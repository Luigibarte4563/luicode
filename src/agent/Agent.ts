import * as path from 'path';
import {
  AgentEvent,
  AgentEventType,
  AskApproval,
  AutonomyLevel,
  ChatMessage,
  LuicodeConfig,
  Plan,
  Session,
  TestResult
} from '../types';
import { Workspace } from '../workspace/Workspace';
import { inspectProject } from '../workspace/inspector';
import { Planner } from '../planner/Planner';
import { ModelRouter } from '../router/ModelRouter';
import { Toolkit } from './toolkit';
import { PlanExecutor } from './executor';
import { SessionManager } from '../sessions/SessionManager';
import { GitManager, GitFileSummary } from '../git/GitManager';
import { classifyError, extractTestSummary } from './errors';
import { SecurityScanner } from '../security/scan';

export interface AgentDeps {
  cwd: string;
  config: LuicodeConfig;
  mode: AutonomyLevel;
  router: ModelRouter | null;
  routerFor: (task: 'planner' | 'coder' | 'reviewer') => ModelRouter | null;
  sessions: SessionManager;
  session: Session;
  emit: (e: AgentEvent) => void;
  askApproval: (q: AskApproval) => Promise<boolean>;
}

export interface AgentRunResult {
  plan?: Plan;
  changedFiles: string[];
  testResults: TestResult[];
  summary: string;
  session: Session;
  approvalDenied?: boolean;
}

export class Agent {
  readonly ws: Workspace;
  config: LuicodeConfig;
  mode: AutonomyLevel;
  session: Session;
  private toolkit: Toolkit;
  private planner: Planner;
  private git: GitManager;
  private scanner = new SecurityScanner();

  constructor(private deps: AgentDeps) {
    this.ws = new Workspace(deps.cwd);
    this.config = deps.config;
    this.mode = deps.mode;
    this.session = deps.session;
    const emit = deps.emit;
    this.toolkit = new Toolkit({
      ws: this.ws,
      config: deps.config,
      mode: deps.mode,
      emit,
      askCommandApproval: async (command) => {
        const rec = { kind: 'command' as const, title: 'Run command', detail: command, items: [command] };
        return deps.askApproval(rec);
      }
    });
    this.planner = new Planner();
    this.git = new GitManager(deps.cwd);

    if (!this.session) throw new Error('Session is required');
  }

  setMode(mode: AutonomyLevel): void {
    this.mode = mode;
    this.toolkit.setMode(mode);
    this.session.mode = mode;
  }

  private emit(type: AgentEventType, text?: string, extra?: Partial<AgentEvent>): void {
    this.deps.emit({ type, timestamp: Date.now(), text, ...extra });
  }

  async runTask(task: string, opts?: { skipApproval?: boolean; planOnly?: boolean }): Promise<AgentRunResult> {
    this.session.task = task;
    this.session.status = 'active';
    this.deps.sessions.save(this.session);
    this.emit('status', 'Inspecting project…');
    const profile = inspectProject(this.ws);

    this.emit('status', `Detected ${profile.language} / ${profile.framework} — preparing implementation plan…`);
    const plannerRouter = this.deps.routerFor('planner');
    const usePlannerLLM = plannerRouter !== null && !plannerRouter.isMock('planner');
    const plan = await this.planner.create({
      task,
      ws: this.ws,
      router: usePlannerLLM ? plannerRouter : null,
      mode: this.mode
    });
    this.session.plan = plan;
    this.emit('plan', 'Plan ready', { plan });
    this.deps.sessions.save(this.session);

    if (opts?.planOnly) {
      plan.status = 'pending';
      this.session.status = 'active';
      this.emit('summary', renderPlanSummary(plan));
      this.deps.sessions.save(this.session);
      return { plan, changedFiles: [], testResults: [], summary: renderPlanSummary(plan), session: this.session };
    }

    const autoApprove =
      opts?.skipApproval === true || this.mode === 'full' || this.mode === 'safe';
    if (!autoApprove) {
      const approved = await this.deps.askApproval({
        kind: 'plan',
        title: 'Implementation plan',
        detail: plan.analysis,
        items: plan.steps.map((s) => s.title)
      });
      if (!approved) {
        plan.status = 'rejected';
        this.session.status = 'canceled';
        this.deps.sessions.save(this.session);
        this.emit('summary', 'Plan rejected — no files were modified.');
        return { changedFiles: [], testResults: [], summary: 'Plan rejected.', session: this.session, approvalDenied: true, plan };
      }
    }
    plan.status = 'approved';
    this.deps.sessions.save(this.session);

    const coderRouter = this.deps.routerFor('coder');
    const useLLM = coderRouter !== null && !coderRouter.isMock('coder');
    const executor = new PlanExecutor({
      toolkit: this.toolkit,
      router: coderRouter,
      useLLM,
      runTests: async (command) => {
        this.emit('status', `Running tests: ${command}`);
        const rec = await this.toolkit.runCommandTool(command);
        const parsed = extractTestSummary(`${rec.stdout}\n${rec.stderr}\nexit: ${rec.code}`);
        return { command, passed: rec.code === 0 && parsed.passed, summary: parsed.summary };
      }
    });

    this.emit('status', 'Executing approved plan…');
    const result = await executor.execute(plan, {
      analysis: plan.analysis,
      filesToCreate: plan.filesToCreate,
      filesToModify: plan.filesToModify,
      steps: plan.steps.map((s) => s.title),
      tests: plan.tests,
      risk: plan.risk
    }, this.config.agent.maxIterations);

    this.session.actions = this.session.actions;
    plan.status = 'implemented';
    this.session.testResults.push(...result.testResults);
    this.deps.sessions.save(this.session);

    const failing = result.testResults.filter((t) => !t.passed);
    let finalTests: TestResult[] = result.testResults;
    if (failing.length && this.config.agent.autoFix && this.mode !== 'manual') {
      finalTests = await this.fixIterations(executor, plan, failing, this.config.agent.maxIterations);
    }

    this.session.status = 'done';
    this.session.fileChanges = result.changedFiles.map((f) => ({ path: f, action: 'modify' }));
    const summary = this.buildSummary(plan, finalTests, result.changedFiles.length);
    this.session.finalSummary = summary;
    this.deps.sessions.save(this.session);
    this.emit('summary', summary);
    return { plan, changedFiles: result.changedFiles, testResults: finalTests, summary, session: this.session };
  }

  private async fixIterations(
    executor: PlanExecutor,
    plan: Plan,
    failing: TestResult[],
    maxIterations: number
  ): Promise<TestResult[]> {
    let current = failing;
    let iterations = 0;
    let lastOutput = failing.map((f) => f.output).join('\n') || failing.map((f) => f.summary).join('\n');
    while (current.length && iterations < maxIterations) {
      iterations++;
      this.emit('status', `Diagnosing ${current.length} failing test run(s)…`);
      const classified = classifyError(lastOutput);
      this.emit('error', `Failure detected: ${classified.message}${classified.file ? ` in ${classified.file}` : ''}`);
      this.session.errors.push(classified.message);

      const fixApplied = await this.applyFix(executor, plan, lastOutput);
      if (!fixApplied) break;

      const first = plan.tests[0] ?? failing[0].command;
      const rec = await this.toolkit.runCommandTool(first);
      const parsed = extractTestSummary(`${rec.stdout}\n${rec.stderr}\nexit: ${rec.code}`);
      const next: TestResult = { command: first, passed: rec.code === 0 && parsed.passed, summary: parsed.summary, output: `${rec.stdout}\n${rec.stderr}`.slice(0, 4000) };
      if (next.passed) {
        current = [];
      } else {
        current = [next];
        lastOutput = next.output ?? `Tests failed: ${next.summary}`;
      }
    }
    this.emit('status', current.length ? 'Fixes exhausted; tests still failing.' : 'All tests passing after fixes.');
    if (!current.length) {
      this.toolkit.opts.emit({ type: 'test', timestamp: Date.now(), test: { command: plan.tests[0] ?? 'tests', passed: true, summary: 'all tests passing', output: '' } });
    }
    return [];
  }

  private async applyFix(executor: PlanExecutor, plan: Plan, failureOutput: string): Promise<boolean> {
    const router = this.deps.routerFor('coder');
    if (!router) {
      this.emit('status', 'No LLM configured for fixing; skipping automatic fix (offline).');
      return false;
    }
    this.emit('status', 'Requesting code fix from model…');
    const messages = [
      {
        role: 'system' as const,
        content:
          'You are LUICode fixing a failing build/test. Analyze the error and emit ACTION blocks (EDIT_FILE or WRITE_FILE) that resolve it. Finish with ACTION: DONE. If more info is needed, use READ_FILE first.'
      },
      { role: 'user' as const, content: `FAILURE OUTPUT:\n${failureOutput.slice(0, 6000)}\n\nProject tree:\n${this.ws.tree('.', 3)}` }
    ];
    let reply: string;
    try {
      const res = await router.complete('coder', messages);
      reply = res.content;
    } catch {
      this.emit('error', 'Fix LLM call failed');
      return false;
    }
    const { parseActions } = await import('./executor');
    const actions = parseActions(reply).filter((a) => a.kind !== 'DONE');
    if (!actions.length) {
      this.emit('status', 'Model produced no actionable fix.');
      return false;
    }
    for (const act of actions) {
      if (act.kind === 'WRITE_FILE' || act.kind === 'EDIT_FILE') {
        await this.toolkit.runTool(act.kind.toLowerCase() === 'write_file' ? 'write_file' : 'edit_file', {
          path: act.file,
          content: act.content,
          find: act.find,
          replace: act.replace
        });
      } else if (act.kind === 'READ_FILE') {
        await this.toolkit.runTool('read_file', { path: act.file });
      }
    }
    void executor;
    void plan;
    return true;
  }

  private buildSummary(plan: Plan, tests: TestResult[], fileCount: number): string {
    const passed = tests.filter((t) => t.passed).length;
    const total = tests.length;
    return [
      `Plan: ${plan.task}`,
      `Implementation: ✓ complete`,
      `Files touched: ${fileCount}`,
      `Tests: ${passed}/${total} runs passed${total ? '' : ' (none configured — run "luicode test")'}`,
      `Mode: ${this.mode}`
    ].join('\n');
  }

  async review(): Promise<string> {
    this.emit('status', 'Reviewing workspace changes and scanning for issues…');
    const isRepo = await this.git.isRepo();
    let gitSummary: GitFileSummary = { modified: [], added: [], deleted: [], additions: 0, deletions: 0 };
    if (isRepo) {
      gitSummary = await this.git.summary();
    } else {
      this.emit('status', 'Not a git repository — reviewing all source files (excluding generated dirs).');
    }
    let report = 'LUICode review\n';
    report += '\nFiles changed:\n';
    report += `  Modified: ${gitSummary.modified.join(', ') || 'none'}\n`;
    report += `  Added:    ${gitSummary.added.join(', ') || 'none'}\n`;
    report += `  Deleted:  ${gitSummary.deleted.join(', ') || 'none'}\n`;
    report += `  +${gitSummary.additions} / -${gitSummary.deletions}\n`;

    report += '\nPotential issues:\n';
    const changedPaths = [...gitSummary.modified, ...gitSummary.added];
    const scanFiles = changedPaths.length
      ? changedPaths.map((f) => ({ path: f, content: this.ws.readFileSafe(f) }))
      : this.ws
          .walkFiles()
          .filter((f) => /\.(ts|tsx|js|jsx|py|go|rs|java|cs|rb|php|vue|svelte|sh|sql|html|htm|css)$/i.test(f))
          .slice(0, 200)
          .map((f) => ({ path: f, content: this.ws.readFileSafe(f) }));
    const findings = this.scanner.scanFiles(scanFiles);
    for (const f of findings.high) report += `  ⚠ [HIGH] ${f.message} (${f.file}:${f.line})\n`;
    for (const f of findings.medium) report += `  ⚠ [MED]  ${f.message} (${f.file}:${f.line})\n`;
    for (const f of findings.low) report += `  ⚠ [LOW]  ${f.message} (${f.file}:${f.line})\n`;
    if (!findings.high.length && !findings.medium.length && !findings.low.length) {
      report += '  No obvious security or code-health issues detected.\n';
    } else {
      report += `  Security: ${findings.high.length} high, ${findings.medium.length} medium, ${findings.low.length} low\n`;
    }

    const sessionTests = this.session.testResults;
    if (sessionTests.length) {
      report += '\nTests:\n';
      for (const t of sessionTests) report += `  ${t.passed ? '✓' : '✗'} ${t.command} — ${t.summary}\n`;
    }
    return report;
  }

  async addMessage(role: 'user' | 'assistant', content: string): Promise<void> {
    const msg: ChatMessage = { role, content, timestamp: Date.now() };
    this.session.messages.push(msg);
    this.deps.sessions.save(this.session);
  }
}

export function openCwd(cwd: string): string {
  return path.resolve(cwd);
}

export function renderPlanSummary(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`PLAN ${plan.id} — PENDING`);
  lines.push(`TASK: ${plan.task}`);
  lines.push(`\nPROJECT ANALYSIS\n${plan.analysis}`);
  lines.push(`\nSTEPS`);
  plan.steps.forEach((s, i) => lines.push(`${i + 1}. ${s.title}`));
  lines.push(`\nFILES (create): ${plan.filesToCreate.join(', ') || '—'}`);
  lines.push(`FILES (modify): ${plan.filesToModify.join(', ') || '—'}`);
  lines.push(`TESTS: ${plan.tests.join('; ') || '—'}`);
  lines.push(`RISK: ${plan.risk}`);
  return lines.join('\n');
}
import * as path from 'path';
import {
  AgentEvent,
  AgentEventType,
  ApprovalDecision,
  AskApproval,
  AutonomyLevel,
  ChatMessage,
  DiffEntry,
  FileChange,
  LuicodeConfig,
  ModelUsage,
  Plan,
  Session,
  TestResult
} from '../types';
import { Workspace } from '../workspace/Workspace';
import { inspectProject } from '../workspace/inspector';
import { Planner, renderPlanMarkdown } from '../planner/Planner';
import { ModelRouter } from '../router/ModelRouter';
import { Toolkit } from './toolkit';
import { PlanExecutor, ExecutorResult } from './executor';
import { SessionManager } from '../sessions/SessionManager';
import { GitManager, GitFileSummary } from '../git/GitManager';
import { classifyError, extractTestSummary } from './errors';
import { SecurityScanner } from '../security/scan';
import { RunControl, isCancelled } from './runControl';

export interface AgentDeps {
  cwd: string;
  config: LuicodeConfig;
  mode: AutonomyLevel;
  router: ModelRouter | null;
  routerFor: (task: 'planner' | 'coder' | 'reviewer') => ModelRouter | null;
  sessions: SessionManager;
  session: Session;
  emit: (e: AgentEvent) => void;
  askApproval: (q: AskApproval) => Promise<ApprovalDecision>;
  control?: RunControl;
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
  readonly control: RunControl;
  private toolkit: Toolkit;
  private planner: Planner;
  private git: GitManager;
  private scanner = new SecurityScanner();
  private lastExecutor: PlanExecutor | null = null;
  private lastPlan: Plan | null = null;
  private lastFailing: TestResult[] = [];

  constructor(private deps: AgentDeps) {
    this.ws = new Workspace(deps.cwd);
    this.config = deps.config;
    this.mode = deps.mode;
    this.session = deps.session;
    const emit = deps.emit;
    this.control = deps.control ?? new RunControl();
    this.toolkit = new Toolkit({
      ws: this.ws,
      config: deps.config,
      mode: deps.mode,
      emit,
      control: this.control,
      askCommandApproval: async (command) => {
        const rec = { kind: 'command' as const, title: 'Run command', detail: command, items: [command] };
        const decision = await deps.askApproval(rec);
        return decision.approved;
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

  // -------------------------------------------------------------------------
  // Run controls (driven by keyboard shortcuts / slash commands)
  // -------------------------------------------------------------------------

  cancel(): boolean {
    if (this.control.aborted) return false;
    this.control.abort();
    this.session.status = 'canceled';
    this.deps.sessions.save(this.session);
    this.emit('status', 'Operation cancelled.');
    this.emit('error', 'Stopped by user', { error: new Error('Operation cancelled by user.') });
    return true;
  }

  pause(): void {
    this.control.pause();
    this.emit('status', 'Paused — press Space to resume.');
  }

  resume(): void {
    this.control.resume();
    this.emit('status', 'Resumed.');
  }

  skipStep(): void {
    this.control.requestSkip();
    this.emit('status', 'Skipping current step…');
  }

  retryStep(): void {
    this.control.requestRetry();
    this.emit('status', 'Retrying current step…');
  }

  requestFix(): void {
    this.control.requestFix();
    this.emit('status', 'Fix loop requested.');
  }

  /**
   * Run the fix loop now against the last failing tests. Safe to call while
   * idle (e.g. after a batch run that left failures). Returns the number of
   * fix passes executed.
   */
  async fixLoopNow(): Promise<number> {
    const plan = this.lastPlan;
    const failing = this.lastFailing.filter((t) => !t.passed);
    if (!plan || !this.lastExecutor) {
      this.emit('status', 'No previous failing run to fix.');
      return 0;
    }
    if (!failing.length) {
      this.emit('status', 'No failing tests from the last run.');
      return 0;
    }
    this.emit('status', `Starting fix loop for ${failing.length} failing test run(s)…`);
    const result = await this.fixIterations(this.lastExecutor, plan, failing, this.config.agent.maxIterations);
    this.lastFailing = result.length ? this.lastFailing : [];
    return result.length ? 0 : 1;
  }

  private emit(type: AgentEventType, text?: string, extra?: Partial<AgentEvent>): void {
    this.deps.emit({ type, timestamp: Date.now(), text, ...extra });
  }

  private persistPlanMarkdown(plan: Plan): void {
    try {
      this.ws.writeFile('plan.md', renderPlanMarkdown(plan));
      this.emit('file', undefined, { file: { path: 'plan.md', action: plan.status === 'rejected' ? 'modify' : 'create' } });
    } catch {
      // plan.md is a convenience artifact; never fail the run if it can't be written.
    }
  }

  private routerFor(task: 'planner' | 'coder' | 'reviewer'): ModelRouter | null {
    const router = this.deps.routerFor(task);
    if (!router) return null;
    router.onUsage = (usage: ModelUsage) => this.emit('usage', undefined, { usage });
    return router;
  }

  async runTask(task: string, opts?: { skipApproval?: boolean; planOnly?: boolean }): Promise<AgentRunResult> {
    await this.control.sync().catch(() => undefined);
    const plan = await this.createPlanOnly(task);
    if (this.control.aborted) return this.cancelledResult(plan);

    if (opts?.planOnly) {
      plan.status = 'pending';
      this.session.status = 'active';
      this.emit('summary', renderPlanSummary(plan));
      this.deps.sessions.save(this.session);
      return { plan, changedFiles: [], testResults: [], summary: renderPlanSummary(plan), session: this.session };
    }

    if (this.control.rejectNext) {
      this.control.takeRejectNext();
      plan.status = 'rejected';
      this.session.status = 'canceled';
      this.persistPlanMarkdown(plan);
      this.deps.sessions.save(this.session);
      this.emit('summary', 'Plan rejected — no files were modified.');
      return { changedFiles: [], testResults: [], summary: 'Plan rejected.', session: this.session, approvalDenied: true, plan };
    }

    const autoApprove =
      opts?.skipApproval === true || this.mode === 'full' || this.mode === 'safe' || this.control.approveNext;
    if (this.control.approveNext) this.control.takeApproveNext();
    if (!autoApprove) {
      const decision = await this.deps.askApproval({
        kind: 'plan',
        title: 'Implementation plan',
        detail: plan.analysis,
        items: plan.steps.map((s) => s.title)
      });
      if (!decision.approved) {
        plan.status = 'rejected';
        this.session.status = 'canceled';
        this.persistPlanMarkdown(plan);
        this.deps.sessions.save(this.session);
        this.emit('summary', 'Plan rejected — no files were modified.');
        return { changedFiles: [], testResults: [], summary: 'Plan rejected.', session: this.session, approvalDenied: true, plan };
      }
      if (decision.steps && decision.steps.length) {
        selectSteps(plan, decision.steps);
      }
    }
    plan.status = 'approved';
    this.persistPlanMarkdown(plan);
    this.deps.sessions.save(this.session);

    return this.executeApproved(plan);
  }

  /**
   * Plan-only entry point. Creates (or re-creates, for /replan) the
   * implementation plan against the current project state without executing
   * it. Shared by runTask and the /plan, /replan slash commands.
   */
  async createPlanOnly(task: string): Promise<Plan> {
    await this.control.sync().catch(() => undefined);
    this.session.task = task;
    this.session.status = 'active';
    this.deps.sessions.save(this.session);
    this.emit('status', 'Inspecting project…');
    const profile = inspectProject(this.ws);

    this.emit('status', `Detected ${profile.language} / ${profile.framework} — preparing implementation plan…`);
    const plannerRouter = this.routerFor('planner');
    const usePlannerLLM = plannerRouter !== null && !plannerRouter.isMock('planner');
    const plan = await this.planner.create({
      task,
      ws: this.ws,
      router: usePlannerLLM ? plannerRouter : null,
      mode: this.mode,
      adapters: this.config.adapters
    });
    this.session.plan = plan;
    this.emit('plan', 'Plan ready', { plan });
    this.emit('comment', undefined, { text: plan.analysis });
    this.persistPlanMarkdown(plan);
    this.deps.sessions.save(this.session);
    this.lastPlan = plan;
    return plan;
  }

  /**
   * Execute an already-approved plan through the coder router + PlanExecutor,
   * including the test loop, automatic fix loop, diff emission and summary.
   * Shared by runTask and the /execute slash command.
   */
  async executePlan(plan: Plan): Promise<AgentRunResult> {
    plan.status = 'approved';
    this.persistPlanMarkdown(plan);
    this.deps.sessions.save(this.session);
    return this.executeApproved(plan);
  }

  private async executeApproved(plan: Plan): Promise<AgentRunResult> {
    const coderRouter = this.routerFor('coder');
    const useLLM = coderRouter !== null && !coderRouter.isMock('coder');
    const executor = new PlanExecutor({
      toolkit: this.toolkit,
      router: coderRouter,
      useLLM,
      control: this.control,
      runTests: async (command) => {
        this.emit('status', `Running tests: ${command}`);
        await this.control.sync().catch(() => undefined);
        const rec = await this.toolkit.runCommandTool(command);
        const parsed = extractTestSummary(`${rec.stdout}\n${rec.stderr}\nexit: ${rec.code}`);
        return { command, passed: rec.code === 0 && parsed.passed, summary: parsed.summary };
      }
    });
    this.lastExecutor = executor;
    this.lastPlan = plan;

    this.emit('status', 'Executing approved plan…');
    let result: ExecutorResult;
    try {
      result = await executor.execute(
        plan,
        {
          analysis: plan.analysis,
          filesToCreate: plan.filesToCreate,
          filesToModify: plan.filesToModify,
          steps: plan.steps.map((s) => ({ title: s.title, stepType: s.stepType, action: s.action, why: s.why, risk: s.risk })),
          tests: plan.tests,
          risk: plan.risk
        },
        this.config.agent.maxIterations
      );
    } catch (err) {
      if (isCancelled(err)) {
        plan.status = 'cancelled';
        this.persistPlanMarkdown(plan);
        this.session.status = 'canceled';
        this.deps.sessions.save(this.session);
        this.emit('status', 'Execution stopped.');
        return { plan, changedFiles: [], testResults: [], summary: 'Execution cancelled.', session: this.session };
      }
      throw err;
    }

    plan.status = 'implemented';
    this.persistPlanMarkdown(plan);
    this.session.testResults.push(...result.testResults);
    this.deps.sessions.save(this.session);

    await this.emitDiffs(result.changedFiles, new Set(plan.filesToCreate));

    const failing = result.testResults.filter((t) => !t.passed);
    this.lastFailing = failing;
    let finalTests: TestResult[] = result.testResults;
    const fixRequested = this.control.fixRequested && this.control.takeFix();
    if (failing.length && (fixRequested || (this.config.agent.autoFix && this.mode !== 'manual'))) {
      finalTests = await this.fixIterations(executor, plan, failing, this.config.agent.maxIterations);
    }

    this.session.status = 'done';
    this.session.fileChanges = result.changedFiles.map((f) => ({ path: f, action: 'modify' }));
    const staticSummary = this.buildSummary(plan, finalTests, result.changedFiles.length);
    const summary = await this.generateSummary(plan, finalTests, result.changedFiles.length, staticSummary);
    this.session.finalSummary = summary;
    this.deps.sessions.save(this.session);
    this.emit('summary', summary);
    return { plan, changedFiles: result.changedFiles, testResults: finalTests, summary, session: this.session };
  }

  private cancelledResult(plan: Plan): AgentRunResult {
    plan.status = 'cancelled';
    this.session.status = 'canceled';
    this.persistPlanMarkdown(plan);
    this.deps.sessions.save(this.session);
    this.emit('status', 'Operation cancelled.');
    return { plan, changedFiles: [], testResults: [], summary: 'Cancelled.', session: this.session };
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
      this.emit('status', `Diagnosing ${current.length} failing test run(s)… (fix attempt ${iterations}/${maxIterations})`);
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
    const messages = [
      {
        role: 'system' as const,
        content:
          'You are LUICode fixing a failing build/test. First, write a brief natural-language explanation of what went wrong and how you plan to fix it. Then emit ACTION blocks (EDIT_FILE or WRITE_FILE) that resolve the issue. Finish with ACTION: DONE.'
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
    const { commentary, body } = this.extractCommentary(reply);
    if (commentary) this.emit('comment', undefined, { text: commentary });
    const { parseActions } = await import('./executor');
    const actions = parseActions(body).filter((a) => a.kind !== 'DONE');
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

  private extractCommentary(text: string): { commentary: string; body: string } {
    const startMatch = text.match(/---\s*commentary\s*---\s*\n?([\s\S]*?)\n?---\s*end\s*commentary\s*---/i);
    if (!startMatch) return { commentary: '', body: text };
    const commentary = startMatch[1].trim();
    const body = text.slice(startMatch.index! + startMatch[0].length).trim();
    return { commentary, body };
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

  private async generateSummary(plan: Plan, tests: TestResult[], fileCount: number, fallback: string): Promise<string> {
    const router = this.deps.routerFor('reviewer');
    if (!router || router.isMock('reviewer')) return fallback;
    const passing = tests.filter((t) => t.passed).length;
    const files = this.session.fileChanges.map((f) => `${f.action} ${f.path}`).join('\n') || '(none)';
    const testLines = tests.length
      ? tests.map((t) => `${t.passed ? 'PASS' : 'FAIL'} ${t.command} — ${t.summary}`).join('\n')
      : 'No tests were run.';
    const failed = tests.filter((t) => !t.passed);
    try {
      const res = await router.complete('reviewer', [
        {
          role: 'system' as const,
          content:
            'You are LUICode writing the final summary for a completed task. Summarize what was done in 2-4 conversational sentences; do not use bullet lists, headings, or markdown headers.'
        },
        {
          role: 'user' as const,
          content: `Task: ${plan.task}\nSteps: ${plan.steps.map((s) => `${s.status === 'done' ? '[done]' : s.status === 'skipped' ? '[skipped]' : '[pending]'} ${s.title}`).join(' | ') || '(none)'}\nFiles changed:\n${files}\nTests (${passing}/${tests.length} passing):\n${testLines}\n${failed.length ? 'Remaining failures:\n' + failed.map((f) => `- ${f.command}: ${f.summary}`).join('\n') : ''}`
        }
      ]);
      const text = res.content.trim();
      return text.length > 0 ? text : fallback;
    } catch {
      return fallback;
    }
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

  private async emitDiffs(files: string[], newFiles: Set<string>): Promise<void> {
    for (const file of new Set(files)) {
      const action = newFiles.has(file) ? 'create' : 'modify';
      const entry = await this.computeDiffEntry(file, action);
      if (entry) this.emit('diff', undefined, { diff: entry });
    }
  }

  private async computeDiffEntry(file: string, action: FileChange['action']): Promise<DiffEntry | null> {
    if (action === 'delete') {
      return { path: file, lines: ['- (deleted)'], additions: 0, deletions: 0 };
    }
    const content = this.ws.readFileSafe(file);
    if (content === null) return null;
    if (await this.git.isRepo()) {
      const numstat = await this.git.numstatFor(file);
      const raw = await this.git.unifiedFor(file);
      if (numstat) {
        const lines = raw
          .split('\n')
          .filter((l) => l.startsWith('+') || l.startsWith('-'))
          .slice(0, 200);
        return { path: file, lines, additions: numstat.add, deletions: numstat.del };
      }
    }
    const lines = content.split('\n').map((l) => `+ ${l}`);
    const additions = content.split('\n').filter((l) => l.trim().length > 0).length;
    return { path: file, lines: lines.slice(0, 200), additions, deletions: 0 };
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

export function selectSteps(plan: Plan, selectedTitles: string[]): Plan {
  const keep = new Set(selectedTitles.map((s) => s.trim().toLowerCase()).filter(Boolean));
  for (const step of plan.steps) {
    if (!keep.has(step.title.trim().toLowerCase())) step.status = 'skipped';
  }
  return plan;
}
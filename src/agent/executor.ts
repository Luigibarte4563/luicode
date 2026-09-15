import { ModelMessage, Plan, TestResult } from '../types';
import { ModelRouter } from '../router/ModelRouter';
import { Toolkit } from './toolkit';
import { classifyError, extractTestSummary } from './errors';
import { PlanEnvironment } from '../planner/Planner';
import { inspectProject, ProjectProfile } from '../workspace/inspector';
import { RunControl, isCancelled } from './runControl';

function extractCommentary(text: string): { commentary: string; body: string } {
  const startMatch = text.match(/---\s*commentary\s*---\s*\n?([\s\S]*?)\n?---\s*end\s*commentary\s*---/i);
  if (!startMatch) return { commentary: '', body: text };
  const commentary = startMatch[1].trim();
  const body = text.slice(startMatch.index! + startMatch[0].length).trim();
  return { commentary, body };
}

export { extractCommentary };

export interface ParsedAction {
  kind: 'READ_FILE' | 'WRITE_FILE' | 'EDIT_FILE' | 'RUN_COMMAND' | 'SEARCH_CODE' | 'DONE' | 'ANALYSIS';
  file?: string;
  find?: string;
  replace?: string;
  command?: string;
  query?: string;
  content?: string;
}

export function parseActions(text: string): ParsedAction[] {
  const actions: ParsedAction[] = [];
  const lines = text.split('\n');
  const rx = /^ACTION:\s*([A-Z_]+)\s*$/;
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(rx);
    if (!m) {
      i++;
      continue;
    }
    const kind = m[1] as ParsedAction['kind'];
    i++;
    const block: string[] = [];
    while (i < lines.length && !rx.test(lines[i])) {
      block.push(lines[i]);
      i++;
    }
    actions.push(parseActionBlock(kind, block));
  }
  if (!actions.length) {
    const blockText = text.trim();
    if (/^FILE:|^CONTENT:|^COMMAND:|^QUERY:/m.test(blockText)) {
      actions.push(parseActionBlock('WRITE_FILE', blockText.split('\n')));
    }
  }
  return actions;
}

function parseActionBlock(kind: ParsedAction['kind'], block: string[]): ParsedAction {
  const read = (tag: string): string | undefined => {
    const idx = block.findIndex((l) => new RegExp(`^${tag}:`).test(l));
    if (idx < 0) return undefined;
    const out: string[] = [];
    for (const line of block.slice(idx + 1)) {
      if (/^(FIND|REPLACE|COMMAND|QUERY|CONTENT):/.test(line)) break;
      out.push(line);
    }
    return out.join('\n').trim();
  };
  const val = (tag: string): string | undefined => {
    const m = block.find((l) => new RegExp(`^${tag}:\\s*(.*)$`).test(l));
    return m?.match(new RegExp(`^${tag}:\\s*(.*)$`))?.[1];
  };

  switch (kind) {
    case 'RUN_COMMAND':
      return { kind, command: val('COMMAND') ?? val('CMD') ?? read('COMMAND') };
    case 'READ_FILE':
      return { kind, file: val('FILE') ?? read('FILE') };
    case 'SEARCH_CODE':
      return { kind, query: val('QUERY') ?? val('SEARCH') ?? read('QUERY') };
    case 'EDIT_FILE':
      return { kind, file: val('FILE'), find: val('FIND') ?? read('FIND'), replace: val('REPLACE') ?? read('REPLACE') };
    case 'WRITE_FILE':
      return { kind, file: val('FILE'), content: read('CONTENT') };
    case 'DONE':
    case 'ANALYSIS':
      return { kind };
  }
}

export interface ExecutorResult {
  actions: ParsedAction[];
  changedFiles: string[];
  testResults: Array<{ command: string; passed: boolean; summary: string }>;
  summary: string;
}

const EXEC_SYSTEM = `You are LUICode executing an approved plan step inside a workspace.

First, write a brief natural-language explanation (1-3 sentences) of what you are about to do and why.
Then emit ACTION blocks (one per action) followed by ACTION: DONE.

--- commentary ---
<your explanation here>
--- end commentary ---

Available actions (one per block):
ACTION: READ_FILE
FILE: <path>

ACTION: SEARCH_CODE
QUERY: <text>

ACTION: WRITE_FILE
FILE: <path>
CONTENT:
<entire new file content>

ACTION: EDIT_FILE
FILE: <path>
FIND: <exact string to replace>
REPLACE: <replacement>

ACTION: RUN_COMMAND
COMMAND: <shell command>

ACTION: DONE

Rules:
- Make the smallest change that satisfies the current step.
- Must finish with ACTION: DONE.
- Do not introduce secrets or destroy files.`;

export class PlanExecutor {
  toolkit: Toolkit;
  private useLLM: boolean;
  private cachedProfile: ProjectProfile | null = null;
  private skipCurrentStep = false;

  constructor(
    private opts: {
      toolkit: Toolkit;
      router: ModelRouter | null;
      useLLM: boolean;
      control?: RunControl;
      runTests: (command: string) => Promise<TestResult>;
    }
  ) {
    this.toolkit = opts.toolkit;
    this.useLLM = opts.useLLM;
  }

  private get profileFor(): ProjectProfile {
    if (!this.cachedProfile) this.cachedProfile = inspectProject(this.toolkit.ws);
    return this.cachedProfile;
  }

  async execute(plan: Plan, env: PlanEnvironment, maxIterations: number): Promise<ExecutorResult> {
    const actions: ParsedAction[] = [];
    const changedFiles: string[] = [];
    const testResults: TestResult[] = [];
    const control = this.opts.control;

    for (const step of plan.steps) {
      await control?.sync().catch(() => undefined);
      if (step.status === 'skipped') continue;
      if (control?.takeSkip()) {
        step.status = 'skipped';
        this.toolkit.opts.emit({ type: 'plan', timestamp: Date.now(), plan, step });
        continue;
      }
      // Retry support: re-attempt the step up to two extra times when the
      // user asks (R / /retry) while the step is in flight.
      let attempts = 0;
      this.skipCurrentStep = false;
      do {
        attempts++;
        if (attempts > 1) step.status = 'pending';
        step.status = 'running';
        this.toolkit.opts.emit({ type: 'plan', timestamp: Date.now(), plan, step });
        await this.runStep(plan, step.title, actions, changedFiles, testResults, maxIterations, env);
        if (this.skipCurrentStep) {
          step.status = 'skipped';
          break;
        }
        step.status = 'done';
        this.toolkit.opts.emit({ type: 'plan', timestamp: Date.now(), plan, step });
        const retry = (control?.retryRequested || false) && control?.takeRetry();
        if (retry) step.status = 'pending';
      } while (step.status === 'pending' && attempts < 3);
      if (step.status === 'pending') step.status = 'done';
    }

    const testCmds = plan.tests.length ? plan.tests : env.tests;
    for (const cmd of testCmds) {
      const result = await this.opts.runTests(cmd);
      testResults.push(result);
      this.toolkit.opts.emit({ type: 'test', timestamp: Date.now(), test: result });
    }

    const summary = `${changedFiles.length} file(s) changed, ${testResults.filter((t) => t.passed).length}/${testResults.length} test runs passed`;
    return { actions, changedFiles, testResults, summary };
  }

  private async runStep(
    plan: Plan,
    stepTitle: string,
    actions: ParsedAction[],
    changedFiles: string[],
    testResults: TestResult[] ,
    maxIterations: number,
    env: PlanEnvironment
  ): Promise<void> {
    let guard = 0;
    const maxActionsPerStep = Math.max(6, Math.floor(maxIterations));
    const planIntro = `PLAN TASK: ${plan.task}\nFILES_TO_CREATE:\n${plan.filesToCreate.join('\n') || '(none)'}\nFILES_TO_MODIFY:\n${plan.filesToModify.join('\n') || '(none)'}\nTESTS:\n${env.tests.join('\n') || '(none)'}\nCURRENT STEP: ${stepTitle}\nANALYSIS: ${plan.analysis}`;

    while (guard < maxActionsPerStep) {
      guard++;
      if (this.opts.control) {
        try {
          await this.opts.control.sync();
        } catch {
          return; // cancelled
        }
        if (this.opts.control.skipRequested) {
          this.opts.control.takeSkip();
          this.skipCurrentStep = true;
          return;
        }
      }
      const reply = this.useLLM ? await this.llmNextAction(planIntro, actions) : this.heuristicNextAction(planIntro);
      const parsed = parseActions(reply);
      if (!parsed.length) break;
      for (const act of parsed) {
        if (act.kind === 'DONE') return;
        if (act.kind === 'ANALYSIS') continue;
        const out = await this.executeAction(act, changedFiles, plan);
        actions.push({ ...act, content: undefined });
        void out;
        if (act.kind === 'RUN_COMMAND') {
          const res = extractTestSummary(String(out ?? ''));
          testResults.push({ command: act.command ?? '', passed: res.passed, summary: res.summary, output: String(out ?? '') });
          this.toolkit.opts.emit({ type: 'test', timestamp: Date.now(), test: testResults[testResults.length - 1] });
        }
      }
    }
  }

  private async llmNextAction(planIntro: string, actions: ParsedAction[]): Promise<string> {
    const history: ModelMessage[] = [
      { role: 'system', content: EXEC_SYSTEM },
      { role: 'user', content: planIntro + '\n\nProject tree:\n' + this.toolkit.ws.tree('.', 3) }
    ];
    const lastFew = actions.slice(-4);
    history.push({ role: 'user', content: `Recent actions performed:\n${lastFew.map((a) => `${a.kind} ${a.file ?? a.command ?? a.query ?? ''}`).join('\n') || '(none)'}\n\nReturn the next ACTION block now.` });
    try {
      const reply = await this.opts.router!.complete('coder', history, {
        signal: this.opts.control?.signal
      });
      const { commentary, body } = extractCommentary(reply.content);
      if (commentary) {
        this.toolkit.opts.emit({ type: 'comment', timestamp: Date.now(), text: commentary });
      }
      return body;
    } catch {
      this.useLLM = false;
      return this.heuristicNextAction(planIntro);
    }
  }

  private heuristicNextAction(planIntro: string): string {
    const feature = planIntro.match(/TASK:\s*(.+)/)?.[1] ?? 'feature';
    const currentStep = planIntro.match(/CURRENT STEP: (.+)/)?.[1] ?? '';
    const testsBlock = planIntro.match(/TESTS:\n([\s\S]*?)(?=\nCURRENT STEP:|$)/)?.[1]?.trim() ?? '';
    const hasTests = Boolean(testsBlock && testsBlock !== '(none)');
    const step = currentStep.toLowerCase();

    if (/\bcreate\b|\bimplement\b/.test(step)) {
      const extByLang: Record<string, string> = {
        TypeScript: '.ts',
        JavaScript: '.js',
        Python: '.py',
        Go: '.go',
        Rust: '.rs',
        Java: '.java',
        Ruby: '.rb',
        PHP: '.php'
      };
      const ext = extByLang[this.profileFor.language];
      if (!ext) return 'ACTION: DONE';
      const safe = feature.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'feature';
      const file = `src/${safe}${ext}`;
      const moduleName = safe.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      const content = [
        `// ${file} — generated by LUICode for: "${feature}"`,
        '',
        `export function ${moduleName}(): string {`,
        `  return '${moduleName} ready';`,
        '}',
        '',
        `export default ${moduleName};`
      ].join('\n');
      return `ACTION: WRITE_FILE\nFILE: ${file}\nCONTENT:\n${content}\n\nACTION: DONE`;
    }
    if (/test|verify/i.test(step)) {
      if (hasTests) {
        const cmd = testsBlock.split('\n').map((l) => l.replace(/^\s*(?:\d+[.)]\s*|[•\-+]\s*)/, '').trim()).find((l) => l) ?? 'npm test';
        return `ACTION: RUN_COMMAND\nCOMMAND: ${cmd}\n\nACTION: DONE`;
      }
      return 'ACTION: DONE';
    }
    if (/build/i.test(step)) {
      return 'ACTION: DONE';
    }
    return 'ACTION: DONE';
  }

  private async executeAction(act: ParsedAction, changedFiles: string[], plan: Plan): Promise<string> {
    switch (act.kind) {
      case 'READ_FILE': {
        const call = await this.toolkit.runTool('read_file', { path: act.file });
        return call.output ?? call.error ?? '';
      }
      case 'SEARCH_CODE': {
        const call = await this.toolkit.runTool('search_code', { query: act.query });
        return call.output ?? call.error ?? '';
      }
      case 'RUN_COMMAND': {
        const rec = await this.toolkit.runCommandTool(act.command ?? '');
        return `EXIT_CODE: ${rec.code}\n${rec.stdout}\n${rec.stderr}`;
      }
      case 'EDIT_FILE': {
        const call = await this.toolkit.runTool('edit_file', { path: act.file, find: act.find, replace: act.replace });
        if (call.status === 'ok' && act.file) {
          changedFiles.push(act.file);
          this.recordChange(act.file, 'modify');
        }
        return call.output ?? call.error ?? '';
      }
      case 'WRITE_FILE': {
        const wasNew = !(this.toolkit.ws.resolveSafe(act.file as string)
          ? this.toolkit.ws.absoluteExists(this.toolkit.ws.resolveSafe(act.file as string) as string)
          : false);
        const call = await this.toolkit.runTool('write_file', { path: act.file, content: act.content });
        if (call.status === 'ok' && act.file) {
          if (!changedFiles.includes(act.file)) changedFiles.push(act.file);
          this.recordChange(act.file, wasNew ? 'create' : 'modify');
        }
        return call.output ?? call.error ?? '';
      }
      default:
        return '';
    }
  }

  private recordChange(file: string, action: 'create' | 'modify'): void {
    this.toolkit.opts.emit({ type: 'file', timestamp: Date.now(), file: { path: file, action } });
  }

  analyzeFailure(output: string): string {
    const c = classifyError(output);
    return `${c.message}${c.file ? ` (${c.file})` : ''}`;
  }
}

import { ModelMessage, Plan, TestResult } from '../types';
import { ModelRouter } from '../router/ModelRouter';
import { Toolkit } from './toolkit';
import { classifyError, extractTestSummary } from './errors';
import { PlanEnvironment } from '../planner/Planner';

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

  constructor(
    private opts: {
      toolkit: Toolkit;
      router: ModelRouter | null;
      useLLM: boolean;
      runTests: (command: string) => Promise<TestResult>;
    }
  ) {
    this.toolkit = opts.toolkit;
    this.useLLM = opts.useLLM;
  }

  async execute(plan: Plan, env: PlanEnvironment, maxIterations: number): Promise<ExecutorResult> {
    const actions: ParsedAction[] = [];
    const changedFiles: string[] = [];
    const testResults: TestResult[] = [];

    for (const step of plan.steps) {
      if (step.status === 'skipped') continue;
      step.status = 'running';
      this.toolkit.opts.emit({ type: 'plan', timestamp: Date.now(), plan, step });
      await this.runStep(plan, step.title, actions, changedFiles, testResults, maxIterations, env);
      step.status = 'done';
      this.toolkit.opts.emit({ type: 'plan', timestamp: Date.now(), plan, step });
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
      const reply = await this.opts.router!.complete('coder', history);
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

    if (step.includes('index.html') || /create index\.html|index\.html with/.test(step)) {
      return `ACTION: WRITE_FILE\nFILE: index.html\nCONTENT:\n${this.webPageHtml(feature)}\n\nACTION: DONE`;
    }
    if (step.includes('style.css') || step.includes('stylesheet')) {
      return `ACTION: WRITE_FILE\nFILE: style.css\nCONTENT:\n${this.webPageCss()}\n\nACTION: DONE`;
    }
    if (step.includes('script.js') || step.includes('vanilla behavior')) {
      return `ACTION: WRITE_FILE\nFILE: script.js\nCONTENT:\n${this.webPageJs()}\n\nACTION: DONE`;
    }
    if (/\bcreate\b|\bimplement\b/.test(step)) {
      const safe = feature.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'feature';
      const file = `src/${safe}.ts`;
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

  private webPageHtml(feature: string): string {
    const siteName = /luicode/i.test(feature) ? 'LUICode' : this.deriveSiteName(feature);
    return [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="UTF-8" />',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      `  <title>${siteName} — Plan. Build. Test. Ship.</title>`,
      '  <meta name="description" content="LUICode — Plan. Build. Test. Ship. An autonomous AI coding agent." />',
      '  <link rel="stylesheet" href="style.css" />',
      '</head>',
      '<body>',
      '  <header class="site-header">',
      '    <nav class="nav container" aria-label="Main navigation">',
      '      <a class="brand" href="index.html">LUICode</a>',
      '      <button class="nav-toggle" id="nav-toggle" aria-label="Toggle navigation" aria-expanded="false">&#9776;</button>',
      '      <ul class="nav-links" id="nav-links">',
      '        <li><a href="#features">Features</a></li>',
      '        <li><a href="#workflow">Workflow</a></li>',
      '        <li><a href="#get-started">Get started</a></li>',
      '      </ul>',
      '    </nav>',
      '  </header>',
      '',
      '  <main>',
      '    <section class="hero">',
      '      <div class="container">',
      '        <h1>Plan. Build. Test. Ship.</h1>',
      `        <p class="tagline">${siteName} — an autonomous AI coding agent that inspects, plans, and ships changes to your codebase.</p>`,
      '        <a class="btn btn-primary" href="#get-started">Try LUICode</a>',
      '      </div>',
      '    </section>',
      '',
      '    <section class="container section" id="features">',
      '      <h2>What makes LUICode different</h2>',
      '      <div class="grid">',
      '        <article class="card"><h3>Plan first</h3><p>Every change starts with an inspection and an implementable plan before any file is touched.</p></article>',
      '        <article class="card"><h3>Safe by default</h3><p>Workspace-only writes, protected paths, command guardrails, and secret redaction.</p></article>',
      '        <article class="card"><h3>Self-verifying</h3><p>Tests and builds run automatically and failures drive a fix loop.</p></article>',
      '      </div>',
      '    </section>',
      '',
      '    <section class="container section" id="workflow">',
      '      <h2>How it works</h2>',
      '      <ol class="steps">',
      '        <li><span>1</span> Inspect the project</li>',
      '        <li><span>2</span> Approve a plan</li>',
      '        <li><span>3</span> Watch it build, test, and iterate</li>',
      '        <li><span>4</span> Review the diff</li>',
      '      </ol>',
      '    </section>',
      '',
      '    <section class="container section cta" id="get-started">',
      '      <h2>Ready to ship smarter?</h2>',
      '      <p><code>npm install; npm run build; npm link; luicode</code></p>',
      '      <button class="btn btn-primary" id="btn-theme">Toggle dark theme</button>',
      '    </section>',
      '  </main>',
      '',
      '  <footer class="site-footer">',
      '    <div class="container">',
      '      <p>&copy; <span id="year"></span> LUICode. Plan. Build. Test. Ship.</p>',
      '    </div>',
      '  </footer>',
      '',
      '  <script src="script.js"></script>',
      '</body>',
      '</html>'
    ].join('\n');
  }

  private deriveSiteName(feature: string): string {
    const words = feature
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(create|make|build|generate|add|develop|design)\s+/i, '')
      .replace(/\b(a|an|the|with|using|about|for|in|of|html|css|javascript|js|website|webpage|site|landing|responsive|simple|static)\b/gi, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4);
    const name = words
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    return name || 'LUICode';
  }

  private webPageCss(): string {
    return [
      ':root {',
      '  --bg: #f6f8fa;',
      '  --fg: #1f2328;',
      '  --accent: #00beff;',
      '  --accent-2: #50e3c2;',
      '  --card: #ffffff;',
      '  --border: #d8dee4;',
      '}',
      '* { box-sizing: border-box; margin: 0; padding: 0; }',
      'body {',
      '  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;',
      '  background: var(--bg);',
      '  color: var(--fg);',
      '  line-height: 1.6;',
      '}',
      'body.dark {',
      '  --bg: #0d1117;',
      '  --fg: #e6edf3;',
      '  --card: #161b22;',
      '  --border: #30363d;',
      '}',
      '.container { max-width: 1080px; margin: 0 auto; padding: 0 20px; }',
      '',
      '.site-header { position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--border); z-index: 10; }',
      '.nav { display: flex; align-items: center; justify-content: space-between; height: 60px; }',
      '.brand { font-weight: 800; font-size: 1.25rem; color: var(--accent); text-decoration: none; }',
      '.nav-links { display: flex; gap: 24px; list-style: none; }',
      '.nav-links a { color: var(--fg); text-decoration: none; }',
      '.nav-links a:hover { color: var(--accent); }',
      '.nav-toggle { display: none; background: none; border: 0; font-size: 1.5rem; cursor: pointer; color: var(--fg); }',
      '',
      '.hero { padding: 96px 0; text-align: center; }',
      '.hero h1 { font-size: clamp(2rem, 6vw, 3.5rem); letter-spacing: -0.02em; }',
      '.tagline { max-width: 640px; margin: 16px auto 32px; color: #57606a; font-size: 1.125rem; }',
      'body.dark .tagline { color: #8b949e; }',
      '.btn { display: inline-block; padding: 12px 28px; border-radius: 8px; font-weight: 600; text-decoration: none; cursor: pointer; border: 0; }',
      '.btn-primary { background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #0d1117; }',
      '',
      '.section { padding: 56px 0; }',
      '.section h2 { font-size: 1.75rem; margin-bottom: 24px; }',
      '.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px; }',
      '.card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }',
      '.card h3 { margin-bottom: 8px; }',
      '.steps { list-style: none; display: grid; gap: 12px; max-width: 560px; }',
      '.steps li { display: flex; align-items: center; gap: 14px; }',
      '.steps span { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; background: var(--accent); color: #0d1117; font-weight: 700; }',
      '.cta { text-align: center; }',
      '.cta p { margin-bottom: 16px; }',
      'code { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 2px 8px; }',
      '',
      '.site-footer { border-top: 1px solid var(--border); padding: 24px 0; text-align: center; color: #57606a; }',
      'body.dark .site-footer { color: #8b949e; }',
      '',
      '@media (max-width: 720px) {',
      '  .nav-toggle { display: block; }',
      '  .nav-links { display: none; flex-direction: column; gap: 8px; width: 100%; padding: 12px 0; }',
      '  .nav-links.open { display: flex; }',
      '  .hero { padding: 64px 0; }',
      '}'
    ].join('\n');
  }

  private webPageJs(): string {
    return [
      '/* LUICode generated vanilla JS */',
      'document.addEventListener("DOMContentLoaded", function () {',
      '  const navToggle = document.getElementById("nav-toggle");',
      '  const navLinks = document.getElementById("nav-links");',
      '  if (navToggle && navLinks) {',
      '    navToggle.addEventListener("click", function () {',
      '      const open = navLinks.classList.toggle("open");',
      '      navToggle.setAttribute("aria-expanded", String(open));',
      '    });',
      '  }',
      '',
      '  const btnTheme = document.getElementById("btn-theme");',
      '  if (btnTheme) {',
      '    btnTheme.addEventListener("click", function () {',
      '      document.body.classList.toggle("dark");',
      '    });',
      '  }',
      '',
      '  const year = document.getElementById("year");',
      '  if (year) year.textContent = String(new Date().getFullYear());',
      '});'
    ].join('\n');
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

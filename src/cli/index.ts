#!/usr/bin/env node

import * as readline from 'readline';
import { Agent } from '../agent/Agent';
import { RunControl } from '../agent/runControl';
import { loadConfig } from '../config/schema';
import { GitManager } from '../git/GitManager';
import { ModelRouter } from '../router/ModelRouter';
import { SessionManager } from '../sessions/SessionManager';
import { Workspace } from '../workspace/Workspace';
import { TerminalUI, printWelcome } from '../ui/TUI';
import { AgentEvent, AutonomyLevel, LuicodeConfig, ProviderKind, Session, TaskKind } from '../types';
import {
  TASK_KINDS,
  addProviderOverride,
  isKnownProvider,
  listProviderIntegrations,
  parseModelSpec,
  routingSummary,
  saveConfigChanges,
  setDefaultProvider,
  setTaskModel,
  testIntegration
} from '../llm/integration';
import { PROVIDER_REGISTRY } from '../llm/provider';

export const VERSION = '0.2.0';
export const TAGLINE = 'LUICode — Plan. Build. Test. Ship.';

interface ParsedArgs {
  mode: AutonomyLevel;
  planOnly: boolean;
  resume: boolean;
  review: boolean;
  version: boolean;
  help: boolean;
  task: string;
  model?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    mode: 'manual',
    planOnly: false,
    resume: false,
    review: false,
    version: false,
    help: false,
    task: ''
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--version' || arg === '-v') out.version = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--plan') out.planOnly = true;
    else if (arg === '--resume') out.resume = true;
    else if (arg === '--review') out.review = true;
    else if (arg === '--auto') out.mode = 'safe';
    else if (arg === '--auto=safe') out.mode = 'safe';
    else if (arg === '--auto=full') out.mode = 'full';
    else if (arg.startsWith('--auto=')) out.mode = 'safe';
    else if (arg === '--model') out.model = argv[++i];
    else if (arg.startsWith('--model=')) out.model = arg.slice('--model='.length);
    else if (arg.startsWith('--')) out.help = true;
    else positional.push(arg);
  }
  out.task = positional.join(' ');
  return out;
}

export function helpText(): string {
  return `${TAGLINE}

USAGE
  luicode                          Launch interactive terminal UI (normal mode)
  luicode --plan [task]            Analyze project and generate a plan (no file changes)
  luicode --auto                   Autonomous dev mode (safe permissions)
  luicode --auto=safe              Autonomous mode, safe permission level
  luicode --auto=full              Autonomous mode, full workspace autonomy
  luicode --resume                 Resume an interrupted session (picker when several exist)
  luicode --review                 Review working-tree changes + security scan
  luicode model                    List model routing and available providers
  luicode model add <name>         Register a custom provider (--base-url --api-key --model)
  luicode model set-default <n>    Set the default provider
  luicode model set <task> <spec>  Route a task to a provider/model (e.g. coder openai/gpt-4o-mini)
  luicode model test <spec>        Verify a provider/model connection (--api-key --timeout)
  luicode server                   Start the LUICode web server for configuration and monitoring
  luicode server --port <port>     Specify server port (default: 3000)
  luicode server --no-open         Do not automatically open browser
  luicode --version                Show version
  luicode --help                   Show this help

INTERACTIVE KEYBINDINGS
  Global:   Ctrl+C stop/exit   Ctrl+Enter submit   Ctrl+P command palette
            Ctrl+R sessions   Ctrl+M models   Ctrl+H help ('?' shortcuts)
            Ctrl+D diff   Ctrl+G git status   Ctrl+T panel area
            Ctrl+L clear   Ctrl+O toggle auto   Ctrl+Q quit
  Agent:    Space pause/resume   R retry   F fix loop   S skip
            Y approve gate   N reject/skip   Esc back
  Prompt:   / -> slash commands (Tab/↑/↓ autocomplete)   ↑/↓ history
  Plan:     ↑/↓ move · Space toggle step · A all · N skip · E replan · V view
  Approval: Y approve / N reject

SLASH COMMANDS
  Use /help for topics, /models for the interactive manager, /model <task> <provider/model>,
  /run <cmd> (through CommandGuard), /test, /build, /git, /review, /context, /tree,
  /memory, /plan, /replan, /execute, /stop, /mode, /permissions, /tools, /config.
  Type "/" in the prompt for a full list with autocomplete.

CONFIG
  ~/.luicode/settings.lock.json     User-level model lock (highest priority for models)
  ~/.luicode/config.yaml            User-level settings (models, providers)
  .luicode/settings.lock.json       Per-project model lock (highest priority for models)
  .luicode/config.yaml              Per-project overrides
  Use \`luicode model ...\` to manage integrations from the CLI (writes the user config).
  Env vars: OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY,
            GROQ_API_KEY, DEEPSEEK_API_KEY, DASHSCOPE_API_KEY, TOGETHER_API_KEY
  Local/free: ollama (localhost:11434), litellm (localhost:4000), groq, deepseek, qwen
  API keys are never stored in the repository.
  Copy .luicode.example/ to .luicode/ and edit settings.lock.json to configure models.
`;
}

export function modelHelpText(): string {
  return `luicode model — manage model/provider integration

USAGE
  luicode model                         List routing + providers (same as 'list')
  luicode model list                    Show current routing and all providers
  luicode model add <name>              Register a custom provider
      --base-url <url>     API base URL (required for unknown providers)
      --api-key <key>      API key (stored in config; use env vars for known providers)
      --model <model>      Default model for this provider
      --local              Write to .luicode/settings.lock.json (or config.yaml) in this project
  luicode model set-default <name>      Set the active provider (e.g. ollama, openrouter)
      --local              Write to project config instead of user config (settings.lock.json when present)
  luicode model set <task> <provider/model>
      Route planner/coder/reviewer/fallback to a specific model
      --local              Write to project config instead of user config
  luicode model test <provider/model>   Ping a connection to verify it works
      --api-key <key>      API key to test with (not persisted)
      --base-url <url>     Override base URL for the test (not persisted)
      --timeout <ms>       Request timeout (default 20000)
  luicode model help                    Show this help

CONFIG FILES
  Settings are loaded in order (later wins):
    ~/.luicode/settings.lock.json       User-level model lock
    ~/.luicode/config.yaml              User-level config
    .luicode/settings.lock.json         Project-level model lock  ← EDIT THIS ONE
    .luicode/config.yaml                Project-level config

  See .luicode.example/settings.lock.json for a ready-to-copy template.

EXAMPLES
  luicode model list
  luicode model add openai --base-url https://api.openai.com/v1 --model gpt-4o-mini
  luicode model set-default ollama
  luicode model set coder openrouter/meta-llama/llama-3.3-70b-instruct
  luicode model test myproxy/llama-3.1 --api-key sk-... --base-url https://proxy.example/v1
`;
}

interface ModelArgs {
  sub: string;
  name?: string;
  task?: string;
  spec?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  kind?: ProviderKind;
  timeoutMs?: number;
  scope: 'user' | 'local';
}

function parseModelArgs(argv: string[]): ModelArgs {
  const out: ModelArgs = { sub: argv[0] ?? 'list', scope: 'user' };
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local') out.scope = 'local';
    else if (a === '--user') out.scope = 'user';
    else if (a === '--base-url' || a === '--baseUrl') out.baseUrl = argv[++i];
    else if (a.startsWith('--base-url=')) out.baseUrl = a.slice('--base-url='.length);
    else if (a === '--api-key') out.apiKey = argv[++i];
    else if (a.startsWith('--api-key=')) out.apiKey = a.slice('--api-key='.length);
    else if (a === '--model') out.model = argv[++i];
    else if (a.startsWith('--model=')) out.model = a.slice('--model='.length);
    else if (a === '--kind') out.kind = argv[++i] as ProviderKind;
    else if (a.startsWith('--kind=')) out.kind = a.slice('--kind='.length) as ProviderKind;
    else if (a === '--timeout') out.timeoutMs = Number(argv[++i]);
    else if (a.startsWith('--timeout=')) out.timeoutMs = Number(a.slice('--timeout='.length));
    else if (a === '-h' || a === '--help') out.sub = 'help';
    else positional.push(a);
  }
  if (out.sub === 'add') out.name = positional[0];
  else if (out.sub === 'set-default') out.name = positional[0];
  else if (out.sub === 'set') {
    out.task = positional[0];
    out.spec = positional[1];
  } else if (out.sub === 'test') out.spec = positional[0];
  return out;
}

function requireName(a: ModelArgs): boolean {
  if (a.name) return true;
  process.stdout.write('Missing provider name. Usage: luicode model add <name> [opts]\n');
  return false;
}

function saved(file: string): string {
  return `Saved to ${file}\n`;
}

function printModelList(config: LuicodeConfig): void {
  const routing = routingSummary(config);
  const width = Math.max(...TASK_KINDS.map((t) => t.length));
  process.stdout.write('\nMODEL ROUTING\n');
  for (const task of TASK_KINDS) {
    process.stdout.write(`  ${task.padEnd(width)}  ${routing[task]}\n`);
  }
  const active =
    config.provider === 'mock'
      ? 'mock (offline mode)'
      : config.provider;
  process.stdout.write(`\nActive provider: ${active}\n`);

  process.stdout.write('\nPROVIDERS\n');
  const rows = listProviderIntegrations(config);
  for (const p of rows) {
    const flags = [
      p.local ? 'local' : '',
      p.freeTier ? 'free' : '',
      p.custom ? 'custom' : '',
      p.configured ? 'configured' : ''
    ].filter(Boolean);
    const key = p.apiKeySet
      ? 'key: set'
      : p.apiKeyEnv
        ? `key: ${p.apiKeyEnv}`
        : 'no key required';
    const baseUrl = p.baseUrl.slice(0, 44);
    const model = p.custom || p.configured ? `  model: ${p.defaultModel}` : '';
    process.stdout.write(
      `  ${p.name.padEnd(12)}${p.kind.padEnd(10)}${baseUrl.padEnd(45)}${flags.length ? `[${flags.join(', ')}] ` : ''}${key}${model}\n`
    );
  }
  process.stdout.write('\nHint: register a custom provider with `luicode model add <name> --base-url <url>`.\n');
}

function modelList(config: LuicodeConfig): void {
  printModelList(config);
}

function modelAdd(cwd: string, config: LuicodeConfig, a: ModelArgs): void {
  if (!requireName(a)) return;
  const name = a.name as string;
  if (a.baseUrl === undefined && a.apiKey === undefined && a.model === undefined && PROVIDER_REGISTRY[name] === undefined) {
    process.stdout.write(`Unknown provider "${name}". Provide --base-url to register a custom provider.\n`);
    return;
  }
  const next = addProviderOverride(config, name, {
    baseUrl: a.baseUrl,
    apiKey: a.apiKey,
    model: a.model
  });
  const file = saveConfigChanges({ providers: next.providers }, { scope: a.scope, cwd });
  process.stdout.write(`Registered provider "${name}".\n${saved(file)}`);
}

function modelSetDefault(cwd: string, config: LuicodeConfig, a: ModelArgs): void {
  if (!requireName(a)) return;
  if (!isKnownProvider(config, a.name as string)) {
    process.stdout.write(`Unknown provider "${a.name}". Register it first with \`luicode model add\`.\n`);
    return;
  }
  const next = setDefaultProvider(config, a.name as string);
  const file = saveConfigChanges({ provider: next.provider }, { scope: a.scope, cwd });
  process.stdout.write(`Default provider set to "${a.name}".\n${saved(file)}`);
}

function modelSet(cwd: string, config: LuicodeConfig, a: ModelArgs): void {
  if (!a.task || !a.spec) {
    process.stdout.write('Usage: luicode model set <task> <provider/model>\n');
    return;
  }
  const task = a.task as TaskKind;
  if (!TASK_KINDS.includes(task)) {
    process.stdout.write(`Unknown task "${a.task}". Valid tasks: ${TASK_KINDS.join(', ')}\n`);
    return;
  }
  const parsed = parseModelSpec(a.spec);
  if (!parsed.provider || !parsed.model) {
    process.stdout.write('Expected a spec in <provider>/<model> form.\n');
    return;
  }
  if (!isKnownProvider(config, parsed.provider)) {
    process.stdout.write(`Unknown provider "${parsed.provider}". Register it first with \`luicode model add\`.\n`);
    return;
  }
  const next = setTaskModel(config, task, a.spec);
  const file = saveConfigChanges({ models: next.models as Record<TaskKind, string> }, { scope: a.scope, cwd });
  process.stdout.write(`Route ${task} -> ${a.spec}.\n${saved(file)}`);
}

async function modelTest(config: LuicodeConfig, a: ModelArgs): Promise<void> {
  if (!a.spec) {
    process.stdout.write('Usage: luicode model test <provider/model> [--api-key KEY] [--base-url URL] [--timeout MS]\n');
    return;
  }
  const parsed = parseModelSpec(a.spec);
  if (!parsed.provider) return;
  if (!isKnownProvider(config, parsed.provider) && !a.baseUrl) {
    process.stdout.write(`Unknown provider "${parsed.provider}". Provide --base-url or register it first.\n`);
    return;
  }
  process.stdout.write(`Testing ${a.spec} ...\n`);
  const result = await testIntegration(config, a.spec, {
    apiKey: a.apiKey,
    baseUrl: a.baseUrl,
    timeoutMs: a.timeoutMs
  });
  if (result.ok) {
    process.stdout.write(`OK ${result.provider}/${result.model} (${result.latencyMs} ms): ${result.reply}\n`);
  } else {
    process.stdout.write(`FAILED ${result.provider}/${result.model} (${result.latencyMs} ms): ${result.error}\n`);
  }
}

async function runModelCommand(cwd: string, config: LuicodeConfig, argv: string[]): Promise<void> {
  const a = parseModelArgs(argv);
  switch (a.sub) {
    case 'help':
      process.stdout.write(modelHelpText());
      break;
    case 'list':
      modelList(config);
      break;
    case 'add':
      modelAdd(cwd, config, a);
      break;
    case 'set-default':
      modelSetDefault(cwd, config, a);
      break;
    case 'set':
      modelSet(cwd, config, a);
      break;
    case 'test':
      await modelTest(config, a);
      break;
    default:
      process.stdout.write(`Unknown model subcommand "${a.sub}". Run \`luicode model help\`.\n`);
  }
}

function describeRoute(config: LuicodeConfig): string {
  return config.provider === 'mock' ? 'mock (offline)' : `${config.provider} // ${config.models.coder ?? 'coder'}`;
}

function printEvent(e: AgentEvent): void {
  switch (e.type) {
    case 'status':
      process.stdout.write(`\n→ ${e.text}\n`);
      break;
    case 'message':
      process.stdout.write(`${e.text ?? ''}\n`);
      break;
    case 'comment':
      if (e.text) process.stdout.write(`  › ${e.text}\n`);
      break;
    case 'tool':
      if (e.tool) process.stdout.write(`  ${e.tool.status === 'ok' ? '✓' : e.tool.status === 'error' ? '✗' : '●'} ${e.tool.name}\n`);
      break;
    case 'test':
      if (e.test) process.stdout.write(`  ${e.test.passed ? '✓' : '✗'} Tests: ${e.test.summary}\n`);
      break;
    case 'command':
      if (e.command) process.stdout.write(`  $ ${e.command.command} (${e.command.code ?? 'killed'})\n`);
      break;
    case 'file':
      if (e.file) process.stdout.write(`  ${e.file.action === 'create' ? '+' : '~'} ${e.file.path}\n`);
      break;
    case 'error':
      process.stdout.write(`  ! ${e.error?.message ?? e.text}\n`);
      break;
    case 'summary':
      if (e.summary) process.stdout.write(`\n=== LUICODE SUMMARY ===\n${e.summary}\n`);
      break;
    default:
      if (e.text) process.stdout.write(`${e.text}\n`);
  }
}

function makeSession(sessions: SessionManager, task: string, mode: AutonomyLevel, resume: boolean, resumeId?: string) {
  if (resume) {
    const s = resumeId ? sessions.load(resumeId) : sessions.latest();
    if (s) return s;
    throw new Error('No previous session found to resume.');
  }
  return sessions.create(task, mode);
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function pickResumeSession(candidates: Array<{ file: string; id: string; updatedAt: number; task: string; status: string }>): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    process.stdout.write('\nInterrupted sessions:\n');
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      process.stdout.write(`  ${i + 1}) ${formatTs(c.updatedAt)}  ${c.task.slice(0, 50) || '(no task)'}  (${c.status})\n`);
    }
    const prompt = `Choose [1-${candidates.length}] (Enter = latest): `;
    rl.question(prompt, (answer) => {
      rl.close();
      const n = parseInt(answer.trim(), 10);
      if (n >= 1 && n <= candidates.length) resolve(candidates[n - 1].id);
      else resolve(candidates[0].id);
    });
  });
}

async function runPlanOnly(cwd: string, config: LuicodeConfig, sessions: SessionManager, interactive: boolean, task: string): Promise<void> {
  const mode: AutonomyLevel = 'manual';
  const routerFor = (t: 'planner' | 'coder' | 'reviewer'): ModelRouter | null => new ModelRouter(config);
  const session = sessions.create(task || 'Plan-only analysis', mode);
  const agent = new Agent({
    cwd,
    config,
    mode,
    router: null,
    routerFor,
    sessions,
    session,
    emit: printEvent,
    askApproval: () => Promise.resolve({ approved: true })
  });
  const result = await agent.runTask(task || 'Analyze this project and produce an implementation plan.', { planOnly: true });
  process.stdout.write('\n' + result.summary);
  process.stdout.write('\n\nPlan saved. To implement, run "luicode" interactively (approve at the prompt) or re-run with --auto.\n');
}

async function runReview(cwd: string, config: LuicodeConfig, sessions: SessionManager): Promise<void> {
  const routerFor = () => null;
  const session = sessions.create('review', 'manual');
  const agent = new Agent({
    cwd,
    config,
    mode: 'manual',
    router: null,
    routerFor,
    sessions,
    session,
    emit: printEvent,
    askApproval: () => Promise.resolve({ approved: true })
  });
  const report = await agent.review();
  process.stdout.write('\n' + report + '\n');
}

async function runServerCommand(cwd: string, config: LuicodeConfig, sessions: SessionManager, argv: string[]): Promise<void> {
  // Parse server-specific arguments
  let port = 3000;
  let open = true;

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' || arg.startsWith('--port=')) {
      port = parseInt(arg.startsWith('--port=') ? arg.slice('--port='.length) : argv[++i], 10);
    } else if (arg === '--no-open') {
      open = false;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (isNaN(port) || port <= 0 || port > 65535) {
    process.stdout.write('Error: Invalid port number. Please specify a valid port between 1 and 65535.\n');
    return;
  }

  process.stdout.write(`Starting LUICode server on port ${port}...\n`);

  try {
    // Import and start the server
    // Note: We're using dynamic import to avoid circular dependencies
    const { LuicodeServer } = await import('../server/server');

    const ws = new Workspace(cwd);
    const git = new GitManager(cwd);

    const server = new LuicodeServer({
      port,
      workspace: ws,
      config,
      sessions,
      gitManager: git
    });

    await server.start();

    process.stdout.write(`LUICode server started at http://localhost:${port}\n`);
    process.stdout.write('Press Ctrl+C to stop the server\n');

    // Open browser if requested
    if (open) {
      const { exec } = await import('child_process');
      try {
        exec(`start http://localhost:${port}`);
      } catch (e) {
        // Ignore errors in opening browser
      }
    }

    // Keep the server running until interrupted
    return new Promise((resolve) => {
      process.once('SIGINT', () => {
        server.stop().then(() => {
          process.stdout.write('\nLUICode server stopped\n');
          resolve();
        });
      });

      process.once('SIGTERM', () => {
        server.stop().then(() => {
          process.stdout.write('\nLUICode server stopped\n');
          resolve();
        });
      });
    });
  } catch (error) {
    process.stdout.write(`Failed to start server: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

async function runTaskOnce(cwd: string, config: LuicodeConfig, sessions: SessionManager, mode: AutonomyLevel, task: string, resume = false): Promise<void> {
  const routerFor = (t: 'planner' | 'coder' | 'reviewer'): ModelRouter | null => new ModelRouter(config);
  const session = makeSession(sessions, task, mode, resume);
  const agent = new Agent({
    cwd,
    config,
    mode,
    router: null,
    routerFor,
    sessions,
    session,
    emit: printEvent,
    askApproval: () => Promise.resolve({ approved: true })
  });
  await agent.runTask(task, { skipApproval: mode !== 'manual' });
}

async function runInteractive(cwd: string, config: LuicodeConfig, sessions: SessionManager, interactive: boolean, projectName: string, args: ParsedArgs, resumeId?: string): Promise<void> {
  if (args.model) applyCliModel(config, args.model);
  const mode = resolveMode(args.mode);
  let modeRef: AutonomyLevel = mode;
  let session;
  try {
    session = makeSession(sessions, args.task, mode, args.resume, resumeId);
  } catch (err) {
    process.stdout.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return;
  }

  const routerFor = (t: TaskKind): ModelRouter | null => new ModelRouter(config);
  const control = new RunControl();
  const ws = new Workspace(cwd);
  const git = new GitManager(cwd);

  printWelcome({ projectName, mode: label(modeRef), model: describeRoute(config), autoBoundary: config.auto.workspaceOnly });

  let agentRef: Agent;
  let running = false;

  const isBusy = (): boolean => running || Boolean(agentRef && !agentRef.control.aborted && agentRef.session.status === 'active');
  const setBusy = (b: boolean): void => {
    if (b) running = true;
  };

  const bindAgent = (a: Agent): void => {
    agentRef = a;
  };

  const onTask = async (text: string): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await agentRef.addMessage('user', text);
      await agentRef.runTask(text, { skipApproval: modeRef !== 'manual' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isCancelledError(msg)) return;
      const ev: AgentEvent = { type: 'error', timestamp: Date.now(), error: new Error(msg), text: 'Operation failed' };
      _ui.handleEvent(ev);
    } finally {
      running = false;
    }
  };

  const _ui = new TerminalUI({
    projectName,
    config,
    mode: modeRef,
    session,
    onToggleAuto: () => {
      modeRef = modeRef === 'manual' ? 'safe' : 'manual';
      if (agentRef) agentRef.setMode(modeRef);
      _ui.setMode(modeRef);
    },
    onInput: (t) => void onTask(t),
    interactive,
    services: {
      cwd,
      projectName,
      config,
      mode: () => modeRef,
      setMode: (m) => {
        modeRef = m;
        if (agentRef) agentRef.setMode(m);
        _ui.setMode(m);
      },
      agent: () => agentRef,
      sessions,
      git,
      ws,
      routerFor,
      runTask: (text) => onTask(text),
      control,
      interactive,
      startNewSession: (t = '') => {
        const next = sessions.create(t, modeRef);
        session = next;
        makeAgent(next);
        _ui.toast('New session started.');
      },
      resumeSession: (id) => {
        const s = sessions.load(id);
        if (!s) {
          _ui.toast('Session not found.');
          return;
        }
        session = s;
        makeAgent(s);
        _ui.toast(`Resumed session ${s.id}`);
      },
      isBusy,
      setBusy
    }
  });

  const makeAgent = (s: Session): void => {
    const a = new Agent({
      cwd,
      config,
      mode: modeRef,
      router: null,
      routerFor,
      sessions,
      session: s,
      emit: (e) => _ui.handleEvent(e),
      askApproval: (q) => _ui.getApproval(q),
      control
    });
    bindAgent(a);
  };

  makeAgent(session);

  if (!interactive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    process.stdout.write('> ');
    rl.on('line', (line) => {
      const t = line.trim();
      if (!t) {
        process.stdout.write('> ');
        return;
      }
      void onTask(t).then(() => process.stdout.write('\n> '));
    });
    rl.on('close', () => {});
    return;
  }

  _ui.start();
  if (args.task) void onTask(args.task);
}

function applyCliModel(config: LuicodeConfig, value: string): void {
  const idx = value.indexOf('/');
  if (idx > 0) {
    config.models = { ...config.models, coder: value };
  } else if (isKnownProvider(config, value)) {
    config.provider = value;
  } else {
    config.models = { ...config.models, coder: value };
  }
}

function isCancelledError(msg: string): boolean {
  return msg.startsWith('CANCELLED:') || msg === 'Error: CANCELLED' || msg.includes('ABORTED:');
}

function resolveMode(name: AutonomyLevel): AutonomyLevel {
  return name === 'full' ? 'full' : name === 'safe' ? 'safe' : 'manual';
}

function label(mode: AutonomyLevel): string {
  return mode === 'full' ? 'AUTO (FULL)' : mode === 'safe' ? 'AUTO (SAFE)' : 'NORMAL';
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.version) {
    process.stdout.write(`luicode v${VERSION}\n`);
    return;
  }
  if (args.help) {
    process.stdout.write(helpText());
    return;
  }

  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const sessions = new SessionManager(cwd);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const projectName = cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'project';

  if (argv[0] === 'model') {
    await runModelCommand(cwd, config, argv.slice(1));
    return;
  }

  if (argv[0] === 'server') {
    await runServerCommand(cwd, config, sessions, argv.slice(1));
    return;
  }

  if (args.review) {
    await runReview(cwd, config, sessions);
    return;
  }

  if (args.planOnly) {
    await runPlanOnly(cwd, config, sessions, interactive, args.task);
    return;
  }

  if (args.task) {
    await runTaskOnce(cwd, config, sessions, resolveMode(args.mode), args.task, Boolean(args.resume));
    return;
  }

  if (args.resume && !interactive) {
    const latest = sessions.latest();
    if (!latest) {
      process.stdout.write('No previous session found to resume.\n');
      return;
    }
    await runTaskOnce(cwd, config, sessions, resolveMode(latest.mode as AutonomyLevel), latest.task, true);
    return;
  }

  let selectedResumeId: string | undefined;
  if (args.resume && interactive) {
    const candidates = sessions.list().filter((s) => s.status !== 'done');
    if (candidates.length > 1) {
      selectedResumeId = await pickResumeSession(candidates);
    }
  }

  await runInteractive(cwd, config, sessions, interactive, projectName, args, selectedResumeId);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`\nLUICode fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
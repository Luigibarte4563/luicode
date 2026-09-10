#!/usr/bin/env node

import * as readline from 'readline';
import { Agent } from '../agent/Agent';
import { loadConfig } from '../config/schema';
import { ModelRouter } from '../router/ModelRouter';
import { SessionManager } from '../sessions/SessionManager';
import { TerminalUI, printWelcome } from '../ui/TUI';
import { AgentEvent, AutonomyLevel, LuicodeConfig } from '../types';

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
  for (const arg of argv) {
    if (arg === '--version' || arg === '-v') out.version = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--plan') out.planOnly = true;
    else if (arg === '--resume') out.resume = true;
    else if (arg === '--review') out.review = true;
    else if (arg === '--auto') out.mode = 'safe';
    else if (arg === '--auto=safe') out.mode = 'safe';
    else if (arg === '--auto=full') out.mode = 'full';
    else if (arg.startsWith('--auto=')) out.mode = 'safe';
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
  luicode --resume                 Resume the last interrupted session
  luicode --review                 Review working-tree changes + security scan
  luicode --version                Show version
  luicode --help                   Show this help

INTERACTIVE KEYBINDINGS
  Ctrl+C cancel/exit   Ctrl+L clear   Ctrl+P plan panel   Ctrl+D diff panel
  Ctrl+T terminal   Ctrl+A activity   Ctrl+O toggle auto   Esc exit

CONFIG
  ~/.luicode/config.yaml            User-level settings (models, providers)
  .luicode/config.yaml              Per-project overrides
  Env vars: OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY,
            GROQ_API_KEY, DEEPSEEK_API_KEY, DASHSCOPE_API_KEY, TOGETHER_API_KEY
  Local/free: ollama (localhost:11434), litellm (localhost:4000), groq, deepseek, qwen
  API keys are never stored in the repository.
`;
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

function makeSession(sessions: SessionManager, task: string, mode: AutonomyLevel, resume: boolean) {
  if (resume) {
    const s = sessions.latest();
    if (s) return s;
    throw new Error('No previous session found to resume.');
  }
  return sessions.create(task, mode);
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
    askApproval: () => Promise.resolve(true)
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
    askApproval: () => Promise.resolve(true)
  });
  const report = await agent.review();
  process.stdout.write('\n' + report + '\n');
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
    askApproval: () => Promise.resolve(true)
  });
  await agent.runTask(task, { skipApproval: mode !== 'manual' });
}

async function runInteractive(cwd: string, config: LuicodeConfig, sessions: SessionManager, interactive: boolean, projectName: string, args: ParsedArgs): Promise<void> {
  const mode = resolveMode(args.mode);
  let modeRef: AutonomyLevel = mode;
  let session;
  try {
    session = makeSession(sessions, args.task, mode, args.resume);
  } catch (err) {
    process.stdout.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return;
  }

  const routerFor = (t: 'planner' | 'coder' | 'reviewer'): ModelRouter | null => new ModelRouter(config);

  printWelcome({ projectName, mode: label(modeRef), model: describeRoute(config), autoBoundary: config.auto.workspaceOnly });

  let agentRef: Agent;
  let running = false;

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
      const ev: AgentEvent = { type: 'error', timestamp: Date.now(), error: new Error(msg), text: 'Operation failed' };
      if (interactive) _ui.handleEvent(ev);
      else printEvent(ev);
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
    interactive
  });

  const agent = new Agent({
    cwd,
    config,
    mode: modeRef,
    router: null,
    routerFor,
    sessions,
    session,
    emit: (e) => {
      if (interactive) _ui.handleEvent(e);
      else printEvent(e);
    },
    askApproval: (q) => _ui.getApproval(q)
  });
  bindAgent(agent);

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

function resolveMode(name: AutonomyLevel): AutonomyLevel {
  return name === 'full' ? 'full' : name === 'safe' ? 'safe' : 'manual';
}

function label(mode: AutonomyLevel): string {
  return mode === 'full' ? 'AUTO (FULL)' : mode === 'safe' ? 'AUTO (SAFE)' : 'NORMAL';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

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

  await runInteractive(cwd, config, sessions, interactive, projectName, args);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`\nLUICode fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
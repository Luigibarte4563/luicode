import { Agent } from '../agent/Agent';
import { Toolkit } from '../agent/toolkit';
import { RunControl } from '../agent/runControl';
import { GitManager } from '../git/GitManager';
import { SessionManager } from '../sessions/SessionManager';
import { Workspace } from '../workspace/Workspace';
import { inspectProject, ProjectProfile } from '../workspace/inspector';
import { ModelRouter } from '../router/ModelRouter';
import { WorkingMemory, MemorySection } from '../memory/WorkingMemory';
import {
  TASK_KINDS,
  listProviderIntegrations,
  parseModelSpec,
  routingSummary,
  saveConfigChanges,
  setTaskModel,
  isKnownProvider
} from '../llm/integration';
import { CommandRisk, LuicodeConfig, AutonomyLevel, Plan, TaskKind, AgentEvent } from '../types';
import * as path from 'path';

export type RgbLike = string | [number, number, number];

export type UiContext =
  | 'global'
  | 'prompt'
  | 'plan'
  | 'diff'
  | 'terminal'
  | 'palette'
  | 'models'
  | 'sessions'
  | 'approval'
  | 'help'
  | 'agent';

/**
 * The surface the TUI exposes to command handlers. Implemented by TerminalUI.
 */
export interface TuiHost {
  handleEvent(e: AgentEvent): void;
  addLine(text: string, color?: RgbLike, prefix?: string): void;
  result(title: string, body: string[]): void;
  toast(text: string, color?: RgbLike): void;
  openPalette(): void;
  openModelManager(): void;
  openSessions(): void;
  openHelp(topic?: string): void;
  confirmYesNo(title: string, detail: string): Promise<boolean>;
  resolveApproval(approved: boolean): void;
  isApprovalPending(): boolean;
  getMode(): AutonomyLevel;
  setMode(m: AutonomyLevel): void;
  focusPanel(panel: 'plan' | 'diff' | 'terminal'): void;
  quit(): void;
}

/**
 * Services provided by the CLI layer and shared with the registry. The
 * registry never re-implements business logic; it only delegates.
 */
export interface CommandServices {
  cwd: string;
  projectName: string;
  config: LuicodeConfig;
  mode: () => AutonomyLevel;
  setMode: (m: AutonomyLevel) => void;
  agent: () => Agent | null;
  sessions: SessionManager;
  git: GitManager;
  ws: Workspace;
  routerFor: (task: TaskKind) => ModelRouter | null;
  runTask: (text: string) => Promise<void>;
  control: RunControl;
  interactive: boolean;
  startNewSession: (t?: string) => void;
  resumeSession: (id: string) => void;
  isBusy: () => boolean;
  setBusy: (b: boolean) => void;
}

export interface CommandContext {
  services: CommandServices;
  tui: TuiHost;
}

export interface KeyBinding {
  combo: string;
  context: UiContext;
}

export interface UICommand {
  id: string;
  name: string;
  aliases?: string[];
  description: string;
  shortcut?: string;
  keybindings?: KeyBinding[];
  category: string;
  slash?: string;
  available?: (ctx: CommandContext) => boolean;
  execute: (ctx: CommandContext, args: string) => void | Promise<void>;
}

export const COMMAND_REGISTRY: UICommand[] = [];

export function registerCommand(cmd: UICommand): UICommand {
  COMMAND_REGISTRY.push(cmd);
  return cmd;
}

// ---------------------------------------------------------------------------
// Helper data used by several commands
// ---------------------------------------------------------------------------

function modeLabel(m: AutonomyLevel): string {
  return m.toUpperCase();
}

// ---------------------------------------------------------------------------
// Startup / general
// ---------------------------------------------------------------------------

registerCommand({
  id: 'submit',
  name: 'Submit',
  description: 'Submit the current prompt to the agent',
  shortcut: 'Ctrl+Enter',
  keybindings: [{ combo: 'ctrl+return', context: 'global' }],
  category: 'General',
  async execute(ctx) {
    const text = (ctx.tui as unknown as { submitPrompt?: () => void }).submitPrompt
      ? ((ctx.tui as unknown as { submitPrompt: () => void }).submitPrompt())
      : undefined;
    void text;
  }
});

registerCommand({
  id: 'command_palette',
  name: 'Open command palette',
  description: 'Open the command palette',
  shortcut: 'Ctrl+P',
  keybindings: [{ combo: 'ctrl+p', context: 'global' }],
  category: 'General',
  aliases: ['palette', 'commands'],
  slash: '/commands',
  execute(ctx) {
    ctx.tui.openPalette();
  }
});

registerCommand({
  id: 'cancel',
  name: 'Stop / cancel',
  description: 'Stop or cancel the current agent operation',
  shortcut: 'Ctrl+C',
  keybindings: [{ combo: 'ctrl+c', context: 'global' }],
  category: 'General',
  execute(ctx) {
    const agent = ctx.services.agent();
    if (ctx.services.isBusy() && agent && !agent.control.aborted) {
      agent.cancel();
    } else {
      ctx.tui.quit();
    }
  }
});

registerCommand({
  id: 'back',
  name: 'Back / cancel UI action',
  description: 'Back or cancel the current UI action',
  shortcut: 'Esc',
  keybindings: [{ combo: 'escape', context: 'global' }],
  category: 'General',
  execute(ctx) {
    (ctx.tui as unknown as { onEsc?: () => boolean }).onEsc?.();
  }
});

registerCommand({
  id: 'clear',
  name: 'Refresh / clear TUI',
  description: 'Refresh or clear the TUI',
  shortcut: 'Ctrl+L',
  keybindings: [{ combo: 'ctrl+l', context: 'global' }],
  category: 'General',
  execute(ctx) {
    (ctx.tui as unknown as { clearPanel?: () => void }).clearPanel?.();
  }
});

registerCommand({
  id: 'toggle_auto',
  name: 'Toggle autonomy mode',
  description: 'Toggle between manual and safe autonomy',
  shortcut: 'Ctrl+O',
  keybindings: [{ combo: 'ctrl+o', context: 'global' }],
  category: 'General',
  execute(ctx) {
    const next: AutonomyLevel = ctx.tui.getMode() === 'manual' ? 'safe' : 'manual';
    ctx.services.setMode(next);
    ctx.tui.setMode(next);
    ctx.tui.toast(`Autonomy toggled → ${modeLabel(next)}`);
  }
});

registerCommand({
  id: 'toggle_panels',
  name: 'Toggle panels',
  description: 'Open or close the plan / diff / terminal panels',
  shortcut: 'Ctrl+T',
  keybindings: [{ combo: 'ctrl+t', context: 'global' }],
  category: 'General',
  execute(ctx) {
    (ctx.tui as unknown as { togglePanelArea?: () => void }).togglePanelArea?.();
  }
});

registerCommand({
  id: 'quit',
  name: 'Quit',
  description: 'Quit LUICode',
  shortcut: 'Ctrl+Q',
  keybindings: [{ combo: 'ctrl+q', context: 'global' }],
  aliases: ['exit'],
  category: 'General',
  slash: '/quit',
  execute(ctx) {
    ctx.tui.quit();
  }
});

// ---------------------------------------------------------------------------
// Help / shortcuts
// ---------------------------------------------------------------------------

registerCommand({
  id: 'help',
  name: 'Help',
  description: 'Show help, keyboard shortcuts and commands',
  shortcut: 'Ctrl+H',
  keybindings: [{ combo: 'ctrl+h', context: 'global' }],
  aliases: ['shortcuts', 'keys'],
  category: 'Help',
  slash: '/help',
  execute(ctx, args) {
    ctx.tui.openHelp(args.trim() || undefined);
  }
});

registerCommand({
  id: 'show_shortcuts',
  name: 'Show shortcuts',
  description: 'Show keyboard shortcuts',
  shortcut: '?',
  keybindings: [{ combo: '?', context: 'prompt' }],
  category: 'Help',
  execute(ctx) {
    ctx.tui.openHelp('shortcuts');
  }
});

// ---------------------------------------------------------------------------
// Session / resume
// ---------------------------------------------------------------------------

registerCommand({
  id: 'resume',
  name: 'Resume session',
  description: 'Resume a previous session',
  shortcut: 'Ctrl+R',
  keybindings: [{ combo: 'ctrl+r', context: 'global' }],
  category: 'Session',
  slash: '/resume',
  execute(ctx) {
    ctx.tui.openSessions();
  }
});

registerCommand({
  id: 'new_session',
  name: 'New session',
  description: 'Start a new session',
  category: 'Session',
  slash: '/new',
  execute(ctx) {
    ctx.services.startNewSession();
  }
});

// ---------------------------------------------------------------------------
// Agent controls
// ---------------------------------------------------------------------------

registerCommand({
  id: 'pause_resume',
  name: 'Pause / resume agent',
  description: 'Pause or resume the running agent',
  shortcut: 'Space',
  keybindings: [{ combo: 'space', context: 'agent' }],
  category: 'Agent',
  execute(ctx) {
    const agent = ctx.services.agent();
    if (!agent) return;
    if (agent.control.aborted) return;
    if (agent.control.paused) agent.resume();
    else agent.pause();
  }
});

registerCommand({
  id: 'retry',
  name: 'Retry failed step',
  description: 'Retry the current or last failed step',
  shortcut: 'R',
  keybindings: [{ combo: 'r', context: 'agent' }, { combo: 'r', context: 'terminal' }],
  category: 'Agent',
  aliases: ['/retry'],
  slash: '/retry',
  execute(ctx) {
    const agent = ctx.services.agent();
    if (!agent) return;
    if (agent.control.aborted) return;
    if (ctx.services.isBusy()) agent.retryStep();
    else ctx.tui.toast('Nothing running — use /fix to loop on the last failure.');
  }
});

registerCommand({
  id: 'fix',
  name: 'Start fix loop',
  description: 'Start the automatic fix loop',
  shortcut: 'F',
  keybindings: [{ combo: 'f', context: 'agent' }, { combo: 'f', context: 'terminal' }],
  category: 'Agent',
  aliases: ['/fix'],
  slash: '/fix',
  async execute(ctx) {
    const agent = ctx.services.agent();
    if (!agent) return;
    if (agent.control.aborted) return;
    if (ctx.services.isBusy()) {
      agent.requestFix();
    } else {
      await agent.fixLoopNow();
    }
  }
});

registerCommand({
  id: 'skip',
  name: 'Skip current step',
  description: 'Skip the current plan step',
  shortcut: 'S',
  keybindings: [{ combo: 's', context: 'agent' }],
  category: 'Agent',
  aliases: ['skip-step'],
  execute(ctx) {
    const agent = ctx.services.agent();
    if (!agent || agent.control.aborted) return;
    agent.skipStep();
  }
});

registerCommand({
  id: 'approve',
  name: 'Approve current operation',
  description: 'Approve the current operation / next approval gate',
  shortcut: 'Y',
  keybindings: [{ combo: 'y', context: 'agent' }, { combo: 'y', context: 'approval' }],
  category: 'Agent',
  aliases: ['yes', 'ok'],
  slash: '/approve',
  execute(ctx) {
    if (ctx.tui.isApprovalPending()) {
      ctx.tui.resolveApproval(true);
      return;
    }
    ctx.services.control.requestApproveNext();
    ctx.tui.toast('Next approval gate will auto-approve.');
  }
});

registerCommand({
  id: 'reject',
  name: 'Reject / skip current operation',
  description: 'Reject or skip the current operation',
  shortcut: 'N',
  keybindings: [{ combo: 'n', context: 'agent' }, { combo: 'n', context: 'approval' }],
  category: 'Agent',
  aliases: ['no'],
  slash: '/reject',
  execute(ctx) {
    if (ctx.tui.isApprovalPending()) {
      ctx.tui.resolveApproval(false);
      return;
    }
    ctx.services.control.requestRejectNext();
    ctx.tui.toast('Next approval gate will be rejected.');
  }
});

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

function applyModelChange(ctx: CommandContext, task: TaskKind, spec: string): void {
  const parsed = parseModelSpec(spec);
  if (!parsed.provider || !parsed.model) {
    ctx.tui.toast(`Expected a spec in <provider>/<model> form: "${spec}"`);
    return;
  }
  if (!isKnownProvider(ctx.services.config, parsed.provider)) {
    ctx.tui.toast(`Unknown provider "${parsed.provider}". Use /providers to list known providers.`);
    return;
  }
  const next = setTaskModel(ctx.services.config, task, spec);
  try {
    saveConfigChanges({ models: next.models as Partial<Record<TaskKind, string>> }, { scope: 'local', cwd: ctx.services.cwd });
  } catch {
    ctx.tui.toast('Model updated for this session (config save failed).');
  }
  ctx.services.config.models = { ...ctx.services.config.models };
  if (ctx.services.config.models) {
    ctx.services.config.models[task] = spec;
  }
  ctx.tui.toast(`Route ${task} → ${spec}`);
}

export function modelRoutingLines(config: LuicodeConfig): string[] {
  const routing = routingSummary(config);
  return TASK_KINDS.map((t) => `  ${t.padEnd(9)}  ${routing[t] ?? '—'}`);
}

registerCommand({
  id: 'models',
  name: '/models',
  description: 'Switch or inspect models',
  shortcut: 'Ctrl+M',
  keybindings: [{ combo: 'ctrl+m', context: 'global' }],
  category: 'Models',
  slash: '/models',
  execute(ctx) {
    ctx.tui.openModelManager();
  }
});

registerCommand({
  id: 'model',
  name: '/model',
  description: 'Show or change the model routing',
  category: 'Models',
  aliases: ['model-set'],
  slash: '/model',
  execute(ctx, args) {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) {
      ctx.tui.result('MODEL ROUTING', modelRoutingLines(ctx.services.config));
      return;
    }
    let task: TaskKind = 'coder';
    let spec: string;
    if (parts.length === 1 || !TASK_KINDS.includes(parts[0] as TaskKind)) {
      spec = parts[0];
    } else {
      task = parts[0] as TaskKind;
      spec = parts.slice(1).join(' ');
    }
    applyModelChange(ctx, task, spec);
  }
});

registerCommand({
  id: 'providers',
  name: '/providers',
  description: 'Show available providers',
  category: 'Models',
  aliases: ['provider-list'],
  slash: '/providers',
  execute(ctx) {
    const rows = listProviderIntegrations(ctx.services.config);
    const lines: string[] = [];
    for (const p of rows) {
      lines.push(
        `  ${p.name}  [${p.kind}]${p.local ? ' (local)' : ''}${p.freeTier ? ' (free)' : ''}  default=${p.defaultModel}  ${p.apiKeySet ? 'key: set' : p.apiKeyEnv ? `key: ${p.apiKeyEnv}` : 'no key required'}`
      );
    }
    ctx.tui.result('PROVIDERS', lines);
  }
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

registerCommand({
  id: 'plan',
  name: '/plan',
  description: 'Create or display an implementation plan',
  category: 'Plan',
  aliases: ['create-plan'],
  slash: '/plan',
  async execute(ctx, args) {
    const agent = ctx.services.agent();
    if (!agent) {
      ctx.tui.toast('No active agent.');
      return;
    }
    const task = args.trim() || agent.session.task || 'Implement the requested feature';
    ctx.tui.result('PLANNING', ['Inspecting project and preparing an implementation plan…']);
    const plan = await agent.createPlanOnly(task);
    ctx.tui.focusPanel('plan');
    void plan;
  }
});

registerCommand({
  id: 'replan',
  name: '/replan',
  description: 'Re-plan the current task against the latest project state',
  category: 'Plan',
  aliases: ['re-plan'],
  slash: '/replan',
  async execute(ctx) {
    const agent = ctx.services.agent();
    if (!agent) {
      ctx.tui.toast('No active agent.');
      return;
    }
    const plan = await agent.createPlanOnly(agent.session.task || 'Implement the requested feature');
    ctx.tui.focusPanel('plan');
    void plan;
  }
});

registerCommand({
  id: 'edit_plan',
  name: 'Edit plan',
  description: 'Re-plan the current task (edit/regenerate plan)',
  shortcut: 'E',
  keybindings: [{ combo: 'e', context: 'plan' }],
  category: 'Plan',
  async execute(ctx) {
    const agent = ctx.services.agent();
    if (!agent) return;
    const plan = await agent.createPlanOnly(agent.session.task || 'Implement the requested feature');
    ctx.tui.focusPanel('plan');
    void plan;
  }
});

registerCommand({
  id: 'replan_plan',
  name: 'Re-plan',
  description: 'Re-plan the current task',
  shortcut: 'R',
  keybindings: [{ combo: 'r', context: 'plan' }],
  category: 'Plan',
  async execute(ctx) {
    const agent = ctx.services.agent();
    if (!agent) return;
    const plan = await agent.createPlanOnly(agent.session.task || 'Implement the requested feature');
    ctx.tui.focusPanel('plan');
    void plan;
  }
});

registerCommand({
  id: 'plan_details',
  name: 'Step details',
  description: 'Show the current step details',
  shortcut: 'D',
  keybindings: [{ combo: 'd', context: 'plan' }],
  category: 'Plan',
  execute(ctx) {
    (ctx.tui as unknown as { showCurrentStepDetail?: () => void }).showCurrentStepDetail?.();
  }
});

registerCommand({
  id: 'view_plan_md',
  name: 'View plan.md',
  description: 'View the plan.md file',
  shortcut: 'V',
  keybindings: [{ combo: 'v', context: 'plan' }],
  category: 'Plan',
  execute(ctx) {
    const content = ctx.services.ws.readFileSafe('plan.md');
    ctx.tui.result('plan.md', (content || '(no plan.md yet)').split('\n'));
  }
});

registerCommand({
  id: 'execute_plan',
  name: 'Execute approved plan',
  description: 'Execute the approved plan',
  shortcut: 'Enter',
  keybindings: [{ combo: 'return', context: 'plan' }],
  aliases: ['run-plan', '/execute'],
  category: 'Plan',
  slash: '/execute',
  async execute(ctx) {
    const agent = ctx.services.agent();
    if (!agent) return;
    const plan = agent.session.plan;
    if (plan && plan.status !== 'implemented' && plan.status !== 'cancelled') {
      await ctx.services.runTask(agent.session.task || plan.task);
    } else {
      await ctx.services.runTask(agent.session.task || 'Implement the requested feature');
    }
    void plan;
  }
});

// ---------------------------------------------------------------------------
// Plan panel navigation / approval
// ---------------------------------------------------------------------------

registerCommand({
  id: 'plan_up',
  name: 'Previous step',
  description: 'Move to the previous plan step',
  shortcut: '↑',
  keybindings: [{ combo: 'up', context: 'plan' }, { combo: 'k', context: 'plan' }],
  category: 'Plan',
  execute(ctx) {
    (ctx.tui as unknown as { movePlan?: (d: number) => void }).movePlan?.(-1);
  }
});

registerCommand({
  id: 'plan_down',
  name: 'Next step',
  description: 'Move to the next plan step',
  shortcut: '↓',
  keybindings: [{ combo: 'down', context: 'plan' }, { combo: 'j', context: 'plan' }],
  category: 'Plan',
  execute(ctx) {
    (ctx.tui as unknown as { movePlan?: (d: number) => void }).movePlan?.(1);
  }
});

registerCommand({
  id: 'plan_toggle',
  name: 'Toggle step approval',
  description: 'Toggle approval for the highlighted step',
  shortcut: 'Space',
  keybindings: [{ combo: 'space', context: 'plan' }],
  category: 'Plan',
  execute(ctx) {
    (ctx.tui as unknown as { togglePlanStep?: () => void }).togglePlanStep?.();
  }
});

registerCommand({
  id: 'plan_approve_all',
  name: 'Approve all steps',
  description: 'Approve all plan steps',
  shortcut: 'A',
  keybindings: [{ combo: 'a', context: 'plan' }],
  aliases: ['approve-all'],
  category: 'Plan',
  execute(ctx) {
    (ctx.tui as unknown as { approveAllSteps?: () => void }).approveAllSteps?.();
  }
});

registerCommand({
  id: 'plan_reject',
  name: 'Reject / skip step',
  description: 'Reject the plan or skip the highlighted step',
  shortcut: 'N',
  keybindings: [{ combo: 'n', context: 'plan' }],
  category: 'Plan',
  execute(ctx) {
    (ctx.tui as unknown as { rejectOrSkipPlan?: () => void }).rejectOrSkipPlan?.();
  }
});

// ---------------------------------------------------------------------------
// Diff panel
// ---------------------------------------------------------------------------

registerCommand({
  id: 'diff',
  name: 'Show Git diff',
  description: 'Show the Git diff',
  shortcut: 'Ctrl+D',
  keybindings: [{ combo: 'ctrl+d', context: 'global' }],
  category: 'Git',
  aliases: ['git-diff'],
  slash: '/diff',
  execute(ctx) {
    ctx.tui.focusPanel('diff');
  }
});

registerCommand({
  id: 'git_status',
  name: 'Git status',
  description: 'Show Git status',
  shortcut: 'Ctrl+G',
  keybindings: [{ combo: 'ctrl+g', context: 'global' }, { combo: 'g', context: 'diff' }],
  category: 'Git',
  aliases: ['status', 'git-status'],
  slash: '/status',
  async execute(ctx) {
    const out = await ctx.services.git.status();
    ctx.tui.result('GIT STATUS', out.trim().split('\n').map((l) => `  ${l}`).filter(Boolean));
  }
});

registerCommand({
  id: 'git_log',
  name: 'Git log',
  description: 'Show recent Git history',
  category: 'Git',
  aliases: ['log', 'git-log'],
  slash: '/log',
  async execute(ctx, args) {
    const count = parseInt(args.trim(), 10);
    const out = await ctx.services.git.log(Number.isFinite(count) ? count : 10);
    ctx.tui.result('GIT LOG', out.trim().split('\n').map((l) => `  ${l}`));
  }
});

registerCommand({
  id: 'git_branch',
  name: 'Git branch',
  description: 'Show the current Git branch',
  category: 'Git',
  aliases: ['branch', 'git-branch'],
  slash: '/branch',
  async execute(ctx) {
    const out = await ctx.services.git.branch();
    ctx.tui.result('GIT BRANCH', [`  ${out}`]);
  }
});

registerCommand({
  id: 'review',
  name: 'Review changes',
  description: 'Review current changes with a security scan',
  category: 'Agent',
  aliases: ['review-changes'],
  slash: '/review',
  async execute(ctx) {
    const agent = ctx.services.agent();
    if (!agent) {
      ctx.tui.toast('No active agent.');
      return;
    }
    const report = await agent.review();
    ctx.tui.result('REVIEW', report.split('\n'));
  }
});

export const diffPanelCommands = [
  'diff_open',
  'diff_all',
  'diff_summary',
  'diff_refresh',
  'diff_back'
] as const;

// ---------------------------------------------------------------------------
// Browse / project inspection
// ---------------------------------------------------------------------------

registerCommand({
  id: 'tree',
  name: '/tree',
  description: 'Show the project file tree',
  category: 'Browse',
  slash: '/tree',
  execute(ctx) {
    const tree = ctx.services.ws.tree('.', 4);
    ctx.tui.result('PROJECT TREE', tree.split('\n'));
  }
});

registerCommand({
  id: 'context',
  name: '/context',
  description: 'Show the current project / agent context',
  category: 'System',
  slash: '/context',
  execute(ctx) {
    const profile = inspectProject(ctx.services.ws);
    const agent = ctx.services.agent();
    const session = agent?.session;
    const plan = session?.plan;
    const done = plan?.steps.filter((s) => s.status === 'done').length ?? 0;
    const total = plan?.steps.length ?? 0;
    const passed = session?.testResults.filter((t) => t.passed).length ?? 0;
    const tests = session?.testResults.length ?? 0;
    const changes = session?.fileChanges.length ?? 0;
    const routing = routingSummary(ctx.services.config);
    const lines = [
      'PROJECT',
      '────────────────────────────',
      `  Workspace:      ${ctx.services.projectName}`,
      `  Framework:      ${profile.framework}`,
      `  Language:       ${profile.language}`,
      `  Package manager: ${profile.packageManager}`,
      `  Test framework: ${profile.testFramework}`,
      '',
      'AGENT',
      '────────────────────────────',
      `  Mode:           ${modeLabel(ctx.tui.getMode())}`,
      `  Session:        ${session?.id ?? '—'}`,
      `  Current task:   ${session?.task ?? '—'}`,
      '',
      'MODELS',
      '────────────────────────────',
      ...TASK_KINDS.map((t) => `  ${t.padEnd(9)}  ${routing[t] ?? '—'}`),
      '',
      'STATE',
      '────────────────────────────',
      `  Plan:           ${plan?.status ?? '—'}`,
      `  Current step:   ${total ? `${done}/${total}` : '—'}`,
      `  Tests:          ${tests ? `${passed}/${tests} passed` : '—'}`,
      `  Changes:        ${changes} file(s)`
    ];
    ctx.tui.result('CONTEXT', lines);
  }
});

registerCommand({
  id: 'search',
  name: '/search',
  description: 'Search project source code',
  category: 'Browse',
  aliases: ['find'],
  slash: '/search',
  async execute(ctx, args) {
    const q = args.trim();
    if (!q) {
      ctx.tui.toast('Usage: /search <query>');
      return;
    }
    await ctx.services.runTask(`search_code: ${q}`);
  }
});

// Project Understanding
registerCommand({
  id: 'understand',
  name: 'Project Understanding',
  description: 'Analyze and map the project structure, dependencies, and architecture',
  category: 'System',
  aliases: ['project-map', 'project-understanding'],
  slash: '/understand',
  execute(ctx, args) {
    const refresh = args.trim() === '--refresh';
    understandProject(ctx, refresh);
  }
});

registerCommand({
  id: 'read',
  name: '/read',
  description: 'Read a file from the workspace',
  category: 'Browse',
  slash: '/read',
  async execute(ctx, args) {
    const file = args.trim();
    if (!file) {
      ctx.tui.toast('Usage: /read <file>');
      return;
    }
    const toolkit = ephemeralToolkit(ctx);
    const call = await toolkit.runTool('read_file', { path: file });
    ctx.tui.result(`READ ${file}`, (call.output ?? call.error ?? 'File not found.').split('\n'));
  }
});

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

const MEMORY_ALIASES: Record<string, MemorySection> = {
  plan: 'Plan',
  completed: 'Completed Steps',
  'completed steps': 'Completed Steps',
  blockers: 'Blockers',
  notes: 'Notes'
};

registerCommand({
  id: 'memory',
  name: '/memory',
  description: 'Show working memory (plan, completed, blockers, notes)',
  category: 'Session',
  aliases: ['working-memory', 'mem'],
  slash: '/memory',
  async execute(ctx, args) {
    const agent = ctx.services.agent();
    const sessionId = agent?.session.id ?? 'interactive';
    const mem = new WorkingMemory(sessionId, path.join(ctx.services.cwd, '.luicode'));
    await mem.init();
    const parts = args.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) {
      ctx.tui.result('WORKING MEMORY', (await mem.read()).split('\n'));
      return;
    }
    const section = MEMORY_ALIASES[parts[0].toLowerCase()] ?? MEMORY_ALIASES[parts.join(' ').toLowerCase()];
    if (!section) {
      ctx.tui.toast(`Unknown memory section: ${parts[0]}. Use plan | completed | blockers | notes`);
      return;
    }
    const rest = args.trim().slice(parts[0].length).trim();
    if (rest) {
      const res = await mem.append(section, rest);
      ctx.tui.toast(res.ok ? `Memory updated (${section}).` : `Memory update failed: ${res.error}`);
      return;
    }
    const body = (await mem.readSection(section)) || '(empty)';
    ctx.tui.result(`MEMORY — ${section}`, body.split('\n'));
  }
});

// Server
registerCommand({
  id: 'server',
  name: 'LUICode Server',
  description: 'Start the LUICode web server for configuration and monitoring',
  category: 'System',
  aliases: ['server-start'],
  slash: '/server',
  async execute(ctx) {
    const { services } = ctx;
    const { ws, config, sessions, git } = services;

    const port = 3000; // Default port

    try {
      ctx.tui.toast(`Starting LUICode server on http://localhost:${port}...`);

      // Import and start the server
      const { LuicodeServer } = await import('../server/server');

      const server = new LuicodeServer({
        port,
        workspace: ws,
        config,
        sessions,
        gitManager: git
      });

      await server.start();

      ctx.tui.toast(`LUICode server started at http://localhost:${port}`);
      ctx.tui.toast('Press Ctrl+C to stop the server');

      // Open browser if requested
      // Note: In the interactive UI, we always open the browser
      const { exec } = await import('child_process');
      try {
        exec(`start http://localhost:${port}`);
      } catch (e) {
        // Ignore errors in opening browser
      }

      // Keep the server running until interrupted
      // In a real implementation, we'd handle shutdown signals properly
      return new Promise((resolve) => {
        process.once('SIGINT', () => {
          server.stop().then(() => {
            ctx.tui.toast('LUICode server stopped');
            resolve();
          });
        });
      });
    } catch (error) {
      ctx.tui.toast(`Failed to start server: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Execution / tests
// ---------------------------------------------------------------------------

/**
 * Build a throwaway Toolkit wired to the live command guard, permission
 * manager and TUI so slash commands run through the *real* safety layer.
 */
export function ephemeralToolkit(ctx: CommandContext): Toolkit {
  return new Toolkit({
    ws: ctx.services.ws,
    config: ctx.services.config,
    mode: ctx.tui.getMode(),
    emit: (e) => ctx.tui.handleEvent(e),
    control: ctx.services.control,
    askCommandApproval: async (cmd) => ctx.tui.confirmYesNo('Run command', cmd)
  });
}

async function runCommandViaGuard(ctx: CommandContext, command: string): Promise<void> {
  if (!command.trim()) {
    ctx.tui.toast('No command to run.');
    return;
  }
  const toolkit = ephemeralToolkit(ctx);
  const rec = await toolkit.runCommandTool(command);
  ctx.tui.result(
    `COMMAND ${rec.risk === 'blocked' ? '(BLOCKED)' : rec.risk === 'modify' ? '(MODIFY)' : '(SAFE)'} $ ${command}`,
    [
      rec.stdout,
      rec.stderr,
      `EXIT_CODE: ${rec.code ?? 'rejected'} (${rec.durationMs}ms)`
    ].filter((l) => l.length > 0)
  );
}

registerCommand({
  id: 'execute',
  name: '/execute',
  description: 'Execute the approved plan / current task',
  category: 'Agent',
  aliases: ['exec', 'run-plan'],
  slash: '/execute',
  async execute(ctx, args) {
    const agent = ctx.services.agent();
    if (!agent) {
      ctx.tui.toast('No active agent.');
      return;
    }
    const task = args.trim() || agent.session.task || 'Implement the requested feature';
    await ctx.services.runTask(task);
  }
});

registerCommand({
  id: 'stop',
  name: '/stop',
  description: 'Stop the agent',
  category: 'Agent',
  aliases: ['cancel-run', 'halt'],
  slash: '/stop',
  execute(ctx) {
    const agent = ctx.services.agent();
    if (agent && !agent.control.aborted) agent.cancel();
    else ctx.tui.toast('Agent is not running.');
  }
});

registerCommand({
  id: 'run',
  name: '/run',
  description: 'Run a command through CommandGuard',
  category: 'Execution',
  slash: '/run',
  async execute(ctx, args) {
    try {
      await runCommandViaGuard(ctx, args);
    } catch (err) {
      ctx.tui.toast(err instanceof Error ? err.message : String(err));
    }
  }
});

registerCommand({
  id: 'test',
  name: '/test',
  description: 'Run the project tests through the safety system',
  category: 'Execution',
  aliases: ['test-run', 'run-tests'],
  slash: '/test',
  async execute(ctx, args) {
    const cmd = args.trim() || ctx.services.agent()?.session.plan?.tests[0] || 'npm test';
    try {
      await runCommandViaGuard(ctx, cmd);
    } catch (err) {
      ctx.tui.toast(err instanceof Error ? err.message : String(err));
    }
  }
});

registerCommand({
  id: 'build',
  name: '/build',
  description: 'Build the project through the safety system',
  category: 'Execution',
  slash: '/build',
  async execute(ctx, args) {
    try {
      await runCommandViaGuard(ctx, args.trim() || 'npm run build');
    } catch (err) {
      ctx.tui.toast(err instanceof Error ? err.message : String(err));
    }
  }
});

// ---------------------------------------------------------------------------
// Tools / safety / config
// ---------------------------------------------------------------------------

registerCommand({
  id: 'tools',
  name: '/tools',
  description: 'Show the tools available to the agent',
  category: 'System',
  slash: '/tools',
  execute(ctx) {
    const toolkit = ephemeralToolkit(ctx);
    const names = toolkit.names();
    const groups: Array<{ label: string; tools: string[]; available: boolean }> = [
      { label: 'File', tools: [], available: true },
      { label: 'Search', tools: [], available: true },
      { label: 'Advanced', tools: [], available: true },
      { label: 'Execution', tools: ['run_command'], available: true },
      { label: 'Git', tools: [], available: ctx.services.config.git.enabled }
    ];
    for (const n of names) {
      if (n === 'run_command') continue;
      if (compileFileToolSet.includes(n)) groups[0].tools.push(n);
      else if (compileSearchToolSet.includes(n)) groups[1].tools.push(n);
      else if (compileAdvancedToolSet.includes(n)) groups[2].tools.push(n);
      else if (compileGitToolSet.includes(n)) groups[3 - 1].tools.push(n);
      else groups[0].tools.push(n);
    }
    const lines: string[] = ['AVAILABLE TOOLS', ''];
    for (const g of groups) {
      lines.push(`${g.label} ${g.available ? '' : '(unavailable — git disabled in config)'}`);
      if (g.tools.length) {
        for (const t of g.tools) lines.push(`  ${t}`);
      } else if (!g.available) {
        lines.push('  (none)');
      }
      lines.push('');
    }
    ctx.tui.result('TOOLS', lines);
  }
});

const compileFileToolSet = ['read_file', 'write_file', 'edit_file', 'create_file', 'delete_file', 'rename_file', 'move_file', 'list_directory'];
const compileSearchToolSet = ['search_files', 'search_code', 'read_project_tree'];
const compileAdvancedToolSet = ['ast_edit', 'line_edit'];
const compileGitToolSet = ['git_status', 'git_diff', 'git_log', 'git_branch'];

registerCommand({
  id: 'permissions',
  name: '/permissions',
  description: 'Show the current safety / permission state',
  category: 'Safety',
  aliases: ['safety', 'permission'],
  slash: '/permissions',
  execute(ctx) {
    const ws = ctx.services.ws;
    const lines = [
      'LUICode Safety',
      '',
      `  Workspace boundary: ${paintYes(true)}`,
      `  Symlink protection: ${paintYes(true)}  (realpath/canonicalized path checks)`,
      `  Protected paths:    ${paintYes(ws.protectPaths().length > 0)} (${ws.protectPaths().length} paths)`,
      `  Secret redaction:   ${paintYes(true)}`,
      `  CommandGuard:       ${paintYes(true)}`,
      '',
      `Mode: ${modeLabel(ctx.tui.getMode())}`,
      '',
      '  SAFE              auto-approved',
      '  MODIFY            requires approval',
      '  MODIFY+NETWORK    requires approval',
      '  BLOCKED           never allowed'
    ];
    ctx.tui.result('PERMISSIONS', lines);
  }
});

function paintYes(v: boolean): string {
  return v ? '[ENABLED]' : '[DISABLED]';
}

registerCommand({
  id: 'config',
  name: '/config',
  description: 'Show the current configuration',
  category: 'System',
  slash: '/config',
  execute(ctx) {
    const c = ctx.services.config;
    const lines = [
      `  provider:          ${c.provider}`,
      `  mode:              ${modeLabel(ctx.tui.getMode())}`,
      `  git.enabled:       ${c.git.enabled}`,
      `  sandbox.enabled:   ${c.sandbox.enabled}`,
      `  command timeout:   ${c.terminal.commandTimeoutMs}ms`,
      `  max output:        ${c.terminal.maxOutputBytes} bytes`,
      `  agent.maxIterations: ${c.agent.maxIterations}`,
      `  agent.autoFix:     ${c.agent.autoFix}`,
      `  terminal whitelist: ${c.terminal.whitelist.length} entries`
    ];
    ctx.tui.result('CONFIG', lines);
  }
});

registerCommand({
  id: 'mode',
  name: '/mode',
  description: 'Show or change the agent mode (manual | safe | full)',
  category: 'System',
  aliases: ['autonomy'],
  slash: '/mode',
  execute(ctx, args) {
    const m = args.trim().toLowerCase() as AutonomyLevel;
    if (m === 'manual' || m === 'safe' || m === 'full') {
      ctx.services.setMode(m);
      ctx.tui.setMode(m);
      ctx.tui.toast(`Mode → ${modeLabel(m)}`);
      return;
    }
    ctx.tui.result(
      'AGENT MODES',
      [
        `Current mode: ${modeLabel(ctx.tui.getMode())}`,
        '',
        '  Manual',
        '    Plan requires human approval.',
        '',
        '  Safe',
        '    Safe actions proceed automatically.',
        '    Risky actions require approval.',
        '',
        '  Full',
        '    Agent runs autonomously subject to safety boundaries.',
        '    (workspace boundary, protected paths, blocked commands,',
        '     secret redaction and CommandGuard remain enforced)'
      ]
    );
  }
});

// ---------------------------------------------------------------------------
// Slash command support
// ---------------------------------------------------------------------------

export function slashCommands(): UICommand[] {
  return COMMAND_REGISTRY.filter((c) => c.slash).sort((a, b) => a.name.localeCompare(b.name));
}

export function findCommandByName(name: string): UICommand | null {
  const n = name.startsWith('/') ? name : `/${name}`;
  const byId = COMMAND_REGISTRY.find((c) => c.id === n || c.slash === n || c.slash === name || c.name === n || c.name === name);
  if (byId) return byId;
  const lower = n.toLowerCase();
  return (
    COMMAND_REGISTRY.find(
      (c) =>
        c.slash?.toLowerCase() === lower ||
        (c.aliases ?? []).some((a) => `/${a.replace(/^\//, '')}`.toLowerCase() === lower || a.toLowerCase() === name.toLowerCase()) ||
        c.id.toLowerCase().replace(/_/g, '') === name.toLowerCase().replace(/\//g, '')
    ) ?? null
  );
}

function fuzzyScore(query: string, candidate: string): number {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (!q) return 1;
  if (c === q) return 100;
  if (c.startsWith(q)) return 80;
  if (c.includes(q)) return 50;
  let i = 0;
  let score = 0;
  for (const ch of c) {
    if (ch === q[i]) {
      score++;
      i++;
      if (i === q.length) return 30 + score;
    }
  }
  return 0;
}

/**
 * Slash-command autocomplete used by the prompt overlay: / → all commands,
 * /mo → /model + /models, etc. Returns commands sorted by fuzzy relevance.
 */
export function slashAutocomplete(text: string, max = 10): UICommand[] {
  const q = text.replace(/^\s*\//, '');
  const cmds = slashCommands().filter((c) => c.slash);
  const scored = cmds
    .map((c) => {
      const haystack = `${c.slash} ${c.name} ${(c.aliases ?? []).join(' ')} ${c.description}`;
      const score = Math.max(
        fuzzyScore(q, c.slash ?? ''),
        fuzzyScore(q, c.id),
        fuzzyScore(q, c.name),
        fuzzyScore(q, haystack)
      );
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
  return scored.map((x) => x.c);
}

export interface SlashInvocation {
  name: string;
  args: string;
}

/** Parse "/models" or "/model coder ollama/qwen3:1.7b" into name + raw args. */
export function parseSlash(raw: string): SlashInvocation | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) return null;
  const body = trimmed.slice(1).trim();
  const m = body.match(/^([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] ?? '').trim() };
}

export interface SlashResult {
  handled: boolean;
  command?: UICommand;
  message?: string;
}

/**
 * Execute a slash command line against the live context. Unknown commands
 * return { handled: false } so the caller can surface a graceful message.
 */
export async function executeSlash(raw: string, ctx: CommandContext): Promise<SlashResult> {
  const parsed = parseSlash(raw);
  if (!parsed) return { handled: false, message: 'Not a slash command.' };
  const cmd = findCommandByName(parsed.name);
  if (!cmd) return { handled: false, message: `Unknown command /${parsed.name}` };
  if (!cmd.slash) return { handled: false, message: `/${parsed.name} is not a slash command.` };
  try {
    await cmd.execute(ctx, parsed.args);
  } catch (err) {
    return { handled: true, message: err instanceof Error ? err.message : String(err) };
  }
  return { handled: true, command: cmd };
}

// ---------------------------------------------------------------------------
// Palette entries
// ---------------------------------------------------------------------------

export interface PaletteEntry {
  command: UICommand;
  left: string;
  right: string;
}

/**
 * Command palette contents: every actionable keyboard command plus every
 * slash command, cross-referenced so each entry maps to one real handler.
 */
export function paletteEntries(): PaletteEntry[] {
  const seen = new Set<string>();
  const out: PaletteEntry[] = [];
  for (const c of COMMAND_REGISTRY) {
    const key = c.slash ?? c.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const right = c.shortcut
      ? c.shortcut
      : c.slash
        ? c.slash
        : '';
    out.push({ command: c, left: c.slash ? c.slash.replace(/^\//, '') : c.name, right });
  }
  return out.sort((a, b) => a.left.localeCompare(b.left));
}

export function isCommandAvailable(cmd: UICommand, ctx: CommandContext): boolean {
  return !cmd.available || cmd.available(ctx);
}

export function classifyRiskKind(risk?: CommandRisk): 'safe' | 'modify' | 'blocked' | 'unknown' {
  return risk ?? 'unknown';
}

export { path as pathUtils };

// Re-export for consumers that want the current runtime plan.
export function currentPlan(services: CommandServices): Plan | null {
  return services.agent()?.session.plan ?? null;
}

// Project Understanding Service
async function understandProject(ctx: CommandContext, refresh: boolean = false): Promise<void> {
  const { services, tui } = ctx;
  const { ws } = services;

  tui.result('PROJECT UNDERSTANDING', ['Analyzing project...']);

  try {
    // Check if project map exists and we're not forcing a refresh
    const projectMapPath = '.luicode/project-map.md';
    const projectMapExists = ws.absoluteExists(path.join(ws.root, projectMapPath));

    if (projectMapExists && !refresh) {
      const existingMap = ws.readFileSafe(projectMapPath);
      if (existingMap) {
        tui.result('PROJECT UNDERSTANDING (CACHED)', existingMap.split('\n'));
        tui.toast('Project understanding loaded from cache. Use /understand --refresh to rebuild.');
        return;
      }
    }

    // Inspect the project
    const profile = inspectProject(ws);
    const allFiles = ws.walkFiles();

    // Analyze project structure
    const analysis = await analyzeProjectStructure(ws, profile, allFiles);

    // Generate project map
    const projectMap = generateProjectMap(profile, analysis, allFiles);

    // Ensure .luicode directory exists by trying to write a file there
    try {
      // Try to write a temporary file to ensure we can write to the directory
      ws.writeFile('.luicode/.tmp-understand', '');
      ws.deleteFile('.luicode/.tmp-understand');
    } catch {
      // If we can't write, continue anyway - the writeFile call below will handle errors
    }

    // Save project map
    ws.writeFile(projectMapPath, projectMap);

    // Display results
    tui.result('PROJECT UNDERSTANDING', projectMap.split('\n'));
    tui.toast('Project understanding complete and saved to .luicode/project-map.md');

  } catch (error) {
    tui.toast(`Failed to analyze project: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Helper function to analyze project structure
// _profile parameter is intentionally unused but kept for potential future use
async function analyzeProjectStructure(ws: Workspace, _profile: ProjectProfile, allFiles: string[]): Promise<{
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  importantFiles: string[];
  directories: Record<string, string[]>;
  patterns: string[];
  issues: string[];
}> {
  // Read package.json for dependencies
  let dependencies: Record<string, string> = {};
  let devDependencies: Record<string, string> = {};

  const pkgPath = allFiles.find(f => f.endsWith('package.json'));
  if (pkgPath && ws.absoluteExists(path.join(ws.root, pkgPath))) {
    try {
      const pkgContent = ws.readFile(pkgPath);
      const pkg = JSON.parse(pkgContent);
      dependencies = pkg.dependencies ?? {};
      devDependencies = pkg.devDependencies ?? {};
    } catch {
      // If we can't parse, continue with empty dependencies
    }
  }

  // Identify important files
  const importantFiles: string[] = [];
  const importantFilePatterns = [
    'README.md', 'package.json', 'tsconfig.json', 'jsconfig.json',
    'main.tsx', 'main.ts', 'index.tsx', 'index.ts', 'App.tsx', 'App.ts',
    'server.ts', 'server.js', 'app.ts', 'app.js', 'vite.config.ts',
    'webpack.config.js', 'next.config.js', 'tailwind.config.js',
    '.env.example', '.env', 'docker-compose.yml', 'Dockerfile'
  ];

  for (const file of allFiles) {
    const fileName = path.basename(file);
    if (importantFilePatterns.includes(fileName)) {
      importantFiles.push(file);
    }
  }

  // Group files by directory
  const directories: Record<string, string[]> = {};
  for (const file of allFiles) {
    const dir = path.dirname(file);
    if (dir === '.') continue; // Skip root files for directory grouping

    if (!directories[dir]) {
      directories[dir] = [];
    }
    directories[dir].push(file);
  }

  // Sort directories by file count
  const sortedDirs = Object.entries(directories)
    .sort(([, a], [, b]) => b.length - a.length)
    .reduce((obj, [key, value]) => ({ ...obj, [key]: value }), {});

  // Detect architectural patterns
  const patterns: string[] = [];

  // Check for common patterns
  if (allFiles.some(f => f.includes('/components/') && (f.endsWith('.tsx') || f.endsWith('.jsx')))) {
    patterns.push('Component-based architecture');
  }

  if (allFiles.some(f => f.includes('/services/') && (f.endsWith('.ts') || f.endsWith('.js')))) {
    patterns.push('Service layer');
  }

  if (allFiles.some(f => f.includes('/hooks/') && (f.endsWith('.ts') || f.endsWith('.js')))) {
    patterns.push('Custom hooks');
  }

  if (allFiles.some(f => f.includes('/utils/') || f.includes('/helpers/'))) {
    patterns.push('Utility helpers');
  }

  if (allFiles.some(f => f.includes('/types/') || f.includes('/interfaces/'))) {
    patterns.push('TypeScript interfaces/types');
  }

  if (allFiles.some(f => f.includes('/context/') && (f.endsWith('.tsx') || f.endsWith('.ts')))) {
    patterns.push('React Context');
  }

  if (allFiles.some(f => f.includes('/routes/') || f.includes('/pages/'))) {
    patterns.push('Routing-based structure');
  }

  if (allFiles.some(f => f.includes('/store/') && (f.endsWith('.ts') || f.endsWith('.js')))) {
    patterns.push('State management');
  }

  // Detect potential issues
  const issues: string[] = [];

  // Check for duplicate files (same name in different directories)
  const fileNames: Record<string, string[]> = {};
  for (const file of allFiles) {
    const name = path.basename(file);
    if (!fileNames[name]) {
      fileNames[name] = [];
    }
    fileNames[name].push(file);
  }

  for (const [name, files] of Object.entries(fileNames)) {
    if (files.length > 1) {
      issues.push(`Duplicate file name: ${name} (found in ${files.length} locations)`);
    }
  }

  // Check for large files (simple heuristic)
  for (const file of allFiles) {
    try {
      const content = ws.readFile(file);
      if (content.length > 5000) { // Arbitrary threshold
        issues.push(`Large file detected: ${file} (${content.length} characters)`);
      }
    } catch {
      // Skip files we can't read
    }
  }

  // Check for missing common files
  const recommendedFiles = ['README.md', '.gitignore'];
  for (const recFile of recommendedFiles) {
    if (!allFiles.includes(recFile)) {
      issues.push(`Missing recommended file: ${recFile}`);
    }
  }

  return {
    dependencies,
    devDependencies,
    importantFiles,
    directories: sortedDirs,
    patterns,
    issues
  };
}

type AnalysisResult = {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  importantFiles: string[];
  directories: Record<string, string[]>;
  patterns: string[];
  issues: string[];
};

// Helper function to generate project map markdown
function generateProjectMap(
  profile: ProjectProfile,
  analysis: AnalysisResult,
  allFiles: string[]
): string {
  const { dependencies, devDependencies, importantFiles, directories, patterns, issues } = analysis;

  const lines: string[] = [];

  lines.push('# LUICode Project Understanding');
  lines.push('');
  lines.push(`**Project:** ${profile.name}`);
  lines.push(`**Framework:** ${profile.framework}`);
  lines.push(`**Language:** ${profile.language}`);
  lines.push(`**Package Manager:** ${profile.packageManager}`);
  lines.push('');

  // Entry points
  if (profile.entryFiles.length > 0) {
    lines.push('## Entry Points');
    for (const entry of profile.entryFiles) {
      lines.push(`- ${entry}`);
    }
    lines.push('');
  }

  // Architecture
  lines.push('## Architecture');
  if (patterns.length > 0) {
    for (const pattern of patterns) {
      lines.push(`✓ ${pattern}`);
    }
  } else {
    lines.push('No specific architectural patterns detected');
  }
  lines.push('');

  // Important directories
  lines.push('## Project Structure');
  lines.push('```');

  // Show directory structure
  const sortedDirKeys = Object.keys(directories).sort();
  for (const dir of sortedDirKeys) {
    const dirName = dir === '.' ? '(root)' : dir;
    const fileCount = directories[dir].length;
    lines.push(`${dirName}/ (${fileCount} files)`);

    // Show up to 3 files per directory
    const filesToShow = directories[dir].slice(0, 3);
    for (const file of filesToShow) {
      const fileName = path.basename(file);
      lines.push(`  ├─ ${fileName}`);
    }

    if (directories[dir].length > 3) {
      lines.push(`  └─ ...and ${directories[dir].length - 3} more`);
    }
  }

  // Show root files not in directories
  const rootFiles = allFiles.filter(file => path.dirname(file) === '.' && !importantFiles.includes(file));
  if (rootFiles.length > 0) {
    lines.push('(root)/');
    for (const file of rootFiles.slice(0, 3)) {
      lines.push(`  ├─ ${file}`);
    }
    if (rootFiles.length > 3) {
      lines.push(`  └─ ...and ${rootFiles.length - 3} more`);
    }
  }

  lines.push('```');
  lines.push('');

  // Important files
  if (importantFiles.length > 0) {
    lines.push('## Important Files');
    for (const file of importantFiles.slice(0, 10)) {
      lines.push(`✓ ${file}`);
    }
    if (importantFiles.length > 10) {
      lines.push(`...and ${importantFiles.length - 10} more`);
    }
    lines.push('');
  }

  // Dependencies
  lines.push('## Dependencies');
  const allDeps = { ...dependencies, ...devDependencies };
  if (Object.keys(allDeps).length > 0) {
    for (const [dep, version] of Object.entries(allDeps).slice(0, 10)) {
      const isDev = devDependencies[dep] ? '(dev)' : '';
      lines.push(`✓ ${dep} ${version} ${isDev}`);
    }
    if (Object.keys(allDeps).length > 10) {
      lines.push(`...and ${Object.keys(allDeps).length - 10} more`);
    }
  } else {
    lines.push('No dependencies found');
  }
  lines.push('');

  // Potential issues
  if (issues.length > 0) {
    lines.push('## Potential Issues');
    for (const issue of issues.slice(0, 5)) {
      lines.push(`⚠ ${issue}`);
    }
    if (issues.length > 5) {
      lines.push(`...and ${issues.length - 5} more`);
    }
    lines.push('');
  } else {
    lines.push('## Potential Issues');
    lines.push('No significant issues detected');
    lines.push('');
  }

  // Statistics
  lines.push('## Statistics');
  lines.push(`- Total files: ${allFiles.length}`);
  lines.push(`- Dependencies: ${Object.keys(dependencies).length}`);
  lines.push(`- Dev dependencies: ${Object.keys(devDependencies).length}`);

  // Add timestamp
  lines.push('');
  lines.push(`*Generated on ${new Date().toLocaleString()}*`);

  return lines.join('\n');
}
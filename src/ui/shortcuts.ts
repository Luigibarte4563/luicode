import { KeybindingManager } from './keybindings';
import { slashCommands, UiContext } from './commands';

/**
 * Help window. Rendered by the TUI when /help, Ctrl+H or '?' is used.
 * Content is derived from the keybinding registry and the command registry,
 * so it can never drift from the real behaviour.
 */

export type HelpTopic =
  | 'shortcuts'
  | 'commands'
  | 'modes'
  | 'safety'
  | 'general'
  | 'agent'
  | 'panels';

const TOPIC_LIST: HelpTopic[] = ['shortcuts', 'commands', 'modes', 'safety', 'general', 'agent', 'panels'];

export function normalizeHelpTopic(topic?: string): HelpTopic {
  if (!topic) return 'shortcuts';
  const t = topic.trim().toLowerCase();
  if (t === 'keys' || t === 'keybindings' || t === 'shortcut') return 'shortcuts';
  if (t === 'cmd' || t === 'slash' || t === 'commands') return 'commands';
  if (t === 'mode' || t === 'autonomy') return 'modes';
  if (t === 'security' || t === 'permissions') return 'safety';
  if (t === 'usage' || t === 'start') return 'general';
  if (t === 'panels' || t === 'layout') return 'panels';
  if (t === 'agent' || t === 'agents') return 'agent';
  return 'shortcuts';
}

const CONTEXT_ORDER: UiContext[] = [
  'global',
  'agent',
  'plan',
  'diff',
  'terminal',
  'approval',
  'palette',
  'models',
  'sessions',
  'help',
  'prompt'
];

const CONTEXT_LABELS: Record<UiContext, string> = {
  global: 'GLOBAL (anywhere)',
  agent: 'AGENT RUNNING (space / r / f / s / y / n)',
  plan: 'PLAN PANEL',
  diff: 'DIFF PANEL',
  terminal: 'TERMINAL PANEL',
  approval: 'APPROVAL GATE',
  palette: 'COMMAND PALETTE',
  models: 'MODEL MANAGER',
  sessions: 'SESSION PICKER',
  help: 'HELP',
  prompt: 'PROMPT',
};

export class HelpWindow {
  private topic: HelpTopic = 'shortcuts';
  private scroll = 0;

  constructor(private readonly keys: KeybindingManager) {}

  open(topic?: string): void {
    this.topic = normalizeHelpTopic(topic);
    this.scroll = 0;
  }

  currentTopic(): HelpTopic {
    return this.topic;
  }

  nextTopic(): void {
    const i = TOPIC_LIST.indexOf(this.topic);
    this.topic = TOPIC_LIST[(i + 1) % TOPIC_LIST.length];
    this.scroll = 0;
  }

  previousTopic(): void {
    const i = TOPIC_LIST.indexOf(this.topic);
    this.topic = TOPIC_LIST[(i - 1 + TOPIC_LIST.length) % TOPIC_LIST.length];
    this.scroll = 0;
  }

  /** Returns true if the key was consumed by the help window. */
  handleKey(combo: string): boolean {
    switch (combo) {
      case 'up':
      case 'k':
        this.scroll = Math.max(0, this.scroll - 1);
        return true;
      case 'down':
      case 'j':
        this.scroll += 1;
        return true;
      case 'tab':
      case 'right':
        this.nextTopic();
        return true;
      case 'left':
        this.previousTopic();
        return true;
      default:
        return false;
    }
  }

  body(): string[] {
    switch (this.topic) {
      case 'commands':
        return this.commandsBody();
      case 'modes':
        return this.modesBody();
      case 'safety':
        return this.safetyBody();
      case 'general':
        return this.generalBody();
      case 'agent':
        return this.agentBody();
      case 'panels':
        return this.panelsBody();
      default:
        return this.shortcutsBody();
    }
  }

  render(width: number, height: number): string[] {
    const body = this.body();
    const header = ` LUICODE HELP — ${this.topic.toUpperCase()} `;
    const pad = Math.max(0, width - header.length);
    const title = `${header}${'─'.repeat(pad)}`;
    const max = Math.max(0, body.length - Math.max(0, height - 2));
    this.scroll = Math.min(this.scroll, max);
    const view = body.slice(this.scroll, this.scroll + Math.max(0, height - 2));
    const footer = ` ↑/↓ scroll   ←/→ or Tab topic   Esc close   /help <topic> for shortcuts|commands|modes|safety|general|agent|panels `;
    const lines = [title, ...view];
    while (lines.length < Math.max(0, height - 1)) lines.push(' ');
    lines.push(footer.slice(0, width));
    return lines;
  }

  private shortcutsBody(): string[] {
    const out: string[] = [];
    const contexts = CONTEXT_ORDER.filter((c) => this.keys.forContext(c).length > 0);
    for (const context of contexts) {
      const shorts = this.keys.forContext(context);
      out.push('');
      out.push(`  ${CONTEXT_LABELS[context]}`);
      out.push('');
      const width = Math.max(...shorts.map((s) => s.display.length)) + 2;
      for (const s of shorts) {
        out.push(`    ${s.display.padEnd(width)}  ${s.description}`);
      }
    }
    return out;
  }

  private commandsBody(): string[] {
    const cmds = slashCommands();
    return [
      '',
      '  SLASH COMMANDS',
      '',
      ...cmds.map((c) => {
        const extra = c.shortcut ? `   (${c.shortcut})` : '';
        return `    ${(c.slash ?? '').padEnd(14)}${c.description}${extra}`;
      }),
      '',
      '  Any command can also be launched from the palette (Ctrl+P).'
    ];
  }

  private modesBody(): string[] {
    return [
      '',
      '  AGENT MODES',
      '',
      '    Manual',
      '      Plan requires human approval. Each step is reviewed.',
      '',
      '    Safe',
      '      Safe actions run automatically. Risky actions require',
      '      approval before they execute.',
      '',
      '    Full',
      '      The agent runs autonomously inside the safety boundaries.',
      '      Workspace boundary, protected paths, blocked commands,',
      '      secret redaction and CommandGuard remain enforced.',
      '',
      '  Switch with /mode or Ctrl+O (toggle manual ⇄ safe).'
    ];
  }

  private safetyBody(): string[] {
    return [
      '',
      '  LUICode SAFETY MODEL',
      '',
      '    Workspace boundary   all file and tool access stays inside cwd',
      '    Symlink protection   canonical paths are checked before access',
      '    Protected paths      explicit carve-outs (plan.md, .luicode, …)',
      '    Secret redaction     API keys and secrets are never echoed',
      '    CommandGuard         every command is classified before running',
      '',
      '    SAFE            auto-approved',
      '    MODIFY          requires approval',
      '    MODIFY+NETWORK  requires approval',
      '    BLOCKED         never allowed — no keystroke bypasses this',
      '',
      '  The safety chain is authoritative. The UI is only a front end for it.'
    ];
  }

  private generalBody(): string[] {
    return [
      '',
      '  GETTING STARTED',
      '',
      '    1. Type a prompt and press Ctrl+Enter to submit it.',
      '    2. The agent inspects the project and builds a plan.',
      '    3. Approve the plan in the plan panel (A = approve all).',
      '    4. Press Enter to execute, or use /execute.',
      '    5. Watch the panels; approve safe/accepted commands from the',
      '       approval banner with Y/N when prompted.',
      '',
      '  While the agent runs, use the agent controls (Space, R, S, F).',
      '  Press ? for the shortcut list, Ctrl+P for the command palette.',
      '  Ctrl+H opens this help at any time.'
    ];
  }

  private agentBody(): string[] {
    return [
      '',
      '  AGENT CONTROLS (while running, prompt empty)',
      '',
      '    Space   pause / resume',
      '    R       retry the current failed step',
      '    S       skip the current step',
      '    F       start the automatic fix loop',
      '    Y       approve the current gate',
      '    N       reject / skip the current gate',
      '    Ctrl+C  stop the agent',
      '',
      '  The same actions are available as slash commands',
      '  (/stop, /retry, /fix, /approve, /reject) and in the palette.'
    ];
  }

  private panelsBody(): string[] {
    return [
      '',
      '  PANELS',
      '',
      '    Plan        the approved implementation plan (arrow keys to',
      '                move, Space to toggle a step, A to approve all)',
      '',
      '    Diff        working-tree changes (g = git status, d = diff,',
      '                enter = open file, q/Esc = back)',
      '',
      '    Terminal    recent command output',
      '',
      '  Panel focus: press Ctrl+T to toggle the panel area, or use',
      '  /panel <plan|diff|terminal>. Esc returns focus to the prompt.'
    ];
  }
}

/** Render a reusable single-file result panel. */
export function resultPanel(title: string, body: string[], width: number, height: number, scroll: number): string[] {
  void width;
  const header = ` ${title} `;
  const max = Math.max(0, body.length - Math.max(0, height - 2));
  const s = Math.min(Math.max(0, scroll), max);
  const view = body.slice(s, s + Math.max(0, height - 2));
  const lines = [header, ...view];
  while (lines.length < Math.max(0, height - 1)) lines.push(' ');
  lines.push(`  ↑/↓ scroll   Esc close `);
  return lines;
}
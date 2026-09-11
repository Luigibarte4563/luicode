import * as readline from 'readline';
import { AgentEvent, ApprovalDecision, AskApproval, AutonomyLevel, CommandRisk, DiffEntry, LuicodeConfig, Session } from '../types';
import { CLEAR_SCREEN, CURSOR_HOME, HIDE_CURSOR, RESET, SHOW_CURSOR, paint, wrapAnsi } from './ansi';

export interface TuiOptions {
  projectName: string;
  config: LuicodeConfig;
  mode: AutonomyLevel;
  session?: Session;
  onInput: (text: string) => void;
  onToggleAuto: () => void;
  onResumePath?: string;
  interactive: boolean;
}

interface PendingApproval {
  q: AskApproval;
  resolve: (d: ApprovalDecision) => void;
  cursor: number;
  selected: Set<number>;
  checkbox: boolean;
}

type Panel = 'conversation' | 'plan' | 'diff' | 'activity' | 'terminal';

const ACCENT: [number, number, number] = [0, 190, 255];
const GREEN: [number, number, number] = [80, 220, 130];
const YELLOW: [number, number, number] = [255, 200, 80];
const RED: [number, number, number] = [255, 90, 90];
const DIM: [number, number, number] = [110, 120, 130];
const TEXT: [number, number, number] = [210, 218, 226];

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;

export class TerminalUI {
  private lines: Array<{ text: string; color?: string | [number, number, number]; prefix?: string }> = [];
  private input = '';
  private inputHeader = 'You';
  private pendingApproval: PendingApproval | null = null;
  private panels = new Set<Panel>(['conversation']);
  private activity: string[] = [];
  private busy = false;
  private lastPlan: Array<{ label: string; skipped?: boolean }> = [];
  private commands: Array<{ command: string; risk?: CommandRisk }> = [];
  private statusText = 'Ready';
  private stopped = false;
  private scheduled = false;
  private keyListenerSet = false;
  private mode: AutonomyLevel;
  private fileChanges: string[] = [];
  private diffEntries: DiffEntry[] = [];
  private tokens = { in: 0, out: 0 };
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private opts: TuiOptions) {
    this.mode = opts.mode;
  }

  getApproval = (q: AskApproval): Promise<ApprovalDecision> => {
    if (!this.opts.interactive) return Promise.resolve({ approved: true });
    return new Promise((resolve) => {
      const checkbox = q.kind === 'plan' && q.items.length > 1;
      this.pendingApproval = {
        q,
        resolve,
        cursor: 0,
        selected: new Set(q.items.map((_, i) => i)),
        checkbox
      };
      this.render();
    });
  };

  clear(): void {
    this.lines = [];
    this.activity = [];
    this.lastPlan = [];
    this.commands = [];
    this.fileChanges = [];
    this.diffEntries = [];
    this.tokens = { in: 0, out: 0 };
    if (!this.busy && this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
      this.spinnerFrame = 0;
    }
    this.render();
  }

  setMode(mode: AutonomyLevel): void {
    this.mode = mode;
    this.render();
  }

  handleEvent(e: AgentEvent): void {
    switch (e.type) {
      case 'status':
        this.statusText = e.text ?? 'Working…';
        this.addLine(e.text ?? '', YELLOW, '→');
        break;
      case 'message':
        this.addLine(e.text ?? '', TEXT, 'You');
        break;
      case 'comment':
        if (e.text) this.addLine(e.text, [150, 165, 185], 'ai');
        break;
      case 'tool':
        if (e.tool) {
          const icon = e.tool.status === 'ok' ? '✓' : e.tool.status === 'error' ? '✗' : '●';
          const color = e.tool.status === 'ok' ? GREEN : e.tool.status === 'error' ? RED : YELLOW;
          this.addLine(`${icon} ${e.tool.name} ${shortArgs(e.tool.args)}`, color, ' ');
          if (e.tool.output) this.activity.push(`${e.tool.name}: ${e.tool.output.split('\n')[0].slice(0, 110)}`);
        }
        break;
      case 'plan':
        if (e.plan) {
          this.lastPlan = e.plan.steps.map((s) => {
            const tier = s.risk ? ` [${s.risk}]` : s.stepType ? ` [${s.stepType}]` : '';
            return { label: `${stepIcon(s.status)} ${s.title}${tier}`, skipped: s.status === 'skipped' };
          });
          this.statusText = `Plan / ${this.mode}`;
        }
        break;
      case 'test':
        if (e.test) {
          const color = e.test.passed ? GREEN : RED;
          this.addLine(`Tests: ${e.test.summary}`, color, e.test.passed ? '✓' : '✗');
        }
        break;
      case 'command':
        if (e.command) {
          this.commands.push({ command: e.command.command, risk: e.command.risk });
          this.addLine(`$ ${e.command.command}`, ACCENT, '$');
          const out = e.command.stdout.slice(0, 200).trim();
          if (out) this.activity.push(out);
          if (e.command.risk === 'blocked') {
            this.addLine(`Blocked: ${e.command.stderr.replace(/^BLOCKED:\s*/, '')}`, RED, '!');
          } else if (e.command.risk === 'modify') {
            this.addLine(`Approved modify command: ${e.command.command}`, YELLOW, '!');
          }
        }
        break;
      case 'error':
        this.addLine(`Error: ${e.error?.message ?? e.text ?? 'unknown error'}`, RED, '!');
        break;
      case 'file':
        if (e.file) {
          const icon = e.file.action === 'create' ? '+' : '~';
          this.fileChanges.push(`${icon} ${e.file.path}`);
          this.addLine(`${icon} ${e.file.path}`, e.file.action === 'create' ? GREEN : ACCENT, icon);
        }
        break;
      case 'diff':
        if (e.diff) {
          this.diffEntries.push(e.diff);
          const { path: p, additions: a, deletions: d } = e.diff;
          this.addLine(`Diff  ${p}  ${a > 0 || d > 0 ? `+${a} -${d}` : '(no changes)'}`, a > d ? GREEN : d > a ? RED : ACCENT, '±');
        }
        break;
      case 'usage':
        if (e.usage) {
          this.tokens.in += e.usage.inputTokens ?? 0;
          this.tokens.out += e.usage.outputTokens ?? 0;
        }
        break;
      case 'summary':
        this.addLine('', DIM);
        for (const l of (e.summary ?? '').split('\n')) this.addLine(l, GREEN, '✓');
        this.busy = false;
        this.statusText = 'Done — type a message or Ctrl+C to exit';
        break;
      case 'approval':
        break;
    }
    this.render();
  }

  private addLine(text: string, color: string | [number, number, number], prefix = ''): void {
    this.lines.push({ text, color, prefix });
    if (this.lines.length > 500) this.lines.splice(0, this.lines.length - 500);
  }

  start(): void {
    process.stdout.write(HIDE_CURSOR);
    this.render();
    if (!this.opts.interactive) return;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      readline.emitKeypressEvents(process.stdin);
    }
    if (!this.keyListenerSet) {
      process.stdin.on('keypress', (str, key) => this.onKeyPress(str, key));
      this.keyListenerSet = true;
    }
    process.stdout.on('resize', () => this.render());
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(SHOW_CURSOR);
    try {
      process.stdin.pause();
    } catch {
      /* ignore */
    }
  }

  async shutdown(): Promise<void> {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    this.stop();
  }

  private onKeyPress(str: string | undefined, key: readline.Key): void {
    if (this.pendingApproval) {
      this.handleApprovalKey(key);
      return;
    }
    if (key && key.ctrl && key.name === 'c') {
      if (this.busy) {
        this.busy = false;
        this.addLine('Operation cancelled (Ctrl+C).', RED, '!');
        this.render();
      } else {
        this.stop();
        process.exit(0);
      }
      return;
    }
    if (key && key.ctrl && key.name === 'l') {
      this.clear();
      return;
    }
    if (key && key.ctrl && key.name === 'o') {
      this.opts.onToggleAuto();
      this.addLine(`Autonomy toggled → ${this.mode}`, YELLOW, '!');
      this.render();
      return;
    }
    if (key && key.ctrl && key.name === 'p') {
      this.togglePanel('plan');
      this.render();
      return;
    }
    if (key && key.ctrl && key.name === 'd') {
      this.togglePanel('diff');
      this.render();
      return;
    }
    if (key && key.ctrl && key.name === 't') {
      this.togglePanel('terminal');
      this.render();
      return;
    }
    if (key && key.ctrl && key.name === 'a') {
      this.togglePanel('activity');
      this.render();
      return;
    }
    if ((key && key.name === 'escape') || (key && key.name === 'return' && key.ctrl)) {
      this.stop();
      process.exit(0);
      return;
    }
    if (key && key.name === 'backspace') {
      this.input = this.input.slice(0, -1);
      this.render();
      return;
    }
    if (key && key.name === 'return') {
      const text = this.input.trim();
      if (!text) return;
      const userText = text;
      this.input = '';
      this.addLine(userText, TEXT, this.inputHeader);
      this.busy = true;
      this.statusText = 'LUICode is working…';
      this.render();
      this.opts.onInput(userText);
      return;
    }
    if (str && str.length === 1) {
      this.input += str;
      this.render();
      return;
    }
    this.render();
  }

  private handleApprovalKey(key: readline.Key): void {
    if (!this.pendingApproval) return;
    const p = this.pendingApproval;

    if (p.checkbox) {
      if (key.name === 'up' || key.name === 'k') {
        p.cursor = (p.cursor + p.q.items.length - 1) % p.q.items.length;
        this.render();
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        p.cursor = (p.cursor + 1) % p.q.items.length;
        this.render();
        return;
      }
      if (key.name === 'space' || key.name === 'x') {
        if (p.selected.has(p.cursor)) p.selected.delete(p.cursor);
        else p.selected.add(p.cursor);
        this.render();
        return;
      }
      if (key.name === 'a') {
        p.selected = new Set(p.q.items.map((_, i) => i));
        this.render();
        return;
      }
      if (key.name === 'return' || key.name === 'y' || key.name === 'n' || key.name === 'escape') {
        const steps = [...p.selected].sort((a, b) => a - b).map((i) => p.q.items[i]);
        const ok = (key.name === 'return' || key.name === 'y') && steps.length > 0;
        this.pendingApproval = null;
        this.addLine(
          `[${ok ? 'Approved' : 'Rejected'}${p.q.kind === 'plan' && ok ? ` ${steps.length}/${p.q.items.length} steps` : ''}] ${p.q.title}`,
          ok ? GREEN : RED,
          ok ? '✓' : '✗'
        );
        this.render();
        p.resolve(ok ? { approved: true, steps } : { approved: false });
      }
      return;
    }

    const approve = key.name === 'y' || key.name === 'return';
    const reject = key.name === 'n' || key.name === 'escape';
    if (approve || reject) {
      this.pendingApproval = null;
      this.addLine(`[${approve ? 'Approved' : 'Rejected'}] ${p.q.title}`, approve ? GREEN : RED, approve ? '✓' : '✗');
      this.render();
      p.resolve({ approved: approve });
    }
  }

  private togglePanel(p: Panel): void {
    if (this.panels.has(p)) this.panels.delete(p);
    else this.panels.add(p);
  }

  private render(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    if (this.busy && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        this.spinnerFrame++;
        this.scheduled = false;
        this.render();
      }, SPINNER_INTERVAL_MS);
    } else if (!this.busy && this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
      this.spinnerFrame = 0;
    }
    setImmediate(() => {
      this.scheduled = false;
      if (this.stopped) return;
      this.paint();
    });
  }

  private paint(): void {
    const width = process.stdout.columns || 100;
    const height = process.stdout.rows || 30;
    let frame = CLEAR_SCREEN + CURSOR_HOME + HIDE_CURSOR;
    frame += this.header(width);
    const contentHeight = Math.max(4, height - 5);
    const body = this.body(width, height - 2);
    const bodyLines = body.split('\n');
    frame += bodyLines.slice(0, contentHeight).join('\n');
    if (bodyLines.length > contentHeight) frame += '\n' + paint('… more output (use Ctrl+C)', DIM);
    frame += '\n' + this.inputLine(width);
    process.stdout.write(frame + SHOW_CURSOR);
  }

  private header(width: number): string {
    const mode = this.mode.toUpperCase();
    const modeColor = this.mode === 'full' ? RED : YELLOW;
    const title = paint(' LUICode ', ACCENT, 'bold') + paint('Plan. Build. Test. Ship.', DIM);
    const center = `${paint('Project:', DIM)} ${this.opts.projectName}  ${paint('Mode:', DIM)} ${paint(mode, modeColor, 'bold')}`;
    const w = width - (title.length + center.length);
    return title + (w > 0 ? ' '.repeat(Math.max(1, w)) : ' ') + center + '\n' + paint('─'.repeat(width), DIM) + '\n';
  }

  private body(width: number, available: number): string {
    const lines: string[] = [];
    const push = (s: string): void => {
      for (const l of wrapAnsi(s, width)) lines.push(l);
    };
    if (this.panels.has('plan') && this.lastPlan.length) {
      push(paint('PLAN', ACCENT, 'bold'));
      for (const l of this.lastPlan) push(paint(`  ${l.label}`, l.skipped ? DIM : TEXT));
      push('');
    }
    if (this.panels.has('terminal') && this.commands.length) {
      push(paint('TERMINAL', ACCENT, 'bold'));
      for (const c of this.commands.slice(-8)) {
        const badge =
          c.risk === 'safe'
            ? paint('SAFE', GREEN, 'bold')
            : c.risk === 'modify'
              ? paint('MODIFY', YELLOW, 'bold')
              : c.risk === 'blocked'
                ? paint('BLOCKED', RED, 'bold')
                : paint('RUN', DIM);
        push(`${badge}${paint(` $ ${c.command}`, [120, 220, 160])}`);
      }
      push('');
    }
    if (this.panels.has('activity') && this.activity.length) {
      push(paint('ACTIVITY', ACCENT, 'bold'));
      for (const l of this.activity.slice(-8)) push(paint(`  ${l}`, DIM));
      push('');
    }
    if (this.panels.has('diff') && this.diffEntries.length) {
      for (const d of this.diffEntries.slice(-6)) {
        const net = d.additions - d.deletions;
        const color = net > 0 ? GREEN : net < 0 ? RED : ACCENT;
        const stats = paint(`+${d.additions} -${d.deletions}`, color, 'bold');
        push(paint(`DIFF  ${d.path}  `, ACCENT, 'bold') + stats);
        for (const l of d.lines.slice(-12)) {
          push(paint(`   ${l}`, l.startsWith('++') || l.startsWith('--') ? DIM : l.startsWith('+') ? GREEN : l.startsWith('-') ? RED : TEXT));
        }
        push('');
      }
    }
    if (this.fileChanges.length) {
      push(paint('CHANGES', GREEN, 'bold'));
      for (const f of this.fileChanges.slice(-8)) push(paint(`  ${f}`, TEXT));
      push('');
    }
    if (!this.lines.length) {
      push(paint('Ask LUICode to inspect, plan, and implement a change for this project.', DIM));
      push(paint('Shortcuts: Ctrl+C cancel · Ctrl+P plan · Ctrl+D diff · Ctrl+T terminal · Ctrl+O auto', DIM));
    } else {
      for (const l of this.lines.slice(-Math.max(4, available - 4))) {
        const style = l.prefix === this.inputHeader ? 'bold' : l.prefix === 'ai' ? 'italic' : undefined;
        push(paint(l.prefix === 'ai' ? `  ${l.text}` : l.text, l.color ?? TEXT, style));
      }
    }
    if (this.busy) {
      const spinner = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length];
      push(paint(`  ${spinner} ${this.statusText}`, ACCENT));
      const progress = parseProgress(this.statusText);
      if (progress) {
        const pct = Math.round((progress.current / progress.total) * 100);
        const barW = Math.min(20, Math.max(4, Math.floor(width * 0.15)));
        const filled = Math.round((pct / 100) * barW);
        const bar = paint('░'.repeat(barW), DIM) + paint('█'.repeat(filled), ACCENT);
        push(`  ${bar}  ${progress.current}/${progress.total}  ${pct}%`);
      }
    }
    if (this.pendingApproval) {
      const q = this.pendingApproval.q;
      push('');
      push(paint(`▍${q.title}`, YELLOW, 'bold'));
      push(paint(`  ${q.detail}`, DIM));
      if (this.pendingApproval.checkbox) {
        for (let i = 0; i < q.items.slice(0, 12).length; i++) {
          const item = q.items[i];
          const sel = this.pendingApproval.selected.has(i);
          const cursor = i === this.pendingApproval.cursor;
          push(paint(`${cursor ? '▶' : ' '} ${sel ? '[x]' : '[ ]'} ${item}`, sel ? TEXT : DIM));
        }
        push(paint('  ↑/↓ move · Space toggle · A all · Enter approve · N/Esc reject', DIM));
      } else {
        for (const item of q.items.slice(0, 12)) push(paint(`  · ${item}`, TEXT));
        push(paint('  [Y] Approve   [N] Reject', GREEN, 'bold'));
      }
    }
    if (this.pendingApproval) push('');
    return lines.join('\n');
  }

  private statusBar(width: number): string {
    const models = this.opts.config.models ?? {};
    const shortSpec = (s?: string): string => {
      if (!s) return '—';
      const base = s.includes('/') ? s.split('/').pop() as string : s;
      return base.length > 16 ? base.slice(0, 15) + '…' : base;
    };
    const modeColor = this.mode === 'full' ? RED : this.mode === 'safe' ? YELLOW : GREEN;
    const statusLabel = this.busy
      ? ` ${SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length]} ${this.statusText.slice(0, 22)} `
      : ` ${this.statusText.slice(0, 24)} `;
    const left =
      paint(statusLabel, this.busy ? ACCENT : DIM) +
      paint(`mode:${this.mode}`, modeColor, 'bold') +
      paint(` planner:${shortSpec(models.planner)} coder:${shortSpec(models.coder)} reviewer:${shortSpec(models.reviewer)}`, DIM) +
      paint(` in:${this.tokens.in} out:${this.tokens.out}`, ACCENT);
    const rawLen = left.replace(/\x1b\[[0-9;]*m/g, '').length;
    return left + (rawLen < width ? ' '.repeat(width - rawLen) : '');
  }

  private inputLine(width: number): string {
    const bar = this.statusBar(width);
    let prompt: string;
    if (this.pendingApproval) prompt = paint('LUICode awaiting decision…', YELLOW);
    else prompt = paint(`> ${this.input}`, TEXT);
    return bar + '\n' + paint('─'.repeat(width), DIM) + '\n' + prompt;
  }
}

function stepIcon(status: string): string {
  switch (status) {
    case 'done':
      return '✓';
    case 'running':
      return '●';
    case 'failed':
      return '✗';
    case 'skipped':
      return '×';
    default:
      return '○';
  }
}

function parseProgress(text: string): { current: number; total: number } | null {
  const m = text.match(/fix attempt\s+(\d+)\s*\/\s*(\d+)/i);
  if (m) return { current: parseInt(m[1], 10), total: parseInt(m[2], 10) };
  const m2 = text.match(/attempt\s+(\d+)\s*\/\s*(\d+)/i);
  if (m2) return { current: parseInt(m2[1], 10), total: parseInt(m2[2], 10) };
  return null;
}

function shortArgs(args: string): string {
  try {
    const obj = JSON.parse(args) as Record<string, unknown>;
    const first = Object.entries(obj)[0];
    if (!first) return '';
    const [k, v] = first;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}=${s.length > 60 ? s.slice(0, 57) + '…' : s}`;
  } catch {
    return '';
  }
}

export function printWelcome(opts: { projectName: string; mode: string; model: string; autoBoundary?: boolean }): void {
  process.stdout.write(
    `${paint('╭ ' + 'LUICode', ACCENT, 'bold')} — Plan. Build. Test. Ship.${RESET}\n` +
      `  Project: ${opts.projectName}   Mode: ${opts.mode}   Route: ${opts.model}\n` +
      (opts.autoBoundary === true ? `  Workspace-only autonomy: true\n` : ``) +
      `  Home: ~/.luicode/config.yaml   Project: .luicode/config.yaml\n`
  );
}
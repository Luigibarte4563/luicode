import * as readline from 'readline';
import { AgentEvent, AskApproval, AutonomyLevel, LuicodeConfig, Session } from '../types';
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
  resolve: (ok: boolean) => void;
}

type Panel = 'conversation' | 'plan' | 'diff' | 'activity' | 'terminal';

const ACCENT: [number, number, number] = [0, 190, 255];
const GREEN: [number, number, number] = [80, 220, 130];
const YELLOW: [number, number, number] = [255, 200, 80];
const RED: [number, number, number] = [255, 90, 90];
const DIM: [number, number, number] = [110, 120, 130];
const TEXT: [number, number, number] = [210, 218, 226];

export class TerminalUI {
  private lines: Array<{ text: string; color?: string | [number, number, number]; prefix?: string }> = [];
  private input = '';
  private inputHeader = 'You';
  private pendingApproval: PendingApproval | null = null;
  private panels = new Set<Panel>(['conversation']);
  private activity: string[] = [];
  private busy = false;
  private lastPlan: string[] = [];
  private planApproved: string[] = [];
  private lastDiff: string[] = [];
  private commands: string[] = [];
  private statusText = 'Ready';
  private stopped = false;
  private scheduled = false;
  private keyListenerSet = false;
  private mode: AutonomyLevel;
  private fileChanges: string[] = [];

  constructor(private opts: TuiOptions) {
    this.mode = opts.mode;
  }

  getApproval = (q: AskApproval): Promise<boolean> => {
    if (!this.opts.interactive) return Promise.resolve(true);
    return new Promise((resolve) => {
      this.pendingApproval = { q, resolve };
      this.render();
    });
  };

  clear(): void {
    this.lines = [];
    this.activity = [];
    this.lastPlan = [];
    this.commands = [];
    this.fileChanges = [];
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
          this.lastPlan = e.plan.steps.map((s) => `${s.status === 'done' ? '✓' : s.status === 'running' ? '●' : '○'} ${s.title}`);
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
          this.commands.push(`$ ${e.command.command}`);
          this.addLine(`$ ${e.command.command}`, ACCENT, '$');
          const out = e.command.stdout.slice(0, 200).trim();
          if (out) this.activity.push(out);
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
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(SHOW_CURSOR);
    try {
      process.stdin.pause();
    } catch {
      /* ignore */
    }
  }

  async shutdown(): Promise<void> {
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
    const approve = key.name === 'y' || key.name === 'return';
    const reject = key.name === 'n' || key.name === 'escape';
    if (approve || reject) {
      this.pendingApproval = null;
      this.addLine(`[${approve ? 'Approved' : 'Rejected'}] ${p.q.title}`, approve ? GREEN : RED, approve ? '✓' : '✗');
      this.render();
      p.resolve(approve);
    }
  }

  private togglePanel(p: Panel): void {
    if (this.panels.has(p)) this.panels.delete(p);
    else this.panels.add(p);
  }

  private render(): void {
    if (this.scheduled) return;
    this.scheduled = true;
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
    const contentHeight = Math.max(4, height - 4);
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
      for (const l of this.lastPlan) push(paint(`  ${l}`, TEXT));
      push('');
    }
    if (this.panels.has('terminal') && this.commands.length) {
      push(paint('TERMINAL', ACCENT, 'bold'));
      for (const l of this.commands.slice(-8)) push(paint(`  ${l}`, [120, 220, 160]));
      push('');
    }
    if (this.panels.has('activity') && this.activity.length) {
      push(paint('ACTIVITY', ACCENT, 'bold'));
      for (const l of this.activity.slice(-8)) push(paint(`  ${l}`, DIM));
      push('');
    }
    if (this.panels.has('diff') && this.lastDiff.length) {
      push(paint('DIFF', ACCENT, 'bold'));
      for (const l of this.lastDiff.slice(-20)) push(paint(`  ${l}`, l.startsWith('+') ? GREEN : l.startsWith('-') ? RED : TEXT));
      push('');
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
        push(paint(l.text, l.color ?? TEXT, l.prefix === this.inputHeader ? 'bold' : undefined));
      }
    }
    if (this.pendingApproval) {
      const q = this.pendingApproval.q;
      push('');
      push(paint(`▍${q.title}`, YELLOW, 'bold'));
      push(paint(`  ${q.detail}`, DIM));
      for (const item of q.items.slice(0, 12)) push(paint(`  · ${item}`, TEXT));
      push(paint('  [Y] Approve   [N] Reject', GREEN, 'bold'));
    }
    if (this.pendingApproval) push('');
    return lines.join('\n');
  }

  private inputLine(width: number): string {
    const status = paint(` ${this.statusText.slice(0, 26)} `, DIM);
    let prompt: string;
    if (this.pendingApproval) prompt = paint('LUICode awaiting decision…', YELLOW);
    else prompt = paint(`> ${this.input}`, TEXT);
    const line = `${status} ${prompt}`;
    return paint('─'.repeat(width), DIM) + '\n' + line;
  }
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
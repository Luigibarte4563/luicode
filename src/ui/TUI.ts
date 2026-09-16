import * as readline from 'readline';
import { AgentEvent, ApprovalDecision, AskApproval, AutonomyLevel, CommandRisk, DiffEntry, LuicodeConfig, Session, Plan } from '../types';
import { CLEAR_SCREEN, CURSOR_HOME, HIDE_CURSOR, RESET, SHOW_CURSOR, cursorTo, paint, wrapAnsi } from './ansi';
import { KeybindingManager, normalizeKeypress } from './keybindings';
import { CommandContext, CommandServices, TuiHost, COMMAND_REGISTRY, executeSlash, slashAutocomplete, slashCommands, isCommandAvailable, UiContext, findCommandByName, modelRoutingLines } from './commands';
import { HelpWindow } from './shortcuts';
import { CommandPalette } from './commandPalette';
import { ModelManager, ModelManagerCallbacks } from './modelManager';
import { SessionPicker, SessionListItem, SessionPickerCallbacks } from './sessionPicker';

export interface TuiOptions {
  services: CommandServices;
  projectName: string;
  config: LuicodeConfig;
  mode: AutonomyLevel;
  session?: Session;
  onInput: (text: string) => void;
  onToggleAuto: () => void;
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
type Overlay = 'none' | 'help' | 'palette' | 'models' | 'sessions' | 'result';
type FocusPanel = 'conversation' | 'plan' | 'diff' | 'terminal';
type UiMode = UiContext;

const ACCENT: [number, number, number] = [0, 190, 255];
const GREEN: [number, number, number] = [80, 220, 130];
const YELLOW: [number, number, number] = [255, 200, 80];
const RED: [number, number, number] = [255, 90, 90];
const DIM: [number, number, number] = [110, 120, 130];
const TEXT: [number, number, number] = [210, 218, 226];

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;

export class TerminalUI implements TuiHost {
  // ── state ─────────────────────────────────────────────────────────────────
  private lines: Array<{ text: string; color?: string | [number, number, number]; prefix?: string }> = [];
  private input = '';
  private inputCursor = 0;
  private inputHeader = 'You';
  private pendingApproval: PendingApproval | null = null;
  private panels = new Set<Panel>(['conversation']);
  private activity: string[] = [];
  private busy = false;
  private lastPlan: Array<{ label: string; skipped?: boolean }> = [];
  private planSteps: Plan['steps'] = [];
  private planCursor = 0;
  private planSelection = new Set<number>();
  private terminalCmds: Array<{ command: string; risk?: CommandRisk }> = [];
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

  // ── overlay / panel focus ──────────────────────────────────────────────────
  private focus: FocusPanel = 'conversation';
  private overlay: Overlay = 'none';
  private resultLines: string[] = [];
  private resultTitle = '';
  private resultScroll = 0;
  private toasts: Array<{ text: string; color?: string | [number, number, number]; expires: number }> = [];

  // ── command systems ────────────────────────────────────────────────────────
  private keys = new KeybindingManager();
  private cmdCtx!: CommandContext;
  private helpWindow: HelpWindow;
  private palette: CommandPalette;
  private modelManager: ModelManager;
  private sessionPicker: SessionPicker;

  // ── slash autocomplete ─────────────────────────────────────────────────────
  private slashMode = false;
  private slashSuggestions: ReturnType<typeof slashAutocomplete> = [];
  private slashCursor = -1;

  // ── history ────────────────────────────────────────────────────────────────
  private history: string[] = [];
  private historyCursor = -1;

  // ── services reference ─────────────────────────────────────────────────────
  private services!: CommandServices;

  constructor(private opts: TuiOptions) {
    this.mode = opts.mode;
    this.services = opts.services;
    this.helpWindow = new HelpWindow(this.keys);
    this.palette = new CommandPalette();
    this.modelManager = new ModelManager(
      () => opts.config,
      {
        apply: (role, spec) => {
          const cmd = findCommandByName('model')!;
          this.resolveCommandCtx();
          void cmd.execute(this.cmdCtx, `${role} ${spec}`);
          this.modelManager.refresh();
          this.closeOverlay();
        },
        test: (spec) => {
          const cmd = findCommandByName('model')!;
          this.resolveCommandCtx();
          void cmd.execute(this.cmdCtx, spec);
        },
        setDefault: (provider) => {
          const { setDefaultProvider, saveConfigChanges } = require('../llm/integration');
          const config = opts.config;
          const next = setDefaultProvider(config, provider);
          Object.assign(config, next);
          saveConfigChanges({ provider }, { scope: 'user' });
          this.toast(`Default provider → ${provider}`);
          this.modelManager.refresh();
        }
      }
    );
    this.sessionPicker = new SessionPicker({
      resume: (id) => { this.closeOverlay(); this.opts.services.resumeSession(id); },
      newSession: () => { this.closeOverlay(); this.opts.services.startNewSession(); },
      rename: (id, name) => { this.services.sessions.rename(id, name); this.refreshSessions(); },
      remove: (id) => { this.services.sessions.remove(id); this.refreshSessions(); }
    });
    this.bindAllShortcuts();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TuiHost interface
  // ───────────────────────────────────────────────────────────────────────────

  getMode(): AutonomyLevel { return this.mode; }
  isApprovalPending(): boolean { return this.pendingApproval !== null; }

  /**
   * Ask for an approval decision. Used by the agent pipeline as askApproval;
   * surfaced as an interactive approval banner (checkbox list for plans).
   */
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

  handleEvent(e: AgentEvent): void { this.handleAgentEvent(e); }

  addLine(text: string, color?: string | [number, number, number], prefix?: string): void {
    this.lines.push({ text, color, prefix });
    if (this.lines.length > 500) this.lines.splice(0, this.lines.length - 500);
  }

  result(title: string, body: string[]): void {
    this.resultTitle = title;
    this.resultLines = body;
    this.resultScroll = 0;
    this.overlay = 'result';
    this.render();
  }

  toast(text: string, color?: string | [number, number, number]): void {
    this.toasts.push({ text, color, expires: Date.now() + 3000 });
    this.render();
  }

  openPalette(): void { this.overlay = 'palette'; this.palette.open(this.resolveCommandCtx()); this.render(); }
  openModelManager(): void { this.overlay = 'models'; this.modelManager.open(); this.render(); }
  openSessions(): void { this.refreshSessions(); this.overlay = 'sessions'; this.render(); }
  openHelp(topic?: string): void { this.helpWindow.open(topic); this.overlay = 'help'; this.render(); }

  async confirmYesNo(title: string, detail: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pendingApproval = {
        q: { title, detail, kind: 'command', items: [] },
        resolve: (d) => { resolve(d.approved); },
        cursor: 0,
        selected: new Set(),
        checkbox: false
      };
      this.render();
    });
  }

  resolveApproval(approved: boolean): void {
    if (!this.pendingApproval) return;
    const p = this.pendingApproval;
    this.pendingApproval = null;
    p.resolve({ approved });
    this.render();
  }

  setMode(m: AutonomyLevel): void { this.mode = m; this.opts.mode = m; this.render(); }
  focusPanel(panel: FocusPanel): void { this.focus = panel; if (panel !== 'conversation') this.panels.add(panel); this.render(); }

  quit(): void { this.stop(); process.exit(0); }

  // ── public helpers for commands.ts cast methods ────────────────────────────

  submitPrompt(): void {
    const text = this.input.trim();
    if (!text) return;
    this.input = '';
    this.inputCursor = 0;
    this.history.push(text);
    this.historyCursor = -1;
    this.slashMode = false;
    this.slashSuggestions = [];
    this.busy = true;
    this.statusText = 'LUICode is working…';
    this.addLine(text, TEXT, this.inputHeader);
    this.render();
    this.opts.onInput(text);
  }

  onEsc(): boolean {
    if (this.overlay !== 'none') { this.closeOverlay(); return true; }
    if (this.pendingApproval) { this.resolveApproval(false); return true; }
    if (this.slashMode) { this.slashMode = false; this.slashSuggestions = []; this.render(); return true; }
    return false;
  }

  clearPanel(): void { this.lines = []; this.activity = []; this.lastPlan = []; this.terminalCmds = []; this.fileChanges = []; this.diffEntries = []; this.tokens = { in: 0, out: 0 }; this.render(); }
  togglePanelArea(): void { const p = this.focus === 'conversation' ? 'plan' : this.focus === 'plan' ? 'diff' : this.focus === 'diff' ? 'terminal' : 'conversation'; this.focusPanel(p); }

  movePlan(d: number): void { if (!this.planSteps.length) return; this.planCursor = Math.max(0, Math.min(this.planSteps.length - 1, this.planCursor + d)); this.render(); }
  togglePlanStep(): void {
    if (!this.planSteps.length) return;
    const i = this.planCursor;
    if (this.planSelection.has(i)) this.planSelection.delete(i); else this.planSelection.add(i);
    this.render();
  }
  approveAllSteps(): void { this.planSteps.forEach((_, i) => this.planSelection.add(i)); this.render(); }
  rejectOrSkipPlan(): void { this.planSelection.delete(this.planCursor); this.render(); }
  showCurrentStepDetail(): void {
    const s = this.planSteps[this.planCursor];
    if (!s) return;
    this.result(`STEP — ${s.title}`, [
      s.why ? `Why: ${s.why}` : '',
      s.action ? `Action: ${s.action}` : '',
      '',
      `Risk:  ${s.risk ?? 'safe'}`,
      `Status: ${s.status}`,
      `Type:  ${s.stepType ?? '—'}`
    ]);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Shortcut binding
  // ───────────────────────────────────────────────────────────────────────────

  private resolveCommandCtx(): CommandContext {
    if (!this.cmdCtx) {
      const tuiHost: TuiHost = this;
      this.cmdCtx = {
        services: this.services,
        tui: tuiHost
      };
    }
    return this.cmdCtx;
  }

  private bindAllShortcuts(): void {
    for (const cmd of COMMAND_REGISTRY) {
      if (!cmd.keybindings?.length) continue;
      if (cmd.available && !cmd.available(this.resolveCommandCtx())) continue;
      for (const kb of cmd.keybindings) {
        this.keys.bind({
          id: cmd.id,
          combo: kb.combo,
          context: kb.context,
          description: cmd.description,
          run: () => { void cmd.execute(this.resolveCommandCtx(), ''); }
        });
      }
    }
  }

  private contextForCombo(): UiMode {
    if (this.focus === 'plan') return 'plan';
    if (this.focus === 'diff') return 'diff';
    if (this.focus === 'terminal') return 'terminal';
    return 'prompt';
  }

  private contextForAgentControls(): UiMode {
    return 'agent';
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Key handling
  // ───────────────────────────────────────────────────────────────────────────

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
    if (this.spinnerTimer) { clearInterval(this.spinnerTimer); this.spinnerTimer = null; }
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(SHOW_CURSOR);
    try { process.stdin.pause(); } catch { /* */ }
  }

  async shutdown(): Promise<void> {
    if (this.spinnerTimer) { clearInterval(this.spinnerTimer); this.spinnerTimer = null; }
    this.stop();
  }

  private onKeyPress(str: string | undefined, key: readline.Key): void {
    if (this.stopped) return;

    const combo = normalizeKeypress(str ?? '', key);

    // 1. Overlay handling
    if (this.overlay !== 'none') {
      if (combo === 'escape') { this.closeOverlay(); this.render(); return; }
      if (this.overlay === 'help') { if (this.helpWindow.handleKey(combo)) { this.render(); return; } }
      if (this.overlay === 'palette') { if (this.palette.handleKey(combo)) { this.render(); return; } this.closeOverlay(); this.render(); return; }
      if (this.overlay === 'models') { if (this.modelManager.handleKey(combo)) { this.render(); return; } this.closeOverlay(); this.render(); return; }
      if (this.overlay === 'sessions') { if (this.sessionPicker.handleKey(combo)) { this.render(); return; } this.closeOverlay(); this.render(); return; }
      if (this.overlay === 'result') {
        if (combo === 'up' || combo === 'k') { this.resultScroll = Math.max(0, this.resultScroll - 1); this.render(); return; }
        if (combo === 'down' || combo === 'j') { this.resultScroll++; this.render(); return; }
      }
      return;
    }

    // 2. Approval modal
    if (this.pendingApproval) { this.handleApprovalKey(combo); return; }

    // 3. Global shortcuts (always active)
    const globalHit = this.keys.resolve(combo, 'global');
    if (globalHit) { globalHit.run(); this.render(); return; }

    // 4. Context-specific shortcuts
    const ctxHit = this.keys.resolve(combo, this.contextForCombo());
    if (ctxHit) { ctxHit.run(); this.render(); return; }

    // 5. Agent controls when busy (agent context)
    if (this.busy && !this.input.trim()) {
      const agentHit = this.keys.resolve(combo, this.contextForAgentControls());
      if (agentHit) { agentHit.run(); this.render(); return; }
    }

    // 6. Slash autocomplete navigation when in slash mode
    if (this.slashMode) {
      if (combo === 'up') { if (this.slashSuggestions.length) { this.slashCursor = Math.max(0, this.slashCursor - 1); this.render(); } return; }
      if (combo === 'down') { if (this.slashSuggestions.length) { this.slashCursor = Math.min(this.slashSuggestions.length - 1, this.slashCursor + 1); this.render(); } return; }
      if (combo === 'tab' || combo === 'return') {
        const sel = this.slashSuggestions[this.slashCursor];
        if (sel?.slash) { this.input = sel.slash + ' '; this.inputCursor = this.input.length; this.slashMode = false; this.slashSuggestions = []; }
        if (combo === 'return') { this.slashMode = false; this.slashSuggestions = []; this.submitPrompt(); return; }
        this.render(); return;
      }
      if (combo === 'escape') { this.slashMode = false; this.slashSuggestions = []; this.render(); return; }
    }

    // 7. Input editing
    if (combo === 'return') { this.submitPrompt(); return; }
    if (combo === 'backspace') { if (this.inputCursor > 0) { this.input = this.input.slice(0, this.inputCursor - 1) + this.input.slice(this.inputCursor); this.inputCursor--; } this.updateSlashMode(); this.render(); return; }
    if (combo === 'delete') { if (this.inputCursor < this.input.length) { this.input = this.input.slice(0, this.inputCursor) + this.input.slice(this.inputCursor + 1); } this.render(); return; }
    if (combo === 'left') { this.inputCursor = Math.max(0, this.inputCursor - 1); this.render(); return; }
    if (combo === 'right') { this.inputCursor = Math.min(this.input.length, this.inputCursor + 1); this.render(); return; }
    if (combo === 'home') { this.inputCursor = 0; this.render(); return; }
    if (combo === 'end') { this.inputCursor = this.input.length; this.render(); return; }
    if (combo === 'up') { if (this.history.length && !this.slashMode) { this.historyCursor = Math.min(this.history.length - 1, this.historyCursor + 1); this.input = this.history[this.history.length - 1 - this.historyCursor]; this.inputCursor = this.input.length; this.render(); } return; }
    if (combo === 'down') { if (this.historyCursor > 0) { this.historyCursor--; this.input = this.history[this.history.length - 1 - this.historyCursor]; this.inputCursor = this.input.length; } else { this.historyCursor = -1; this.input = ''; this.inputCursor = 0; } this.render(); return; }
    if (combo === 'ctrl+u') { this.input = ''; this.inputCursor = 0; this.updateSlashMode(); this.render(); return; }

    // 8. Printable character
    if (str && str.length === 1) {
      this.input = this.input.slice(0, this.inputCursor) + str + this.input.slice(this.inputCursor);
      this.inputCursor++;
      this.updateSlashMode();
      this.render();
    }
  }

  private updateSlashMode(): void {
    const slash = this.input.startsWith('/');
    if (slash && !this.slashMode) {
      this.slashMode = true;
      this.slashSuggestions = slashAutocomplete(this.input, 10);
      this.slashCursor = this.slashSuggestions.length > 0 ? 0 : -1;
    } else if (slash) {
      this.slashSuggestions = slashAutocomplete(this.input, 10);
      this.slashCursor = Math.min(this.slashCursor, this.slashSuggestions.length - 1);
      if (this.slashCursor < 0 && this.slashSuggestions.length) this.slashCursor = 0;
    } else {
      this.slashMode = false;
      this.slashSuggestions = [];
    }
  }

  private handleApprovalKey(combo: string): void {
    if (!this.pendingApproval) return;
    const p = this.pendingApproval;
    if (p.checkbox) {
      if (combo === 'up' || combo === 'k') { p.cursor = (p.cursor + p.q.items.length - 1) % p.q.items.length; this.render(); return; }
      if (combo === 'down' || combo === 'j') { p.cursor = (p.cursor + 1) % p.q.items.length; this.render(); return; }
      if (combo === 'space' || combo === 'x') { if (p.selected.has(p.cursor)) p.selected.delete(p.cursor); else p.selected.add(p.cursor); this.render(); return; }
      if (combo === 'a') { p.selected = new Set(p.q.items.map((_, i) => i)); this.render(); return; }
      if (combo === 'return' || combo === 'y' || combo === 'n') {
        const steps = [...p.selected].sort((a, b) => a - b).map((i) => p.q.items[i]);
        const ok = (combo === 'return' || combo === 'y') && steps.length > 0;
        this.pendingApproval = null;
        this.addLine(`[${ok ? 'Approved' : 'Rejected'}] ${p.q.title}`, ok ? GREEN : RED, ok ? '✓' : '✗');
        this.render();
        p.resolve(ok ? { approved: true, steps } : { approved: false });
        return;
      }
      return;
    }
    const approve = combo === 'y' || combo === 'return';
    const reject = combo === 'n' || combo === 'escape';
    if (approve || reject) {
      this.pendingApproval = null;
      this.addLine(`[${approve ? 'Approved' : 'Rejected'}] ${p.q.title}`, approve ? GREEN : RED, approve ? '✓' : '✗');
      this.render();
      p.resolve({ approved: approve });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Agent event handling
  // ───────────────────────────────────────────────────────────────────────────

  private handleAgentEvent(e: AgentEvent): void {
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
          this.planSteps = e.plan.steps;
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
          this.terminalCmds.push({ command: e.command.command, risk: e.command.risk });
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

  // ───────────────────────────────────────────────────────────────────────────
  // Rendering
  // ───────────────────────────────────────────────────────────────────────────

  private render(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    if (this.busy && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => { this.spinnerFrame++; this.scheduled = false; this.render(); }, SPINNER_INTERVAL_MS);
    } else if (!this.busy && this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
      this.spinnerFrame = 0;
    }
    setImmediate(() => { this.scheduled = false; if (!this.stopped) this.paint(); });
  }

  private paint(): void {
    const width = process.stdout.columns || 100;
    const height = process.stdout.rows || 30;
    const frame = CLEAR_SCREEN + CURSOR_HOME + HIDE_CURSOR;

    if (this.overlay !== 'none') {
      const content = this.paintOverlay(width, height);
      if (this.overlay === 'palette') {
        // Command palette has a live text field on its second line ("> /query").
        process.stdout.write(frame + content + cursorTo(3 + this.palette.queryText.length, 1) + SHOW_CURSOR);
      } else {
        process.stdout.write(frame + content + SHOW_CURSOR);
      }
      return;
    }

    // Build output as a line array so we can track cursor position.
    const lines: string[] = [];
    const pushLines = (s: string): void => { for (const l of s.split('\n')) lines.push(l); };

    pushLines(this.paintHeader(width));
    const bodyH = Math.max(4, height - 6);
    pushLines(this.paintBody(width, bodyH));

    // The input cursor sits at the end of the prompt text ("> …") on the
    // first line of the input area.
    const inputParts = this.paintInputLine(width).split('\n');
    const inputRow = lines.length;
    for (const l of inputParts) lines.push(l);
    const inputCol = (inputParts[0] ?? '').replace(/\x1b\[[0-9;]*m/g, '').length;

    pushLines(this.paintStatusBar(width));

    const visible = lines.slice(0, height);
    const cursorRow = Math.min(Math.max(inputRow, 0), height - 1);
    process.stdout.write(frame + visible.join('\n') + cursorTo(inputCol, cursorRow) + SHOW_CURSOR);
  }

  private paintHeader(width: number): string {
    const modeColor = this.mode === 'full' ? RED : YELLOW;
    const title = paint(' LUICode ', ACCENT, 'bold') + paint('Plan. Build. Test. Ship.', DIM);
    const center = `${paint('Project:', DIM)} ${this.opts.projectName}  ${paint('Mode:', DIM)} ${paint(this.mode.toUpperCase(), modeColor, 'bold')}`;
    const w = width - (title.length + center.length);
    const line1 = title + (w > 0 ? ' '.repeat(Math.max(1, w)) : ' ') + center;

    const models = this.opts.config.models ?? {};
    const provider = this.opts.config.provider;
    const coder = models.coder ?? '—';
    const modelInfo = `${paint('  Provider:', DIM)} ${paint(provider, ACCENT)}  ${paint('Coder:', DIM)} ${paint(coder, ACCENT)}`;

    return line1 + '\n' + modelInfo + '\n' + paint('─'.repeat(width), DIM) + '\n';
  }

  private paintBody(width: number, available: number): string {
    const lines: string[] = [];
    const push = (s: string): void => { for (const l of wrapAnsi(s, width)) lines.push(l); };
    if (this.focus === 'plan' && this.lastPlan.length) {
      push(paint('PLAN', ACCENT, 'bold'));
      for (const [i, l] of this.lastPlan.entries()) {
        const marker = i === this.planCursor ? '▶' : this.planSelection.has(i) ? '☑' : '☐';
        push(paint(`  ${marker} ${l.label}`, l.skipped ? DIM : i === this.planCursor ? ACCENT : this.planSelection.has(i) ? GREEN : TEXT));
      }
      push('');
    }
    if (this.focus === 'terminal' && this.terminalCmds.length) {
      push(paint('TERMINAL', ACCENT, 'bold'));
      for (const c of this.terminalCmds.slice(-8)) {
        const badge = c.risk === 'safe' ? paint('SAFE', GREEN, 'bold') : c.risk === 'modify' ? paint('MODIFY', YELLOW, 'bold') : c.risk === 'blocked' ? paint('BLOCKED', RED, 'bold') : paint('RUN', DIM);
        push(`${badge}${paint(` $ ${c.command}`, [120, 220, 160])}`);
      }
      push('');
    }
    if (this.focus === 'conversation' && this.activity.length) {
      push(paint('ACTIVITY', ACCENT, 'bold'));
      for (const l of this.activity.slice(-8)) push(paint(`  ${l}`, DIM));
      push('');
    }
    if (this.focus === 'diff' && this.diffEntries.length) {
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
    if (!this.lines.length && this.focus === 'conversation') {
      const models = this.opts.config.models ?? {};
      const provider = this.opts.config.provider;
      const coder = models.coder ?? '—';
      push(paint(`  Model: ${provider} / ${coder}`, ACCENT));
      push('');
      push(paint('Ask LUICode to inspect, plan, and implement a change for this project.', DIM));
      push(paint('Ctrl+P palette · Ctrl+H help · Ctrl+O auto · Ctrl+M models · Ctrl+R sessions', DIM));
      push(paint('Agent controls (busy): Space pause · R retry · S skip · F fix · Y approve · N reject', DIM));
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
        push(paint('  ↑/↓ move · Space toggle · A all · Enter approve · N reject', DIM));
      } else {
        for (const item of q.items.slice(0, 12)) push(paint(`  · ${item}`, TEXT));
        push(paint('  [Y] Approve   [N] Reject', GREEN, 'bold'));
      }
    }
    while (lines.length < available) lines.push('');
    return lines.slice(0, available).join('\n');
  }

  private paintInputLine(width: number): string {
    const prompt = this.pendingApproval ? '' : `> ${this.input}`;
    const slashHelp = this.slashMode && this.slashSuggestions.length > 0
      ? '\n' + this.slashSuggestions.map((s, i) =>
          paint(`  ${i === this.slashCursor ? '▶' : ' '} ${s.slash}  ${s.description}`, i === this.slashCursor ? ACCENT : DIM)
        ).join('\n')
      : '';
    return paint(prompt, TEXT) + slashHelp;
  }

  private paintStatusBar(width: number): string {
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
    const focusTag = this.focus !== 'conversation' ? ` [${this.focus}]` : '';
    const left =
      paint(statusLabel, this.busy ? ACCENT : DIM) +
      paint(`mode:${this.mode}${focusTag}`, modeColor, 'bold') +
      paint(` planner:${shortSpec(models.planner)} coder:${shortSpec(models.coder)} reviewer:${shortSpec(models.reviewer)}`, DIM) +
      paint(` in:${this.tokens.in} out:${this.tokens.out}`, ACCENT);
    const rawLen = left.replace(/\x1b\[[0-9;]*m/g, '').length;
    const toastLine = this.paintToasts();
    const bar = left + (rawLen < width ? ' '.repeat(width - rawLen) : '');
    return (toastLine ? toastLine + '\n' : '') + paint('─'.repeat(width), DIM) + '\n' + bar;
  }

  private paintToasts(): string {
    const now = Date.now();
    this.toasts = this.toasts.filter((t) => t.expires > now);
    if (!this.toasts.length) return '';
    return this.toasts.map((t) => paint(`  ${t.text}`, t.color ?? TEXT)).join('\n');
  }

  private paintOverlay(width: number, height: number): string {
    if (this.overlay === 'help') {
      const lines = this.helpWindow.render(width, height);
      return lines.join('\n');
    }
    if (this.overlay === 'palette') {
      const lines = this.palette.render(width, height);
      return lines.join('\n');
    }
    if (this.overlay === 'models') {
      const lines = this.modelManager.render(width, height);
      return lines.join('\n');
    }
    if (this.overlay === 'sessions') {
      const lines = this.sessionPicker.render(width, height);
      return lines.join('\n');
    }
    if (this.overlay === 'result') {
      const body = this.resultLines;
      const header = ` ${this.resultTitle} `;
      const pad = Math.max(0, width - header.length);
      const title = `${header}${'─'.repeat(pad)}`;
      const max = Math.max(0, body.length - Math.max(0, height - 2));
      this.resultScroll = Math.min(this.resultScroll, max);
      const view = body.slice(this.resultScroll, this.resultScroll + Math.max(0, height - 2));
      const lines = [title, ...view];
      while (lines.length < Math.max(0, height - 1)) lines.push(' ');
      lines.push(`  ↑/↓ scroll   Esc close `);
      return lines.join('\n');
    }
    return '';
  }

  private closeOverlay(): void {
    this.overlay = 'none';
  }

  private refreshSessions(): void {
    const items: SessionListItem[] = this.services.sessions.list();
    this.sessionPicker.open(items);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function stepIcon(status: string): string {
  switch (status) {
    case 'done': return '✓';
    case 'running': return '●';
    case 'failed': return '✗';
    case 'skipped': return '×';
    default: return '○';
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
      `  Project: ${opts.projectName}   Mode: ${opts.mode}\n` +
      `  Model:   ${paint(opts.model, ACCENT, 'bold')}\n` +
      (opts.autoBoundary === true ? `  Workspace-only autonomy: true\n` : ``) +
      `  Home: ~/.luicode/config.yaml   Project: .luicode/config.yaml\n`
  );
}
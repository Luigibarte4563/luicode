import { LuicodeConfig, TaskKind } from '../types';
import { TASK_KINDS, listProviderIntegrations, ProviderIntegration, routingSummary } from '../llm/integration';

/**
 * Interactive model manager (Ctrl+M or /models).
 *
 * Left pane = task roles, right pane = available providers. Tab switches
 * focus, Enter applies the highlighted provider's default model to the
 * highlighted role, T tests a provider in place, D sets the default
 * provider. The bottom query line accepts a raw <provider>/<model> spec.
 */

export interface ModelManagerCallbacks {
  apply: (role: TaskKind, spec: string) => void;
  test: (spec: string) => void;
  setDefault: (provider: string) => void;
}

type ModelPane = 'tasks' | 'providers' | 'query';

export class ModelManager {
  private focused: ModelPane = 'tasks';
  private taskCursor = 0;
  private providerCursor = 0;
  private query = '';
  private providers: ProviderIntegration[] = [];

  constructor(
    private readonly getConfig: () => LuicodeConfig,
    private readonly callbacks: ModelManagerCallbacks
  ) {}

  open(): void {
    this.focused = 'tasks';
    this.taskCursor = 0;
    this.providerCursor = 0;
    this.query = '';
    this.refresh();
  }

  refresh(): void {
    this.providers = listProviderIntegrations(this.getConfig());
  }

  /** Returns true if the key was consumed by the manager. */
  handleKey(combo: string): boolean {
    if (combo === 'tab' || combo === 'right' || combo === 'left') {
      this.focused = this.focused === 'tasks' ? 'providers' : this.focused === 'providers' ? 'query' : 'tasks';
      return true;
    }
    // While typing a raw spec, only Enter/backspace/navigation are special;
    // every printable key goes into the query buffer.
    if (this.focused === 'query') {
      if (combo === 'return') {
        this.applySelection();
        return true;
      }
      if (combo === 'backspace') {
        this.query = this.query.slice(0, -1);
        return true;
      }
      if (combo === 'up' || combo === 'down') {
        return true;
      }
      if (combo.length === 1 && this.query.length < 80) {
        this.query += combo;
        return true;
      }
      return true;
    }
    switch (combo) {
      case 'up':
      case 'k':
        this.move(-1);
        return true;
      case 'down':
      case 'j':
        this.move(1);
        return true;
      case 'return':
      case 'u':
        this.applySelection();
        return true;
      case 't':
      case 'y':
        this.testSelection();
        return true;
      case 'd':
        this.defaultSelection();
        return true;
      default:
        return false;
    }
  }

  private move(dir: 1 | -1): void {
    if (this.focused === 'tasks') {
      this.taskCursor = (this.taskCursor + dir + TASK_KINDS.length) % TASK_KINDS.length;
    } else if (this.focused === 'providers') {
      if (!this.providers.length) return;
      this.providerCursor = (this.providerCursor + dir + this.providers.length) % this.providers.length;
    }
  }

  private role(): TaskKind {
    return TASK_KINDS[this.taskCursor] ?? 'coder';
  }

  private provider(): ProviderIntegration | null {
    return this.providers[this.providerCursor] ?? null;
  }

  private specFor(p: ProviderIntegration): string {
    return `${p.name}/${p.defaultModel}`;
  }

  private applySelection(): void {
    const role = this.role();
    if (this.focused === 'query' && this.query.trim()) {
      this.callbacks.apply(role, this.query.trim());
      return;
    }
    const p = this.provider();
    if (p && this.focused !== 'query') this.callbacks.apply(role, this.specFor(p));
  }

  private testSelection(): void {
    const p = this.provider();
    if (p && this.focused !== 'query') this.callbacks.test(this.specFor(p));
    else if (this.query.trim()) this.callbacks.test(this.query.trim());
  }

  private defaultSelection(): void {
    const p = this.provider();
    if (p) this.callbacks.setDefault(p.name);
  }

  render(width: number, height: number): string[] {
    const routing = routingSummary(this.getConfig());
    const leftCol = Math.max(16, Math.floor(width * 0.34));
    const rightCol = Math.max(10, width - leftCol - 1);
    const header = ` MODEL MANAGER — roles left, providers right (Tab to switch, T test, D default) `;
    const bodyHeight = Math.max(1, height - 4);
    const out: string[] = [];

    const taskLine = (i: number): string => {
      const t = TASK_KINDS[i];
      const cur = routing[t] ?? '—';
      const arrow = this.focused === 'tasks' && i === this.taskCursor ? '▶' : ' ';
      return `${arrow} ${t.padEnd(9)} ${cur}`;
    };

    for (let i = 0; i < bodyHeight; i++) {
      let left = '';
      if (i === 0) left = ' ROLES';
      else if (i <= TASK_KINDS.length) {
        left = ` ${taskLine(i - 1)}`;
        left = left.slice(0, leftCol);
      } else left = '';

      let right = '';
      if (i === 0) {
        const sel = this.focused === 'providers';
        right = ` ${sel ? '▼' : ' '} PROVIDERS`;
      } else {
        const p = this.providers[i - 1];
        if (!p) right = '';
        else {
          const sel = this.focused === 'providers' && i - 1 === this.providerCursor;
          const status = p.apiKeySet ? 'key ✓' : p.apiKeyEnv ? `key: ${p.apiKeyEnv}` : 'no key';
          const badge = p.local ? 'local' : p.freeTier ? 'free' : '';
          right = ` ${sel ? '▶' : ' '} ${p.name}/${p.defaultModel}  ${badge} ${status}`;
          right = right.slice(0, rightCol);
        }
      }
      out.push(`${left.padEnd(leftCol)}│${right}`);
    }

    const queryLine = ` spec: ${this.query}${this.focused === 'query' ? '▏' : ' '}`;
    out.push('─'.repeat(width));
    out.push(`${queryLine.slice(0, width)}`);
    out.push(` ←/→ Tab: switch pane    ↑/↓: move    Enter/U: apply   T: test   D: default   Esc: close `);
    while (out.length < height) out.push('');
    return out.slice(0, height);
  }
}
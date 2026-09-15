/**
 * Session picker (Ctrl+R or /resume). Lists previous sessions, supports
 * filtering, rename and delete. The TUI owns the actual SessionManager
 * mutation via the provided callbacks.
 */

export interface SessionListItem {
  file: string;
  id: string;
  updatedAt: number;
  task: string;
  status: string;
}

export interface SessionPickerCallbacks {
  resume: (id: string) => void;
  newSession: () => void;
  rename: (id: string, task: string) => void;
  remove: (id: string) => void;
}

type PickerMode = 'browse' | 'search' | 'rename';

export class SessionPicker {
  private items: SessionListItem[] = [];
  private filter = '';
  private cursor = 0;
  private mode: PickerMode = 'browse';
  private editBuf = '';

  constructor(private readonly callbacks: SessionPickerCallbacks) {}

  open(items: SessionListItem[]): void {
    this.items = items;
    this.filter = '';
    this.cursor = 0;
    this.mode = 'browse';
    this.editBuf = '';
  }

  private visible(): SessionListItem[] {
    if (!this.filter) return this.items;
    const q = this.filter.toLowerCase();
    return this.items.filter((i) => i.task.toLowerCase().includes(q) || i.status.toLowerCase().includes(q));
  }

  private clamp(): void {
    const n = this.visible().length;
    if (n === 0) this.cursor = 0;
    else if (this.cursor >= n) this.cursor = n - 1;
  }

  /** Returns true if the key was consumed. */
  handleKey(combo: string): boolean {
    if (this.mode !== 'browse') {
      if (combo === 'escape') {
        this.mode = 'browse';
        return true;
      }
      if (combo === 'backspace') {
        this.editBuf = this.editBuf.slice(0, -1);
        return true;
      }
      if (combo === 'return') {
        this.commit();
        return true;
      }
      if (combo.length === 1) {
        this.editBuf += combo;
        return true;
      }
      // navigation still allowed
      if (combo === 'up' || combo === 'k') {
        this.cursor = Math.max(0, this.cursor - 1);
        return true;
      }
      if (combo === 'down' || combo === 'j') {
        this.cursor += 1;
        this.clamp();
        return true;
      }
      return true;
    }

    switch (combo) {
      case 'up':
      case 'k':
        this.cursor = Math.max(0, this.cursor - 1);
        return true;
      case 'down':
      case 'j':
        this.cursor += 1;
        this.clamp();
        return true;
      case 'return':
      case 'ctrl+l':
        this.resumeSelected();
        return true;
      case 'n':
        this.callbacks.newSession();
        return true;
      case 's':
        this.mode = 'search';
        this.editBuf = this.filter;
        return true;
      case 'r':
        this.beginRename();
        return true;
      case 'd':
        this.removeSelected();
        return true;
      default:
        return false;
    }
  }

  private beginRename(): void {
    const item = this.visible()[this.cursor];
    if (!item) return;
    this.mode = 'rename';
    this.editBuf = item.task;
  }

  private commit(): void {
    if (this.mode === 'search') {
      this.filter = this.editBuf;
      this.mode = 'browse';
      this.cursor = 0;
      this.clamp();
    } else if (this.mode === 'rename') {
      const item = this.visible()[this.cursor];
      const name = this.editBuf.trim();
      if (item && name) this.callbacks.rename(item.id, name);
      this.mode = 'browse';
      this.editBuf = '';
    }
  }

  private resumeSelected(): void {
    const item = this.visible()[this.cursor];
    if (item) this.callbacks.resume(item.id);
  }

  private removeSelected(): void {
    const item = this.visible()[this.cursor];
    if (!item) return;
    this.callbacks.remove(item.id);
  }

  render(width: number, height: number): string[] {
    const items = this.visible();
    this.clamp();
    const header = ` SESSION PICKER — ${items.length} ${items.length === 1 ? 'session' : 'sessions'}`;
    const modeTag =
      this.mode === 'search' ? `[search: ${this.editBuf}]` : this.mode === 'rename' ? `[rename: ${this.editBuf}]` : '';
    const bodyHeight = Math.max(1, height - 3);
    const scroll = Math.max(0, this.cursor - bodyHeight + 1);
    const view = items.slice(scroll, scroll + bodyHeight);
    const out: string[] = [];
    const idWidth = Math.min(24, Math.floor(width * 0.3));
    for (let i = 0; i < bodyHeight; i++) {
      const item = view[i];
      if (!item) {
        out.push('');
        continue;
      }
      const selected = scroll + i === this.cursor;
      const arrow = selected ? '▶' : ' ';
      const task = item.task;
      const id = item.id.slice(0, idWidth);
      const when = new Date(item.updatedAt).toLocaleString();
      const taskCell = task.slice(0, Math.max(0, width - idWidth - 30));
      out.push(` ${arrow} ${id.padEnd(idWidth)} ${taskCell.padEnd(Math.max(0, width - idWidth - 12))} ${when.slice(0, 12)} ${item.status}`);
    }
    out.push('─'.repeat(width));
    out.push(` ${modeTag}  ↑/↓ move   Enter resume   N new   S search   R rename   D delete   Esc close`);
    while (out.length < height) out.push('');
    return out.slice(0, height);
  }
}
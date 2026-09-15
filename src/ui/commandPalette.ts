import { CommandContext, paletteEntries, PaletteEntry } from './commands';

/**
 * Command palette (Ctrl+P). Lists every actionable command and slash
 * command from the shared registry, filters live as the user types,
 * and executes the selection through the same implementation every
 * other surface (keyboard, slash command) uses.
 */

function fuzzyMatch(query: string, candidate: string): boolean {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (!q) return true;
  if (c.startsWith(q)) return true;
  if (c.includes(q)) return true;
  let i = 0;
  for (const ch of c) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return false;
}

export class CommandPalette {
  private ctx: CommandContext | null = null;
  private base: PaletteEntry[] = [];
  private filtered: PaletteEntry[] = [];
  private query = '';
  private cursor = 0;
  private scroll = 0;

  get isOpen(): boolean {
    return this.ctx !== null;
  }

  open(ctx: CommandContext): void {
    this.ctx = ctx;
    this.query = '';
    this.cursor = 0;
    this.scroll = 0;
    this.base = paletteEntries().filter((e) => !e.command.available || e.command.available(ctx));
    this.refilter();
  }

  close(): void {
    this.ctx = null;
  }

  private refilter(): void {
    const q = this.query.trim().replace(/^\//, '');
    this.filtered = this.base.filter((e) => fuzzyMatch(q, `${e.left} ${e.right} ${e.command.description}`));
    if (this.cursor > this.filtered.length - 1) this.cursor = Math.max(0, this.filtered.length - 1);
    if (this.filtered.length === 0) this.cursor = 0;
  }

  private move(dir: 1 | -1): void {
    if (!this.filtered.length) return;
    this.cursor = (this.cursor + dir + this.filtered.length) % this.filtered.length;
  }

  /** Returns true when the palette consumed the key. */
  handleKey(combo: string): boolean {
    switch (combo) {
      case 'up':
      case 'ctrl+p':
        this.move(-1);
        return true;
      case 'down':
      case 'ctrl+n':
        this.move(1);
        return true;
      case 'tab':
        if (this.filtered.length) this.cursor = 0;
        return true;
      default:
        if (combo.length === 1 || combo === ' ') {
          this.query += combo;
          this.cursor = 0;
          this.refilter();
          return true;
        }
        return false;
    }
  }

  handleChar(ch: string, isPrintable: boolean): boolean {
    if (!isPrintable) return false;
    this.query += ch;
    this.cursor = 0;
    this.refilter();
    return true;
  }

  backspace(): void {
    this.query = this.query.slice(0, -1);
    this.refilter();
  }

  clearQuery(): void {
    this.query = '';
    this.refilter();
  }

  /** Execute the highlighted entry. Returns true if a command ran. */
  runSelection(): boolean {
    const ctx = this.ctx;
    const entry = this.filtered[this.cursor];
    if (!ctx || !entry) return false;
    void entry.command.execute(ctx, '');
    return true;
  }

  render(width: number, height: number): string[] {
    const header = ` COMMAND PALETTE — ${this.filtered.length} ${this.filtered.length === 1 ? 'item' : 'items'}`;
    const padded = height - 2;
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor >= this.scroll + padded) this.scroll = this.cursor - padded + 1;
    const view = this.filtered.slice(this.scroll, this.scroll + padded);
    const inputLeft = this.query.length + 1;
    const rows: string[] = [];
    for (let i = 0; i < padded; i++) {
      const entry = view[i];
      if (!entry) {
        rows.push('');
        continue;
      }
      const selected = this.scroll + i === this.cursor;
      const left = (selected ? '▶ ' : '  ') + entry.left;
      const right = entry.right.padStart(Math.max(0, width - left.length - 2));
      rows.push(left + (right ? ` ${right}` : ''));
    }
    const prompt = `> /${this.query}`;
    const input = prompt.slice(0, width);
    const footer = ` ↑/↓ move   Enter run   Esc close   / + text filters slash commands `;
    const lines = [
      header,
      input,
      ...rows.slice(0, Math.max(0, height - 3)),
      footer.slice(0, width)
    ];
    void inputLeft;
    while (lines.length < height) lines.push('');
    return lines;
  }
}
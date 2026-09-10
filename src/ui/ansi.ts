export type Rgb = [number, number, number];

export function clampRgb(c: number): number {
  return Math.max(0, Math.min(255, Math.round(c)));
}

export function hexToRgb(hex: string): Rgb {
  const m = hex.replace('#', '');
  return [
    clampRgb(parseInt(m.slice(0, 2), 16)),
    clampRgb(parseInt(m.slice(2, 4), 16)),
    clampRgb(parseInt(m.slice(4, 6), 16))
  ];
}

export function rgb(c: Rgb, bg = false): string {
  return `\x1b[${bg ? 48 : 38};2;${c[0]};${c[1]};${c[2]}m`;
}

export function fg(c: Rgb): string {
  return rgb(c, false);
}

export function bg(c: Rgb): string {
  return rgb(c, true);
}

export const RESET = '\x1b[0m';

export function paint(s: string, color: string | Rgb, style?: 'bold' | 'dim' | 'italic' | 'underline'): string {
  const col = Array.isArray(color)
    ? `\x1b[38;2;${color[0]};${color[1]};${color[2]}m`
    : `\x1b[${code(color)}m`;
  const styleCode =
    style === 'bold' ? '\x1b[1m' : style === 'dim' ? '\x1b[2m' : style === 'italic' ? '\x1b[3m' : style === 'underline' ? '\x1b[4m' : '';
  return `${styleCode}${col}${s}${RESET}`;
}

function code(color: string): number {
  const map: Record<string, number> = {
    black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
    blackBright: 90, redBright: 91, greenBright: 92, yellowBright: 93, blueBright: 94,
    magentaBright: 95, cyanBright: 96, whiteBright: 97, gray: 90
  };
  return map[color] ?? 37;
}

export const CURSOR_HOME = '\x1b[H';
export const CLEAR_SCREEN = '\x1b[2J';
export const CLEAR_LINE = '\x1b[2K';
export const HIDE_CURSOR = '\x1b[?25l';
export const SHOW_CURSOR = '\x1b[?25h';

export function cursorTo(x: number, y: number): string {
  return `\x1b[${y + 1};${x + 1}H`;
}

export function wrapAnsi(text: string, width: number): string[] {
  if (width <= 1) return [text];
  const withoutAnsi = text.replace(/\x1b\[[0-9;]*m/g, '');
  if (withoutAnsi.length <= width) return [text];
  const lines: string[] = [];
  const segments = text.split(/(\n)/);
  let buf = '';
  let bufLen = 0;
  for (const seg of segments) {
    if (seg === '\n') {
      lines.push(buf);
      buf = '';
      bufLen = 0;
      continue;
    }
    for (const ch of seg) {
      if (ch === '\x1b') {
        const m = seg.slice(seg.indexOf(ch)).match(/^[\x1b][[0-9;]*m/);
        if (m) buf += m[0];
        continue;
      }
      buf += ch;
      bufLen++;
      if (bufLen >= width) {
        lines.push(buf);
        buf = '';
        bufLen = 0;
      }
    }
  }
  if (buf || !lines.length) lines.push(buf);
  return lines;
}

export function padRight(s: string, width: number): string {
  const len = s.replace(/\x1b\[[0-9;]*m/g, '').length;
  return len >= width ? s : s + ' '.repeat(width - len);
}
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_IGNORES = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
  'target',
  'vendor',
  '.luicode',
  '.lui'
];

function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    // The path doesn't exist yet (e.g. about to be created): canonicalize the
    // deepest existing ancestor and re-append the remaining segments.
    const segments: string[] = [];
    let cur = abs;
    for (let i = 0; i < 64; i++) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      segments.unshift(path.basename(cur));
      cur = parent;
      try {
        const realAncestor = fs.realpathSync(cur);
        return path.join(realAncestor, ...segments);
      } catch {
        continue;
      }
    }
    return abs;
  }
}

export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(canonicalPath(root), canonicalPath(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export class Workspace {
  readonly root: string;
  private ignores: string[];

  constructor(root: string, ignores?: string[]) {
    this.root = path.resolve(root);
    this.ignores = [...DEFAULT_IGNORES, ...(ignores ?? [])];
  }

  resolve(rel: string): string {
    const abs = path.resolve(this.root, rel);
    if (!isWithin(this.root, abs)) {
      throw new Error(`LUICODE_BOUNDARY: path "${rel}" is outside the workspace`);
    }
    return abs;
  }

  resolveSafe(rel: string): string | null {
    const abs = path.resolve(this.root, rel);
    return isWithin(this.root, abs) ? abs : null;
  }

  readFileSafe(rel: string): string {
    try {
      return this.readFile(rel);
    } catch {
      return '';
    }
  }

  absoluteExists(abs: string): boolean {
    if (!isWithin(this.root, abs)) return false;
    return fs.existsSync(abs);
  }

  readFile(rel: string): string {
    const abs = this.resolve(rel);
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${rel}`);
    return fs.readFileSync(abs, 'utf8');
  }

  writeFile(rel: string, content: string): void {
    const abs = this.resolve(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }

  deleteFile(rel: string): void {
    const abs = this.resolve(rel);
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${rel}`);
    fs.unlinkSync(abs);
  }

  renameFile(from: string, to: string): void {
    const absFrom = this.resolve(from);
    const absTo = this.resolve(to);
    if (!fs.existsSync(absFrom)) throw new Error(`File not found: ${from}`);
    fs.mkdirSync(path.dirname(absTo), { recursive: true });
    fs.renameSync(absFrom, absTo);
  }

  moveFile(from: string, to: string): void {
    this.renameFile(from, to);
  }

  protectPaths(): string[] {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const protected_: string[] = [];
    if (home) {
      for (const p of ['.ssh', '.aws', '.azure', '.config', '.gnupg', '.netrc']) {
        protected_.push(path.join(home, p));
      }
    }
    return protected_;
  }

  isProtected(abs: string): boolean {
    const canon = canonicalPath(abs);
    return this.protectPaths().some((p) => {
      const cp = canonicalPath(p);
      return canon === cp || canon.startsWith(cp + path.sep);
    });
  }

  tree(rel = '', depth = 4): string {
    const abs = this.resolve(rel);
    return this.walk(abs, depth);
  }

  private walk(dir: string, depth: number, prefix = ''): string {
    if (depth < 0) return prefix + '...\n';
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return prefix + '<unreadable>\n';
    }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    const lines: string[] = [];
    for (const e of entries) {
      if (this.ignores.includes(e.name)) continue;
      const full = path.join(dir, e.name);
      const isDir = e.isDirectory();
      lines.push(`${prefix}${isDir ? '📁 ' : '📄 '}${e.name}`);
      if (isDir) {
        lines.push(this.walk(full, depth - 1, prefix + '   '));
      }
    }
    return lines.join('\n');
  }

  listDirectory(rel = ''): string[] {
    const abs = this.resolve(rel);
    if (!fs.existsSync(abs)) return [];
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    return entries
      .filter((e) => !this.ignores.includes(e.name))
      .map((e) => (e.isDirectory() ? e.name + '/' : e.name));
  }

  walkFiles(rel = '', maxDepth = 8): string[] {
    const out: string[] = [];
    const visit = (dir: string, depth: number): void => {
      if (depth > maxDepth) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (this.ignores.includes(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) visit(full, depth + 1);
        else out.push(path.relative(this.root, full).split(path.sep).join('/'));
      }
    };
    visit(this.root, 0);
    return out;
  }

  searchFiles(pattern: string): string[] {
    const rx = new RegExp(pattern.split('*').join('.*'));
    return this.walkFiles().filter((f) => rx.test(path.basename(f)));
  }

  searchCode(query: string, maxResults = 50): Array<{ file: string; line: number; text: string }> {
    const q = query.toLowerCase();
    const out: Array<{ file: string; line: number; text: string }> = [];
    const codeExt = /\.(ts|tsx|js|jsx|py|go|rs|java|rb|c|cpp|h|cs|php|vue|svelte|sql|sh|yml|yaml|json|html|css|scss|toml)$/i;
    for (const f of this.walkFiles()) {
      if (!codeExt.test(f)) continue;
      const abs = path.join(this.root, f);
      try {
        const lines = fs.readFileSync(abs, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(q)) {
            out.push({ file: f, line: i + 1, text: lines[i].trim().slice(0, 140) });
            if (out.length >= maxResults) return out;
          }
        }
      } catch {
        continue;
      }
    }
    return out;
  }
}
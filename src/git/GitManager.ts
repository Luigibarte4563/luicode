import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

async function run(workspaceRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: workspaceRoot,
      maxBuffer: 4 * 1024 * 1024
    });
    return stdout;
  } catch {
    return '';
  }
}

export interface GitFileSummary {
  modified: string[];
  added: string[];
  deleted: string[];
  additions: number;
  deletions: number;
}

export class GitManager {
  constructor(private root: string) {}

  async isRepo(): Promise<boolean> {
    return (await run(this.root, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  }

  async status(): Promise<string> {
    return run(this.root, ['status', '--short']);
  }

  async diff(): Promise<string> {
    const tracked = await run(this.root, ['diff', '--stat']);
    const untracked = await run(this.root, ['ls-files', '--others', '--exclude-standard']);
    const sections: string[] = [];
    if (tracked.trim()) sections.push(tracked);
    if (untracked.trim()) {
      sections.push(`Untracked files:\n${untracked}`);
    }
    return sections.join('\n');
  }

  async log(count = 10): Promise<string> {
    const out = await run(this.root, ['log', `--oneline`, `-${count}`]);
    return out;
  }

  async branch(): Promise<string> {
    const out = await run(this.root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return out ? `* ${out}` : '* (detached)';
  }

  private async numstat(): Promise<Array<{ path: string; add: number; del: number }>> {
    const out = await run(this.root, ['diff', '--numstat']);
    const rows: Array<{ path: string; add: number; del: number }> = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
      if (m) rows.push({ path: m[3], add: m[1] === '-' ? 0 : Number(m[1]), del: m[2] === '-' ? 0 : Number(m[2]) });
    }
    return rows;
  }

  async summary(): Promise<GitFileSummary> {
    const statusOut = await run(this.root, ['status', '--porcelain']);
    const modified: string[] = [];
    const added: string[] = [];
    const deleted: string[] = [];
    for (const line of statusOut.split('\n')) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2).trim();
      const p = line.slice(3);
      if (code === '??') added.push(p);
      else if (code.startsWith('D')) deleted.push(p);
      else if (code.startsWith('A')) added.push(p);
      else modified.push(p);
    }
    let additions = 0;
    let deletions = 0;
    for (const r of await this.numstat()) {
      additions += r.add;
      deletions += r.del;
    }
    return { modified, added, deleted, additions, deletions };
  }
}
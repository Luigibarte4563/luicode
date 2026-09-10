import { DiffAction, DiffResult } from '../types';

export class DiffEngine {
  compute(oldText: string, newText: string): DiffResult {
    const a = oldText.length ? oldText.split('\n') : [];
    const b = newText.length ? newText.split('\n') : [];
    const N = a.length;
    const M = b.length;
    const MAX = N + M;
    const offset = MAX;
    const v: number[] = new Array(2 * MAX + 1).fill(-1);
    const trace: number[][] = [];
    v[offset + 1] = 0;

    for (let d = 0; d <= MAX; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x: number;
        if (k === -d || (k !== d && (v[offset + k - 1] ?? -1) < (v[offset + k + 1] ?? -1))) {
          x = v[offset + k + 1] ?? 0;
        } else {
          x = (v[offset + k - 1] ?? 0) + 1;
        }
        let y = x - k;
        while (x < N && y < M && a[x] === b[y]) {
          x++;
          y++;
        }
        v[offset + k] = x;
        if (x >= N && y >= M) {
          return this.backtrack(trace, a, b, N, M, offset);
        }
      }
    }
    return this.backtrack(trace, a, b, N, M, offset);
  }

  private backtrack(
    trace: number[][],
    a: string[],
    b: string[],
    N: number,
    M: number,
    offset: number
  ): DiffResult {
    const actions: DiffAction[] = [];
    let x = N;
    let y = M;
    for (let d = trace.length - 1; d >= 0; d--) {
      const vv = trace[d];
      const k = x - y;
      let prevK: number;
      if (k === -d || (k !== d && (vv[offset + k - 1] ?? -1) < (vv[offset + k + 1] ?? -1))) {
        prevK = k + 1;
      } else {
        prevK = k - 1;
      }
      const prevX = vv[offset + prevK] ?? 0;
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) {
        const t = x - 1 >= 0 && x - 1 < a.length && y - 1 >= 0 && y - 1 < b.length ? a[x - 1] : '';
        actions.push({ type: 'equal', text: t });
        x--;
        y--;
      }
      if (d > 0) {
        if (x === prevX) {
          const t = y - 1 >= 0 && y - 1 < b.length ? b[y - 1] : '';
          actions.push({ type: 'add', text: t });
          y--;
        } else {
          const t = x - 1 >= 0 && x - 1 < a.length ? a[x - 1] : '';
          actions.push({ type: 'remove', text: t });
          x--;
        }
      }
    }
    actions.reverse();
    return this.summarize(actions);
  }

  private summarize(actions: DiffAction[]): DiffResult {
    const addedLines: string[] = [];
    const removedLines: string[] = [];
    let additions = 0;
    let deletions = 0;
    for (const a of actions) {
      if (a.type === 'add') {
        addedLines.push(a.text);
        additions++;
      } else if (a.type === 'remove') {
        removedLines.push(a.text);
        deletions++;
      }
    }
    return { actions, addedLines, removedLines, additions, deletions };
  }

  toUnified(title: string, result: DiffResult): string {
    const out: string[] = [];
    out.push(`--- a/${title}`);
    out.push(`+++ b/${title}`);
    const changed = result.actions.filter((a) => a.type !== 'equal').length;
    if (changed === 0) {
      out.push('  (no changes)');
      return out.join('\n');
    }
    out.push(`@@ ${result.deletions} deletions ${result.additions} additions @@`);
    for (const a of result.actions) {
      if (a.type === 'equal') out.push(` ${a.text}`);
      else if (a.type === 'add') out.push(`+${a.text}`);
      else out.push(`-${a.text}`);
    }
    return out.join('\n');
  }
}

export const diffEngine = new DiffEngine();
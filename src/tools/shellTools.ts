import { spawn } from 'child_process';
import { CommandRecord } from '../types';
import { CommandGuard } from '../security/commandGuard';
import { Tool } from './registry';

export class ShellRunner {
  constructor(
    private cwd: string,
    private guard: CommandGuard,
    private defaults: { timeoutMs: number; maxOutputBytes: number }
  ) {}

  async run(
    command: string,
    opts: { timeoutMs?: number; maxOutputBytes?: number } = {}
  ): Promise<CommandRecord> {
    const timeoutMs = opts.timeoutMs ?? this.defaults.timeoutMs;
    const maxBytes = opts.maxOutputBytes ?? this.defaults.maxOutputBytes;
    const started = Date.now();
    const isWin = process.platform === 'win32';
    const shell = isWin ? process.env.ComSpec ?? 'cmd.exe' : process.env.SHELL ?? '/bin/sh';
    const args = isWin ? ['/d', '/s', '/c', command] : ['-c', command];
    const child = spawn(shell, args, { cwd: this.cwd, windowsHide: true, env: process.env });

    let stdout = '';
    let stderr = '';
    let code: number | null = null;
    let done = false;

    const capture = (chunk: Buffer, target: 'out' | 'err'): void => {
      const s = chunk.toString('utf8');
      const cap = target === 'out' ? stdout : stderr;
      if (Buffer.byteLength(cap + s, 'utf8') > maxBytes) {
        const append = Buffer.from(s, 'utf8').subarray(0, Math.max(0, maxBytes - Buffer.byteLength(cap, 'utf8'))).toString('utf8');
        if (target === 'out') stdout = cap + append + '\n… (output truncated)';
        else stderr = cap + append;
        return;
      }
      if (target === 'out') stdout = cap + s;
      else stderr = cap + s;
    };

    child.stdout?.on('data', (c: Buffer) => capture(c, 'out'));
    child.stderr?.on('data', (c: Buffer) => capture(c, 'err'));

    return new Promise<CommandRecord>((resolve) => {
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve({
          command,
          stdout,
          stderr: stderr + (stderr && !stderr.endsWith('\n') ? '\n' : '') + '… (command timed out)',
          code: null,
          durationMs: Date.now() - started
        });
      }, timeoutMs);

      child.on('error', (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ command, stdout, stderr: String(err.message), code: 1, durationMs: Date.now() - started });
      });
      child.on('close', (c) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ command, stdout, stderr, code: c, durationMs: Date.now() - started });
      });
    });
  }
}

export const shellTools: Tool[] = [
  {
    name: 'run_command',
    description: 'Run a shell command inside the workspace. Args: { command }',
    async run(args, rt) {
      const command = String(args.command ?? '');
      if (!command.trim()) return 'ERROR: empty command';
      const verdict = rt.guard.classify(command);
      if (verdict.risk === 'blocked') {
        return `BLOCKED: ${verdict.reason}`;
      }
      if (verdict.risk === 'modify' && rt.permission.getMode() === 'manual') {
        return 'NEEDS_APPROVAL: command modifies project state; user must approve it in the UI.';
      }
      const runner = new ShellRunner(rt.ws.root, new CommandGuard({ whitelist: rt.config.terminal.whitelist }), {
        timeoutMs: rt.config.terminal.commandTimeoutMs,
        maxOutputBytes: rt.config.terminal.maxOutputBytes
      });
      const rec = await runner.run(command);
      const out = (rec.stdout + (rec.stderr ? '\n[stderr]\n' + rec.stderr : '')).trim();
      const header = `EXIT_CODE: ${rec.code === null ? 'killed' : rec.code} (${rec.durationMs}ms)`;
      return `${header}\n${out || '(no output)'}`;
    }
  }
];
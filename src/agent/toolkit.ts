import { AgentEvent, CommandRecord, LuicodeConfig, ToolCall } from '../types';
import { Workspace } from '../workspace/Workspace';
import { PermissionManager, PermissionResult } from '../security/permission';
import { CommandGuard } from '../security/commandGuard';
import { Tool, ToolRuntime } from '../tools/registry';
import { fileTools } from '../tools/fileTools';
import { shellTools } from '../tools/shellTools';
import { gitTools } from '../tools/gitTools';
import { astTools } from '../tools/astTools';
import { GitManager } from '../git/GitManager';
import { redactSecrets } from '../security/scan';

export interface ToolkitOptions {
  ws: Workspace;
  config: LuicodeConfig;
  mode: 'manual' | 'safe' | 'full';
  emit: (e: AgentEvent) => void;
  askCommandApproval: (command: string) => Promise<boolean>;
}

export class Toolkit implements ToolRuntime {
  ws: Workspace;
  config: LuicodeConfig;
  permission: PermissionManager;
  guard: CommandGuard;
  tools: Map<string, Tool> = new Map();
  git: GitManager;
  readonly opts: ToolkitOptions;

  constructor(opts: ToolkitOptions) {
    this.opts = opts;
    this.ws = opts.ws;
    this.config = opts.config;
    this.permission = new PermissionManager(opts.ws, opts.mode);
    this.guard = new CommandGuard({ whitelist: opts.config.terminal.whitelist, workspaceRoot: opts.ws.root });
    this.git = new GitManager(opts.ws.root);
    if (opts.config.git.enabled) {
      for (const t of gitTools(this.git)) this.tools.set(t.name, t);
    }
    for (const t of [...fileTools, ...shellTools, ...astTools]) this.tools.set(t.name, t);
  }

  setMode(mode: 'manual' | 'safe' | 'full'): void {
    this.permission.setMode(mode);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  async runShell(command: string, timeouts?: { timeoutMs?: number; maxOutputBytes?: number }): Promise<CommandRecord> {
    return this.runCommandTool(command, timeouts);
  }

  async runCommandTool(command: string, timeouts?: { timeoutMs?: number; maxOutputBytes?: number }): Promise<CommandRecord> {
    const verdict = this.guard.classify(command);
    if (verdict.risk === 'blocked') {
      const rec: CommandRecord = { command, stdout: '', stderr: `BLOCKED: ${verdict.reason}`, code: 1, durationMs: 0 };
      this.opts.emit({ type: 'command', timestamp: Date.now(), command: rec });
      return rec;
    }
    if (verdict.risk === 'modify') {
      const approved = await this.opts.askCommandApproval(command);
      if (!approved) {
        const rec: CommandRecord = { command, stdout: '', stderr: 'Command rejected by user (needs approval).', code: null, durationMs: 0 };
        this.opts.emit({ type: 'command', timestamp: Date.now(), command: rec });
        return rec;
      }
    }
    const { ShellRunner } = await import('../tools/shellTools');
    const runner = new ShellRunner(this.ws.root, this.guard, {
      timeoutMs: timeouts?.timeoutMs ?? this.config.terminal.commandTimeoutMs,
      maxOutputBytes: timeouts?.maxOutputBytes ?? this.config.terminal.maxOutputBytes
    });
    const rec = await runner.run(command);
    this.opts.emit({ type: 'command', timestamp: Date.now(), command: rec });
    return rec;
  }

  async runTool(name: string, args: Record<string, unknown>): Promise<ToolCall> {
    const tool = this.tools.get(name);
    const call: ToolCall = {
      id: `${Date.now().toString(36)}`,
      name,
      args: JSON.stringify(args),
      status: 'running',
      startedAt: Date.now()
    };
    this.opts.emit({ type: 'tool', timestamp: Date.now(), tool: call });
    if (!tool) {
      call.status = 'error';
      call.error = `Unknown tool: ${name}`;
      call.endedAt = Date.now();
      this.opts.emit({ type: 'tool', timestamp: Date.now(), tool: call });
      return call;
    }
    try {
      const output = await tool.run(args, this);
      call.status = 'ok';
      call.output = redactSecrets(output.slice(0, 4000));
      call.endedAt = Date.now();
      if (call.output.startsWith('DENIED:') || call.output.startsWith('BLOCKED:')) call.status = 'error';
      if (call.output.startsWith('NEEDS_APPROVAL')) {
        const approved = await this.opts.askCommandApproval(String(args.command ?? ''));
        if (approved) {
          const viaShell = await this.runCommandTool(String(args.command ?? ''));
          call.output = `EXIT_CODE: ${viaShell.code} (${viaShell.durationMs}ms)\n${(viaShell.stdout + '\n' + viaShell.stderr).trim().slice(0, 4000)}`;
          call.status = 'ok';
        } else {
          call.status = 'error';
          call.error = 'Command rejected by user';
        }
      }
    } catch (err) {
      call.status = 'error';
      call.error = err instanceof Error ? err.message : String(err);
      call.endedAt = Date.now();
    }
    this.opts.emit({ type: 'tool', timestamp: Date.now(), tool: call });
    return call;
  }

  checkPermission(rel: string): PermissionResult {
    return this.permission.canWrite(rel);
  }
}
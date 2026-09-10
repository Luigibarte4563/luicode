import { CommandRecord, LuicodeConfig } from '../types';
import { Workspace } from '../workspace/Workspace';
import { PermissionManager } from '../security/permission';
import { CommandGuard } from '../security/commandGuard';

export interface ToolRuntime {
  ws: Workspace;
  permission: PermissionManager;
  config: LuicodeConfig;
  guard: CommandGuard;
  runShell(command: string, opts?: { timeoutMs: number; maxOutputBytes: number }): Promise<CommandRecord>;
}

export interface Tool {
  name: string;
  description: string;
  run(args: Record<string, unknown>, rt: ToolRuntime): Promise<string>;
}

export function makeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)}`)
    .join(' ');
}
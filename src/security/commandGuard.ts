import * as path from 'path';
import { CommandRisk } from '../types';

export type { CommandRisk };

export interface CommandRiskResult {
  risk: CommandRisk;
  reason: string;
  matched?: string;
}

export const DANGEROUS_PREFIXES: Array<[string, string]> = [
  ['rm -rf /', 'attempts to delete the entire filesystem'],
  ['rm -rf ~', 'attempts to delete the home directory'],
  ['sudo rm', 'destructive OS-level delete'],
  ['mkfs', 'formats a disk'],
  ['format c:', 'formats the OS drive'],
  ['dd if=', 'raw disk write'],
  ['chmod -R 777', 'disables filesystem permissions'],
  ['shutdown', 'shuts down the machine'],
  ['reboot', 'reboots the machine'],
  [':(){ :|:& };:', 'fork bomb'],
  ['> /dev/sda', 'writes directly to a block device'],
  ['diskpart', 'manages raw disks'],
  ['reg delete HKLM', 'modifies OS registry'],
  ['del /f /s /q', 'force-deletes recursively (Windows)'],
  ['rmdir /s', 'removes directory tree (Windows)']
];

export const GUI_MODIFIERS = [
  '--force',
  '-f',
  '--push',
  'push'
];

export interface GuardOptions {
  whitelist: string[];
  blockForceDeleteOutsideWorkspace?: boolean;
  workspaceRoot?: string;
}

export class CommandGuard {
  constructor(private opts: GuardOptions = { whitelist: [] }) {}

  classify(command: string): CommandRiskResult {
    const trimmed = command.trim();
    if (!trimmed) return { risk: 'blocked', reason: 'Empty command' };

    const whitelisted = this.opts.whitelist.some((w) => {
      const wTrim = w.trim().toLowerCase();
      return wTrim.length > 0 && trimmed.toLowerCase().startsWith(wTrim);
    });
    if (whitelisted) return { risk: 'safe', reason: 'Whitelisted command (e.g. tests/build).' };

    for (const [prefix, reason] of DANGEROUS_PREFIXES) {
      if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
        return { risk: 'blocked', reason: `Dangerous command blocked: ${reason}.`, matched: prefix };
      }
    }

    const lower = trimmed.toLowerCase();
    if (/\brm\s+-r/.test(lower) || /\brm\b/.test(lower) || /\bdel\b/.test(lower)) {
      return {
        risk: 'blocked',
        reason: 'Delete command requires explicit approval and is blocked in autonomous mode.',
        matched: trimmed.match(/\brm\b/)?.[0]
      };
    }

    const hardModify = [
      ['sudo', 'requires root privileges'],
      ['git push', 'pushes to remote repository (blocked by default)'],
      ['git reset --hard', 'destructive history rewrite'],
      ['git clean', 'removes untracked files'],
      ['git checkout .', 'discards local changes'],
      ['npm uninstall', 'removes dependencies'],
      ['npm prune', 'removes dependencies'],
      ['yarn remove', 'removes dependencies']
    ] as Array<[string, string]>;
    for (const [prefix, reason] of hardModify) {
      if (lower.startsWith(prefix)) {
        return { risk: 'modify', reason: `Command modifies state: ${reason}`, matched: prefix };
      }
    }

    const softModifyPrefixes = ['npm install', 'npm i ', 'npm run', 'npx', 'pnpm', 'yarn add', 'yarn install', 'npm ci', 'git commit', 'git add', 'git stash', 'git restore'];
    if (softModifyPrefixes.some((p) => lower.startsWith(p))) {
      return { risk: 'modify', reason: 'Command modifies project state (deps/build/watch).', matched: trimmed.split(/\s+/)[0] };
    }

    if (lower.startsWith('cd ') || lower.startsWith('git status') || lower.startsWith('git diff') || lower.startsWith('git log') || lower.startsWith('git branch')) {
      return { risk: 'safe', reason: 'Read-only command.' };
    }

    void GUI_MODIFIERS;
    void path;
    if (/^([a-z]:\\)?[\w.\\/-]+$/i.test(trimmed) && !trimmed.includes(' ')) {
      return { risk: 'safe', reason: 'Simple program execution.' };
    }
    return { risk: 'modify', reason: 'Unrecognized command; treated as modify (requires approval).' };
  }
}
import { AutonomyLevel } from '../types';
import { isWithin, Workspace } from '../workspace/Workspace';

export interface PermissionResult {
  allowed: boolean;
  reason: string;
  requiresApproval: boolean;
}

export const PROTECTED_WORDS = [
  'ssh',
  'aws',
  'azure',
  'gcloud',
  'gnupg',
  '.netrc',
  'passwd',
  'shadow',
  'credentials',
  'keychain',
  'wallet',
  'password'
];

export class PermissionManager {
  constructor(
    private ws: Workspace,
    private mode: AutonomyLevel
  ) {}

  setMode(mode: AutonomyLevel): void {
    this.mode = mode;
  }

  getMode(): AutonomyLevel {
    return this.mode;
  }

  canWriteAbsolute(abs: string): PermissionResult {
    if (this.ws.isProtected(abs)) {
      return { allowed: false, reason: 'Path is on the protected list (credentials/system config).', requiresApproval: false };
    }
    if (!isWithin(this.ws.root, abs)) {
      return { allowed: false, reason: `Path outside workspace: ${abs}`, requiresApproval: false };
    }
    return { allowed: true, reason: 'ok', requiresApproval: false };
  }

  canWrite(rel: string): PermissionResult {
    if (rel.startsWith('.')) {
      return { allowed: true, reason: 'dotfile in workspace', requiresApproval: this.mode !== 'full' };
    }
    const abs = this.ws.resolve(rel);
    if (this.ws.isProtected(abs)) {
      return { allowed: false, reason: 'Path is on the protected list (credentials/system config).', requiresApproval: false };
    }
    return { allowed: true, reason: 'Workspace write permitted.', requiresApproval: this.mode === 'manual' };
  }

  canDelete(rel: string): PermissionResult {
    if (this.mode === 'full') {
      return { allowed: true, reason: 'Full autonomy: delete permitted within workspace.', requiresApproval: false };
    }
    return { allowed: true, reason: 'Delete permitted after approval.', requiresApproval: true };
  }
}
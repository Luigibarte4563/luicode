/**
 * RunControl — a shared, real control channel between the UI layer and a
 * running agent pipeline.
 *
 * The TUI (keyboard shortcuts / slash commands) and the agent pipeline
 * (Toolkit, PlanExecutor, Agent) share a single instance. The UI never
 * bypasses the safety layer: pause/resume genuinely block between tool calls,
 * stop marks the run as cancelled at the next safe checkpoint, and
 * skip/retry/fix only affect the *current* step so the CommandGuard and
 * PermissionManager stay authoritative.
 */
export class RunControl {
  private controller = new AbortController();
  private _paused = false;
  private waiters: Array<() => void> = [];
  private _skipRequested = false;
  private _retryRequested = false;
  private _fixRequested = false;
  private _approveNext = false;
  private _rejectNext = false;

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get paused(): boolean {
    return this._paused;
  }

  get skipRequested(): boolean {
    return this._skipRequested;
  }

  get retryRequested(): boolean {
    return this._retryRequested;
  }

  get fixRequested(): boolean {
    return this._fixRequested;
  }

  get approveNext(): boolean {
    return this._approveNext;
  }

  get rejectNext(): boolean {
    return this._rejectNext;
  }

  /** Stop/cancel the current operation at the next safe checkpoint. */
  abort(): void {
    this.controller.abort();
    this._paused = false;
    while (this.waiters.length) this.waiters.shift()?.();
  }

  pause(): void {
    this._paused = true;
  }

  resume(): void {
    this._paused = false;
    while (this.waiters.length) this.waiters.shift()?.();
  }

  /** One-shot skip of the current step. */
  requestSkip(): void {
    this._skipRequested = true;
  }

  takeSkip(): boolean {
    const v = this._skipRequested;
    this._skipRequested = false;
    return v;
  }

  /** One-shot retry of the current/last step. */
  requestRetry(): void {
    this._retryRequested = true;
  }

  takeRetry(): boolean {
    const v = this._retryRequested;
    this._retryRequested = false;
    return v;
  }

  /** Ask the agent to enter the fix loop after the current phase. */
  requestFix(): void {
    this._fixRequested = true;
  }

  takeFix(): boolean {
    const v = this._fixRequested;
    this._fixRequested = false;
    return v;
  }

  /** Auto-approve the next approval gate (respected at the gate, not bypassed). */
  requestApproveNext(): void {
    this._approveNext = true;
  }

  takeApproveNext(): boolean {
    const v = this._approveNext;
    this._approveNext = false;
    return v;
  }

  /** Auto-reject the next approval gate. */
  requestRejectNext(): void {
    this._rejectNext = true;
  }

  takeRejectNext(): boolean {
    const v = this._rejectNext;
    this._rejectNext = false;
    return v;
  }

  /**
   * Blocks while paused; returns immediately when running or aborted.
   * The pipeline calls this at each safe checkpoint (before a step, before a
   * tool call, between actions) so pause/resume are real, not cosmetic.
   */
  async waitIfPaused(): Promise<void> {
    if (this.controller.signal.aborted || !this._paused) return;
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * Safe checkpoint: waits out pause and throws when the run was cancelled.
   * Throws an error whose message prefix is CANCELLED for easy detection.
   */
  async sync(): Promise<void> {
    await this.waitIfPaused();
    if (this.controller.signal.aborted) {
      throw new Error('CANCELLED: agent operation was stopped by the user.');
    }
  }
}

export function isCancelled(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('CANCELLED:');
}
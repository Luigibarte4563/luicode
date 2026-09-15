import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RunControl, isCancelled } from '../src/agent/runControl';
import { KeybindingManager, normalizeKeypress, canonicalCombo, displayCombo } from '../src/ui/keybindings';
import {
  parseSlash,
  findCommandByName,
  slashAutocomplete,
  executeSlash,
  paletteEntries,
  slashCommands,
  classifyRiskKind,
  COMMAND_REGISTRY,
  type CommandContext,
  type TuiHost
} from '../src/ui/commands';
import { SessionManager } from '../src/sessions/SessionManager';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'luicode-ui-test-'));
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// RunControl — pause/resume/abort/skip/retry semantics
// ---------------------------------------------------------------------------

describe('RunControl', () => {
  it('sync() returns immediately when not paused or aborted', async () => {
    const c = new RunControl();
    await expect(c.sync()).resolves.toBeUndefined();
  });

  it('sync() blocks while paused and resumes after resume()', async () => {
    const c = new RunControl();
    c.pause();
    let resumed = false;
    const p = c.sync().then(() => {
      resumed = true;
    });
    await delay(20);
    expect(resumed).toBe(false);
    c.resume();
    await p;
    expect(resumed).toBe(true);
  });

  it('abort() cancels the run by throwing a CANCELLED error', async () => {
    const c = new RunControl();
    c.abort();
    await expect(c.sync()).rejects.toMatchObject({ message: expect.stringContaining('CANCELLED') });
    expect(isCancelled(new Error('CANCELLED: stopped'))).toBe(true);
    expect(isCancelled(new Error('other'))).toBe(false);
  });

  it('abort() interrupts an in-flight pause wait', async () => {
    const c = new RunControl();
    c.pause();
    const p = c.sync().catch(() => 'cancelled');
    await delay(10);
    c.abort();
    expect(await p).toBe('cancelled');
  });

  it('skip/retry/fix/approveNext/rejectNext are one-shot', async () => {
    const c = new RunControl();
    c.requestSkip();
    expect(c.skipRequested).toBe(true);
    expect(c.takeSkip()).toBe(true);
    expect(c.takeSkip()).toBe(false);

    c.requestRetry();
    expect(c.takeRetry()).toBe(true);
    expect(c.retryRequested).toBe(false);

    c.requestFix();
    expect(c.takeFix()).toBe(true);
    expect(c.fixRequested).toBe(false);

    c.requestApproveNext();
    expect(c.takeApproveNext()).toBe(true);
    expect(c.approveNext).toBe(false);

    c.requestRejectNext();
    expect(c.takeRejectNext()).toBe(true);
    expect(c.rejectNext).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// KeybindingManager — normalization, precedence, conflicts
// ---------------------------------------------------------------------------

describe('KeybindingManager', () => {
  it('normalizeKeypress maps ctrl+p / space / arrows to canonical combos', () => {
    expect(normalizeKeypress('p', { name: 'p', ctrl: true })).toBe('ctrl+p');
    expect(normalizeKeypress('', { name: 'space' })).toBe('space');
    expect(normalizeKeypress('', { name: 'up' })).toBe('up');
    expect(normalizeKeypress('', { name: 'return' })).toBe('return');
    expect(normalizeKeypress('Y', { name: 'y', shift: true })).toBe('y');
    expect(normalizeKeypress('', { name: 'f5' })).toBe('f5');
    expect(canonicalCombo('  Ctrl +  P ')).toBe('ctrl+p');
    expect(displayCombo('ctrl+return')).toBe('Ctrl+Enter');
    expect(displayCombo('space')).toBe('Space');
  });

  it('resolves exact-context binding first, then global fallback', () => {
    const m = new KeybindingManager();
    m.bind({ id: 'g', combo: 'r', context: 'global', description: 'global r', run: () => {} });
    m.bind({ id: 'p', combo: 'r', context: 'plan', description: 'plan r', run: () => {} });

    const inPlan = m.resolve('r', 'plan');
    expect(inPlan?.id).toBe('p');
    const inPrompt = m.resolve('r', 'prompt');
    expect(inPrompt?.id).toBe('g');
  });

  it('reports conflicts when the same combo is registered twice in one context', () => {
    const m = new KeybindingManager();
    m.bind({ id: 'a', combo: 'x', context: 'global', description: 'a', run: () => {} });
    m.bind({ id: 'b', combo: 'x', context: 'global', description: 'b', run: () => {} });
    const conflicts = m.conflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ combo: 'x', context: 'global' });
    expect(conflicts[0].ids).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('global + context-specific same combo is NOT a conflict (precedence handles it)', () => {
    const m = new KeybindingManager();
    m.bind({ id: 'g', combo: 'r', context: 'global', description: 'g', run: () => {} });
    m.bind({ id: 'p', combo: 'r', context: 'plan', description: 'p', run: () => {} });
    expect(m.conflicts()).toHaveLength(0);
  });

  it('registry bindings are conflict-free across the whole command set', () => {
    const m = new KeybindingManager();
    for (const cmd of COMMAND_REGISTRY) {
      for (const kb of cmd.keybindings ?? []) {
        m.bind({ id: cmd.id, combo: kb.combo, context: kb.context, description: cmd.description, run: () => {} });
      }
    }
    expect(m.conflicts()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Command registry — slash parsing, lookup, autocomplete, palette
// ---------------------------------------------------------------------------

function makeCtx(): CommandContext {
  const tui = {} as unknown as TuiHost;
  const config = {
    provider: 'mock',
    models: { planner: 'mock', coder: 'mock', reviewer: 'mock', fallback: 'mock' },
    git: { enabled: true },
    terminal: { commandTimeoutMs: 30000, maxOutputBytes: 1e6, whitelist: [] },
    agent: { maxIterations: 3, autoFix: true },
    auto: { workspaceOnly: true },
    sandbox: { enabled: true },
    adapters: [],
    providers: {}
  } as unknown as import('../src/types').LuicodeConfig;
  const services = {
    cwd: process.cwd(),
    projectName: 'x',
    config,
    mode: () => 'manual' as const,
    setMode: () => {},
    agent: () => null,
    sessions: new SessionManager(process.cwd()),
    git: {} as never,
    ws: {} as never,
    routerFor: () => null,
    runTask: async () => {},
    control: new RunControl(),
    interactive: false,
    startNewSession: () => {},
    resumeSession: () => {},
    isBusy: () => false,
    setBusy: () => {}
  };
  return { services, tui };
}

describe('Command registry', () => {
  it('parseSlash recognises name and args', () => {
    expect(parseSlash('/quit')).toEqual({ name: 'quit', args: '' });
    expect(parseSlash('  /model coder ollama/qwen3:1.7b ')).toEqual({
      name: 'model',
      args: 'coder ollama/qwen3:1.7b'
    });
    expect(parseSlash('not a slash')).toBeNull();
  });

  it('findCommandByName resolves by slash name, alias and id', () => {
    expect(findCommandByName('quit')?.id).toBe('quit');
    expect(findCommandByName('/quit')?.id).toBe('quit');
    expect(findCommandByName('exit')?.id).toBe('quit');
    expect(findCommandByName('commands')?.id).toBe('command_palette');
    expect(findCommandByName('nope-nope-nope')).toBeNull();
  });

  it('slashCommands() returns every registered slash command sorted by name', () => {
    const cmds = slashCommands();
    expect(cmds.length).toBeGreaterThan(15);
    expect(cmds.every((c) => c.slash && c.slash.startsWith('/'))).toBe(true);
    const names = cmds.map((c) => c.name);
    expect([...names].sort()).toEqual(names);
  });

  it('slashAutocomplete narrows /model+ /models and falls back gracefully', () => {
    const ids = slashAutocomplete('/model').map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['model', 'models']));
    expect(slashAutocomplete('/zzz')).toEqual([]);
  });

  it('executeSlash returns handled:false for unknown commands', async () => {
    const ctx = makeCtx();
    const res = await executeSlash('/totally-unknown-cmd', ctx);
    expect(res.handled).toBe(false);
    expect(res.message).toContain('Unknown command');
  });

  it('executeSlash handles a pure-UI command (quit) without escaping safety', async () => {
    // /quit must route to the TuiHost.quit() and not touch the file system.
    const ctx = makeCtx();
    let quitCalled = false;
    ctx.tui.quit = () => {
      quitCalled = true;
    };
    const res = await executeSlash('/quit', ctx);
    expect(res.handled).toBe(true);
    expect(quitCalled).toBe(true);
  });

  it('paletteEntries() is derived and deduplicated', () => {
    const entries = paletteEntries();
    const keys = entries.map((e) => e.command.id);
    expect(keys).not.toEqual([]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(entries.every((e) => e.command.execute)).toBe(true);
  });

  it('every registered slash command is a slash command and keybindings use unique (combo, context) pairs', () => {
    for (const cmd of COMMAND_REGISTRY) {
      if (cmd.slash) expect(cmd.execute).toBeDefined();
      const pairs = (cmd.keybindings ?? []).map((k) => `${k.combo}@${k.context}`);
      expect(pairs.length).toBe(new Set(pairs).size);
    }
  });

  it('classifyRiskKind preserves safe/modify/blocked and maps unknown', () => {
    expect(classifyRiskKind('safe')).toBe('safe');
    expect(classifyRiskKind('modify')).toBe('modify');
    expect(classifyRiskKind('blocked')).toBe('blocked');
    expect(classifyRiskKind(undefined)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// SessionManager — remove() / rename() lifecycle
// ---------------------------------------------------------------------------

describe('SessionManager remove/rename', () => {
  it('rename updates the session task and persists', () => {
    const dir = tmpdir();
    const m = new SessionManager(dir);
    const s = m.create('initial task', 'manual');
    m.save(s);
    expect(m.rename(s.id, 'renamed task')).toBe(true);
    const loaded = m.load(s.id);
    expect(loaded?.task).toBe('renamed task');
    expect(m.rename('missing-id', 'x')).toBe(false);
  });

  it('remove deletes the session file and return false for unknown ids', () => {
    const dir = tmpdir();
    const m = new SessionManager(dir);
    const s = m.create('to delete', 'safe');
    m.save(s);
    expect(m.list()).toHaveLength(1);
    expect(m.remove(s.id)).toBe(true);
    expect(m.list()).toHaveLength(0);
    expect(m.remove('nope')).toBe(false);
  });
});
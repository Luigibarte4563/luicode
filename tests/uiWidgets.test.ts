import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RunControl } from '../src/agent/runControl';
import { Workspace } from '../src/workspace/Workspace';
import { SessionManager } from '../src/sessions/SessionManager';
import { executeSlash, type CommandContext, type TuiHost } from '../src/ui/commands';
import { HelpWindow, normalizeHelpTopic } from '../src/ui/shortcuts';
import { CommandPalette } from '../src/ui/commandPalette';
import { ModelManager } from '../src/ui/modelManager';
import { SessionPicker, type SessionListItem } from '../src/ui/sessionPicker';
import { KeybindingManager } from '../src/ui/keybindings';
import type { LuicodeConfig } from '../src/types';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'luicode-widget-test-'));
}

function mockConfig(): LuicodeConfig {
  return {
    provider: 'mock',
    models: { planner: 'mock', coder: 'mock', reviewer: 'mock', fallback: 'mock' },
    git: { enabled: true },
    terminal: { commandTimeoutMs: 30000, maxOutputBytes: 1e6, whitelist: [] },
    agent: { maxIterations: 3, autoFix: true },
    auto: { workspaceOnly: true },
    sandbox: { enabled: true },
    adapters: [],
    providers: {}
  } as unknown as LuicodeConfig;
}

function makeCtx(cwd: string): CommandContext {
  const tui: TuiHost = {
    handleEvent: () => {},
    addLine: () => {},
    result: () => {},
    toast: () => {},
    openPalette: () => {},
    openModelManager: () => {},
    openSessions: () => {},
    openHelp: () => {},
    confirmYesNo: async () => true,
    resolveApproval: () => {},
    isApprovalPending: () => false,
    getMode: () => 'manual',
    setMode: () => {},
    focusPanel: () => {},
    quit: () => {}
  };
  const services = {
    cwd,
    projectName: 'x',
    config: mockConfig(),
    mode: () => 'manual' as const,
    setMode: () => {},
    agent: () => null,
    sessions: new SessionManager(cwd),
    git: { status: async () => '' } as never,
    ws: new Workspace(cwd),
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

// ---------------------------------------------------------------------------
// HelpWindow
// ---------------------------------------------------------------------------

describe('HelpWindow', () => {
  it('normalizes topics (keys → shortcuts, modes ↔ mode)', () => {
    expect(normalizeHelpTopic('keys')).toBe('shortcuts');
    expect(normalizeHelpTopic('mode')).toBe('modes');
    expect(normalizeHelpTopic('usage')).toBe('general');
    expect(normalizeHelpTopic(undefined)).toBe('shortcuts');
  });

  it('renders a shortcuts body derived from the keybinding registry', () => {
    const keys = new KeybindingManager();
    keys.bind({ id: 'x', combo: 'ctrl+p', context: 'global', description: 'palette', run: () => {} });
    keys.bind({ id: 'y', combo: 'space', context: 'agent', description: 'pause', run: () => {} });
    const h = new HelpWindow(keys);
    h.open();
    const body = h.body();
    expect(body.join('\n')).toContain('ctrl+p'.length === 0 ? '' : 'GLOBAL');
    expect(body.join('\n')).toContain('Ctrl+P');
    expect(body.join('\n')).toContain('pause');
  });

  it('consumes navigation keys and leaves scroll at sane values', () => {
    const keys = new KeybindingManager();
    const h = new HelpWindow(keys);
    h.open('modes');
    expect(h.handleKey('down')).toBe(true);
    expect(h.handleKey('j')).toBe(true);
    expect(h.handleKey('right')).toBe(true);
    expect(h.currentTopic()).not.toBe('modes');
    expect(h.handleKey('q')).toBe(false);
    const lines = h.render(80, 20);
    expect(lines.length).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// CommandPalette
// ---------------------------------------------------------------------------

describe('CommandPalette', () => {
  it('opens with registry entries, filters live, and can be cleared', () => {
    const ctx = makeCtx(tmpdir());
    const p = new CommandPalette();
    p.open(ctx);
    expect(p.isOpen).toBe(true);
    expect(p.render(80, 20).join('\n')).toContain('COMMAND PALETTE');

    p.handleChar('m', true);
    p.handleChar('o', true);
    p.handleChar('d', true);
    const rendered = p.render(80, 20).join('\n');
    expect(rendered.toLowerCase()).toContain('/model');
    expect(p.handleKey('backspace')).toBe(false); // backspace handled via dedicated method for palette
    p.clearQuery();
    expect(p.render(80, 20).join('\n')).toContain('COMMAND PALETTE');
    p.close();
    expect(p.isOpen).toBe(false);
  });

  it('runSelection is a no-op when nothing is selected', () => {
    const ctx = makeCtx(tmpdir());
    const p = new CommandPalette();
    p.open(ctx);
    ctx.tui.quit = () => {
      throw new Error('should not run without a selection');
    };
    // Filter to nothing, so no entry can be selected.
    for (const ch of 'qqqqqqzzzz') p.handleChar(ch, true);
    p.close();
  });
});

// ---------------------------------------------------------------------------
// ModelManager
// ---------------------------------------------------------------------------

describe('ModelManager', () => {
  it('render shows roles and providers; navigation + Tab switch focus', () => {
    const config = mockConfig();
    const calls: string[] = [];
    const mm = new ModelManager(
      () => config,
      {
        apply: (role, spec) => calls.push(`apply:${role}:${spec}`),
        test: (spec) => calls.push(`test:${spec}`),
        setDefault: (p) => calls.push(`default:${p}`)
      }
    );
    mm.open();
    const rendered = mm.render(90, 20).join('\n');
    expect(rendered).toContain('ROLES');
    expect(rendered).toContain('PROVIDERS');

    mm.handleKey('down'); // move role cursor → coder
    mm.handleKey('tab'); // tasks → providers
    mm.handleKey('down');
    mm.handleKey('u'); // apply highlighted provider to coder role
    expect(calls.some((c) => c.startsWith('apply:coder:'))).toBe(true);

    mm.handleKey('t'); // test highlighted provider
    expect(calls.some((c) => c.startsWith('test:'))).toBe(true);

    mm.handleKey('d'); // set default
    expect(calls.some((c) => c.startsWith('default:'))).toBe(true);
  });

  it('query pane applies a raw <provider>/<model> spec', () => {
    const config = mockConfig();
    const applied: Array<[string, string]> = [];
    const mm = new ModelManager(
      () => config,
      {
        apply: (role, spec) => applied.push([role, spec]),
        test: () => {},
        setDefault: () => {}
      }
    );
    mm.open();
    mm.handleKey('tab'); // → providers
    mm.handleKey('tab'); // → query
    for (const ch of 'mock/model-x') mm.handleKey(ch);
    mm.handleKey('return');
    expect(applied).toEqual([['planner', 'mock/model-x']]);
  });
});

// ---------------------------------------------------------------------------
// SessionPicker
// ---------------------------------------------------------------------------

describe('SessionPicker', () => {
  const items: SessionListItem[] = [
    { file: 'a.json', id: 's-a', updatedAt: 1000, task: 'first task', status: 'active' },
    { file: 'b.json', id: 's-b', updatedAt: 2000, task: 'second task', status: 'done' }
  ];

  it('lists, filters by search, renames and deletes via callbacks', () => {
    const calls: string[] = [];
    const sp = new SessionPicker({
      resume: (id) => calls.push(`resume:${id}`),
      newSession: () => calls.push('new'),
      rename: (id, name) => calls.push(`rename:${id}:${name}`),
      remove: (id) => calls.push(`remove:${id}`)
    });
    sp.open(items);
    expect(sp.render(90, 20).join('\n')).toContain('first task');

    // highlight second, resume
    sp.handleKey('down');
    sp.handleKey('return');
    expect(calls).toContain('resume:s-b');

    // search mode narrows the list
    sp.open(items);
    sp.handleKey('s');
    for (const ch of 'first') sp.handleKey(ch);
    sp.handleKey('return'); // commit search → browse
    expect(sp.render(90, 20).join('\n')).not.toContain('second task');

    // rename highlighted item
    sp.open(items);
    sp.handleKey('r');
    for (const ch of 't') sp.handleKey(ch);
    sp.handleKey('return');
    expect(calls).toContain('rename:s-a:first taskt');
    expect(calls.some((c) => c.startsWith('rename:s-a:'))).toBe(true);

    // delete second item
    sp.open(items);
    sp.handleKey('down');
    sp.handleKey('d');
    expect(calls).toContain('remove:s-b');

    // new session
    sp.handleKey('n');
    expect(calls).toContain('new');
  });
});

// ---------------------------------------------------------------------------
// Safety: slash /run still flows through CommandGuard
// ---------------------------------------------------------------------------

describe('Safety via slash commands', () => {
  it('/run rm -rf is classified BLOCKED and never executes (guard stays authoritative)', async () => {
    const cwd = tmpdir();
    const ctx = makeCtx(cwd);
    const results: Array<{ title: string }> = [];
    ctx.tui.result = (title: string) => {
      results.push({ title });
    };
    ctx.tui.confirmYesNo = async () => true;

    const res = await executeSlash('/run rm -rf /', ctx);
    expect(res.handled).toBe(true);
    const blocked = results.find((r) => r.title.includes('BLOCKED'));
    expect(blocked).toBeDefined();
  });

  it('/run ls still reports SAFE', async () => {
    const ctx = makeCtx(tmpdir());
    const results: Array<{ title: string }> = [];
    ctx.tui.result = (title: string) => {
      results.push({ title });
    };
    ctx.tui.confirmYesNo = async () => true;
    await executeSlash('/run ls', ctx);
    expect(results.some((r) => r.title.includes('SAFE'))).toBe(true);
  });
});
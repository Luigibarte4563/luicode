import { DiffEngine } from '../src/diff/DiffEngine';
import { CommandGuard } from '../src/security/commandGuard';
import { Workspace } from '../src/workspace/Workspace';
import { PermissionManager } from '../src/security/permission';
import { parsePlanText, PlanEnvironment } from '../src/planner/Planner';
import { classifyError, extractTestSummary } from '../src/agent/errors';
import { parseActions, PlanExecutor } from '../src/agent/executor';
import { Toolkit } from '../src/agent/toolkit';
import { SecurityScanner, redactSecrets } from '../src/security/scan';
import { ModelRouter } from '../src/router/ModelRouter';
import { DEFAULT_CONFIG } from '../src/config/schema';
import { inspectProject } from '../src/workspace/inspector';
import { Plan } from '../src/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'luicode-test-'));
}

describe('DiffEngine', () => {
  it('detects additions and deletions', () => {
    const d = new DiffEngine().compute('a\nb\nc', 'a\nc\nd');
    expect(d.additions).toBe(1);
    expect(d.deletions).toBe(1);
    expect(d.addedLines).toEqual(['d']);
    expect(d.removedLines).toEqual(['b']);
  });

  it('handles identical texts', () => {
    const d = new DiffEngine().compute('same\nlines', 'same\nlines');
    expect(d.additions).toBe(0);
    expect(d.deletions).toBe(0);
  });

  it('handles empty old text', () => {
    const d = new DiffEngine().compute('', 'hello\nworld');
    expect(d.additions).toBe(2);
    expect(d.deletions).toBe(0);
  });

  it('produces unified diff output', () => {
    const d = new DiffEngine().compute('x\ny', 'x\nz');
    const u = new DiffEngine().toUnified('file.txt', d);
    expect(u).toContain('+z');
    expect(u).toContain('-y');
  });
});

describe('CommandGuard', () => {
  const guard = new CommandGuard({ whitelist: ['npm test', 'npm run build'] });

  it('allows safe read-only commands', () => {
    expect(guard.classify('git status').risk).toBe('safe');
    expect(guard.classify('git diff').risk).toBe('safe');
  });

  it('allows whitelisted commands', () => {
    expect(guard.classify('npm test').risk).toBe('safe');
    expect(guard.classify('npm run build').risk).toBe('safe');
  });

  it('treats a trailing-star whitelist entry as a prefix match', () => {
    const globGuard = new CommandGuard({ whitelist: ['npm test*'] });
    expect(globGuard.classify('npm test').risk).toBe('safe');
    expect(globGuard.classify('npm test -- --watch').risk).toBe('safe');
    expect(globGuard.classify('npm run dev').risk).toBe('modify');
  });

  it('marks dependency/state changes as modify', () => {
    expect(guard.classify('npm install').risk).toBe('modify');
    expect(guard.classify('git commit -m x').risk).toBe('modify');
    expect(guard.classify('npm run dev').risk).toBe('modify');
  });

  it('blocks destructive commands', () => {
    expect(guard.classify('rm -rf /').risk).toBe('blocked');
    expect(guard.classify('rm -rf ~').risk).toBe('blocked');
    expect(guard.classify('mkfs.ext4 /dev/sda').risk).toBe('blocked');
    expect(guard.classify('git push github main').risk).toBe('modify');
  });
});

describe('Workspace boundary', () => {
  it('blocks paths outside the workspace', () => {
    const ws = new Workspace('C:/Projects/app');
    expect(() => ws.resolve('../secret.txt')).toThrow(/outside the workspace/);
    expect(ws.resolveSafe('..\\..\\etc\\passwd')).toBeNull();
  });

  it('rejects writes through a symlink that points outside the workspace', () => {
    const dir = tmpdir();
    const outside = tmpdir();
    const link = path.join(dir, 'escape');
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // symlink creation unavailable (non-elevated Windows); cannot verify
    }
    const ws = new Workspace(dir);
    expect(ws.resolveSafe('escape/secret.txt')).toBeNull();
    expect(() => ws.writeFile('escape/secret.txt', 'x')).toThrow(/outside the workspace/);
  });

  it('resolves relative paths safely', () => {
    const ws = new Workspace('C:/Projects/app');
    expect(ws.resolve('src/App.tsx')).toBe(path.resolve('C:/Projects/app', 'src', 'App.tsx'));
  });

  it('honors ignore lists in file walks', () => {
    const dir = tmpdir();
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'x');
    fs.writeFileSync(path.join(dir, 'node_modules', 'big.js'), 'y');
    const ws = new Workspace(dir);
    const files = ws.walkFiles();
    expect(files).toEqual(['src/a.ts']);
  });
});

describe('PermissionManager', () => {
  it('denies writes to protected paths', () => {
    const ws = new Workspace(os.homedir());
    const pm = new PermissionManager(ws, 'full');
    const sshKey = path.join(os.homedir(), '.ssh');
    if (fs.existsSync(sshKey) || os.homedir()) {
      const r = pm.canWriteAbsolute(sshKey);
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/protected/i);
    }
  });

  it('requires approval for deletes in safe mode', () => {
    const dir = tmpdir();
    const ws = new Workspace(dir);
    const pm = new PermissionManager(ws, 'safe');
    expect(pm.canDelete('file.txt').requiresApproval).toBe(true);
    expect(pm.canDelete('file.txt').allowed).toBe(true);
  });

  it('allows deletes without approval in full mode', () => {
    const dir = tmpdir();
    const ws = new Workspace(dir);
    const pm = new PermissionManager(ws, 'full');
    expect(pm.canDelete('file.txt').requiresApproval).toBe(false);
  });
});

describe('Planner parsing', () => {
  it('parses structured plan text', () => {
    const text = `PLAN_START
TASK: add auth
ANALYSIS: React app, needs login.
STEPS:
1. Inspect existing auth
2. Create login service
3. Protect routes
FILES_TO_CREATE:
src/auth/login.ts
FILES_TO_MODIFY:
src/routes.ts
TESTS:
npm test
RISK: medium
PLAN_END`;
    const env = parsePlanText(text);
    expect(env).not.toBeNull();
    expect(env!.steps.map((s) => s.title)).toContain('Create login service');
    expect(env!.filesToCreate).toEqual(['src/auth/login.ts']);
    expect(env!.tests).toEqual(['npm test']);
  });
});

describe('Error classification', () => {
  it('detects type errors', () => {
    const c = classifyError('error TS2322: Type X is not assignable to type Y in src/main.ts');
    expect(c.kind).toBe('type');
    expect(c.file).toContain('main.ts');
  });

  it('detects syntax errors', () => {
    expect(classifyError('SyntaxError: Unexpected token in app.js').kind).toBe('syntax');
  });

  it('parses test summaries', () => {
    expect(extractTestSummary('Tests:       42 passed, 0 failed').passed).toBe(true);
    expect(extractTestSummary('Tests:       3 failed, 39 passed').passed).toBe(false);
    expect(extractTestSummary('EXIT_CODE: 1').passed).toBe(false);
  });
});

describe('Action parsing', () => {
  it('parses multiple action blocks', () => {
    const actions = parseActions(`ACTION: WRITE_FILE
FILE: src/a.ts
CONTENT:
export const a = 1;

ACTION: RUN_COMMAND
COMMAND: npm test

ACTION: DONE`);
    expect(actions.map((a) => a.kind)).toEqual(['WRITE_FILE', 'RUN_COMMAND', 'DONE']);
    expect(actions[0].file).toBe('src/a.ts');
    expect(actions[0].content).toContain('export const a = 1;');
  });

  it('does not duplicate CONTENT in a single WRITE_FILE block', () => {
    const actions = parseActions(`ACTION: WRITE_FILE
FILE: src/b.ts
CONTENT:
// header

export function b() {}

ACTION: RUN_COMMAND
COMMAND: npm test

ACTION: DONE`);
    expect(actions[0].content).toBe('// header\n\nexport function b() {}');
  });

  it('reads multi-line CONTENT up to the next ACTION block', () => {
    const actions = parseActions(`ACTION: WRITE_FILE
FILE: src/c.ts
CONTENT:
line one
line two

ACTION: DONE`);
    expect(actions[0].content).toBe('line one\nline two');
  });
});

describe('SecurityScanner', () => {
  it('finds hardcoded secrets', () => {
    const s = new SecurityScanner();
    const f = s.scanFile('const key = "sk-abcdefghijklmnopqrstuvwxyz123456"', 'app.ts');
    expect(f.some((x) => x.severity === 'high')).toBe(true);
  });

  it('redacts secrets from output', () => {
    expect(redactSecrets('Authorization: Bearer abcdef1234567890')).not.toContain('abcdef');
  });
});

describe('ModelRouter fallback', () => {
  it('routes to configured provider', () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.provider = 'mock';
    const router = new ModelRouter(cfg);
    expect(router.isMock('coder')).toBe(true);
  });

  it('resolves specs with provider/model syntax', async () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.models.coder = 'mock';
    const router = new ModelRouter(cfg);
    const reply = await router.complete('coder', [{ role: 'user', content: 'hello' }]);
    expect(typeof reply.content).toBe('string');
  });
});

describe('PlanExecutor heuristic', () => {
  function mkExecutor(dir: string): PlanExecutor {
    const ws = new Workspace(dir);
    const toolkit = new Toolkit({
      ws,
      config: DEFAULT_CONFIG,
      mode: 'full',
      emit: () => {},
      askCommandApproval: async () => true
    });
    return new PlanExecutor({ toolkit, router: null, useLLM: false, runTests: async () => ({ command: '', passed: true, summary: '' }) });
  }

  function planWithStep(step: string): Plan {
    return {
      id: 'p1',
      task: 'Fix the calculator for the app',
      analysis: 'heuristic',
      filesToCreate: ['src/calculator.ts'],
      filesToModify: [],
      steps: [{ id: 's1', title: step, status: 'pending' }],
      tests: [],
      risk: 'low',
      status: 'approved',
      createdAt: Date.now()
    };
  }

  it('writes a .py file on a create step in a Python project', async () => {
    const dir = tmpdir();
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '');
    fs.writeFileSync(path.join(dir, 'src', 'main.py'), 'def main(): pass\n');
    const env: PlanEnvironment = { analysis: '', filesToCreate: [], filesToModify: [], steps: [], tests: [], risk: 'low' };
    const result = await mkExecutor(dir).execute(planWithStep('Create calculator module'), env, 5);
    expect(result.actions.some((a) => a.kind === 'WRITE_FILE' && a.file && a.file.endsWith('.py'))).toBe(true);
  });

  it('falls back to DONE on a create step in an unsupported-language workspace', async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'index.html'), '<main></main>\n');
    const env: PlanEnvironment = { analysis: '', filesToCreate: [], filesToModify: [], steps: [], tests: [], risk: 'low' };
    const result = await mkExecutor(dir).execute(planWithStep('Create the landing page'), env, 5);
    expect(result.actions).toEqual([]);
  });
});

describe('ProjectInspector', () => {
  it('detects framework from package.json', () => {
    const dir = tmpdir();
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { react: '^18', 'react-dom': '^18' }, devDependencies: { jest: '^29' } })
    );
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'x');
    const ws = new Workspace(dir);
    const profile = inspectProject(ws);
    expect(profile.framework).toBe('React');
    expect(profile.testFramework).toBe('Jest');
  });

  it('detects the package manager from the workspace root, not process.cwd()', () => {
    const dir = tmpdir();
    const elsewhere = tmpdir();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    const previousCwd = process.cwd();
    process.chdir(elsewhere);
    try {
      const ws = new Workspace(dir);
      const profile = inspectProject(ws);
      expect(profile.packageManager).toBe('pnpm');
    } finally {
      process.chdir(previousCwd);
    }
  });
});
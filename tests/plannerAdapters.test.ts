import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ADAPTERS, adapterForProfile, adapterNamed, resolveAdapters } from '../src/planner/adapters';
import { Planner, parsePlanText, renderPlanMarkdown } from '../src/planner/Planner';
import { Workspace } from '../src/workspace/Workspace';
import { ProjectProfile } from '../src/workspace/inspector';
import { PlanTier, StepType } from '../src/types';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'luicode-planner-test-'));
}

function profile(keyFiles: string[]): ProjectProfile {
  return {
    name: 'test',
    language: 'TypeScript',
    framework: 'Unknown',
    bundler: 'npm',
    database: 'Unknown',
    testFramework: 'Unknown',
    packageManager: 'npm',
    entryFiles: [],
    keyFiles,
    staticWeb: false
  };
}

describe('Adapter registry', () => {
  it('maintains the required adapters', () => {
    const names = ADAPTERS.map((a) => a.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'node-npm',
        'node-pnpm',
        'node-yarn',
        'python-pip',
        'python-poetry',
        'rust-cargo',
        'go-modules',
        'ruby-bundler'
      ])
    );
  });

  it('every nodemon adapter is script-suppressed where supported', () => {
    expect(adapterNamed('node-npm')!.install).toContain('--ignore-scripts');
    expect(adapterNamed('node-pnpm')!.install).toContain('--ignore-scripts');
    expect(adapterNamed('node-yarn')!.install).toContain('--ignore-scripts');
  });

  it('detects adapters from profile key files', () => {
    expect(adapterForProfile(profile(['package.json', 'package-lock.json']))!.name).toBe('node-npm');
    expect(adapterForProfile(profile(['package.json', 'pnpm-lock.yaml']))!.name).toBe('node-pnpm');
    expect(adapterForProfile(profile(['package.json', 'yarn.lock']))!.name).toBe('node-yarn');
    expect(adapterForProfile(profile(['requirements.txt']))!.name).toBe('python-pip');
    expect(adapterForProfile(profile(['Cargo.toml', 'Cargo.lock']))!.name).toBe('rust-cargo');
    expect(adapterForProfile(profile(['go.mod']))!.name).toBe('go-modules');
    expect(adapterForProfile(profile(['Gemfile']))!.name).toBe('ruby-bundler');
    expect(adapterForProfile(profile([]))).toBeNull();
  });

  it('applies config overrides through resolveAdapters and adapterForProfile', () => {
    const overrides = { 'node-npm': { install: 'npm ci --ignore-scripts', test: 'npm run test:unit' } };
    const resolved = resolveAdapters(overrides);
    const npm = resolved.find((a) => a.name === 'node-npm')!;
    expect(npm.install).toBe('npm ci --ignore-scripts');
    expect(npm.test).toBe('npm run test:unit');

    const detected = adapterForProfile(profile(['package.json']), overrides)!;
    expect(detected.install).toBe('npm ci --ignore-scripts');
  });
});

describe('parsePlanText rich steps', () => {
  it('parses type, action, why and risk on each step', () => {
    const text = `PLAN_START
TASK: scaffold a new app
ANALYSIS: from-scratch build
STEPS:
1. [scaffold] Scaffold a Next.js project — action: npx create-next-app@latest . — why: use the official scaffolder — risk: modify
2. [install] Install dependencies — action: npm install --ignore-scripts — why: pull declared deps — risk: modify+network
3. [review] Confirm the lockfile was written — action: npm ls --depth=0 — why: partial installs exit clean — risk: safe
FILES_TO_CREATE:
src/app/page.tsx
FILES_TO_MODIFY:
TESTS:
npm test
RISK: medium
PLAN_END`;

    const env = parsePlanText(text);
    expect(env).not.toBeNull();
    expect(env!.steps).toHaveLength(3);

    const [scaffold, install, review] = env!.steps;
    expect(scaffold.stepType).toBe('scaffold');
    expect(scaffold.action).toBe('npx create-next-app@latest .');
    expect(scaffold.risk).toBe('modify');
    expect(scaffold.title).toContain('Next.js');

    expect(install.stepType).toBe('install');
    expect(install.risk).toBe('modify+network');
    expect(install.action).toBe('npm install --ignore-scripts');

    expect(review.stepType).toBe('review');
    expect(review.risk).toBe('safe');
    expect(review.why).toContain('partial installs');
  });

  it('keeps plain untyped step lines working', () => {
    const text = `PLAN_START
TASK: login
ANALYSIS: add auth
STEPS:
1. Create login service
2. Protect routes
FILES_TO_CREATE:
FILES_TO_MODIFY:
TESTS:
RISK: low
PLAN_END`;
    const env = parsePlanText(text);
    expect(env).not.toBeNull();
    expect(env!.steps.map((s) => s.title)).toEqual(['Create login service', 'Protect routes']);
    expect(env!.steps[0].stepType).toBeUndefined();
    expect(env!.steps[0].risk).toBeUndefined();
  });
});

describe('renderPlanMarkdown', () => {
  it('renders task, analysis, steps with action/why/risk, files and tests', () => {
    const text = renderPlanMarkdown({
      id: 'plan-x1',
      task: 'Add login',
      analysis: 'Add an auth layer.',
      filesToCreate: ['src/auth/login.ts'],
      filesToModify: ['src/routes.ts'],
      steps: [
        { id: '1', title: 'Install dependencies', status: 'pending', stepType: 'install', action: 'npm install --ignore-scripts', why: 'pull deps', risk: 'modify+network' },
        { id: '2', title: 'Create login service', status: 'pending', stepType: 'edit', action: 'src/auth/login.ts', why: 'auth logic', risk: 'modify' }
      ],
      tests: ['npm test'],
      risk: 'medium',
      status: 'approved',
      createdAt: 1700000000000
    });

    expect(text).toContain('# LUICode Plan — plan-x1');
    expect(text).toContain('**Task:** Add login');
    expect(text).toContain('## Analysis');
    expect(text).toContain('Add an auth layer.');
    expect(text).toContain('Install dependencies [install] — `modify+network`');
    expect(text).toContain('- Action: npm install --ignore-scripts');
    expect(text).toContain('- Why: pull deps');
    expect(text).toContain('## Files to create');
    expect(text).toContain('- `src/auth/login.ts`');
    expect(text).toContain('## Tests');
    expect(text).toContain('- `npm test`');
  });
});

describe('Planner heuristic planning', () => {
  it('plans a from-scratch build through the official scaffolder when a stack is named', async () => {
    const dir = tmpdir();
    const ws = new Workspace(dir);
    const plan = await new Planner().create({ task: 'Build me a Next.js app', ws, router: null, mode: 'manual' });

    const types = plan.steps.map((s) => s.stepType as StepType);
    expect(types[0]).toBe('scaffold');
    expect(plan.steps[0].action).toContain('create-next-app');
    expect(types).toContain('install');
    expect(plan.steps.find((s) => s.stepType === 'install')!.risk).toBe('modify+network');
    expect(plan.steps.some((s) => s.action?.includes('package-lock.json'))).toBe(true);
    expect(plan.tests).toContain('npm test');
  });

  it('proposes a vanilla static site for unnamed web intent on an empty workspace', async () => {
    const dir = tmpdir();
    const ws = new Workspace(dir);
    const plan = await new Planner().create({ task: 'Build a website for my bakery', ws, router: null, mode: 'manual' });

    expect(plan.filesToCreate).toContain('index.html');
    expect(plan.steps.map((s) => s.title)).toContain('Create style.css with a modern responsive stylesheet');
    expect(plan.risk).toBe('low');
  });

  it('flags an ambiguous stack with a blocked clarify step instead of guessing', async () => {
    const dir = tmpdir();
    const ws = new Workspace(dir);
    const plan = await new Planner().create({ task: 'Build me a CLI tool', ws, router: null, mode: 'manual' });

    const first = plan.steps[0];
    expect(first.stepType).toBe('review');
    expect(first.risk).toBe('blocked');
    expect(first.title.toLowerCase()).toContain('stack');
  });

  it('routes commands through the detected adapter for existing projects', async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    const ws = new Workspace(dir);
    const plan = await new Planner().create({ task: 'Add a login API route', ws, router: null, mode: 'manual' });

    expect(plan.tests).toEqual(['npm test']);
    const runStep = plan.steps.find((s) => s.stepType === 'run');
    expect(runStep?.action).toContain('npm test');
    expect(plan.steps[0].stepType).toBe('review');
  });

  it('carries step metadata onto the Plan object', async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    const ws = new Workspace(dir);
    const plan = await new Planner().create({ task: 'Add health check endpoint', ws, router: null, mode: 'manual' });

    const risks = plan.steps.map((s) => s.risk).filter(Boolean) as PlanTier[];
    expect(risks.length).toBeGreaterThan(0);
    for (const step of plan.steps) {
      expect(typeof step.title).toBe('string');
    }
  });
});
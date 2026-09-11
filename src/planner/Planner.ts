import { AdapterOverrideConfig, ModelMessage, Plan, PlanStep, PlanTier, StepType } from '../types';
import { ModelRouter } from '../router/ModelRouter';
import { Workspace } from '../workspace/Workspace';
import { ProjectProfile, inspectProject } from '../workspace/inspector';
import { Adapter, adapterForProfile, adapterNamed, adaptersContext } from './adapters';

export interface PlannerInput {
  task: string;
  ws: Workspace;
  router: ModelRouter | null;
  mode: 'manual' | 'safe' | 'full';
  adapters?: Record<string, AdapterOverrideConfig>;
}

export interface PlanStepSpec {
  title: string;
  stepType?: StepType;
  action?: string;
  why?: string;
  risk?: PlanTier;
}

export interface PlanEnvironment {
  analysis: string;
  filesToCreate: string[];
  filesToModify: string[];
  steps: PlanStepSpec[];
  tests: string[];
  risk: 'low' | 'medium' | 'high';
}

const SYSTEM_PROMPT = `You are the planner for LUICode, an autonomous coding agent. Your job is to inspect the current workspace state and produce a step-by-step plan for the coder to execute. You do not write application code — you decide what needs to happen and in what order.

Rules:
1. Classify the workspace first. Empty or near-empty (no project manifest) → treat it as a from-scratch build and use the framework's official scaffolding CLI, then re-inspect the generated files before planning further edits. Never silently assume a framework — if the task does not name one, the first step must be a clarifying question or a proposed stack presented for approval.
2. Route all dependency, build and test operations through the detected adapter from the registry below. Use adapter commands verbatim. If no adapter matches the stack, say so explicitly and propose the closest available adapter for user approval — never guess commands.
3. Every plan step must specify: type (scaffold / install / edit / run / review), the exact action, a one-line why, and a risk tier (safe / modify / modify+network / blocked).
4. Dependency installs are high-risk. Flag them as modify+network (never bundle with plain edits), prefer script-suppressed installs, scope them to known-good registries, and always follow with a verification step (lockfile or equivalent) — never trust a zero exit code alone.
5. Never write package.json, requirements.txt, Cargo.toml or equivalent manifests by hand when an official scaffolder or adapter command can produce or update them instead.
6. Stop and request approval before any modify+network step unless the active autonomy mode is full.`;
const FORMAT_REMINDER = `Respond with a plan in this exact structured format:

PLAN_START
TASK: <task>
ANALYSIS: <1-3 sentence analysis>
STEPS:
1. [<scaffold|install|edit|run|review>] <step title> — action: <exact command or file change> — why: <one line> — risk: <safe|modify|modify+network|blocked>
2. ...
FILES_TO_CREATE:
<path>
FILES_TO_MODIFY:
<path>
TESTS:
<test command>
RISK: <low|medium|high>
PLAN_END`;

export class Planner {
  async create(input: PlannerInput): Promise<Plan> {
    const profile = inspectProject(input.ws);
    let env: PlanEnvironment;
    if (input.router) {
      env = await this.evaluate(input, profile);
    } else {
      env = this.heuristic(input, profile);
    }
    return this.buildPlan(input, env);
  }

  private async evaluate(input: PlannerInput, profile: ProjectProfile): Promise<PlanEnvironment> {
    const context = this.projectContext(input.ws, profile, input.task, input.adapters);
    const messages: ModelMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT + '\n\n' + context + '\n\n' + FORMAT_REMINDER },
      { role: 'user', content: context }
    ];
    try {
      const reply = await input.router!.complete('planner', messages);
      const extracted = parsePlanText(reply.content);
      if (extracted) return extracted;
    } catch {
      // No reachable provider — degrade to offline heuristic planning.
    }
    return this.heuristic(input, profile);
  }

  private heuristic(input: PlannerInput, profile: ProjectProfile): PlanEnvironment {
    const adapter = adapterForProfile(profile, input.adapters);
    const named = scaffoldFor(input.task);
    const webIntent = /\b(website|web page|webpage|landing page|static site|homepage|marketing site|portfolio|a site for|docs site)\b/i.test(input.task);
    const vanillaIntent = /\b(vanilla|html|css|javascript)\b/i.test(input.task);
    const isScratch = !adapter && !profile.staticWeb && !profile.manifest && profile.keyFiles.length <= 1;

    if (profile.staticWeb || (isScratch && (webIntent || vanillaIntent)) && !named) {
      return this.vanillaSitePlan(input, profile, isScratch);
    }
    if (isScratch && named) {
      return this.scaffoldPlan(input, profile, named, adapter);
    }
    if (isScratch) {
      return this.proposeStackPlan(input, profile);
    }
    return this.existingProjectPlan(input, profile, adapter);
  }

  private vanillaSitePlan(input: PlannerInput, profile: ProjectProfile, isScratch: boolean): PlanEnvironment {
    const steps: PlanStepSpec[] = [
      { title: 'Analyze the page requirements and the existing site structure', stepType: 'edit', risk: 'safe', why: 'Ground the markup in the actual page intent' },
      { title: 'Create index.html with the page markup and content', stepType: 'edit', action: 'Create index.html in the project root', risk: 'modify', why: 'Deliver the page structure' },
      { title: 'Create style.css with a modern responsive stylesheet', stepType: 'edit', action: 'Create style.css', risk: 'modify', why: 'Style the page responsively' },
      { title: 'Create script.js with interactive vanilla behavior', stepType: 'edit', action: 'Create script.js', risk: 'modify', why: 'Add interactive behavior without a framework' },
      { title: 'Review the generated webpage and fix any issues', stepType: 'review', risk: 'safe', why: 'Confirm the page renders as intended' }
    ];
    return {
      analysis: `${profile.language} static website (${profile.framework}). No build or test steps required. Will generate index.html, style.css, and script.js in the project root.${isScratch ? ' The task did not name a framework, so a dependency-free vanilla stack is proposed — swap it out when approving if you prefer a framework.' : ''}`,
      filesToCreate: ['index.html', 'style.css', 'script.js'],
      filesToModify: [],
      steps,
      tests: [],
      risk: 'low'
    };
  }

  private scaffoldPlan(input: PlannerInput, profile: ProjectProfile, stack: ScafoldCommand, adapter: Adapter | null): PlanEnvironment {
    const fallback = adapterForProfile(
      { ...profile, keyFiles: [stack.configFile] },
      input.adapters
    );
    const effective = adapter ?? fallback;
    const steps: PlanStepSpec[] = [
      { title: `Scaffold a ${stack.name} project using its official scaffolder`, stepType: 'scaffold', action: stack.cmd, risk: 'modify', why: 'Official scaffolders handle versioning, build tooling and folder conventions' },
      { title: 'Re-inspect the scaffolded project and adjust the plan', stepType: 'review', action: 'Re-run project inspection on the generated files', risk: 'safe', why: 'Ground the plan in what the scaffolder actually produced' },
      { title: 'Re-run inspection and plan edits against scaffolded files', stepType: 'review', action: 'Inspect generated manifest and layout', risk: 'safe', why: 'Avoid planning against expectations' }
    ];
    if (effective) {
      steps.push({ title: 'Install the declared dependencies', stepType: 'install', action: effective.install, risk: 'modify+network', why: 'Pull in the dependencies the scaffolder declared' });
      steps.push({ title: 'Confirm the lockfile was written', stepType: 'review', action: `${effective.verify}; check ${effective.lockfile ?? 'lockfile'} was created`, risk: 'safe', why: 'Script-suppressed installs can exit zero while only partially completing' });
    }
    steps.push(
      { title: `Create the ${shorten(input.task)} implementation`, stepType: 'edit', action: 'Create or modify source files', risk: 'modify', why: 'Deliver the requested feature on top of the scaffold' },
      { title: 'Add focused tests for the new behavior', stepType: 'edit', action: 'Write test files', risk: 'modify', why: 'Validate behavior automatically' }
    );
    const tests: string[] = effective ? [effective.test] : [];
    if (effective?.test) {
      steps.push({ title: `Run the ${effective.test} suite and fix failures`, stepType: 'run', action: effective.test, risk: 'modify', why: 'Verify the implementation against the scaffolded tooling' });
    }
    if (effective?.build) {
      steps.push({ title: `Run the build (${effective.build})`, stepType: 'run', action: effective.build, risk: 'modify', why: 'Resolve compiler or bundler errors' });
    }
    return {
      analysis: `From-scratch build: ${stack.name} via the official scaffolder. ${effective ? `Dependencies routed through the ${effective.name} adapter (${effective.install}); installs are flagged modify+network and followed by a ${effective.lockfile ?? 'lockfile'} verification.` : 'No matching adapter in the registry for this stack — closest-or-manual commands will be proposed for approval.'} Risk medium.`,
      filesToCreate: [],
      filesToModify: [],
      steps,
      tests,
      risk: 'medium'
    };
  }

  private proposeStackPlan(input: PlannerInput, profile: ProjectProfile): PlanEnvironment {
    const adapter = adapterNamed('node-npm')!;
    const steps: PlanStepSpec[] = [
      { title: 'Confirm the technology stack before scaffolding', stepType: 'review', action: 'Present a proposed stack (e.g. Next.js + TypeScript on node-npm) and components for approval', risk: 'blocked', why: 'The task does not name a framework; a guess would be baked into every later step' },
      { title: 'Scaffold the project with the selected stack official scaffolder', stepType: 'scaffold', action: 'Official scaffolding CLI for the approved stack', risk: 'modify', why: 'Start from canonical project conventions' },
      { title: 'Re-inspect the scaffolded project', stepType: 'review', action: 'Inspect the generated files before editing', risk: 'safe', why: 'Plan edits against what the scaffolder produced' },
      { title: 'Install the declared dependencies', stepType: 'install', action: adapter.install, risk: 'modify+network', why: 'Pull in declared dependencies, script-suppressed by default' },
      { title: 'Confirm the lockfile was written', stepType: 'review', action: `${adapter.verify}; check package-lock.json was created`, risk: 'safe', why: 'Partial installs can still exit clean' },
      { title: `Create the ${shorten(input.task)} implementation`, stepType: 'edit', action: 'Create or modify source files', risk: 'modify', why: 'Deliver the requested feature' },
      { title: 'Add focused tests for the new behavior', stepType: 'edit', action: 'Write test files', risk: 'modify', why: 'Validate behavior automatically' },
      { title: `Run the ${adapter.test} suite and fix failures`, stepType: 'run', action: adapter.test, risk: 'modify', why: 'Verify the implementation' }
    ];
    return {
      analysis: `From-scratch build with no named stack. A stack is proposed for approval before scaffolding (node-npm is the closest adapter in the registry). Risk medium.`,
      filesToCreate: [],
      filesToModify: [],
      steps,
      tests: [adapter.test],
      risk: 'medium'
    };
  }

  private existingProjectPlan(input: PlannerInput, profile: ProjectProfile, adapter: Adapter | null): PlanEnvironment {
    const steps: PlanStepSpec[] = [
      { title: `Analyze existing ${profile.framework || 'application'} architecture and locate integration points`, stepType: 'review', risk: 'safe', why: 'Ground changes in the existing structure' },
      { title: `Create the ${shorten(input.task)} implementation`, stepType: 'edit', action: 'Create or modify source files', risk: 'modify', why: 'Deliver the requested behavior' },
      { title: 'Add focused tests covering the new behavior', stepType: 'edit', action: 'Write test files', risk: 'modify', why: 'Validate the new behavior' }
    ];
    const tests: string[] = adapter ? [adapter.test] : testCommandsFor(profile);
    if (tests.length) {
      steps.push({ title: `Run the ${tests[0]} suite and fix failures`, stepType: 'run', action: tests[0], risk: 'modify', why: 'Verify the implementation' });
    }
    if (adapter?.build) {
      steps.push({ title: `Run the build (${adapter.build})`, stepType: 'run', action: adapter.build, risk: 'modify', why: 'Resolve compiler or bundler errors' });
    }
    steps.push({ title: 'Verify the complete flow end-to-end', stepType: 'review', risk: 'safe', why: 'Confirm the feature works in context' });

    const filesToCreate: string[] = [];
    const filesToModify: string[] = ['README.md'];
    if (profile.entryFiles.length) filesToModify.push(...profile.entryFiles.slice(0, 2));
    if (profile.keyFiles.includes('package.json')) filesToModify.push('package.json');
    return {
      analysis: `${profile.language} project (${profile.framework}). ${profile.testFramework} testing. ${adapter ? `Commands routed through the ${adapter.name} adapter.` : 'No adapter in the registry matches this stack — install/build/test commands are proposed for approval.'} ${filesToCreate.length ? `Will likely create ${filesToCreate.length} new file(s).` : 'Will primarily modify existing files.'}`,
      filesToCreate,
      filesToModify,
      steps,
      tests,
      risk: 'medium'
    };
  }

  private projectContext(ws: Workspace, profile: ProjectProfile, task: string, adapters?: Record<string, AdapterOverrideConfig>): string {
    const tree = ws.tree('.', 3);
    const adapter = adapterForProfile(profile, adapters);
    return `TASK: ${task}

=== PROJECT ===
Name: ${profile.name}
Language: ${profile.language}
Framework: ${profile.framework}
Test framework: ${profile.testFramework}
Package manager: ${profile.packageManager}
Entry files: ${profile.entryFiles.join(', ') || 'none'}
Detected adapter: ${adapter?.name ?? 'none (propose the closest one)'}

=== ADAPTER REGISTRY ===
${adaptersContext(adapters)}

=== FILE TREE ===
${tree}

=== PROJECT ANALYSIS ===`;
  }

  private buildPlan(input: PlannerInput, env: PlanEnvironment): Plan {
    const steps: PlanStep[] = env.steps.map((s, i) => ({
      id: `${i + 1}`,
      title: s.title,
      status: 'pending',
      stepType: s.stepType,
      action: s.action,
      why: s.why,
      risk: s.risk
    }));
    return {
      id: `plan-${Date.now().toString(36)}`,
      task: input.task,
      analysis: env.analysis,
      filesToCreate: env.filesToCreate,
      filesToModify: env.filesToModify,
      steps,
      tests: env.tests,
      risk: env.risk,
      status: 'pending',
      createdAt: Date.now()
    };
  }
}

function shorten(task: string): string {
  const t = task.trim();
  return t.length > 60 ? t.slice(0, 57) + '…' : t;
}

export function renderPlanMarkdown(plan: Plan): string {
  const lines: string[] = [
    `# LUICode Plan — ${plan.id}`,
    '',
    `**Task:** ${plan.task}`,
    `**Risk:** ${plan.risk} · **Status:** ${plan.status}`,
    `**Created:** ${new Date(plan.createdAt).toISOString()}`,
    '',
    '## Analysis',
    '',
    plan.analysis || '—',
    '',
    '## Steps',
    ''
  ];
  for (const s of plan.steps) {
    const type = s.stepType ? ` [${s.stepType}]` : '';
    const risk = s.risk ? ` — \`${s.risk}\`` : '';
    lines.push(`1. ${s.title}${type}${risk}`);
    if (s.action) lines.push(`   - Action: ${s.action}`);
    if (s.why) lines.push(`   - Why: ${s.why}`);
    lines.push('');
  }
  if (plan.filesToCreate.length) {
    lines.push('## Files to create');
    lines.push('');
    for (const f of plan.filesToCreate) lines.push(`- \`${f}\``);
    lines.push('');
  }
  if (plan.filesToModify.length) {
    lines.push('## Files to modify');
    lines.push('');
    for (const f of plan.filesToModify) lines.push(`- \`${f}\``);
    lines.push('');
  }
  if (plan.tests.length) {
    lines.push('## Tests');
    lines.push('');
    for (const t of plan.tests) lines.push(`- \`${t}\``);
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

interface ScafoldCommand {
  name: string;
  cmd: string;
  configFile: string;
}

const STACKS: Array<ScafoldCommand & { rx: RegExp }> = [
  { rx: /\bnext\s*\.?\s*js\b|\bnextjs\b/i, cmd: 'npx create-next-app@latest .', name: 'Next.js', configFile: 'package.json' },
  { rx: /\bnuxt\b/i, cmd: 'npm create nuxt@latest .', name: 'Nuxt', configFile: 'package.json' },
  { rx: /\bvite\b/i, cmd: 'npm create vite@latest .', name: 'Vite', configFile: 'package.json' },
  { rx: /\breact\b/i, cmd: 'npm create vite@latest . -- --template react', name: 'React (Vite template)', configFile: 'package.json' },
  { rx: /\bvue\b/i, cmd: 'npm create vue@latest .', name: 'Vue', configFile: 'package.json' },
  { rx: /\bsvelte\b/i, cmd: 'npm create svelte@latest .', name: 'Svelte', configFile: 'package.json' },
  { rx: /\bexpress\b/i, cmd: 'npm init -y && npm install --ignore-scripts express', name: 'Express', configFile: 'package.json' },
  { rx: /\bdjango\b/i, cmd: 'pip install django && django-admin startproject project .', name: 'Django', configFile: 'manage.py' },
  { rx: /\bflask\b/i, cmd: 'pip install flask', name: 'Flask', configFile: 'requirements.txt' },
  { rx: /\bfastapi\b/i, cmd: 'pip install "fastapi[standard]"', name: 'FastAPI', configFile: 'requirements.txt' }
];

function scaffoldFor(task: string): ScafoldCommand | null {
  const hit = STACKS.find((s) => s.rx.test(task));
  return hit ? { name: hit.name, cmd: hit.cmd, configFile: hit.configFile } : null;
}

export function testCommandsFor(profile: ProjectProfile): string[] {
  if (profile.testFramework === 'Jest' || profile.testFramework === 'Vitest') return ['npm test'];
  if (profile.testFramework === 'pytest') return ['python -m pytest'];
  if (profile.testFramework === 'go test') return ['go test ./...'];
  if (profile.testFramework === 'cargo test') return ['cargo test'];
  return [];
}

export function parsePlanText(text: string): PlanEnvironment | null {
  const body = text.match(/PLAN_START\s*([\s\S]*?)\s*PLAN_END/);
  const content = body?.[1] ?? text;
  const task = readSection(content, 'TASK');
  const analysis = readSection(content, 'ANALYSIS');
  const steps = extractList(content, 'STEPS', 'FILES_TO_CREATE').map(parseStepLine);
  const filesToCreate = extractList(content, 'FILES_TO_CREATE', 'FILES_TO_MODIFY');
  const filesToModify = extractList(content, 'FILES_TO_MODIFY', 'TESTS');
  const tests = extractList(content, 'TESTS', 'RISK');
  const riskMatch = content.match(/RISK:\s*(\w+)/);
  if (steps.length < 2) return null;
  const risk = riskMatch?.[1] === 'high' || riskMatch?.[1] === 'low' ? (riskMatch[1] as 'high' | 'low') : 'medium';
  return { analysis: analysis ?? '—', filesToCreate, filesToModify, steps, tests, risk };
}

const STEP_TYPES: StepType[] = ['scaffold', 'install', 'edit', 'run', 'review'];

function parseStepLine(raw: string): PlanStepSpec {
  const line = raw.trim();
  let rest = line;
  let stepType: StepType | undefined;
  const typeMatch = rest.match(/^\[([a-z+_]+)\]\s+([\s\S]*)$/i);
  if (typeMatch) {
    const t = typeMatch[1].toLowerCase();
    if ((STEP_TYPES as string[]).includes(t)) stepType = t as StepType;
    rest = typeMatch[2].trim();
  }
  const segs = rest.split(/\s*(?:—|--)\s+/);
  const fields: Record<string, string> = {};
  const titleParts: string[] = [];
  for (const seg of segs) {
    const m = seg.match(/^(action|why|risk):\s*(.+)$/i);
    if (m) fields[m[1].toLowerCase()] = m[2].trim();
    else titleParts.push(seg.trim());
  }
  return {
    title: titleParts.join(' — ').trim(),
    stepType,
    action: fields.action,
    why: fields.why,
    risk: parseRisk(fields.risk)
  };
}

function parseRisk(v: string | undefined): PlanTier | undefined {
  if (!v) return undefined;
  const s = v.trim().toLowerCase().replace(/_/g, '-').replace(/ /g, '-');
  if (s === 'safe' || s === 'modify' || s === 'modify+network' || s === 'blocked') return s;
  if (s.includes('block')) return 'blocked';
  if (s.includes('network')) return 'modify+network';
  if (s.includes('modif')) return 'modify';
  return 'safe';
}

function readSection(text: string, key: string): string | undefined {
  const m = text.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  return m?.[1]?.trim();
}

function extractList(text: string, from: string, to: string): string[] {
  const rx = new RegExp(`${from}:\\s*([\\s\\S]*?)(?=\\n${to}:|$)`);
  const m = text.match(rx);
  if (!m) return [];
  const items = m[1].split('\n').filter(Boolean);
  return items
    .map((i) => i.replace(/^\s*(?:\d+[.)]\s*|[•\-+]\s*)/, '').trim())
    .filter((i) => i.length > 0 && !/^(analysis|files_to_create|files_to_modify|tests):$/i.test(i));
}
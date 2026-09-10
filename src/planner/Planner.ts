import { ModelMessage, Plan, PlanStep } from '../types';
import { ModelRouter } from '../router/ModelRouter';
import { Workspace } from '../workspace/Workspace';
import { ProjectProfile, inspectProject } from '../workspace/inspector';

export interface PlannerInput {
  task: string;
  ws: Workspace;
  router: ModelRouter | null;
  mode: 'manual' | 'safe' | 'full';
}

export interface PlanEnvironment {
  analysis: string;
  filesToCreate: string[];
  filesToModify: string[];
  steps: string[];
  tests: string[];
  risk: 'low' | 'medium' | 'high';
}

const SYSTEM_PROMPT = `You are LUICode, an AI coding agent. Produce an implementation plan.

Constraints:
- Never modify files immediately. Only output the plan.
- Plan must be concise and actionable; no more than 14 steps.
- You may call tools to inspect the project before finalizing a plan.`;
const FORMAT_REMINDER = `Respond with a plan in this exact structured format:

PLAN_START
TASK: <task>
ANALYSIS: <1-3 sentence analysis>
STEPS:
1. <step>
2. <step>
...
FILES_TO_CREATE:
<path>
<path>
FILES_TO_MODIFY:
<path>
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
    const context = this.projectContext(input.ws, profile, input.task);
    const messages: ModelMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT + '\n' + FORMAT_REMINDER },
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
    const webIntent =
      /website|web page|webpage|landing page|static site|a site for|html|css|javascript|vanilla/i.test(input.task);
    if (profile.staticWeb || (webIntent && !profile.manifest)) {
      const steps: string[] = [
        'Analyze the page requirements and the existing site structure',
        'Create index.html with the page markup and content',
        'Create style.css with a modern responsive stylesheet',
        'Create script.js with interactive vanilla behavior',
        'Review the generated webpage and fix any issues'
      ];
      return {
        analysis: `${profile.language} static website (${profile.framework}). No build or test steps required. Will generate index.html, style.css, and script.js in the project root.`,
        filesToCreate: ['index.html', 'style.css', 'script.js'],
        filesToModify: [],
        steps,
        tests: [],
        risk: 'low'
      };
    }
    const steps: string[] = [
      `Analyze existing ${profile.framework || 'application'} architecture and locate integration points`,
      `Create the ${shorten(input.task)} implementation`,
      'Add focused tests covering the new behavior',
      'Run the test suite and fix failures',
      'Run the build and resolve compiler errors',
      'Verify the complete flow end-to-end'
    ];
    const filesToCreate: string[] = [];
    const filesToModify: string[] = ['README.md'];
    if (profile.entryFiles.length) filesToModify.push(...profile.entryFiles.slice(0, 2));
    if (profile.keyFiles.includes('package.json')) filesToModify.push('package.json');
    const tests = testCommandsFor(profile);
    return {
      analysis: `${profile.language} project (${profile.framework}). ${profile.testFramework} testing. ${
        filesToCreate.length ? `Will likely create ${filesToCreate.length} new file(s).` : 'Will primarily modify existing files.'
      }`,
      filesToCreate,
      filesToModify,
      steps,
      tests,
      risk: 'medium'
    };
  }

  private projectContext(ws: Workspace, profile: ProjectProfile, task: string): string {
    const tree = ws.tree('.', 3);
    return `TASK: ${task}

=== PROJECT ===
Name: ${profile.name}
Language: ${profile.language}
Framework: ${profile.framework}
Test framework: ${profile.testFramework}
Package manager: ${profile.packageManager}
Entry files: ${profile.entryFiles.join(', ') || 'none'}

=== FILE TREE ===
${tree}

=== PROJECT ANALYSIS ===`;
  }

  private buildPlan(input: PlannerInput, env: PlanEnvironment): Plan {
    const steps: PlanStep[] = env.steps.map((s, i) => ({ id: `${i + 1}`, title: s, status: 'pending' }));
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
  const steps = extractList(content, 'STEPS', 'FILES_TO_CREATE');
  const filesToCreate = extractList(content, 'FILES_TO_CREATE', 'FILES_TO_MODIFY');
  const filesToModify = extractList(content, 'FILES_TO_MODIFY', 'TESTS');
  const tests = extractList(content, 'TESTS', 'RISK');
  const riskMatch = content.match(/RISK:\s*(\w+)/);
  if (steps.length < 2) return null;
  const risk = riskMatch?.[1] === 'high' || riskMatch?.[1] === 'low' ? (riskMatch[1] as 'high' | 'low') : 'medium';
  return { analysis: analysis ?? '—', filesToCreate, filesToModify, steps, tests, risk };
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
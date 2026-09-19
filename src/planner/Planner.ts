import { AdapterOverrideConfig, ModelMessage, Plan, PlanStep, PlanTier, StackConfidence, StepType } from '../types';
import { ModelRouter } from '../router/ModelRouter';
import { Workspace } from '../workspace/Workspace';
import { ProjectProfile, inspectProject } from '../workspace/inspector';
import { Adapter, adapterForProfile, adapterNamed, adaptersContext } from './adapters';
import * as fs from 'fs';
import * as path from 'path';

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

interface ProjectUnderstanding {
  framework: string;
  language: string;
  packageManager: string;
  entryPoints: string[];
  architecture: {
    patterns: string[];
    structure: Record<string, string[]>; // directory -> files
  };
  dependencies: Record<string, string>;
  importantFiles: string[];
  potentialIssues: string[];
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

  /**
   * Loads project understanding from .luicode/project-map.md if available
   */
  private async loadProjectUnderstanding(ws: Workspace): Promise<ProjectUnderstanding | null> {
    try {
      const projectMapPath = path.join(ws.root, '.luicode', 'project-map.md');
      if (!ws.absoluteExists(projectMapPath)) {
        return null;
      }

      const content = ws.readFile(projectMapPath);
      if (!content) {
        return null;
      }

      // Parse the project map to extract structured data
      // This is a simplified parser - in a full implementation, we would parse the markdown more thoroughly
      const understanding: ProjectUnderstanding = {
        framework: 'Unknown',
        language: 'Unknown',
        packageManager: 'Unknown',
        entryPoints: [],
        architecture: {
          patterns: [],
          structure: {}
        },
        dependencies: {},
        importantFiles: [],
        potentialIssues: []
      };

      // Extract basic info from the project map
      const lines = content.split('\n');
      for (const line of lines) {
        if (line.includes('**Framework:**')) {
          understanding.framework = line.split('**Framework:**')[1].trim();
        } else if (line.includes('**Language:**')) {
          understanding.language = line.split('**Language:**')[1].trim();
        } else if (line.includes('**Package Manager:**')) {
          understanding.packageManager = line.split('**Package Manager:**')[1].trim();
        }
      }

      // Extract patterns
      const patternsStart = content.indexOf('## Architecture');
      if (patternsStart !== -1) {
        const patternsSection = content.substring(patternsStart);
        const patternsEnd = patternsSection.indexOf('\n## ');
        const patternsContent = patternsEnd !== -1
          ? patternsSection.substring(0, patternsEnd)
          : patternsSection;

        const patternLines = patternsContent.split('\n')
          .filter(line => line.trim().startsWith('✓'))
          .map(line => line.substring(2).trim());
        understanding.architecture.patterns = patternLines;
      }

      // Extract important files
      const importantFilesStart = content.indexOf('## Important Files');
      if (importantFilesStart !== -1) {
        const importantFilesSection = content.substring(importantFilesStart);
        const importantFilesEnd = importantFilesSection.indexOf('\n## ');
        const importantFilesContent = importantFilesEnd !== -1
          ? importantFilesSection.substring(0, importantFilesEnd)
          : importantFilesSection;

        const importantFileLines = importantFilesContent.split('\n')
          .filter(line => line.trim().startsWith('✓'))
          .map(line => line.substring(2).trim());
        understanding.importantFiles = importantFileLines;
      }

      // Extract dependencies
      const depsStart = content.indexOf('## Dependencies');
      if (depsStart !== -1) {
        const depsSection = content.substring(depsStart);
        const depsEnd = depsSection.indexOf('\n## ');
        const depsContent = depsEnd !== -1
          ? depsSection.substring(0, depsEnd)
          : depsSection;

        const depLines = depsContent.split('\n')
          .filter(line => line.trim().startsWith('✓'))
          .map(line => line.substring(2).trim());

        // Parse dependency lines like "✓ react 18.2.0"
        for (const depLine of depLines) {
          const parts = depLine.split(' ');
          if (parts.length >= 2) {
            const depName = parts[0];
            const depVersion = parts[1];
            // Check if it's a dev dependency
            const isDev = depLine.includes('(dev)');
            if (!isDev) {
              understanding.dependencies[depName] = depVersion;
            }
            // For simplicity, we're putting all in dependencies; could split into devDependencies if needed
          }
        }
      }

      // Extract potential issues
      const issuesStart = content.indexOf('## Potential Issues');
      if (issuesStart !== -1) {
        const issuesSection = content.substring(issuesStart);
        const issuesEnd = issuesSection.indexOf('\n## ');
        const issuesContent = issuesEnd !== -1
          ? issuesSection.substring(0, issuesEnd)
          : issuesSection;

        const issueLines = issuesContent.split('\n')
          .filter(line => line.trim().startsWith('⚠'))
          .map(line => line.substring(2).trim());
        understanding.potentialIssues = issueLines;
      }

      return understanding;
    } catch (error) {
      // If we fail to load or parse, return null to fall back to standard planning
      return null;
    }
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

  /**
   * Resolves whether a from-scratch build is "confirmed" on its technology
   * stack. A stack is confirmed when the inspector detected a manifest, or when
   * the task text itself names a recognizable framework keyword. When the
   * inspector only guessed (empty workspace) and the task is silent on the
   * stack, the plan must stop and ask the user to confirm before scaffolding.
   */
  private stackConfirmed(input: PlannerInput, profile: ProjectProfile): boolean {
    if (profile.stackConfidence === 'detected') return true;
    return scaffoldFor(input.task) !== null;
  }

  private heuristic(input: PlannerInput, profile: ProjectProfile): PlanEnvironment {
    const adapter = adapterForProfile(profile, input.adapters);
    const named = scaffoldFor(input.task);
    const scratch = profile.stackConfidence !== 'detected' && profile.entryFiles.length === 0;

    if (scratch && !this.stackConfirmed(input, profile)) {
      return this.proposeStackPlan(input, profile);
    }
    if (scratch && named?.name === 'HTML/CSS/JS') {
      return this.staticWebPlan(input, profile);
    }
    if (scratch && named) {
      return this.scaffoldPlan(input, profile, named, adapter);
    }
    return this.existingProjectPlan(input, profile, adapter);
  }

  private staticWebPlan(input: PlannerInput, profile: ProjectProfile): PlanEnvironment {
    // Load project understanding if available
    const projectUnderstanding = this.loadProjectUnderstanding(input.ws);

    // Generate the implementation step title and action
    let implementationTitle = `Create the ${shorten(input.task)} implementation`;
    let implementationAction = 'Write the page markup, styles and behaviour into the scaffolded files';
    let implementationWhy = 'Deliver the requested feature on top of the scaffold';

    // If we have project understanding, make the implementation step more specific
    if (projectUnderstanding) {
      // Check if there are existing files that might be relevant to the task
      const relevantFiles = this.findRelevantFiles(input.task, projectUnderstanding);

      if (relevantFiles.length > 0) {
        // We found existing files that might be related to the task
        implementationTitle = `Extend existing ${input.task} implementation`;
        implementationAction = `Modify existing files: ${relevantFiles.join(', ')}`;
        implementationWhy = `Leverage existing implementations rather than creating duplicates`;
      } else {
        // No existing relevant files found, but we can still provide some guidance
        implementationTitle = `Create new ${input.task} implementation`;
        implementationAction = `Create new files in appropriate directories based on project structure`;
        implementationWhy = `Follow existing project patterns and conventions`;
      }
    }

    const steps: PlanStepSpec[] = [
      { title: 'Create the static site scaffold (index.html, style.css, script.js)', stepType: 'edit', action: 'Create index.html, style.css and script.js with minimal canonical content', risk: 'modify', why: 'Static sites have no official scaffolder; the vanilla three-file layout is the conventional starting point' },
      { title: implementationTitle, stepType: 'edit', action: implementationAction, risk: 'modify', why: implementationWhy },
      { title: 'Add focused tests for the new behavior', stepType: 'edit', action: 'Write test files', risk: 'modify', why: 'Validate behavior automatically' }
    ];
    return {
      analysis: `From-scratch build: the task explicitly names a plain HTML/CSS/JS (static) stack, so no framework confirmation is needed and no framework adapter applies — the vanilla scaffold is the resolved stack. Risk low.`,
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
    // Load project understanding if available
    const projectUnderstanding = this.loadProjectUnderstanding(input.ws);

    // Generate the implementation step title and action
    let implementationTitle = `Create the ${shorten(input.task)} implementation`;
    let implementationAction = 'Create or modify source files';
    let implementationWhy = 'Deliver the requested feature';

    // If we have project understanding, make the implementation step more specific
    if (projectUnderstanding) {
      // Check if there are existing files that might be relevant to the task
      const relevantFiles = this.findRelevantFiles(input.task, projectUnderstanding);

      if (relevantFiles.length > 0) {
        // We found existing files that might be related to the task
        implementationTitle = `Extend existing ${input.task} implementation`;
        implementationAction = `Modify existing files: ${relevantFiles.join(', ')}`;
        implementationWhy = `Leverage existing implementations rather than creating duplicates`;
      } else {
        // No existing relevant files found, but we can still provide some guidance
        implementationTitle = `Create new ${input.task} implementation`;
        implementationAction = `Create new files in appropriate directories based on project structure`;
        implementationWhy = `Follow existing project patterns and conventions`;
      }
    }

    const adapter = adapterNamed('node-npm')!;
    const steps: PlanStepSpec[] = [
      { title: 'Confirm the technology stack before scaffoding', stepType: 'review', action: 'Present a proposed stack (e.g. Next.js + TypeScript on node-npm) and components for approval', risk: 'blocked', why: 'The task does not name a framework; a guess would be baked into every later step' },
      { title: 'Scaffold the project with the selected stack official scaffolder', stepType: 'scaffold', action: 'Official scaffolding CLI for the approved stack', risk: 'modify', why: 'Start from canonical project conventions' },
      { title: 'Re-inspect the scaffolded project', stepType: 'review', action: 'Inspect the generated files before editing', risk: 'safe', why: 'Plan edits against what the scaffolder produced' },
      { title: 'Install the declared dependencies', stepType: 'install', action: adapter.install, risk: 'modify+network', why: 'Pull in declared dependencies, script-suppressed by default' },
      { title: 'Confirm the lockfile was written', stepType: 'review', action: `${adapter.verify}; check package-lock.json was created`, risk: 'safe', why: 'Partial installs can still exit clean' },
      { title: implementationTitle, stepType: 'edit', action: implementationAction, risk: 'modify', why: implementationWhy },
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
    // Load project understanding if available
    const projectUnderstanding = this.loadProjectUnderstanding(input.ws);

    // Generate the implementation step title and action
    let implementationTitle = `Create the ${shorten(input.task)} implementation`;
    let implementationAction = 'Create or modify source files';
    let implementationWhy = 'Deliver the requested behavior';

    // If we have project understanding, make the implementation step more specific
    if (projectUnderstanding) {
      // Check if there are existing files that might be relevant to the task
      const relevantFiles = this.findRelevantFiles(input.task, projectUnderstanding);

      if (relevantFiles.length > 0) {
        // We found existing files that might be related to the task
        implementationTitle = `Extend existing ${input.task} implementation`;
        implementationAction = `Modify existing files: ${relevantFiles.join(', ')}`;
        implementationWhy = `Leverage existing implementations rather than creating duplicates`;
      } else {
        // No existing relevant files found, but we can still provide some guidance
        implementationTitle = `Create new ${input.task} implementation`;
        implementationAction = `Create new files in appropriate directories based on project structure`;
        implementationWhy = `Follow existing project patterns and conventions`;
      }
    }

    const steps: PlanStepSpec[] = [
      { title: `Analyze existing ${profile.framework || 'application'} architecture and locate integration points`, stepType: 'review', risk: 'safe', why: 'Ground changes in the existing structure' },
      { title: implementationTitle, stepType: 'edit', action: implementationAction, risk: 'modify', why: implementationWhy },
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

  /**
   * Finds files in the project understanding that might be relevant to the given task
   */
  private findRelevantFiles(task: string, understanding: ProjectUnderstanding): string[] {
    const relevantFiles: string[] = [];
    const taskLower = task.toLowerCase();

    // Common task keywords and their associated file patterns
    const taskPatterns: Record<string, string[]> = {
      'auth': ['auth', 'login', 'logout', 'password', 'token', 'session'],
      'user': ['user', 'profile', 'account'],
      'api': ['api', 'service', 'endpoint', 'route'],
      'database': ['db', 'database', 'model', 'entity', 'repository'],
      'ui': ['component', 'page', 'view', 'ui'],
      'util': ['util', 'helper', 'utils', 'helpers'],
      'test': ['test', 'spec'],
      'config': ['config', 'settings', 'configure']
    };

    // Check if task matches any known patterns
    let matchedPatterns: string[] = [];
    for (const [pattern, keywords] of Object.entries(taskPatterns)) {
      if (taskLower.includes(pattern) || keywords.some(keyword => taskLower.includes(keyword))) {
        matchedPatterns = keywords;
        break;
      }
    }

    // If no specific pattern matched, use words from the task itself
    if (matchedPatterns.length === 0) {
      const taskWords = taskLower.split(/\s+/).filter(w => w.length > 2);
      matchedPatterns = taskWords;
    }

    // Search for files that match these patterns
    const allFiles = [...understanding.importantFiles];
    for (const [dir, files] of Object.entries(understanding.architecture.structure)) {
      allFiles.push(...files.map(f => path.join(dir, f)));
    }

    for (const file of allFiles) {
      const fileLower = file.toLowerCase();
      const fileName = path.basename(fileLower);

      // Check if file matches any of our patterns
      if (matchedPatterns.some(pattern =>
          fileName.includes(pattern) ||
          fileLower.includes(pattern))) {
        relevantFiles.push(file);
      }
    }

    // Limit to most relevant files
    return relevantFiles.slice(0, 5);
  }

  private projectContext(ws: Workspace, profile: ProjectProfile, task: string, adapters?: Record<string, AdapterOverrideConfig>): string {
    const tree = ws.tree('.', 3);
    const adapter = adapterForProfile(profile, adapters);
    return `TASK: ${task}

=== PROJECT ===
Name: ${profile.name}
Language: ${profile.language}
Framework: ${profile.framework}
Stack confidence: ${profile.stackConfidence === 'detected' ? 'detected (from project manifest)' : 'guessed (no project manifest — default is html-css-js; must confirm with the user unless the task names a stack)'}
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
  { rx: /\bfastapi\b/i, cmd: 'pip install "fastapi[standard]"', name: 'FastAPI', configFile: 'requirements.txt' },
  { rx: /\bstatic\s+(?:website|site|web\s?page)\b|\bvanilla\s+(?:html|css|js|javascript)\b|\b(?:plain\s+|pure\s+)?(?:html\s*css\s*js|html\/css\/js)\b/i, cmd: '', name: 'HTML/CSS/JS', configFile: 'index.html' }
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
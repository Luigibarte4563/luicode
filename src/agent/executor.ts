import { ModelMessage, Plan, TestResult } from '../types';
import { GeneratorAgent, GeneratorAgentOptions } from './GeneratorAgent';
import { ModelRouter } from '../router/ModelRouter';
import { Toolkit } from './toolkit';
import { classifyError, extractTestSummary } from './errors';
import { PlanEnvironment } from '../planner/Planner';
import { inspectProject, ProjectProfile } from '../workspace/inspector';
import { RunControl, isCancelled } from './runControl';

function extractCommentary(text: string): { commentary: string; body: string } {
  const startMatch = text.match(/---\s*commentary\s*---\s*\n?([\s\S]*?)\n?---\s*end\s*commentary\s*---/i);
  if (!startMatch) return { commentary: '', body: text };
  const commentary = startMatch[1].trim();
  const body = text.slice(startMatch.index! + startMatch[0].length).trim();
  return { commentary, body };
}

export { extractCommentary };

export interface ParsedAction {
  kind: 'READ_FILE' | 'WRITE_FILE' | 'EDIT_FILE' | 'RUN_COMMAND' | 'SEARCH_CODE' | 'DONE' | 'ANALYSIS';
  file?: string;
  find?: string;
  replace?: string;
  command?: string;
  query?: string;
  content?: string;
}

export function parseActions(text: string): ParsedAction[] {
  const actions: ParsedAction[] = [];
  const lines = text.split('\n');
  const rx = /^ACTION:\s*([A-Z_]+)\s*$/;
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(rx);
    if (!m) {
      i++;
      continue;
    }
    const kind = m[1] as ParsedAction['kind'];
    i++;
    const block: string[] = [];
    while (i < lines.length && !rx.test(lines[i])) {
      block.push(lines[i]);
      i++;
    }
    actions.push(parseActionBlock(kind, block));
  }
  if (!actions.length) {
    const blockText = text.trim();
    if (/^FILE:|^CONTENT:|^COMMAND:|^QUERY:/m.test(blockText)) {
      actions.push(parseActionBlock('WRITE_FILE', blockText.split('\n')));
    }
  }
  return actions;
}

function parseActionBlock(kind: ParsedAction['kind'], block: string[]): ParsedAction {
  const read = (tag: string): string | undefined => {
    const idx = block.findIndex((l) => new RegExp(`^${tag}:`).test(l));
    if (idx < 0) return undefined;
    const out: string[] = [];
    for (const line of block.slice(idx + 1)) {
      if (/^(FIND|REPLACE|COMMAND|QUERY|CONTENT):/.test(line)) break;
      out.push(line);
    }
    return out.join('\n').trim();
  };
  const val = (tag: string): string | undefined => {
    const m = block.find((l) => new RegExp(`^${tag}:\\s*(.*)$`).test(l));
    return m?.match(new RegExp(`^${tag}:\\s*(.*)$`))?.[1];
  };

  switch (kind) {
    case 'RUN_COMMAND':
      return { kind, command: val('COMMAND') ?? val('CMD') ?? read('COMMAND') };
    case 'READ_FILE':
      return { kind, file: val('FILE') ?? read('FILE') };
    case 'SEARCH_CODE':
      return { kind, query: val('QUERY') ?? val('SEARCH') ?? read('QUERY') };
    case 'EDIT_FILE':
      return { kind, file: val('FILE'), find: val('FIND') ?? read('FIND'), replace: val('REPLACE') ?? read('REPLACE') };
    case 'WRITE_FILE':
      return { kind, file: val('FILE'), content: read('CONTENT') };
    case 'DONE':
    case 'ANALYSIS':
      return { kind };
  }
}

export interface ExecutorResult {
  actions: ParsedAction[];
  changedFiles: string[];
  testResults: Array<{ command: string; passed: boolean; summary: string }>;
  summary: string;
}

const EXEC_SYSTEM = `You are LUICode executing an approved plan step inside a workspace.

First, write a brief natural-language explanation (1-3 sentences) of what you are about to do and why.
Then emit ACTION blocks (one per action) followed by ACTION: DONE.

--- commentary ---
<your explanation here>
--- end commentary ---

Available actions (one per block):
ACTION: READ_FILE
FILE: <path>

ACTION: SEARCH_CODE
QUERY: <text>

ACTION: WRITE_FILE
FILE: <path>
CONTENT:
<entire new file content>

ACTION: EDIT_FILE
FILE: <path>
FIND: <exact string to replace>
REPLACE: <replacement>

ACTION: RUN_COMMAND
COMMAND: <shell command>

ACTION: DONE

Rules:
- Make the smallest change that satisfies the current step.
- Must finish with ACTION: DONE.
- Do not introduce secrets or destroy files.`;

export class PlanExecutor {
  toolkit: Toolkit;
  private useLLM: boolean;
  private cachedProfile: ProjectProfile | null = null;
  private skipCurrentStep = false;

  constructor(
    private opts: {
      toolkit: Toolkit;
      router: ModelRouter | null;
      useLLM: boolean;
      control?: RunControl;
      runTests: (command: string) => Promise<TestResult>;
    }
  ) {
    this.toolkit = opts.toolkit;
    this.useLLM = opts.useLLM;
  }

  private get profileFor(): ProjectProfile {
    if (!this.cachedProfile) this.cachedProfile = inspectProject(this.toolkit.ws);
    return this.cachedProfile;
  }

  /**
   * Find similar files in the project to infer coding patterns
   */
  private findSimilarFiles(fileHint: string | null): string[] {
    const similarFiles: string[] = [];
    const allFiles = this.toolkit.ws.walkFiles();

    // If we have a file hint, look for files with similar names or in similar directories
    if (fileHint) {
      const hintLower = fileHint.toLowerCase();
      // Look for files with similar base names
      for (const file of allFiles) {
        const fileLower = file.toLowerCase();
        if (fileLower.includes(hintLower.split('.')[0]) ||
            hintLower.includes(fileLower.split('.')[0])) {
          similarFiles.push(file);
        }
      }
    }

    // Also look for common file patterns based on the hint
    if (!fileHint) return similarFiles;

    // Limit to most relevant files
    return similarFiles.slice(0, 5);
  }

  /**
   * Generate appropriate file content based on file path, feature description, and similar files
   */
  private generateFileContent(filePath: string, feature: string, similarFiles: string[]): string {
    const ext = filePath.split('.').pop();
    const fileName = filePath.split('/').pop()?.split('.')[0] || '';
    const featureLower = feature.toLowerCase();

    // Determine what type of file this might be based on name and path
    const isTest = filePath.includes('.test.') || filePath.includes('.spec.') ||
                   fileName.includes('test') || fileName.includes('spec');
    const isComponent = fileName.includes('Component') || filePath.includes('/components/');
    const isService = fileName.includes('Service') || filePath.includes('/services/');
    const isController = fileName.includes('Controller') || filePath.includes('/controllers/');
    const isRoute = fileName.includes('Route') || filePath.includes('/routes/');
    const isModel = fileName.includes('Model') || filePath.includes('/models/');
    const isUtil = fileName.includes('Util') || fileName.includes('Helper') ||
                  filePath.includes('/utils/') || filePath.includes('/helpers/');
    const isConfig = fileName.includes('Config') || filePath.includes('/config/');
    const isMiddleware = fileName.includes('Middleware') || filePath.includes('/middleware/');
    const isRouteHandler = fileName.includes('Handler') || filePath.includes('/handlers/');

    // Generate content based on file type and language
    switch (this.profileFor.language) {
      case 'TypeScript':
        return this.generateTypeScriptContent(filePath, fileName, feature, isTest, isComponent, isService, isController, isRoute, isModel, isUtil, isConfig, isMiddleware, isRouteHandler, similarFiles);
      case 'JavaScript':
        return this.generateJavaScriptContent(filePath, fileName, feature, isTest, isComponent, isService, isController, isRoute, isModel, isUtil, isConfig, isMiddleware, isRouteHandler, similarFiles);
      case 'Python':
        return this.generatePythonContent(filePath, fileName, feature, isTest, isComponent, isService, isController, isRoute, isModel, isUtil, isConfig, isMiddleware, isRouteHandler, similarFiles);
      default:
        // Fallback to basic template
        return this.generateBasicContent(filePath, fileName, feature, ext);
    }
  }

  /**
   * Generate TypeScript file content
   */
  private generateTypeScriptContent(filePath: string, fileName: string, feature: string,
                                  isTest: boolean, isComponent: boolean, isService: boolean,
                                  isController: boolean, isRoute: boolean, isModel: boolean,
                                  isUtil: boolean, isConfig: boolean, isMiddleware: boolean,
                                  isRouteHandler: boolean, similarFiles: string[]): string {
    // If it's a test file, generate appropriate test content
    if (isTest) {
      const testTarget = fileName.replace(/\.(test|spec)/, '');
      return `import { ${testTarget} } from './${testTarget}';\n\n` +
             `describe('${testTarget}', () => {\n` +
             `  it('should be created', () => {\n` +
             `    expect(${testTarget}).toBeDefined();\n` +
             `  });\n` +
             `});\n`;
    }

    // Generate based on file type
    if (isComponent) {
      return `import React from 'react';\n\n` +
             `const ${fileName}: React.FC = () => {\n` +
             `  return (\n` +
             `    <div>\n` +
             `      <h1>${fileName}</h1>\n` +
             `    </div>\n` +
             `  );\n` +
             `};\n\n` +
             `export default ${fileName};\n`;
    }

    if (isService) {
      return `export class ${fileName} {\n` +
             `  constructor() {}\n\n` +
             `  // TODO: Implement service methods based on: ${feature}\n` +
             `}\n\n` +
             `export default ${fileName};\n`;
    }

    if (isController) {
      return `import { Request, Response } from 'express';\n\n` +
             `export class ${fileName}Controller {\n` +
             `  // TODO: Implement controller methods based on: ${feature}\n` +
             `}\n\n` +
             `export default ${fileName}Controller;\n`;
    }

    if (isModel) {
      return `export interface ${fileName} {\n` +
             `  // TODO: Define model properties based on: ${feature}\n` +
             `}\n\n` +
             `export default ${fileName};\n`;
    }

    if (isRoute) {
      return `import { Router } from 'express';\n` +
             `const router = Router();\n\n` +
             `// TODO: Define routes based on: ${feature}\n\n` +
             `export default router;\n`;
    }

    if (isUtil || isHelper) {
      return `// Utility functions for: ${feature}\n\n` +
             `export const ${fileName} = {\n` +
             `  // TODO: Implement utility functions\n` +
             `};\n\n` +
             `export default ${fileName};\n`;
    }

    if (isConfig) {
      return `// Configuration for: ${feature}\n\n` +
             `export const ${fileName} = {\n` +
             `  // TODO: Add configuration properties\n` +
             `};\n\n` +
             `export default ${fileName};\n`;
    }

    if (isMiddleware) {
      return `export const ${fileName} = (req: Request, res: Response, next: NextFunction) => {\n` +
             `  // TODO: Implement middleware logic based on: ${feature}\n` +
             `  next();\n` +
             `};\n\n` +
             `export default ${fileName};\n`;
    }

    if (isRouteHandler) {
      return `export const ${fileName} = async (req: Request, res: Response) => {\n` +
             `  // TODO: Implement route handler based on: ${feature}\n` +
             `  res.status(200).json({ message: '${fileName}' });\n` +
             `};\n\n` +
             `export default ${fileName};\n`;
    }

    // Default class or function based on feature
    if (feature.includes('class') || feature.includes('Class')) {
      const className = fileName.charAt(0).toUpperCase() + fileName.slice(1);
      return `export class ${className} {\n` +
             `  constructor() {}\n\n` +
             `  // TODO: Implement class based on: ${feature}\n` +
             `}\n\n` +
             `export default ${className};\n`;
    }

    // Default to a function or constant
    return `// ${filePath} - Generated for: ${feature}\n\n` +
           `export const ${fileName} = '';\n\n` +
           `export default ${fileName};\n`;
  }

  /**
   * Generate JavaScript file content
   */
  private generateJavaScriptContent(filePath: string, fileName: string, feature: string,
                                  isTest: boolean, isComponent: boolean, isService: boolean,
                                  isController: boolean, isRoute: boolean, isModel: boolean,
                                  isUtil: boolean, isConfig: boolean, isMiddleware: boolean,
                                  isRouteHandler: boolean, similarFiles: string[]): string {
    // Similar to TypeScript but without types
    if (isTest) {
      const testTarget = fileName.replace(/\.(test|spec)/, '');
      return `const { ${testTarget} } = require('./${testTarget}');\n\n` +
             `describe('${testTarget}', () => {\n` +
             `  it('should be created', () => {\n` +
             `    expect(${testTarget}).toBeDefined();\n` +
             `  });\n` +
             `});\n`;
    }

    if (isComponent) {
      return `const React = require('react');\n\n` +
             `const ${fileName} = () => {\n` +
             `  return (\n` +
             `    <div>\n` +
             `    <h1>${fileName}</h1>\n` +
             `    </div>\n` +
             `  );\n` +
             `};\n\n` +
             `module.exports = ${fileName};\n`;
    }

    if (isService) {
      return `class ${fileName} {\n` +
             `  constructor() {}\n\n` +
             `  // TODO: Implement service methods based on: ${feature}\n` +
             `}\n\n` +
             `module.exports = ${fileName};\n`;
    }

    if (isController) {
      return `const ${fileName}Controller = {\n` +
             `  // TODO: Implement controller methods based on: ${feature}\n` +
             `};\n\n` +
             `module.exports = ${fileName}Controller;\n`;
    }

    if (isModel) {
      return `// ${fileName} model - TODO: Define based on: ${feature}\n\n` +
             `module.exports = ${fileName};\n`;
    }

    if (isRoute) {
      return `const express = require('express');\n` +
             `const router = express.Router();\n\n` +
             `// TODO: Define routes based on: ${feature}\n\n` +
             `module.exports = router;\n`;
    }

    if (isUtil || isHelper) {
      return `// Utility functions for: ${feature}\n\n` +
             `const ${fileName} = {\n` +
             `  // TODO: Implement utility functions\n` +
             `};\n\n` +
             `module.exports = ${fileName};\n`;
    }

    if (isConfig) {
      return `// Configuration for: ${feature}\n\n` +
             `const ${fileName} = {\n` +
             `  // TODO: Add configuration properties\n` +
             `};\n\n` +
             `module.exports = ${fileName};\n`;
    }

    if (isMiddleware) {
      return `const ${fileName} = (req, res, next) => {\n` +
             `  // TODO: Implement middleware logic based on: ${feature}\n` +
             `  next();\n` +
             `};\n\n` +
             `module.exports = ${fileName};\n`;
    }

    if (isRouteHandler) {
      return `const ${fileName} = async (req: Request, res: Response) => {\n` +
             `  // TODO: Implement route handler based on: ${feature}\n` +
             `  res.status(200).json({ message: '${fileName}' });\n` +
             `};\n\n` +
             `module.exports = ${fileName};\n`;
    }

    // Default to a function or object
    return `// ${filePath} - Generated for: ${feature}\n\n` +
           `const ${fileName} = '';\n\n` +
           `module.exports = ${fileName};\n`;
  }

  /**
   * Generate Python file content
   */
  private generatePythonContent(filePath: string, fileName: string, feature: string,
                              isTest: boolean, isComponent: boolean, isService: boolean,
                              isController: boolean, isRoute: boolean, isModel: boolean,
                              isUtil: boolean, isConfig: boolean, isMiddleware: boolean,
                              isRouteHandler: boolean, similarFiles: string[]): string {
    if (isTest) {
      const testTarget = fileName.replace(/\.(test|spec)/, '');
      return `import unittest\n` +
             `from ${testTarget} import ${testTarget.capitalize()}\n\n` +
             `class Test${testTarget.capitalize()}(unittest.TestCase):\n` +
             `    def test_creation(self):\n` +
             `        self.assertIsNotNone(${testTarget.capitalize()}())\n\n` +
             `if __name__ == '__main__':\n` +
             `    unittest.main()\n`;
    }

    if (isComponent) {
      return `# ${fileName} component\n` +
             `def ${fileName}():\n` +
             `    \"\"\"Component for: ${feature}\"\"\"\n` +
             `    pass\n\n` +
             `if __name__ == '__main__':\n` +
             `    ${fileName}()\n`;
    }

    if (isService) {
      return `class ${fileName.capitalize()}:\n` +
             `    \"\"\"Service for: ${feature}\"\"\"\n\n` +
             `    def __init__(self):\n` +
             `        pass\n\n` +
             `    // TODO: Implement service methods based on: ${feature}\n\n` +
             `if __name__ == '__main__':\n` +
             `    ${fileName.capitalize()}()\n`;
    }

    if (isController) {
      return `class ${fileName}Controller:\n` +
             `    \"\"\"Controller for: ${feature}\"\"\"\n\n` +
             `    def __init__(self):\n` +
             `        pass\n\n` +
             `    // TODO: Implement controller methods based on: ${feature}\n\n` +
             `if __name__ == '__main__':\n` +
             `    controller = ${fileName}Controller()\n`;
    }

    if (isModel) {
      return `class ${fileName}:\n` +
             `    \"\"\"Model for: ${feature}\"\"\"\n\n` +
             `    def __init__(self):\n` +
             `        pass\n\n` +
             `    // TODO: Define model attributes based on: ${feature}\n\n` +
             `if __name__ == '__main__':\n` +
             `    model = ${fileName}()\n`;
    }

    if (isRoute) {
      return `# Routes for: ${feature}\n` +
             `# TODO: Implement routes based on: ${feature}\n\n` +
             `if __name__ == '__main__':\n` +
             `    print(\"Routes module\")\n`;
    }

    if (isUtil || isHelper) {
      return `\"\"\"Utility functions for: ${feature}\"\"\"\n\n` +
             `# TODO: Implement utility functions\n\n` +
             `if __name__ == '__main__':\n` +
             `    print(\"Utilities module\")\n`;
    }

    if (isConfig) {
      return `\"\"\"Configuration for: ${feature}\"\"\"\n\n` +
             `# TODO: Add configuration properties\n\n` +
             `if __name__ == '__main__':\n` +
             `    print(\"Configuration module\")\n`;
    }

    if (isMiddleware) {
      return `def ${fileName}(req, res, next):\n` +
             `    \"\"\"Middleware for: ${feature}\"\"\"\n` +
             `    # TODO: Implement middleware logic\n` +
             `    next()\n\n` +
             `if __name__ == '__main__':\n` +
             `    print(\"Middleware function\")\n`;
    }

    if (isRouteHandler) {
      return `async def ${fileName}(req, res):\n` +
             `    \"\"\"Route handler for: ${feature}\"\"\"\n` +
             `    # TODO: Implement route handler logic\n` +
             `    return {\"message\": \"${fileName}\"}\n\n` +
             `if __name__ == '__main__':\n` +
             `    print(\"Route handler\")\n`;
    }

    // Default to a class or function
    if (feature.includes('class') || feature.includes('Class')) {
      return `class ${fileName.capitalize()}:\n` +
             `    \"\"\"${fileName} class for: ${feature}\"\"\"\n\n` +
             `    def __init__(self):\n` +
             `        pass\n\n` +
             `    // TODO: Implement class based on: ${feature}\n\n` +
             `if __name__ == '__main__':\n` +
             `    obj = ${fileName.capitalize()}()\n`;
    }

    // Default function
    return `def ${fileName}():\n` +
           `    \"\"\"Function for: ${feature}\"\"\"\n` +
           `    # TODO: Implement function logic\n` +
           `    return \"${fileName} ready\"\n\n` +
           `if __name__ == '__main__':\n` +
           `    result = ${fileName}()\n` +
           `    print(result)\n`;
  }

  /**
   * Generate basic file content for unsupported languages
   */
  private generateBasicContent(filePath: string, fileName: string, feature: string, ext: string): string {
    return `# ${filePath}\n` +
           `# Generated for: ${feature}\n\n` +
           `# TODO: Implement functionality based on: ${feature}\n`;
  }

  /**
   * Generate a default action when no specific pattern matches
   */
  private generateDefaultAction(feature: string, currentStep: string, hasTests: boolean): string {
    // If it mentions testing but we don't have specific tests
    if (/test|verify/i.test(currentStep) && !hasTests) {
      return `ACTION: RUN_COMMAND\nCOMMAND: echo "No specific test command defined"\n\nACTION: DONE`;
    }

    // If it mentions building
    if (/build/i.test(currentStep)) {
      return `ACTION: RUN_COMMAND\nCOMMAND: echo "No build step defined"\n\nACTION: DONE`;
    }

    // Default to doing nothing
    return `ACTION: DONE`;
  }

  async execute(plan: Plan, env: PlanEnvironment, maxIterations: number): Promise<ExecutorResult> {
    const actions: ParsedAction[] = [];
    const changedFiles: string[] = [];
    const testResults: TestResult[] = [];
    const control = this.opts.control;

    for (const step of plan.steps) {
      await control?.sync().catch(() => undefined);
      if (step.status === 'skipped') continue;
      if (control?.takeSkip()) {
        step.status = 'skipped';
        this.toolkit.opts.emit({ type: 'plan', timestamp: Date.now(), plan, step });
        continue;
      }
      // Retry support: re-attempt the step up to two extra times when the
      // user asks (R / /retry) while the step is in flight.
      let attempts = 0;
      this.skipCurrentStep = false;
      do {
        attempts++;
        if (attempts > 1) step.status = 'pending';
        step.status = 'running';
        this.toolkit.opts.emit({ type: 'plan', timestamp: Date.now(), plan, step });
        await this.runStep(plan, step.title, actions, changedFiles, testResults, maxIterations, env);
        if (this.skipCurrentStep) {
          step.status = 'skipped';
          break;
        }
        step.status = 'done';
        this.toolkit.opts.emit({ type: 'plan', timestamp: Date.now(), plan, step });
        const retry = (control?.retryRequested || false) && control?.takeRetry();
        if (retry) step.status = 'pending';
      } while (step.status === 'pending' && attempts < 3);
      if (step.status === 'pending') step.status = 'done';
    }

    const testCmds = plan.tests.length ? plan.tests : env.tests;
    for (const cmd of testCmds) {
      const result = await this.opts.runTests(cmd);
      testResults.push(result);
      this.toolkit.opts.emit({ type: 'test', timestamp: Date.now(), test: result });
    }

    const summary = `${changedFiles.length} file(s) changed, ${testResults.filter((t) => t.passed).length}/${testResults.length} test runs passed`;
    return { actions, changedFiles, testResults, summary };
  }

  private async runStep(
    plan: Plan,
    stepTitle: string,
    actions: ParsedAction[],
    changedFiles: string[],
    testResults: TestResult[] ,
    maxIterations: number,
    env: PlanEnvironment
  ): Promise<void> {
    let guard = 0;
    const maxActionsPerStep = Math.max(6, Math.floor(maxIterations));
    const planIntro = `PLAN TASK: ${plan.task}\nFILES_TO_CREATE:\n${plan.filesToCreate.join('\n') || '(none)'}\nFILES_TO_MODIFY:\n${plan.filesToModify.join('\n') || '(none)'}\nTESTS:\n${env.tests.join('\n') || '(none)'}\nCURRENT STEP: ${stepTitle}\nANALYSIS: ${plan.analysis}`;

    while (guard < maxActionsPerStep) {
      guard++;
      if (this.opts.control) {
        try {
          await this.opts.control.sync();
        } catch {
          return; // cancelled
        }
        if (this.opts.control.skipRequested) {
          this.opts.control.takeSkip();
          this.skipCurrentStep = true;
          return;
        }
      }
      const reply = this.useLLM ? await this.llmNextAction(planIntro, actions) : this.heuristicNextAction(planIntro);
      const parsed = parseActions(reply);
      if (!parsed.length) break;
      for (const act of parsed) {
        if (act.kind === 'DONE') return;
        if (act.kind === 'ANALYSIS') continue;
        const out = await this.executeAction(act, changedFiles, plan);
        actions.push({ ...act, content: undefined });
        void out;
        if (act.kind === 'RUN_COMMAND') {
          const res = extractTestSummary(String(out ?? ''));
          testResults.push({ command: act.command ?? '', passed: res.passed, summary: res.summary, output: String(out ?? '') });
          this.toolkit.opts.emit({ type: 'test', timestamp: Date.now(), test: testResults[testResults.length - 1] });
        }
      }
    }
  }

  private async llmNextAction(planIntro: string, actions: ParsedAction[]): Promise<string> {
    // Extract current step to see if it's about creating/modifying a file
    const currentStepMatch = planIntro.match(/CURRENT STEP: (.+)/);
    const currentStep = currentStepMatch ? currentStepMatch[1] : '';
    const stepLower = currentStep.toLowerCase();

    // Check if step involves file creation or modification
    const isFileCreationModification = /\b(create|add|write|modify|edit)\b/.test(stepLower) &&
                                      /\b(file|class|function|component|service|controller|route|middleware|util|helper|config|test|spec|interface|type|enum|constant)\b/.test(stepLower);

    if (isFileCreationModification && this.opts.router) {
      // Extract file hint from step
      const fileMatch = currentStep.match(/(?:create|add|write|modify|edit).*?(?:file|class|function|component|service|controller|route|middleware|util|helper|config|test|spec|interface|type|enum|constant|constant)\s+([^\s\n]+)/i);
      const fileHint = fileMatch ? fileMatch[1] : null;

      // Determine file path (similar to heuristicNextAction)
      let filePath = '';
      if (fileHint) {
        filePath = fileHint.replace(/[\\\/*?:"<>|]/g, '');
        const extByLang: Record<string, string> = {
          TypeScript: '.ts',
          JavaScript: '.js',
          Python: '.py',
          Go: '.go',
          Rust: '.rs',
          Java: '.java',
          Ruby: '.rb',
          PHP: '.php'
        };
        const ext = extByLang[this.profileFor.language];
        if (ext && !filePath.endsWith(ext)) {
          filePath = filePath + ext;
        }
        if (!filePath.includes('/') && !filePath.startsWith('./') && !filePath.startsWith('../')) {
          filePath = `src/${filePath}`;
        }
      } else {
        const safe = currentStep.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'feature';
        const extByLang: Record<string, string> = {
          TypeScript: '.ts',
          JavaScript: '.js',
          Python: '.py',
          Go: '.go',
          Rust: '.rs',
          Java: '.java',
          Ruby: '.rb',
          PHP: '.php'
        };
        const ext = extByLang[this.profileFor.language] || '';
        filePath = `src/${safe}${ext}`;
      }

      // Use GeneratorAgent to generate the file content
      try {
        const generatorAgent = new GeneratorAgent({
          router: this.opts.router!,
          toolkit: this.toolkit,
          maxSteps: 4, // Fewer steps for file generation
          maxTokens: 800, // Limit tokens per LLM call
          maxObservationChars: 2000
        });

        const request = `Create or modify the file at ${filePath} to implement: ${currentStep}`;
        const result = await generatorAgent.runAgentTask(request);

        // Check if we got structured multi-file output
        let fileOperations: { action: 'create' | 'modify' | 'delete'; path: string; content?: string }[] = [];
        if (result.answer) {
          try {
            const parsed = JSON.parse(result.answer);
            if (parsed && parsed.operations && Array.isArray(parsed.operations)) {
              fileOperations = parsed.operations;
            }
          } catch {
            // Not JSON, try to extract from text
            const jsonMatch = result.answer.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              try {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed && parsed.operations && Array.isArray(parsed.operations)) {
                  fileOperations = parsed.operations;
                }
              } catch {}
            }
          }
        }

        // If we have file operations, convert to ACTION blocks
        if (fileOperations.length > 0) {
          const actionBlocks: string[] = [];
          for (const op of fileOperations) {
            if (op.action === 'create' || op.action === 'modify') {
              if (typeof op.content === 'string') {
                actionBlocks.push(`ACTION: WRITE_FILE\nFILE: ${op.path}\nCONTENT:\n${op.content}\n`);
              }
            }
            // Note: We don't handle delete in this context for safety
          }

          if (actionBlocks.length > 0) {
            // Add ACTION: DONE at the end
            actionBlocks.push('ACTION: DONE');
            return actionBlocks.join('\n');
          }
        }
        // If GeneratorAgent didn't produce usable file operations, fall back to original LLM approach
      } catch (err) {
        // If GeneratorAgent fails, fall back to original LLM approach
        console.error('GeneratorAgent failed in llmNextAction:', err);
      }
    }

    // Fall back to original LLM approach with token limits
    const history: ModelMessage[] = [
      { role: 'system', content: EXEC_SYSTEM },
      { role: 'user', content: planIntro + '\n\nProject tree:\n' + this.toolkit.ws.tree('.', 3) }
    ];
    const lastFew = actions.slice(-4);
    history.push({ role: 'user', content: `Recent actions performed:\n${lastFew.map((a) => `${a.kind} ${a.file ?? a.command ?? a.query ?? ''}`).join('\n') || '(none)'}\n\nReturn the next ACTION block now.` });
    try {
      const reply = await this.opts.router!.complete('coder', history, {
        signal: this.opts.control?.signal,
        maxTokens: 1000 // Add token limit to prevent excessive output
      });
      const { commentary, body } = extractCommentary(reply.content);
      if (commentary) {
        this.toolkit.opts.emit({ type: 'comment', timestamp: Date.now(), text: commentary });
      }
      return body;
    } catch {
      this.useLLM = false;
      return this.heuristicNextAction(planIntro);
    }
  }

  private heuristicNextAction(planIntro: string): string {
    const feature = planIntro.match(/TASK:\s*(.+)/)?.[1] ?? 'feature';
    const currentStep = planIntro.match(/CURRENT STEP: (.+)/)?.[1] ?? '';
    const testsBlock = planIntro.match(/TESTS:\n([\s\S]*?)(?=\nCURRENT STEP:|$)/)?.[1]?.trim() ?? '';
    const hasTests = Boolean(testsBlock && testsBlock !== '(none)');
    const step = currentStep.toLowerCase();

    // Extract file path if mentioned in step
    const fileMatch = currentStep.match(/(?:create|add|write|modify|edit).*?(?:file|class|function|component|service|controller|route|middleware|util|helper|config|test|spec|interface|type|enum|constant|constant|constant)\s+([^\s\n]+)/i);
    const fileHint = fileMatch ? fileMatch[1] : null;

    // Look for existing similar files to infer patterns
    const similarFiles = this.findSimilarFiles(fileHint || feature);

    if (/\bcreate\b|\bimplement\b|\badd\b|\bwrite\b/.test(step)) {
      const extByLang: Record<string, string> = {
        TypeScript: '.ts',
        JavaScript: '.js',
        Python: '.py',
        Go: '.go',
        Rust: '.rs',
        Java: '.java',
        Ruby: '.rb',
        PHP: '.php'
      };
      const ext = extByLang[this.profileFor.language];
      if (!ext) return 'ACTION: DONE';

      // Determine file path
      let filePath = '';
      if (fileHint) {
        // Clean up the file hint
        filePath = fileHint.replace(/[\\\/*?:"<>|]/g, '');
        // Ensure it has the right extension
        if (!filePath.endsWith(ext)) {
          filePath = filePath + ext;
        }
        // Ensure it's in src/ if not already in a path
        if (!filePath.includes('/') && !filePath.startsWith('./') && !filePath.startsWith('../')) {
          filePath = `src/${filePath}`;
        }
      } else {
        const safe = feature.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'feature';
        filePath = `src/${safe}${ext}`;
      }

      // Generate content based on file name and existing patterns
      const content = this.generateFileContent(filePath, feature, similarFiles);

      // Check if file already exists to decide between CREATE and EDIT
      const fileExists = this.toolkit.ws.absoluteExists(this.toolkit.ws.resolveSafe(filePath) as string);
      const action = fileExists ? 'EDIT_FILE' : 'WRITE_FILE';

      let actionBlock = `ACTION: ${action}\nFILE: ${filePath}\n`;
      if (action === 'EDIT_FILE') {
        // For edit, we need to provide FIND and REPLACE
        // Simple approach: replace the entire file content
        actionBlock += `FIND: *\nREPLACE:\n${content}\n`;
      } else {
        actionBlock += `CONTENT:\n${content}\n`;
      }

      return actionBlock + 'ACTION: DONE\n';
    }

    if (/test|verify/i.test(step)) {
      if (hasTests) {
        const cmd = testsBlock.split('\n').map((l) => l.replace(/^\s*(?:\d+[.)]\s*|[•\-+]\s*)/, '').trim()).find((l) => l) ?? 'npm test';
        return `ACTION: RUN_COMMAND\nCOMMAND: ${cmd}\n\nACTION: DONE`;
      }
      return 'ACTION: DONE';
    }

    if (/build/i.test(step)) {
      return 'ACTION: DONE';
    }

    // Default fallback - try to analyze what might be needed
    return this.generateDefaultAction(feature, currentStep, hasTests);
  }

  private async executeAction(act: ParsedAction, changedFiles: string[], plan: Plan): Promise<string> {
    switch (act.kind) {
      case 'READ_FILE': {
        const call = await this.toolkit.runTool('read_file', { path: act.file });
        return call.output ?? call.error ?? '';
      }
      case 'SEARCH_CODE': {
        const call = await this.toolkit.runTool('search_code', { query: act.query });
        return call.output ?? call.error ?? '';
      }
      case 'RUN_COMMAND': {
        const rec = await this.toolkit.runCommandTool(act.command ?? '');
        return `EXIT_CODE: ${rec.code}\n${rec.stdout}\n${rec.stderr}`;
      }
      case 'EDIT_FILE': {
        const call = await this.toolkit.runTool('edit_file', { path: act.file, find: act.find, replace: act.replace });
        if (call.status === 'ok' && act.file) {
          changedFiles.push(act.file);
          this.recordChange(act.file, 'modify');
        }
        return call.output ?? call.error ?? '';
      }
      case 'WRITE_FILE': {
        const wasNew = !(this.toolkit.ws.resolveSafe(act.file as string)
          ? this.toolkit.ws.absoluteExists(this.toolkit.ws.resolveSafe(act.file as string) as string)
          : false);
        const call = await this.toolkit.runTool('write_file', { path: act.file, content: act.content });
        if (call.status === 'ok' && act.file) {
          if (!changedFiles.includes(act.file)) changedFiles.push(act.file);
          this.recordChange(act.file, wasNew ? 'create' : 'modify');
        }
        return call.output ?? call.error ?? '';
      }
      default:
        return '';
    }
  }

  private recordChange(file: string, action: 'create' | 'modify'): void {
    this.toolkit.opts.emit({ type: 'file', timestamp: Date.now(), file: { path: file, action } });
  }

  analyzeFailure(output: string): string {
    const c = classifyError(output);
    return `${c.message}${c.file ? ` (${c.file})` : ''}`;
  }
}

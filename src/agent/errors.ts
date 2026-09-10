export type ErrorKind =
  | 'syntax'
  | 'type'
  | 'dependency'
  | 'runtime'
  | 'test'
  | 'build'
  | 'config'
  | 'unknown';

export interface ClassifiedError {
  kind: ErrorKind;
  file?: string;
  message: string;
  original: string;
}

const PATTERNS: Array<{ kind: ErrorKind; rx: RegExp; label: string }> = [
  { kind: 'type', rx: /error TS\d{4}|TS\d{4}:|Type [\"']|not assignable to type|Property '.*' does not exist/i, label: 'TypeScript type error' },
  { kind: 'syntax', rx: /SyntaxError|Unexpected token|Unexpected end of input|Parse error|Cannot find module.*expected|Unexpected identifier/i, label: 'Syntax error' },
  { kind: 'dependency', rx: /Cannot find module|Module not found|ERR_MODULE_NOT_FOUND|npm ERR! code E[A-Z]+|error: package */i, label: 'Missing dependency/module' },
  { kind: 'config', rx: /EMISSINGCONFIG|Invalid configuration|Unexpected key|Configuration error|tsconfig.*error/i, label: 'Configuration error' },
  { kind: 'runtime', rx: /TypeError:|ReferenceError:|RangeError:|Unhandled rejection|Cannot read (properties|proper) of|is not a function|is not defined/i, label: 'Runtime error' },
  { kind: 'build', rx: /Build failed|error during build|Module build failed|compil.* failed|Exited with 1/i, label: 'Build failure' },
  { kind: 'test', rx: /FAIL\s|✕|×|expected .* to|AssertionError|Test Suites:\s*\d+ failed|tests? (failed|passed)/i, label: 'Test failure' }
];

const FILE_LOC = /\b([\w./\\-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|c|cpp|h|cs|vue|svelte|css|scss|json|yaml|yml))\b/i;

export function classifyError(output: string): ClassifiedError {
  const file = output.match(FILE_LOC)?.[1];
  const body = output.trim();
  for (const p of PATTERNS) {
    if (p.rx.test(body)) {
      return {
        kind: p.kind,
        file,
        message: `${p.label}${file ? ` in ${file}` : ''}`,
        original: output
      };
    }
  }
  return { kind: 'unknown', file, message: 'Unclassified failure', original: output };
}

export function extractTestSummary(output: string): { passed: boolean; summary: string } {
  const suites = output.match(/Tests:\s+[\s\S]*?\d+ (passed|failed)[^\n]*/);
  const passLine =
    output.match(/Tests:\s+\d+ passed[^\n]*/i) ||
    output.match(/\d+ tests?\s+passed[^\n]*/i) ||
    output.match(/All (tests?|checks) passed/);
  const failLine = output.match(/Tests:\s+\d+ failed[^\n]*/i) || output.match(/\d+ failed[^\n]*/i);
  if (passLine) return { passed: true, summary: passLine[0] };
  if (failLine) return { passed: false, summary: failLine[0] };
  if (suites) return { passed: !/failed/i.test(suites[0]), summary: suites[0].trim() };
  const hasExit = output.match(/EXIT_CODE:\s*(\d+)/);
  if (hasExit && hasExit[1] !== '0') return { passed: false, summary: `exit code ${hasExit[1]}` };
  return { passed: /(passing|passed|ok\b|✓)/i.test(output), summary: 'tests completed' };
}
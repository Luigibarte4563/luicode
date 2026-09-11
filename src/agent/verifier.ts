import * as ts from 'typescript';
import { TaskType } from './taskRouter';

// ---------------------------------------------------------------------------
// Output verifier — PHASE 4 of the Universal Generator Agent v2.
// Cheap, deterministic checks for machine-verifiable output (JSON, code).
// Free-form prose skips verification.
// ---------------------------------------------------------------------------

export interface VerificationResult {
  passed: boolean;
  feedback: string;
  format?: 'json' | 'code' | 'prose';
}

/** Strip a single triple-backtick fenced block (with optional language hint). */
function stripFences(text: string): string {
  const m = text.match(/^```[^\n]*\n?([\s\S]*?)\n?```/);
  return m ? m[1].trim() : text.trim();
}

function looksLikeCode(text: string): boolean {
  return /[{};()=>=]/.test(text) && (/\b(function|class|const|let|var|def |from |import |export)\b/.test(text) || text.split('\n').length > 2);
}

/** Report error-category syntax diagnostics from tsc's transpile. */
function syntaxDiagnostics(code: string): string[] {
  const out = ts.transpileModule(code, {
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      allowJs: true
    }
  });
  const diags = out.diagnostics ?? [];
  return diags
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

/**
 * Verify generated output against the claimed format.
 * - structured_data (or JSON-looking output): parse as JSON.
 * - code: syntax-check JavaScript/TypeScript via the TypeScript compiler.
 * - anything else: no machine check is possible — declare passed (the caller
 *   should rely on tool execution inside the loop for real validation).
 */
export function verifyOutput(output: string, opts?: { taskType?: TaskType }): VerificationResult {
  const trimmed = stripFences(output);
  const isJSONish = trimmed.startsWith('{') || trimmed.startsWith('[');

  if (opts?.taskType === 'structured_data' || isJSONish) {
    try {
      JSON.parse(trimmed);
      return { passed: true, feedback: 'JSON is valid.', format: 'json' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { passed: false, feedback: `Invalid JSON: ${msg}`, format: 'json' };
    }
  }

  if (looksLikeCode(trimmed)) {
    const errors = syntaxDiagnostics(trimmed);
    if (errors.length) {
      return {
        passed: false,
        feedback: `Syntax errors in output:\n${errors.map((e) => `- ${e}`).join('\n')}`,
        format: 'code'
      };
    }
    return {
      passed: true,
      feedback: 'No syntax errors detected (semantic/runtime correctness must be validated by executing the code).',
      format: 'code'
    };
  }

  return { passed: true, feedback: 'No machine-verifiable format detected.', format: 'prose' };
}
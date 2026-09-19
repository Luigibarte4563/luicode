import * as path from 'path';
import * as ts from 'typescript';
import { Tool, ToolRuntime } from './registry';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface AstEditArgs {
  path: string;
  targetNode: string; // e.g. 'MyClass.myMethod' or 'myFunction'
  newContent: string; // replacement source for that node
}

export interface AstEditResult {
  ok: boolean;
  message: string;
  topLevelNames?: string[]; // populated when targetNode is not found
}

export interface LineEditArgs {
  path: string;
  startLine: number; // 1-based inclusive
  endLine: number;   // 1-based inclusive
  newContent: string; // replacement text (may contain \n)
}

// ---------------------------------------------------------------------------
// Strategy interface (pluggable per-language parser)
// ---------------------------------------------------------------------------

interface EditStrategy {
  /** Try to locate targetNode in source and replace it with newContent.
   *  Returns the modified source string on success, or an AstEditResult error. */
  edit(source: string, targetNode: string, newContent: string, filePath: string): Promise<string | AstEditResult>;
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript strategy
// ---------------------------------------------------------------------------

/**
 * Collect up to 20 top-level declaration names from a TS source file.
 */
function collectTopLevelNames(sourceFile: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const stmt of sourceFile.statements) {
    if (names.length >= 20) break;
    if (
      ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt) ||
      ts.isModuleDeclaration(stmt)
    ) {
      if (stmt.name) names.push(stmt.name.getText(sourceFile));
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.push(decl.name.getText(sourceFile));
        if (names.length >= 20) break;
      }
    }
  }
  return names;
}

/**
 * Walk top-level declarations and class members to find the node whose
 * qualified name matches `targetNode` (e.g. 'MyClass.myMethod' or 'myFn').
 */
function findTargetNode(
  sourceFile: ts.SourceFile,
  targetNode: string
): ts.Node | undefined {
  const parts = targetNode.split('.');

  if (parts.length === 1) {
    // Top-level lookup
    const name = parts[0];
    for (const stmt of sourceFile.statements) {
      if (
        (ts.isFunctionDeclaration(stmt) ||
          ts.isClassDeclaration(stmt) ||
          ts.isInterfaceDeclaration(stmt) ||
          ts.isTypeAliasDeclaration(stmt) ||
          ts.isEnumDeclaration(stmt) ||
          ts.isModuleDeclaration(stmt)) &&
        stmt.name?.getText(sourceFile) === name
      ) {
        return stmt;
      }
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.getText(sourceFile) === name) {
            // Return the whole VariableStatement for clean replacement
            return stmt;
          }
        }
      }
    }
    return undefined;
  }

  if (parts.length === 2) {
    const [className, memberName] = parts;
    // Find the class first
    for (const stmt of sourceFile.statements) {
      if (ts.isClassDeclaration(stmt) && stmt.name?.getText(sourceFile) === className) {
        for (const member of stmt.members) {
          const memberNameText =
            member.name && ts.isIdentifier(member.name)
              ? member.name.getText(sourceFile)
              : undefined;
          if (memberNameText === memberName) {
            return member;
          }
        }
      }
    }
    return undefined;
  }

  return undefined;
}

class TypeScriptEditStrategy implements EditStrategy {
  async edit(
    source: string,
    targetNode: string,
    newContent: string,
    filePath: string
  ): Promise<string | AstEditResult> {
    const fileName = path.basename(filePath);
    const sourceFile = ts.createSourceFile(
      fileName,
      source,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true
    );

    const node = findTargetNode(sourceFile, targetNode);

    if (!node) {
      const topLevelNames = collectTopLevelNames(sourceFile);
      return {
        ok: false,
        message: `ERROR: targetNode "${targetNode}" not found in ${filePath}. Top-level names: ${topLevelNames.join(', ')}`,
        topLevelNames
      };
    }

    const start = node.getFullStart();
    const end = node.getEnd();
    const modified = source.slice(0, start) + newContent + source.slice(end);

    // Re-parse and check for errors
    const reparsed = ts.createSourceFile(
      fileName,
      modified,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true
    );

    // Check parse diagnostics via internal API (available when setParentNodes=true)
    const diags: readonly ts.Diagnostic[] =
      (reparsed as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];

    const errors = diags.filter((d) => d.category === ts.DiagnosticCategory.Error);
    if (errors.length > 0) {
      const msg = errors
        .map((e) => ts.flattenDiagnosticMessageText(e.messageText, '\n'))
        .join('; ');
      return {
        ok: false,
        message: `ERROR: syntax validation failed after edit: ${msg}`
      };
    }

    return modified;
  }
}

// ---------------------------------------------------------------------------
// Python strategy (indentation-aware regex)
// ---------------------------------------------------------------------------

class PythonEditStrategy implements EditStrategy {
  async edit(
    source: string,
    targetNode: string,
    newContent: string,
    filePath: string
  ): Promise<string | AstEditResult> {
    // Support 'ClassName.methodName' and 'funcName'
    const parts = targetNode.split('.');
    const simpleName = parts[parts.length - 1];

    // Regex: match def <name>(...) or class <name>[(:]
    const defPattern = new RegExp(
      `^([ \\t]*)(def ${escapeRegex(simpleName)}\\s*\\(|class ${escapeRegex(simpleName)}\\s*[:(])`,
      'm'
    );
    const match = defPattern.exec(source);
    if (!match) {
      return {
        ok: false,
        message: `ERROR: targetNode "${targetNode}" not found in ${filePath} (Python).`
      };
    }

    const blockStart = match.index;
    const indentLevel = match[1].length;

    // Collect lines of this block: the declaration line + subsequent lines with
    // deeper indentation (or blank lines that are within the block).
    const fromBlock = source.slice(blockStart);
    const lines = fromBlock.split('\n');

    let blockLineCount = 1; // Include the def/class line itself
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') {
        blockLineCount++;
        continue;
      }
      // Count leading spaces/tabs
      const leading = line.match(/^[ \t]*/)?.[0].length ?? 0;
      if (leading > indentLevel) {
        blockLineCount++;
      } else {
        break;
      }
    }

    const blockEnd = blockStart + lines.slice(0, blockLineCount).join('\n').length;
    const modified = source.slice(0, blockStart) + newContent + source.slice(blockEnd);
    return modified;
  }
}

// ---------------------------------------------------------------------------
// JSON strategy (dot-path pointer)
// ---------------------------------------------------------------------------

class JsonEditStrategy implements EditStrategy {
  async edit(
    source: string,
    targetNode: string,
    newContent: string,
    filePath: string
  ): Promise<string | AstEditResult> {
    let obj: unknown;
    try {
      obj = JSON.parse(source);
    } catch (e) {
      return { ok: false, message: `ERROR: could not parse JSON in ${filePath}: ${String(e)}` };
    }

    const pathParts = targetNode.split('.');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cursor: any = obj;
    for (let i = 0; i < pathParts.length - 1; i++) {
      if (cursor == null || typeof cursor !== 'object') {
        return { ok: false, message: `ERROR: path "${targetNode}" not found in ${filePath}` };
      }
      cursor = cursor[pathParts[i]];
    }

    const lastKey = pathParts[pathParts.length - 1];
    if (cursor == null || typeof cursor !== 'object' || !(lastKey in cursor)) {
      return { ok: false, message: `ERROR: path "${targetNode}" not found in ${filePath}` };
    }

    // Parse newContent as JSON value; if it fails, use as raw string
    let value: unknown;
    try {
      value = JSON.parse(newContent);
    } catch {
      value = newContent;
    }

    cursor[lastKey] = value;
    return JSON.stringify(obj, null, 2);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getStrategy(filePath: string): EditStrategy | null {
  const ext = path.extname(filePath).toLowerCase();
  if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) return new TypeScriptEditStrategy();
  if (ext === '.py') return new PythonEditStrategy();
  if (ext === '.json') return new JsonEditStrategy();
  return null;
}

/**
 * Analyze a TypeScript/JavaScript file to find exported declarations.
 * Returns information about what the file exports (functions, classes, interfaces, etc.).
 */
export interface AnalyzeExportsArgs {
  path: string; // relative to workspace root
}

export interface AnalyzeExportsResult {
  ok: boolean;
  message?: string;
  exports?: Array<{
    name: string;
    type: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable' | 'module';
    isExported: boolean;
    line: number;
    character: number;
  }>;
}

/**
 * Collect exported declarations from a TS source file.
 */
function collectExportedDeclarations(sourceFile: ts.SourceFile): Array<{
  name: string;
  type: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable' | 'module';
  isExported: boolean;
  line: number;
  character: number;
}> {
  const exports: Array<{
    name: string;
    type: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable' | 'module';
    isExported: boolean;
    line: number;
    character: number;
  }> = [];

  const visitNode = (node: ts.Node) => {
    // Check for each declaration type and export status
    if (ts.isFunctionDeclaration(node) && node.name) {
      const isExported = !!(
        node.modifiers &&
        node.modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      );
      const pos = node.getStart(sourceFile);
      const lineChar = sourceFile.getLineAndCharacterOfPosition(pos);
      exports.push({
        name: node.name.getText(sourceFile),
        type: 'function',
        isExported,
        line: lineChar.line + 1,
        character: lineChar.character + 1
      });
    } else if (ts.isClassDeclaration(node) && node.name) {
      const isExported = !!(
        node.modifiers &&
        node.modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      );
      const pos = node.getStart(sourceFile);
      const lineChar = sourceFile.getLineAndCharacterOfPosition(pos);
      exports.push({
        name: node.name.getText(sourceFile),
        type: 'class',
        isExported,
        line: lineChar.line + 1,
        character: lineChar.character + 1
      });
    } else if (ts.isInterfaceDeclaration(node) && node.name) {
      const isExported = !!(
        node.modifiers &&
        node.modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      );
      const pos = node.getStart(sourceFile);
      const lineChar = sourceFile.getLineAndCharacterOfPosition(pos);
      exports.push({
        name: node.name.getText(sourceFile),
        type: 'interface',
        isExported,
        line: lineChar.line + 1,
        character: lineChar.character + 1
      });
    } else if (ts.isTypeAliasDeclaration(node) && node.name) {
      const isExported = !!(
        node.modifiers &&
        node.modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      );
      const pos = node.getStart(sourceFile);
      const lineChar = sourceFile.getLineAndCharacterOfPosition(pos);
      exports.push({
        name: node.name.getText(sourceFile),
        type: 'type',
        isExported,
        line: lineChar.line + 1,
        character: lineChar.character + 1
      });
    } else if (ts.isEnumDeclaration(node) && node.name) {
      const isExported = !!(
        node.modifiers &&
        node.modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      );
      const pos = node.getStart(sourceFile);
      const lineChar = sourceFile.getLineAndCharacterOfPosition(pos);
      exports.push({
        name: node.name.getText(sourceFile),
        type: 'enum',
        isExported,
        line: lineChar.line + 1,
        character: lineChar.character + 1
      });
    } else if (ts.isVariableStatement(node)) {
      // Check if it's a const/let/var declaration that might be exported
      const isExported = !!(
        node.modifiers &&
        node.modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      );
      const pos = node.getStart(sourceFile);
      const lineChar = sourceFile.getLineAndCharacterOfPosition(pos);
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          exports.push({
            name: decl.name.getText(sourceFile),
            type: 'variable',
            isExported,
            line: lineChar.line + 1,
            character: lineChar.character + 1
          });
        }
      }
    } else if (ts.isModuleDeclaration(node) && node.name) {
      const isExported = !!(
        node.modifiers &&
        node.modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      );
      const pos = node.getStart(sourceFile);
      const lineChar = sourceFile.getLineAndCharacterOfPosition(pos);
      exports.push({
        name: node.name.getText(sourceFile),
        type: 'module',
        isExported,
        line: lineChar.line + 1,
        character: lineChar.character + 1
      });
    }

    // Recursively visit children
    ts.forEachChild(node, visitNode);
  };

  // Visit all top-level nodes
  for (const stmt of sourceFile.statements) {
    visitNode(stmt);
  }

  // Also check for export statements like "export { foo }" or "export * from './foo'"
  // This is a simplified check - a full implementation would parse export declarations
  for (const stmt of sourceFile.statements) {
    if (ts.isExportDeclaration(stmt)) {
      // Handle export declarations
      if (stmt.exportClause) {
        // Named exports: export { foo, bar }
        if (ts.isNamedExports(stmt.exportClause)) {
          for (const element of stmt.exportClause.elements) {
            const name = element.propertyName ?? element.name;
            if (ts.isIdentifier(name)) {
              const pos = name.getStart(sourceFile);
              const lineChar = sourceFile.getLineAndCharacterOfPosition(pos);
              exports.push({
                name: name.getText(sourceFile),
                type: 'variable', // We don't know the exact type without looking up the original
                isExported: true,
                line: lineChar.line + 1,
                character: lineChar.character + 1
              });
            }
          }
        }
      }
      // TODO: Handle export * from './foo' and export default
    } else if (ts.isExportAssignment(stmt)) {
      // export default ...
      // For simplicity, we'll skip detailed handling of export default
    }
  }

  return exports;
}

export async function analyzeExports(args: AnalyzeExportsArgs, rt: ToolRuntime): Promise<string> {
  const rel = args.path;

  let source: string;
  try {
    source = rt.ws.readFile(rel);
  } catch (e) {
    return `ERROR: could not read file ${rel}: ${String(e)}`;
  }

  const strategy = getStrategy(rel);
  if (!strategy) {
    return `ERROR: unsupported file type for analyze_exports: ${path.extname(rel)}`;
  }

  // For TypeScript/JavaScript files, we can do proper AST analysis
  if (['.ts', '.tsx', '.js', '.jsx'].includes(path.extname(rel).toLowerCase())) {
    const fileName = path.basename(rel);
    const sourceFile = ts.createSourceFile(
      fileName,
      source,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true
    );

    const exports = collectExportedDeclarations(sourceFile);

    return JSON.stringify({
      ok: true,
      exports: exports
    }, null, 2);
  }

  // For other file types, fall back to basic info
  return JSON.stringify({
    ok: true,
    exports: [],
    message: `Export analysis not implemented for ${path.extname(rel)} files. Only TypeScript/JavaScript is supported for detailed analysis.`
  }, null, 2);
}

// ---------------------------------------------------------------------------
// astEdit
// ---------------------------------------------------------------------------

export async function astEdit(args: AstEditArgs, rt: ToolRuntime): Promise<string> {
  const rel = args.path;
  const { targetNode, newContent } = args;

  let source: string;
  try {
    source = rt.ws.readFile(rel);
  } catch (e) {
    return `ERROR: could not read file ${rel}: ${String(e)}`;
  }

  const strategy = getStrategy(rel);
  if (!strategy) {
    return `ERROR: unsupported file type for ast_edit: ${path.extname(rel)}`;
  }

  const result = await strategy.edit(source, targetNode, newContent, rel);

  if (typeof result !== 'string') {
    // AstEditResult error
    return result.message;
  }

  const perm = rt.permission.canWrite(rel);
  if (!perm.allowed) return `DENIED: ${perm.reason}`;

  rt.ws.writeFile(rel, result);
  return `EDITED ${targetNode} in ${rel}`;
}

// ---------------------------------------------------------------------------
// lineEdit
// ---------------------------------------------------------------------------

export async function lineEdit(args: LineEditArgs, rt: ToolRuntime): Promise<string> {
  const { path: rel, startLine, endLine, newContent } = args;

  let source: string;
  try {
    source = rt.ws.readFile(rel);
  } catch (e) {
    return `ERROR: could not read file ${rel}: ${String(e)}`;
  }

  const lines = source.split('\n');

  // Validate bounds
  if (startLine < 1) {
    return `ERROR: startLine (${startLine}) must be >= 1`;
  }
  if (endLine > lines.length) {
    return `ERROR: endLine (${endLine}) exceeds file line count (${lines.length})`;
  }
  if (startLine > endLine) {
    return `ERROR: startLine (${startLine}) must be <= endLine (${endLine})`;
  }

  const perm = rt.permission.canWrite(rel);
  if (!perm.allowed) return `DENIED: ${perm.reason}`;

  const replacementLines = newContent.split('\n');
  // splice is 0-based; startLine/endLine are 1-based inclusive
  lines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines);
  const updated = lines.join('\n');

  rt.ws.writeFile(rel, updated);
  return `EDITED lines ${startLine}-${endLine} in ${rel} (replaced with ${replacementLines.length} line(s))`;
}

// ---------------------------------------------------------------------------
// Tool registrations
// ---------------------------------------------------------------------------

export const astTools: Tool[] = [
  {
    name: 'ast_edit',
    description:
      'Edit a specific function, class, or method in a source file by AST node name. ' +
      'Supports TypeScript, JavaScript, Python, and JSON. ' +
      'Args: { path, targetNode (e.g. "MyClass.myMethod" or "myFunction"), newContent }',
    async run(args, rt) {
      const p = String(args.path ?? args.file ?? '');
      const targetNode = String(args.targetNode ?? args.target ?? '');
      const newContent = String(args.newContent ?? args.content ?? '');
      if (!p) return 'ERROR: missing "path" argument';
      if (!targetNode) return 'ERROR: missing "targetNode" argument';
      return astEdit({ path: p, targetNode, newContent }, rt);
    }
  },
  {
    name: 'line_edit',
    description:
      'Replace a range of lines in a file (1-based, inclusive). ' +
      'Args: { path, startLine, endLine, newContent }',
    async run(args, rt) {
      const p = String(args.path ?? args.file ?? '');
      const startLine = Number(args.startLine ?? args.start ?? 0);
      const endLine = Number(args.endLine ?? args.end ?? 0);
      const newContent = String(args.newContent ?? args.content ?? '');
      if (!p) return 'ERROR: missing "path" argument';
      if (!startLine) return 'ERROR: missing or invalid "startLine" argument';
      if (!endLine) return 'ERROR: missing or invalid "endLine" argument';
      return lineEdit({ path: p, startLine, endLine, newContent }, rt);
    }
  },
  {
    name: 'analyze_exports',
    description:
      'Analyze a TypeScript/JavaScript file to find exported declarations (functions, classes, interfaces, etc.). ' +
      'Args: { path }',
    async run(args, rt) {
      const p = String(args.path ?? args.file ?? '');
      if (!p) return 'ERROR: missing "path" argument';
      return analyzeExports({ path: p }, rt);
    }
  }
];

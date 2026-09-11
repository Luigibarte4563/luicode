import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import * as fc from 'fast-check';
import { astEdit, lineEdit } from '../src/tools/astTools';
import { ToolRuntime } from '../src/tools/registry';
import { Workspace } from '../src/workspace/Workspace';
import { PermissionManager } from '../src/security/permission';
import { CommandGuard } from '../src/security/commandGuard';
import { DEFAULT_CONFIG } from '../src/config/schema';
import { LuicodeConfig } from '../src/types';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'luicode-ast-test-'));
}

function makeRuntime(dir: string): ToolRuntime {
  const ws = new Workspace(dir);
  const permission = new PermissionManager(ws, 'full');
  return {
    ws,
    permission,
    config: structuredClone(DEFAULT_CONFIG) as LuicodeConfig,
    guard: new CommandGuard({ whitelist: [], workspaceRoot: dir }),
    runShell: async (command: string) => ({ command, stdout: '', stderr: '', code: 0, durationMs: 0 })
  };
}

// ---------------------------------------------------------------------------
// Property 7 — Line Edit Round Trip  (Validates: Req 5.5)
// ---------------------------------------------------------------------------

describe('Property 7 — Line Edit Round Trip', () => {
  it('total line count equals N - (endLine - startLine + 1) + newContent line count', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ maxLength: 40 }), { minLength: 2, maxLength: 100 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        fc.string({ maxLength: 120 }),
        async (lines, s, e, nc) => {
          fc.pre(s <= e && e <= lines.length);
          const dir = tmpdir();
          fs.writeFileSync(path.join(dir, 'data.txt'), lines.join('\n'), 'utf8');
          const rt = makeRuntime(dir);

          const out = await lineEdit({ path: 'data.txt', startLine: s, endLine: e, newContent: nc }, rt);
          expect(out).not.toContain('ERROR');

          const updated = fs.readFileSync(path.join(dir, 'data.txt'), 'utf8');
          const expected = lines.length - (e - s + 1) + nc.split('\n').length;
          expect(updated.split('\n').length).toBe(expected);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8 — AST Edit Parse Preservation  (Validates: Req 5.9)
// ---------------------------------------------------------------------------

const TS_FN_NAMES = ['alpha', 'beta', 'gamma', 'delta', 'compute', 'resolve', 'render', 'build'];
const TS_CLASS_NAMES = ['WidgetService', 'HandlerFactory', 'MeshBuilder', 'ConfigStore', 'RepoAccess'];

function tsFile(fnName: string, clsName: string, propVal: string): string {
  return [
    '/* auto-generated sample */',
    '',
    'export interface Settings {',
    '  enabled: boolean;',
    '  label: string;',
    '}',
    '',
    `export function ${fnName}(a: number, b: number): number {`,
    '  return a + b;',
    '}',
    '',
    `export class ${clsName} {`,
    `  readonly version: string = "${propVal}";`,
    '',
    '  constructor(private readonly label: string = "default") {}',
    '',
    '  compute(x: number): number {',
    '    return x + 1;',
    '  }',
    '}',
    '',
    `export default ${clsName};`,
    ''
  ].join('\n');
}

function fnDeclaration(fnName: string): string {
  return [
    `export function ${fnName}(a: number, b: number, scale: number = 1): number {`,
    '  const base = a * 100 + b;',
    '  return Math.round(base / scale);',
    '}',
    ''
  ].join('\n');
}

const validTsFileArbitrary = fc
  .record({
    fnName: fc.constantFrom(...TS_FN_NAMES),
    newFn: fc.constantFrom(...TS_FN_NAMES),
    clsName: fc.constantFrom(...TS_CLASS_NAMES),
    propVal: fc.string({ maxLength: 8 }).map((s) => s.replace(/[^a-zA-Z0-9]/g, 'x'))
  })
  .map((o) => ({
    ...o,
    src: tsFile(o.fnName, o.clsName, o.propVal),
    newContent: fnDeclaration(o.newFn)
  }));

describe('Property 8 — AST Edit Parse Preservation', () => {
  it('ast_edit on a valid TS file with valid newContent yields zero error diagnostics', async () => {
    await fc.assert(
      fc.asyncProperty(validTsFileArbitrary, async (spec) => {
        const { src, fnName, newContent } = spec;
        const dir = tmpdir();
        fs.writeFileSync(path.join(dir, 'sample.ts'), src, 'utf8');
        const rt = makeRuntime(dir);

        const out = await astEdit({ path: 'sample.ts', targetNode: fnName, newContent }, rt);
        expect(out).not.toContain('ERROR');

        const updated = fs.readFileSync(path.join(dir, 'sample.ts'), 'utf8');
        const sf = ts.createSourceFile('sample.ts', updated, ts.ScriptTarget.Latest, true);
        const diags =
          (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
        expect(diags.filter((d) => d.category === ts.DiagnosticCategory.Error)).toHaveLength(0);
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9 — Line Edit Out-of-Bounds Rejection  (Validates: Req 5.6, 5.7)
// ---------------------------------------------------------------------------

describe('Property 9 — Line Edit Out-of-Bounds Rejection', () => {
  it('invalid bounds return an error and leave the file byte-for-byte identical', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ maxLength: 40 }), { minLength: 1, maxLength: 30 }),
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 1, max: 60 }),
        fc.string({ maxLength: 100 }),
        async (lines, s, e, nc) => {
          fc.pre(s > lines.length || e > lines.length || s > e);
          const dir = tmpdir();
          const content = lines.join('\n');
          fs.writeFileSync(path.join(dir, 'data.txt'), content, 'utf8');
          const rt = makeRuntime(dir);

          const out = await lineEdit({ path: 'data.txt', startLine: s, endLine: e, newContent: nc }, rt);
          expect(out).toContain('ERROR');
          expect(fs.readFileSync(path.join(dir, 'data.txt'), 'utf8')).toBe(content);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Unit tests — astTools  (Req 5.1–5.7)
// ---------------------------------------------------------------------------

describe('astEdit', () => {
  const SAMPLE = [
    'import * as fs from "fs";',
    '',
    'export interface Shape {',
    '  name: string;',
    '}',
    '',
    'export function renderShape(s: Shape): string {',
    '  return `shape:${s.name}`;',
    '}',
    '',
    'export class Renderer {',
    '  private count = 0;',
    '',
    '  greet(name: string): string {',
    '    return "hi " + name;',
    '  }',
    '',
    '  render(shape: Shape): string {',
    '    this.count++;',
    '    return renderShape(shape);',
    '  }',
    '}',
    ''
  ].join('\n');

  it('locates and replaces a TypeScript method by qualified name', async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'shapes.ts'), SAMPLE, 'utf8');
    const rt = makeRuntime(dir);

    const out = await astEdit(
      {
        path: 'shapes.ts',
        targetNode: 'Renderer.greet',
        newContent: `greet(name: string): string { return "hello " + name; }`
      },
      rt
    );
    expect(out).toBe('EDITED Renderer.greet in shapes.ts');
    const updated = fs.readFileSync(path.join(dir, 'shapes.ts'), 'utf8');
    expect(updated).toContain('return "hello " + name;');
    expect(updated).not.toContain('return "hi " + name;');
  });

  it('returns an error listing top-level names when the target is not found', async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'shapes.ts'), SAMPLE, 'utf8');
    const rt = makeRuntime(dir);

    const out = await astEdit(
      { path: 'shapes.ts', targetNode: 'DoesNotExist.render', newContent: 'x' },
      rt
    );
    expect(out).toContain('ERROR');
    expect(out).toContain('not found');
    expect(out).toContain('renderShape');
    expect(out).toContain('Renderer');
  });

  it('rolls back (does not write) when newContent introduces a syntax error', async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'shapes.ts'), SAMPLE, 'utf8');
    const rt = makeRuntime(dir);
    const before = fs.readFileSync(path.join(dir, 'shapes.ts'), 'utf8');

    const out = await astEdit(
      {
        path: 'shapes.ts',
        targetNode: 'Renderer.greet',
        newContent: `greet(name: string { return "unterminated";` // syntax error
      },
      rt
    );
    expect(out).toContain('ERROR');
    expect(fs.readFileSync(path.join(dir, 'shapes.ts'), 'utf8')).toBe(before);
  });
});

describe('lineEdit', () => {
  const SAMPLE = ['line 1', 'line 2', 'line 3', 'line 4'].join('\n');

  it('replaces a valid 1-based inclusive range', async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'f.txt'), SAMPLE, 'utf8');
    const rt = makeRuntime(dir);

    const out = await lineEdit({ path: 'f.txt', startLine: 2, endLine: 3, newContent: 'A\nB\nC' }, rt);
    expect(out).not.toContain('ERROR');
    expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe('line 1\nA\nB\nC\nline 4');
  });

  it('rejects startLine > endLine without modifying the file', async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'f.txt'), SAMPLE, 'utf8');
    const rt = makeRuntime(dir);
    const before = fs.readFileSync(path.join(dir, 'f.txt'), 'utf8');

    const out = await lineEdit({ path: 'f.txt', startLine: 3, endLine: 2, newContent: 'x' }, rt);
    expect(out).toContain('ERROR');
    expect(out).toContain('startLine');
    expect(out).toContain('endLine');
    expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe(before);
  });

  it('rejects an out-of-bounds start line without modifying the file', async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'f.txt'), SAMPLE, 'utf8');
    const rt = makeRuntime(dir);
    const before = fs.readFileSync(path.join(dir, 'f.txt'), 'utf8');

    const out = await lineEdit({ path: 'f.txt', startLine: 0, endLine: 2, newContent: 'x' }, rt);
    expect(out).toContain('ERROR');
    expect(out).toContain('startLine');
    expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe(before);
  });

  it('rejects an out-of-bounds end line without modifying the file', async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'f.txt'), SAMPLE, 'utf8');
    const rt = makeRuntime(dir);
    const before = fs.readFileSync(path.join(dir, 'f.txt'), 'utf8');

    const out = await lineEdit({ path: 'f.txt', startLine: 3, endLine: 99, newContent: 'x' }, rt);
    expect(out).toContain('ERROR');
    expect(out).toContain('endLine');
    expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe(before);
  });
});
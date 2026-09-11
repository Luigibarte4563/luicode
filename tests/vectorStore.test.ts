import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as fc from 'fast-check';
import { VectorStore, cosineSimilarity } from '../src/rag/VectorStore';
import { RAGRetriever } from '../src/rag/RAGRetriever';
import { VectorStoreConfig } from '../src/types';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'luicode-rag-test-'));
}

const CFG: VectorStoreConfig = {
  embeddingModel: 'local/minilm',
  chunkSize: 64,
  chunkOverlap: 8,
  maxFileSizeBytes: 1048576,
  topK: 5,
  indexDir: '.luicode/vector-index',
  extensions: ['.ts', '.js', '.py'],
  excludeDirs: ['node_modules', '.git', '.luicode']
};

const SAMPLE_TS = `// auth helper
export interface User {
  id: number;
  email: string;
}
export function login(email: string, password: string): boolean {
  return email.includes('@') && password.length > 0;
}
export function logout(): void {
  console.log('bye');
}
`;

const SAMPLE_JS = `// api client
const API_KEY = 'secret';
async function fetchUser(id) {
  return { id, name: 'user' + id };
}
module.exports = { fetchUser };
`;

const SAMPLE_PY = `# runner
import os

def build_project(config):
    return config.get('name', 'app')

if __name__ == '__main__':
    print(build_project({}))
`;

const EXCL_NODE = 'zzzexcl_nodemodule';
const EXCL_GIT = 'zzzexcl_gitdir';
const EXCL_LUI = 'zzzexcl_luicode';
const EXCL_TXT = 'zzzexcl_textfile';

function writeWorkspace(root: string): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, '.luicode'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'auth.ts'), SAMPLE_TS);
  fs.writeFileSync(path.join(root, 'src', 'api.js'), SAMPLE_JS);
  fs.writeFileSync(path.join(root, 'src', 'runner.py'), SAMPLE_PY);
  fs.writeFileSync(path.join(root, 'node_modules', 'skip.js'), `// ${EXCL_NODE}\nexport const skip = 1;\n`);
  fs.writeFileSync(path.join(root, '.git', 'config'), `[core]\n  label = ${EXCL_GIT}\n`);
  fs.writeFileSync(path.join(root, '.luicode', 'config.yaml'), `marker: ${EXCL_LUI}\n`);
  fs.writeFileSync(path.join(root, 'notes.txt'), `${EXCL_TXT}\n`);
  // Oversized file — exceeds maxFileSizeBytes
  fs.writeFileSync(path.join(root, 'src', 'big.ts'), 'x'.repeat(CFG.maxFileSizeBytes + 1024));
}

// ---------------------------------------------------------------------------
// Property 1 — Semantic Search Idempotence  (Validates: Req 1.8)
// ---------------------------------------------------------------------------

describe('Property 1 — Semantic Search Idempotence', () => {
  let store: VectorStore;

  beforeAll(async () => {
    const dir = tmpdir();
    writeWorkspace(dir);
    store = new VectorStore(dir, CFG);
    await store.ensureIndexed();
  });

  it('query(q, 5) twice on unchanged index returns the same ordered results', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 200 }), async (query) => {
        const a = await store.query(query, 5);
        const b = await store.query(query, 5);
        const tuple = (r: { filePath: string; startLine: number; endLine: number; score: number }) =>
          [r.filePath, r.startLine, r.endLine, r.score];
        expect(a.map(tuple)).toEqual(b.map(tuple));
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2 — Semantic Search Score Bounds  (Validates: Req 1.3)
// ---------------------------------------------------------------------------

describe('Property 2 — Semantic Search Score Bounds', () => {
  let retriever: RAGRetriever;

  beforeAll(async () => {
    const dir = tmpdir();
    writeWorkspace(dir);
    const store = new VectorStore(dir, CFG);
    await store.ensureIndexed();
    retriever = new RAGRetriever({
      store,
      emit: () => undefined,
      searchCode: async (query, topK) => ({
        id: 'x',
        name: 'search_code',
        args: JSON.stringify({ query, topK }),
        status: 'ok',
        output: '',
        startedAt: Date.now(),
        endedAt: Date.now()
      })
    });
  });

  it('every result from retrieve() has score in [0.0, 1.0]', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 200 }), async (query) => {
        const ctx = await retriever.retrieve(query, 5);
        for (const r of ctx.results) {
          expect(r.score).toBeGreaterThanOrEqual(0.0);
          expect(r.score).toBeLessThanOrEqual(1.0);
        }
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3 — Semantic Search Result Count Bound  (Validates: Req 1.3, 1.7)
// ---------------------------------------------------------------------------

describe('Property 3 — Semantic Search Result Count Bound', () => {
  let store: VectorStore;

  beforeAll(async () => {
    const dir = tmpdir();
    writeWorkspace(dir);
    store = new VectorStore(dir, CFG);
    await store.ensureIndexed();
  });

  it('result count is <= topK for any topK in [1, 50]', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 50 }), fc.string({ maxLength: 200 }), async (topK, query) => {
        const results = await store.query(query, topK);
        expect(results.length).toBeLessThanOrEqual(topK);
        expect(results.length).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Unit tests — VectorStore  (Req 1.1, 1.2, 1.5)
// ---------------------------------------------------------------------------

describe('VectorStore unit tests', () => {
  it('cosine similarity of identical vectors is 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it('cosine similarity of orthogonal vectors is 0', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 10);
  });

  it('cosine similarity clamps raw negatives to 0', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(0);
  });

  it('cosine similarity with a zero vector is 0', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 1, 1])).toBe(0);
  });

  it('excludes node_modules/.git/.luicode, non-configured extensions, and oversized files', async () => {
    const dir = tmpdir();
    writeWorkspace(dir);
    const store = new VectorStore(dir, CFG);
    await store.ensureIndexed();

    // Included files are indexed
    expect((await store.query('login email', 10)).length).toBeGreaterThan(0);
    expect((await store.query('fetchUser api', 10)).map((r) => r.filePath).join(',')).toContain('api.js');
    expect((await store.query('build_project', 10)).map((r) => r.filePath).join(',')).toContain('runner.py');

    // Inspect the persisted index: no chunk may reference an excluded path
    const chunksMeta = JSON.parse(
      fs.readFileSync(path.join(dir, CFG.indexDir, 'chunks.json'), 'utf8')
    ) as Array<{ filePath: string; startLine: number; endLine: number }>;
    const paths = chunksMeta.map((c) => c.filePath.split(path.sep).join('/'));

    expect(paths).toContain('src/auth.ts');
    expect(paths).toContain('src/api.js');
    expect(paths).toContain('src/runner.py');
    expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.git/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.luicode/'))).toBe(false);
    expect(paths.some((p) => p.endsWith('.txt'))).toBe(false);
    expect(paths.some((p) => p.endsWith('big.ts'))).toBe(false);
  });

  it('incremental update only re-indexes stale/new files', async () => {
    const dir = tmpdir();
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    const store = new VectorStore(dir, CFG);
    const spy = jest.spyOn(store, 'indexFile');

    await store.ensureIndexed();
    const afterFirst = spy.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // No changes → no re-indexing
    await store.ensureIndexed();
    expect(spy.mock.calls.length).toBe(afterFirst);

    // Touch a.ts (bump mtime into the future) and add b.py
    fs.appendFileSync(path.join(dir, 'src', 'a.ts'), '\nexport const a2 = 2;\n');
    const aPath = path.join(dir, 'src', 'a.ts');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(aPath, future, future);
    fs.writeFileSync(path.join(dir, 'src', 'b.py'), 'def helper():\n    return 1\n');

    await store.ensureIndexed();
    const reIndexed = spy.mock.calls.slice(afterFirst).map((c) => String(c[0])).map((p) => p.split(path.sep).join('/')).sort();
    expect(reIndexed).toEqual(['src/a.ts', 'src/b.py']);

    // Stable again
    const beforeStable = spy.mock.calls.length;
    await store.ensureIndexed();
    expect(spy.mock.calls.length).toBe(beforeStable);
  });

  it('flush/load round-trip persists chunks, embeddings, and metadata', async () => {
    const dir = tmpdir();
    writeWorkspace(dir);
    const store = new VectorStore(dir, CFG);
    await store.ensureIndexed();

    const before = await store.query('login email user', 5);

    const indexDir = path.join(dir, CFG.indexDir);
    for (const f of ['chunks.json', 'embeddings.bin', 'meta.json']) {
      expect(fs.existsSync(path.join(indexDir, f))).toBe(true);
    }

    // Cold-start a second store from the persisted index
    const store2 = new VectorStore(dir, CFG);
    await store2.ensureIndexed();
    const after = await store2.query('login email user', 5);
    expect(after).toEqual(before);
  });
});
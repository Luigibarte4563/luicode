import { RAGRetriever, RAGContext } from '../src/rag/RAGRetriever';
import { EmbeddingUnavailableError, VectorStore, SemanticSearchResult } from '../src/rag/VectorStore';
import { AgentEvent, ToolCall } from '../src/types';

function okCall(output: string): ToolCall {
  return { id: 't1', name: 'search_code', args: '', status: 'ok', output, startedAt: 0, endedAt: 0 };
}

function fakeStore(queryImpl: jest.Mock | ((q: string, k?: number) => Promise<SemanticSearchResult[]>)): VectorStore {
  return { query: queryImpl } as unknown as VectorStore;
}

describe('RAGRetriever', () => {
  it('falls back to keyword search when the embedding backend is unavailable', async () => {
    const searchCode = jest.fn().mockResolvedValue(okCall('src/a.ts:3  export const x = 1\nsrc/b.ts:7  const y = 2'));
    const emit = jest.fn();
    const retriever = new RAGRetriever({
      store: fakeStore(jest.fn().mockRejectedValue(new EmbeddingUnavailableError('backend down'))),
      emit,
      searchCode
    });

    const ctx = await retriever.retrieve('some query', 5);

    expect(searchCode).toHaveBeenCalledTimes(1);
    expect(searchCode).toHaveBeenCalledWith('some query', 5);
    expect(ctx.source).toBe('keyword');
    expect(ctx.results).toHaveLength(2);
    expect(ctx.results[0].filePath).toBe('src/a.ts');
    expect(ctx.results[0].startLine).toBe(3);
    // Keyword hits carry score 1.0 (within [0, 1])
    expect(ctx.results[0].score).toBe(1.0);

    // A 'status' warning is emitted on fallback
    const statusEvents = emit.mock.calls.map((c) => c[0] as AgentEvent).filter((e) => e.type === 'status');
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);
    expect(statusEvents[0].text).toMatch(/falling back to keyword search/i);
  });

  it('emits a status warning when the vector search returns zero results', async () => {
    const emit = jest.fn();
    const searchCode = jest.fn();
    const retriever = new RAGRetriever({
      store: fakeStore(jest.fn().mockResolvedValue([])),
      emit,
      searchCode
    });

    const ctx = await retriever.retrieve('nothing matches this', 3);

    expect(ctx.source).toBe('vector');
    expect(ctx.results).toEqual([]);
    expect(searchCode).not.toHaveBeenCalled();
    const statusEvents = emit.mock.calls.map((c) => c[0] as AgentEvent).filter((e) => e.type === 'status');
    expect(statusEvents.some((e) => e.text && /no matches/i.test(e.text))).toBe(true);
  });

  it('formatForPrompt renders file path, line numbers, and relevance scores in a fenced block', () => {
    const retriever = new RAGRetriever({
      store: fakeStore(jest.fn()),
      emit: jest.fn(),
      searchCode: jest.fn()
    });
    const ctx: RAGContext = {
      source: 'vector',
      query: 'find login',
      results: [
        { filePath: 'src/auth.ts', startLine: 10, endLine: 12, text: 'export function login() {}', score: 0.87 }
      ]
    };

    const prompt = retriever.formatForPrompt(ctx);
    expect(prompt).toContain('```rag');
    expect(prompt).toContain('```');
    expect(prompt).toContain('src/auth.ts:10-12');
    expect(prompt).toContain('score 0.87');
    expect(prompt).toContain('source: vector');
    expect(prompt).toContain('export function login() {}');
  });

  it('formatForPrompt returns an empty string when there are no results', () => {
    const retriever = new RAGRetriever({
      store: fakeStore(jest.fn()),
      emit: jest.fn(),
      searchCode: jest.fn()
    });
    const ctx: RAGContext = { source: 'vector', query: 'x', results: [] };
    expect(retriever.formatForPrompt(ctx)).toBe('');
  });
});
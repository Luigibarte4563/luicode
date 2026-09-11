import { AgentEvent, ToolCall } from '../types';
import { EmbeddingUnavailableError, SemanticSearchResult, VectorStore } from './VectorStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RAGContext {
  /** Whether results came from the vector index or keyword fallback */
  source: 'vector' | 'keyword';
  query: string;
  results: SemanticSearchResult[];
}

export interface RAGRetrieverOptions {
  store: VectorStore;
  emit: (e: AgentEvent) => void;
  searchCode: (query: string, topK?: number) => Promise<ToolCall>;
}

// ---------------------------------------------------------------------------
// Keyword-hit parser (search_code output)
// ---------------------------------------------------------------------------

/**
 * Parse the output of the `search_code` tool into SemanticSearchResult rows.
 * Output lines have the form `file:line  text`; `NO_MATCHES` yields [].
 * Keyword hits carry score 1.0 (exact substring match) so scores stay in
 * [0.0, 1.0] on both the vector and fallback paths.
 */
function parseKeywordHits(output: string): SemanticSearchResult[] {
  const trimmed = output.trim();
  if (!trimmed || trimmed.startsWith('NO_MATCHES')) return [];

  const results: SemanticSearchResult[] = [];
  for (const line of trimmed.split('\n')) {
    const m = line.match(/^([^:\n]+):(\d+)\s+(.*)$/);
    if (m) {
      const lineNum = Number(m[2]);
      results.push({
        filePath: m[1],
        startLine: lineNum,
        endLine: lineNum,
        text: m[3],
        score: 1.0
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// RAGRetriever
// ---------------------------------------------------------------------------

/**
 * Retrieval front-end for the agent. Tries semantic search first and falls
 * back to keyword search via the `search_code` tool when the embedding
 * backend is unavailable. Emits 'status' warnings on fallback or zero results.
 */
export class RAGRetriever {
  constructor(private readonly opts: RAGRetrieverOptions) {}

  async retrieve(query: string, topK?: number): Promise<RAGContext> {
    try {
      const results = await this.opts.store.query(query, topK);
      if (results.length === 0) {
        this.opts.emit({
          type: 'status',
          timestamp: Date.now(),
          text: `Semantic search returned no matches for "${query}".`
        });
      }
      return { source: 'vector', query, results };
    } catch (err) {
      const isUnavailable = err instanceof EmbeddingUnavailableError;
      this.opts.emit({
        type: 'status',
        timestamp: Date.now(),
        text: isUnavailable
          ? 'Embedding model unavailable — falling back to keyword search.'
          : 'Semantic search failed — falling back to keyword search.'
      });

      const call = await this.opts.searchCode(query, topK);
      return { source: 'keyword', query, results: parseKeywordHits(call.output ?? '') };
    }
  }

  /**
   * Render a RAGContext as a markdown fenced block suitable for prompt
   * injection, showing file paths, line ranges, and relevance scores.
   * Returns an empty string when there are no results.
   */
  formatForPrompt(ctx: RAGContext): string {
    if (ctx.results.length === 0) return '';

    const blocks: string[] = [
      '```rag',
      `# Relevant code (source: ${ctx.source}) for: "${ctx.query}"`
    ];
    for (const r of ctx.results.slice(0, 10)) {
      blocks.push(`\n${r.filePath}:${r.startLine}-${r.endLine} (score ${r.score.toFixed(4)})`);
      blocks.push(r.text);
    }
    blocks.push('```');
    return blocks.join('\n');
  }
}
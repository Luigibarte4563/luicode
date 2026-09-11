import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { VectorStoreConfig } from '../types';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface VectorChunk {
  /** sha256(filePath + ':' + startLine) */
  id: string;
  /** workspace-relative path */
  filePath: string;
  /** 1-based */
  startLine: number;
  /** 1-based */
  endLine: number;
  /** raw chunk text */
  text: string;
  /** float32 vector (stored in-memory; persisted in embeddings.bin) */
  embedding: number[];
  /** Unix ms timestamp */
  indexedAt: number;
}

export interface VectorIndexMeta {
  /** schema version — currently 1 */
  version: number;
  createdAt: number;
  updatedAt: number;
  /** filePath → mtime ms */
  fileTimestamps: Record<string, number>;
}

export interface SemanticSearchResult {
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
  /** cosine similarity 0.0–1.0 */
  score: number;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown by VectorStore.query() when the embedding model API is explicitly
 * unavailable (e.g. network error). RAGRetriever catches this and falls back
 * to keyword search.
 */
export class EmbeddingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// Embedding helpers — deterministic TF-IDF-like placeholder
// ---------------------------------------------------------------------------

const VECTOR_DIM = 128;

/**
 * Produce a deterministic float32 vector from text without a real API call.
 * Uses a simple hash-seeded approach that gives consistent vectors for the
 * same input while keeping the placeholder self-contained (no external deps).
 *
 * The returned vector is L2-normalised so cosine similarity reduces to dot
 * product and results stay in [0, 1].
 */
function computeEmbedding(text: string): number[] {
  // Build a frequency map over "words" (split on non-alphanumeric)
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const freq: Record<string, number> = {};
  for (const w of words) {
    freq[w] = (freq[w] ?? 0) + 1;
  }

  // Deterministically map each unique word to a dimension bucket via sha256,
  // then accumulate weighted contributions.
  const vec = new Float32Array(VECTOR_DIM);
  for (const [w, count] of Object.entries(freq)) {
    const hash = crypto.createHash('sha256').update(w).digest();
    // Use the first 4 bytes as a dimension index (mod VECTOR_DIM)
    const dim = hash.readUInt32BE(0) % VECTOR_DIM;
    // Use the next 4 bytes for a sign/weight
    const weight = ((hash.readUInt32BE(4) / 0xffffffff) * 2 - 1);
    vec[dim] += weight * count;
  }

  // L2-normalise
  let norm = 0;
  for (let i = 0; i < VECTOR_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < VECTOR_DIM; i++) vec[i] /= norm;
  }

  return Array.from(vec);
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  const raw = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // Clamp to [0, 1] (embeddings can be negative, similarity can be negative)
  return Math.max(0, Math.min(1, raw));
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

interface RawChunk {
  text: string;
  startLine: number;
  endLine: number;
}

/**
 * Split file text into word-based chunks with overlap.
 * chunkSize / chunkOverlap are in "words" (whitespace-split tokens).
 */
function chunkText(text: string, chunkSize: number, chunkOverlap: number): RawChunk[] {
  const lines = text.split('\n');
  // Build a flat list of (word, lineIndex) pairs
  const wordLines: Array<{ word: string; line: number }> = [];
  for (let li = 0; li < lines.length; li++) {
    const tokens = lines[li].split(/\s+/).filter(Boolean);
    for (const word of tokens) {
      wordLines.push({ word, line: li });
    }
  }

  if (wordLines.length === 0) return [];

  const chunks: RawChunk[] = [];
  let start = 0;
  const step = Math.max(1, chunkSize - chunkOverlap);

  while (start < wordLines.length) {
    const end = Math.min(start + chunkSize, wordLines.length);
    const slice = wordLines.slice(start, end);

    const startLine = slice[0].line + 1; // 1-based
    const endLine = slice[slice.length - 1].line + 1; // 1-based

    chunks.push({
      text: slice.map(wl => wl.word).join(' '),
      startLine,
      endLine,
    });

    if (end >= wordLines.length) break;
    start += step;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Directory walker
// ---------------------------------------------------------------------------

function walkDir(dir: string, excludeDirs: string[], extensions: string[]): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (excludeDirs.includes(entry.name)) continue;
      const sub = walkDir(path.join(dir, entry.name), excludeDirs, extensions);
      results.push(...sub);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (extensions.includes(ext)) {
        results.push(path.join(dir, entry.name));
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Chunk-id helper
// ---------------------------------------------------------------------------

function chunkId(filePath: string, startLine: number): string {
  return crypto.createHash('sha256').update(`${filePath}:${startLine}`).digest('hex');
}

// ---------------------------------------------------------------------------
// VectorStore
// ---------------------------------------------------------------------------

export class VectorStore {
  private chunks: VectorChunk[] = [];
  private meta: VectorIndexMeta = {
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    fileTimestamps: {},
  };

  constructor(private wsRoot: string, private config: VectorStoreConfig) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Warm up the index. On cold-start walks the workspace; on subsequent calls
   * only re-embeds files whose mtime is newer than the stored timestamp.
   */
  async ensureIndexed(): Promise<void> {
    // Try to load an existing persisted index first
    await this.load();

    const allAbsPaths = walkDir(
      this.wsRoot,
      this.config.excludeDirs,
      this.config.extensions,
    );

    for (const absPath of allAbsPaths) {
      const relPath = path.relative(this.wsRoot, absPath);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(absPath);
      } catch {
        continue;
      }

      const mtime = stat.mtimeMs;
      const stored = this.meta.fileTimestamps[relPath];

      if (stored !== undefined && stored >= mtime) {
        // Up-to-date — skip
        continue;
      }

      if (stat.size > this.config.maxFileSizeBytes) {
        // Too large — skip (remove any stale entries)
        this.removeFile(relPath);
        continue;
      }

      await this.indexFile(relPath);
    }

    await this.flush();
  }

  /**
   * Index (or re-index) a single file. Called on file-watcher events and by
   * ensureIndexed() for stale/new files.
   */
  async indexFile(relPath: string): Promise<void> {
    const absPath = path.join(this.wsRoot, relPath);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      // File may have been deleted between the walk and now
      return;
    }

    if (stat.size > this.config.maxFileSizeBytes) {
      this.removeFile(relPath);
      return;
    }

    let content: string;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch {
      return;
    }

    // Remove existing chunks for this file
    this.chunks = this.chunks.filter(c => c.filePath !== relPath);

    const rawChunks = chunkText(content, this.config.chunkSize, this.config.chunkOverlap);
    const now = Date.now();

    for (const rc of rawChunks) {
      const embedding = computeEmbedding(rc.text);
      this.chunks.push({
        id: chunkId(relPath, rc.startLine),
        filePath: relPath,
        startLine: rc.startLine,
        endLine: rc.endLine,
        text: rc.text,
        embedding,
        indexedAt: now,
      });
    }

    this.meta.fileTimestamps[relPath] = stat.mtimeMs;
    this.meta.updatedAt = now;
  }

  /**
   * Remove index entries for a deleted file.
   */
  removeFile(relPath: string): void {
    this.chunks = this.chunks.filter(c => c.filePath !== relPath);
    delete this.meta.fileTimestamps[relPath];
    this.meta.updatedAt = Date.now();
  }

  /**
   * Query the index; returns up to topK results sorted by cosine similarity
   * descending. Scores are in [0.0, 1.0].
   */
  async query(text: string, topK?: number): Promise<SemanticSearchResult[]> {
    const k = Math.min(Math.max(1, topK ?? this.config.topK), 50);

    if (this.chunks.length === 0) return [];

    const queryVec = computeEmbedding(text);

    const scored = this.chunks.map(chunk => ({
      chunk,
      score: cosineSimilarity(queryVec, chunk.embedding),
    }));

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, k).map(({ chunk, score }) => ({
      filePath: chunk.filePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      text: chunk.text,
      score,
    }));
  }

  /**
   * Persist the index to:
   *   <wsRoot>/<indexDir>/chunks.json    — chunk metadata (no embedding)
   *   <wsRoot>/<indexDir>/embeddings.bin — packed float32 vectors
   *   <wsRoot>/<indexDir>/meta.json      — VectorIndexMeta
   */
  async flush(): Promise<void> {
    const indexDir = path.join(this.wsRoot, this.config.indexDir);
    fs.mkdirSync(indexDir, { recursive: true });

    // chunks.json — strip embeddings to keep file size manageable
    const chunksMeta = this.chunks.map(({ embedding: _omit, ...rest }) => rest);
    fs.writeFileSync(
      path.join(indexDir, 'chunks.json'),
      JSON.stringify(chunksMeta, null, 2),
      'utf8',
    );

    // embeddings.bin — packed float32, VECTOR_DIM floats per chunk
    const buf = Buffer.alloc(this.chunks.length * VECTOR_DIM * 4);
    for (let i = 0; i < this.chunks.length; i++) {
      const emb = this.chunks[i].embedding;
      for (let j = 0; j < VECTOR_DIM; j++) {
        buf.writeFloatLE(emb[j] ?? 0, (i * VECTOR_DIM + j) * 4);
      }
    }
    fs.writeFileSync(path.join(indexDir, 'embeddings.bin'), buf);

    // meta.json
    fs.writeFileSync(
      path.join(indexDir, 'meta.json'),
      JSON.stringify(this.meta, null, 2),
      'utf8',
    );
  }

  /**
   * Load a previously persisted index from disk. If any file is missing or
   * corrupt, starts fresh (no error thrown).
   */
  async load(): Promise<void> {
    const indexDir = path.join(this.wsRoot, this.config.indexDir);

    const chunksPath = path.join(indexDir, 'chunks.json');
    const embeddingsPath = path.join(indexDir, 'embeddings.bin');
    const metaPath = path.join(indexDir, 'meta.json');

    if (
      !fs.existsSync(chunksPath) ||
      !fs.existsSync(embeddingsPath) ||
      !fs.existsSync(metaPath)
    ) {
      // Cold start — no persisted index yet
      return;
    }

    try {
      // Load meta
      const metaRaw = fs.readFileSync(metaPath, 'utf8');
      this.meta = JSON.parse(metaRaw) as VectorIndexMeta;

      // Load chunk metadata (without embeddings)
      const chunksRaw = fs.readFileSync(chunksPath, 'utf8');
      type ChunkWithoutEmb = Omit<VectorChunk, 'embedding'>;
      const chunksMeta: ChunkWithoutEmb[] = JSON.parse(chunksRaw) as ChunkWithoutEmb[];

      // Load binary embeddings
      const embBuf = fs.readFileSync(embeddingsPath);
      const expectedBytes = chunksMeta.length * VECTOR_DIM * 4;
      if (embBuf.length !== expectedBytes) {
        // Mismatch — start fresh
        this.chunks = [];
        return;
      }

      this.chunks = chunksMeta.map((meta, i) => {
        const embedding: number[] = [];
        const base = i * VECTOR_DIM * 4;
        for (let j = 0; j < VECTOR_DIM; j++) {
          embedding.push(embBuf.readFloatLE(base + j * 4));
        }
        return { ...meta, embedding };
      });
    } catch {
      // Corrupt index — start fresh
      this.chunks = [];
      this.meta = {
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        fileTimestamps: {},
      };
    }
  }
}

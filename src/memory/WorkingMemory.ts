import * as fs from 'fs';
import * as path from 'path';
import { ModelRouterLike, ModelMessage } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemorySection = 'Plan' | 'Completed Steps' | 'Blockers' | 'Notes';

export const MEMORY_SECTIONS: MemorySection[] = ['Plan', 'Completed Steps', 'Blockers', 'Notes'];

export const DEFAULT_MEMORY_TEMPLATE =
  '## Plan\n\n## Completed Steps\n\n## Blockers\n\n## Notes\n';

export interface MemoryWriteResult {
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// WorkingMemory
// ---------------------------------------------------------------------------

/**
 * Manages a per-session markdown scratchpad file located at
 * `<baseDir>/memory/<sessionId>.md`.  Provides atomic section-level
 * read/write so the agent can maintain plan state, completed steps,
 * blockers, and notes across LLM calls within a session.
 */
export class WorkingMemory {
  /** Absolute path to the session memory file. */
  readonly filePath: string;

  constructor(
    private readonly sessionId: string,
    private readonly baseDir: string,
  ) {
    this.filePath = path.join(baseDir, 'memory', `${sessionId}.md`);
  }

  // -------------------------------------------------------------------------
  // init
  // -------------------------------------------------------------------------

  /**
   * Create the memory file with the default four-section structure if it does
   * not already exist.  Creates parent directories as needed.
   */
  async init(): Promise<void> {
    if (!fs.existsSync(this.filePath)) {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, DEFAULT_MEMORY_TEMPLATE, 'utf8');
    }
  }

  // -------------------------------------------------------------------------
  // read
  // -------------------------------------------------------------------------

  /**
   * Return the full contents of the memory file.
   * Recreates the file with the default structure if it is missing.
   */
  async read(): Promise<string> {
    if (!fs.existsSync(this.filePath)) {
      await this.init();
    }
    return fs.readFileSync(this.filePath, 'utf8');
  }

  // -------------------------------------------------------------------------
  // write
  // -------------------------------------------------------------------------

  /**
   * Replace the body of a named section.
   *
   * - Returns `{ ok: false, error }` when `section` is not one of the four
   *   defined names, without modifying the file.
   * - Returns `{ ok: false, error }` when the section heading cannot be found
   *   in the file.
   * - Returns `{ ok: true }` on success.
   */
  async write(section: MemorySection, content: string): Promise<MemoryWriteResult> {
    if (!MEMORY_SECTIONS.includes(section)) {
      return { ok: false, error: `Unknown section: ${section}` };
    }

    const raw = await this.read();
    const result = spliceSection(raw, section, content);

    if (!result.ok) {
      return result;
    }

    fs.writeFileSync(this.filePath, result.text!, 'utf8');
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // append
  // -------------------------------------------------------------------------

  /**
   * Append a single line to the body of a named section.
   * A trailing newline is added after the line if not already present.
   */
  async append(section: MemorySection, line: string): Promise<MemoryWriteResult> {
    if (!MEMORY_SECTIONS.includes(section)) {
      return { ok: false, error: `Unknown section: ${section}` };
    }

    const raw = await this.read();
    const existingBody = extractSectionBody(raw, section);

    if (existingBody === null) {
      return { ok: false, error: `Section not found in file: ${section}` };
    }

    // Ensure the new line ends with \n
    const newLine = line.endsWith('\n') ? line : line + '\n';

    // Append after existing body (which may be empty)
    const newBody = existingBody.length > 0
      ? existingBody + newLine
      : newLine;

    const result = spliceSection(raw, section, newBody);
    if (!result.ok) {
      return result;
    }

    fs.writeFileSync(this.filePath, result.text!, 'utf8');
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // readSection
  // -------------------------------------------------------------------------

  /**
   * Return only the body of the named section (text between the section
   * heading and the next `## ` heading, or end of file).
   * Returns an empty string if the section has no body.
   * Returns `{ ok: false }` style via throwing is NOT used — callers receive
   * an empty string for missing sections.
   */
  async readSection(section: MemorySection): Promise<string> {
    if (!MEMORY_SECTIONS.includes(section)) {
      return '';
    }

    const raw = await this.read();
    const body = extractSectionBody(raw, section);
    return body ?? '';
  }

  // -------------------------------------------------------------------------
  // condense
  // -------------------------------------------------------------------------

  /**
   * When the file exceeds 50 KB, summarise the oldest 50% of non-empty lines
   * in each section using the LLM, then replace those lines with the summary
   * while keeping the newest 50% verbatim.
   *
   * Skips gracefully when:
   * - The file is ≤ 50 KB.
   * - The LLM call throws (logs to stderr and continues).
   */
  async condense(router: ModelRouterLike): Promise<void> {
    // Only condense when file exceeds 50 KB
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      // File doesn't exist — nothing to condense
      return;
    }

    const FIFTY_KB = 50 * 1024;
    if (stat.size < FIFTY_KB) {
      return;
    }

    let raw = await this.read();
    let modified = false;

    for (const section of MEMORY_SECTIONS) {
      const body = extractSectionBody(raw, section);
      if (body === null || body.trim().length === 0) {
        continue;
      }

      const nonEmptyLines = body.split('\n').filter(l => l.trim().length > 0);
      if (nonEmptyLines.length < 2) {
        // Nothing meaningful to condense
        continue;
      }

      const halfIndex = Math.floor(nonEmptyLines.length / 2);
      const oldLines = nonEmptyLines.slice(0, halfIndex);
      const newLines = nonEmptyLines.slice(halfIndex);

      let summary: string;
      try {
        const messages: ModelMessage[] = [
          {
            role: 'system',
            content:
              'You are a concise summariser. Given a list of notes, produce a single short bullet-point summary paragraph.',
          },
          {
            role: 'user',
            content: `Summarise these lines concisely:\n${oldLines.join('\n')}`,
          },
        ];
        const reply = await router.complete('planner', messages, { maxTokens: 256 });
        summary = reply.content.trim();
      } catch (err) {
        // LLM unavailable — skip this section
        console.error(
          `[WorkingMemory.condense] LLM unavailable for section "${section}"; skipping. ${String(err)}`,
        );
        continue;
      }

      // Build new body: summary + newest 50% verbatim
      const newBody = `- [condensed] ${summary}\n${newLines.join('\n')}\n`;
      const result = spliceSection(raw, section, newBody);
      if (result.ok && result.text !== undefined) {
        raw = result.text;
        modified = true;
      }
    }

    if (modified) {
      fs.writeFileSync(this.filePath, raw, 'utf8');
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the body of a section from the raw file text.
 * Returns the body string (may be empty) or `null` if the heading is absent.
 */
function extractSectionBody(raw: string, section: MemorySection): string | null {
  const headingRegex = new RegExp(`^## ${escapeRegex(section)}$`, 'm');
  const match = headingRegex.exec(raw);
  if (!match) {
    return null;
  }

  const afterHeading = raw.slice(match.index + match[0].length);
  // Body starts after the newline that follows the heading
  const bodyStart = afterHeading.startsWith('\n') ? 1 : 0;
  const bodyText = afterHeading.slice(bodyStart);

  // The section ends at the next `## ` heading
  const nextHeading = /^## /m.exec(bodyText);
  if (nextHeading) {
    return bodyText.slice(0, nextHeading.index);
  }
  return bodyText;
}

interface SpliceResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/**
 * Replace the body of `section` in `raw` with `newContent`.
 * Returns `{ ok: true, text }` on success or `{ ok: false, error }` if the
 * section heading is not found.
 */
function spliceSection(raw: string, section: MemorySection, newContent: string): SpliceResult {
  const headingRegex = new RegExp(`^## ${escapeRegex(section)}$`, 'm');
  const match = headingRegex.exec(raw);
  if (!match) {
    return { ok: false, error: `Section heading not found: ## ${section}` };
  }

  // Position immediately after the heading line
  const headingEnd = match.index + match[0].length;

  // Skip exactly one newline after the heading (the heading's own line ending)
  let bodyStart = headingEnd;
  if (raw[bodyStart] === '\n') {
    bodyStart += 1;
  }

  // The section body ends at the start of the next `## ` heading
  const remaining = raw.slice(bodyStart);
  const nextHeadingMatch = /^## /m.exec(remaining);
  const bodyEnd = nextHeadingMatch
    ? bodyStart + nextHeadingMatch.index
    : raw.length;

  // Ensure newContent ends with a newline so the next heading starts on its
  // own line (or we're at end-of-file in a clean state)
  let normalised = newContent;
  if (normalised.length > 0 && !normalised.endsWith('\n')) {
    normalised += '\n';
  }

  const newRaw =
    raw.slice(0, bodyStart) +   // everything up to section body
    normalised +                  // new section body
    raw.slice(bodyEnd);           // everything from next heading onward

  return { ok: true, text: newRaw };
}

/**
 * Escape special regex characters in a string so it can be used safely inside
 * `new RegExp(...)`.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

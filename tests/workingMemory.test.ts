import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as fc from 'fast-check';
import { WorkingMemory, MEMORY_SECTIONS, MemorySection } from '../src/memory/WorkingMemory';
import { ModelRouterLike } from '../src/types';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'luicode-memory-test-'));
}

// Content that cannot introduce a fake `## ` heading (which would shift section parsing)
const safeContent = fc.string({ maxLength: 100 }).map((s) =>
  s.split('\n').map((l) => (l.startsWith('## ') ? '### ' + l.slice(3) : l)).join('\n')
);

const SECTION_PAIRS: Array<[MemorySection, MemorySection]> = [];
for (const a of MEMORY_SECTIONS) {
  for (const b of MEMORY_SECTIONS) {
    if (a !== b) SECTION_PAIRS.push([a, b]);
  }
}

// ---------------------------------------------------------------------------
// Property 4 — Working Memory Round Trip  (Validates: Req 2.10)
// ---------------------------------------------------------------------------

describe('Property 4 — Working Memory Round Trip', () => {
  it('memory_write(section, c) then read returns c under the correct heading', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...MEMORY_SECTIONS),
        safeContent,
        async (section, c) => {
          const wm = new WorkingMemory('s1', tmpdir());
          await wm.init();

          const res = await wm.write(section, c);
          expect(res.ok).toBe(true);

          const text = await wm.read();
          expect(text).toContain(`## ${section}`);

          const body = await wm.readSection(section);
          expect(body).toContain(c);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5 — Working Memory Section Isolation  (Validates: Req 2.3)
// ---------------------------------------------------------------------------

describe('Property 5 — Working Memory Section Isolation', () => {
  it('writing to s1 does not alter the content of any other section s2', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...SECTION_PAIRS),
        safeContent,
        async (pair, content) => {
          const [s1, s2] = pair;
          const wm = new WorkingMemory('s2', tmpdir());
          await wm.init();

          for (const s of MEMORY_SECTIONS) {
            await wm.write(s, `baseline ${s}`);
          }

          const before = await wm.readSection(s2);
          const res = await wm.write(s1, content);
          expect(res.ok).toBe(true);
          const after = await wm.readSection(s2);
          expect(after).toBe(before);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6 — Working Memory Unknown Section Rejection  (Validates: Req 2.3)
// ---------------------------------------------------------------------------

describe('Property 6 — Working Memory Unknown Section Rejection', () => {
  it('writing to an unknown section returns !ok and leaves the file byte-for-byte unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 50 }).filter((s) => !MEMORY_SECTIONS.includes(s as MemorySection)),
        fc.string({ maxLength: 100 }),
        async (section, c) => {
          const wm = new WorkingMemory('s3', tmpdir());
          await wm.init();

          const before = fs.readFileSync(wm.filePath, 'utf8');
          const res = await wm.write(section as MemorySection, c);
          expect(res.ok).toBe(false);
          const after = fs.readFileSync(wm.filePath, 'utf8');
          expect(after).toBe(before);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Unit tests — WorkingMemory  (Req 2.1, 2.3, 2.7, 2.9)
// ---------------------------------------------------------------------------

describe('WorkingMemory unit tests', () => {
  it('write supports each of the four valid sections', async () => {
    const wm = new WorkingMemory('u1', tmpdir());
    await wm.init();
    for (const s of MEMORY_SECTIONS) {
      const res = await wm.write(s, `content for ${s}`);
      expect(res.ok).toBe(true);
      expect(await wm.readSection(s)).toContain(`content for ${s}`);
    }
  });

  it('write with an invalid section name leaves the file unchanged', async () => {
    const wm = new WorkingMemory('u2', tmpdir());
    await wm.init();
    const before = fs.readFileSync(wm.filePath, 'utf8');
    const res = await wm.write('Summary' as MemorySection, 'x');
    expect(res.ok).toBe(false);
    expect(fs.readFileSync(wm.filePath, 'utf8')).toBe(before);
  });

  it('append adds a line to the correct section only', async () => {
    const wm = new WorkingMemory('u3', tmpdir());
    await wm.init();
    await wm.append('Notes', '- first note');
    await wm.append('Plan', '- one step');
    await wm.append('Notes', '- second note');

    const notes = await wm.readSection('Notes');
    expect(notes).toContain('- first note');
    expect(notes).toContain('- second note');
    expect(await wm.readSection('Plan')).toContain('- one step');
    // Sections not touched stay empty
    expect((await wm.readSection('Blockers')).trim()).toBe('');
    expect((await wm.readSection('Completed Steps')).trim()).toBe('');
  });

  it('read recreates the file with the default structure when missing', async () => {
    const wm = new WorkingMemory('u4', tmpdir());
    expect(fs.existsSync(wm.filePath)).toBe(false);
    const text = await wm.read();
    expect(fs.existsSync(wm.filePath)).toBe(true);
    for (const s of MEMORY_SECTIONS) {
      expect(text).toContain(`## ${s}`);
    }
  });

  it('condense summarises the oldest 50% lines and preserves the newest 50% and structure', async () => {
    const wm = new WorkingMemory('u5', tmpdir());
    fs.mkdirSync(path.dirname(wm.filePath), { recursive: true });
    const noteLines = Array.from({ length: 4000 }, (_, i) => `- note item ${i}`);
    fs.writeFileSync(
      wm.filePath,
      `## Plan\n\n## Completed Steps\n\n## Blockers\n\n## Notes\n${noteLines.join('\n')}\n`,
      'utf8'
    );
    expect(fs.statSync(wm.filePath).size).toBeGreaterThan(50 * 1024);

    const router = {
      complete: async () => ({ content: 'CONDENSED-SUMMARY' })
    } as unknown as ModelRouterLike;

    await wm.condense(router);

    const text = await wm.read();
    // Most-recent 50% kept verbatim
    expect(text).toContain('- note item 3999');
    expect(text).toContain('- note item 3500');
    // Oldest lines collapsed into the summary marker
    expect(text).toContain('- [condensed] CONDENSED-SUMMARY');
    expect(text).not.toContain('- note item 0');
    expect(text).not.toContain('- note item 1000');
    // Section structure intact
    for (const s of MEMORY_SECTIONS) {
      expect(text).toContain(`## ${s}`);
    }
  });

  it('condense skips gracefully when the LLM is unavailable', async () => {
    const wm = new WorkingMemory('u6', tmpdir());
    fs.mkdirSync(path.dirname(wm.filePath), { recursive: true });
    const noteLines = Array.from({ length: 4000 }, (_, i) => `- note item ${i}`);
    fs.writeFileSync(
      wm.filePath,
      `## Plan\n\n## Completed Steps\n\n## Blockers\n\n## Notes\n${noteLines.join('\n')}\n`,
      'utf8'
    );

    const brokenRouter = {
      complete: async () => {
        throw new Error('LLM offline');
      }
    } as unknown as ModelRouterLike;

    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const original = fs.readFileSync(wm.filePath, 'utf8');
    await expect(wm.condense(brokenRouter)).resolves.toBeUndefined();
    logSpy.mockRestore();
    expect(fs.readFileSync(wm.filePath, 'utf8')).toBe(original);
  });
});
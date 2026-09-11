# LUICode — Feature Overview

This document inventories what the LUICode agent can do today: the core
autonomous coding pipeline, the reasoning-and-tools agent (Universal Generator
Agent v2), and the advanced capability layers built on top of it.

---

## 1. Core agent pipeline (Plan → Build → Test → Ship)

The default workflow is an `Agent → Planner → PlanExecutor → Toolkit → Tools`
pipeline that keeps the human in the loop where it matters.

- **Project inspection** — framework, language, and test-framework detection
  from the workspace (`src/workspace/inspector.ts`).
- **Planning** — the `Planner` produces a structured plan (analysis, steps,
  files to create/modify, test commands, risk) either from an LLM or from a
  rule-based fallback.
- **Approval gates** — plan approval is requested in `manual` mode; `safe`
  auto-approves the plan but gates risky operations; `full` runs autonomously.
- **Execution** — the `PlanExecutor` runs each step as ACTION blocks
  (READ_FILE / SEARCH_CODE / WRITE_FILE / EDIT_FILE / RUN_COMMAND / DONE),
  driving tests after changes are made.
- **Self-verification** — test/build output is parsed; failures are classified
  and drive an automatic fix loop.
- **Review** — diff summary via git, plus security scanning for secrets and
  credential-shaped strings.

## 2. Reasoning + tools — Universal Generator Agent v2

`src/agent/GeneratorAgent.ts` is a tool-use agent that reasons before acting,
uses tools by default rather than by exception, and verifies output before
delivering it. It is wired into the existing `ModelRouter` (LLM calling with
provider fallback) and `Toolkit` (tool execution).

Three supporting modules:

- `src/agent/taskRouter.ts` — request classification + per-task sub-prompts
- `src/agent/verifier.ts` — mechanical output verification
- Tests in `tests/generatorAgent.test.ts` — the eval harness

### The five phases

1. **Understand** — intent, format, constraints. If the request is
   underspecified in a way that changes correctness, the agent answers
   `ACTION: CLARIFY` with a question instead of guessing; otherwise it records
   a one-line `ASSUMPTION:` and proceeds (assumptions are surfaced back to the
   caller).
2. **Plan** — multi-step tasks are outlined as a numbered plan in `THOUGHT`
   before acting; the plan can be revised after each tool observation.
3. **Execute** — a ReAct-style loop issues tool calls
   (`THOUGHT` / `ACTION: <tool>` / `ARGS: {json}`) and feeds observations back
   until the model emits `ACTION: FINAL` + `ANSWER`.
4. **Verify** — output is checked mechanically (JSON parse, TS/JS syntax via
   the TypeScript compiler) and, if it fails, corrected once automatically
   before delivery.
5. **Deliver** — the final answer, with assumptions surfaced and a flag
   (`corrected`) when verification rewrote the output.

### Guards and quality controls

- `maxSteps` loop cap (default 6) with graceful partial-result fallback.
- Duplicate tool-call detection — repeating the same tool with the same
  arguments halts the loop instead of spinning.
- Lenient parsing — a reply without a protocol marker is treated as the answer.
- Errors from tools are surfaced as observations and the loop continues.
- `corrected` / `verified` / `clarificationNeeded` / `halted` flags on the
  result give callers full visibility into what happened.

### Task-type router

Requests are classified (research → structured data → code → general) so the
right behavioural sub-prompt is injected:

| Task type | Behaviour |
|-----------|-----------|
| `code` | idiomatic style; must be valid/runnable before returning; verify with a tool when possible |
| `structured_data` | define the schema first, then fill it; match the requested format exactly (CSV/JSON/YAML/table); mechanically validate |
| `research` | never fabricate sources/versions/URLs; mark unverified current facts as "based on my knowledge cutoff" |
| `general` | tone/scope matching; `CLARIFY` over guessing when ambiguity changes correctness |

### Tools the agent can invoke

All `Toolkit` tools plus `run_command` (shell), listed in `AVAILABLE TOOLS` so
the model only calls what exists:

`ast_edit`, `line_edit`, `read_file`, `write_file`, `edit_file`,
`create_file`, `delete_file`, `rename_file`, `move_file`, `list_directory`,
`search_files`, `search_code`, `read_project_tree`, `run_command`, plus git
tools (`git_status`, `git_diff`, `git_log`, `git_branch`) when git is enabled.

---

## 3. Advanced capability layers

### Semantic code search (RAG)

- `src/rag/VectorStore.ts` — local, deterministic vector index (no external
  embedding API): chunking with configurable size/overlap, TF-IDF-style
  hashed embeddings, cosine similarity, `embeddings.bin` + `chunks.json` +
  `meta.json` persistence, cold-start walk with incremental mtime-based
  re-indexing, exclusion of `node_modules/`/`.git/`/`.luicode/` and oversized
  files.
- `src/rag/RAGRetriever.ts` — retrieval front-end. Tries semantic search and
  falls back to keyword search (`search_code`) when the embedding backend is
  unavailable, emitting `status` warnings on fallback or zero results. Provides
  `formatForPrompt()` for injecting a relevance-scored context block.
- Guarantees: same query on an unchanged index returns identical ordered
  results; scores are clamped to `[0, 1]`; result count ≤ `topK`.

### Working memory

- `src/memory/WorkingMemory.ts` — per-session Markdown scratchpad
  (`<baseDir>/memory/<sessionId>.md`) with four sections
  (`Plan`, `Completed Steps`, `Blockers`, `Notes`).
- Section-scoped `write` / `append` / `readSection`; unknown section names are
  rejected without touching the file; missing files are recreated with the
  default template; files over 50 KB are condensed by the LLM (skipped
  gracefully when the LLM is unavailable).

### AST-aware editing

- `src/tools/astTools.ts` — structural edits instead of blind string search.
  - `ast_edit`: TypeScript/JavaScript via the TypeScript parser (replace a
    node by qualified name, re-parse, and roll back on syntax errors; lists up
    to 20 top-level names when the target is missing), Python via
    indentation-aware `def`/`class` blocks, JSON via pointer-path traversal.
  - `line_edit`: 1-based inclusive line-range replacement with strict bounds
    validation that leaves the file untouched on invalid ranges.

---

## 4. Safety posture

- **Workspace-only boundary** — paths outside the workspace are rejected.
- **Protected paths** — home-dir credential dirs (`.ssh`, `.aws`, `.azure`,
  `.config`, `.gnupg`, `.netrc`, …) cannot be written.
- **Command guardrail** — `CommandGuard` distinguishes safe / needs-approval /
  blocked commands; destructive commands are blocked outright.
- **Secret redaction** — sensitive tokens are redacted from tool output and
  scans flag hardcoded secrets.
- Toolkit emits full event telemetry (`status`, `tool`, `command`, `test`,
  `file`, `error`, …) so UIs can render activity live.

---

## 5. Verification & testing

Every component ships with unit tests and fast-check property tests
(`npm test` — 77 tests, 6 suites). The GeneratorAgent's eval harness
re-runs the spec's five canonical test cases on every change:

- `Write a Python script for a web scraper` → `code`
- `Generate a CSV of 5 mock user profiles` → `structured_data`
- `Draft an email requesting a deadline extension` → `general`
- `What's the current version of the OpenAI SDK?` → `research`
- `Make me a thing` → `general` (deliberately ambiguous — must ask or state an assumption)

Add any new prompt or behaviour to this harness so quality is measured, not
felt. Typecheck/lint: `npm run typecheck`.
# LUICode — Feature Overview

This document inventories what the LUICode agent can do today: the core
autonomous coding pipeline, the reasoning-and-tools agent (Universal Generator
Agent v2), and the advanced capability layers built on top of it.

---

## 1. Core agent pipeline (Plan → Build → Test → Ship)

The default workflow is an `Agent → Planner → PlanExecutor → Toolkit → Tools`
pipeline that keeps the human in the loop where it matters.

- **Project inspection** — framework, language, and test-framework detection
  from the workspace (`src/workspace/inspector.ts`), plus workspace
  classification (from-scratch vs existing project). The package manager is
  detected from the workspace root's lockfiles (never the process CWD), so
  inspections stay correct when the workspace isn't the current directory.
- **Planning** — the `Planner` produces a structured plan (analysis, steps,
  files to create/modify, test commands, risk) either from an LLM or from a
  rule-based fallback. Steps carry a type (`scaffold` / `install` / `edit` /
  `run` / `review`), an exact action, a one-line why, and a risk tier
  (`safe` / `modify` / `modify+network` / `blocked`). Every plan is persisted
  to `plan.md` and refreshed as it is approved, rejected, or implemented.
- **Framework adapters** — install / build / test commands are routed through
  an adapter registry (`src/planner/adapters.ts`) with `node-npm`,
  `node-pnpm`, `node-yarn`, `python-pip`, `python-poetry`, `rust-cargo`,
  `go-modules`, and `ruby-bundler`. Installs are flagged `modify+network`,
  default to script-suppressed installs, and are always followed by a lockfile
  or equivalent verification step. Per-project `adapters` config overrides the
  commands.
- **Multi-file config precedence** — settings deep-merge from built-in
  defaults, `~/.luicode/`, and `.luicode/`, with `settings.lock.json` (user and
  project) sitting at the top of the priority chain. The project model lock —
  `.luicode/settings.lock.json`, copied from `.luicode.example/` — is the
  idiomatic way to pin planner/coder/reviewer/fallback models per repository
  (see MODEL_SETUP.md). `luicode model … --local` writes there when present.
- **From-scratch builds** — empty workspaces get an official-scaffolder step,
  a re-inspection step after scaffolding, then edits. When the task names no
  stack, the first step is a `blocked` "confirm the technology stack" step
  instead of a silently assumed framework.
- **Approval gates** — plan approval is requested in `manual` mode (with
  per-step checkboxes); `safe` auto-approves the plan but gates risky
  operations; `full` runs autonomously.
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

### Dynamic commentary

`src/agent/executor.ts` and `src/agent/Agent.ts` emit natural-language
`comment` events instead of hardcoded status text:

- The planner's analysis is surfaced as a conversational comment.
- The coder writes a 1-3 sentence explanation *before* each ACTION block
  (delimited by `--- commentary ---` … `--- end commentary ---` markers and
  stripped out by `extractCommentary`), so the UI explains what is about to
  happen while the actions still execute.
- The fix loop explains why a test failed and how it will patch it.
- The final summary is generated by a reviewer-model call in the same
  conversational register, with a static fallback when the LLM is offline.

### Terminal UI (TUI)

`src/ui/TUI.ts` is a full multi-panel terminal interface:

- **Status bar** — session mode, the model per role, and running token/cost
  usage.
- **Spinner + progress** — animated indicator while the agent thinks, plans,
  and retries (with a `(fix attempt X/Y)` progress bar).
- **Plan panel** — steps with type/risk badges and checkbox-based per-step
  approval (`↑`/`↓`, `Space`, `A`, `Enter`, `N`/`Esc`).
- **Diff panel** — inline stats (`+N -M`) for every changed file.
- **Terminal panel** — commands with color-coded verdict badges
  (SAFE / MODIFY / BLOCKED).
- **Session picker** — interactive `--resume` picker when several sessions
  exist.

---

## 4. Safety posture

- **Workspace-only boundary** — paths outside the workspace are rejected. The
  boundary check canonicalizes symlinks (`fs.realpathSync`), so a symlink
  inside the workspace pointing outside can't be used to escape it.
- **Protected paths** — home-dir credential dirs (`.ssh`, `.aws`, `.azure`,
  `.config`, `.gnupg`, `.netrc`, …) cannot be written, and the same
  symlink-aware canonicalization is applied.
- **Command guardrail** — `CommandGuard` distinguishes safe / needs-approval /
  blocked commands; destructive commands are blocked outright. Whitelist
  entries are prefix matches — a trailing `*` is stripped, so `npm test*`
  behaves exactly like `npm test` and also matches `npm test --coverage`.
- **Secret redaction** — sensitive tokens are redacted from tool output and
  scans flag hardcoded secrets.
- Toolkit emits full event telemetry (`status`, `tool`, `command`, `test`,
  `file`, `error`, …) so UIs can render activity live.

---

## 5. Verification & testing

Every component ships with unit tests and fast-check property tests
(`npm test` — 157 tests, 11 suites). The GeneratorAgent's eval harness
re-runs the spec's five canonical test cases on every change:

- `Write a Python script for a web scraper` → `code`
- `Generate a CSV of 5 mock user profiles` → `structured_data`
- `Draft an email requesting a deadline extension` → `general`
- `What's the current version of the OpenAI SDK?` → `research`
- `Make me a thing` → `general` (deliberately ambiguous — must ask or state an assumption)

Add any new prompt or behaviour to this harness so quality is measured, not
felt. Typecheck/lint: `npm run typecheck`.

---

## 6. Terminal UX — keyboard shortcuts & command registry

The interactive TUI (`src/ui/TUI.ts`) is a thin renderer over three shared
systems, all driven from a single source of truth:

- **Command registry** (`src/ui/commands.ts`) — every action is a
  `registerCommand` entry: id, name, description, `slash` name, `shortcut`
  label, `keybindings` (combo + context), and an `execute(ctx, args)` handler.
- **Keybinding manager** (`src/ui/keybindings.ts`) — converts raw keypresses
  into canonical combos (`ctrl+p`, `space`, `up`, …), resolves them against a
  `UiContext` (`global` / `plan` / `diff` / `terminal` / `agent` / `approval` /
  `palette` / `models` / `sessions` / `help` / `prompt`). Resolve order is
  *context-exact first, then global*, so a global shortcut can never shadow a
  context-specific one. `conflicts()` reports duplicate (context, combo)
  registrations at startup/tests.
- **Overlay widgets** — `src/ui/shortcuts.ts` (`/help` + `?`, topics
  shortcuts/commands/modes/safety/general/agent/panels), `commandPalette.ts`
  (`Ctrl+P`, fuzzy filter, Enter runs the command), `modelManager.ts`
  (`Ctrl+M`/`/models`: role ⇄ provider panes, `T` test-in-place, `D` default,
  raw `<provider>/<model>` query line), `sessionPicker.ts`
  (`Ctrl+R`/`/resume`: browse, `S` filter, `R` rename, `D` delete).

Every user-facing action is reachable three ways — **keyboard shortcut, slash
command, command palette** — and all three call the same `execute` handler, so
no path can bypass the CommandGuard, permission manager, or approval gates.
`/run <cmd>` still flows through `CommandGuard`; `BLOCKED` commands never
execute no matter how the action was invoked. The TUI also exposes the Agent's
run controls as `agent`-context shortcuts while the prompt is empty.

## 7. Agent run controls (RunControl)

`src/agent/runControl.ts` is the real control channel shared by the UI and the
pipeline. The same instance is threaded through `Toolkit`, `PlanExecutor`, and
`Agent`; the UI asks, the pipeline obeys:

- **Pause/resume** — `waitIfPaused()` blocks at each safe checkpoint (before a
  step, before a tool call), so pause is a genuine gate, not cosmetic.
- **Stop** — `abort()` throws a `CANCELLED:` error at the next checkpoint; the
  pipeline reports it as a user cancellation rather than a failure.
- **One-shot step controls** — `requestSkip()` / `requestRetry()` /
  `requestFix()` are consumed exactly once by the current step (skip, retry)
  or the next loop pass (fix).
- **Approval gate shortcuts** — `requestApproveNext()` / `requestRejectNext()`
  set the *next* gate's outcome; they are consumed at the gate itself, so they
  never bypass the safety chain.

`Agent` exposes `cancel/pause/resume/skipStep/retryStep/requestFix/fixLoopNow`
and closes over the same `RunControl`, letting the TUI's `Space/R/S/F/Y/N` hit
the running pipeline with no race conditions.

## Recent Improvements

Enhanced the GeneratorAgent to support structured multi-file output for large code generation:
- Added `FileOperation` and `MultiFileOutput` interfaces in `src/types.ts`
- Modified `src/agent/GeneratorAgent.ts` to output structured JSON representing multiple file operations
- Accumulate file operations across reasoning steps
- Added per-file verification and correction passes
- Improved handling of ARGS parsing and payload extraction

Added web server UI for configuration and monitoring:
- Created `src/server/server.ts` with Express-based LuicodeServer class
- Implemented REST API endpoints for status, project info, config, providers, models, sessions, files, and git status
- Added static file serving for SPA UI with tabs for Providers, Models, Messaging, Integrations, and Session
- Created `public/` directory with HTML/CSS/JS for the interactive web interface
- Added `luicode server` command to both CLI and interactive UI
- Fixed TypeScript errors in Project Understanding Mode implementation
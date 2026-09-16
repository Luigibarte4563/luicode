# LUICode — Code Review

**Scope:** `src/**`, `tests/**`, `config/**`, build/test config
**Base:** commit `fbe0232`, branch `main`
**Method:** static review of the current tree + `npm run typecheck` + full `npm test` (11 suites / 157 tests, all passing)

---

## 1. Overall assessment

**Good.** LUICode is a well-structured, security-conscious autonomous coding
agent. The architecture is cleanly layered (workspace → tools → toolkit →
agent → planner/executor → UI/CLI), the safety model is the strongest part of
the codebase, and the code is consistent, typed end-to-end, and free of
`TODO`/`FIXME` litter. TypeScript strictness (`tsc --noEmit`) passes clean and
the test suite is meaningful, not ceremonial.

The main review findings are a small number of correctness edge cases (the
most notable being package-manager detection that ignores the workspace root),
dead code left behind by feature churn, and a gap between a documented
promise (glob whitelists, symlink-safe workspace boundary) and the actual
implementation.

---

## 2. Architecture map

| Module | Responsibility |
| --- | --- |
| `src/cli/index.ts` | Arg parsing, interactive/non-interactive entry, `--plan`/`--resume`/`--review` wiring |
| `src/ui/TUI.ts` | Multi-panel terminal UI, spinner, status bar, approvals |
| `src/agent/Agent.ts` | Orchestrator: inspect → plan → approve → execute → fix loop → summarize |
| `src/planner/Planner.ts` | LLM + heuristic planning, workspace classification, step type/risk model |
| `src/planner/adapters.ts` | Framework adapter registry (install/build/test/verify commands) |
| `src/agent/executor.ts` | Step execution as ACTION blocks, parse/extract, heuristic fallback |
| `src/agent/GeneratorAgent.ts` | ReAct tool-use agent (understand → plan → execute → verify → deliver) |
| `src/agent/toolkit.ts` | Tool registry, command runner, permission + guard wiring |
| `src/workspace/Workspace.ts` | Workspace boundary, file I/O, tree/search |
| `src/security/` | Command guard, permission manager, secret scan/redaction |
| `src/router/ModelRouter.ts` | Provider routing + fallback + usage hooks |
| `src/rag/`, `src/memory/`, `src/diff/`, `src/git/` | RAG search, working memory, diff engine, git ops |
| `src/sessions/SessionManager.ts` | Session persistence (`<sessionId>.json`) |

---

## 3. Strengths

- **Layered, single-flow architecture.** Orchestration stays in `Agent.ts`;
  tools are small, uniform (`Tool` interface + `ToolRuntime`), and drive
  through `Toolkit`. Easy to follow and extend.
- **Defense in depth.** Workspace boundary → protected paths → command guard →
  permission manager → secret redaction → approval gates. Commands are blocked
  before spawn, run inside the workspace `cwd`, and are subject to timeout +
  output caps (`src/tools/shellTools.ts:23`, `:62`).
- **Structured agent protocol.** `ACTION:` blocks with strict `parseActions`
  parsing — an output without the protocol is handled leniently; commentary is
  cleanly separated from actions (`src/agent/executor.ts`).
- **Degraded fallbacks everywhere.** Provider down → heuristic planning /
  heuristic step execution; RAG unavailable → keyword search; LLM offline →
  static summary. The system keeps working offline, which is rare and good.
- **Deterministic substitutes.** In-memory vector store, heuristic plan
  builder, and stable plan IDs keep behavior reproducible without an LLM.
- **Naming and typography are coherent** — event payloads (`AgentEvent`
  union), step metadata, and risk tiers are all first-class types.

---

## 4. Findings

> **Status note (base `fbe0232` → current):** fixes 1–5 below are resolved and
> verified by `npm run typecheck` (clean) and `npm test` (157/157).

### 4.1 Correctness & robustness

**[RESOLVED] Package-manager detection used `process.cwd()`**
`src/workspace/inspector.ts:85-90`

```ts
function detectPackageManager(): string {
  if (fs.existsSync(path.join(process.cwd(), 'pnpm-lock.yaml'))) return 'pnpm';
  ...
}
```

Detection reads lockfiles from the workspace root (`ws.root`), not the process
CWD — `detectPackageManager` now accepts the root path explicitly, and a test
covers the CWD-differs case. If a task runs against a workspace that isn't the
CWD, `profile.packageManager` still resolves correctly.

**[RESOLVED] Whitelist semantics didn't match the documented format**
`src/security/commandGuard.ts:50-54`

The README and config examples document glob-style entries (`"npm test*"`), and
the implementation now normalizes them: a trailing `*` is stripped before the
`startsWith` comparison, so `npm test*` behaves exactly like `npm test` and
also matches `npm test --coverage`. The README and FEATURE docs state the
prefix-match semantics explicitly.

**[RESOLVED] Workspace boundary was not symlink-safe**
`src/workspace/Workspace.ts:18-21`

`isWithin` and `isProtected` now canonicalize both root and target with
`fs.realpathSync()` before the containment check, falling back to
`path.resolve()` when the target doesn't exist yet. A test covers the
symlink-outside-workspace case (skipped when the platform can't create
symlinks).

**[RESOLVED] Dead code in the command guard** — removed.

`GUI_MODIFIERS` and the unused `path` import (previously suppressed with
`void`) have been deleted; no `--force`/`push` detection was wired in.

**[RESOLVED] Heuristic executor writes `.ts` regardless of language** — fixed.

The offline `heuristicNextAction` "create/implement" branch now keys the
extension off the detected language from `inspectProject` (`TypeScript →
`.ts`, `JavaScript` → `.js`, `Python` → `.py`, …) and emits `ACTION: DONE` for
unsupported languages (e.g. vanilla HTML/CSS/JS workspaces). Tests cover the
Python path and the unsupported-language fallback.

**[P3] `plan.md` is a workspace artifact**
`src/agent/Agent.ts` (`persistPlanMarkdown`)

Writing `plan.md` into the project root is intentional, but it lands in the
working tree and would be swept into git checkpoints/diffs. Worth an explicit
decision: `.gitignore` entry, or include it deliberately in the summary of
"files modified".

### 4.2 Security

- **Strengths:** blocked commands are rejected before spawn
  (`src/agent/toolkit.ts:57-60`); tool output is redacted and capped at 4 KB
  (`:101`); protected home-dir paths are refused; API keys are env-only and
  never persisted.
- **Note:** the command guard still relies on `cwd` for workspace locality of
  an already-approved command; a `cd` inside a command runs wherever it wants.
  That's a reasonable model for this kind of tool, but worth documenting so
  users don't assume runtime sandboxing.
- **Note:** `ShellRunner` passes the full `process.env` to child processes
  (`src/tools/shellTools.ts:23`). Fine for a CLI; if LUICode is ever embedded
  as a library, key env vars leak into spawned commands by default.

### 4.3 Maintainability & design

- **[P2] `TUI.ts` is a 500+-line monolith.** Rendering, input handling, event
  dispatch, panel state, spinner, and ANSI helpers all live in one class.
  Splitting into `Panels`, `Renderer`, and `Input` would improve testability —
  pay special attention because `src/ui/**` is excluded from coverage.
- **[P2] CLI logic is untested.** `parseArgs` and `helpText` are exported pure
  functions but `src/cli/**` is excluded from coverage
  (`jest.config.js:10`). Those two are trivially unit-testable and are the
  public contract every user hits.
- **[P3] System prompts are scattered.** Planner, executor, and summary prompts
  live inside their own modules. Collating them in a `src/prompts/` module
  would make prompt changes versionable and reviewable.
- **[P3] Generated marker files** (`src/c.ts`, `src/hello.ts`) appear in the
  working tree after demo runs — consider adding a `*.generated.*` ignore rule
  or writing fixture output elsewhere.

---

## 5. Testing & tooling

| Check | Status |
| --- | --- |
| `npm run typecheck` (`tsc --noEmit`) | Pass, 0 errors |
| `npm test` (jest, 11 suites) | 157/157 pass |
| Coverage config | `collectCoverageFrom` excludes `src/cli/**`, `src/ui/**` |

Coverage is solid in the engine (`Agent`, `executor`, `Planner`, `Workspace`,
security, tooling). The two uncovered areas are the ones users interact with
most: the CLI front door and the TUI. The plan-approval, spinner, adapter, and
commentary logic added recently is covered through the shared logic in
`Agent`/`Planner`/`executor`, but the rendering layer itself has no tests.

---

## 6. Prioritized recommendations

Status after the fix pass:

~~1. Fix package-manager detection to use the workspace root + test~~ **done**
~~2. Reconcile whitelist semantics (prefix-match, align README example)~~ **done**
~~3. Symlink-safe boundary in `isWithin`/`isProtected` + test~~ **done**
~~4. Remove dead code — `GUI_MODIFIERS`, unused `path` import~~ **done**
~~5. Language-keyed heuristic file extension + DONE fallback for unsupported~~ **done**

Still open:

1. **Unit-test `parseArgs`/`helpText`** and re-enable `!src/cli/**` in
   coverage for those files.
2. **Decompose `TUI.ts`** incrementally (panels out first) as UI work
   continues.
3. **Decide the fate of `plan.md`** in git (ignore vs. deliverable).

---

## 7. Verification reference

Ran on Windows (PowerShell), once after each fix step:

```
npm run typecheck  → clean (0 errors)
npm test           → 11 passed suites, 157 passed tests
```

---

## 8. Change log (current working tree)

- **Model integration lock file.** Config now also loads
  `.luicode/settings.lock.json` (user + project), which takes highest
  priority for provider/model routing. `.luicode.example/settings.lock.json`
  ships as the template; `writeConfigFile` emits real JSON for `.json` files;
  `luicode model … --local` writes to `settings.lock.json` when it exists
  (`src/config/schema.ts`, `src/llm/integration.ts`, `src/cli/index.ts`).
- **Docs updated:** README (setup + config precedence), MODEL_SETUP.md (new
  step-by-step model integration guide), MODEL_INTEGRATION.md (points to
  MODEL_SETUP.md, updated precedence), FEATURE.md (config bullet + test count),
  this file.
- Tests added for the lock-file write path (`tests/modelIntegration.test.ts`).
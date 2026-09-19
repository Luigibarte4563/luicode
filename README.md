# LUICode

**LUICode — Plan. Build. Test. Ship.**

LUICode is an autonomous AI coding-agent CLI with an interactive terminal UI. It
inspects your project, builds an implementation plan, executes it (with your
approval when you want it), runs the test/build loop, fixes failures, and
reviews the result — while staying inside a workspace-only safety boundary.

## Install

Requires **Node.js ≥ 18**.

```bash
cd luicode
npm install
npm run build
npm link            # makes the `luicode` command available globally
```

Verify:

```bash
luicode --version   # luicode v0.2.0
```

## Setup

After installing, point LUICode at an LLM provider by setting the appropriate
environment variable and (optionally) creating a config file.

### 1. Set your API key

Export the key for whichever provider you want to use:

```bash
# Anthropic (Claude)
export ANTHROPIC_API_KEY="sk-ant-..."

# OpenAI
export OPENAI_API_KEY="sk-..."

# Google Gemini
export GEMINI_API_KEY="..."

# OpenRouter (access many models with one key)
export OPENROUTER_API_KEY="..."

# Groq
export GROQ_API_KEY="..."

# DeepSeek
export DEEPSEEK_API_KEY="..."

# Qwen / DashScope
export DASHSCOPE_API_KEY="..."

# Together AI
export TOGETHER_API_KEY="..."

# GitHub Models (free tier)
export GITHUB_TOKEN="ghp_..."
```

For a fully local, free setup use **Ollama** — no key required. Install it from
[ollama.com](https://ollama.com) and pull a model:

```bash
ollama pull llama3.1
```

### 2. Create a config (recommended)

**Project-level model config.** Copy the template and edit the model lock —
the recommended way to set up a provider like Claude per project:

```bash
cp -r .luicode.example .luicode     # creates .luicode/settings.lock.json
export ANTHROPIC_API_KEY="sk-ant-..."   # or your provider's key
luicode model test anthropic/claude-sonnet-4-20250514
```

`settings.lock.json` always takes priority and is the fastest way to route the
planner/coder/reviewer roles to any provider. See **MODEL_SETUP.md** for the
full guide and per-provider examples.

**Global user config.** Create `~/.luicode/config.yaml` (or `.json`) to set your
preferred provider and models once, globally:

```yaml
# ~/.luicode/config.yaml

provider: anthropic           # change to: openai | gemini | groq | ollama | …

models:
  planner:  anthropic/claude-3-5-sonnet-latest
  coder:    anthropic/claude-3-5-sonnet-latest
  reviewer: anthropic/claude-3-5-sonnet-latest

auto:
  mode: manual                # manual | safe | full
```

You can also create a per-project override at `<project>/.luicode/config.yaml`.
Project settings take precedence over the global file, which takes precedence
over the built-in defaults. `settings.lock.json` (user or project) takes
priority over all of them.

### 3. Quick-start examples

**Anthropic (Claude):**
```yaml
provider: anthropic
models:
  planner:  anthropic/claude-3-5-sonnet-latest
  coder:    anthropic/claude-3-5-sonnet-latest
  reviewer: anthropic/claude-3-5-sonnet-latest
```

**OpenAI:**
```yaml
provider: openai
models:
  planner:  openai/gpt-4o
  coder:    openai/gpt-4o-mini
  reviewer: openai/gpt-4o
```

**Fully local with Ollama (no API key):**
```yaml
provider: ollama
models:
  planner:  ollama/llama3.1
  coder:    ollama/llama3.1
  reviewer: ollama/llama3.1
```

**LiteLLM proxy (default):**
The built-in default routes through a local LiteLLM proxy at
`http://localhost:4000`. To use it, [run LiteLLM](https://docs.litellm.ai)
locally and configure its backend separately.

### 4. Verify setup

```bash
luicode --plan "list the files in this project"
```

LUICode will inspect the workspace and produce a plan (writes plan.md only)
without modifying any source files. If it responds successfully, your provider
and API key are configured correctly.

## Usage

```bash
luicode                      Launch the interactive terminal UI
luicode --plan [task]        Inspect the project and generate a plan (writes plan.md only)
luicode --auto "task"        Autonomous dev mode (safe permissions by default)
luicode --auto=safe "task"   Autonomous mode, safe permission level
luicode --auto=full "task"   Autonomous mode, full workspace autonomy
luicode --model <spec>       Route the coder to a model for this run (e.g. openai/gpt-4o-mini)
luicode --resume             Resume the last interrupted session (picker when several exist)
luicode --resume "task"      Run a task, continuing an earlier session
luicode --review             Review working-tree changes + security scan
luicode --version            Show version
luicode --help               Show help
```

### Interactive TUI

Run `luicode` in a terminal inside your project. Type a task such as
"How long does the diff engine take on a million-line file? Optimize it if
needed." and press **Ctrl+Enter** (or Enter).

**Global shortcuts:**

| Key | Action |
| --- | --- |
| `Ctrl+Enter` | Submit the current prompt |
| `Ctrl+P` | Open the **command palette** (fuzzy search, Enter runs) |
| `Ctrl+C` | Stop the running agent (when idle, exits) |
| `Ctrl+R` | **Session picker** (resume / new / rename / delete) |
| `Ctrl+H` | Help (`/help`), `?` opens shortcuts too |
| `Ctrl+M` | Model manager (roles ⇄ providers, test in place) |
| `Ctrl+H` | Help (`/help`), `?` opens shortcuts too |
| `Ctrl+D` | Focus the diff panel / show Git diff |
| `Ctrl+G` | Git status |
| `Ctrl+T` | Cycle panel area (plan → diff → terminal → prompt) |
| `Ctrl+L` | Clear the panels |
| `Ctrl+O` | Toggle autonomy mode (manual ⇄ safe) |
| `Ctrl+Q` | Quit |
| `Esc` | Close overlay / back to prompt |
| `?` | Shortcuts popup (while the prompt is empty) |

**Agent controls** (active while the agent is running and the prompt is empty):

| Key | Action |
| --- | --- |
| `Space` | Pause / resume the agent |
| `R` | Retry the current failed step |
| `S` | Skip the current step |
| `F` | Start the automatic fix loop |
| `Y` | Approve the current gate |
| `N` | Reject / skip the current gate |

**Prompt editing:** `←`/`→` move the cursor, `Home`/`End` jump, `↑`/`↓`
scroll history, and typing **`/`** opens slash-command autocomplete
(use `↑`/`↓` to pick, `Tab` to complete, `Enter` to run).

**Plan panel:** `↑`/`↓` or `j`/`k` move between steps, `Space` toggles a step,
`A` selects all, `E` re-plans, `V` views `plan.md`, `N` skips/rejects, `Enter`
executes the approved plan.

**Diff/terminal panels:** `Ctrl+D` focuses the diff panel, `Ctrl+T` cycles the
panel area, `g` shows git status while the diff panel is focused.

**Command palette (`Ctrl+P`)** lists every action and slash command from the
shared registry — type to filter, `↑`/`↓` to move, `Enter` to run. Every action
has three equivalent ways to run it: keyboard shortcut, slash command, or
palette entry. All of them call the same implementation, so the safety layer
(CommandGuard, approval gates) is never bypassed by choosing a different path.

**Slash commands:** type `/` to see a live list. Highlights: `/help [topic]`,
`/models` (interactive), `/model <task> <provider/model>`, `/providers`,
`/plan`, `/replan`, `/execute`, `/stop`, `/retry`, `/fix`, `/approve`,
`/reject`, `/run <cmd>` (through CommandGuard), `/test`, `/build`, `/status`,
`/log`, `/diff`, `/review`, `/context`, `/tree`, `/memory`, `/mode`,
`/permissions`, `/tools`, `/config`, `/resume`, `/new`, `/quit`.

**Plan approval (checkboxes):** when a plan is up for approval in `manual`
mode, use `↑`/`↓` to move, `Space` to toggle a single step, `A` selects all,
`Enter` to approve, and `N` / `Esc` to reject. Skipped steps stay out
of the run. From the agent controls, `Y` approves the *next* approval gate and
`N` rejects/skips it.

The status bar shows the session mode, the model assigned to each role, and
running token/cost usage; a spinner and progress indicator keep you informed
while the agent thinks, plans, or retries a fix. Toast notifications appear
above the input line, and overlays (help, palette, model manager, session
picker, results) replace the panel area until dismissed with `Esc`.

When stdin is not a TTY (piped or CI), LUICode runs in plain line mode instead
of rendering the terminal UI.

### The plan file (`plan.md`)

Every plan LUICode produces is written to **`plan.md`** in the project root (in
addition to the plan panel). The file captures the task, risk level, analysis,
and each step with its type (`scaffold` / `install` / `edit` / `run` /
`review`), the exact action, the reasoning, and its risk tier. Its status
field is refreshed as the plan is **approved**, **rejected**, or
**implemented**, so `plan.md` doubles as a lightweight run log. `luicode
--plan` generates the file and makes no other changes.

### Planner spec & framework adapters

The planner classifies the workspace first:

- **Empty / near-empty workspace** → from-scratch build: it plans an official
  scaffolder step (e.g. `npx create-next-app@latest .`), a re-inspection step,
  a script-suppressed install, and a lockfile verification.
- **Task without a named stack** → the first step is a `blocked` "confirm the
  technology stack" step instead of a silently guessed framework (no more
  hardcoded vanilla HTML/CSS/JS output).
- **Existing project** → the detected adapter's commands are used verbatim.

Install, build, and test commands are routed through the **adapter registry**
(`src/planner/adapters.ts`), which maintains `node-npm`, `node-pnpm`,
`node-yarn`, `python-pip`, `python-poetry`, `rust-cargo`, `go-modules`, and
`ruby-bundler`. Installs are always flagged `modify+network`, default to
script-suppressed (`--ignore-scripts`) where supported, are scoped to known
registries, and are always followed by a verification step — a zero exit code
is never trusted on its own.

### Autonomy levels

| Mode | Behavior |
| --- | --- |
| `manual` (default) | LUICode plans, then asks before executing the plan and before risky shell commands |
| `safe` | Plans are auto-approved; file writes must be inside the workspace; command-guard whitelist still applies |
| `full` | Everything runs without prompts (use with caution) |

`--auto` maps to `safe`; `--auto=full` grants full workspace autonomy.

### Workflow

1. **Inspect** — LUICode reads the project (manifest, source layout, tests) and
   classifies it (from-scratch vs existing).
2. **Plan** — A typed, risk-tiered plan is produced (LLM or offline heuristic),
   routed through the detected framework adapter, and written to `plan.md`;
   shown for approval in manual mode.
3. **Build** — File edits are applied with per-file diffs (additions/deletions
   stats shown in the diff panel).
4. **Test** — The test command runs; failures drive the fix loop (up to a
   configured iteration budget), with a spinner and progress indicator during
   each retry.
5. **Build** — A compile/build step catches type or syntax errors.
6. **Review** — A final LLM-written summary lists what changed; `luicode
   --review` runs an independent security/health scan any time.

The agent narrates its work conversationally — it explains why a test failed
and how it will fix it rather than echoing canned status lines.

## Configuration

LUICode merges settings from, in order (lowest to highest priority):

1. Built-in defaults (`config/default.yaml` in the LUICode install)
2. `~/.luicode/settings.lock.json` — global model lock
3. `~/.luicode/config.yaml` (or `config.json`) — global user settings
4. `<project>/.luicode/settings.lock.json` — project model lock
5. `<project>/.luicode/config.yaml` (or `config.json`) — per-project settings

`settings.lock.json` is the highest-priority file and is meant for model /
provider integration (copy `.luicode.example/` to `.luicode/` to start).

Example `~/.luicode/config.yaml`:

```yaml
provider: anthropic            # default provider for all tasks
models:
  planner:  anthropic/claude-3-5-sonnet-latest
  coder:    anthropic/claude-3-5-sonnet-latest
  reviewer: anthropic/claude-3-5-sonnet-latest
fallbackOrder: [ollama]        # try these providers if the primary is unreachable
auto:
  mode: manual                 # manual | safe | full
  maxIterations: 5
  maxActionsPerStep: 6
terminal:
  whitelist:
    - "npm test*"
    - "npm run build*"
    - "npm run lint*"
  # Note: whitelist entries are PREFIX matches, not full globs. A trailing "*"
  # is stripped and harmless ("npm test*" acts exactly like "npm test"), so
  # "npm test" also matches "npm test --coverage".
adapters:
  node-npm:
    install: "npm ci --ignore-scripts"
    test: "npm run test:unit"
```

`adapters` lets you override the install / install-one / test / build /
scaffold / lockfile / verify commands of any adapter in the registry,
per project.

## Providers

| Provider | Kind | API key env var | Notes |
| --- | --- | --- | --- |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | Claude models |
| OpenAI | `openai` | `OPENAI_API_KEY` | |
| Google Gemini | `gemini` | `GEMINI_API_KEY` | |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | Many models |
| Groq | `groq` | `GROQ_API_KEY` | Fast/cheap |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | |
| Qwen | `qwen` | `DASHSCOPE_API_KEY` | qwen-coder-plus |
| Together | `together` | `TOGETHER_API_KEY` | |
| GitHub | `github` | `GITHUB_TOKEN` | Free tier |
| Ollama | `ollama` | — | Free, runs locally (e.g. `llama3.1`) |
| vLLM | `vllm` | — | Serves open models at `http://localhost:8000` |
| LiteLLM proxy | `litellm` | — | Any backend via local proxy (`http://localhost:4000`) |
| Mock | `mock` | — | Offline deterministic mode for demos/tests |

Model specs use `provider/model` syntax, e.g. `models.coder: "ollama/llama3.1"`.
Set any model to `mock` to run that task offline.

The default config uses `litellm` with a Qwen coder model, an Anthropic planner,
a DeepSeek reviewer, and an Ollama fallback. To go fully free and local:

```yaml
provider: ollama
models:
  planner:  ollama/llama3.1
  coder:    ollama/llama3.1
  reviewer: ollama/llama3.1
```

## Safety

- **Workspace boundary** — every file operation is resolved inside the project
  directory; writes outside the workspace are rejected.
- **Protected paths** — `.ssh`, `.aws`, `.config`, `.git`, credentials files,
  and the `.luicode` directory itself cannot be modified.
- **Command guard** — shell commands are classified `safe` / `modify` /
  `blocked`. Blocked commands never run; modifying commands require approval
  unless you configured a whitelist match (e.g. `npm test*`). Whitelist
  entries are **prefix matches**: a trailing `*` is stripped (so `npm test*`
  behaves the same as `npm test`), and any command starting with the entry is
  allowed — `npm test*` also matches `npm test --coverage`.
- **Secret redaction** — anything that looks like an API key is redacted
  (`sk-***`) before project content is sent to a model.
- **`--review`** — scans changed files (or the workspace in non-git projects)
  for leaked secrets and risky patterns, and reports a severity summary.

## Development

```bash
npm run build      # tsc → dist/
npm run typecheck  # tsc --noEmit
npm test           # jest
```

Public API is exported from `src/index.ts` (`Workspace`, `Agent`,
`ModelRouter`, `SecurityScanner`, `DiffEngine`, `SessionManager`, …) so LUICode
can be embedded in other tools.

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
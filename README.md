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

### 2. Create a user config (recommended)

Create `~/.luicode/config.yaml` (or `.json`) to set your preferred provider and
models once, globally:

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
over the built-in defaults.

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

LUICode will inspect the workspace and print a plan (writing it to `plan.md`)
without modifying any source files. If it responds successfully, your provider
and API key are configured correctly.

---

## Usage

```bash
luicode                      Launch the interactive terminal UI
luicode --plan [task]        Inspect the project and generate a plan (writes plan.md only)
luicode --auto "task"        Autonomous dev mode (safe permissions by default)
luicode --auto=safe "task"   Autonomous mode, safe permission level
luicode --auto=full "task"   Autonomous mode, full workspace autonomy
luicode --resume             Resume the last interrupted session (picker when several exist)
luicode --resume "task"      Run a task, continuing an earlier session
luicode --review             Review working-tree changes + security scan
luicode --version            Show version
luicode --help               Show help
```

### Interactive TUI

Run `luicode` in a terminal inside your project. Type a task such as
"How long does the diff engine take on a million-line file? Optimize it if
needed." and press Enter.

Shortcuts:

| Key | Action |
| --- | --- |
| `Ctrl+C` | Cancel the running task (press again to exit) |
| `Ctrl+P` | Toggle the plan panel |
| `Ctrl+D` | Toggle the diff panel |
| `Ctrl+T` | Toggle the terminal/command panel |
| `Ctrl+A` | Toggle the activity panel |
| `Ctrl+O` | Toggle automode (manual ↔ autonomous) |
| `Ctrl+L` | Clear the screen |
| `Y` / `N` | Approve / reject a command approval prompt |
| `Esc`   | Exit |

**Plan approval (checkboxes):** when a plan is up for approval in `manual`
mode, use `↑`/`↓` to move, `Space` to toggle a single step, `A` to select all
steps, `Enter` to approve, and `N` / `Esc` to reject. Skipped steps stay out
of the run.

The status bar shows the session mode, the model assigned to each role, and
running token/cost usage; a spinner and progress indicator keep you informed
while the agent thinks, plans, or retries a fix.

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

LUICode merges settings from, in order:

1. `~/.luicode/config.yaml` (or `config.json`) — global user settings
2. `<project>/.luicode/config.yaml` (or `config.json`) — per-project settings
3. Built-in defaults (`config/default.yaml` in the LUICode install)

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

### Providers

| Provider | Kind | API key env var | Notes |
| --- | --- | --- | --- |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | Claude models |
| OpenAI | `openai` | `OPENAI_API_KEY` | |
| Google Gemini | `gemini` | `GEMINI_API_KEY` | |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | Many models |
| Groq | `groq` | `GROQ_API_KEY` | Fast/cheap |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | |
| Qwen (DashScope) | `qwen` | `DASHSCOPE_API_KEY` | qwen-coder-plus |
| Together | `together` | `TOGETHER_API_KEY` | |
| GitHub Models | `github` | `GITHUB_TOKEN` | Free tier |
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
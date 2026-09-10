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

## Usage

```bash
luicode                      Launch the interactive terminal UI
luicode --plan [task]        Inspect the project and generate a plan (no file changes)
luicode --auto "task"        Autonomous dev mode (safe permissions by default)
luicode --auto=safe "task"   Autonomous mode, safe permission level
luicode --auto=full "task"   Autonomous mode, full workspace autonomy
luicode --resume             Resume the last interrupted session
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
| `Y` / `N` | Approve / reject a plan or command approval prompt |
| `Esc`   | Exit |

When stdin is not a TTY (piped or CI), LUICode runs in plain line mode instead
of rendering the terminal UI.

### Static websites (vanilla HTML/CSS/JS)

LUICode auto-detects static web projects (an `index.html` with no JS framework
manifest) and web-intent tasks. For those it generates `index.html`, `style.css`,
and `script.js` in the project root, skips `npm test`/build steps entirely, and
never creates `.ts` files:

```bash
luicode --auto "create a responsive website about Luicode"
# → + index.html, + style.css, + script.js (only)
```

### Autonomy levels

| Mode | Behavior |
| --- | --- |
| `manual` (default) | LUICode plans, then asks before executing the plan and before risky shell commands |
| `safe` | Plans are auto-approved; file writes must be inside the workspace; command-guard whitelist still applies |
| `full` | Everything runs without prompts (use with caution) |

`--auto` maps to `safe`; `--auto=full` grants full workspace autonomy.

### Workflow

1. **Inspect** — LUICode reads the project (package.json, source layout, tests).
2. **Plan** — A plan of steps is produced; shown for approval in manual mode.
3. **Build** — File edits are applied with per-file diffs.
4. **Test** — The test command runs; failures drive the fix loop (up to a
   configured iteration budget).
5. **Build** — A compile/build step catches type or syntax errors.
6. **Review** — A final summary lists what changed. Use `luicode --review` any
   time for an independent security/health scan.

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
```

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
  unless you configured a whitelist match (e.g. `npm test*`).
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
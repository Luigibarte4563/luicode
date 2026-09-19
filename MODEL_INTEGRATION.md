# Model Integration Setup

LUICode talks to large language models through a small, pluggable **provider layer**. This
guide walks through configuring, registering, and verifying model integrations so the planner,
coder, reviewer, and fallback tasks talk to the models you want.

> **New in this repo:** the recommended way to configure models per project is
> `.luicode/settings.lock.json` (copy `.luicode.example/` → `.luicode/`). See
> **MODEL_SETUP.md** — a step-by-step guide with ready-to-paste examples for
> Claude, OpenAI, Ollama, OpenRouter, Groq, DeepSeek, and custom endpoints. This
> file covers the underlying provider layer and the `luicode model` CLI in depth.

---

## 1. Quick start

```bash
# 1) See what is configured and which providers are available
luicode model list

# 2) Pick a provider that is already known (env key still required)
luicode model set-default openai

# 3) Route the "coder" task to a specific model
luicode model set coder openai/gpt-4o-mini

# 4) Verify the connection end-to-end (provider + model + API key)
luicode model test openai/gpt-4o-mini
```

After any `luicode model ...` change, the effective config is written to
`~/.luicode/config.yaml` (or — when `--local` is passed — to
`.luicode/settings.lock.json` if present, otherwise `.luicode/config.yaml`
in the current project).

---

## 2. Provider concepts

Each integration is identified by a **provider name** and an optional **model**:

```
provider/model
openai/gpt-4o-mini
ollama/llama3.1
```

- **Provider** — an API gateway/client implementation. LUICode ships with
  `anthropic`, `openai`, `gemini`, `openrouter`, `groq`, `deepseek`, `qwen`,
  `together`, `ollama`, `vllm`, `github`, `litellm`, and `mock`.
- **Model** — the model identifier sent to that provider. When omitted, a provider
  default is used (e.g. `gpt-4o-mini` for OpenAI, `llama3.1` for Ollama).
- **Task kinds** — four roles that each route to their own model:
  - `planner` — analyzes the project and produces an implementation plan
  - `coder` — executes file changes and runs tools
  - `reviewer` — reviews changes/tests
  - `fallback` — supplier used when the primary provider is unreachable

Default routing:

| Task     | Default model                      |
| -------- | ---------------------------------- |
| planner  | `anthropic/claude-3-5-sonnet-latest` |
| coder    | `qwen/qwen-coder-plus`             |
| reviewer | `deepseek/deepseek-chat`           |
| fallback | `ollama/llama3.1`                  |

### Provider kinds

| Kind        | Protocol                                       | Examples                        |
| ----------- | ---------------------------------------------- | ------------------------------- |
| `openai`    | OpenAI-compatible `/chat/completions` (Bearer) | OpenAI, OpenRouter, Groq, DeepSeek, Qwen, Together, vLLM, litellm |
| `anthropic` | Anthropic `/v1/messages` (x-api-key)           | Anthropic                       |
| `ollama`    | Ollama `/api/chat` (no auth)                   | Ollama, LM Studio-compatible    |
| `gemini`    | OpenAI-compatible endpoint over Gemini         | Google Gemini                   |

`freeTier` (OpenRouter, Groq, DeepSeek, Qwen, Together, GitHub) and `local`
(Ollama, vLLM, litellm, mock) providers need no paid key or can run entirely
offline.

---

## 3. API keys

LUICode **never commits API keys to the repository**. For built-in providers the key is
read from the environment:

| Provider   | Environment variable        |
| ---------- | --------------------------- |
| Anthropic  | `ANTHROPIC_API_KEY`         |
| OpenAI     | `OPENAI_API_KEY`            |
| Gemini     | `GEMINI_API_KEY`            |
| OpenRouter | `OPENROUTER_API_KEY`        |
| Groq       | `GROQ_API_KEY`              |
| DeepSeek   | `DEEPSEEK_API_KEY`          |
| Qwen       | `DASHSCOPE_API_KEY`         |
| Together   | `TOGETHER_API_KEY`          |
| GitHub     | `GITHUB_TOKEN`              |

```bash
# Windows PowerShell
$env:OPENAI_API_KEY = "sk-..."
register-session variable  # or setx OPENAI_API_KEY sk-...
```

When a provider is missing its key, LUICode reports `key: OPENAI_API_KEY` in
`luicode model list`. The `MockProvider` needs no key and lets the whole pipeline
run offline.

---

## 4. The `luicode model` command

| Command                     | What it does                                        |
| --------------------------- | --------------------------------------------------- |
| `luicode model list`        | Show task routing + all providers and key status    |
| `luicode model add <name>`  | Register a custom provider                          |
| `luicode model set-default <name>` | Set the active provider                      |
| `luicode model set <task> <provider/model>` | Route one task to a model   |
| `luicode model test <provider/model>` | Ping a provider+key+model combination  |
| `luicode model help`        | Print the command reference                         |

Inside the interactive TUI the same routing is available without the CLI:

- `/model <task> <provider/model>` — route one task to a model on the fly
  (same persistence as `luicode model set`).
- `/model <provider/model>` — set the coder model for the current task, or
  `/model coder <provider/model>` to name the role explicitly.
- `/models` (or `Ctrl+M`) — interactive **model manager**: two panes (roles on
  the left, providers on the right). `Tab` hops panes, `↑↓`/`j`/`k` navigate,
  `Enter`/`U` apply a provider to the selected role, `T` writes the change and
  **tests the connection in place** (a spinner while it pings, a toast with the
  result), `D` marks the selected role for set-default, `Esc` closes without
  changes.
- `--model <spec>` on the `luicode` command line routes the coder role for that
  run only, e.g. `luicode --model openai/gpt-4o-mini "…"`.

All routes go through the same `ModelRouter` + `config`-writing layer, so it
does not matter whether you use the CLI, a slash command, or the interactive
manager.

### Registering a custom (OpenAI-compatible) provider

Any OpenAI-compatible endpoint can be integrated without code changes:

```bash
luicode model add myproxy \
  --base-url https://proxy.example.com/v1 \
  --api-key sk-... \
  --model llama-3.1-70b

luicode model test myproxy/llama-3.1
luicode model set coder myproxy/llama-3.1
luicode model set-default myproxy
```

- `--base-url` is required for providers that are not already known.
- `--api-key` is optional; known providers prefer their env var, but a
  config-level key is used as a fallback. Consider exporting the env var instead.
- `--local` writes the change to `.luicode/settings.lock.json` when that file
  exists, otherwise `.luicode/config.yaml`, in the current project (handy for
  per-project integration) instead of the user-level config.

### Testing a connection

`luicode model test` sends a minimal request (`"Reply with the single word OK."`) with
a short timeout and reports latency and the model's reply:

```bash
luicode model test openai/gpt-4o-mini
luicode model test ollama/llama3.1 --timeout 60000
luicode model test myproxy/llama-3.1 --api-key sk-test --base-url https://proxy.example/v1
```

Flags on `test` are applied only for the test run — they are never persisted.

### Fallbacks

If the primary provider fails, LUICode tries the providers listed (in order) in
`fallbackOrder` in the config. Local/offline providers avoid surprises:

```yaml
fallbackOrder:
  - litellm
  - anthropic
  - openai
  - openrouter
  - groq
  - deepseek
  - qwen
  - ollama
```

Set `provider: mock` to force fully offline operation.

---

## 5. Configuration files

Config is resolved by deep-merging, lowest to highest priority:

1. Built-in defaults (`config/default.yaml`)
2. `~/.luicode/settings.lock.json` — user-level model lock
3. `~/.luicode/config.yaml` or `.json` — user-level (written by `luicode model ...`)
4. `.luicode/settings.lock.json` — **project model lock (highest priority)**
5. `.luicode/config.yaml` or `.json` — per-project overrides

`settings.lock.json` always wins and is the idiomatic place to commit-readable
model/provider meta per project (copy `.luicode.example/settings.lock.json`).
With `--local`, `luicode model ...` writes to `.luicode/settings.lock.json`
when it exists — otherwise to `.luicode/config.yaml`. For a repository team,
keep both files *provider meta* only (no keys) and leave secrets in env vars or
the user-level config:

```yaml
# ~/.luicode/config.yaml
provider: myproxy

models:
  planner: anthropic/claude-3-5-sonnet-latest
  coder: myproxy/llama-3.1
  reviewer: deepseek/deepseek-chat
  fallback: ollama/llama3.1

providers:
  myproxy:
    baseUrl: https://proxy.example.com/v1
    model: llama-3.1-70b
```

```jsonc
// <project>/.luicode/settings.lock.json — model lock, template in .luicode.example/
{
  "provider": "anthropic",
  "models": {
    "planner":  "anthropic/claude-sonnet-4-20250514",
    "coder":    "anthropic/claude-sonnet-4-20250514",
    "reviewer": "anthropic/claude-sonnet-4-20250514",
    "fallback": "ollama/llama3.1"
  },
  "providers": {},
  "fallbackOrder": ["ollama", "anthropic"],
  "auto": { "mode": "manual", "workspaceOnly": true }
}
```

> Tip: for a repository team, keep `.luicode/config.yaml` *provider meta* only
> (no keys) and leave secrets in env vars or the user-level config.

---

## 6. Local / self-hosted

### Ollama

```bash
ollama pull llama3.1
luicode model set-default ollama
luicode model test ollama/llama3.1
```

### LiteLLM proxy

```bash
litellm --model gpt-4o-mini --port 4000
luicode model set-default litellm
luicode model test litellm/gpt-4o-mini
```

### vLLM

```bash
luicode model add vllm --base-url http://localhost:8000/v1 --model default
luicode model test vllm/default
```

---

## 7. Troubleshooting

| Symptom                                  | Fix                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `key: OPENAI_API_KEY` in `model list`    | Export/set the env var, or register the provider with `--api-key`.   |
| `HTTP 401` in `model test`               | Wrong or missing key for that provider.                              |
| `HTTP 404` in `model test`               | Wrong `--base-url` or model id; confirm the endpoint path.           |
| Timeout / `ECONNREFUSED` (Ollama/litellm) | Ensure the local service is running on the expected port.            |
| Unknown provider error                   | Register it first: `luicode model add <name> --base-url <url>`.      |
| Want offline/CI without keys             | `luicode model set-default mock`.                                    |

---

## 8. Security notes

- API keys are only stored inside config files under your home directory (or — with
  `--local` — in a project config under `.luicode/` that you should keep out of version control).
- `luicode model test` and `luicode model add` accept keys on the command line; on
  multi-user machines prefer setting the environment variable instead.
- Keep `.luicode/` out of git unless the config is key-free: add
  `git rm -r --cached .luicode 2>/dev/null` guardrails or a `.gitignore` entry.

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
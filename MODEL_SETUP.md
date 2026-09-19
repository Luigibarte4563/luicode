# Model Integration Setup

This guide walks through configuring LUICode to talk to your preferred LLM
provider using the `.luicode/settings.lock.json` pattern.

---

## Quick start (30 seconds)

```bash
# 1  Copy the example config into your project
cp -r .luicode.example .luicode

# 2  Set your Anthropic API key (Claude)
export ANTHROPIC_API_KEY="sk-ant-..."

# 3  Verify the connection
luicode model test anthropic/claude-sonnet-4-20250514

# 4  Run LUICode — everything just works
luicode
```

No other setup is required. LUICode reads `.luicode/settings.lock.json`
automatically on startup.

---

## 1. How the config system works

LUICode merges settings from four files, in order (lowest to highest priority):

| Priority | File | Scope |
| -------- | ---- | ----- |
| 1 | Built-in defaults (`config/default.yaml`) | Shipped with the install |
| 2 | `~/.luicode/settings.lock.json` | User-level, all projects |
| 3 | `~/.luicode/config.yaml` | User-level, all projects |
| 4 | `.luicode/settings.lock.json` | **This project only** |
| 5 | `.luicode/config.yaml` | This project only |

**`settings.lock.json` always wins.** Use it to pin model versions and
provider settings that should not change during normal development. The
`.lock` suffix signals "this file is intentional" — treat it like a lockfile.

> **Rule of thumb:** put provider meta and model pins in `settings.lock.json`.
> Put non-model config (terminal, agent, sandbox) in `config.yaml`.

---

## 2. Create the `.luicode` folder

LUICode does not create this folder for you — you opt in by creating it.

```bash
# From the project root:
cp -r .luicode.example .luicode
```

The directory structure after copying:

```
your-project/
  .luicode/
    settings.lock.json    <-- edit this file
```

> **Do not commit `.luicode/`** — it is already in `.gitignore`.

---

## 3. Configure a provider

Open `.luicode/settings.lock.json` and edit the fields you need.

### Anthropic (Claude) — recommended

```json
{
  "provider": "anthropic",
  "models": {
    "planner":  "anthropic/claude-sonnet-4-20250514",
    "coder":    "anthropic/claude-sonnet-4-20250514",
    "reviewer": "anthropic/claude-sonnet-4-20250514",
    "fallback": "ollama/llama3.1"
  },
  "providers": {},
  "fallbackOrder": ["ollama", "anthropic", "openai"],
  "auto": {
    "mode": "manual",
    "workspaceOnly": true
  }
}
```

```bash
export ANTHROPIC_API_KEY="sk-ant-api03-..."
```

### OpenAI

```json
{
  "provider": "openai",
  "models": {
    "planner":  "openai/gpt-4o",
    "coder":    "openai/gpt-4o-mini",
    "reviewer": "openai/gpt-4o",
    "fallback": "ollama/llama3.1"
  },
  "providers": {},
  "fallbackOrder": ["ollama", "openai"],
  "auto": {
    "mode": "manual",
    "workspaceOnly": true
  }
}
```

```bash
export OPENAI_API_KEY="sk-..."
```

### Fully local with Ollama (no API key)

```json
{
  "provider": "ollama",
  "models": {
    "planner":  "ollama/llama3.1",
    "coder":    "ollama/llama3.1",
    "reviewer": "ollama/llama3.1",
    "fallback": "ollama/llama3.1"
  },
  "providers": {},
  "fallbackOrder": ["ollama"],
  "auto": {
    "mode": "manual",
    "workspaceOnly": true
  }
}
```

```bash
# Install Ollama, then:
ollama pull llama3.1
```

### OpenRouter (many models, one key)

```json
{
  "provider": "openrouter",
  "models": {
    "planner":  "openrouter/anthropic/claude-sonnet-4-20250514",
    "coder":    "openrouter/meta-llama/llama-3.3-70b-instruct",
    "reviewer": "openrouter/anthropic/claude-sonnet-4-20250514",
    "fallback": "ollama/llama3.1"
  },
  "providers": {},
  "fallbackOrder": ["ollama", "openrouter"],
  "auto": {
    "mode": "manual",
    "workspaceOnly": true
  }
}
```

```bash
export OPENROUTER_API_KEY="sk-or-..."
```

### Groq (fast, free tier)

```json
{
  "provider": "groq",
  "models": {
    "planner":  "groq/llama-3.3-70b-versatile",
    "coder":    "groq/llama-3.3-70b-versatile",
    "reviewer": "groq/llama-3.3-70b-versatile",
    "fallback": "ollama/llama3.1"
  },
  "providers": {},
  "fallbackOrder": ["ollama", "groq"],
  "auto": {
    "mode": "manual",
    "workspaceOnly": true
  }
}
```

```bash
export GROQ_API_KEY="gsk_..."
```

### DeepSeek

```json
{
  "provider": "deepseek",
  "models": {
    "planner":  "deepseek/deepseek-chat",
    "coder":    "deepseek/deepseek-chat",
    "reviewer": "deepseek/deepseek-chat",
    "fallback": "ollama/llama3.1"
  },
  "providers": {},
  "fallbackOrder": ["ollama", "deepseek"],
  "auto": {
    "mode": "manual",
    "workspaceOnly": true
  }
}
```

```bash
export DEEPSEEK_API_KEY="..."
```

### Custom OpenAI-compatible endpoint

```json
{
  "provider": "myproxy",
  "models": {
    "planner":  "myproxy/llama-3.1-70b",
    "coder":    "myproxy/llama-3.1-70b",
    "reviewer": "myproxy/llama-3.1-70b",
    "fallback": "ollama/llama3.1"
  },
  "providers": {
    "myproxy": {
      "baseUrl": "https://proxy.example.com/v1",
      "model": "llama-3.1-70b"
    }
  },
  "fallbackOrder": ["ollama"],
  "auto": {
    "mode": "manual",
    "workspaceOnly": true
  }
}
```

API keys for custom providers go in `settings.lock.json` under
`providers.<name>.apiKey` — but prefer environment variables on shared
machines:

```bash
# Option A: environment variable (recommended)
export MYPROXY_API_KEY="..."

# Option B: settings.lock.json (local only)
# Add "apiKey": "..." inside providers.myproxy
```

---

## 4. Verify the connection

```bash
luicode model list              # shows routing + provider status
luicode model test <provider/model>   # pings the provider
```

Example:

```bash
luicode model test anthropic/claude-sonnet-4-20250514
# OK anthropic/claude-sonnet-4-20250514 (423 ms): OK
```

If you see `key: ANTHROPIC_API_KEY` in `model list`, the env var is missing.

---

## 5. Use the CLI to change models

All CLI changes write to `~/.luicode/config.yaml` by default. Pass `--local`
for project scope — it writes to `.luicode/settings.lock.json` when that file
exists (this project has it), otherwise `.luicode/config.yaml`.

```bash
luicode model set coder openai/gpt-4o-mini          # user scope
luicode model set coder openai/gpt-4o-mini --local  # project scope → settings.lock.json
luicode model set-default anthropic
luicode model add myproxy --base-url http://localhost:8000/v1 --model default
```

Inside the interactive TUI:

- `Ctrl+M` — open the model manager (visual, no CLI needed)
- `/model coder anthropic/claude-sonnet-4-20250514` — change on the fly

---

## 6. Task roles

| Role | Purpose | What to set |
| ---- | ------- | ----------- |
| `planner` | Analyzes the project, produces a step plan | Best with a strong reasoning model (Claude, GPT-4o) |
| `coder` | Executes file edits and runs tools | Fast + accurate (Claude, GPT-4o-mini, Qwen-coder) |
| `reviewer` | Reviews diffs and runs security scan | Strong reasoning model |
| `fallback` | Used when the primary provider is unreachable | A free/local model (Ollama) |

---

## 7. `settings.lock.json` reference

```jsonc
{
  // Active provider name — must match a key in PROVIDER_REGISTRY or providers
  "provider": "anthropic",

  // Model specs in "provider/model" format, keyed by task role
  "models": {
    "planner":  "anthropic/claude-sonnet-4-20250514",
    "coder":    "anthropic/claude-sonnet-4-20250514",
    "reviewer": "anthropic/claude-sonnet-4-20250514",
    "fallback": "ollama/llama3.1"
  },

  // Custom / override provider configs (optional)
  "providers": {
    // "myproxy": { "baseUrl": "...", "model": "...", "apiKey": "..." }
  },

  // Providers tried in order when the primary is unreachable
  "fallbackOrder": ["ollama", "anthropic"],

  // Autonomy settings
  "auto": {
    "mode": "manual",          // "manual" | "safe" | "full"
    "workspaceOnly": true
  }
}
```

All fields are optional — any missing key falls through to built-in defaults.

---

## 8. Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `key: ANTHROPIC_API_KEY` in `model list` | `export ANTHROPIC_API_KEY="sk-ant-..."` |
| `HTTP 401` in `model test` | Wrong or missing API key |
| `HTTP 404` in `model test` | Wrong model ID or base URL |
| Timeout / `ECONNREFUSED` (Ollama) | Ensure `ollama serve` is running on port 11434 |
| Want offline / CI without keys | Set `"provider": "mock"` in settings.lock.json |
| Config changes not taking effect | Check file priority — `settings.lock.json` overrides `config.yaml` |

---

## 9. Security

- **Never commit `.luicode/`** — it may contain API keys. It is in `.gitignore`.
- Prefer environment variables for API keys on shared/CI machines.
- `settings.lock.json` under `providers.<name>.apiKey` is read locally only.
- The `luicode model test` command accepts `--api-key` on the command line;
  on multi-user machines, use env vars instead.

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
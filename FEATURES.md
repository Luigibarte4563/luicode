# LUICode — Complete Features Reference

LUICode is a **local gateway for agentic coding** that runs your favorite coding agents against a unified catalog of provider models — free tiers, subscriptions, and local servers — from one configurable proxy with a browser-based Admin UI.

---

## Core Architecture

| Component | Description |
|-----------|-------------|
| **luicode-server** | Single local gateway process (FastAPI + Uvicorn) |
| **Admin UI** | Browser-based management at `http://127.0.0.1:8082/admin` |
| **Launchers** | `luicode-claude`, `luicode-codex`, `luicode-pi`, `luicode-opencode`, `luicode-cline`, `luicode-hermes`, `luicode-dsh`, `luicode-grok`, `luicode-muse`, `luicode-aider` |
| **Protocol Adapters** | Anthropic Messages, OpenAI Responses, OpenAI Chat Completions |
| **Loopback-only** | Admin UI binds to `127.0.0.1` / `::1` — no external access |

---

## Provider Catalog (53+ Providers)

### Cloud Providers (API Key)
- **NVIDIA NIM** — `nvidia_nim/nvidia/nemotron-3-super-120b-a12b`
- **OpenRouter** — `open_router/openrouter/free`
- **Groq** — `groq/llama-3.3-70b-versatile`
- **ClinePass** — `cline_pass/cline-pass/kimi-k3`
- **xAI (Grok)** — `xai/grok-4.5`
- **QwenCloud Token Plan** — `qwencloud/qwen3.7-plus`
- **QwenCloud Coding Plan** — `qwencloud_coding/qwen3.7-plus`
- **Together AI** — `together/zai-org/GLM-5.2`
- **DeepInfra** — `deepinfra/deepseek-ai/DeepSeek-V4-Flash`
- **SiliconFlow** — `siliconflow/Qwen/Qwen3-32B`
- **Nebius Token Factory** — `nebius/Qwen/Qwen3-30B-A3B`
- **Chutes** — `chutes/Qwen/Qwen3-32B-TEE`
- **Featherless AI** — `featherless/Qwen/Qwen3-32B`
- **Agnes AI** — `agnes/agnes-2.0-flash`
- **ZenMux** — `zenmux/deepseek/deepseek-v4-flash-free`
- **W&B Inference** — `wandb/openai/gpt-oss-20b`
- **Azure OpenAI** — `azure_openai/<deployment-name>`
- **Google AI Studio (Gemini)** — `gemini/models/gemini-3.1-flash-lite`
- **Google Vertex AI** — `vertex/google/gemini-3.5-flash`
- **DeepSeek** — `deepseek/deepseek-chat`
- **Mistral La Plateforme** — `mistral/devstral-small-latest`
- **Mistral Codestral** — `mistral_codestral/codestral-latest`
- **OpenCode Zen** — `opencode_zen/gpt-5.3-codex`
- **OpenCode Go** — `opencode_go/minimax-m2.7`
- **Vercel AI Gateway** — `vercel/openai/gpt-5.5`
- **Amazon Bedrock** — `bedrock/openai.gpt-oss-120b`
- **Hugging Face Inference** — `huggingface/Qwen/Qwen3-Coder-480B-A35B-Instruct:fastest`
- **Cohere** — `cohere/command-a-plus-05-2026`
- **Wafer** — `wafer/DeepSeek-V4-Pro`
- **Kimi API** — `kimi/kimi-k2.5`
- **Kimi Code** — `kimi_code/k3`
- **MiniMax** — `minimax/MiniMax-M3`
- **Cerebras Inference** — `cerebras/gpt-oss-120b`
- **SambaNova** — `sambanova/Meta-Llama-3.3-70B-Instruct`
- **Kilo.ai** — `kilo/kilo-auto/free`
- **Fireworks AI** — `fireworks/accounts/fireworks/models/llama-v3p3-70b-instruct`
- **Novita AI** — `novita/deepseek/deepseek-v4-flash-0731`
- **Cloudflare Workers AI** — `cloudflare/@cf/moonshotai/kimi-k2.6`
- **Z.ai Coding Plan** — `zai/glm-5.2`
- **Z.ai API** — `zai_api/glm-4.7-flash`
- **TokenRouter** — `tokenrouter/moonshotai/kimi-k3-free`
- **NaraRoute** — `nararoute/kimi-k3-free`
- **Poolside AI** — `poolside/poolside/laguna-s-2.1`
- **LLM7.io** — `llm7/default`
- **Scaleway** — `scaleway/deepseek/deepseek-v4-flash`
- **Lightning AI** — `lightning/lightning-ai/Qwen3.8-27B`
- **Experiential Labs** — `experiential/union-alpha`
- **Ollama Cloud** — `ollama_cloud/qwen3-coder:480b`

### OAuth / Connected Account Providers
- **OpenAI / ChatGPT** — Uses ChatGPT subscription via OAuth (device/browser flow)
- **GitHub Copilot** — Uses GitHub account + Copilot subscription via GitHub CLI

### Local Providers (No API Key)
- **LM Studio** — `lmstudio/<model-id>` (default `http://localhost:1234/v1`)
- **llama.cpp** — `llamacpp/<model-id>` (default `http://localhost:8080/v1`)
- **Ollama** — `ollama/<model-tag>` (default `http://localhost:11434`)

---

## Model Routing & Fallbacks

### Unified Model Catalog
- Single `MODEL` setting acts as fallback for **every** request
- Per-tier overrides: `MODEL_FABLE`, `MODEL_OPUS`, `MODEL_SONNET`, `MODEL_HAIKU`
- Each override can use a **different provider**
- **Ordered fallback list** via `MODEL_FALLBACKS` — applies globally across all clients
- Automatic retry through fallbacks when primary model fails (rate limit, timeout, error)

### Model Discovery
- Automatic model listing from configured providers
- Searchable combobox in Admin UI with custom slug support
- Manual model entry: `<provider-id>/<exact-provider-model-id>`
- Refresh button to re-discover models

---

## Reasoning Control

| Setting | Values | Behavior |
|---------|--------|----------|
| `REASONING_POLICY` (root) | `client` (default), `off`, `low`, `medium`, `high`, `xhigh`, `max` | Global reasoning effort |
| `REASONING_FABLE` | `inherit` (default), `client`, `off`, `low`...`max` | Override for Fable tier |
| `REASONING_OPUS` | `inherit`, `client`, `off`, `low`...`max` | Override for Opus tier |
| `REASONING_SONNET` | `inherit`, `client`, `off`, `low`...`max` | Override for Sonnet tier |
| `REASONING_HAIKU` | `inherit`, `client`, `off`, `low`...`max` | Override for Haiku tier |

- **From client** (default): Uses effort sent by the coding agent
- **Off**: Requests reasoning disabled
- **Low–Max**: Overrides client with selected level
- **Inherit** (tiers only): Uses root `REASONING_POLICY`
- Provider-specific translation handled automatically

---

## Web Tools (Built-in)

| Tool | Description | Configuration |
|------|-------------|---------------|
| **web_search** | Local web search via configured search provider | `ENABLE_WEB_SERVER_TOOLS=true` (default) |
| **web_fetch** | Fetch and extract content from URLs | `WEB_FETCH_ALLOWED_SCHEMES=http,https` |
| **Automatic Web Search** | Detects when agents need search, executes locally | Built-in heuristic + domain filtering |

### Web Fetch Security
- **Egress policy**: Blocks private/link-local IPs by default
- `WEB_FETCH_ALLOW_PRIVATE_NETWORKS=false` (lab only)
- Configurable allowed URL schemes

---

## Token-Saving Optimizations (Up to 90% fewer terminal-output tokens)

| Optimization | Setting | Description |
|--------------|---------|-------------|
| **Network Probe Mock** | `ENABLE_NETWORK_PROBE_MOCK=true` | Intercepts connectivity checks, returns synthetic response |
| **Title Generation Skip** | `ENABLE_TITLE_GENERATION_SKIP=true` | Skips "Conversation title" requests |
| **Suggestion Mode Skip** | `ENABLE_SUGGESTION_MODE_SKIP=true` | Skips suggestion/completion-only requests |
| **Filepath Extraction Mock** | `ENABLE_FILEPATH_EXTRACTION_MOCK=true` | Extracts filepaths locally without provider call |
| **RTK Integration** | Optional extra | Filters common command output (ls, grep, etc.) |

All enabled by default. Each optimization targets a specific Anthropic/Claude Code token pattern.

---

## Code Sessions (Browser-Based)

Native **Codex sessions in your browser** with real-time and background support:

| Feature | Description |
|---------|-------------|
| **Folder picker** | Native OS dialog to choose working directory |
| **Real-time streaming** | Live token streaming via Server-Sent Events |
| **Background runs** | Continue sessions after closing browser tab |
| **Session persistence** | SQLite-backed, survives restarts |
| **Model switching** | Change provider/model mid-session |
| **Harness switching** | Switch between Codex, OpenCode, etc. (coming soon) |
| **Search & filter** | Query by text, provider, model |
| **Resume / Delete** | Full session lifecycle management |
| **Native history recovery** | Reconciles with Codex native conversation history |

### Architecture
- **Server-owned** — Sessions independent of HTTP/browser lifetime
- **Event-driven** — Real-time updates via subscription (SSE)
- **Optimistic locking** — Revision-based concurrency control
- **Graceful shutdown** — Waits for active turns, persists state

---

## Editor & IDE Integrations

| Integration | Target | Configuration |
|-------------|--------|---------------|
| **Claude Code in VS Code** | VS Code extension | Sets URL, token, enables model discovery |
| **Codex in VS Code & App** | Codex extension + desktop app | Configures Codex to use luicode |
| **Claude Code in JetBrains ACP** | JetBrains IDEs via ACP | Routes Claude Code through luicode |
| **Claude Code in App** | Claude Desktop app | Sets luicode as gateway |

### Workflow
1. Click **Connect** in Admin UI → Integrations tab
2. Dialog shows files that will be modified
3. Confirm → Reload/restart target application
4. Select luicode model from picker
5. **Disconnect** removes integration cleanly

---

## Messaging Integrations

### Discord Bot
- Bot token + allowed channels + allowed directory
- Requires **Message Content Intent** + **Manage Messages** permission
- `/stats`, `/stop`, `/clear` commands

### Telegram Bot
- Bot token + allowed user ID + allowed directory
- Requires delete message permission in groups
- Same command set as Discord

### Voice Notes (Optional)
| Backend | Install Flag | Requirements |
|---------|--------------|--------------|
| **NVIDIA NIM Whisper** | `--voice-nim` | `NVIDIA_NIM_API_KEY` |
| **Local Whisper (CPU/CUDA)** | `--voice-local` | `uv sync --extra voice_local` |
| **Both** | `--voice-all` | Both sets of deps |

- Enable in Admin UI → Messaging → Voice
- Select device: `cpu`, `cuda`, or `nvidia_nim`
- Choose Whisper model (local) or NIM model (cloud)

---

## Browser Automation (Optional)

Enable coding agents to **navigate, click, fill forms, extract data** from web pages.

| Aspect | Details |
|--------|---------|
| **Engine** | Chrome DevTools Protocol via `browser-harness` (same as JEV-Ultrafast) |
| **Install** | `uv sync --extra browser` |
| **Requirements** | Chrome/Chromium with remote debugging (managed automatically) |
| **Capabilities** | Navigate, Observe (indexed elements), Click, Fill, Select, Scroll, Wait, Multi-step tasks |
| **API** | `BrowserToolsPort` protocol in application layer |
| **Runtime** | `BrowserToolsClient` handles CDP sessions, DOM snapshots, staleness detection |

```python
from luicode.application.browser_tools.ports import BrowserToolsPort

async def my_handler(browser_tools: BrowserToolsPort):
    await browser_tools.navigate("https://example.com")
    state = await browser_tools.observe()
    await browser_tools.click(node_id=5)
    await browser_tools.fill(node_id=3, text="search query")
    await browser_tools.wait()
```

---

## Supported Coding Agents (10)

| Agent | Launcher | Notes |
|-------|----------|-------|
| **Claude Code** | `luicode-claude` | Full Messages API support |
| **Codex** | `luicode-codex` | OpenAI Responses API |
| **Pi** | `luicode-pi` | Anthropic-compatible |
| **OpenCode 2** | `luicode-opencode` | Native upgrade supported |
| **Cline** | `luicode-cline` | VS Code extension |
| **Hermes** | `luicode-hermes` | Nous Research |
| **DeepSeek Harness** | `luicode-dsh` | Web-based |
| **Grok Build** | `luicode-grok` | xAI |
| **Muse Code** | `luicode-muse` | Meta |
| **Aider** | `luicode-aider` | Terminal-based |

---

## Admin UI Features

### Navigation (5 Views)
| View | Path | Purpose |
|------|------|---------|
| **Providers** | `/admin` | Configure cloud, local, OAuth providers |
| **Model Config** | `/admin/model_config` | Select models, reasoning, web tools |
| **Messaging** | `/admin/messaging` | Discord, Telegram, Voice |
| **Integrations** | `/admin/integrations` | VS Code, JetBrains, Claude Desktop |
| **Code Sessions** | `/admin/code` | Browse, search, manage sessions |

### Provider Management
- **Responsive card grid** (260px min, auto-fill columns)
- **Three sections**: OAuth, Cloud, Local (each with Configured/Not Configured)
- **Status pills**: Connected, Not configured, Model count, Checking, Error
- **Actions**: Configure, Manage, Edit, Test (local), Refresh models

### Model Config
- **Model combobox** — Searchable, custom slugs, "None" option
- **Fallback editor** — Ordered list with move/remove
- **Reasoning controls** — Per-tier dropdowns
- **Web tools toggles** — Enable/disable per optimization

### Apply & Restart
- **Dirty state tracking** — Shows unsaved changes count
- **Validation** — Checks API keys, required fields
- **Hot-reload** — Applies without restart when possible
- **Restart handling** — Auto-reconnect or manual "Reconnect" button
- **Pending restart banner** — Shows which fields require restart

---

## Security

- **Loopback-only binding** — Admin UI inaccessible from network
- **Proxy authentication** — Optional bearer token (`PROXY_AUTH_ENABLED`)
- **Secret masking** — API keys hidden in UI, stored in managed environment
- **No external dependencies** — All processing local
- **Configurable logging** — Redacted payloads by default

---

## Installation & Management

### Install
```bash
# macOS/Linux
curl -fsSL "https://raw.githubusercontent.com/Luigibarte4563/luicode/main/scripts/install.sh" | sh

# Windows PowerShell
& ([scriptblock]::Create((irm "https://raw.githubusercontent.com/Luigibarte4563/luicode/main/scripts/install.ps1")))
```

### Optional Extras
```bash
# Browser automation
uv sync --extra browser

# Voice (local Whisper)
uv sync --extra voice_local

# Voice (NVIDIA NIM)
uv sync --extra voice
```

### Update
```bash
luicode-update
```

### Uninstall
```bash
# macOS/Linux
curl -fsSL "https://raw.githubusercontent.com/Luigibarte4563/luicode/main/scripts/uninstall.sh" | sh

# Windows PowerShell
& ([scriptblock]::Create((irm "https://raw.githubusercontent.com/Luigibarte4563/luicode/main/scripts/uninstall.ps1")))
```

---

## Technical Details

### API Endpoints
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/admin` | GET | Admin page (HTML) |
| `/admin/assets/{version}/{file}` | GET | Static assets (versioned) |
| `/admin/api/config` | GET | Current config |
| `/admin/api/config/apply` | POST | Apply changes |
| `/admin/api/status` | GET | Server status |
| `/admin/api/providers/{id}/test` | POST | Test provider |
| `/admin/api/providers/{id}/auth` | GET | OAuth status |
| `/admin/api/providers/{id}/auth/login` | POST | Start OAuth |
| `/admin/api/integrations/*` | GET/POST | Integration status/connect |
| `/admin/api/models` | GET | Discovered models |
| `/admin/api/models/refresh` | POST | Refresh models |
| `/admin/api/code/*` | GET/POST/WS | Code sessions |
| `/v1/messages` | POST | Anthropic Messages API |
| `/v1/responses` | POST | OpenAI Responses API |
| `/v1/chat/completions` | POST | OpenAI Chat Completions |

### Performance
- **Static assets**: Versioned URLs with long-term caching
- **Admin page**: `Cache-Control: no-store` (always fresh)
- **API calls**: `cache: "no-store"` on all fetches
- **Comboboxes**: Single shared instance per field, lazy render
- **OAuth polling**: 1s interval, auto-cleanup
- **Startup polling**: 500ms, backs off when tab hidden

### Browser Support
| Feature | Minimum |
|---------|---------|
| CSS Grid | Chrome 57, Firefox 52, Safari 10.1, Edge 16 |
| CSS Custom Properties | Chrome 49, Firefox 31, Safari 9.1, Edge 16 |
| `dialog` element | Chrome 37, Firefox 53, Safari 15.4, Edge 79 |
| `focus-visible` | Chrome 86, Firefox 85, Safari 15.4, Edge 86 |
| `aspect-ratio` | Chrome 88, Firefox 89, Safari 15, Edge 88 |

All features degrade gracefully.

---

## Configuration Reference

### Core Settings
```bash
# Server
HOST=0.0.0.0
PORT=8082
LUICODE_OPEN_BROWSER=true

# Proxy Auth
PROXY_AUTH_ENABLED=false
ANTHROPIC_AUTH_TOKEN=luicode

# Default Model (provider/model format)
MODEL=zai/glm-5.2

# Fallbacks (comma-separated)
MODEL_FALLBACKS=open_router/openrouter/free,groq/llama-3.3-70b-versatile

# Per-tier Overrides
MODEL_FABLE=
MODEL_OPUS=
MODEL_SONNET=
MODEL_HAIKU=
```

### Reasoning
```bash
REASONING_POLICY=client      # client, off, low, medium, high, xhigh, max
REASONING_FABLE=inherit      # inherit, client, off, low...
REASONING_OPUS=inherit
REASONING_SONNET=inherit
REASONING_HAIKU=inherit
```

### Optimizations
```bash
ENABLE_NETWORK_PROBE_MOCK=true
ENABLE_TITLE_GENERATION_SKIP=true
ENABLE_SUGGESTION_MODE_SKIP=true
ENABLE_FILEPATH_EXTRACTION_MOCK=true
```

### Web Tools
```bash
ENABLE_WEB_SERVER_TOOLS=true
WEB_FETCH_ALLOWED_SCHEMES=http,https
WEB_FETCH_ALLOW_PRIVATE_NETWORKS=false
```

### Provider Rate Limiting
```bash
PROVIDER_RATE_LIMIT=1
PROVIDER_RATE_WINDOW=2
PROVIDER_MAX_CONCURRENCY=2
PROVIDER_PROGRESS_TIMEOUT=600.0
```

### HTTP Timeouts
```bash
HTTP_READ_TIMEOUT=120.0
HTTP_WRITE_TIMEOUT=10.0
HTTP_CONNECT_TIMEOUT=5.0
```

### Voice
```bash
VOICE_NOTE_ENABLED=true
WHISPER_DEVICE=cpu          # cpu, cuda, nvidia_nim
WHISPER_MODEL=base          # tiny, base, small, medium, large-v2, large-v3, large-v3-turbo
```

### Messaging
```bash
MESSAGING_PLATFORM=discord  # telegram, discord, none
MESSAGING_RATE_LIMIT=1
MESSAGING_RATE_WINDOW=1.0
TELEGRAM_BOT_TOKEN=
ALLOWED_TELEGRAM_USER_ID=
DISCORD_BOT_TOKEN=
ALLOWED_DISCORD_CHANNELS=
ALLOWED_DIR=
```

---

## Adding a New Provider

1. Add entry to `PROVIDER_CATALOG` in `src/luicode/config/provider_catalog.py`
2. Add logo to `src/luicode/api/admin_static/providers/`
3. Implement provider client in `src/luicode/providers/<name>/`
4. Register factory in `src/luicode/providers/runtime/factory.py`
5. Tests auto-verify asset serving and model discovery

---

## Adding a New Integration

1. Add dialog markup to `src/luicode/api/admin_static/index.html`
2. Add state object in `src/luicode/api/admin_static/admin.js`
3. Implement `renderXxxIntegration()` + `refreshXxxIntegration()`
4. Add API endpoints in `src/luicode/api/admin_routes.py`
5. Add button handlers and file modification logic

---

## Project Links

- **Repository**: https://github.com/Luigibarte4563/luicode
- **Issues**: https://github.com/Luigibarte4563/luicode/issues
- **Contributing**: CONTRIBUTING.md
- **Product E2E Tests**: smoke/README.md
- **License**: MIT (see LICENSE)

---

*LUICode is an independent open-source project. Not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.*
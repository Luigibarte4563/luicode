# LUICode Admin UI — Complete Guide

## Overview

The LUICode Admin UI is a local-only web interface for managing model providers, integrations, messaging, and code sessions. It runs on `http://127.0.0.1:<port>/admin` (default port 8082) and is accessible only from loopback addresses for security.

---

## Getting Started

### Starting the Admin Server

```bash
uv run luicode-server --port 8082
```

Then open `http://127.0.0.1:8082/admin` in your browser.

### Navigation

The sidebar provides access to five views:

| View | Path | Purpose |
|------|------|---------|
| **Providers** | `/admin` | Configure cloud, local, and OAuth providers |
| **Model Config** | `/admin/model_config` | Select models, reasoning, web tools |
| **Messaging** | `/admin/messaging` | Configure messaging integrations |
| **Integrations** | `/admin/integrations` | Connect editors (VS Code, JetBrains, etc.) |
| **Code Sessions** | `/admin/code` | Browse and manage code sessions |

---

## Providers Tab — Grid Layout

### Card Grid

Providers are displayed in a responsive card grid:
- **Desktop**: 2–5 columns (auto-fill, min 260px)
- **Tablet**: 1–2 columns
- **Mobile**: Single column

Each card shows:
1. **Provider logo** (32×32, never squeezed)
2. **Provider name** — links to provider website (no underline)
3. **Description** — hint text about the provider
4. **Status pill** — "connected", "not configured", "82 models available", etc.
4. **Action button** — "Configure", "Manage", or "Edit" (pinned to bottom)

### Grouping

Providers are organized into three sections:
- **OAuth providers** — GitHub Copilot, etc. (show "Connected" / "Not connected")
- **Cloud providers** — OpenAI, Anthropic, etc. (show "Configured" / "Not configured")
- **Local providers** — LM Studio, Ollama, llama.cpp (show "Configured" / "Not configured")

Each section has **CONFIGURED** and **NOT CONFIGURED** subsections with counts.

### Actions

| Button | When Visible | Action |
|--------|--------------|--------|
| **Configure** | Not configured, has settings | Opens provider dialog to enter API key |
| **Manage** | Configured, has settings | Opens dialog to edit settings |
| **Edit** | OAuth, connected | Opens dialog to edit shared settings |
| **Test** | Local providers | Checks local endpoint reachability |
| **Refresh models** | Any configured | Triggers model discovery |

---

## Model Config Tab

### Sections

1. **Models** — Select which models luicode routes to; configure fallbacks
2. **Reasoning** — Control reasoning effort, budgets, visibility
3. **Web Tools** — Configure browsing, search, and code execution tools

### Model Combobox

- Searchable dropdown with all discovered models
- Supports custom slugs (type to create)
- "None" option for optional fields
- Keyboard navigation: ↑/↓ to select, Enter to confirm, Esc to close

---

## Messaging Tab

Configure messaging integrations (Telegram, Discord, etc.) with:
- Bot tokens
- Allowed users/chats
- Voice settings (when voice dependencies installed)

---

## Integrations Tab

Connect luicode to your editors and coding agents. Four integration cards:

| Integration | Target | Configuration |
|-------------|--------|---------------|
| **Claude Code in VS Code** | VS Code extension | Sets URL, token, enables model discovery |
| **Codex in VS Code and App** | Codex extension + desktop app | Configures Codex to use luicode |
| **Claude Code in JetBrains ACP** | JetBrains IDEs via ACP | Routes Claude Code through luicode |
| **Claude Code in App** | Claude Desktop app | Sets luicode as gateway |

### Card Layout

Each card has:
- **Title** + description
- **Status** — "Connect" or "Disconnect" button
- **Files to modify** — shown in dialog before confirming
- **Dialog** — confirms action, lists affected config files

### Workflow

1. Click **Connect** (or **Retry** if error)
2. Dialog shows files that will be modified
3. Click **Connect** in dialog
4. Reload/restart target application as instructed

---

## Code Sessions Tab

Browse, search, and manage code sessions:
- **Search** — Filter by query, provider, model
- **List** — Paginated session cards with metadata
- **Actions** — View, resume, delete sessions

---

## Provider Dialog

Opened via "Configure"/"Manage"/"Edit" buttons. Contains:

1. **Fields** — All settings for the provider (API keys, base URLs, etc.)
2. **Shared field notice** — If a field is shared with other providers
3. **Test button** — For local/cloud providers (checks connectivity)
4. **Save/Cancel** — Apply or discard changes

### Field Types

| Type | UI | Notes |
|------|-----|-------|
| `secret` | Password input, masked | Shows "Configured" when set |
| `text` | Text input | Standard string |
| `number` | Number input | With min/max validation |
| `boolean` | Checkbox | True/false |
| `select` | Dropdown | Predefined options |
| `model` / `optional_model` | Combobox | Model search with custom slugs |
| `model_list` | Multi-select editor | Ordered fallback models |

---

## Applying Changes

### Dirty State

The footer shows:
- **No changes** — Clean state
- **N unsaved changes** — Modified fields count
- **Changes saved** — After successful apply

### Apply Button

Click **Apply** to:
1. Validate all changed fields
2. Check API keys (for secret fields)
3. Write to managed environment
4. Hot-reload if possible, or schedule restart

### Restart Handling

- **Automatic restart** — Server restarts, UI reconnects
- **Manual restart** — "Reconnect" button appears
- **Pending restart** — Banner shows which fields need restart

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Tab` / `Shift+Tab` | Navigate focusable elements |
| `Enter` / `Space` | Activate buttons/links |
| `Esc` | Close dialogs, comboboxes |
| `↑` / `↓` | Navigate combobox options |
| `Ctrl+Shift+R` | Hard refresh (clears cache) |

---

## Troubleshooting

### Provider Not Showing

1. Check provider is enabled in catalog
2. Verify API key is valid (use Test button)
3. Check logs: `luicode-server --port 8082` output

### Model Discovery Failing

1. Click **Refresh models** in Model Config
2. Check provider status in Providers tab
3. Verify network connectivity to provider API

### Integration Not Working

1. Open Integrations tab
2. Click **Connect** → check dialog for errors
3. Verify target app config files are writable
4. Fully quit and reopen target application

### UI Not Updating

1. Hard refresh: `Ctrl+Shift+R`
2. Check browser console for JS errors
3. Restart luicode-server

---

## Security Notes

- Admin UI binds to **loopback only** (127.0.0.1 / ::1)
- No external access possible
- All config changes require local access
- Secrets masked in UI, stored in managed env

---

## File Locations

| Asset | Path |
|-------|------|
| Admin HTML | `src/luicode/api/admin_static/index.html` |
| Styles | `src/luicode/api/admin_static/admin.css` |
| Main JS | `src/luicode/api/admin_static/admin.js` |
| Form controls | `src/luicode/api/admin_static/form_controls.js` |
| Model combobox | `src/luicode/api/admin_static/model_combobox.js` |
| Provider logos | `src/luicode/api/admin_static/providers/*.svg` |
| Wordmark logo | `src/luicode/api/admin_static/luicode-wordmark-dark.svg` |
| Favicon | `src/luicode/assets/app-icon.svg` |
| Routes | `src/luicode/api/admin_routes.py` |
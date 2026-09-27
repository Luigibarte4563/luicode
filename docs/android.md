# Running luicode on Android (Termux)

This guide covers installing and running luicode on Android using **Termux** (F-Droid build).

## Prerequisites

- Android 10 or later
- **Termux** installed from [F-Droid](https://f-droid.org/packages/com.termux/) (not the abandoned Play Store build)
- Optional: **Termux:API** and **Termux:Boot** add-ons from F-Droid for background persistence and notifications
- No root required

## Installation

1. Open Termux and run the standard installer:

```sh
curl -fsSL https://raw.githubusercontent.com/Luigibarte4563/luicode/main/scripts/install.sh | sh
```

The installer will detect Termux automatically and:
- Install Python, Node.js, and uv via `pkg install`
- Skip systemd/launchctl/tray-icon logic (not applicable on Android)
- Skip unsupported components (Hermes Agent, Muse Code, local Whisper, browser automation)
- Install luicode and selected coding agents (Claude Code, Codex, OpenCode, etc.)

## Running the Server

### Foreground (default)

```sh
luicode-server
```

The server will start and print the Admin UI URL (e.g., `http://127.0.0.1:8080`). Open this in Chrome/Firefox on the same device.

### Keeping the Server Alive (Background)

Android aggressively kills background processes. To keep `luicode-server` running:

1. **Acquire a wake lock** (prevents CPU suspend):
   ```sh
   termux-wake-lock
   luicode-server
   ```
   Release with `termux-wake-unlock` when done.

2. **Disable battery optimization for Termux**:
   - Settings → Apps → Termux → Battery → **Unrestricted**
   - This is required for the server to survive screen-off beyond a few minutes.

3. **Optional: Termux:Boot for auto-start on device boot**
   - Install Termux:Boot from F-Droid
   - Create `~/.termux/boot/luicode-server` with:
     ```sh
     #!/bin/sh
     termux-wake-lock
     exec luicode-server
     ```
   - Make it executable: `chmod +x ~/.termux/boot/luicode-server`

4. **Optional: Termux:API for persistent notification**
   - Install Termux:API from F-Droid
   - Shows a notification while the server runs, letting you stop it from the shade
   - Example wrapper script:
     ```sh
     #!/bin/sh
     termux-wake-lock
     termux-notification --id luicode --title "luicode Server" --content "Running on port 8080" --ongoing
     luicode-server
     termux-notification-remove luicode
     termux-wake-unlock
     ```

## Accessing the Admin UI

### From the same device (localhost)

The Admin UI is available at `http://127.0.0.1:<port>`. Open it directly in your browser, or use:
```sh
termux-open-url http://127.0.0.1:8080
```

### From another device on the same LAN

To configure luicode from a laptop while the phone runs the server:

1. Bind to all interfaces (add to `~/.luicode/.env`):
   ```env
   LUICODE_HOST=0.0.0.0
   ```

2. **Security warning**: This exposes the Admin UI and API to your LAN. **Enable Proxy Authentication**:
   ```env
   ANTHROPIC_AUTH_TOKEN=your-secure-random-token
   ```
   Then configure clients to send `Authorization: Bearer your-secure-random-token`.

3. Find your phone's LAN IP (e.g., `192.168.1.42`) and access `http://192.168.1.42:8080` from the other device.

## Supported Coding Agents on Android

| Agent | Status | Notes |
|-------|--------|-------|
| Claude Code (`luicode-claude`) | ✅ Supported | Node.js-based, works via Termux `nodejs` package |
| Codex (`luicode-codex`) | ✅ Supported | Node.js-based, works via Termux `nodejs` package |
| OpenCode (`luicode-opencode`) | ✅ Supported | Go binary, works on Android |
| Pi (`luicode-pi`) | ✅ Supported | Node.js-based |
| Cline (`luicode-cline`) | ✅ Supported | Node.js-based |
| DeepSeek Harness (`luicode-dsh`) | ✅ Supported | Node.js-based |
| Grok Build (`luicode-grok`) | ✅ Supported | Node.js-based |
| Aider (`luicode-aider`) | ✅ Supported | Python-based, installed via uv |
| Hermes Agent | ❌ Not supported | No ARM64 Linux release for Termux |
| Muse Code | ❌ Not supported | No Android/Termux support |

## Unsupported Features on Android

| Feature | Reason | Alternative |
|---------|--------|-------------|
| Local Whisper transcription (`--voice-local`) | No feasible CPU/CUDA Whisper on Android | Use **NVIDIA NIM remote transcription** (enabled by default) |
| Browser automation (`browser` extra) | No embeddable Chromium in Termux | Not available on Android |
| Desktop app / tray icon | No desktop environment | Use Termux session + browser |

## Messaging Integrations (Discord/Telegram)

These work as long as the Python process stays alive. Apply the same persistence measures as the server (wake lock, battery exemption, Termux:Boot).

## Upgrading

Re-run the installer:
```sh
curl -fsSL https://raw.githubusercontent.com/Luigibarte4563/luicode/main/scripts/install.sh | sh
```

Or use `luicode-update` once installed.

## Uninstalling

```sh
curl -fsSL https://raw.githubusercontent.com/Luigibarte4563/luicode/main/scripts/uninstall.sh | sh
```

This removes the luicode uv tool and `~/.luicode/` config directory. It does not remove Termux packages (Python, Node.js, uv) or coding agent CLIs.

## Troubleshooting

### Server dies when screen turns off
- Ensure **battery optimization is disabled** for Termux (Unrestricted)
- Ensure **wake lock is held** (`termux-wake-lock`)
- Check that Termux:Boot script is working if using auto-start

### `luicode-server` not found after install
- Run `uv tool update-shell` and restart Termux, or
- Add `~/.local/bin` to PATH in `~/.bashrc` / `~/.zshrc`

### Python version issues
- Termux's `pkg install python` provides Python 3.11+ (3.14 when available)
- The installer uses the system Python on Termux, not a uv-managed Python

### Network access from LAN not working
- Verify `LUICODE_HOST=0.0.0.0` is set
- Check Android firewall / VPN settings
- Ensure both devices are on the same network (not guest/isolation mode)
- Enable `ANTHROPIC_AUTH_TOKEN` for security

## Acceptance Criteria Checklist

- [ ] Fresh Termux install → `curl ... | sh` completes without error
- [ ] No systemd/launchctl/tray assumptions in output
- [ ] `luicode-server` starts and prints Admin UI URL
- [ ] Admin UI reachable at `http://127.0.0.1:<port>` from device browser
- [ ] `luicode-claude` and `luicode-codex` connect and complete a round-trip
- [ ] Server survives 10+ minutes screen-off with wake-lock + battery exemption
- [ ] Attempting `--voice-local` prints clear "not supported on Android" message
- [ ] Attempting to use browser extra fails with clear explanation
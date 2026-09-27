# Running luicode on Android (Termux)

This guide covers installing and running luicode on Android using **Termux** (F-Droid build).

## Prerequisites

- Android 10 or later
- **Termux** installed from [F-Droid](https://f-droid.org/packages/com.termux/) (not the abandoned Play Store build)
- Python 3.14 or newer (the installer upgrades it for you with `pkg upgrade python`)
- Optional: **Termux:API** and **Termux:Boot** add-ons from F-Droid for background persistence and notifications
- No root required

## Installation

Open Termux and run one command:

```sh
curl -fsSL https://raw.githubusercontent.com/Luigibarte4563/luicode/main/scripts/install.sh | sh
```

The installer detects Termux automatically and:

1. Prints a banner with the detected Termux version.
2. Refuses to run as root.
3. Runs `pkg update -y` and `pkg upgrade -y`, then installs only the packages
   you are actually missing (`python`, `git`, `curl`).
4. Detects `python` or `python3` and confirms it satisfies the 3.14 minimum.
5. Upgrades pip, tolerating Termux builds that refuse a global pip upgrade.
6. Clones the repository into `~/.luicode-src` (or `git pull --ff-only` if it
   is already there). If the checkout has uncommitted changes it warns and
   skips the update rather than discarding your work.
7. Installs the package with `pip install -e .`.
8. Adds the console-script directory to `PATH` from `~/.bashrc` or `~/.zshrc`,
   inside one managed block:

   ```sh
   # >>> LUICode PATH >>>
   # Managed by the luicode installer; changes inside this block are overwritten.
   export PATH="/data/data/com.termux/files/usr/bin:$PATH"
   # <<< LUICode PATH <<<
   ```

9. Verifies that `luicode` and `luicode-server` resolve on `PATH` and run
   `--version`, then prints the web interface URL.

`~/.luicode-src` is deliberately **not** `~/.luicode`: `~/.luicode` is your live
configuration and data directory (`.env`, `code.db`, `logs/`, `auth/`), and
`scripts/uninstall.sh` deletes it. Keeping the checkout separate means
uninstalling can never destroy your source or your settings.

### After installing

Open a **new** Termux session so the updated `PATH` is loaded, then:

```sh
luicode          # alias for luicode-server
luicode-server   # start the gateway
```

Add `--dry-run` to see every step without changing anything.

## Running the Server

### Foreground (default)

```sh
luicode-server
```

The server prints the Admin UI URL. With the default settings that is
<http://127.0.0.1:8082/admin> (built-in defaults: `HOST=0.0.0.0`, `PORT=8082`).
Set `PORT` in `~/.luicode/.env` to change it, and the installer will report the
resulting URL on the next run.

### Keeping the Server Alive (Background)

Android aggressively kills background processes. To keep `luicode-server` running:

1. **Acquire a wake lock** (prevents CPU suspend):
   ```sh
   termux-wake-lock
   luicode-server
   ```
   Release with `termux-wake-unlock` when done. The installer never runs
   `termux-wake-lock` for you; it only prints this as an optional tip.

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
     termux-notification --id luicode --title "luicode Server" --content "Running on port 8082" --ongoing
     luicode-server
     termux-notification-remove luicode
     termux-wake-unlock
     ```

## Accessing the Admin UI

### From the same device (localhost)

The Admin UI is available at `http://127.0.0.1:8082/admin`. Open it directly in
your browser, or use:
```sh
termux-open-url http://127.0.0.1:8082/admin
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

3. Find your phone's LAN IP (e.g., `192.168.1.42`) and access `http://192.168.1.42:8082` from the other device.

## Supported Coding Agents on Android

The one-command Termux install covers the gateway. Coding agents are installed
separately, and each has its own Android support status:

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

## Updating

Re-run the same one-line installer:

```sh
curl -fsSL https://raw.githubusercontent.com/Luigibarte4563/luicode/main/scripts/install.sh | sh
```

It runs `git pull --ff-only` and re-installs the package. Reruns are safe: the
`PATH` block is replaced rather than duplicated, packages that are already
present are not reinstalled, and your configuration and data are never touched.

## Uninstalling

```sh
# Remove the Python package
pip uninstall luicode

# Optionally remove the source checkout
rm -rf ~/.luicode-src
```

Then remove the managed block from `~/.bashrc` or `~/.zshrc`:

```sh
# >>> LUICode PATH >>>
...
# <<< LUICode PATH <<<
```

> **Note:** `scripts/uninstall.sh` targets the uv tool install used on
> Linux/macOS. It does not remove a pip install, so on Termux use
> `pip uninstall luicode` as shown above. Neither path deletes `~/.luicode`;
> remove that yourself if you want your configuration and data gone.

## Troubleshooting

### Server dies when screen turns off
- Ensure **battery optimization is disabled** for Termux (Unrestricted)
- Ensure **wake lock is held** (`termux-wake-lock`)
- Check that Termux:Boot script is working if using auto-start

### `luicode-server: command not found` after install
- Open a **new** Termux session so the updated `PATH` is loaded
- Confirm the managed block exists: `grep -A2 'LUICode PATH' ~/.bashrc`
- Confirm the entry points exist: `ls "$(python -m site --user-base)/bin"` or
  `$PREFIX/bin`
- Re-run the installer; it re-verifies both commands and reports the real error

### `luicode: command not found`
- `luicode` is an alias for `luicode-server`; both come from the same install
- Re-run the installer and read the verification step

### Python version issues
- LUICode requires Python 3.14 or newer
- The installer refuses to continue on an older interpreter and tells you to run
  `pkg upgrade python`
- If pip is missing, run `pkg reinstall python`

### Installer says the repository has uncommitted changes
- Commit or stash them, then rerun. The installer deliberately skips the update
  instead of discarding your edits.

### Network access from LAN not working
- Verify `LUICODE_HOST=0.0.0.0` is set
- Check Android firewall / VPN settings
- Ensure both devices are on the same network (not guest/isolation mode)
- Enable `ANTHROPIC_AUTH_TOKEN` for security

## Acceptance Criteria Checklist

- [ ] Fresh Termux install → `curl ... | sh` completes without error
- [ ] Source checkout lives in `~/.luicode-src`, not `~/.luicode`
- [ ] `command -v luicode` and `command -v luicode-server` both resolve in a new session
- [ ] `luicode --version` and `luicode-server --version` both succeed
- [ ] `~/.bashrc` (or `~/.zshrc`) has exactly one `# >>> LUICode PATH >>>` block
- [ ] `luicode-server` starts and prints Admin UI URL
- [ ] Admin UI reachable at `http://127.0.0.1:8082/admin` from device browser
- [ ] Rerunning the installer pulls instead of cloning and adds no duplicate PATH block
- [ ] `luicode-claude` and `luicode-codex` connect and complete a round-trip
- [ ] Server survives 10+ minutes screen-off with wake-lock + battery exemption
- [ ] Attempting `--voice-local` prints clear "not supported on Android" message
- [ ] Attempting to use browser extra fails with clear explanation

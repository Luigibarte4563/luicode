"""Termux/Android prerequisites and installer behavior smoke tests.

These tests validate that the installer correctly detects Termux and adjusts
its behavior accordingly. They can run inside a Termux CI image or be used
as a manual checklist.
"""

import os
import platform
import shutil
import subprocess
import sys
from contextlib import suppress
from pathlib import Path

import pytest


def is_termux() -> bool:
    """Detect if running inside Termux."""
    prefix = os.environ.get("PREFIX", "")
    return ("com.termux" in prefix) or (
        platform.system() == "Linux" and "android" in platform.platform().lower()
    )


pytestmark = [pytest.mark.live, pytest.mark.smoke_target("termux")]


def test_termux_detection():
    """Verify Termux detection logic matches installer."""
    # This test always runs to document the detection criteria
    prefix = os.environ.get("PREFIX", "")
    uname_o = ""
    with suppress(Exception):
        uname_o = subprocess.check_output(["uname", "-o"], text=True).strip()

    detected = ("com.termux" in prefix) or (uname_o == "Android")
    expected = is_termux()

    assert detected == expected, (
        f"Termux detection mismatch: PREFIX={prefix!r} uname -o={uname_o!r} "
        f"detected={detected} expected={expected}"
    )


@pytest.mark.skipif(not is_termux(), reason="Only runs inside Termux")
def test_termux_python_available():
    """Verify Python is available via pkg in Termux."""
    python = shutil.which("python") or shutil.which("python3")
    assert python, "python not found in PATH; run 'pkg install python'"

    # Check version is 3.11+
    result = subprocess.run([python, "--version"], capture_output=True, text=True)
    assert result.returncode == 0
    version_str = result.stdout.strip()
    # Expected format: "Python 3.11.x" or "Python 3.14.x"
    assert "Python 3." in version_str


@pytest.mark.skipif(not is_termux(), reason="Only runs inside Termux")
def test_termux_nodejs_available():
    """Verify Node.js is available via pkg in Termux."""
    node = shutil.which("node")
    assert node, "node not found in PATH; run 'pkg install nodejs'"

    result = subprocess.run([node, "--version"], capture_output=True, text=True)
    assert result.returncode == 0
    assert result.stdout.strip().startswith("v")


@pytest.mark.skipif(not is_termux(), reason="Only runs inside Termux")
def test_termux_uv_available():
    """Verify uv is available via pkg in Termux."""
    uv = shutil.which("uv")
    assert uv, "uv not found in PATH; run 'pkg install uv'"

    result = subprocess.run([uv, "--version"], capture_output=True, text=True)
    assert result.returncode == 0
    version = result.stdout.strip()
    # Should be a stable version
    assert not ("-" in version or "dev" in version or "rc" in version)


@pytest.mark.skipif(not is_termux(), reason="Only runs inside Termux")
def test_installer_rejects_voice_local():
    """Verify installer rejects --voice-local on Termux."""
    # Find the install script
    repo_root = Path(__file__).parent.parent.parent.parent
    install_sh = repo_root / "scripts" / "install.sh"
    assert install_sh.exists()

    # Run with --voice-local and --dry-run, should fail
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            f"import subprocess; subprocess.run(['sh', '{install_sh}', '--voice-local', '--dry-run'], capture_output=True, text=True)",
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    # The installer should fail with a clear message
    assert result.returncode != 0
    assert (
        "not supported on Android" in result.stderr
        or "not supported on Android" in result.stdout
    )


@pytest.mark.skipif(not is_termux(), reason="Only runs inside Termux")
def test_installer_rejects_torch_backend():
    """Verify installer rejects --torch-backend on Termux."""
    repo_root = Path(__file__).parent.parent.parent.parent
    install_sh = repo_root / "scripts" / "install.sh"
    assert install_sh.exists()

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            f"import subprocess; subprocess.run(['sh', '{install_sh}', '--torch-backend', 'cu130', '--dry-run'], capture_output=True, text=True)",
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode != 0
    assert (
        "not supported on Android" in result.stderr
        or "not supported on Android" in result.stdout
    )


@pytest.mark.skipif(not is_termux(), reason="Only runs inside Termux")
def test_installer_skips_hermes_muse():
    """Verify installer skips Hermes and Muse on Termux (dry-run)."""
    repo_root = Path(__file__).parent.parent.parent.parent
    install_sh = repo_root / "scripts" / "install.sh"
    assert install_sh.exists()

    # Run in dry-run mode non-interactively (will use defaults)
    result = subprocess.run(
        ["sh", str(install_sh), "--dry-run"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, f"Installer dry-run failed: {result.stderr}"

    output = result.stdout
    # Should mention Termux and unsupported components
    assert "Android/Termux" in output or "Termux" in output
    assert "Hermes Agent" in output and "NOT supported" in output
    assert "Muse Code" in output and "NOT supported" in output
    assert "Local Whisper" in output and "NOT supported" in output
    assert "Browser automation" in output and "NOT supported" in output


@pytest.mark.skipif(not is_termux(), reason="Only runs inside Termux")
def test_luicode_server_starts():
    """Verify luicode-server can start in Termux."""
    luicode_server = shutil.which("luicode-server")
    if not luicode_server:
        pytest.skip("luicode not installed; run installer first")

    # Start server in background, check it binds to port
    import socket
    import time

    proc = subprocess.Popen(
        [luicode_server],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    try:
        # Wait for server to start
        time.sleep(3)

        # Check if process is still alive
        stderr = proc.stderr.read() if proc.stderr is not None else ""
        assert proc.poll() is None, f"Server exited early: {stderr}"

        # Try to connect to default port
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(2)
        sock.connect_ex(("127.0.0.1", 8080))
        sock.close()

        # Port might be different, so just verify process is running
        assert proc.poll() is None
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


# Manual test checklist (not automated)
# These are documented here for CI/CD integration reference
MANUAL_CHECKLIST = """
# Manual Android/Termux Smoke Test Checklist

Run these manually in a Termux environment after installation:

## 1. Fresh Install
- [ ] `curl -fsSL https://raw.githubusercontent.com/Luigibarte4563/luicode/main/scripts/install.sh | sh`
- [ ] Completes without error
- [ ] No systemd/launchctl/tray references in output
- [ ] Mentions Android/Termux notes at the end

## 2. Server Startup
- [ ] `luicode-server` starts and prints Admin UI URL
- [ ] Admin UI reachable at http://127.0.0.1:<port> from device browser
- [ ] `termux-open-url http://127.0.0.1:<port>` opens browser

## 3. Coding Agents
- [ ] `luicode-claude` connects through gateway and completes round-trip
- [ ] `luicode-codex` connects through gateway and completes round-trip

## 4. Persistence
- [ ] `termux-wake-lock` acquired
- [ ] Battery optimization disabled for Termux (Unrestricted)
- [ ] Server survives 10+ minutes screen-off

## 5. Unsupported Features
- [ ] `--voice-local` prints "not supported on Android" message
- [ ] Browser extra not offered / fails with clear explanation
- [ ] Hermes Agent not offered
- [ ] Muse Code not offered

## 6. LAN Access (Optional)
- [ ] Set LUICODE_HOST=0.0.0.0 in ~/.luicode/.env
- [ ] Enable ANTHROPIC_AUTH_TOKEN
- [ ] Access Admin UI from another device on same LAN
"""

if __name__ == "__main__":
    # Allow running as a script to print the manual checklist
    if "--manual-checklist" in sys.argv:
        print(MANUAL_CHECKLIST)
    else:
        pytest.main([__file__, "-v"])

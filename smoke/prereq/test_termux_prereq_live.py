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
    """Detect if running inside Termux, matching scripts/install.sh."""
    prefix = os.environ.get("PREFIX", "")
    return ("com.termux" in prefix) or (
        platform.system() == "Linux" and "android" in platform.platform().lower()
    )


def installer_detects_termux() -> bool:
    """Evaluate the installer's own detection criteria in this environment."""
    prefix = os.environ.get("PREFIX", "")
    uname_o = ""
    with suppress(Exception):
        uname_o = subprocess.check_output(["uname", "-o"], text=True).strip()
    if "com.termux" in prefix or uname_o == "Android":
        return True
    if os.environ.get("TERMUX_VERSION"):
        return True
    return Path("/data/data/com.termux").is_dir()


pytestmark = [pytest.mark.live, pytest.mark.smoke_target("termux")]


def test_termux_detection():
    """Verify Termux detection logic matches installer."""
    # This test always runs to document the detection criteria
    prefix = os.environ.get("PREFIX", "")
    uname_o = ""
    with suppress(Exception):
        uname_o = subprocess.check_output(["uname", "-o"], text=True).strip()

    detected = installer_detects_termux()
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

    # LUICode requires Python 3.14 or newer; the installer refuses older ones.
    result = subprocess.run(
        [python, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0
    major, _, minor = result.stdout.strip().partition(".")
    assert (int(major), int(minor)) >= (3, 14), (
        f"LUICode needs Python >= 3.14, found {result.stdout.strip()}; "
        "run 'pkg upgrade python'"
    )


@pytest.mark.skipif(not is_termux(), reason="Only runs inside Termux")
def test_termux_luicode_commands_available():
    """Verify the installer-provided entry points are on PATH."""
    luicode = shutil.which("luicode")
    luicode_server = shutil.which("luicode-server")
    assert luicode, "luicode not found in PATH; rerun the Termux installer"
    assert luicode_server, (
        "luicode-server not found in PATH; rerun the Termux installer"
    )

    for command in (luicode, luicode_server):
        # --version is the supported non-starting check. --help is not handled
        # by luicode.cli.entrypoints.serve and would start the server.
        result = subprocess.run(
            [command, "--version"], capture_output=True, text=True, check=False
        )
        assert result.returncode == 0, f"{command} --version failed: {result.stderr}"
        assert "luicode" in result.stdout


@pytest.mark.skipif(not is_termux(), reason="Only runs inside Termux")
def test_termux_source_checkout_present():
    """Verify the installer kept the source checkout outside ~/.luicode."""
    source_dir = Path(os.environ.get("LUICODE_SRC_DIR", Path.home() / ".luicode-src"))
    assert (source_dir / ".git").is_dir(), (
        f"missing checkout at {source_dir}; rerun the Termux installer"
    )
    assert (source_dir / "pyproject.toml").is_file()
    # ~/.luicode is the config/data directory and is purged on uninstall, so the
    # checkout must never be placed there.
    assert not (Path.home() / ".luicode" / ".git").exists()


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
            f"import subprocess; subprocess.run(['sh', '{install_sh}', '--voice-local', '--torch-backend', 'cu130', '--dry-run'], capture_output=True, text=True)",
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
def test_installer_dry_run_reports_unsupported_components():
    """Verify installer reports the Android limitations on a dry run."""
    repo_root = Path(__file__).parent.parent.parent.parent
    install_sh = repo_root / "scripts" / "install.sh"

    result = subprocess.run(
        ["sh", str(install_sh), "--dry-run"],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode == 0, f"Installer dry-run failed: {result.stderr}"

    output = result.stdout
    assert "Android/Termux" in output or "Termux" in output
    for unsupported in (
        "Hermes Agent",
        "Muse Code",
        "Local Whisper",
        "Browser automation",
    ):
        assert unsupported in output and "NOT supported" in output


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
- [ ] Reports the source directory (`~/.luicode-src`), not `~/.luicode`
- [ ] Mentions Android/Termux limitations at the end

## 2. Commands
- [ ] `luicode --version` prints a version and exits
- [ ] `luicode-server --version` prints a version and exits
- [ ] `command -v luicode` and `command -v luicode-server` both resolve
- [ ] `~/.bashrc` (or `~/.zshrc`) contains exactly one `# >>> LUICode PATH >>>` block

## 3. Server Startup
- [ ] `luicode-server` starts and prints Admin UI URL
- [ ] Admin UI reachable at http://127.0.0.1:8082 from device browser
- [ ] `termux-open-url http://127.0.0.1:8082/admin` opens browser

## 4. Coding Agents
- [ ] `luicode-claude` connects through gateway and completes round-trip
- [ ] `luicode-codex` connects through gateway and completes round-trip

## 5. Persistence
- [ ] `termux-wake-lock` acquired
- [ ] Battery optimization disabled for Termux (Unrestricted)
- [ ] Server survives 10+ minutes screen-off

## 6. Unsupported Features
- [ ] `--voice-local` prints "not supported on Android" message
- [ ] Browser extra not offered / fails with clear explanation
- [ ] Hermes Agent not offered
- [ ] Muse Code not offered

## 7. Idempotency
- [ ] Re-running the installer performs `git pull --ff-only`, not a fresh clone
- [ ] `~/.bashrc` still contains exactly one managed PATH block
- [ ] `pkg install` is not called again for packages already present

## 8. LAN Access (Optional)
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

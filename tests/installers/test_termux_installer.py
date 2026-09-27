"""Termux one-command installer scenarios for scripts/install.sh.

These drive the real POSIX installer with a stubbed Termux package manager,
interpreter, and git so the Android flow is covered on any POSIX host. The
Linux/macOS uv tool flow has its own coverage in test_installers.py.
"""

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest

LUICODE_TERMUX_COMMANDS = ("luicode", "luicode-server")
REPO_URL = "https://github.com/Luigibarte4563/luicode.git"
# Everything the Termux path shells out to besides the stubs it provisions.
HERMETIC_TOOLS = (
    "awk",
    "cat",
    "chmod",
    "cp",
    "grep",
    "id",
    "mkdir",
    "mktemp",
    "ps",
    "rm",
    "sed",
    "uname",
)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _write_executable(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    path.chmod(0o755)


def _pkg_command() -> str:
    """Stub `pkg` that provisions the binaries the installer asks for.

    `pkg <subcommand>` only fails for the subcommand the scenario targets so a
    failing upgrade cannot be confused with a failing update.
    """
    return """#!/bin/sh
echo "pkg:$*" >> "$CALL_LOG"
case "$1" in
    update) [ "$FAIL_STEP" = "pkg-update" ] && exit 51; exit 0 ;;
    upgrade) [ "$FAIL_STEP" = "pkg-upgrade" ] && exit 52; exit 0 ;;
    install) ;;
    *) exit 53 ;;
esac
shift
installed=""
for requested in "$@"; do
    case "$requested" in
        -*) continue ;;
    esac
    installed="$installed $requested"
    case "$requested" in
        python)
            [ "$FAIL_STEP" = "pkg-python" ] && exit 54
            cp "$FAKE_FIXTURES/python-command.sh" "$FAKE_BIN_DIR/python"
            chmod +x "$FAKE_BIN_DIR/python"
            ;;
        git)
            [ "$FAIL_STEP" = "pkg-git" ] && exit 55
            cp "$FAKE_FIXTURES/git-command.sh" "$FAKE_BIN_DIR/git"
            chmod +x "$FAKE_BIN_DIR/git"
            ;;
        curl)
            [ "$FAIL_STEP" = "pkg-curl" ] && exit 56
            cp "$FAKE_FIXTURES/curl-command.sh" "$FAKE_BIN_DIR/curl"
            chmod +x "$FAKE_BIN_DIR/curl"
            ;;
    esac
done
printf 'pkg installed:%s\\n' "$installed" >> "$CALL_LOG"
exit 0
"""


def _silent_pkg_command() -> str:
    """Stub `pkg` that reports success but installs nothing."""
    return """#!/bin/sh
echo "pkg:$*" >> "$CALL_LOG"
case "$1" in
    update|upgrade|install) exit 0 ;;
    *) exit 53 ;;
esac
"""


def _git_command() -> str:
    """Stub `git` that creates a fixture checkout instead of hitting GitHub."""
    return """#!/bin/sh
echo "git:$*" >> "$CALL_LOG"
[ "$FAIL_STEP" = "git-clone" ] && exit 61
[ "$FAIL_STEP" = "git-pull" ] && exit 62
if [ "$1" = "clone" ]; then
    shift
    url=$1
    destination=$2
    echo "git-clone:$url -> $destination" >> "$CALL_LOG"
    mkdir -p "$destination/.git" "$destination/src/luicode"
    if [ -z "${LUICODE_FAKE_NO_PYPROJECT:-}" ]; then
        printf '[project]\\nname = "luicode"\\n' > "$destination/pyproject.toml"
    fi
    if [ -n "${LUICODE_FAKE_REQUIREMENTS:-}" ]; then
        : > "$destination/requirements.txt"
    fi
    exit 0
fi
if [ "$1" = "-C" ]; then
    directory=$2
    shift 2
    case "$1" in
        status)
            [ -n "${LUICODE_FAKE_DIRTY:-}" ] && printf ' M src/luicode/cli/commands.py\\n'
            exit 0
            ;;
        pull)
            echo "git-pull:$directory" >> "$CALL_LOG"
            exit 0
            ;;
    esac
fi
exit 63
"""


def _python_command() -> str:
    """Stub the Termux interpreter, pip, and the console-script layout."""
    return """#!/bin/sh
echo "python:$*" >> "$CALL_LOG"
if [ "$1" = "--version" ]; then
    [ "$FAIL_STEP" = "python-version" ] && exit 61
    printf 'Python %s\\n' "$FAKE_PYTHON_VERSION"
    exit 0
fi
if [ "$1" = "-c" ]; then
    case "$2" in
        *sys.version_info*) printf '%s\\n' "$FAKE_PYTHON_VERSION"; exit 0 ;;
        *sysconfig*) printf '%s\\n' "$FAKE_SCRIPTS_DIR"; exit 0 ;;
        *local_admin_url*)
            printf '%s\\n' "$FAKE_PROXY_URL"
            printf '%s\\n' "$FAKE_ADMIN_URL"
            exit 0
            ;;
    esac
    exit 0
fi
if [ "$1" = "-m" ] && [ "$2" = "site" ]; then
    printf '%s\\n' "$FAKE_HOME/.local"
    exit 0
fi
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then
    [ "$FAIL_STEP" = "pip-missing" ] && exit 67
    if [ "$3" = "--version" ]; then
        printf 'pip 24.0\\n'
        exit 0
    fi
    if [ "$FAIL_STEP" = "pip-upgrade" ] && [ "$3" = "install" ] && [ "$4" = "--upgrade" ]; then
        printf 'error: externally-managed-environment\\n' >&2
        exit 1
    fi
    if [ "$FAIL_STEP" = "pip-install" ] && [ "$3" = "install" ] && [ "$4" != "--upgrade" ]; then
        exit 68
    fi
    exit 0
fi
exit 64
"""


def _curl_command() -> str:
    return """#!/bin/sh
echo "curl:$*" >> "$CALL_LOG"
exit 0
"""


def _entry_point(name: str) -> str:
    return f"""#!/bin/sh
if [ "$FAIL_STEP" = "entrypoint-run" ]; then
    printf '{name}: broken\\n' >&2
    exit 65
fi
if [ "${{1:-}}" = "--version" ]; then
    printf 'luicode 3.5.18\\n'
    exit 0
fi
# The installer must only use --version. Anything else starts the server, so
# failing loudly here catches a regression that would hang the install.
printf '{name}: refusing to start\\n' >&2
exit 66
"""


@dataclass
class TermuxHarness:
    root: Path
    bin_dir: Path
    scripts_dir: Path
    home: Path
    log: Path
    env: dict[str, str]

    def calls(self) -> list[str]:
        if not self.log.exists():
            return []
        return self.log.read_text(encoding="utf-8").splitlines()

    def run(self, *args: str, fail_step: str = "") -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["/bin/sh", str(_repo_root() / "scripts" / "install.sh"), *args],
            check=False,
            capture_output=True,
            text=True,
            env=self.env | {"FAIL_STEP": fail_step},
            timeout=120,
        )

    def src_dir(self) -> Path:
        return self.home / ".luicode-src"

    def rc_file(self) -> Path:
        shell = self.env.get("SHELL", "")
        return self.home / (".zshrc" if "zsh" in shell else ".bashrc")

    def truncate_calls(self) -> None:
        if self.log.exists():
            self.log.unlink()

    def reset_pkg(self, text: str) -> None:
        _write_executable(self.bin_dir / "pkg", text)

    def narrow_path(self) -> None:
        """Limit PATH to the stub directory plus the tools the installer needs.

        `shutil.which` resolves against the host PATH, so the real tools are
        linked into the sandbox before PATH is replaced with it.
        """
        tools_dir = self.root / "hermetic-tools"
        tools_dir.mkdir(exist_ok=True)
        for tool in HERMETIC_TOOLS:
            resolved = shutil.which(tool)
            if resolved is None:
                continue
            link = tools_dir / tool
            if link.exists() or link.is_symlink():
                continue
            try:
                link.symlink_to(resolved)
            except OSError:
                shutil.copy2(resolved, link)
        self.env["PATH"] = os.pathsep.join((str(self.bin_dir), str(tools_dir)))

    def _probe_path(self, script: str) -> bool:
        return (
            subprocess.run(
                ["/bin/sh", "-c", script],
                check=False,
                capture_output=True,
                env=self.env | {"FAIL_STEP": ""},
                timeout=60,
            ).returncode
            == 0
        )

    def restrict_path(self) -> bool:
        """Limit PATH to the stub directory plus the tools the installer needs.

        Returns False unless the shell can actually use that PATH, so a caller
        skips instead of asserting on an environment it could not isolate.
        """
        self.narrow_path()
        return self._probe_path(
            "command -v awk >/dev/null 2>&1 && ! command -v git >/dev/null 2>&1"
        )

    def restrict_path_without_python(self) -> bool:
        """Limit PATH so no interpreter resolves outside the stub directory.

        A scenario that deletes the stub `python` only tests the missing-Python
        path when the host interpreter cannot stand in for it. Otherwise
        `command -v python` succeeds, the installer reports Python as already
        installed, never calls `pkg install`, and the scenario silently asserts
        on the wrong code path.

        Unlike `restrict_path`, git and curl stay installed, so this only
        denies the interpreter.

        Returns False unless the shell can actually be denied an interpreter, so
        a caller skips instead of asserting on an environment it could not
        isolate.
        """
        self.narrow_path()
        return self._probe_path(
            "! command -v python >/dev/null 2>&1"
            " && ! command -v python3 >/dev/null 2>&1"
        )


@pytest.fixture
def termux_harness(tmp_path: Path) -> TermuxHarness:
    if os.name == "nt":
        pytest.skip("POSIX installer scenarios run on POSIX hosts")

    bin_dir = tmp_path / "bin"
    fixtures = tmp_path / "fixtures"
    scripts_dir = tmp_path / "termux-prefix" / "bin"
    home = tmp_path / "home"
    log = tmp_path / "calls.log"
    for path in (bin_dir, fixtures, scripts_dir, home):
        path.mkdir(parents=True)

    # Termux's termux-tools bootstrap ships awk, so a deterministic one is put
    # on PATH. procps is also in termux-tools; report no matching processes so
    # the "stop luicode first" check never depends on the host process table.
    _write_executable(bin_dir / "awk", '#!/bin/sh\nexec /usr/bin/awk "$@"\n')
    _write_executable(bin_dir / "ps", "#!/bin/sh\nexit 0\n")
    _write_executable(
        bin_dir / "uname",
        """#!/bin/sh
case "${1:-}" in
    -m) printf 'aarch64\\n' ;;
    -o) printf '%s\\n' "${FAKE_UNAME_O:-Android}" ;;
    *) printf 'Linux\\n' ;;
esac
""",
    )
    for name, text in (
        ("pkg", _pkg_command()),
        ("git", _git_command()),
        ("python", _python_command()),
        ("curl", _curl_command()),
    ):
        _write_executable(bin_dir / name, text)
    # The installer restores these from the fixtures when pkg installs them.
    for name, text in (
        ("python-command.sh", _python_command()),
        ("git-command.sh", _git_command()),
        ("curl-command.sh", _curl_command()),
    ):
        _write_executable(fixtures / name, text)
    for name in LUICODE_TERMUX_COMMANDS:
        _write_executable(scripts_dir / name, _entry_point(name))

    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{bin_dir}:/usr/bin:/bin",
            "HOME": str(home),
            "SHELL": "/bin/bash",
            "PREFIX": "/data/data/com.termux/files/usr",
            "TERMUX_VERSION": "0.118.0",
            "CALL_LOG": str(log),
            "FAKE_BIN_DIR": str(bin_dir),
            "FAKE_FIXTURES": str(fixtures),
            "FAKE_SCRIPTS_DIR": str(scripts_dir),
            "FAKE_HOME": str(home),
            "FAKE_PYTHON_VERSION": "3.14.6",
            "FAKE_PROXY_URL": "http://127.0.0.1:8082",
            "FAKE_ADMIN_URL": "http://127.0.0.1:8082/admin",
            "FAIL_STEP": "",
        }
    )
    for leaked in (
        "XDG_BIN_HOME",
        "XDG_DATA_HOME",
        "UV_TOOL_BIN_DIR",
        "UV_INSTALL_DIR",
        "UV_UNMANAGED_INSTALL",
        "LUICODE_SRC_DIR",
    ):
        env.pop(leaked, None)
    return TermuxHarness(tmp_path, bin_dir, scripts_dir, home, log, env)


def test_fresh_install_provides_both_commands(termux_harness: TermuxHarness):
    result = termux_harness.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert "LUICode Installer for Android" in result.stdout
    assert "Detected Termux 0.118.0 on Android." in result.stdout
    assert "LUICode Installation Complete" in result.stdout
    for command in LUICODE_TERMUX_COMMANDS:
        assert f"Found {command} at" in result.stdout
        assert f"Verified {command}:" in result.stdout
    # Reported from the project defaults: Settings.PORT 8082 on loopback.
    assert "http://127.0.0.1:8082" in result.stdout
    assert "http://127.0.0.1:8082/admin" in result.stdout
    assert "termux-wake-lock" in result.stdout
    assert "Python 3.14.6" in result.stdout

    calls = termux_harness.calls()
    assert "pkg:update -y" in calls
    assert "pkg:upgrade -y" in calls
    assert any(call.startswith(f"git-clone:{REPO_URL}") for call in calls)
    assert "python:-m pip install -e ." in calls
    assert (termux_harness.src_dir() / "pyproject.toml").is_file()


def test_fresh_install_skips_present_packages(termux_harness: TermuxHarness):
    result = termux_harness.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert "python, git, and curl are already installed." in result.stdout
    assert not any("pkg install" in call for call in termux_harness.calls())


def test_checkout_never_lands_in_the_config_directory(termux_harness: TermuxHarness):
    # ~/.luicode is the live config/data directory and scripts/uninstall.sh
    # purges it, so the checkout must live somewhere else.
    result = termux_harness.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert termux_harness.src_dir().is_dir()
    assert not (termux_harness.home / ".luicode" / ".git").exists()
    assert not (termux_harness.home / ".luicode" / "pyproject.toml").exists()


def test_wake_lock_is_never_invoked(termux_harness: TermuxHarness):
    result = termux_harness.run()

    assert result.returncode == 0, result.stdout + result.stderr
    # The installer advertises the wake lock, but never runs it. Match command
    # lines only: any path may legitimately contain the substring "wake".
    assert "termux-wake-lock" in result.stdout
    invocations = [
        line
        for line in result.stdout.splitlines()
        if line.startswith("+ ") and "termux-wake-lock" in line
    ]
    assert not invocations
    assert not any(
        call.startswith("termux-wake-lock") for call in termux_harness.calls()
    )


def test_bashrc_is_configured_once(termux_harness: TermuxHarness):
    assert termux_harness.run().returncode == 0

    text = termux_harness.rc_file().read_text(encoding="utf-8")
    assert text.count("# >>> LUICode PATH >>>") == 1
    assert text.count("# <<< LUICode PATH <<<") == 1
    assert f'export PATH="{termux_harness.scripts_dir}:$PATH"' in text


def test_second_run_is_idempotent(termux_harness: TermuxHarness):
    first = termux_harness.run()
    assert first.returncode == 0, first.stdout + first.stderr
    rc_before = termux_harness.rc_file().read_text(encoding="utf-8")

    termux_harness.truncate_calls()
    second = termux_harness.run()

    assert second.returncode == 0, second.stdout + second.stderr
    assert termux_harness.rc_file().read_text(encoding="utf-8") == rc_before
    calls = termux_harness.calls()
    assert not any("git clone" in call for call in calls)
    assert any("pull --ff-only" in call for call in calls)
    assert not any("pkg install" in call for call in calls)
    assert "Installation verified" in second.stdout


def test_uncommitted_changes_skip_the_update(termux_harness: TermuxHarness):
    assert termux_harness.run().returncode == 0

    termux_harness.env["LUICODE_FAKE_DIRTY"] = "1"
    termux_harness.truncate_calls()
    result = termux_harness.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert "has uncommitted changes; skipping the update" in result.stderr
    assert not any("pull --ff-only" in call for call in termux_harness.calls())
    # Verification must still run so a real failure is never reported as success.
    assert "Installation verified" in result.stdout


def test_zsh_shell_uses_zshrc(termux_harness: TermuxHarness):
    termux_harness.env["SHELL"] = "/data/data/com.termux/files/usr/bin/zsh"

    result = termux_harness.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert (termux_harness.home / ".zshrc").is_file()
    assert not (termux_harness.home / ".bashrc").exists()


def test_requirements_txt_is_used_without_pyproject(termux_harness: TermuxHarness):
    termux_harness.env["LUICODE_FAKE_REQUIREMENTS"] = "1"
    termux_harness.env["LUICODE_FAKE_NO_PYPROJECT"] = "1"

    result = termux_harness.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert any("pip install -r" in call for call in termux_harness.calls())
    assert not any("pip install -e ." in call for call in termux_harness.calls())


def test_missing_python_is_installed_by_pkg(termux_harness: TermuxHarness):
    (termux_harness.bin_dir / "python").unlink()
    if not termux_harness.restrict_path_without_python():
        pytest.skip("host PATH still resolves a Python interpreter")

    result = termux_harness.run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert "pkg installed: python" in termux_harness.calls()


def test_failed_pkg_install_reports_the_command_and_a_remedy(
    termux_harness: TermuxHarness,
):
    (termux_harness.bin_dir / "python").unlink()
    if not termux_harness.restrict_path_without_python():
        pytest.skip("host PATH still resolves a Python interpreter")

    result = termux_harness.run(fail_step="pkg-python")

    assert result.returncode != 0
    assert "error:" in result.stderr
    assert "pkg install -y python" in result.stderr
    assert "pkg update" in result.stderr


def test_git_missing_after_pkg_fails_with_guidance(termux_harness: TermuxHarness):
    (termux_harness.bin_dir / "git").unlink()
    # pkg reports success but provides nothing.
    termux_harness.reset_pkg(_silent_pkg_command())
    if not termux_harness.restrict_path():
        pytest.skip("host PATH still resolves git after restricting it")

    result = termux_harness.run()

    assert result.returncode != 0
    assert "git is still unavailable" in result.stderr
    assert "pkg install git" in result.stderr


def test_old_python_is_rejected_with_guidance(termux_harness: TermuxHarness):
    termux_harness.env["FAKE_PYTHON_VERSION"] = "3.13.7"

    result = termux_harness.run()

    assert result.returncode != 0
    assert "requires Python 3.14.0 or newer" in result.stderr
    assert "3.13.7" in result.stderr
    assert "pkg upgrade python" in result.stderr


def test_rejected_pip_upgrade_does_not_abort(termux_harness: TermuxHarness):
    result = termux_harness.run(fail_step="pip-upgrade")

    assert result.returncode == 0, result.stdout + result.stderr
    assert "could not upgrade pip" in result.stderr
    assert "Installation verified" in result.stdout


def test_missing_pip_fails_with_guidance(termux_harness: TermuxHarness):
    result = termux_harness.run(fail_step="pip-missing")

    assert result.returncode != 0
    assert "pip is not available" in result.stderr
    assert "pkg reinstall python" in result.stderr


def test_pkg_update_failure_is_reported(termux_harness: TermuxHarness):
    result = termux_harness.run(fail_step="pkg-update")

    assert result.returncode != 0
    assert "pkg update -y" in result.stderr
    assert "pkg update" in result.stderr


def test_pkg_upgrade_failure_is_not_fatal(termux_harness: TermuxHarness):
    result = termux_harness.run(fail_step="pkg-upgrade")

    assert result.returncode == 0, result.stdout + result.stderr
    assert 'pkg upgrade -y" failed' in result.stderr
    assert "Installation verified" in result.stdout


def test_entry_point_missing_from_path_reports_the_real_cause(
    termux_harness: TermuxHarness,
):
    # Point the interpreter at a directory without the entry points.
    empty_scripts = termux_harness.root / "empty-scripts"
    empty_scripts.mkdir()
    termux_harness.env["FAKE_SCRIPTS_DIR"] = str(empty_scripts)
    for name in LUICODE_TERMUX_COMMANDS:
        (termux_harness.scripts_dir / name).unlink()

    result = termux_harness.run()

    assert result.returncode != 0
    assert "is installed but is not on PATH" in result.stderr
    assert ".bashrc" in result.stderr
    assert "Installation Complete" not in result.stdout


def test_broken_entry_point_is_not_reported_as_success(termux_harness: TermuxHarness):
    result = termux_harness.run(fail_step="entrypoint-run")

    assert result.returncode != 0
    assert "failed to run" in result.stderr
    assert "broken" in result.stderr
    assert "Installation Complete" not in result.stdout


def test_dry_run_changes_nothing(termux_harness: TermuxHarness):
    result = termux_harness.run("--dry-run")

    assert result.returncode == 0, result.stdout + result.stderr
    assert "Dry run complete. No changes were made." in result.stdout
    assert not termux_harness.src_dir().exists()
    assert not termux_harness.rc_file().exists()
    assert not any("git clone" in call for call in termux_harness.calls())
    assert not any("pip install -e" in call for call in termux_harness.calls())


def test_dry_run_reports_unsupported_android_features(termux_harness: TermuxHarness):
    result = termux_harness.run("--dry-run")

    assert result.returncode == 0, result.stdout + result.stderr
    assert "NOT supported on Android" in result.stdout
    for feature in (
        "Local Whisper voice transcription",
        "Hermes Agent",
        "Muse Code",
        "Browser automation",
    ):
        assert feature in result.stdout


@pytest.mark.parametrize(
    "args",
    (("--voice-local",), ("--voice-local", "--torch-backend=cu130")),
)
def test_android_unsupported_flags_are_rejected(
    termux_harness: TermuxHarness, args: tuple[str, ...]
):
    result = termux_harness.run(*args, "--dry-run")

    assert result.returncode != 0
    assert "not supported on Android" in result.stderr
    assert not termux_harness.src_dir().exists()


def test_non_git_source_directory_is_never_deleted(termux_harness: TermuxHarness):
    src_dir = termux_harness.src_dir()
    src_dir.mkdir()
    (src_dir / "important.txt").write_text("keep me", encoding="utf-8")

    result = termux_harness.run()

    assert result.returncode != 0
    assert "is not a git checkout" in result.stderr
    assert (src_dir / "important.txt").read_text(encoding="utf-8") == "keep me"


def test_existing_rc_content_is_preserved(termux_harness: TermuxHarness):
    rc = termux_harness.rc_file()
    rc.write_text("# my own settings\nexport EDITOR=vim\n", encoding="utf-8")

    result = termux_harness.run()

    assert result.returncode == 0, result.stdout + result.stderr
    text = rc.read_text(encoding="utf-8")
    assert "# my own settings" in text
    assert "export EDITOR=vim" in text
    assert text.count("# >>> LUICode PATH >>>") == 1


def test_changed_entry_point_directory_replaces_the_managed_block(
    termux_harness: TermuxHarness,
):
    rc = termux_harness.rc_file()
    rc.write_text("export EDITOR=vim\n", encoding="utf-8")
    assert termux_harness.run().returncode == 0

    other_scripts = termux_harness.root / "other-scripts"
    other_scripts.mkdir()
    for name in LUICODE_TERMUX_COMMANDS:
        _write_executable(other_scripts / name, _entry_point(name))
    termux_harness.env["FAKE_SCRIPTS_DIR"] = str(other_scripts)

    rerun = termux_harness.run()

    assert rerun.returncode == 0, rerun.stdout + rerun.stderr
    rewritten = rc.read_text(encoding="utf-8")
    assert rewritten.count("# >>> LUICode PATH >>>") == 1
    assert str(termux_harness.scripts_dir) not in rewritten
    assert str(other_scripts) in rewritten
    assert "export EDITOR=vim" in rewritten


def test_non_termux_falls_through_to_the_uv_flow(termux_harness: TermuxHarness):
    # No TERMUX_VERSION, no com.termux PREFIX, and uname -o reports Linux.
    env = termux_harness.env
    env.pop("TERMUX_VERSION")
    env["PREFIX"] = "/usr"
    env["FAKE_UNAME_O"] = "Linux"

    result = termux_harness.run("--dry-run")

    # The Android flow must not run at all. The rest of the Linux/macOS flow is
    # covered end to end by test_installers.py.
    assert "LUICode Installer for Android" not in result.stdout
    assert "Detected Termux" not in result.stdout
    assert not any("pkg:" in call for call in termux_harness.calls())
    assert not any(call.startswith("python:") for call in termux_harness.calls())
    assert "Ensuring uv" in result.stdout


def test_unset_home_does_not_break_the_non_termux_flow(
    termux_harness: TermuxHarness,
):
    # The Android block declares its source directory at load time, so it must
    # not expand HOME unguarded under `set -u` on the Linux/macOS path. An empty
    # HOME stands in for an absent one because some runtimes repopulate a
    # missing HOME; the installer's guards treat both the same way.
    env = termux_harness.env
    env.pop("TERMUX_VERSION")
    env["HOME"] = ""
    env["PREFIX"] = "/usr"
    env["FAKE_UNAME_O"] = "Linux"

    result = termux_harness.run("--dry-run")

    assert "unbound variable" not in result.stderr
    assert "Ensuring uv" in result.stdout

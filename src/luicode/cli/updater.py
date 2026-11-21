"""Wrapper for shell-based updater scripts."""

import os
import subprocess
import sys
import sysconfig
from pathlib import Path


def _run_script(script_name: str) -> int:
    """Run a shell script from the package's data/scripts directory."""
    # First try: wheel's data directory (sysconfig.get_path("data")) / scripts
    data_dir = Path(sysconfig.get_path("data")) / "scripts"
    script_path = data_dir / script_name

    if not script_path.is_file():
        # Fallback: Windows Scripts directory (sysconfig.get_path("scripts"))
        scripts_dir = Path(sysconfig.get_path("scripts"))
        script_path = scripts_dir / f"{script_name}.exe"
        if not script_path.is_file():
            script_path = scripts_dir / f"{script_name}.cmd.exe"

    if not script_path.is_file():
        # Fallback: try the package's data directory via sysconfig.get_path("platlib")
        platlib_dir = Path(sysconfig.get_path("platlib")) / "luicode" / "data" / "scripts"
        script_path = platlib_dir / script_name

    if not script_path.is_file():
        # Fallback: try the package's data directory via sysconfig.get_path("purelib")
        purelib_dir = Path(sysconfig.get_path("purelib")) / "luicode" / "data" / "scripts"
        script_path = purelib_dir / script_name

    if not script_path.is_file():
        # Fallback to development location
        script_dir = Path(__file__).parent.parent.parent / "scripts" / "update"
        script_path = script_dir / script_name

    if not script_path.is_file():
        print(f"Error: {script_name} not found", file=sys.stderr)
        return 1

    env = os.environ.copy()
    env["LUICODE_FROM_WRAPPER"] = "1"
    return subprocess.run([str(script_path)] + sys.argv[1:], env=env).returncode


def luicode_update() -> int:
    return _run_script("luicode-update")


def luicode_upgrade() -> int:
    return _run_script("luicode-upgrade")


def luicode_update_cmd() -> int:
    return _run_script("luicode-update.cmd")


def luicode_upgrade_cmd() -> int:
    return _run_script("luicode-upgrade.cmd")
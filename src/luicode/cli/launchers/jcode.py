"""Installed jcode launcher with LUICODE gateway routing."""

import re
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path

from luicode.harnesses.config_file import atomic_write_text
from luicode.harnesses.environment import client_environment
from luicode.harnesses.launch import PreparedLaunch
from luicode.harnesses.resources import LaunchResources

from .jcode_config import build_jcode_config
from .runner import HarnessSpec, LaunchContext, launch_harness, version_at_least

_INSTALL_HINT = (
    "Install jcode from: https://jcode.sh/install\n"
    "  macOS/Linux:  curl -fsSL https://jcode.sh/install | bash\n"
    "  Windows:      irm https://jcode.sh/install.ps1 | iex\n"
    "  Homebrew:     brew tap 1jehuang/jcode && brew install jcode\n"
    "  From source:  git clone https://github.com/1jehuang/jcode && cd jcode && cargo build --release\n"
    "  Termux:       pkg install glibc patchelf && curl -fsSL https://jcode.sh/install | bash"
)

# Advisory only. The profile shape was verified against 0.95.0; older releases
# may ignore it and fall back to the user's own provider, so warn and continue
# rather than refuse to launch.
_MINIMUM_VERSION = (0, 90, 0)
_VERSION_PATTERN = re.compile(
    r"jcode v(\d+)\.(\d+)\.(\d+)(?:[-\w]*)?(?: \([\da-f]+\))?"
)

_JCODE_ROUTING_ENV_KEYS = (
    "JCODE_OPENAI_COMPAT_API_BASE",
    "JCODE_OPENAI_COMPAT_DEFAULT_MODEL",
    "OPENAI_COMPAT_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "JCODE_OPENAI_EXTRA_BODY",
    "JCODE_STREAM_IDLE_TIMEOUT_SECS",
)


def jcode_home_path() -> Path:
    """Return the LUICODE-owned jcode home.

    Resolved per call so tests and relocated homes both apply. Sessions, memory
    and ``--resume`` survive because this directory is not a temp scope.
    """

    return Path.home() / ".luicode" / "jcode-home"


def _is_supported_version(output: str) -> bool:
    return version_at_least(output, _VERSION_PATTERN, _MINIMUM_VERSION)


def _warn_on_old_version(binary_path: str, env: dict[str, str]) -> None:
    """Print one advisory line for a jcode older than the verified release."""

    try:
        result = subprocess.run(
            [binary_path, "--version"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=5,
            env=env,
        )
    except OSError, subprocess.TimeoutExpired:
        return
    if result.returncode != 0 or _is_supported_version(result.stdout):
        return
    minimum = ".".join(str(part) for part in _MINIMUM_VERSION)
    print(
        f"warning: {result.stdout.strip() or 'jcode'} is older than {minimum}; "
        "LUICODE continues, but jcode may ignore the luicode profile.",
        file=sys.stderr,
    )


def _stream_idle_timeout_secs(ctx: LaunchContext) -> int | None:
    """Widen jcode's first-token window when fallbacks can delay the reply."""

    if not ctx.settings.model_fallbacks:
        return None
    # 180s is jcode's default; each fallback attempt needs its own budget.
    return 360


def _configure(
    ctx: LaunchContext, args: list[str], _files: LaunchResources
) -> PreparedLaunch:
    catalog = ctx.require_catalog()
    home = jcode_home_path()
    home.mkdir(parents=True, mode=0o700, exist_ok=True)

    config_text = build_jcode_config(
        catalog.models,
        base_url=f"{ctx.proxy_root_url.rstrip('/')}/v1",
        api_key_env="LUICODE_JCODE_TOKEN",
        default_model=catalog.default_model_id,
        stream_idle_timeout_secs=_stream_idle_timeout_secs(ctx),
    )
    atomic_write_text(home / "config.toml", config_text)

    env = client_environment(
        ctx.base_env,
        proxy_root_url=ctx.proxy_root_url,
        remove_keys=_JCODE_ROUTING_ENV_KEYS,
        updates={
            "JCODE_HOME": str(home),
            "LUICODE_JCODE_TOKEN": ctx.auth_token,
            "JCODE_NO_TELEMETRY": "1",
        },
    )

    _warn_on_old_version(ctx.binary_path, env)

    return PreparedLaunch(
        [ctx.binary_path, "--provider-profile", "luicode", *args], env
    )


SPEC = HarnessSpec(
    binary_name="jcode",
    display_name="jcode",
    install_hint=_INSTALL_HINT,
    configure=_configure,
    catalog_view="messages",
)


def launch(argv: Sequence[str] | None = None) -> None:
    launch_harness(SPEC, argv)

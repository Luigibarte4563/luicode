"""Lightweight entrypoint for the optional LUICODE desktop shell."""

import sys
from collections.abc import Sequence
from pathlib import Path

from luicode.cli.desktop_assets import export_app_icon
from luicode.core.windows_dpi import enable_dpi_awareness


def launch(argv: Sequence[str] | None = None) -> None:
    """Export installer assets or launch the supported native tray adapter."""

    args = tuple(sys.argv[1:] if argv is None else argv)
    if len(args) == 2 and args[0] == "--export-icon":
        export_app_icon(Path(args[1]))
        return
    if args:
        print("Usage: luicode-desktop [--export-icon PATH]", file=sys.stderr)
        raise SystemExit(2)
    if sys.platform not in {"darwin", "win32"}:
        print("LUICODE Desktop is supported on Windows and macOS.", file=sys.stderr)
        raise SystemExit(1)

    enable_dpi_awareness()

    from luicode.cli.desktop_tray import launch as launch_tray

    launch_tray()

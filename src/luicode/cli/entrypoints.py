"""Lightweight entry points for installed luicode commands."""

import sys
from collections.abc import Sequence

from luicode.core.version import package_version


def serve(argv: Sequence[str] | None = None) -> None:
    """Start the FastAPI server (registered as ``luicode-server``)."""
    if _print_version_if_requested(argv):
        return

    # Keep the server composition root off metadata-only command paths.
    from luicode.cli.commands import serve as run_server

    run_server()


def _print_version_if_requested(argv: Sequence[str] | None) -> bool:
    args = sys.argv[1:] if argv is None else argv
    if "--version" not in args:
        return False
    print(f"luicode {package_version()}")
    return True

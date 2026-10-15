"""Run a command behind a PTY from a fresh single-threaded process."""

import os
import pty
import sys


def main() -> int:
    # pty.spawn may return either:
    #  - a raw wait-status (what os.waitpid() returns as the 'status'),
    #  - or an already-normalized exit code (depending on Python/platform).
    # Accept both by attempting waitstatus_to_exitcode first, then falling back.
    spawn = pty.spawn
    status = spawn(sys.argv[1:])
    try:
        return os.waitstatus_to_exitcode(status)
    except Exception:
        # If status is already an exit code (or can't be translated),
        # cast to int and return that.
        return int(status)


if __name__ == "__main__":
    raise SystemExit(main())

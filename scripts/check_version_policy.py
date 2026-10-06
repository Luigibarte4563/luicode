"""Validate release intent against changed files and calculate one version bump."""

import argparse
import json
import re
import subprocess
import tomllib
from pathlib import Path

RELEASE_FILES = {".python-version", "pyproject.toml", "uv.lock"}
RELEASE_DIRS = ("assets/", "scripts/", "src/")
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
PREFIX = re.compile(r"(patch|minor|major): \S[^\r\n]*")
RESERVED = re.compile(r"\s*(patch|minor|major)\s*[:\uff1a]", re.IGNORECASE)


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], check=True, capture_output=True, text=True, encoding="utf-8"
    ).stdout.rstrip("\r\n")


def changed_paths(base: str, head: str) -> list[str]:
    return list(
        filter(
            None,
            git("diff", "--no-renames", "--name-only", "-z", base, head).split("\0"),
        )
    )


def release_paths(paths: list[str]) -> list[str]:
    return [
        path for path in paths if path in RELEASE_FILES or path.startswith(RELEASE_DIRS)
    ]


def release_kind(title: str, paths: list[str]) -> str | None:
    match = PREFIX.fullmatch(title)
    released = release_paths(paths)
    if not match and RESERVED.match(title):
        raise ValueError(
            "Use exactly patch: , minor: , or major: followed by a description"
        )
    if released and not match:
        raise ValueError("Release changes require a patch: , minor: , or major: title")
    if not released and match:
        raise ValueError("A non-release PR must not use a release prefix")
    return match[1] if match else None


def next_version(previous: str, kind: str) -> str:
    match = VERSION.fullmatch(previous)
    if not match:
        raise ValueError(f"Invalid release version: {previous}")
    major, minor, patch = map(int, match.groups())
    if kind == "major":
        return f"{major + 1}.0.0"
    if kind == "minor":
        return f"{major}.{minor + 1}.0"
    if kind == "patch":
        return f"{major}.{minor}.{patch + 1}"
    raise ValueError(f"Invalid release kind: {kind}")


VERSION_FILE = "src/luicode/_version/__init__.py"
VERSION_ASSIGNMENT = re.compile(r"""__version__\s*=\s*["']([^"']+)["']""")


def previous_version(head: str) -> str | None:
    """Return the newest stable release version already tagged in history."""
    versions = []
    for tag in git("tag", "--list", "v*", "--merged", head).splitlines():
        name = tag.removeprefix("v")
        if VERSION.fullmatch(name):
            versions.append(name)
    if not versions:
        return None
    # VERSION matches only X.Y.Z, so tuple ordering is numeric ordering.
    return max(versions, key=lambda value: tuple(map(int, value.split("."))))


def check_version_bump(head: str, kind: str | None, previous: str | None) -> None:
    """Fail a release whose committed __version__ disagrees with its tag.

    The wheel and sdist carry this file's value, so a mismatch only surfaces
    during publication, after the tag is already pushed.
    """
    if kind is None:
        return
    try:
        declared_source = git("show", f"{head}:{VERSION_FILE}")
    except subprocess.CalledProcessError:
        raise ValueError(
            f"{VERSION_FILE} must be tracked by the release commit"
        ) from None
    match = VERSION_ASSIGNMENT.search(declared_source)
    if match is None:
        raise ValueError(f"{VERSION_FILE} must declare __version__")
    declared = match.group(1)
    if previous is None:
        # No baseline tag exists yet, so there is nothing to compute against.
        return
    expected = next_version(previous, kind)
    if declared != expected:
        raise ValueError(
            f"__version__ is {declared} but a {kind} release after "
            f"{previous} must set it to {expected}"
        )


def check_packaging(head: str) -> None:
    project = tomllib.loads(git("show", f"{head}:pyproject.toml"))["project"]
    if (
        project["name"] != "luicode"
        or "version" in project
        or "version" not in project.get("dynamic", [])
    ):
        raise ValueError(
            "LUICODE must declare a dynamic version without project.version"
        )
    lock = tomllib.loads(git("show", f"{head}:uv.lock"))
    roots = [
        p
        for p in lock["package"]
        if p["name"] == "luicode" and p.get("source") == {"editable": "."}
    ]
    if len(roots) != 1 or "version" in roots[0]:
        raise ValueError(
            "uv.lock must have one editable LUICODE package without a version"
        )


def check(base: str, head: str, title: str) -> None:
    base = git("rev-parse", "--verify", "--end-of-options", f"{base}^{{commit}}")
    head = git("rev-parse", "--verify", "--end-of-options", f"{head}^{{commit}}")
    paths = changed_paths(git("merge-base", base, head), head)
    print("Release changes: " + (", ".join(release_paths(paths)) or "none"))
    kind = release_kind(title, paths)
    check_packaging(head)
    check_version_bump(head, kind, previous_version(head))
    print(f"Version policy passed: {kind or 'no release'}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base")
    parser.add_argument("--head", required=True)
    parser.add_argument("--title")
    parser.add_argument("--pr-json", type=Path)
    args = parser.parse_args()
    try:
        if args.pr_json:
            pr = json.loads(args.pr_json.read_text(encoding="utf-8"))
            if pr["head"]["sha"] != git(
                "rev-parse", "--verify", "--end-of-options", f"{args.head}^{{commit}}"
            ):
                raise ValueError("PR head changed; use the current policy run")
            base, title = pr["base"]["sha"], pr["title"]
        else:
            base, title = args.base, args.title
        if not base or title is None:
            raise ValueError("Provide --pr-json or both --base and --title")
        check(base, args.head, title)
    except (
        ValueError,
        KeyError,
        TypeError,
        OSError,
        subprocess.CalledProcessError,
    ) as error:
        print(f"Version policy failed: {error}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

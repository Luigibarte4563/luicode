# Contributing

Thanks for helping improve luicode. Keep changes focused, test the behavior you change, and preserve the public Claude Code and Codex workflows that luicode routes.

## Before Opening A Pull Request

- Open an issue before proposing README changes.
- Do not open Docker integration pull requests.
- For bugs, include every model mapping, the active model when the failure occurred, the complete error, and reproducible steps.
- Add focused tests for behavior changes and relevant edge cases.

## Pull Request Titles

Changes to `assets/`, `scripts/`, `src/`, `.python-version`, `pyproject.toml`, or `uv.lock` require a title starting with `patch: `, `minor: `, or `major: ` followed by a description. Use exactly one space after the colon.

PRs without changes to those paths must not use a release prefix.

The merge or squash commit that lands on `main` must repeat that prefix in its own subject line. Publishing reads the merged commit's subject, not the pull request title, so GitHub's default `Merge pull request #N from ...` subject fails the release. Prefer squash merges and give the squash commit the same prefixed title as the pull request.

## Version Numbers

Publishing derives the next version from the latest release tag plus one increment of your prefix: `patch:` bumps the patch component, `minor:` bumps the minor component, and `major:` bumps the major component. Set `__version__` in `src/luicode/_version/__init__.py` in the same commit to exactly that value. The built wheel and sdist carry this file's value, and release validation rejects the upload when it disagrees with the computed version.

Never add a `version` key to `pyproject.toml`. It declares `dynamic = ["version"]`, and the release workflow fails when a literal version appears there or in the `uv.lock` entry for this project.

## Development Setup

Install [uv](https://docs.astral.sh/uv/) and Python 3.14, then run directly from the checkout:

```bash
git clone https://github.com/Luigibarte4563/luicode.git
cd luicode
uv python install 3.14.0
uv run luicode-server
```

**Android/Termux:** Install Termux from F-Droid, then run the installer. See [docs/android.md](docs/android.md) for details.

Use `uv run` for Python commands. Do not run the project with a global Python interpreter.

## Quality Checks

Run the complete local CI sequence before opening a pull request:

```bash
./scripts/ci.sh
```

```powershell
.\scripts\ci.ps1
```

Useful iteration flags are `--only`, `--skip`, and `--dry-run` on macOS/Linux, or `-Only`, `-Skip`, and `-DryRun` in PowerShell.

Individual repair and test commands:

```bash
uv run ruff format
uv run ruff check --fix
uv run ty check
uv run pytest -v --tb=short
```

GitHub CI runs Ruff in check-only mode and also bans `# type: ignore`, `# ty: ignore`, and legacy annotation workarounds. Fix underlying typing and import-boundary problems instead of suppressing them.

## Project Standards

- Target Python 3.14 and rely on native lazy annotations; do not add `from __future__ import annotations`.
- Python 3.14 supports multiple exception types without parentheses, such as `except TypeError, ValueError:`.
- Keep shared Anthropic protocol behavior under `src/luicode/core/anthropic/` rather than importing utilities from another provider.
- Keep provider-specific configuration in the provider that owns it.
- Remove dead compatibility code when completing migrations unless preserving a published interface is explicitly required.

## Versioning

Changes to runtime code, packaging, dependencies, or install/CI scripts require a semantic version bump in the same commit, applied to `__version__` in `src/luicode/_version/__init__.py` as described under [Version Numbers](#version-numbers). Update `uv.lock` only when dependencies change, since this project's version is deliberately absent from it. Documentation, tests, smoke coverage, and repository configuration do not require a version bump by themselves.

## Releasing

Merging to `main` publishes to PyPI and GitHub Releases automatically. The workflow needs a PyPI trusted publisher, configured once per repository: owner `Luigibarte4563`, repository `luicode`, workflow `post-merge.yml`, environment `pypi`.

Users install published releases with `luicode-upgrade`, which resolves the newest release tag from the repository's releases feed. That feed is the source of truth for the upgrade path, so a release is only installable once its GitHub Release is public; drafts never appear.

Publishing is resumable. To retry a failed or interrupted release, run the *Post merge* workflow with `release_commit` set to the full 40-character SHA of the `main` commit being released. That commit must lie on `main`'s first-parent history, so pass the merged commit rather than the branch commit it merged.

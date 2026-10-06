"""Release intent is validated against committed paths, not edited numbers."""

import os
import subprocess
import sys
from pathlib import Path

import pytest

CHECKER = Path(__file__).resolve().parents[2] / "scripts/check_version_policy.py"


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
        env=os.environ
        | {
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "Test",
            "GIT_AUTHOR_EMAIL": "test@example.invalid",
            "GIT_COMMITTER_NAME": "Test",
            "GIT_COMMITTER_EMAIL": "test@example.invalid",
        },
    ).stdout.strip()


def write(repo: Path, path: str, content: str) -> None:
    target = repo / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def commit(repo: Path, title: str = "test change") -> str:
    git(repo, "add", ".")
    git(repo, "commit", "--no-gpg-sign", "-m", title)
    return git(repo, "rev-parse", "HEAD")


@pytest.fixture
def history(tmp_path):
    git(tmp_path, "init", "-b", "main")
    git(tmp_path, "config", "core.autocrlf", "false")
    write(
        tmp_path,
        "pyproject.toml",
        '[project]\nname="luicode"\ndynamic=["version"]\n',
    )
    write(
        tmp_path,
        "uv.lock",
        '[[package]]\nname="luicode"\nsource={editable="."}\n',
    )
    write(tmp_path, "src/file.py", "original\n")
    write(tmp_path, "src/luicode/_version/__init__.py", '__version__ = "1.1.0"\n')
    base = commit(tmp_path)
    git(tmp_path, "tag", "v1.1.0", base)
    return tmp_path, base


BUMPED_VERSION = {"patch": "1.1.1", "minor": "1.2.0", "major": "2.0.0"}


def set_version(repo: Path, version: str) -> None:
    write(repo, "src/luicode/_version/__init__.py", f'__version__ = "{version}"\n')


def check(repo: Path, base: str, title: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(CHECKER),
            "--base",
            base,
            "--head",
            "HEAD",
            "--title",
            title,
        ],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.parametrize(
    "path",
    [
        "assets/a.svg",
        "scripts/a.sh",
        "src/a.py",
        ".python-version",
        "pyproject.toml",
        "uv.lock",
    ],
)
@pytest.mark.parametrize(
    "title,allowed",
    [
        ("patch: Fix it", True),
        ("minor: Add it", True),
        ("major: Replace it", True),
        ("Fix it", False),
    ],
)
def test_release_inputs_require_prefix(history, path, title, allowed):
    repo, base = history
    target = repo / path
    write(repo, path, (target.read_text() if target.exists() else "") + "\n# change\n")
    kind = title.split(":", 1)[0]
    if allowed:
        set_version(repo, BUMPED_VERSION[kind])
    commit(repo)
    result = check(repo, base, title)
    assert (result.returncode == 0) is allowed, result.stdout + result.stderr


@pytest.mark.parametrize(
    "title",
    ["patch: Missing release", "minor: Missing release", "major: Missing release"],
)
def test_nonrelease_changes_forbid_prefix(history, title):
    repo, base = history
    write(repo, "README.md", "docs")
    commit(repo)
    assert check(repo, base, title).returncode != 0


@pytest.mark.parametrize(
    "title",
    [
        "Patch: Change",
        " patch: Change",
        "patch:Change",
        "patch:  Change",
        "patch:\tChange",
        "patch: ",
        "patch : Change",
        "major\uff1a Change",
    ],
)
def test_malformed_release_title_rejected(history, title):
    repo, base = history
    write(repo, "src/file.py", "change")
    commit(repo)
    assert check(repo, base, title).returncode != 0


@pytest.mark.parametrize("move", [False, True])
def test_delete_or_move_out_counts_as_release(history, move):
    repo, base = history
    if move:
        (repo / "src/file.py").rename(repo / "outside.py")
    else:
        (repo / "src/file.py").unlink()
    commit(repo)
    assert check(repo, base, "Docs").returncode != 0
    set_version(repo, "1.1.1")
    commit(repo)
    assert check(repo, base, "patch: Remove file").returncode == 0


def test_unrelated_main_and_dirty_files_do_not_change_pr_classification(history):
    repo, original = history
    write(repo, "src/main.py", "main")
    base = commit(repo)
    git(repo, "checkout", "-b", "docs", original)
    write(repo, "README.md", "docs")
    commit(repo)
    write(repo, "src/file.py", "uncommitted")
    assert check(repo, base, "Explain setup").returncode == 0


def test_title_is_data_and_multiple_commits_have_one_intent(history):
    repo, base = history
    write(repo, "src/file.py", "one")
    commit(repo)
    write(repo, "src/file.py", "two")
    set_version(repo, "1.1.1")
    commit(repo)
    assert check(repo, base, 'patch: $(echo unsafe) `literal` "quoted"').returncode == 0


def test_manual_version_is_rejected(history):
    repo, base = history
    write(repo, "pyproject.toml", '[project]\nname="luicode"\nversion="1.2.3"\n')
    commit(repo)
    assert check(repo, base, "patch: Manual version").returncode != 0


@pytest.mark.parametrize(
    "title,version",
    [("patch: Fix", "1.1.1"), ("minor: Add", "1.2.0"), ("major: Replace", "2.0.0")],
)
def test_release_accepts_the_computed_version(history, title, version):
    repo, base = history
    write(repo, "src/file.py", "change")
    set_version(repo, version)
    commit(repo)
    assert check(repo, base, title).returncode == 0


@pytest.mark.parametrize(
    "title,version",
    [
        # The exact regression: the tag advanced but __version__ did not.
        ("patch: Fix", "1.1.0"),
        ("patch: Fix", "1.1.2"),
        ("minor: Add", "1.1.1"),
        ("major: Replace", "1.1.1"),
        ("patch: Fix", "not-a-version"),
    ],
)
def test_release_rejects_a_version_that_disagrees_with_the_tag(history, title, version):
    repo, base = history
    write(repo, "src/file.py", "change")
    set_version(repo, version)
    commit(repo)
    result = check(repo, base, title)
    assert result.returncode != 0
    assert "__version__" in result.stdout


def test_version_must_come_from_the_latest_tag(history):
    repo, base = history
    git(repo, "tag", "v1.1.9", base)
    write(repo, "src/file.py", "change")
    set_version(repo, "1.1.1")
    commit(repo)
    result = check(repo, base, "patch: Fix")
    assert result.returncode != 0
    assert "1.1.10" in result.stdout


def test_release_without_a_baseline_tag_skips_the_comparison(history):
    repo, _ = history
    git(repo, "tag", "-d", "v1.1.0")
    write(repo, "src/file.py", "change")
    set_version(repo, "9.9.9")
    commit(repo)
    assert check(repo, _, "patch: First").returncode == 0


def test_release_requires_a_tracked_version_file(history):
    repo, base = history
    (repo / "src/luicode/_version/__init__.py").unlink()
    write(repo, "src/file.py", "change")
    commit(repo)
    result = check(repo, base, "patch: Missing file")
    assert result.returncode != 0
    assert "_version/__init__.py" in result.stdout


def test_unversioned_change_is_not_held_to_a_bump(history):
    repo, base = history
    write(repo, "README.md", "docs")
    commit(repo)
    assert check(repo, base, "Explain setup").returncode == 0


def test_pr_snapshot_uses_latest_title_and_rejects_stale_head(history, tmp_path):
    import json

    repo, base = history
    write(repo, "src/file.py", "change")
    set_version(repo, "1.1.1")
    head = commit(repo)
    payload = tmp_path / "current-pr.json"
    payload.write_text(
        json.dumps(
            {"head": {"sha": head}, "base": {"sha": base}, "title": "patch: New title"}
        )
    )
    result = subprocess.run(
        [sys.executable, str(CHECKER), "--head", head, "--pr-json", str(payload)],
        cwd=repo,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout
    payload.write_text(
        json.dumps(
            {"head": {"sha": base}, "base": {"sha": base}, "title": "patch: New title"}
        )
    )
    result = subprocess.run(
        [sys.executable, str(CHECKER), "--head", head, "--pr-json", str(payload)],
        cwd=repo,
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "head changed" in result.stdout

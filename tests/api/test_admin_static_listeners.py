"""Static tripwire for Admin UI event wiring.

A listener registered with a local DOM binding instead of a handler is accepted
by the browser and silently does nothing, which is how the Browser Agent
Disconnect button once shipped dead. Substring assertions cannot catch that, so
this checks the shape of the call inside each function body.
"""

import re
from pathlib import Path

STATIC = (
    Path(__file__).resolve().parents[2] / "src" / "luicode" / "api" / "admin_static"
)

_BINDING = re.compile(r"\b(?:const|let|var)\s+(\w+)\s*=\s*([^;\n]+)")
_LISTENER = re.compile(r"addEventListener\(\s*[\"']\w+[\"']\s*,\s*(\w+)\s*\)")
_FUNCTION_INITIALIZER = re.compile(r"^\s*(?:async\s+)?(?:function\b|\()")
_FUNCTION_START = re.compile(
    r"(?:async\s+)?function\s*\w*\s*\([^)]*\)\s*\{|^\s*\w+\s*\([^)]*\)\s*\{",
    re.MULTILINE,
)


def _function_regions(script: str) -> list[str]:
    """Return the innermost function bodies, found by brace matching.

    An enclosing wrapper (the module IIFE, for example) is not a scope of its
    own for this check: its body would merge unrelated functions.
    """

    found: list[tuple[int, str]] = []
    for match in _FUNCTION_START.finditer(script):
        depth = 0
        for index in range(match.end() - 1, len(script)):
            char = script[index]
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    found.append((match.start(), script[match.end() - 1 : index + 1]))
                    break
    return [
        text
        for start, text in found
        if not any(
            start < other < start + len(text) for other, _ in found if other != start
        )
    ]


def _listener_offenders(script: str) -> list[str]:
    """Return listener registrations that pass a non-function local binding."""

    offenders: set[str] = set()
    for region in _function_regions(script):
        bound = {
            name
            for name, initializer in _BINDING.findall(region)
            if not _FUNCTION_INITIALIZER.match(initializer)
        }
        offenders.update(
            f"addEventListener(..., {name}) passes a binding, not a handler"
            for name in _LISTENER.findall(region)
            if name in bound
        )
    return sorted(offenders)


def test_admin_scripts_always_pass_a_handler_to_add_event_listener() -> None:
    offenders: list[str] = []
    for path in sorted(STATIC.glob("*.js")):
        offenders.extend(
            f"{path.name}: {offender}"
            for offender in _listener_offenders(path.read_text(encoding="utf-8"))
        )

    assert offenders == []


def test_listener_detector_reports_a_shadowed_handler() -> None:
    script = "\n".join(
        (
            "function disconnect() { return 1; }",
            "function bind() {",
            '  const disconnect = byId("jevDisconnect");',
            '  if (disconnect) disconnect.addEventListener("click", disconnect);',
            "  const handler = () => disconnect();",
            '  other.addEventListener("click", handler);',
            "}",
        )
    )

    assert _listener_offenders(script) == [
        "addEventListener(..., disconnect) passes a binding, not a handler"
    ]


def test_listener_detector_ignores_a_binding_in_another_function() -> None:
    """A binding elsewhere (or a parameter) is not evidence of shadowing."""

    script = "\n".join(
        (
            "function render() {",
            '  const disconnect = byId("jevDisconnect");',
            "  disconnect.hidden = true;",
            "}",
            "async function disconnect() { return 1; }",
            "function bind() {",
            '  byId("jevDisconnect").addEventListener("click", disconnect);',
            "}",
            "function authButton(label, action) {",
            '  button.addEventListener("click", () => action(button));',
            "}",
        )
    )

    assert _listener_offenders(script) == []

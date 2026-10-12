"""The declared ports must be served by their owners.

The API layers depend on these protocols and nothing checked that the owners
still implemented them, so a rename would only fail at request time. This also
pins which class owns which port: requests belong to the provider manager,
everything admin-side belongs to the application runtime, and every provider
serves the application's provider port.
"""

import ast
import inspect
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from luicode.api.ports import AdminRuntimePort
from luicode.application.browser_agent.ports import ConfigValuesWriter
from luicode.application.ports import (
    ModelCatalogPort,
    ProviderPort,
    RequestRuntimePort,
    TaskController,
)
from luicode.providers.base import BaseProvider
from luicode.runtime.application import ApplicationRuntime
from luicode.runtime.provider_manager import ProviderRuntimeManager

# (owner, ports it must satisfy)
_OWNERS: tuple[tuple[type, tuple[type, ...]], ...] = (
    (ApplicationRuntime, (AdminRuntimePort, TaskController, ConfigValuesWriter)),
    (ProviderRuntimeManager, (RequestRuntimePort, ModelCatalogPort)),
    # Concrete providers derive from BaseProvider and must keep serving the
    # application's structural provider port.
    (BaseProvider, (ProviderPort,)),
)

_PROVIDERS_ROOT = Path(__file__).resolve().parents[2] / "src" / "luicode" / "providers"
_PORT_METHODS = ("stream_messages", "stream_responses")


def _declared_members(port: type) -> dict[str, object]:
    """Return the port's members, including those inherited from base protocols."""

    members: dict[str, object] = {}
    for base in reversed(port.__mro__):
        if base in {object, Protocol}:
            continue
        members.update(
            {
                name: member
                for name, member in vars(base).items()
                if not name.startswith("_")
            }
        )
    return members


def _missing_members(target: type, port: type) -> list[str]:
    return [
        f"{port.__name__}.{name}"
        for name in _declared_members(port)
        if not hasattr(target, name)
    ]


def _signature_mismatches(target: type, port: type) -> list[str]:
    """Return declared members whose shape the target cannot serve."""

    mismatches: list[str] = []
    for name, member in _declared_members(port).items():
        actual = getattr(target, name, None)
        if actual is None:
            continue
        if isinstance(member, property):
            if not isinstance(actual, property):
                mismatches.append(f"{port.__name__}.{name} must be a property")
            continue
        if not callable(member) or not callable(actual):
            continue
        if not _accepts(inspect.signature(member), inspect.signature(actual)):
            mismatches.append(
                f"{port.__name__}.{name}: {inspect.signature(actual)} "
                f"cannot serve {inspect.signature(member)}"
            )
    return mismatches


def _accepts(expected: inspect.Signature, actual: inspect.Signature) -> bool:
    """Every declared parameter must exist, with compatible kind and requiredness."""

    available = {
        parameter.name: parameter
        for parameter in actual.parameters.values()
        if parameter.name != "self"
    }
    for parameter in expected.parameters.values():
        if parameter.name == "self":
            continue
        candidate = available.get(parameter.name)
        if candidate is None:
            return False
        # An implementation may accept a keyword-declared parameter positionally
        # (it still accepts the keyword), but not the other way around.
        if (
            parameter.kind is not inspect.Parameter.KEYWORD_ONLY
            and candidate.kind is inspect.Parameter.KEYWORD_ONLY
        ):
            return False
        if (
            parameter.default is not inspect.Parameter.empty
            and candidate.default is inspect.Parameter.empty
        ):
            return False
    return True


def test_runtime_owners_implement_every_declared_port_member() -> None:
    missing = [
        member
        for owner, ports in _OWNERS
        for port in ports
        for member in _missing_members(owner, port)
    ]

    assert missing == []


def test_runtime_owners_keep_port_signatures_compatible() -> None:
    mismatches = [
        mismatch
        for owner, ports in _OWNERS
        for port in ports
        for mismatch in _signature_mismatches(owner, port)
    ]

    assert mismatches == []


@dataclass(frozen=True, slots=True)
class _ClassShape:
    path: Path
    bases: tuple[str, ...]
    methods: Mapping[str, tuple[int, set[str]]]


def _class_shapes() -> dict[str, _ClassShape]:
    """Return every class defined in the providers package, by name."""

    shapes: dict[str, _ClassShape] = {}
    for path in sorted(_PROVIDERS_ROOT.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef):
                continue
            methods: dict[str, tuple[int, set[str]]] = {}
            for member in node.body:
                if not isinstance(member, ast.FunctionDef | ast.AsyncFunctionDef):
                    continue
                names = {
                    parameter.arg
                    for parameter in (
                        *member.args.posonlyargs,
                        *member.args.args,
                        *member.args.kwonlyargs,
                    )
                }
                methods[member.name] = (member.lineno, names)
            shapes[node.name] = _ClassShape(
                path=path,
                bases=tuple(
                    base.id if isinstance(base, ast.Name) else base.attr
                    for base in node.bases
                    if isinstance(base, ast.Name | ast.Attribute)
                ),
                methods=methods,
            )
    return shapes


def _provider_class_shapes() -> dict[str, _ClassShape]:
    """Return the classes that derive from BaseProvider, directly or not."""

    shapes = _class_shapes()
    providers: dict[str, _ClassShape] = {}
    changed = True
    while changed:
        changed = False
        for name, shape in shapes.items():
            if name in providers:
                continue
            if "BaseProvider" in shape.bases or any(
                base in providers for base in shape.bases
            ):
                providers[name] = shape
                changed = True
    return providers


def test_no_provider_narrows_the_declared_provider_port() -> None:
    """A provider override must still accept every keyword the port declares."""

    expected = {
        name: set(inspect.signature(getattr(ProviderPort, name)).parameters) - {"self"}
        for name in _PORT_METHODS
    }
    providers = _provider_class_shapes()
    # A broken inheritance walk would silently check nothing.
    assert {
        "OpenAIChatProvider",
        "DeepSeekProvider",
        "GeminiProvider",
        "GroqProvider",
        "LMStudioProvider",
        "MistralProvider",
    } <= set(providers)
    offenders: list[str] = []
    for class_name, shape in sorted(providers.items()):
        for method, (line, names) in sorted(shape.methods.items()):
            if method not in expected:
                continue
            missing = expected[method] - names
            if missing:
                offenders.append(
                    f"{shape.path.name}:{line}: {class_name}.{method} is missing "
                    f"{sorted(missing)}"
                )

    assert offenders == []


class _PartialPort(Protocol):
    """A port used to prove the conformance checks can fail."""

    def present(self) -> int: ...

    def missing(self) -> int: ...

    @property
    def renamed(self) -> int: ...


class _PartialRuntime:
    def present(self) -> int:
        return 1

    def renamed(self) -> int:
        return 1


def test_conformance_checks_report_missing_and_mistyped_members() -> None:
    assert _missing_members(_PartialRuntime, _PartialPort) == ["_PartialPort.missing"]
    assert _signature_mismatches(_PartialRuntime, _PartialPort) == [
        "_PartialPort.renamed must be a property"
    ]


class _BasePort(Protocol):
    def inherited(self) -> int: ...


class _DerivedPort(_BasePort, Protocol):
    def own(self) -> int: ...


def test_conformance_checks_include_inherited_port_members() -> None:
    assert sorted(_declared_members(_DerivedPort)) == ["inherited", "own"]
    assert _missing_members(_PartialRuntime, _DerivedPort) == [
        "_DerivedPort.inherited",
        "_DerivedPort.own",
    ]

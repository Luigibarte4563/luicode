import re
from pathlib import Path

from luicode.config.provider_catalog import PROVIDER_CATALOG
from luicode.messaging.platforms.factory import create_messaging_components
from luicode.providers.base import BaseProvider
from luicode.providers.cloudflare import CloudflareProvider
from luicode.providers.deepseek import DeepSeekProvider
from luicode.providers.gemini import GeminiProvider
from luicode.providers.github_copilot.provider import GitHubCopilotProvider
from luicode.providers.groq import GroqProvider
from luicode.providers.kilo import KiloProvider
from luicode.providers.lmstudio import LMStudioProvider
from luicode.providers.mistral import MistralProvider
from luicode.providers.nvidia_nim import NvidiaNimProvider
from luicode.providers.open_router import OpenRouterProvider
from luicode.providers.openai_chat import (
    OPENAI_CHAT_PROFILES,
    OpenAIChatProvider,
)
from luicode.providers.openai_codex.provider import OpenAICodexProvider
from luicode.providers.opencode import OpenCodeProvider
from luicode.providers.vertex import VertexProvider
from smoke.features import FEATURE_INVENTORY


def test_feature_inventory_is_unique_and_decision_complete() -> None:
    ids = [feature.feature_id for feature in FEATURE_INVENTORY]
    assert len(ids) == len(set(ids))
    assert "claude_pick" not in ids

    for feature in FEATURE_INVENTORY:
        assert feature.title.strip(), feature
        assert feature.skip_policy.strip(), feature
        assert feature.pytest_contract_tests, feature
        assert feature.has_pytest_coverage, feature
        if feature.product_e2e_tests:
            assert feature.smoke_targets, feature
            assert not feature.product_e2e_reason, feature
        else:
            assert feature.product_e2e_reason.strip(), feature
        if feature.live_prereq_tests:
            assert feature.smoke_targets, feature


def test_feature_inventory_test_owners_exist() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    pytest_names = _collect_test_names(repo_root / "tests")
    smoke_names = _collect_test_names(repo_root / "smoke")

    for feature in FEATURE_INVENTORY:
        for owner in feature.pytest_contract_tests:
            _assert_owner_exists(owner, repo_root, pytest_names)
        for owner in feature.live_prereq_tests + feature.product_e2e_tests:
            assert owner in smoke_names or owner in pytest_names, (feature, owner)


def test_product_coverage_is_not_satisfied_by_prereq_probes() -> None:
    for feature in FEATURE_INVENTORY:
        overlap = set(feature.live_prereq_tests) & set(feature.product_e2e_tests)
        assert not overlap, (feature.feature_id, sorted(overlap))
        if feature.product_e2e_tests:
            assert all("_e2e" in name for name in feature.product_e2e_tests), feature


def test_provider_and_platform_registries_include_builtins() -> None:
    specialized_provider_classes = {
        "openai": OpenAICodexProvider,
        "github_copilot": GitHubCopilotProvider,
        "opencode_zen": OpenCodeProvider,
        "opencode_go": OpenCodeProvider,
        "nvidia_nim": NvidiaNimProvider,
        "open_router": OpenRouterProvider,
        "mistral": MistralProvider,
        "deepseek": DeepSeekProvider,
        "kilo": KiloProvider,
        "cloudflare": CloudflareProvider,
        "lmstudio": LMStudioProvider,
        "groq": GroqProvider,
        "gemini": GeminiProvider,
        "vertex": VertexProvider,
    }
    assert set(OPENAI_CHAT_PROFILES).isdisjoint(specialized_provider_classes)
    assert set(PROVIDER_CATALOG) == (
        set(OPENAI_CHAT_PROFILES) | set(specialized_provider_classes)
    )
    assert issubclass(OpenAIChatProvider, BaseProvider)
    for provider_class in specialized_provider_classes.values():
        assert issubclass(provider_class, BaseProvider)

    assert create_messaging_components("not-a-platform") is None


def _collect_test_names(root: Path) -> set[str]:
    names: set[str] = set()
    for path in root.rglob("test_*.py"):
        text = path.read_text(encoding="utf-8")
        names.update(re.findall(r"^\s*(?:async\s+)?def (test_[^(]+)", text, re.M))
    return names


def _assert_owner_exists(owner: str, repo_root: Path, test_names: set[str]) -> None:
    if owner.startswith("test_"):
        assert owner in test_names, owner
        return

    path_part, _, node_name = owner.partition("::")
    path = repo_root / path_part
    assert path.exists(), owner
    if node_name:
        assert node_name in test_names, owner

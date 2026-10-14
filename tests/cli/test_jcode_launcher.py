"""Tests for the jcode launcher configuration."""

import tomllib

import pytest

from luicode.application.model_catalog import CatalogModel, ModelCatalog
from luicode.cli.launchers import jcode
from luicode.cli.launchers.jcode_config import build_jcode_config
from luicode.core.model_capabilities import ModelInputModality


def _model(
    slug: str,
    provider_ref: str,
    *,
    ctx: int | None = 200000,
    reasoning: bool = True,
    vision: bool = False,
) -> CatalogModel:
    mods = (
        (ModelInputModality.TEXT, ModelInputModality.IMAGE)
        if vision
        else (ModelInputModality.TEXT,)
    )
    return CatalogModel(
        wire_slug=slug,
        provider_model_ref=provider_ref,
        display_name=slug,
        supports_reasoning=reasoning,
        input_modalities=mods,
        context_window_tokens=ctx,
        max_output_tokens=None,
    )


def _build(models: tuple[CatalogModel, ...], **overrides: object) -> str:
    catalog = ModelCatalog(models, models[0].wire_slug)
    kwargs: dict[str, object] = {
        "base_url": "http://127.0.0.1:8082/v1",
        "api_key_env": "LUICODE_JCODE_TOKEN",
        "default_model": catalog.default_model_id,
    }
    kwargs.update(overrides)
    return build_jcode_config(catalog.models, **kwargs)  # type: ignore[arg-type]


def test_build_jcode_config_basic():
    config = _build(
        (
            _model("open_router/Zulu", "open_router/Zulu", ctx=128000),
            _model("deepseek/alpha", "deepseek/alpha"),
        ),
        stream_idle_timeout_secs=360,
    )
    parsed = tomllib.loads(config)

    # Provider section
    assert parsed["provider"]["default_provider"] == "luicode"
    assert parsed["provider"]["default_model"] == "open_router/Zulu"
    assert parsed["provider"]["stream_idle_timeout_secs"] == 360

    # LUICODE provider profile
    profile = parsed["providers"]["luicode"]
    assert profile["type"] == "anthropic-compatible"
    assert profile["base_url"] == "http://127.0.0.1:8082/v1"
    assert profile["auth"] == "bearer"
    assert profile["api_key_env"] == "LUICODE_JCODE_TOKEN"
    assert profile["disable_reasoning_heuristics"] is True
    assert profile["headers"] == {"x-app": "jcode"}

    ids = {model["id"]: model for model in profile["models"]}
    assert ids["open_router/Zulu"]["context_window"] == 128000
    assert ids["deepseek/alpha"]["context_window"] == 200000
    assert ids["open_router/Zulu"]["reasoning"] is True
    # Bare and anthropic-prefixed aliases both resolve to the same model
    assert ids["anthropic/open_router/Zulu"]["context_window"] == 128000


def test_build_jcode_config_omits_unknown_values():
    """Unknown context windows and non-reasoning models are left out."""
    parsed = tomllib.loads(
        _build((_model("unknown/model", "unknown/model", ctx=None, reasoning=False),))
    )

    assert "stream_idle_timeout_secs" not in parsed["provider"]
    entry = next(
        model
        for model in parsed["providers"]["luicode"]["models"]
        if model["id"] == "unknown/model"
    )
    assert "context_window" not in entry
    assert "reasoning" not in entry


def test_build_jcode_config_requires_model():
    with pytest.raises(ValueError, match="at least one routable"):
        build_jcode_config(
            (),
            base_url="http://127.0.0.1:8082/v1",
            api_key_env="LUICODE_JCODE_TOKEN",
            default_model="x",
        )


def test_build_jcode_config_vision_model():
    parsed = tomllib.loads(
        _build((_model("vision/model", "vision/model", vision=True),))
    )
    entry = parsed["providers"]["luicode"]["models"][0]
    assert entry["context_window"] == 200000
    assert entry["reasoning"] is True


def test_model_id_cannot_inject_toml_keys():
    """A provider-supplied id must not be able to rewrite the gateway URL."""
    hostile = 'vendor/evil" \nbase_url = "http://attacker.example/v1'
    parsed = tomllib.loads(_build((_model(hostile, hostile),)))

    profile = parsed["providers"]["luicode"]
    assert profile["base_url"] == "http://127.0.0.1:8082/v1"
    assert profile["api_key_env"] == "LUICODE_JCODE_TOKEN"
    assert set(profile) == {
        "type",
        "base_url",
        "auth",
        "api_key_env",
        "default_model",
        "disable_reasoning_heuristics",
        "headers",
        "models",
    }
    # The hostile id survives as data, unchanged, instead of becoming TOML.
    assert profile["models"][0]["id"] == hostile


def test_is_supported_version():
    assert jcode._is_supported_version("jcode v0.95.0 (abc123)") is True
    assert jcode._is_supported_version("jcode v0.90.0") is True
    assert jcode._is_supported_version("jcode v0.89.19-dev (be386f2)") is False
    assert jcode._is_supported_version("not jcode output") is False


def test_jcode_home_is_luicode_owned(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))

    home = jcode.jcode_home_path()

    assert home == tmp_path / ".luicode" / "jcode-home"
    assert not home.exists()


def test_jcode_routing_env_keys_are_stripped():
    """Lock the list of jcode overrides that must not leak from the user's shell."""
    assert set(jcode._JCODE_ROUTING_ENV_KEYS) == {
        "JCODE_OPENAI_COMPAT_API_BASE",
        "JCODE_OPENAI_COMPAT_DEFAULT_MODEL",
        "OPENAI_COMPAT_API_KEY",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "JCODE_OPENAI_EXTRA_BODY",
        "JCODE_STREAM_IDLE_TIMEOUT_SECS",
    }


def test_jcode_install_hint_contains_methods():
    assert "curl -fsSL https://jcode.sh/install" in jcode._INSTALL_HINT
    assert "irm https://jcode.sh/install.ps1" in jcode._INSTALL_HINT
    assert "brew tap 1jehuang/jcode" in jcode._INSTALL_HINT
    assert "cargo build --release" in jcode._INSTALL_HINT
    assert "pkg install glibc patchelf" in jcode._INSTALL_HINT

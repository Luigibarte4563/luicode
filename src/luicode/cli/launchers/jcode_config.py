"""Generate jcode TOML configuration for LUICODE gateway routing."""

from luicode.application.model_catalog import CatalogModel

# TOML basic strings also reject raw newlines and control characters, so escape
# the ones a provider id could plausibly contain and keep the file parseable.
# shortcut: other control characters (\x00-\x1f) are not escaped; extend the map
# if a provider is ever seen returning them.
_TOML_ESCAPES = str.maketrans(
    {"\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t"}
)


def _toml_string(value: str) -> str:
    """Quote a value for a TOML basic string, escaping what could break out.

    Model ids come from provider ``/v1/models`` responses, so a quote or
    backslash in one must not be able to add keys to the generated file.
    """

    return f'"{value.translate(_TOML_ESCAPES)}"'


def build_jcode_config(
    models: tuple[CatalogModel, ...],
    *,
    base_url: str,
    api_key_env: str,
    default_model: str,
    stream_idle_timeout_secs: int | None = None,
) -> str:
    """Project a non-empty LUICODE Messages catalog into jcode's config.toml.

    The gateway owns routing/fallbacks/reasoning; we only expose models and auth.
    """
    if not models:
        raise ValueError("jcode requires at least one routable LUICODE model")

    by_slug = {model.wire_slug: model for model in models}
    for model in models:
        by_slug.setdefault(f"anthropic/{model.wire_slug}", model)

    lines: list[str] = [
        "[provider]",
        'default_provider = "luicode"',
        f"default_model = {_toml_string(default_model)}",
    ]
    if stream_idle_timeout_secs is not None:
        lines.append(f"stream_idle_timeout_secs = {stream_idle_timeout_secs}")
    lines += [
        "",
        "[providers.luicode]",
        'type = "anthropic-compatible"',
        f"base_url = {_toml_string(base_url)}",
        'auth = "bearer"',
        f"api_key_env = {_toml_string(api_key_env)}",
        f"default_model = {_toml_string(default_model)}",
        "disable_reasoning_heuristics = true",
        "",
        "[providers.luicode.headers]",
        'x-app = "jcode"',
        "",
    ]

    for slug, model in sorted(
        by_slug.items(),
        key=lambda item: (
            item[1].provider_model_ref,
            item[0] != item[1].wire_slug,
            item[0],
        ),
    ):
        lines.append("[[providers.luicode.models]]")
        lines.append(f"id = {_toml_string(slug)}")
        if model.context_window_tokens is not None:
            lines.append(f"context_window = {model.context_window_tokens}")
        if model.supports_reasoning:
            lines.append("reasoning = true")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"

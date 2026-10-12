"""Canonical HTTP policy for the OpenAI SDK clients providers own.

Every provider that drives the OpenAI SDK must use the same timeout policy, retry
setting, and proxy/transport rule. Those live here; each provider still
constructs its own client, because that construction is the seam its tests
intercept.
"""

from collections.abc import Awaitable, Callable

import httpx2
from openai import DefaultAsyncHttpx2Client

from luicode.providers.base import ProviderConfig

OpenAIAsyncCredentialProvider = Callable[[], Awaitable[str]]
OpenAICredential = str | OpenAIAsyncCredentialProvider


def provider_timeout(config: ProviderConfig) -> httpx2.Timeout:
    """Return the one HTTP timeout policy provider SDK clients share."""

    return httpx2.Timeout(
        config.http_read_timeout,
        connect=config.http_connect_timeout,
        read=config.http_read_timeout,
        write=config.http_write_timeout,
    )


def openai_http_client(
    config: ProviderConfig,
    *,
    timeout: httpx2.Timeout,
    transport: httpx2.AsyncBaseTransport | None = None,
) -> httpx2.AsyncClient | None:
    """Return the client's HTTP layer from the shared proxy/transport rule.

    A caller that owns its connection pool passes ``transport``. Otherwise the
    configured provider proxy supplies the client, and without a proxy the SDK
    keeps its own default.
    """

    if transport is not None:
        return httpx2.AsyncClient(transport=transport, timeout=timeout)
    if config.proxy:
        return DefaultAsyncHttpx2Client(proxy=config.proxy, timeout=timeout)
    return None


def resolve_openai_credential(
    config: ProviderConfig,
    *,
    provider_name: str,
    api_key: OpenAICredential | None = None,
) -> OpenAICredential:
    """Return the SDK credential, refusing a provider with none configured."""

    credential = api_key if api_key is not None else config.api_key
    if credential is None:
        raise ValueError(f"{provider_name} requires an API key or credential provider")
    return credential


__all__ = [
    "OpenAIAsyncCredentialProvider",
    "OpenAICredential",
    "openai_http_client",
    "provider_timeout",
    "resolve_openai_credential",
]

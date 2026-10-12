"""SDK client construction for Chat provider resource owners."""

from collections.abc import Mapping

from openai import AsyncOpenAI

from luicode.providers.base import ProviderConfig
from luicode.providers.sdk_client import (
    OpenAIAsyncCredentialProvider,
    openai_http_client,
    provider_timeout,
    resolve_openai_credential,
)

__all__ = ["OpenAIAsyncCredentialProvider", "create_chat_client"]


def create_chat_client(
    config: ProviderConfig,
    *,
    base_url: str,
    provider_name: str,
    default_headers: Mapping[str, str] | None = None,
    api_key_provider: OpenAIAsyncCredentialProvider | None = None,
) -> AsyncOpenAI:
    """Create a provider-owned SDK client with LUICODE's shared HTTP policy."""

    credential = resolve_openai_credential(
        config, provider_name=provider_name, api_key=api_key_provider
    )
    timeout = provider_timeout(config)
    return AsyncOpenAI(
        api_key=credential,
        base_url=base_url,
        max_retries=0,
        default_headers=default_headers,
        timeout=timeout,
        http_client=openai_http_client(config, timeout=timeout),
    )

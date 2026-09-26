"""Single production composition root for the LUICODE server."""

import os
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING

from luicode.api.app import create_app
from luicode.api.ports import ApiServices
from luicode.application.code_sessions import CodeService
from luicode.config.loader import ManagedConfigStore
from luicode.config.logging_config import configure_logging
from luicode.config.paths import (
    code_database_path,
    code_lock_path,
    server_log_path,
)
from luicode.config.settings import Settings
from luicode.core.async_tasks import run_sync_owned
from luicode.messaging.voice import Transcriber
from luicode.providers.base import BaseProvider, ProviderConfig
from luicode.providers.github_copilot.auth import CopilotAuthManager
from luicode.providers.openai_codex.auth import OpenAIAuthManager
from luicode.providers.runtime.runtime import ProviderRuntime, create_provider

if TYPE_CHECKING:
    from luicode.providers.admission import ProviderAdmissionController
    from luicode.providers.runtime.factory import ProviderFactory

from .application import ApplicationRuntime, RestartCallback
from .asgi import RuntimeASGIApp
from .code_sessions_sqlite import SQLiteCodeStore
from .codex_app_server import CodexHarnessFactory
from .codex_catalog import CodexModelCatalogPublisher
from .configuration import ConfigurationService
from .provider_manager import ProviderRuntimeManager
from .web_tools.client import HTTPWebToolsClient

try:
    from luicode.application.browser_tools import (
        BrowserAutomationConfig,
        BrowserToolsService,
    )

    from .browser_tools.client import BrowserToolsClient
except ImportError:
    BrowserToolsClient: type | None = None
    BrowserToolsService: type | None = None
    BrowserAutomationConfig: type | None = None


def build_asgi_app(
    settings: Settings,
    restart_callback: RestartCallback | None = None,
) -> RuntimeASGIApp:
    """Construct the complete server application and its resource owner."""
    log_path = Path(os.getenv("LOG_FILE", server_log_path()))
    configure_logging(
        log_path,
        level=settings.log_level,
        verbose_third_party=settings.log_raw_api_payloads,
    )
    openai_auth = OpenAIAuthManager(proxy=settings.openai_proxy)
    copilot_auth = CopilotAuthManager()
    copilot_factory = partial(_load_copilot_provider, auth=copilot_auth)
    openai_factory = partial(_load_openai_provider, auth=openai_auth)
    provider_constructor = partial(
        create_provider,
        provider_loaders={
            "openai": openai_factory,
            "github_copilot": copilot_factory,
        },
    )
    runtime_factory = partial(
        ProviderRuntime,
        provider_constructor=provider_constructor,
    )
    provider_manager = ProviderRuntimeManager(
        settings,
        runtime_factory=runtime_factory,
        connected_provider_ids=lambda: (
            *openai_auth.connected_provider_ids(),
            *copilot_auth.connected_provider_ids(),
        ),
        model_catalog_publisher=CodexModelCatalogPublisher(),
    )
    code_service = CodeService(
        SQLiteCodeStore(code_database_path(), code_lock_path()),
        CodexHarnessFactory(provider_manager),
    )
    runtime = ApplicationRuntime(
        provider_manager,
        configuration=ConfigurationService(ManagedConfigStore()),
        code_service=code_service,
        transcriber=None,
        transcriber_factory=_create_transcriber,
        restart_callback=restart_callback,
        connected_accounts={"openai": openai_auth, "github_copilot": copilot_auth},
    )

    # Initialize browser tools service if available
    browser_tools_service = None
    if BrowserToolsService and BrowserAutomationConfig and BrowserToolsClient:
        browser_client = BrowserToolsClient(headless=True)
        browser_config = BrowserAutomationConfig(headless=True)
        browser_tools_service = BrowserToolsService(
            client=browser_client,
            config=browser_config,
        )

    services = ApiServices(
        requests=provider_manager,
        admin=runtime,
        tasks=runtime,
        web_tools=HTTPWebToolsClient(),
        browser_tools=browser_tools_service,
        code=code_service,
    )
    return RuntimeASGIApp(create_app(services), runtime)


def _load_openai_provider(*, auth: OpenAIAuthManager) -> ProviderFactory:
    from luicode.providers.openai_codex.provider import OpenAICodexProvider

    def construct(
        config: ProviderConfig,
        _settings: Settings,
        admission: ProviderAdmissionController,
    ) -> BaseProvider:
        return OpenAICodexProvider(config, auth=auth, admission=admission)

    return construct


def _load_copilot_provider(*, auth: CopilotAuthManager) -> ProviderFactory:
    from luicode.providers.github_copilot.provider import GitHubCopilotProvider

    def construct(
        config: ProviderConfig,
        _settings: Settings,
        admission: ProviderAdmissionController,
    ) -> BaseProvider:
        return GitHubCopilotProvider(config, auth=auth, admission=admission)

    return construct


async def _create_transcriber(settings: Settings) -> Transcriber | None:
    if not settings.voice_note_enabled:
        return None

    def load():
        if settings.whisper_device == "nvidia_nim":
            from luicode.providers.nvidia_nim.voice import NvidiaNimTranscriber

            return partial(
                NvidiaNimTranscriber,
                model=settings.whisper_model,
                api_key=_required_voice_key(settings.nvidia_nim_api_key),
            )
        from luicode.messaging.transcription import TranscriptionService

        return partial(
            TranscriptionService,
            model=settings.whisper_model,
            device=settings.whisper_device,
            huggingface_api_key=settings.huggingface_api_key,
        )

    constructor = await run_sync_owned(load)
    return constructor()


def _required_voice_key(api_key: str | None) -> str:
    if api_key is None:
        raise AssertionError("NIM voice settings were not validated")
    return api_key

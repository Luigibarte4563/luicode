"""Explicit web-client double for tests that do not perform outbound requests."""

import pytest

from luicode.application.web_tools.ports import WebFetchEgressPolicy
from luicode.core.web_tools import WebFetchResult, WebSearchResult


class StubWebToolsClient:
    async def search(self, query: str) -> list[WebSearchResult]:
        pytest.fail(f"Unexpected web search: {query!r}")

    async def fetch(self, url: str, *, egress: WebFetchEgressPolicy) -> WebFetchResult:
        pytest.fail(f"Unexpected web fetch: {url!r}")

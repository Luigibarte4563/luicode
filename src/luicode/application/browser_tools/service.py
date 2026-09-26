"""Browser automation service implementing the BrowserToolsPort."""

from typing import Any

from luicode.application.browser_tools.ports import (
    BrowserAutomationConfig,
    BrowserToolsPort,
)


class BrowserToolsService:
    """Application-level browser automation service."""

    def __init__(
        self,
        *,
        client: BrowserToolsPort,
        config: BrowserAutomationConfig | None = None,
    ) -> None:
        self._client = client
        self._config = config or BrowserAutomationConfig()

    async def navigate(self, url: str) -> Any:
        """Navigate to a URL."""
        return await self._client.navigate(url)

    async def observe(self) -> Any:
        """Observe current page state."""
        return await self._client.observe()

    async def click(self, node_id: int) -> Any:
        """Click an element."""
        return await self._client.click(node_id)

    async def fill(self, node_id: int, text: str) -> Any:
        """Fill text into an element."""
        return await self._client.fill(node_id, text)

    async def select(self, node_id: int, value: str) -> Any:
        """Select a dropdown option."""
        return await self._client.select(node_id, value)

    async def scroll(self, delta: int) -> Any:
        """Scroll the page."""
        return await self._client.scroll(delta)

    async def wait(self, timeout: float = 2.0) -> Any:
        """Wait for page to settle."""
        return await self._client.wait(timeout)

    async def close(self) -> None:
        """Close the browser session."""
        await self._client.close()

    async def run_task(self, steps: list[dict[str, Any]]) -> list[Any]:
        """Run a sequence of browser automation steps."""
        return await self._client.run_task(steps)


# Factory function for dependency injection
async def create_browser_tools_service(
    client: BrowserToolsPort,
    config: BrowserAutomationConfig | None = None,
) -> BrowserToolsService:
    """Create a browser tools service with the given client."""
    return BrowserToolsService(client=client, config=config)

"""Browser automation client using CDP (Chrome DevTools Protocol) via browser-harness.

This integrates JEV-Ultrafast's browser automation capabilities into LUICode.
Provides a high-level async interface for browser automation tasks.
"""

import asyncio
import base64
import contextlib
import hashlib
import json
import time
from pathlib import Path
from typing import Any

try:
    from browser_harness.admin import ensure_daemon
    from browser_harness.helpers import cdp
except ImportError as e:
    raise ImportError(
        "Browser automation requires the 'browser' extra. "
        "Install with: uv sync --extra browser"
    ) from e

from luicode.core.browser_tools import BrowserActionResult, BrowserState

# Atomically read visible content and controls, preserving actual DOM node identity.
# This is adapted from JEV-Ultrafast's snapshot.js
READ_STATE_JS = """
(() => {
  const nodes = new Map();
  let nodeCounter = 0;
  const getNodeId = (node) => {
    if (!nodes.has(node)) {
      nodes.set(node, ++nodeCounter);
    }
    return nodes.get(node);
  };

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT,
    null
  );

  const actions = [];
  const controls = {};
  let currentNode;
  while (currentNode = walker.nextNode()) {
    const el = currentNode;
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const label = el.getAttribute('aria-label') ||
                  el.getAttribute('placeholder') ||
                  el.getAttribute('title') ||
                  el.textContent?.trim().slice(0, 100) ||
                  el.tagName.toLowerCase();
    const rect = el.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 &&
                    rect.bottom > 0 && rect.top < window.innerHeight &&
                    el.checkVisibility({checkOpacity: true, checkVisibilityCSS: true});
    const disabled = el.matches(':disabled, [aria-disabled="true"], [inert]') ||
                     (role === 'textbox' && (el.readOnly || el.getAttribute('aria-readonly') === 'true'));

    if (!visible || disabled) continue;

    const nodeId = getNodeId(el);
    const id = String(nodeId);
    const kind = (() => {
      if (role === 'button' || role === 'menuitem' || role === 'tab' ||
          role === 'checkbox' || role === 'radio' || role === 'switch' ||
          role === 'treeitem' || role === 'option' ||
          el.tagName === 'A' || el.tagName === 'BUTTON' ||
          (el.tagName === 'INPUT' && ['button', 'submit', 'reset', 'checkbox', 'radio'].includes(el.type))) {
        return 'click';
      }
      if (role === 'textbox' || role === 'searchbox' || role === 'combobox' ||
          el.tagName === 'INPUT' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'hidden'].includes(el.type) ||
          el.tagName === 'TEXTAREA') {
        return 'fill';
      }
      if (role === 'combobox' || el.tagName === 'SELECT') {
        return 'select';
      }
      return null;
    })();

    if (!kind) continue;

    const action = {
      id: id,
      node: nodeId,
      kind: kind,
      role: role,
      label: label,
      value: el.value || '',
      checked: el.checked,
      selected: el.selected,
      expanded: el.getAttribute('aria-expanded') === 'true',
      rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
    };
    actions.push(action);
  }

  // Scroll info
  const scroll = {
    x: window.scrollX,
    y: window.scrollY,
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  };

  // Page text (truncated)
  const text = document.body.innerText.slice(0, 15000);

  // Fingerprint for staleness detection
  const pageKey = (document.title + '|' + location.href).slice(0, 500);
  const guards = {};
  for (const [node, id] of nodes) {
    guards[id] = node.isConnected ? 'ok' : 'gone';
  }
  const marker = JSON.stringify({pageKey, guards});

  return {
    url: location.href,
    title: document.title,
    text: text,
    actions: actions,
    scroll: scroll,
    page_key: pageKey,
    guards: guards,
    marker: marker,
  };
})()
"""

MARKER_JS = "(() => { const state=" + READ_STATE_JS + "; return state?.marker ?? null; })()"


class StalePage(ValueError):
    """A decision no longer refers to the observed page."""


class BrowserToolsClient:
    """Async browser automation client using CDP via browser-harness.

    Provides high-level operations for browser automation:
    - navigate: Navigate to a URL
    - observe: Get current page state with interactive elements
    - click: Click an element by node ID
    - fill: Fill text into an input field
    - select: Select an option from a dropdown
    - scroll: Scroll the page
    - wait: Wait for page to settle
    - close: Close the browser session
    """

    def __init__(self, url: str = "about:blank", *, headless: bool = False):
        self._url = url
        self._headless = headless
        self._target_id: str | None = None
        self._session_id: str | None = None
        self._after_input_action: dict[str, Any] | None = None
        self._page: dict[str, Any] | None = None
        self._started_at: float | None = None

    async def __aenter__(self) -> BrowserToolsClient:
        await self.start()
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def start(self) -> None:
        """Start the browser session and navigate to the initial URL."""
        # Ensure browser-harness daemon is running
        ensure_daemon()

        # Create a new background target
        self._target_id = cdp("Target.createTarget", url="about:blank", background=True)["targetId"]
        self._session_id = cdp("Target.attachToTarget", targetId=self._target_id, flatten=True)["sessionId"]

        # Set viewport
        cdp("Emulation.setDeviceMetricsOverride",
            session_id=self._session_id,
            width=1120, height=780, deviceScaleFactor=1, mobile=False)

        # Keep rAF/menus rendering in background tab without activating user's Chrome tab
        cdp("Emulation.setFocusEmulationEnabled", session_id=self._session_id, enabled=True)

        # Navigate to initial URL
        if self._url != "about:blank":
            await self.navigate(self._url)

        self._started_at = time.perf_counter()

    def _call_cdp(self, method: str, **params: Any) -> Any:
        """Call a CDP method on the current session."""
        if not self._session_id:
            raise RuntimeError("Browser not started. Call start() first.")
        return cdp(method, session_id=self._session_id, **params)

    def _evaluate(self, expression: str) -> Any:
        """Evaluate JavaScript in the browser context."""
        response = self._call_cdp("Runtime.evaluate", expression=expression, returnByValue=True)
        if response.get("exceptionDetails"):
            raise StalePage("Document changed during evaluation")
        return response.get("result", {}).get("value")

    async def navigate(self, url: str) -> None:
        """Navigate to a URL and wait for page load."""
        self._call_cdp("Page.navigate", url=url)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if self._evaluate("document.readyState") == "complete":
                break
            await asyncio.sleep(0.02)
        else:
            raise TimeoutError(f"Page load timed out after 30s: {url}")
        # Observe to get initial state
        self._page = await self.observe()

    def _fingerprint(self, state: dict[str, Any]) -> str:
        """Compute fingerprint for staleness detection."""
        content = {k: state[k] for k in ("url", "text", "actions", "scroll")}
        return hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()

    async def observe(self, screenshot: bool = False) -> dict[str, Any]:
        """Observe the current page state, returning interactive elements."""
        if not self._session_id:
            raise RuntimeError("Browser not started. Call start() first.")

        # Handle post-input observation if needed
        if self._after_input_action:
            action = self._after_input_action
            self._after_input_action = None
            try:
                # Wait for autocomplete suggestions or animation frames
                _ = action.get("kind") == "fill" and action.get("role") == "combobox"
                await self._call_cdp(
                    "Runtime.evaluate",
                    expression=f"""
                    (action => new Promise(resolve => {{
                      const field = window.__jevFast?.nodes.get(action.node);
                      const autocomplete = action.kind === 'fill' && field?.getAttribute('role') === 'combobox';
                      let frames = 0, stopped = false;
                      const finish = () => {{ stopped = true; resolve(); }};
                      setTimeout(finish, autocomplete ? 200 : 50);
                      const ready = () => {{
                        if (stopped) return;
                        const ids = (field?.getAttribute('aria-controls') || field?.getAttribute('aria-owns') || '')
                          .split(/\\s+/).filter(Boolean);
                        const roots = ids.length ? ids.map(id => document.getElementById(id)).filter(Boolean) : [document];
                        const options = roots.flatMap(root => [...root.querySelectorAll('[role="option"]')]);
                        if (++frames >= 2 && (!autocomplete || options.some(e => {{
                          const r = e.getBoundingClientRect();
                          return r.width && r.height && r.bottom > 0 && r.top < innerHeight &&
                            e.checkVisibility({{checkOpacity: true, checkVisibilityCSS: true}});
                        }}))) finish();
                        else requestAnimationFrame(ready);
                      }};
                      requestAnimationFrame(ready);
                    }})({json.dumps(action)})
                    """,
                    awaitPromise=True,
                    returnByValue=True,
                )
            except RuntimeError:
                pass

        # Observe with retries for page settling
        for attempt in range(10):
            try:
                info = await self._browser_operation({"operation": "observe", "screenshot": screenshot})
                self._page = info
                return info
            except StalePage:
                if attempt == 9:
                    raise
                await asyncio.sleep(0.02)
        raise StalePage("Page did not settle")

    def _fresh(self, page: dict[str, Any], action: dict[str, Any] | None = None) -> bool:
        """Check if page is still fresh (not stale)."""
        if action is not None and action.get("kind") in {"click", "select"}:
            node = action.get("node")
            if not isinstance(node, int):
                return False
            current = self._evaluate(f"""
                (() => {{
                  const c = window.__jevFast;
                  return c ? [c.pageKey(), c.guard(c.nodes.get({node}))] : null;
                }})()
            """)
            return current == [page["page_key"], page["guards"].get(str(node))]
        return self._evaluate(MARKER_JS) == page.get("marker")

    async def _browser_operation(self, request: dict[str, Any]) -> dict[str, Any]:
        """Execute a browser operation via CDP."""
        operation = request["operation"]

        def call(method: str, **params: Any) -> Any:
            return cdp(method, session_id=self._session_id, **params)

        def evaluate(expression: str) -> Any:
            result = call("Runtime.evaluate", expression=expression, returnByValue=True)
            if result.get("exceptionDetails"):
                if operation == "act" and request.get("action", {}).get("kind") == "select":
                    raise RuntimeError("Dropdown execution was interrupted; inspect before retrying.")
                raise StalePage("Document changed during evaluation")
            return result.get("result", {}).get("value")

        if operation == "act":
            action = request["action"]
            kind = action.get("kind")
            if kind == "scroll":
                call("Input.dispatchMouseEvent",
                     type="mouseWheel", x=550, y=650, deltaX=0, deltaY=action.get("delta", 0))
            elif kind != "wait":
                if not isinstance(action.get("node"), int):
                    raise ValueError("Invalid observed node")
                # Code-owned node IDs refer to actual observed elements
                target = evaluate(f"""
                    (action => {{
                      const e = window.__jevFast?.nodes.get(action.node);
                      if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
                          !e.checkVisibility({{checkOpacity:true,checkVisibilityCSS:true}})) return null;
                      if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
                      const r = e.getBoundingClientRect(), x = r.x + r.width/2, y = r.y + r.height/2;
                      if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
                      if (!e.contains(document.elementFromPoint(x,y))) return null;
                      if (action.kind === 'select') {{
                        if (e.tagName !== 'SELECT' || ![...e.options].some(o =>
                            o.value === action.value && !o.disabled && !o.closest('optgroup[disabled]')))
                          return null;
                        e.value = action.value;
                        e.dispatchEvent(new Event('input', {{bubbles: true}}));
                        e.dispatchEvent(new Event('change', {{bubbles: true}}));
                      }}
                      return {{x, y}};
                    }})({json.dumps(action)})
                """)
                if target is None:
                    if kind == "select":
                        raise RuntimeError("Dropdown execution was not confirmed; inspect before retrying.")
                    raise StalePage("Target changed or is covered. Observe again.")
                if kind != "select":
                    x, y = target["x"], target["y"]
                    for event in ("mousePressed", "mouseReleased"):
                        call("Input.dispatchMouseEvent",
                             type=event, x=x, y=y, button="left", clickCount=1)
                    if kind == "fill":
                        text = request.get("text", "")
                        import sys
                        modifiers = 4 if sys.platform == "darwin" else 2
                        call("Input.dispatchKeyEvent",
                             type="keyDown", key="a", code="KeyA", modifiers=modifiers, commands=["selectAll"])
                        call("Input.dispatchKeyEvent",
                             type="keyUp", key="a", code="KeyA", modifiers=modifiers)
                        call("Input.insertText", text=text)
            return {"executed": action.get("id")}

        # Observe operation
        info = evaluate(READ_STATE_JS)
        if info is None:
            raise StalePage("Document is navigating")
        info["fingerprint"] = self._fingerprint(info)
        if request.get("screenshot", True):
            info["screenshot"] = call("Page.captureScreenshot", format="jpeg", quality=72)["data"]
        return info

    async def act(self, action: dict[str, Any], page: dict[str, Any], text: str | None = None) -> dict[str, Any]:
        """Execute an action on the page."""
        if not self._fresh(page, action):
            raise StalePage("Page changed since this decision. Observe again.")

        if action.get("kind") == "wait":
            await asyncio.sleep(0.1)

        result = await self._browser_operation({
            "operation": "act",
            "action": action,
            "text": text,
        })

        self._after_input_action = action if action.get("kind") != "wait" else None
        return result

    # High-level action methods

    async def click(self, node_id: int, page: dict[str, Any]) -> BrowserActionResult:
        """Click an element by node ID."""
        action = next((a for a in page.get("actions", []) if a.get("node") == node_id), None)
        if not action:
            return BrowserActionResult(
                action="click",
                target=str(node_id),
                success=False,
                message=f"Element with node_id {node_id} not found in current page",
            )
        if action.get("kind") != "click":
            return BrowserActionResult(
                action="click",
                target=str(node_id),
                success=False,
                message=f"Element {node_id} is not clickable (kind: {action.get('kind')})",
            )
        try:
            await self.act(action, page)
            return BrowserActionResult(
                action="click",
                target=str(node_id),
                success=True,
                message=f"Clicked element: {action.get('label', 'unknown')}",
            )
        except StalePage as e:
            return BrowserActionResult(
                action="click",
                target=str(node_id),
                success=False,
                message=str(e),
            )
        except Exception as e:
            return BrowserActionResult(
                action="click",
                target=str(node_id),
                success=False,
                message=f"Click failed: {e}",
            )

    async def fill(self, node_id: int, text: str, page: dict[str, Any]) -> BrowserActionResult:
        """Fill text into an input field by node ID."""
        action = next((a for a in page.get("actions", []) if a.get("node") == node_id), None)
        if not action:
            return BrowserActionResult(
                action="fill",
                target=str(node_id),
                success=False,
                message=f"Element with node_id {node_id} not found in current page",
            )
        if action.get("kind") != "fill":
            return BrowserActionResult(
                action="fill",
                target=str(node_id),
                success=False,
                message=f"Element {node_id} is not fillable (kind: {action.get('kind')})",
            )
        try:
            await self.act(action, page, text=text)
            return BrowserActionResult(
                action="fill",
                target=str(node_id),
                success=True,
                message=f"Filled element: {action.get('label', 'unknown')}",
            )
        except StalePage as e:
            return BrowserActionResult(
                action="fill",
                target=str(node_id),
                success=False,
                message=str(e),
            )
        except Exception as e:
            return BrowserActionResult(
                action="fill",
                target=str(node_id),
                success=False,
                message=f"Fill failed: {e}",
            )

    async def select(self, node_id: int, value: str, page: dict[str, Any]) -> BrowserActionResult:
        """Select an option from a dropdown by node ID."""
        action = next((a for a in page.get("actions", []) if a.get("node") == node_id), None)
        if not action:
            return BrowserActionResult(
                action="select",
                target=str(node_id),
                success=False,
                message=f"Element with node_id {node_id} not found in current page",
            )
        if action.get("kind") != "select":
            return BrowserActionResult(
                action="select",
                target=str(node_id),
                success=False,
                message=f"Element {node_id} is not a select dropdown (kind: {action.get('kind')})",
            )
        # Create a select action with the desired value
        select_action = {**action, "value": value}
        try:
            await self.act(select_action, page)
            return BrowserActionResult(
                action="select",
                target=f"{node_id}:{value}",
                success=True,
                message=f"Selected option: {value}",
            )
        except StalePage as e:
            return BrowserActionResult(
                action="select",
                target=str(node_id),
                success=False,
                message=str(e),
            )
        except Exception as e:
            return BrowserActionResult(
                action="select",
                target=str(node_id),
                success=False,
                message=f"Select failed: {e}",
            )

    async def scroll(self, delta: int, page: dict[str, Any]) -> BrowserActionResult:
        """Scroll the page by delta pixels (positive = down)."""
        action = {"kind": "scroll", "delta": delta}
        try:
            await self.act(action, page)
            return BrowserActionResult(
                action="scroll",
                target=str(delta),
                success=True,
                message=f"Scrolled by {delta}px",
            )
        except Exception as e:
            return BrowserActionResult(
                action="scroll",
                target=str(delta),
                success=False,
                message=f"Scroll failed: {e}",
            )

    async def wait(self, page: dict[str, Any], timeout: float = 2.0) -> BrowserActionResult:
        """Wait for page to settle."""
        action = {"kind": "wait"}
        try:
            await self.act(action, page)
            await asyncio.sleep(min(timeout, 0.5))
            return BrowserActionResult(
                action="wait",
                target=None,
                success=True,
                message="Wait completed",
            )
        except Exception as e:
            return BrowserActionResult(
                action="wait",
                target=None,
                success=False,
                message=f"Wait failed: {e}",
            )

    # Protocol-compatible methods (call observe internally)
    async def click_by_id(self, node_id: int) -> BrowserActionResult:
        """Click an element by node ID (protocol-compatible)."""
        page = await self.observe()
        return await self.click(node_id, page)

    async def fill_by_id(self, node_id: int, text: str) -> BrowserActionResult:
        """Fill text into an element by node ID (protocol-compatible)."""
        page = await self.observe()
        return await self.fill(node_id, text, page)

    async def select_by_id(self, node_id: int, value: str) -> BrowserActionResult:
        """Select a dropdown option by node ID (protocol-compatible)."""
        page = await self.observe()
        return await self.select(node_id, value, page)

    async def scroll_by_delta(self, delta: int) -> BrowserActionResult:
        """Scroll the page by delta pixels (protocol-compatible)."""
        page = await self.observe()
        return await self.scroll(delta, page)

    async def wait_for_settle(self, timeout: float = 2.0) -> BrowserActionResult:
        """Wait for page to settle (protocol-compatible)."""
        page = await self.observe()
        return await self.wait(page, timeout)

    def get_state(self, page: dict[str, Any] | None = None) -> BrowserState:
        """Get current browser state as a structured object."""
        page = page or self._page
        if not page:
            raise RuntimeError("No page observed yet. Call observe() first.")
        return BrowserState(
            url=page.get("url", ""),
            title=page.get("title", ""),
            text=page.get("text", ""),
            elements=page.get("actions", []),
            fingerprint=page.get("fingerprint", ""),
        )

    async def close(self) -> None:
        """Close the browser session."""
        if self._target_id:
            with contextlib.suppress(Exception):
                cdp("Target.closeTarget", targetId=self._target_id)
            self._target_id = None
            self._session_id = None
            self._page = None
            self._after_input_action = None


# Convenience function for simple automation tasks
async def run_browser_task(
    url: str,
    steps: list[dict[str, Any]],
    *,
    headless: bool = False,
    screenshot_dir: str | None = None,
) -> list[BrowserActionResult]:
    """Run a sequence of browser automation steps.

    Args:
        url: Starting URL
        steps: List of step dicts with keys:
            - action: "click" | "fill" | "select" | "scroll" | "wait" | "navigate" | "observe"
            - target: element node_id (for click/fill/select) or value (for select/fill/scroll)
            - text: text to fill (for fill action)
            - url: URL to navigate to (for navigate action)
        headless: Run in headless mode
        screenshot_dir: Optional directory to save screenshots

    Returns:
        List of BrowserActionResult for each step
    """
    results = []
    screenshot_path = Path(screenshot_dir) if screenshot_dir else None
    if screenshot_path:
        screenshot_path.mkdir(parents=True, exist_ok=True)

    async with BrowserToolsClient(url, headless=headless) as client:
        page = await client.observe(screenshot=bool(screenshot_path))
        if screenshot_path and page.get("screenshot"):
            (screenshot_path / "000000.jpg").write_bytes(base64.b64decode(page["screenshot"]))

        for _i, step in enumerate(steps):
            action = step.get("action")
            target = step.get("target")
            text = step.get("text")

            if action == "navigate":
                await client.navigate(step.get("url", ""))
                page = await client.observe(screenshot=bool(screenshot_path))
                results.append(BrowserActionResult(
                    action="navigate",
                    target=step.get("url", ""),
                    success=True,
                    message=f"Navigated to {step.get('url', '')}",
                ))
            elif action == "observe":
                page = await client.observe(screenshot=bool(screenshot_path))
                results.append(BrowserActionResult(
                    action="observe",
                    target=None,
                    success=True,
                    message="Page observed",
                    data={"elements_count": len(page.get("actions", []))},
                ))
            elif action == "click":
                if target is None:
                    results.append(BrowserActionResult(
                        action="click",
                        target=None,
                        success=False,
                        message="Click action requires a target node_id",
                    ))
                else:
                    result = await client.click(int(target), page)
                    results.append(result)
                    if result.success:
                        page = await client.observe(screenshot=bool(screenshot_path))
            elif action == "fill":
                if target is None:
                    results.append(BrowserActionResult(
                        action="fill",
                        target=None,
                        success=False,
                        message="Fill action requires a target node_id",
                    ))
                else:
                    result = await client.fill(int(target), text or "", page)
                    results.append(result)
                    if result.success:
                        page = await client.observe(screenshot=bool(screenshot_path))
            elif action == "select":
                if target is None:
                    results.append(BrowserActionResult(
                        action="select",
                        target=None,
                        success=False,
                        message="Select action requires a target node_id",
                    ))
                else:
                    result = await client.select(int(target), text or "", page)
                    results.append(result)
                    if result.success:
                        page = await client.observe(screenshot=bool(screenshot_path))
            elif action == "scroll":
                result = await client.scroll(int(target or 0), page)
                results.append(result)
                if result.success:
                    page = await client.observe(screenshot=bool(screenshot_path))
            elif action == "wait":
                result = await client.wait(page, timeout=step.get("timeout", 2.0))
                results.append(result)
                if result.success:
                    page = await client.observe(screenshot=bool(screenshot_path))
            else:
                results.append(BrowserActionResult(
                    action=action or "unknown",
                    target=str(target) if target else None,
                    success=False,
                    message=f"Unknown action: {action}",
                ))

            # Save screenshot if requested
            if screenshot_path and page.get("screenshot"):
                elapsed = int((time.perf_counter() - (client._started_at or time.perf_counter())) * 1000)
                (screenshot_path / f"{elapsed:06d}.jpg").write_bytes(base64.b64decode(page["screenshot"]))

    return results

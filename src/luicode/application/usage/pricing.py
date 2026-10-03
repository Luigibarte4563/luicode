"""Pricing lookup from bundled table + user override."""

from __future__ import annotations

import threading
from dataclasses import dataclass
from importlib import resources
from typing import Any

import tomllib
import tomlkit

from luicode.config.paths import config_dir_path


@dataclass(frozen=True, slots=True)
class ModelPrice:
    input_per_million: float
    output_per_million: float
    source: str  # "bundled" | "override"


class PriceTable:
    """Thread-safe price lookup with bundled defaults and user overrides."""

    def __init__(self) -> None:
        self._bundled: dict[str, dict[str, ModelPrice]] = {}
        self._override: dict[str, dict[str, ModelPrice]] = {}
        self._lock = threading.RLock()
        self._loaded = False

    def _load_bundled(self) -> None:
        if self._loaded:
            return
        # Load from package data (shipped in wheel), not from repo root
        asset = resources.files("luicode.application.usage").joinpath("data/pricing.toml")
        with resources.as_file(asset) as path:
            with path.open("rb") as f:
                data = tomllib.load(f)
        for provider, models in data.items():
            if provider == "metadata":
                continue
            self._bundled[provider] = {}
            for model, prices in models.items():
                if isinstance(prices, dict) and "input" in prices and "output" in prices:
                    self._bundled[provider][model] = ModelPrice(
                        input_per_million=float(prices["input"]),
                        output_per_million=float(prices["output"]),
                        source="bundled",
                    )
        self._load_override()
        self._loaded = True

    def _load_override(self) -> None:
        override_path = config_dir_path() / "pricing.override.toml"
        if override_path.exists():
            try:
                with open(override_path, "rb") as f:
                    data = tomllib.load(f)
                for provider, models in data.items():
                    if provider == "metadata":
                        continue
                    self._override[provider] = {}
                    for model, prices in models.items():
                        if isinstance(prices, dict) and "input" in prices and "output" in prices:
                            self._override[provider][model] = ModelPrice(
                                input_per_million=float(prices["input"]),
                                output_per_million=float(prices["output"]),
                                source="override",
                            )
            except Exception:
                pass  # Ignore malformed override

    def get_price(self, provider_id: str, model_id: str) -> ModelPrice | None:
        """Look up price for a provider/model. Checks override first, then bundled."""
        self._load_bundled()
        with self._lock:
            # Try exact match in override
            if provider_id in self._override and model_id in self._override[provider_id]:
                return self._override[provider_id][model_id]
            # Try exact match in bundled
            if provider_id in self._bundled and model_id in self._bundled[provider_id]:
                return self._bundled[provider_id][model_id]
            # Try wildcard in override (e.g., "ollama/*")
            if provider_id in self._override and "*" in self._override[provider_id]:
                return self._override[provider_id]["*"]
            if provider_id in self._bundled and "*" in self._bundled[provider_id]:
                return self._bundled[provider_id]["*"]
            # Try OpenRouter-style prefix matching
            for prefixed_provider in ("openrouter", "together", "fireworks", "nvidia", "azure", "bedrock"):
                if provider_id == prefixed_provider:
                    # Models from these providers often have full paths
                    for key, price in self._bundled.get(prefixed_provider, {}).items():
                        if model_id.endswith(key) or key in model_id:
                            return price
            return None

    def calculate_cost(
        self,
        provider_id: str,
        model_id: str,
        input_tokens: int,
        output_tokens: int,
    ) -> tuple[float | None, str]:
        """Return (cost_usd, source) or (None, 'unknown')."""
        price = self.get_price(provider_id, model_id)
        if price is None:
            return None, "unknown"
        if price.input_per_million == 0 and price.output_per_million == 0:
            return 0.0, price.source
        cost = (input_tokens * price.input_per_million + output_tokens * price.output_per_million) / 1_000_000
        return round(cost, 8), price.source

    def set_override(self, provider_id: str, model_id: str, input_price: float, output_price: float) -> None:
        """Set a user override price and persist to disk."""
        self._load_bundled()
        with self._lock:
            if provider_id not in self._override:
                self._override[provider_id] = {}
            self._override[provider_id][model_id] = ModelPrice(
                input_per_million=input_price,
                output_per_million=output_price,
                source="override",
            )
        self._persist_override()

    def remove_override(self, provider_id: str, model_id: str) -> bool:
        """Remove a user override. Returns True if one existed."""
        self._load_bundled()
        with self._lock:
            if provider_id in self._override and model_id in self._override[provider_id]:
                del self._override[provider_id][model_id]
                if not self._override[provider_id]:
                    del self._override[provider_id]
                self._persist_override()
                return True
            return False

    def list_overrides(self) -> dict[str, dict[str, ModelPrice]]:
        """Return all user overrides."""
        self._load_bundled()
        with self._lock:
            return {p: dict(m) for p, m in self._override.items()}

    def _persist_override(self) -> None:
        override_path = config_dir_path() / "pricing.override.toml"
        try:
            data: dict[str, Any] = {}
            for provider, models in self._override.items():
                data[provider] = {}
                for model, price in models.items():
                    data[provider][model] = {
                        "input": price.input_per_million,
                        "output": price.output_per_million,
                    }
            override_path.parent.mkdir(parents=True, exist_ok=True)
            with open(override_path, "w", encoding="utf-8") as f:
                f.write(tomlkit.dumps(data))
        except Exception:
            pass


PRICE_TABLE = PriceTable()
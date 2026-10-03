"""Tests for pricing lookup."""

from __future__ import annotations

import tempfile
import tomli_w
from pathlib import Path

from luicode.application.usage.pricing import ModelPrice, PriceTable
from luicode.config.paths import config_dir_path


def test_price_table_bundled():
    """Test that bundled prices are loaded."""
    table = PriceTable()
    # Force reload
    table._loaded = False
    table._bundled.clear()
    table._override.clear()

    price = table.get_price("anthropic", "claude-3-5-sonnet-20241022")
    assert price is not None
    assert price.input_per_million == 3.0
    assert price.output_per_million == 15.0
    assert price.source == "bundled"


def test_price_table_free_provider():
    """Test that free/local providers return $0 price."""
    table = PriceTable()
    table._loaded = False
    table._bundled.clear()
    table._override.clear()

    price = table.get_price("ollama", "llama3")
    assert price is not None
    assert price.input_per_million == 0.0
    assert price.output_per_million == 0.0
    assert price.source == "bundled"


def test_price_table_missing_model():
    """Test that missing models return None."""
    table = PriceTable()
    table._loaded = False
    table._bundled.clear()
    table._override.clear()

    price = table.get_price("nonexistent", "model")
    assert price is None


def test_price_calculation():
    """Test cost calculation."""
    table = PriceTable()
    table._loaded = False
    table._bundled.clear()
    table._override.clear()

    # 1000 input + 500 output tokens at $3/$15 per M
    cost, source = table.calculate_cost("anthropic", "claude-3-5-sonnet-20241022", 1000, 500)
    assert cost is not None
    expected = (1000 * 3.0 + 500 * 15.0) / 1_000_000
    assert cost == round(expected, 8)
    assert source == "bundled"


def test_price_calculation_free():
    """Test cost calculation for free provider."""
    table = PriceTable()
    table._loaded = False
    table._bundled.clear()
    table._override.clear()

    cost, source = table.calculate_cost("ollama", "llama3", 1000, 500)
    assert cost == 0.0
    assert source == "bundled"


def test_price_calculation_unknown():
    """Test cost calculation for unknown model."""
    table = PriceTable()
    table._loaded = False
    table._bundled.clear()
    table._override.clear()

    cost, source = table.calculate_cost("unknown", "model", 1000, 500)
    assert cost is None
    assert source == "unknown"


def test_override_persistence(tmp_path: Path):
    """Test that user overrides work in memory."""
    import os
    # Ensure clean state by removing override file
    override_path = config_dir_path() / "pricing.override.toml"
    if override_path.exists():
        override_path.unlink()

    table = PriceTable()
    table._loaded = False
    table._bundled.clear()
    table._override.clear()

    # Set override
    table.set_override("test_provider", "test_model", 1.0, 2.0)
    price = table.get_price("test_provider", "test_model")
    assert price is not None
    assert price.input_per_million == 1.0
    assert price.output_per_million == 2.0
    assert price.source == "override"

    # Remove override - should fall back to bundled (which has no entry for test_provider, so None)
    removed = table.remove_override("test_provider", "test_model")
    assert removed is True
    price = table.get_price("test_provider", "test_model")
    assert price is None  # No bundled entry exists

    # Test with bundled wildcard
    table._bundled["test_provider"] = {"*": ModelPrice(5.0, 10.0, "bundled")}
    table._override.clear()
    table._loaded = False  # Force reload to pick up the new bundled entry

    price = table.get_price("test_provider", "any_model")
    assert price is not None
    assert price.input_per_million == 5.0
    assert price.source == "bundled"

    # Set override on top of bundled wildcard
    table.set_override("test_provider", "specific_model", 1.0, 2.0)
    price = table.get_price("test_provider", "specific_model")
    assert price.input_per_million == 1.0
    assert price.source == "override"

    # Remove override - should fall back to bundled wildcard
    removed = table.remove_override("test_provider", "specific_model")
    assert removed is True
    price = table.get_price("test_provider", "specific_model")
    assert price is not None  # Falls back to bundled wildcard
    assert price.input_per_million == 5.0
    assert price.source == "bundled"

    # Remove non-existent
    removed = table.remove_override("test_provider", "test_model")
    assert removed is False
    
    # Cleanup
    if override_path.exists():
        override_path.unlink()


def test_bundled_table_is_package_data():
    """Guard the wheel-packaging bug: pricing.toml must live inside the package."""
    from importlib import resources

    asset = resources.files("luicode.application.usage").joinpath("data/pricing.toml")
    with resources.as_file(asset) as path:
        assert path.exists(), "pricing.toml must ship inside the package"
    # Verify the table actually loads through the package
    from luicode.application.usage.pricing import PRICE_TABLE
    assert PRICE_TABLE.get_price("anthropic", "claude-3-5-sonnet-20241022") is not None


def test_wildcard_pricing():
    """Test wildcard (*) pricing for provider."""
    table = PriceTable()
    table._loaded = False
    table._bundled.clear()
    table._override.clear()

    # Add wildcard
    table.set_override("test_provider", "*", 5.0, 10.0)

    price = table.get_price("test_provider", "any_model")
    assert price is not None
    assert price.input_per_million == 5.0
    assert price.output_per_million == 10.0
    assert price.source == "override"
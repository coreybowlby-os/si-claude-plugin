"""Opt-in live smoke tests against the real provider SDKs.

The unit tests swap in fake clients, so they cannot notice when a new
openai / anthropic major version changes request parameters or response
fields. These tests make one real plain-text call and one real tool call per
provider and check the fields each provider maps into LLMOutput.

They never run in CI: they are marked ``integration`` (CI runs
``-m "not integration"``) and each provider skips unless its API key is set.

Run locally:

    ANTHROPIC_API_KEY=... OPENAI_API_KEY=... \
        python -m pytest -m integration tests/test_live_sdk_smoke.py -v

Each call is capped at a few dozen output tokens, so a full run costs well
under a cent per provider.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass

import pytest

from llm.core.interface import LLMProvider
from llm.core.types import LLMInput, Message, Role, ToolDefinition
from llm.providers.astraflow import AstraflowCNProvider, AstraflowProvider
from llm.providers.atlas import AtlasProvider
from llm.providers.claude import ClaudeProvider
from llm.providers.openai import OpenAIProvider

pytestmark = pytest.mark.integration

MAX_TOKENS = 64


@dataclass(frozen=True)
class LiveProvider:
    name: str
    key_envs: tuple[str, ...]
    factory: Callable[[], LLMProvider]
    model: str | None
    # Field names each SDK reports token usage under, as mapped by the provider.
    usage_keys: tuple[str, ...]


OPENAI_USAGE = ("prompt_tokens", "completion_tokens", "total_tokens")

PROVIDERS = [
    LiveProvider("claude", ("ANTHROPIC_API_KEY",), ClaudeProvider, "claude-haiku-4-5",
                 ("input_tokens", "output_tokens")),
    LiveProvider("openai", ("OPENAI_API_KEY",), OpenAIProvider, "gpt-4o-mini", OPENAI_USAGE),
    LiveProvider("atlas", ("ATLAS_API_KEY", "ATLASCLOUD_API_KEY"), AtlasProvider, None, OPENAI_USAGE),
    LiveProvider("astraflow", ("ASTRAFLOW_API_KEY",), AstraflowProvider, None, OPENAI_USAGE),
    LiveProvider("astraflow-cn", ("ASTRAFLOW_CN_API_KEY",), AstraflowCNProvider, None, OPENAI_USAGE),
]

WEATHER_TOOL = ToolDefinition(
    name="get_weather",
    description="Get the current weather for a city.",
    parameters={
        "type": "object",
        "properties": {"city": {"type": "string", "description": "City name"}},
        "required": ["city"],
        "additionalProperties": False,
    },
)


def _live(provider: LiveProvider) -> LLMProvider:
    if not any(os.environ.get(env) for env in provider.key_envs):
        pytest.skip(f"set {' or '.join(provider.key_envs)} to run the live {provider.name} smoke test")
    return provider.factory()


def _assert_usage(provider: LiveProvider, usage: dict[str, int] | None) -> None:
    assert usage is not None, f"{provider.name}: usage missing from the SDK response"
    for key in provider.usage_keys:
        assert isinstance(usage.get(key), int), f"{provider.name}: usage[{key!r}] = {usage.get(key)!r}"
        assert usage[key] > 0, f"{provider.name}: usage[{key!r}] should be positive"


@pytest.mark.parametrize("provider", PROVIDERS, ids=lambda p: p.name)
def test_plain_reply_maps_content_usage_and_stop_reason(provider: LiveProvider) -> None:
    client = _live(provider)

    output = client.generate(
        LLMInput(
            messages=[Message(role=Role.USER, content="Reply with exactly the word: pong")],
            model=provider.model,
            max_tokens=MAX_TOKENS,
        )
    )

    assert "pong" in output.content.lower(), f"{provider.name}: unexpected content {output.content!r}"
    assert not output.tool_calls
    assert output.model, f"{provider.name}: model missing from the SDK response"
    assert output.stop_reason, f"{provider.name}: stop_reason missing from the SDK response"
    _assert_usage(provider, output.usage)


@pytest.mark.parametrize("provider", PROVIDERS, ids=lambda p: p.name)
def test_tool_call_maps_name_and_parsed_arguments(provider: LiveProvider) -> None:
    client = _live(provider)

    output = client.generate(
        LLMInput(
            messages=[
                Message(
                    role=Role.USER,
                    content="What is the weather in Paris? Use the get_weather tool; do not answer directly.",
                )
            ],
            model=provider.model,
            max_tokens=MAX_TOKENS,
            tools=[WEATHER_TOOL],
        )
    )

    assert output.tool_calls, f"{provider.name}: expected a tool call, got content {output.content!r}"
    call = output.tool_calls[0]
    assert call.name == "get_weather"
    assert call.id, f"{provider.name}: tool call id missing"
    assert isinstance(call.arguments, dict), f"{provider.name}: arguments not parsed to a dict: {call.arguments!r}"
    assert "paris" in str(call.arguments.get("city", "")).lower()
    assert output.stop_reason, f"{provider.name}: stop_reason missing from the SDK response"

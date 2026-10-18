"""Keep fake SDK clients honest about the real SDK's call signature.

The provider unit tests replace the SDK client with fakes whose ``create``
accepts ``**params``. On their own those fakes accept anything, which is how
anthropic 1.x removing ``temperature`` from ``Messages.create`` reached main
with every unit test still green. Each fake routes its params through
``assert_sdk_accepts`` so the installed SDK's signature is checked on every
test run, with no API key needed.
"""

from __future__ import annotations

import inspect
from collections.abc import Callable, Mapping
from typing import Any

from anthropic.resources.messages import Messages
from openai.resources.chat.completions import Completions

ANTHROPIC_MESSAGES_CREATE = Messages.create
OPENAI_CHAT_COMPLETIONS_CREATE = Completions.create


def accepted_params(method: Callable[..., Any]) -> frozenset[str]:
    """Keyword names ``method`` accepts, excluding ``self``."""
    return frozenset(name for name in inspect.signature(method).parameters if name != "self")


def assert_sdk_accepts(method: Callable[..., Any], params: Mapping[str, Any]) -> None:
    """Fail with the offending names if ``params`` would be rejected by ``method``."""
    unknown = sorted(set(params) - accepted_params(method))
    assert not unknown, (
        f"{method.__qualname__}() in the installed SDK does not accept {unknown}; "
        "the real client would raise TypeError on this call"
    )

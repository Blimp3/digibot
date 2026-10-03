"""One absolute deadline shared by all work in a Container request."""

from __future__ import annotations

import asyncio
import inspect
import math
import time
from collections.abc import Awaitable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import TypeVar


class JobDeadlineExceeded(TimeoutError):
    """The request-wide deadline expired before an operation completed."""


_T = TypeVar("_T")
_CURRENT_DEADLINE: ContextVar[JobDeadline | None] = ContextVar("current_job_deadline", default=None)


@dataclass(slots=True)
class JobDeadline:
    """Monotonic request deadline with bounded stage and sleep helpers."""

    expires_at: float
    absolute_expires_at: float

    @classmethod
    def start(cls, timeout_seconds: float) -> JobDeadline:
        if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
            raise ValueError("job timeout must be positive")
        return cls(time.monotonic() + timeout_seconds, time.time() + timeout_seconds)

    @classmethod
    def from_absolute(cls, deadline_at: float, *, maximum_seconds: float) -> JobDeadline:
        """Use a persisted wall-clock expiry, capped by this process's policy."""

        if not math.isfinite(deadline_at) or not math.isfinite(maximum_seconds) or maximum_seconds <= 0:
            raise ValueError("invalid job deadline")
        now = time.time()
        remaining = min(deadline_at - now, maximum_seconds)
        # Keep an expired deadline representable so the caller can enter its
        # normal cleanup/error path without ever starting another operation.
        return cls(time.monotonic() + max(0.0, remaining), deadline_at)

    @property
    def deadline_at(self) -> float:
        return self.absolute_expires_at

    def remaining(self) -> float:
        return max(0.0, self.expires_at - time.monotonic())

    def ensure_remaining(self) -> None:
        if self.remaining() <= 0:
            raise JobDeadlineExceeded

    def budget(self, configured_seconds: float | None = None, *, reserve_seconds: float = 0.0) -> float:
        """Return a stage cap while reserving time for required teardown."""

        available = self.remaining() - max(0.0, reserve_seconds)
        if available <= 0:
            raise JobDeadlineExceeded
        if configured_seconds is None:
            return available
        if configured_seconds <= 0:
            raise ValueError("stage timeout must be positive")
        return min(configured_seconds, available)

    async def run(self, awaitable: Awaitable[_T], *, timeout_seconds: float | None = None) -> _T:
        """Await an operation until its stage cap or this deadline."""

        remaining = self.remaining()
        if remaining <= 0:
            if inspect.iscoroutine(awaitable):
                awaitable.close()
            raise JobDeadlineExceeded
        limit = remaining if timeout_seconds is None else min(timeout_seconds, remaining)
        if limit <= 0:
            if inspect.iscoroutine(awaitable):
                awaitable.close()
            raise JobDeadlineExceeded
        try:
            async with asyncio.timeout(limit):
                return await awaitable
        except TimeoutError as exc:
            if self.remaining() <= 0:
                raise JobDeadlineExceeded from exc
            raise

    async def sleep(self, seconds: float) -> None:
        if seconds <= 0:
            return
        await self.run(asyncio.sleep(seconds), timeout_seconds=seconds)


def current_deadline() -> JobDeadline | None:
    return _CURRENT_DEADLINE.get()


@contextmanager
def activate_deadline(deadline: JobDeadline) -> Iterator[None]:
    token = _CURRENT_DEADLINE.set(deadline)
    try:
        yield
    finally:
        _CURRENT_DEADLINE.reset(token)

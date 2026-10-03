"""Structured JSON logging with source and secret redaction."""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Mapping
from enum import StrEnum
from typing import Any

from .errors import ErrorCode, ErrorStage, FailureReason

LOGGER = logging.getLogger("downloader_container")


class ProcessName(StrEnum):
    """Child processes whose bounded metadata may appear in logs."""

    YT_DLP = "yt-dlp"
    FFMPEG = "ffmpeg"
    FFPROBE = "ffprobe"


_SAFE_EXTRA_KEYS = frozenset({"ready", "delivery", "fallback"})


def configure_logging() -> None:
    if not LOGGER.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(message)s"))
        LOGGER.addHandler(handler)
    LOGGER.setLevel(logging.INFO)
    LOGGER.propagate = False


def log_event(
    event: str,
    *,
    job_id: str | None = None,
    source_host: str | None = None,
    state: str | None = None,
    operation_ms: int | None = None,
    output_size: int | None = None,
    error_code: str | None = None,
    retry_count: int | None = None,
    error_stage: ErrorStage | str | None = None,
    failure_reason: FailureReason | str | None = None,
    process_name: ProcessName | str | None = None,
    process_exit_code: int | None = None,
    process_timed_out: bool | None = None,
    **extra: Any,
) -> None:
    """Emit only allowlisted operational fields.

    The function intentionally has no ``url`` or arbitrary exception argument;
    callers must choose a safe detail before adding an extra field. Unknown
    keywords such as a source URL fall into ``extra`` and are dropped, so logs
    contain neither the raw URL nor a correlatable unkeyed fingerprint.
    """

    payload: dict[str, Any] = {
        "event": event,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    for key, value in (
        ("job_id", job_id),
        ("source_host", source_host),
        ("state", state),
        ("operation_ms", operation_ms),
        ("output_size", output_size),
        ("error_code", _enum_value(error_code, ErrorCode)),
        ("retry_count", retry_count),
        ("error_stage", _enum_value(error_stage, ErrorStage)),
        ("failure_reason", _enum_value(failure_reason, FailureReason)),
        ("process_name", _enum_value(process_name, ProcessName)),
        ("process_exit_code", _safe_int(process_exit_code)),
        ("process_timed_out", process_timed_out if isinstance(process_timed_out, bool) else None),
    ):
        if value is not None:
            payload[key] = value
    if extra:
        payload.update(_safe_extra(extra))
    if _is_failure_event(event, payload):
        payload.setdefault("error_stage", ErrorStage.INTERNAL.value)
        payload.setdefault("failure_reason", FailureReason.INTERNAL.value)
    LOGGER.info(json.dumps(payload, separators=(",", ":"), sort_keys=True))


def _safe_extra(values: Mapping[str, Any]) -> dict[str, Any]:
    """Keep only explicitly safe, low-cardinality operational fields.

    A denylist is not sufficient for logs: arbitrary text can contain a URL,
    filename, title, token, or exception even when the key looks harmless.
    The extra-field surface is therefore intentionally tiny.  Sensitive data
    is represented only by the explicit source-host field above.
    """

    safe: dict[str, Any] = {}
    for key, value in values.items():
        if key not in _SAFE_EXTRA_KEYS:
            continue
        if isinstance(value, bool) or (isinstance(value, str) and len(value) <= 48):
            safe[key] = value
    return safe


def _enum_value(value: Any, enum_type: type[StrEnum]) -> str | None:
    if isinstance(value, enum_type):
        return value.value
    if isinstance(value, str):
        try:
            return enum_type(value).value
        except ValueError:
            return None
    return None


def _safe_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return int(value)


def _is_failure_event(event: str, payload: Mapping[str, Any]) -> bool:
    return event.endswith("_failed") or event.endswith("_failure") or payload.get("state") == "failed" or (
        event == "dependency_check" and payload.get("ready") is False
    )


class OperationTimer:
    """Small context manager for consistent duration logging."""

    def __init__(self, event: str, **fields: Any) -> None:
        self.event = event
        self.fields = fields
        self.started = 0.0

    def __enter__(self) -> OperationTimer:
        self.started = time.monotonic()
        return self

    def finish(self, **fields: Any) -> None:
        merged = {**self.fields, **fields, "operation_ms": int((time.monotonic() - self.started) * 1000)}
        log_event(self.event, **merged)

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        if exc is not None:
            self.finish(
                error_code=ErrorCode.INTERNAL_ERROR,
                error_stage=ErrorStage.INTERNAL,
                failure_reason=FailureReason.INTERNAL,
            )

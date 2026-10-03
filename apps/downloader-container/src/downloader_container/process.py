"""Safe subprocess execution with process-group timeout cleanup."""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .deadline import JobDeadline, JobDeadlineExceeded, current_deadline

DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024
DEFAULT_MAX_STDERR_BYTES = 2 * 1024 * 1024
DEFAULT_RESOURCE_CHECK_INTERVAL_SECONDS = 0.1


@dataclass(slots=True)
class ProcessResult:
    args: tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str
    timed_out: bool = False
    output_limited: bool = False


class ProcessExecutionError(RuntimeError):
    def __init__(self, result: ProcessResult) -> None:
        self.result = result
        super().__init__("child process failed")


def _validate_args(args: tuple[str, ...]) -> None:
    if not args or any("\x00" in item for item in args):
        raise ValueError("invalid child process arguments")


class _OutputLimitExceeded(RuntimeError):
    pass


async def _read_bounded(stream: asyncio.StreamReader | None, max_bytes: int) -> bytes:
    if stream is None:
        return b""
    captured = bytearray()
    while True:
        chunk = await stream.read(64 * 1024)
        if not chunk:
            return bytes(captured)
        if len(captured) + len(chunk) > max_bytes:
            raise _OutputLimitExceeded
        captured.extend(chunk)


async def _monitor_resource(
    process: asyncio.subprocess.Process,
    resource_check: Callable[[], object],
    interval_seconds: float,
) -> None:
    while process.returncode is None:
        await asyncio.sleep(max(0.01, interval_seconds))
        resource_check()


def _process_group_exists(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


async def _wait_for_process_group_exit(
    pgid: int,
    timeout_seconds: float,
    deadline: JobDeadline | None,
) -> None:
    end = time.monotonic() + max(0.0, timeout_seconds)
    while _process_group_exists(pgid):
        remaining = end - time.monotonic()
        if deadline is not None:
            remaining = min(remaining, deadline.remaining())
        if remaining <= 0:
            return
        try:
            await asyncio.sleep(min(0.05, remaining))
        except asyncio.CancelledError:
            return


async def terminate_process_group(
    process: asyncio.subprocess.Process,
    grace_seconds: float = 10.0,
    *,
    deadline: JobDeadline | None = None,
) -> None:
    """Terminate the complete process group, including children after leader exit."""

    pgid = process.pid
    group_exists = _process_group_exists(pgid)
    if group_exists:
        try:
            os.killpg(pgid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            group_exists = False
    if not group_exists:
        with contextlib.suppress(ProcessLookupError):
            process.terminate()

    grace = max(0.0, grace_seconds)
    if deadline is not None:
        grace = min(grace, deadline.remaining())
    if group_exists:
        await _wait_for_process_group_exit(pgid, grace, deadline)
    elif process.returncode is None and grace > 0:
        try:
            if deadline is None:
                await asyncio.wait_for(process.wait(), timeout=grace)
            else:
                await deadline.run(process.wait(), timeout_seconds=grace)
        except (TimeoutError, ProcessLookupError, asyncio.CancelledError):
            pass

    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        with contextlib.suppress(ProcessLookupError):
            process.kill()
    try:
        if deadline is None:
            await process.wait()
        elif deadline.remaining() > 0:
            await deadline.run(process.wait())
    except (JobDeadlineExceeded, ProcessLookupError, asyncio.CancelledError):
        return


async def run_process(
    args: list[str] | tuple[str, ...],
    *,
    cwd: str | Path | None = None,
    timeout_seconds: float,
    term_grace_seconds: float = 10.0,
    env: dict[str, str] | None = None,
    max_stdout_bytes: int = DEFAULT_MAX_STDOUT_BYTES,
    max_stderr_bytes: int = DEFAULT_MAX_STDERR_BYTES,
    resource_check: Callable[[], object] | None = None,
    resource_check_interval_seconds: float = DEFAULT_RESOURCE_CHECK_INTERVAL_SECONDS,
) -> ProcessResult:
    """Run an executable using an argv array and a dedicated process group."""

    normalized = tuple(str(item) for item in args)
    _validate_args(normalized)
    deadline = current_deadline()
    effective_timeout = timeout_seconds
    if deadline is not None:
        try:
            effective_timeout = deadline.budget(timeout_seconds, reserve_seconds=max(0.0, term_grace_seconds))
        except JobDeadlineExceeded:
            raise ProcessExecutionError(ProcessResult(normalized, -signal.SIGTERM, "", "", True)) from None
    process = await asyncio.create_subprocess_exec(
        *normalized,
        cwd=os.fspath(cwd) if cwd is not None else None,
        env=env,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    stdout_task = asyncio.create_task(_read_bounded(process.stdout, max_stdout_bytes))
    stderr_task = asyncio.create_task(_read_bounded(process.stderr, max_stderr_bytes))
    wait_task = asyncio.create_task(process.wait())
    resource_task = (
        asyncio.create_task(_monitor_resource(process, resource_check, resource_check_interval_seconds))
        if resource_check is not None
        else None
    )
    active_tasks: list[asyncio.Task[Any]] = [stdout_task, stderr_task, wait_task]
    if resource_task is not None:
        active_tasks.append(resource_task)

    async def collect() -> tuple[bytes, bytes]:
        gathered: list[Any] = [stdout_task, stderr_task, wait_task]
        if resource_task is not None:
            gathered.append(resource_task)
        stdout_raw, stderr_raw, *_remaining = await asyncio.gather(*gathered)
        return stdout_raw, stderr_raw

    communication = asyncio.create_task(collect())
    try:
        if deadline is None:
            stdout_raw, stderr_raw = await asyncio.wait_for(asyncio.shield(communication), timeout=effective_timeout)
        else:
            stdout_raw, stderr_raw = await deadline.run(
                asyncio.shield(communication),
                timeout_seconds=effective_timeout,
            )
    except (Exception, asyncio.CancelledError) as exc:
        # Every early exit stops the whole process group before it propagates.
        await terminate_process_group(process, term_grace_seconds, deadline=deadline)
        for task in active_tasks:
            task.cancel()
        communication.cancel()
        await asyncio.gather(*active_tasks, communication, return_exceptions=True)
        if isinstance(exc, TimeoutError):
            result = ProcessResult(normalized, process.returncode or -signal.SIGTERM, "", "", True)
            raise ProcessExecutionError(result) from None
        if isinstance(exc, _OutputLimitExceeded):
            result = ProcessResult(normalized, process.returncode or -signal.SIGTERM, "", "", output_limited=True)
            raise ProcessExecutionError(result) from None
        raise
    finally:
        if resource_task is not None:
            resource_task.cancel()
            await asyncio.gather(resource_task, return_exceptions=True)
    result = ProcessResult(
        normalized,
        process.returncode or 0,
        stdout_raw.decode(errors="replace"),
        stderr_raw.decode(errors="replace"),
    )
    if result.returncode != 0:
        raise ProcessExecutionError(result)
    return result

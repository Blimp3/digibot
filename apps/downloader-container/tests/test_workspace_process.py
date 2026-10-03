from __future__ import annotations

import asyncio
import os
import sys
import time

import pytest

from downloader_container.errors import DownloadError, ErrorCode
from downloader_container.process import ProcessExecutionError, run_process
from downloader_container.workspace import JobWorkspace


def test_workspace_is_removed_and_rejects_nested_child(tmp_path):
    with JobWorkspace(tmp_path, "job-1", max_bytes=100) as workspace:
        workspace.child("media.mp4").write_bytes(b"x")
        with pytest.raises(DownloadError):
            workspace.child("nested/media.mp4")
        path = workspace.path
        assert path.exists()
    assert not path.exists()


def test_workspace_child_supports_symlinked_root(tmp_path):
    real_root = tmp_path / "real"
    real_root.mkdir()
    root_alias = tmp_path / "alias"
    root_alias.symlink_to(real_root, target_is_directory=True)

    with JobWorkspace(root_alias, "job-1", max_bytes=100) as workspace:
        child = workspace.child("media.mp4")
        child.write_bytes(b"x")
        assert child.parent == workspace.path.resolve()

    assert not (real_root / "job-1").exists()


def test_stale_cleanup_removes_only_old_job_directories(tmp_path):
    root = tmp_path / "jobs"
    root.mkdir()
    old = root / "old-job"
    old.mkdir()
    (old / "media.mp4").write_bytes(b"old")
    old_time = time.time() - 86_401
    os.utime(old, (old_time, old_time))
    recent = root / "recent-job"
    recent.mkdir()
    (recent / "media.mp4").write_bytes(b"recent")
    outside = tmp_path / "outside"
    outside.mkdir()
    linked = root / "linked-job"
    linked.symlink_to(outside, target_is_directory=True)

    assert JobWorkspace.cleanup_stale(root) == 1
    assert not old.exists()
    assert recent.is_dir()
    assert linked.is_symlink()
    assert outside.is_dir()


@pytest.mark.asyncio
async def test_process_uses_argv_and_returns_output():
    result = await run_process(["/usr/bin/printf", "%s", "safe"], timeout_seconds=5)
    assert result.stdout == "safe"
    assert result.args == ("/usr/bin/printf", "%s", "safe")


@pytest.mark.asyncio
async def test_process_timeout_is_reported_and_cleaned():
    with pytest.raises(ProcessExecutionError) as caught:
        await run_process(["/bin/sleep", "30"], timeout_seconds=0.05, term_grace_seconds=0.05)
    assert caught.value.result.timed_out


@pytest.mark.asyncio
async def test_process_output_limit_terminates_child():
    with pytest.raises(ProcessExecutionError) as caught:
        await run_process(
            ["/usr/bin/printf", "%s", "x" * 128],
            timeout_seconds=5,
            max_stdout_bytes=32,
        )
    assert caught.value.result.output_limited


@pytest.mark.asyncio
async def test_resource_monitor_terminates_child_before_completion():
    checks = 0

    def enforce_budget() -> None:
        nonlocal checks
        checks += 1
        if checks >= 2:
            raise DownloadError(ErrorCode.SOURCE_SIZE_LIMIT)

    with pytest.raises(DownloadError) as caught:
        await run_process(
            ["/bin/sleep", "30"],
            timeout_seconds=5,
            term_grace_seconds=0.05,
            resource_check=enforce_budget,
            resource_check_interval_seconds=0.01,
        )
    assert caught.value.code == ErrorCode.SOURCE_SIZE_LIMIT


@pytest.mark.asyncio
async def test_cancellation_kills_descendant_after_leader_exits(tmp_path):
    pid_file = tmp_path / "child.pid"
    child_code = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"
    parent_code = (
        "import pathlib,subprocess,sys\n"
        f"child=subprocess.Popen([sys.executable,'-c',{child_code!r}])\n"
        f"pathlib.Path({str(pid_file)!r}).write_text(str(child.pid))\n"
    )
    task = asyncio.create_task(
        run_process(
            [sys.executable, "-c", parent_code],
            timeout_seconds=30,
            term_grace_seconds=0.1,
        )
    )
    for _ in range(100):
        if pid_file.exists():
            break
        await asyncio.sleep(0.01)
    assert pid_file.exists()
    child_pid = int(pid_file.read_text())
    await asyncio.sleep(0.05)

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    end = time.monotonic() + 2
    while time.monotonic() < end:
        try:
            os.kill(child_pid, 0)
        except ProcessLookupError:
            break
        await asyncio.sleep(0.02)
    else:
        pytest.fail("descendant process survived cancellation")

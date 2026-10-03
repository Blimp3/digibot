from __future__ import annotations

import asyncio
import threading
from pathlib import Path

import pytest

from downloader_container.models import JobRunRequest, MediaMetadata, ProbeInfo
from downloader_container.process import ProcessResult
from downloader_container.r2 import R2Uploader
from downloader_container.service import DownloaderService


def _configure_r2(settings) -> None:
    settings.r2_endpoint = "https://r2.example"
    settings.r2_bucket = "bucket"
    settings.r2_access_key_id = "access-key"
    settings.r2_secret_access_key = "secret-key"
    settings.r2_public_base_url = "https://download.example"
    settings.download_link_hmac_secret = "download-secret"


@pytest.mark.asyncio
async def test_r2_upload_drains_blocking_thread_on_repeated_cancellation(settings, tmp_path):
    _configure_r2(settings)
    started = threading.Event()
    release = threading.Event()
    finished = threading.Event()

    class BlockingClient:
        def upload_fileobj(self, *_args, **_kwargs):
            started.set()
            try:
                release.wait(timeout=5)
            finally:
                finished.set()
            raise RuntimeError("late SDK failure")

    uploader = R2Uploader(settings, client_factory=lambda *_args, **_kwargs: BlockingClient())
    media = tmp_path / "media.mp4"
    media.write_bytes(b"media")
    task = asyncio.create_task(
        uploader.upload(
            job_id="job-r2-cancel",
            path=media,
            filename=media.name,
            mime_type="video/mp4",
        )
    )

    try:
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        await asyncio.sleep(0.05)
        assert not task.done()
        task.cancel()
        await asyncio.sleep(0.05)
        assert not task.done()
        assert not finished.is_set()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert finished.is_set()
    finally:
        release.set()
        if not task.done():
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task


@pytest.mark.asyncio
async def test_service_keeps_claim_and_workspace_until_r2_thread_finishes(
    settings,
    ready_diagnostics,
    monkeypatch,
):
    _configure_r2(settings)
    settings.job_timeout_seconds = 0.05
    settings.telegram_upload_limit_bytes = 1
    upload_started = threading.Event()
    release_upload = threading.Event()
    upload_finished = threading.Event()
    lock = threading.Lock()
    active = 0
    max_active = 0
    uploads: list[str] = []
    client_options: list[dict[str, object]] = []

    class BlockingClient:
        def upload_fileobj(self, _handle, _bucket, object_key, **_kwargs):
            nonlocal active, max_active
            with lock:
                active += 1
                max_active = max(max_active, active)
                uploads.append(object_key)
            upload_started.set()
            try:
                release_upload.wait(timeout=5)
            finally:
                with lock:
                    active -= 1
                upload_finished.set()

    def client_factory(*_args, **kwargs):
        client_options.append(kwargs)
        return BlockingClient()

    async def fake_probe(*_args, **_kwargs):
        return ProbeInfo(
            id="image-id",
            title="Image",
            extractor="example",
            formats=[
                {
                    "format_id": "image",
                    "ext": "jpg",
                    "width": 100,
                    "height": 100,
                    "vcodec": "mjpeg",
                    "acodec": "none",
                    "filesize": 10,
                }
            ],
        )

    async def fake_run(args, *, cwd, **_kwargs):
        output = Path(cwd) / "photo.jpg"
        output.write_bytes(b"image")
        return ProcessResult(tuple(args), 0, str(output), "")

    async def fake_verify(path, **_kwargs):
        return MediaMetadata(filename=Path(path).name, mimeType="image/jpeg", sizeBytes=5, hasVideo=False)

    async def no_direct(*_args, **_kwargs):
        return None

    monkeypatch.setattr("downloader_container.service.resolve_direct_media", no_direct)
    monkeypatch.setattr("downloader_container.service.probe_media", fake_probe)
    monkeypatch.setattr("downloader_container.service.run_process", fake_run)
    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    uploader = R2Uploader(settings, client_factory=client_factory)
    service = DownloaderService(
        settings,
        r2=uploader,
        dependency_provider=lambda _settings: ready_diagnostics,
    )

    def request(job_id: str) -> JobRunRequest:
        return JobRunRequest(
            jobId=job_id,
            sourceUrl="https://example.com/image",
            telegramChatId="123",
            waitingMessageId=7,
            mode="video",
        )

    first = asyncio.create_task(service.run(request("job-r2-first")))
    try:
        assert await asyncio.to_thread(upload_started.wait, 2)
        config = client_options[0]["config"]
        assert config.connect_timeout <= settings.job_timeout_seconds
        assert config.read_timeout <= settings.job_timeout_seconds
        assert config.retries["total_max_attempts"] == 1
        await asyncio.sleep(0.1)
        assert not first.done()
        first_dir = Path(settings.jobs_root) / "job-r2-first"
        assert first_dir.is_dir()

        # The first deadline has expired, but its synchronous R2 call still
        # owns the service's active-job claim until the thread is drained.
        settings.job_timeout_seconds = 2
        second = asyncio.create_task(service.run(request("job-r2-second")))
        try:
            await asyncio.sleep(0.1)
            assert not second.done()
            assert uploads == ["jobs/job-r2-first/photo.jpg"]
            assert max_active == 1

            release_upload.set()
            first_result = await first
            assert first_result["status"] == "failed"
            assert first_result["errorCode"] == "DOWNLOAD_TIMEOUT"
            assert first_result["retryable"] is True
            assert not first_dir.exists()
            assert upload_finished.is_set()

            second_result = await second
            assert second_result["status"] == "prepared"
            assert uploads == ["jobs/job-r2-first/photo.jpg", "jobs/job-r2-second/photo.jpg"]
            assert max_active == 1
        finally:
            release_upload.set()
            if not second.done():
                await second
    finally:
        release_upload.set()
        if not first.done():
            await first

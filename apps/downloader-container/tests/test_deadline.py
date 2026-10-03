from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from downloader_container import deadline as deadline_module
from downloader_container.deadline import JobDeadline, JobDeadlineExceeded, activate_deadline
from downloader_container.models import JobDeliveryRequest, JobRunRequest, MediaMetadata, ProbeInfo
from downloader_container.process import ProcessResult
from downloader_container.service import DownloaderService
from downloader_container.telegram import TelegramClient, TelegramMessage


@pytest.mark.asyncio
async def test_job_deadline_caps_an_awaited_stage() -> None:
    deadline = JobDeadline.start(0.02)
    with activate_deadline(deadline), pytest.raises(JobDeadlineExceeded):
        await deadline.run(asyncio.sleep(1))


def test_absolute_deadline_retains_original_expiry_when_local_cap_is_shorter() -> None:
    absolute_expiry = time.time() + 60
    deadline = JobDeadline.from_absolute(absolute_expiry, maximum_seconds=1)
    assert deadline.deadline_at == absolute_expiry
    assert 0 < deadline.remaining() <= 1


@pytest.mark.asyncio
async def test_prepare_returns_timeout_when_probe_outlives_job_deadline(settings, ready_diagnostics, monkeypatch):
    settings.job_timeout_seconds = 1

    async def slow_probe(*_args, **_kwargs):
        await asyncio.sleep(2)

    monkeypatch.setattr("downloader_container.service.probe_media", slow_probe)
    service = DownloaderService(
        settings,
        dependency_provider=lambda _settings: ready_diagnostics,
    )

    result = await service.run(
        JobRunRequest(
            jobId="job-deadline-prepare",
            sourceUrl="https://example.com/media",
            telegramChatId="123",
            waitingMessageId=7,
            mode="audio",
        )
    )

    assert result == {
        "status": "failed",
        "errorCode": "DOWNLOAD_TIMEOUT",
        "safeMessage": "The source took too long to download.",
        "retryable": True,
    }


@pytest.mark.asyncio
async def test_delivery_returns_timeout_without_replaying_when_upload_outlives_deadline(
    settings,
    monkeypatch,
):
    settings.job_timeout_seconds = 1
    job_id = "job-deadline-delivery"
    job_dir = Path(settings.jobs_root) / job_id
    job_dir.mkdir(parents=True)
    output = job_dir / "media.mp4"
    output.write_bytes(b"media")
    metadata = MediaMetadata(
        filename=output.name,
        mimeType="video/mp4",
        sizeBytes=5,
        duration=1,
        height=360,
        hasVideo=True,
        hasAudio=True,
    )
    probe = ProbeInfo(id="source-id", title="media", extractor="youtube", formats=[])
    (job_dir / ".manifest.json").write_text(
        json.dumps({"metadata": metadata.model_dump(by_alias=True), "probe": probe.model_dump()}),
        encoding="utf-8",
    )

    async def fake_verify(*_args, **_kwargs):
        return metadata

    class SlowTelegram:
        sent = 0

        async def send_chat_action(self, **_kwargs):
            return None

        async def send_media(self, **_kwargs):
            self.sent += 1
            await asyncio.sleep(2)
            return TelegramMessage(123)

    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    telegram = SlowTelegram()
    service = DownloaderService(settings, telegram=telegram)

    result = await service.deliver(
        JobDeliveryRequest(
            jobId=job_id,
            telegramChatId="123",
            objectKey=f"staged/{job_id}/{output.name}",
            filename=output.name,
            mimeType=metadata.mime_type,
            sizeBytes=metadata.size_bytes,
            mode="video",
            deliveryMode="telegram",
        )
    )

    assert result["status"] == "failed"
    assert result["errorCode"] == "TELEGRAM_UPLOAD_FAILED"
    assert result["retryable"] is False
    assert result["outcome"] == "ambiguous"
    assert telegram.sent == 1
    assert not job_dir.exists()


@pytest.mark.asyncio
async def test_telegram_response_body_timeout_is_ambiguous(settings, monkeypatch):
    settings.job_timeout_seconds = 1
    job_id = "job-deadline-response"
    job_dir = Path(settings.jobs_root) / job_id
    job_dir.mkdir(parents=True)
    output = job_dir / "media.mp4"
    output.write_bytes(b"media")
    metadata = MediaMetadata(
        filename=output.name,
        mimeType="video/mp4",
        sizeBytes=5,
        duration=1,
        height=360,
        hasVideo=True,
        hasAudio=True,
    )
    probe = ProbeInfo(id="source-id", title="media", extractor="youtube", formats=[])
    (job_dir / ".manifest.json").write_text(
        json.dumps({"metadata": metadata.model_dump(by_alias=True), "probe": probe.model_dump()}),
        encoding="utf-8",
    )

    async def fake_verify(*_args, **_kwargs):
        return metadata

    class SlowResponseBody(httpx.AsyncByteStream):
        async def __aiter__(self):
            await asyncio.sleep(2)
            yield b'{"ok":true,"result":{"message_id":123}}'

    async def response_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=SlowResponseBody(), request=request)

    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(response_handler))
    telegram = TelegramClient("token", client=http_client)
    service = DownloaderService(settings, telegram=telegram)

    try:
        result = await service.deliver(
            JobDeliveryRequest(
                jobId=job_id,
                telegramChatId="123",
                objectKey=f"staged/{job_id}/{output.name}",
                filename=output.name,
                mimeType=metadata.mime_type,
                sizeBytes=metadata.size_bytes,
                mode="video",
                deliveryMode="telegram",
            )
        )
    finally:
        await http_client.aclose()

    assert result["status"] == "failed"
    assert result["errorCode"] == "DOWNLOAD_TIMEOUT"
    assert result["outcome"] == "ambiguous"
    assert not job_dir.exists()


@pytest.mark.asyncio
async def test_delivery_uses_prepare_deadline_in_manifest_instead_of_resetting(settings, monkeypatch):
    settings.job_timeout_seconds = 5
    job_id = "job-cross-phase-deadline"
    requested_deadline = time.time() + 30

    async def fake_probe(*_args, **_kwargs):
        return ProbeInfo(
            id="source-id",
            title="media",
            extractor="youtube",
            formats=[{"format_id": "a", "ext": "m4a", "acodec": "mp4a", "filesize": 5}],
        )

    async def fake_run(args, *, cwd, **_kwargs):
        output = Path(cwd) / "media.m4a"
        output.write_bytes(b"media")
        return ProcessResult(tuple(args), 0, str(output), "")

    async def fake_verify(path, **_kwargs):
        return MediaMetadata(
            filename=Path(path).name,
            mimeType="audio/mp4",
            sizeBytes=5,
            duration=1,
            hasAudio=True,
        )

    class NoSendTelegram:
        sent = 0

        async def send_chat_action(self, **_kwargs):
            return None

        async def send_media(self, **_kwargs):
            self.sent += 1
            return TelegramMessage(123)

    monkeypatch.setattr("downloader_container.service.probe_media", fake_probe)
    monkeypatch.setattr("downloader_container.service.run_process", fake_run)
    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    telegram = NoSendTelegram()
    service = DownloaderService(settings, telegram=telegram, dependency_provider=lambda _settings: {"ready": True})
    monkeypatch.setattr(service, "_runtime", lambda: ("deno", "/usr/bin/deno"))
    prepared = await service.run(
        JobRunRequest(
            jobId=job_id,
            sourceUrl="https://example.com/media",
            telegramChatId="123",
            waitingMessageId=7,
            mode="audio",
            preferredFormat="m4a",
            deadlineAt=requested_deadline,
        )
    )

    assert prepared["status"] == "prepared"
    assert prepared["deadlineAt"] == requested_deadline
    manifest = json.loads((Path(settings.jobs_root) / job_id / ".manifest.json").read_text(encoding="utf-8"))
    assert manifest["deadlineAt"] == requested_deadline
    monkeypatch.setattr(
        deadline_module,
        "time",
        SimpleNamespace(time=lambda: requested_deadline + 1, monotonic=time.monotonic),
    )
    result = await service.deliver(
        JobDeliveryRequest(
            jobId=job_id,
            telegramChatId="123",
            objectKey=prepared["objectKey"],
            filename=prepared["filename"],
            mimeType=prepared["mimeType"],
            sizeBytes=prepared["sizeBytes"],
            mode="audio",
            deliveryMode="telegram",
        )
    )

    assert result["status"] == "failed"
    assert result["errorCode"] == "DOWNLOAD_TIMEOUT"
    assert result["outcome"] == "ambiguous"
    assert telegram.sent == 0


@pytest.mark.asyncio
async def test_cosmetic_chat_action_cannot_consume_delivery_budget(settings, monkeypatch) -> None:
    class HangingTelegram:
        async def send_chat_action(self, **_kwargs):
            await asyncio.sleep(3600)

    monkeypatch.setattr("downloader_container.service.CHAT_ACTION_TIMEOUT_SECONDS", 0.01)
    service = DownloaderService(settings, telegram=HangingTelegram())  # type: ignore[arg-type]
    with activate_deadline(JobDeadline.start(600)):
        await asyncio.wait_for(service._send_action("123", "upload_video"), 1)

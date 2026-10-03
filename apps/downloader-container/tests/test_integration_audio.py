from __future__ import annotations

import hashlib
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
from pydantic import ValidationError

from downloader_container.app import create_app
from downloader_container.errors import DownloadError, ErrorCode
from downloader_container.models import IntegrationAudioRequest, JobRunRequest, MediaMetadata
from downloader_container.service import DownloaderService
from downloader_container.workspace import JobWorkspace


def integration_request(**changes: object) -> IntegrationAudioRequest:
    payload: dict[str, object] = {
        "accountId": "account-1",
        "operationId": "123e4567-e89b-42d3-a456-426614174000",
        "sourceUrl": "https://youtu.be/example",
        "segment": {"startSeconds": 5, "endSeconds": 20},
        "expiresAt": "2099-01-01T00:00:00Z",
    }
    payload.update(changes)
    return IntegrationAudioRequest.model_validate(payload)


@pytest.mark.parametrize(
    "segment",
    [
        {"startSeconds": 5, "endSeconds": 5},
        {"startSeconds": 5, "endSeconds": 66},
        {"startSeconds": 1.5, "endSeconds": 2},
        {"startSeconds": True, "endSeconds": 2},
        {"startSeconds": -1, "endSeconds": 2},
        {"startSeconds": 86400, "endSeconds": 86400},
    ],
)
def test_integration_audio_range_is_strict_and_bounded(segment: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        integration_request(segment=segment)


def test_integration_audio_request_requires_expiry_and_rejects_extra_fields() -> None:
    with pytest.raises(ValidationError):
        integration_request(expiresAt="2099-01-01T00:00:00")
    with pytest.raises(ValidationError):
        integration_request(unexpected="reject")


@pytest.mark.asyncio
async def test_private_route_auth_and_binary_contract(settings, ready_diagnostics) -> None:
    content = b"verified-mp3"
    service = DownloaderService(settings, dependency_provider=lambda _settings: ready_diagnostics)
    service.prepare_integration_audio = AsyncMock(return_value={
        "status": "prepared",
        "mimeType": "audio/mpeg",
        "filename": "clip.mp3",
        "sizeBytes": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        "duration": 4.5,
        "trimEndClamped": True,
        "content": content,
    })
    transport = httpx.ASGITransport(app=create_app(settings, service))
    payload = integration_request().model_dump(by_alias=True)
    headers = {"content-type": "application/json", "authorization": "Bearer test-internal-secret"}
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        unauthorized = await client.post("/v1/integration/audio/prepare", json=payload)
        assert unauthorized.status_code == 401
        response = await client.post("/v1/integration/audio/prepare", json=payload, headers=headers)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/mpeg")
    assert response.content == content
    assert response.headers["x-digibot-media-sha256"] == hashlib.sha256(content).hexdigest()
    assert response.headers["x-digibot-media-byte-length"] == str(len(content))
    assert response.headers["x-digibot-trim-end-clamped"] == "true"
    service.prepare_integration_audio.assert_awaited_once()


@pytest.mark.asyncio
async def test_prepare_integration_audio_has_no_legacy_delivery_or_url_log(settings, monkeypatch) -> None:
    class FakeProxy:
        url = "http://127.0.0.1:1"

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

    service = DownloaderService(settings)
    seen: dict[str, object] = {}

    async def fake_run_active(request, validated, *, proxy_url, processing_only_audio=False):
        seen.update({
            "request": request,
            "validated": validated,
            "proxy_url": proxy_url,
            "processing_only_audio": processing_only_audio,
        })
        return {"status": "prepared", "content": b"mp3", "sizeBytes": 3, "duration": 2.0}

    monkeypatch.setattr("downloader_container.service.PublicEgressProxy", FakeProxy)
    monkeypatch.setattr(service, "_run_active", fake_run_active)
    request = integration_request()
    result = await service.prepare_integration_audio(request)

    assert result["status"] == "prepared"
    assert seen["processing_only_audio"] is True
    prepared = seen["request"]
    assert isinstance(prepared, JobRunRequest)
    assert prepared.mode == "audio" and prepared.preferred_format == "mp3"
    assert prepared.trim_start_seconds == 5 and prepared.trim_end_seconds == 20
    assert prepared.job_id == "integration-" + hashlib.sha256(f"{request.account_id}\0{request.operation_id}".encode()).hexdigest()
    assert prepared.telegram_chat_id == "1" and prepared.waiting_message_id == 1
    assert "source_url" not in str(result)


@pytest.mark.asyncio
async def test_integration_audio_finish_returns_measured_duration_and_rejects_clamping(settings) -> None:
    service = DownloaderService(settings)
    content = b"verified-mp3"
    request = JobRunRequest(
        jobId="integration-audio",
        sourceUrl="https://youtu.be/example",
        telegramChatId="1",
        waitingMessageId=1,
        mode="audio",
        preferredFormat="mp3",
        trimStartSeconds=5,
        trimEndSeconds=20,
    )
    metadata = MediaMetadata(
        filename="clip.mp3",
        mimeType="audio/mpeg",
        sizeBytes=len(content),
        duration=3.25,
        hasAudio=True,
        firstAudioCodec="mp3",
        trimStartSeconds=5,
        trimEndSeconds=8,
        trimEndClamped=False,
    )
    with JobWorkspace(settings.jobs_root, request.job_id, max_bytes=settings.max_temp_disk_bytes) as workspace:
        output = workspace.child("clip.mp3")
        output.write_bytes(content)
        result = await service._finish_integration_audio(request, output, metadata, workspace, title="clip")
        assert result["content"] == content
        assert result["duration"] == pytest.approx(3.25)
        assert result["trimEndClamped"] is False
        with pytest.raises(DownloadError):
            await service._finish_integration_audio(request, output, metadata.model_copy(update={"trim_end_clamped": True}), workspace, title="clip")
        assert result["sha256"] == hashlib.sha256(content).hexdigest()
    assert not Path(settings.jobs_root, request.job_id).exists()


@pytest.mark.asyncio
async def test_integration_audio_rejects_over_limit_output(settings, monkeypatch) -> None:
    service = DownloaderService(settings)
    request = JobRunRequest(
        jobId="integration-audio-large",
        sourceUrl="https://youtu.be/example",
        telegramChatId="1",
        waitingMessageId=1,
        mode="audio",
        preferredFormat="mp3",
        trimStartSeconds=0,
        trimEndSeconds=60,
    )
    content = b"x" * (4 * 1024 * 1024 + 1)
    metadata = MediaMetadata(
        filename="clip.mp3", mimeType="audio/mpeg", sizeBytes=len(content), duration=60,
        hasAudio=True, firstAudioCodec="mp3",
    )
    async def no_shrink(*_args, **_kwargs):
        return _args[1], metadata

    monkeypatch.setattr(service, "_try_transcode", no_shrink)
    with JobWorkspace(settings.jobs_root, request.job_id, max_bytes=settings.max_temp_disk_bytes + len(content)) as workspace:
        output = workspace.child("clip.mp3")
        output.write_bytes(content)
        with pytest.raises(DownloadError) as failure:
            await service._finish_integration_audio(request, output, metadata, workspace, title="clip")
    assert failure.value.code == ErrorCode.SOURCE_SIZE_LIMIT

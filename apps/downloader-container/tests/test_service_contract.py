from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import httpx
import pytest
from pydantic import ValidationError

from downloader_container.deadline import JobDeadline, activate_deadline
from downloader_container.errors import DownloadError, ErrorCode
from downloader_container.models import JobDeliveryRequest, JobRunRequest, MediaMetadata, ProbeInfo
from downloader_container.process import ProcessResult
from downloader_container.security import validate_source_url
from downloader_container.service import DownloaderService
from downloader_container.telegram import TelegramApiError, TelegramMessage
from downloader_container.workspace import JobWorkspace


@pytest.mark.parametrize(
    "message_id",
    [None, "", "-1", "1.5", "not-a-number", 0, -1, 1.5, True, 2**53],
)
def test_confirmed_message_rejects_malformed_message_ids(settings, message_id) -> None:
    service = DownloaderService(settings)

    with pytest.raises(TelegramApiError):
        service._confirmed_message(TelegramMessage(message_id))


def test_delivery_request_accepts_sanitized_bracketed_youtube_filename() -> None:
    request = JobDeliveryRequest(
        jobId="job-youtube",
        telegramChatId="123",
        objectKey="staged/job-youtube/Me at the zoo [jNQXAC9IVRw].mp4",
        filename="Me at the zoo [jNQXAC9IVRw].mp4",
        mimeType="video/mp4",
        mode="video",
    )

    assert request.object_key == "staged/job-youtube/Me at the zoo [jNQXAC9IVRw].mp4"


@pytest.mark.parametrize(
    "object_key",
    [
        "staged/job-youtube/../escape.mp4",
        "staged/job-youtube/nested/video.mp4",
    ],
)
def test_delivery_request_rejects_traversal_and_extra_path_separators(object_key: str) -> None:
    with pytest.raises(ValidationError):
        JobDeliveryRequest(
            jobId="job-youtube",
            telegramChatId="123",
            objectKey=object_key,
            filename="video.mp4",
            mimeType="video/mp4",
            mode="video",
        )


class FakeTelegram:
    def __init__(self) -> None:
        self.sent = 0
        self.document_sent = 0

    async def send_media(self, **_kwargs):
        self.sent += 1
        return TelegramMessage(321)

    async def send_download_link(self, **_kwargs):
        self.sent += 1
        return TelegramMessage(654)

    async def send_document(self, **_kwargs):
        self.sent += 1
        self.document_sent += 1
        return TelegramMessage(987)

    async def send_chat_action(self, **_kwargs):
        return None


class PhotoTelegram(FakeTelegram):
    def __init__(self) -> None:
        super().__init__()
        self.actions: list[str] = []
        self.metadata: list[MediaMetadata] = []

    async def send_chat_action(self, **kwargs):
        self.actions.append(kwargs["action"])

    async def send_media(self, **kwargs):
        self.sent += 1
        self.metadata.append(kwargs["metadata"])
        return TelegramMessage(322)


class TooLargeTelegram(FakeTelegram):
    async def send_media(self, **_kwargs):
        self.sent += 1
        raise DownloadError(ErrorCode.TELEGRAM_FILE_TOO_LARGE)


class BadRequestTelegram(FakeTelegram):
    async def send_media(self, **_kwargs):
        self.sent += 1
        raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED, status_code=400)


class RateLimitedOnceTelegram(FakeTelegram):
    async def send_media(self, **_kwargs):
        self.sent += 1
        if self.sent == 1:
            raise TelegramApiError(ErrorCode.TELEGRAM_RATE_LIMITED, retry_after=1, status_code=429)
        return TelegramMessage(321)


class AmbiguousTelegram(FakeTelegram):
    async def send_media(self, **_kwargs):
        self.sent += 1
        raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED, retryable=True)


class NetworkTelegram(FakeTelegram):
    async def send_media(self, **_kwargs):
        self.sent += 1
        raise httpx.NetworkError("connection lost")


class ServerErrorTelegram(FakeTelegram):
    async def send_media(self, **_kwargs):
        self.sent += 1
        raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED, status_code=503)


class MalformedTelegram(FakeTelegram):
    async def send_media(self, **_kwargs):
        self.sent += 1
        return TelegramMessage(0)


class ExplicitBadRequestTelegram(FakeTelegram):
    async def send_media(self, **_kwargs):
        self.sent += 1
        raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED, status_code=403)


class TimeoutTelegram(FakeTelegram):
    async def send_media(self, **_kwargs):
        self.sent += 1
        raise TimeoutError("response timed out")


class LongRateLimitedTelegram(FakeTelegram):
    async def send_media(self, **_kwargs):
        self.sent += 1
        raise TelegramApiError(ErrorCode.TELEGRAM_RATE_LIMITED, retry_after=86_401, status_code=429)


@pytest.mark.asyncio
async def test_failed_delivery_removes_staged_workspace(settings, ready_diagnostics):
    job_dir = Path(settings.jobs_root) / "job-delivery-failure"
    job_dir.mkdir(parents=True)
    (job_dir / "orphan.mp4").write_bytes(b"media")
    service = DownloaderService(
        settings,
        telegram=FakeTelegram(),
        dependency_provider=lambda _settings: ready_diagnostics,
    )

    result = await service.deliver(
        JobDeliveryRequest(
            jobId="job-delivery-failure",
            telegramChatId="123",
            objectKey="staged/job-delivery-failure/orphan.mp4",
            filename="orphan.mp4",
            mimeType="video/mp4",
            mode="video",
            deliveryMode="telegram",
        )
    )

    assert result["status"] == "failed"
    assert result["errorCode"] == ErrorCode.DOWNLOAD_FAILED.value
    assert result["outcome"] == "rejected"
    assert service.telegram.sent == 0
    assert not job_dir.exists()


@pytest.mark.asyncio
async def test_explicit_telegram_429_retries_without_retrying_ambiguous_errors(
    settings,
    ready_diagnostics,
    monkeypatch,
):
    job_id = "job-rate-limited"
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
    probe = ProbeInfo(id="source-id", title="A title", extractor="youtube", formats=[])
    (job_dir / ".manifest.json").write_text(
        json.dumps({"metadata": metadata.model_dump(by_alias=True), "probe": probe.model_dump()}),
        encoding="utf-8",
    )

    async def fake_verify(*_args, **_kwargs):
        return metadata

    async def no_wait(_seconds):
        return None

    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    monkeypatch.setattr("downloader_container.service.asyncio.sleep", no_wait)
    telegram = RateLimitedOnceTelegram()
    service = DownloaderService(
        settings,
        telegram=telegram,
        dependency_provider=lambda _settings: ready_diagnostics,
    )
    result = await service.deliver(
        JobDeliveryRequest(
            jobId=job_id,
            telegramChatId="123",
            objectKey=f"staged/{job_id}/{output.name}",
            filename=output.name,
            mimeType="video/mp4",
            mode="video",
            deliveryMode="telegram",
        )
    )

    assert result["status"] == "completed"
    assert telegram.sent == 2
    assert not job_dir.exists()

    ambiguous_job_id = "job-ambiguous-upload"
    ambiguous_dir = Path(settings.jobs_root) / ambiguous_job_id
    ambiguous_dir.mkdir(parents=True)
    ambiguous_output = ambiguous_dir / output.name
    ambiguous_output.write_bytes(b"media")
    (ambiguous_dir / ".manifest.json").write_text(
        json.dumps({"metadata": metadata.model_dump(by_alias=True), "probe": probe.model_dump()}),
        encoding="utf-8",
    )
    ambiguous = AmbiguousTelegram()
    ambiguous_service = DownloaderService(
        settings,
        telegram=ambiguous,
        dependency_provider=lambda _settings: ready_diagnostics,
    )
    ambiguous_result = await ambiguous_service.deliver(
        JobDeliveryRequest(
            jobId=ambiguous_job_id,
            telegramChatId="123",
            objectKey=f"staged/{ambiguous_job_id}/{ambiguous_output.name}",
            filename=ambiguous_output.name,
            mimeType="video/mp4",
            mode="video",
            deliveryMode="telegram",
        )
    )
    assert ambiguous_result["status"] == "failed"
    assert ambiguous_result["outcome"] == "ambiguous"
    assert ambiguous.sent == 1
    assert not ambiguous_dir.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("retry_after", [None, "1", 0, 1.5, 2**53])
async def test_malformed_telegram_retry_after_is_not_replayed(settings, retry_after):
    calls = 0
    service = DownloaderService(settings)

    async def operation():
        nonlocal calls
        calls += 1
        raise TelegramApiError(ErrorCode.TELEGRAM_RATE_LIMITED, retry_after=retry_after)

    with pytest.raises(TelegramApiError) as caught:
        await service._retry_explicit_telegram_rate_limit("job-rate-limit", operation)

    assert caught.value.outcome == "rejected"
    assert calls == 1


@pytest.mark.asyncio
async def test_long_telegram_retry_after_does_not_cross_deadline(settings):
    service = DownloaderService(settings)
    calls = 0

    async def operation():
        nonlocal calls
        calls += 1
        raise TelegramApiError(ErrorCode.TELEGRAM_RATE_LIMITED, retry_after=86_401)

    with activate_deadline(JobDeadline.start(0.05)), pytest.raises(TelegramApiError) as caught:
        await service._retry_explicit_telegram_rate_limit("job-rate-limit", operation)

    assert caught.value.outcome == "rejected"
    assert caught.value.retry_after == 86_401
    assert calls == 1


@pytest.mark.asyncio
async def test_long_telegram_retry_after_is_serialized_for_durable_scheduling(settings, monkeypatch):
    settings.job_timeout_seconds = 1
    job_id = "job-rate-limit-durable"
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

    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    telegram = LongRateLimitedTelegram()
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
    assert result["outcome"] == "rejected"
    assert result["retryAfterSeconds"] == 86_401
    assert telegram.sent == 1
    assert not job_dir.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("telegram_type", "outcome"),
    [
        (TimeoutTelegram, "ambiguous"),
        (NetworkTelegram, "ambiguous"),
        (ServerErrorTelegram, "ambiguous"),
        (MalformedTelegram, "ambiguous"),
        (ExplicitBadRequestTelegram, "rejected"),
    ],
)
async def test_delivery_failure_outcome_is_explicit(settings, monkeypatch, telegram_type, outcome):
    job_id = f"job-outcome-{telegram_type.__name__.lower()}"
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

    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    telegram = telegram_type()
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
    assert result["outcome"] == outcome
    assert telegram.sent == 1
    assert not job_dir.exists()


@pytest.mark.asyncio
async def test_prepare_and_one_shot_deliver_contract(settings, ready_diagnostics, monkeypatch):
    calls = {"probe": 0, "download": 0}

    async def fake_probe(*_args, **_kwargs):
        calls["probe"] += 1
        return ProbeInfo(
            id="source-id",
            title="A title",
            extractor="youtube",
            formats=[
                {"format_id": "v", "ext": "mp4", "height": 720, "vcodec": "avc1", "acodec": "none", "filesize": 2_000},
                {"format_id": "a", "ext": "m4a", "vcodec": "none", "acodec": "mp4a", "filesize": 500},
            ],
        )

    async def fake_run(args, *, cwd, **_kwargs):
        calls["download"] += 1
        output = Path(cwd) / "Me at the zoo [jNQXAC9IVRw].mp4"
        output.write_bytes(b"media")
        return ProcessResult(tuple(args), 0, str(output), "")

    async def fake_verify(path, **_kwargs):
        return MediaMetadata(
            filename=Path(path).name,
            mimeType="video/mp4",
            sizeBytes=5,
            duration=1,
            height=360,
            hasVideo=True,
            hasAudio=True,
        )

    monkeypatch.setattr("downloader_container.service.probe_media", fake_probe)
    monkeypatch.setattr("downloader_container.service.run_process", fake_run)
    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    telegram = FakeTelegram()
    service = DownloaderService(settings, telegram=telegram, dependency_provider=lambda _settings: ready_diagnostics)
    prepared = await service.run(
        JobRunRequest(
            jobId="job-contract",
            sourceUrl="https://youtu.be/example",
            telegramChatId="123",
            waitingMessageId=7,
            mode="video",
            maximumHeight=720,
            preferredFormat="mp4",
        )
    )
    assert prepared["status"] == "prepared"
    assert prepared["delivery"] == "telegram"
    assert prepared["filename"] == "Me at the zoo [jNQXAC9IVRw].mp4"
    assert prepared["objectKey"] == "staged/job-contract/Me at the zoo [jNQXAC9IVRw].mp4"
    object_key = prepared["objectKey"]
    assert isinstance(object_key, str)
    assert (Path(settings.jobs_root) / "job-contract").is_dir()
    assert telegram.sent == 0
    prepared_again = await service.run(
        JobRunRequest(
            jobId="job-contract",
            sourceUrl="https://youtu.be/example",
            telegramChatId="123",
            waitingMessageId=7,
            mode="video",
            maximumHeight=720,
            preferredFormat="mp4",
        )
    )
    assert prepared_again["objectKey"] == object_key
    assert calls == {"probe": 1, "download": 1}

    def fail_cleanup(*_args, **_kwargs):
        raise OSError("cleanup unavailable")

    monkeypatch.setattr(JobWorkspace, "cleanup_existing", fail_cleanup)
    delivered = await service.deliver(
        JobDeliveryRequest(
            jobId="job-contract",
            telegramChatId="123",
            objectKey=object_key,
            filename=prepared["filename"],
            mimeType=prepared["mimeType"],
            mode="video",
            deliveryMode="telegram",
        )
    )
    assert delivered["status"] == "completed"
    assert delivered["telegramMessageId"] == "321"
    assert telegram.sent == 1
    assert (Path(settings.jobs_root) / "job-contract").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("real_portrait", [False, True])
async def test_default_video_request_prepares_and_delivers_image_as_photo(settings, ready_diagnostics, monkeypatch, tmp_path, real_portrait):
    original = tmp_path / "portrait.jpg"
    if real_portrait:
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            pytest.skip("real image check requires ffmpeg and ffprobe")
        settings.ffprobe_path = shutil.which("ffprobe")
        subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-f", "lavfi", "-i",
                        "color=red:s=640x1280", "-frames:v", "1", str(original)], check=True, capture_output=True)
    async def fake_probe(*_args, **_kwargs):
        return ProbeInfo(
            id="image-id",
            title="A photo",
            extractor="instagram",
            formats=[
                {
                    "format_id": "image",
                    "ext": "jpg",
                    "width": 1200,
                    "height": 800,
                    "vcodec": "mjpeg",
                    "acodec": "none",
                    "filesize": 2_000,
                }
            ],
        )

    async def fake_run(args, *, cwd, **_kwargs):
        assert "--format" in args
        assert args[args.index("--format") + 1] == "best"
        assert "--merge-output-format" not in args
        output = Path(cwd) / "photo.jpg"
        output.write_bytes(original.read_bytes() if real_portrait else b"image")
        return ProcessResult(tuple(args), 0, str(output), "")

    async def fake_verify(path, **_kwargs):
        return MediaMetadata(filename=Path(path).name, mimeType="image/jpeg", sizeBytes=5, hasVideo=False)

    monkeypatch.setattr("downloader_container.service.probe_media", fake_probe)
    monkeypatch.setattr("downloader_container.service.run_process", fake_run)
    if not real_portrait:
        monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    telegram = PhotoTelegram()
    service = DownloaderService(settings, telegram=telegram, dependency_provider=lambda _settings: ready_diagnostics)

    prepared = await service.run(
        JobRunRequest(
            jobId="job-image",
            sourceUrl="https://example.com/image",
            telegramChatId="123",
            waitingMessageId=7,
            mode="video",
            maximumHeight=360,
        )
    )

    assert prepared["status"] == "prepared"
    assert prepared["mimeType"] == "image/jpeg"
    if real_portrait:
        assert prepared["height"] == 1280
        assert (Path(settings.jobs_root) / "job-image" / prepared["filename"]).read_bytes() == original.read_bytes()
    delivered = await service.deliver(
        JobDeliveryRequest(
            jobId="job-image",
            telegramChatId="123",
            objectKey=prepared["objectKey"],
            filename=prepared["filename"],
            mimeType=prepared["mimeType"],
            mode="video",
            deliveryMode="telegram",
        )
    )

    assert delivered["status"] == "completed"
    assert telegram.actions == ["upload_photo"]
    assert telegram.metadata[0].mime_type == "image/jpeg"
    assert not (Path(settings.jobs_root) / "job-image").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("size_field", ["filesize", "filesize_approx"])
async def test_oversized_image_preflight_requires_exact_filesize(
    settings,
    ready_diagnostics,
    monkeypatch,
    size_field,
):
    settings.telegram_upload_limit_bytes = 5
    calls = {"download": 0}

    async def fake_probe(*_args, **_kwargs):
        return ProbeInfo(
            id="image-id",
            title="A large photo",
            extractor="instagram",
            formats=[
                {
                    "format_id": "image",
                    "ext": "jpg",
                    "width": 1200,
                    "height": 800,
                    "vcodec": "mjpeg",
                    "acodec": "none",
                    size_field: 10,
                }
            ],
        )

    async def fake_run(args, *, cwd, **_kwargs):
        calls["download"] += 1
        if size_field == "filesize":
            raise AssertionError("known oversized image should not be downloaded without R2")
        output = Path(cwd) / "photo.jpg"
        output.write_bytes(b"image")
        return ProcessResult(tuple(args), 0, str(output), "")

    async def fake_verify(path, **_kwargs):
        return MediaMetadata(filename=Path(path).name, mimeType="image/jpeg", sizeBytes=5, hasVideo=False)

    monkeypatch.setattr("downloader_container.service.probe_media", fake_probe)
    monkeypatch.setattr("downloader_container.service.run_process", fake_run)
    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    service = DownloaderService(settings, dependency_provider=lambda _settings: ready_diagnostics)

    result = await service.run(
        JobRunRequest(
            jobId="job-oversized-image-no-r2",
            sourceUrl="https://example.com/image",
            telegramChatId="123",
            waitingMessageId=7,
            mode="video",
        )
    )

    if size_field == "filesize":
        assert result["status"] == "failed"
        assert result["errorCode"] == ErrorCode.R2_UPLOAD_FAILED.value
        assert result["retryable"] is False
        assert calls["download"] == 0
    else:
        assert result["status"] == "prepared"
        assert calls["download"] == 1


class FakeR2:
    def __init__(self) -> None:
        self.uploaded = []

    async def upload(self, **_kwargs):
        from types import SimpleNamespace

        self.uploaded.append(_kwargs)
        return SimpleNamespace(
            object_key=f"jobs/{_kwargs['job_id']}/{_kwargs['filename']}",
            expires_at="2099-01-01T00:00:00Z",
            download_url=None,
        )

    def download_url_for(self, **_kwargs):
        return "https://worker.example/download/signed", "2099-01-01T00:00:00Z"


@pytest.mark.asyncio
async def test_r2_prepare_has_no_local_delivery_and_r2_deliver_has_no_workspace(settings, ready_diagnostics, monkeypatch):
    settings.telegram_upload_limit_bytes = 1

    async def fake_probe(*_args, **_kwargs):
        return ProbeInfo(
            id="source-id",
            title="A title",
            extractor="youtube",
            formats=[{"format_id": "v", "ext": "mp4", "height": 360, "vcodec": "avc1", "acodec": "none", "filesize": 10}],
        )

    async def fake_run(args, *, cwd, **_kwargs):
        output = Path(cwd) / "large.mp4"
        output.write_bytes(b"large-media")
        return ProcessResult(tuple(args), 0, str(output), "")

    async def fake_verify(path, **_kwargs):
        return MediaMetadata(
            filename=Path(path).name,
            mimeType="video/mp4",
            sizeBytes=11,
            duration=1,
            height=360,
            hasVideo=True,
            hasAudio=True,
        )

    monkeypatch.setattr("downloader_container.service.probe_media", fake_probe)
    monkeypatch.setattr("downloader_container.service.run_process", fake_run)
    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    telegram = FakeTelegram()
    service = DownloaderService(settings, telegram=telegram, r2=FakeR2(), dependency_provider=lambda _settings: ready_diagnostics)
    prepared = await service.run(
        JobRunRequest(
            jobId="job-r2",
            sourceUrl="https://youtu.be/example",
            telegramChatId="123",
            waitingMessageId=7,
            mode="video",
            maximumHeight=360,
            preferredFormat="mp4",
        )
    )
    assert prepared["status"] == "prepared"
    assert prepared["delivery"] == "r2"
    assert prepared["objectKey"] == "jobs/job-r2/large.mp4"
    assert telegram.sent == 0
    def fail_cleanup(*_args, **_kwargs):
        raise OSError("cleanup unavailable")

    monkeypatch.setattr(JobWorkspace, "cleanup_existing", fail_cleanup)
    delivered = await service.deliver(
        JobDeliveryRequest(
            jobId="job-r2",
            telegramChatId="123",
            objectKey=prepared["objectKey"],
            filename=prepared["filename"],
            mimeType="video/mp4",
            sizeBytes=11,
            mode="video",
            deliveryMode="r2",
        )
    )
    assert delivered["status"] == "completed"
    assert delivered["delivery"] == "r2"
    assert delivered["telegramMessageId"] == "654"
    assert delivered["objectKey"] == "jobs/job-r2/large.mp4"
    assert not (Path(settings.jobs_root) / "job-r2").exists()


@pytest.mark.asyncio
async def test_explicit_telegram_size_rejection_falls_back_to_one_r2_link(settings, ready_diagnostics, monkeypatch):
    async def fake_probe(*_args, **_kwargs):
        return ProbeInfo(
            id="source-id",
            title="A title",
            extractor="youtube",
            formats=[
                {"format_id": "v", "ext": "mp4", "height": 360, "vcodec": "avc1", "acodec": "none", "filesize": 10}
            ],
        )

    async def fake_run(args, *, cwd, **_kwargs):
        output = Path(cwd) / "download.mp4"
        output.write_bytes(b"media")
        return ProcessResult(tuple(args), 0, str(output), "")

    async def fake_verify(path, **_kwargs):
        return MediaMetadata(
            filename=Path(path).name,
            mimeType="video/mp4",
            sizeBytes=5,
            duration=1,
            height=360,
            hasVideo=True,
            hasAudio=True,
        )

    monkeypatch.setattr("downloader_container.service.probe_media", fake_probe)
    monkeypatch.setattr("downloader_container.service.run_process", fake_run)
    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    telegram = TooLargeTelegram()
    r2 = FakeR2()
    service = DownloaderService(settings, telegram=telegram, r2=r2, dependency_provider=lambda _settings: ready_diagnostics)
    prepared = await service.run(
        JobRunRequest(
            jobId="job-fallback",
            sourceUrl="https://youtu.be/example",
            telegramChatId="123",
            waitingMessageId=7,
            mode="video",
            maximumHeight=360,
            preferredFormat="mp4",
        )
    )
    def fail_cleanup(*_args, **_kwargs):
        raise OSError("cleanup unavailable")

    monkeypatch.setattr(JobWorkspace, "cleanup_existing", fail_cleanup)
    delivered = await service.deliver(
        JobDeliveryRequest(
            jobId="job-fallback",
            telegramChatId="123",
            objectKey=prepared["objectKey"],
            filename=prepared["filename"],
            mimeType=prepared["mimeType"],
            mode="video",
            deliveryMode="telegram",
        )
    )
    assert delivered["status"] == "completed"
    assert delivered["delivery"] == "r2"
    assert delivered["telegramMessageId"] == "654"
    assert delivered["objectKey"] == "jobs/job-fallback/download.mp4"
    assert len(r2.uploaded) == 1
    assert telegram.sent == 2  # one explicit 413, then one link message
    assert (Path(settings.jobs_root) / "job-fallback").exists()


@pytest.mark.asyncio
async def test_explicit_telegram_400_retries_once_as_document(settings, ready_diagnostics, monkeypatch):
    async def fake_probe(*_args, **_kwargs):
        return ProbeInfo(
            id="source-id",
            title="A title",
            extractor="youtube",
            formats=[{"format_id": "v", "ext": "mp4", "height": 360, "vcodec": "avc1", "acodec": "none", "filesize": 10}],
        )

    async def fake_run(args, *, cwd, **_kwargs):
        output = Path(cwd) / "download.mp4"
        output.write_bytes(b"media")
        return ProcessResult(tuple(args), 0, str(output), "")

    async def fake_verify(path, **_kwargs):
        return MediaMetadata(
            filename=Path(path).name,
            mimeType="video/mp4",
            sizeBytes=5,
            duration=1,
            height=360,
            hasVideo=True,
            hasAudio=True,
        )

    monkeypatch.setattr("downloader_container.service.probe_media", fake_probe)
    monkeypatch.setattr("downloader_container.service.run_process", fake_run)
    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    telegram = BadRequestTelegram()
    service = DownloaderService(settings, telegram=telegram, dependency_provider=lambda _settings: ready_diagnostics)
    prepared = await service.run(
        JobRunRequest(
            jobId="job-document-fallback",
            sourceUrl="https://youtu.be/example",
            telegramChatId="123",
            waitingMessageId=7,
            mode="video",
            maximumHeight=360,
            preferredFormat="mp4",
        )
    )
    def fail_cleanup(*_args, **_kwargs):
        raise OSError("cleanup unavailable")

    monkeypatch.setattr(JobWorkspace, "cleanup_existing", fail_cleanup)
    delivered = await service.deliver(
        JobDeliveryRequest(
            jobId="job-document-fallback",
            telegramChatId="123",
            objectKey=prepared["objectKey"],
            filename=prepared["filename"],
            mimeType=prepared["mimeType"],
            mode="video",
            deliveryMode="telegram",
        )
    )
    assert delivered["status"] == "completed"
    assert delivered["delivery"] == "telegram"
    assert delivered["telegramMessageId"] == "987"
    assert telegram.sent == 2
    assert telegram.document_sent == 1
    assert (Path(settings.jobs_root) / "job-document-fallback").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("verified_height", [None, 721])
async def test_delivery_rechecks_persisted_video_ceiling_before_telegram(settings, monkeypatch, verified_height):
    job_dir = Path(settings.jobs_root) / "job-height"
    job_dir.mkdir(parents=True)
    (job_dir / "clip.mp4").write_bytes(b"video")
    metadata = MediaMetadata(filename="clip.mp4", mimeType="video/mp4", sizeBytes=5,
                             duration=1, height=720, hasVideo=True, hasAudio=True)
    (job_dir / ".manifest.json").write_text(json.dumps({
        "maximumHeight": 720, "metadata": metadata.model_dump(), "probe": ProbeInfo().model_dump(),
    }))

    async def verify(*_args, **_kwargs):
        return metadata.model_copy(update={"height": verified_height})

    monkeypatch.setattr("downloader_container.service.verify_media", verify)
    telegram = FakeTelegram()
    service = DownloaderService(settings, telegram=telegram)
    result = await service.deliver(JobDeliveryRequest(
        jobId="job-height", telegramChatId="123", objectKey="staged/job-height/clip.mp4",
        filename="clip.mp4", mimeType="video/mp4", sizeBytes=5, mode="video",
    ))
    assert result["errorCode"] == "PROCESSING_FAILED" and result["outcome"] == "rejected"
    assert telegram.sent == 0 and not job_dir.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("height", [None, 720])
@pytest.mark.parametrize("delivery", ["telegram", "r2"])
async def test_no_staging_or_r2_upload_of_unverified_over_cap_video(settings, height, delivery):
    job = JobRunRequest(jobId="job-height", sourceUrl="https://youtu.be/example", telegramChatId="123",
                        waitingMessageId=7, mode="video", maximumHeight=360)
    r2 = FakeR2()
    service = DownloaderService(settings, r2=r2)
    with JobWorkspace(settings.jobs_root, job.job_id, max_bytes=settings.max_temp_disk_bytes) as workspace:
        output = workspace.child("clip.mp4")
        output.write_bytes(b"video")
        metadata = MediaMetadata(filename="clip.mp4", mimeType="video/mp4", sizeBytes=5,
                                 duration=1, height=height, hasVideo=True, hasAudio=True)
        with pytest.raises(DownloadError) as failure:
            if delivery == "telegram":
                await service._stage_telegram(job, output, metadata, ProbeInfo(), workspace)
            else:
                source = validate_source_url(job.source_url, allowed_hosts=settings.allowed_source_hosts, resolve_dns=False)
                await service._prepare_r2(job, output, metadata, source)
        assert failure.value.code == ErrorCode.PROCESSING_FAILED
        assert not workspace.child(".manifest.json").exists() and not r2.uploaded

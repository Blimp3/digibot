from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest

from downloader_container.direct_media import DirectMedia
from downloader_container.errors import DownloadError, ErrorCode
from downloader_container.models import (
    JobDeliveryRequest,
    JobRunRequest,
    MediaMetadata,
    MediaMode,
    ProbeFormat,
    ProbeInfo,
)
from downloader_container.process import ProcessExecutionError, ProcessResult
from downloader_container.service import DownloaderService
from downloader_container.telegram import TelegramApiError, TelegramMessage
from downloader_container.workspace import JobWorkspace


def _stage_legacy_direct(
    service,
    request: JobRunRequest,
    direct: DirectMedia,
    workspace: JobWorkspace,
) -> dict[str, object]:
    manifest = {
        "kind": "direct",
        "maximumHeight": request.maximum_height or 1080,
        "provider": "tiktok" if direct.probe.extractor == "tiktok" else "x",
        "directUrl": direct.url,
        "deadlineAt": None,
        "metadata": {
            "filename": direct.filename,
            "mimeType": direct.mime_type,
            "sizeBytes": direct.size_bytes,
            "duration": direct.duration,
            "width": direct.width,
            "height": direct.height,
            "hasVideo": True,
            "hasAudio": True,
            "formatName": "mp4",
        },
        "probe": direct.probe.model_dump(),
        "mode": request.mode.value,
    }
    manifest_path = workspace.child(".manifest.json")
    manifest_path.write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
    # The manifest contains a short-lived provider URL, so keep it private
    # even though the enclosing JobWorkspace is already mode 0700.
    manifest_path.chmod(0o600)
    workspace.retain()
    return service._direct_success(request, MediaMetadata.model_validate(manifest["metadata"]), direct.url, deadline_at=None)


class DirectTelegram:
    def __init__(self) -> None:
        self.urls: list[str] = []

    async def send_video_url(self, **kwargs):
        self.urls.append(kwargs["url"])
        return TelegramMessage(777, file_id="telegram-file-id", media_method="sendVideo")


class RejectedUrlTelegram(DirectTelegram):
    def __init__(self) -> None:
        super().__init__()
        self.multipart_paths: list[str] = []

    async def send_video_url(self, **_kwargs):
        self.urls.append("rejected")
        raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED, status_code=400)

    async def send_media(self, **kwargs):
        self.multipart_paths.append(str(kwargs["path"]))
        return TelegramMessage(778, file_id="telegram-uploaded-file", media_method="sendVideo")


class AudioTelegram:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def send_chat_action(self, **_kwargs):
        return None

    async def send_media(self, **kwargs):
        self.calls.append(kwargs)
        return TelegramMessage(779, file_id="telegram-audio-file", media_method="sendAudio")


def _direct_audio_media(url: str = "https://v16e.tiktokcdn.com/video.mp4?token=short-lived") -> DirectMedia:
    probe = ProbeInfo(
        id="7578502470108777750",
        title="A clip",
        extractor="tiktok",
        duration=2,
        width=576,
        height=576,
        formats=[ProbeFormat(format_id="h264", ext="mp4", vcodec="h264", acodec="aac", filesize=6)],
    )
    return DirectMedia(
        url=url,
        filename="A clip [7578502470108777750].mp4",
        mime_type="video/mp4",
        size_bytes=6,
        duration=2,
        width=576,
        height=576,
        probe=probe,
    )


def _transcode_request(job_id: str, preferred_format: str = "m4a") -> JobRunRequest:
    return JobRunRequest(
        jobId=job_id,
        sourceUrl="https://www.tiktok.com/@author/video/7578502470108777750",
        telegramChatId="123",
        waitingMessageId=7,
        mode="audio",
        preferredFormat=preferred_format,
    )


def _video_audio_metadata(codec: str = "aac") -> MediaMetadata:
    return MediaMetadata(
        filename="source.mp4",
        mimeType="video/mp4",
        sizeBytes=6,
        duration=2,
        hasVideo=True,
        hasAudio=True,
        firstAudioCodec=codec,
    )


def _verified_audio_metadata(path: str | Path, *, size: int = 4) -> MediaMetadata:
    return MediaMetadata(
        filename=Path(path).name,
        mimeType="audio/mp4",
        sizeBytes=size,
        duration=2,
        hasVideo=False,
        hasAudio=True,
        firstAudioCodec="aac",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("preferred_format", "mime_type", "codec"),
    [("m4a", "audio/mp4", "aac"), ("mp3", "audio/mpeg", "libmp3lame")],
)
async def test_direct_audio_uses_provider_mp4_when_yt_dlp_is_unavailable(
    settings,
    monkeypatch,
    preferred_format,
    mime_type,
    codec,
):
    settings.allowed_source_hosts = frozenset({"tiktok.com", "www.tiktok.com"})
    settings.resolve_source_dns = False
    direct = _direct_audio_media()
    ffmpeg_args: list[list[str]] = []

    async def fake_resolve(*_args, **_kwargs):
        return direct

    async def fake_download(_url, target, **_kwargs):
        Path(target).write_bytes(b"source")
        return 6

    async def fake_process(args, **_kwargs):
        normalized = [str(item) for item in args]
        ffmpeg_args.append(normalized)
        Path(normalized[-1]).write_bytes(b"audio")
        return ProcessResult(tuple(normalized), 0, "", "")

    async def fake_verify(path, **_kwargs):
        path = Path(path)
        if path.name == "direct-source.mp4":
            return MediaMetadata(
                filename=path.name,
                mimeType="video/mp4",
                sizeBytes=6,
                duration=2,
                hasVideo=True,
                hasAudio=True,
            )
        return MediaMetadata(
            filename=path.name,
            mimeType=mime_type,
            sizeBytes=5,
            duration=2,
            hasVideo=False,
            hasAudio=True,
        )

    monkeypatch.setattr("downloader_container.service.resolve_direct_media", fake_resolve)
    monkeypatch.setattr("downloader_container.service.download_direct_media", fake_download)
    monkeypatch.setattr("downloader_container.service.run_process", fake_process)
    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)

    def yt_dlp_unavailable(_settings):
        raise AssertionError("the direct provider fallback should bypass yt-dlp diagnostics")

    telegram = AudioTelegram()
    service = DownloaderService(settings, telegram=telegram, dependency_provider=yt_dlp_unavailable)
    prepared = await service.run(
        JobRunRequest(
            jobId=f"job-direct-{preferred_format}",
            sourceUrl="https://www.tiktok.com/@author/video/7578502470108777750",
            telegramChatId="123",
            waitingMessageId=7,
            mode="audio",
            preferredFormat=preferred_format,
        )
    )

    assert prepared == {
        "status": "prepared",
        "delivery": "telegram",
        "objectKey": f"staged/job-direct-{preferred_format}/transcoded-96.{preferred_format}",
        "filename": f"transcoded-96.{preferred_format}",
        "mimeType": mime_type,
        "sizeBytes": 5,
        "duration": 2.0,
        "deadlineAt": prepared["deadlineAt"],
    }
    assert len(ffmpeg_args) == 1
    args = ffmpeg_args[0]
    assert direct.url not in args
    assert "-vn" in args
    assert "-c:a" in args and args[args.index("-c:a") + 1] == codec
    assert "-metadata" in args and "title=A clip" in args[args.index("-metadata") + 1]

    manifest = json.loads((Path(settings.jobs_root) / f"job-direct-{preferred_format}" / ".manifest.json").read_text())
    assert manifest["metadata"]["hasVideo"] is False
    assert manifest["metadata"]["hasAudio"] is True
    delivered = await service.deliver(
        JobDeliveryRequest(
            jobId=f"job-direct-{preferred_format}",
            telegramChatId="123",
            objectKey=prepared["objectKey"],
            filename=prepared["filename"],
            mimeType=mime_type,
            sizeBytes=5,
            mode=MediaMode.AUDIO,
        )
    )
    assert delivered["status"] == "completed"
    assert telegram.calls[0]["mode"] == MediaMode.AUDIO


@pytest.mark.asyncio
async def test_direct_audio_rejects_silent_provider_media(settings, monkeypatch):
    settings.allowed_source_hosts = frozenset({"tiktok.com", "www.tiktok.com"})
    settings.resolve_source_dns = False
    direct = _direct_audio_media()

    async def fake_resolve(*_args, **_kwargs):
        return direct

    async def fake_download(_url, target, **_kwargs):
        Path(target).write_bytes(b"silent-video")
        return 12

    async def fake_verify(path, **_kwargs):
        return MediaMetadata(
            filename=Path(path).name,
            mimeType="video/mp4",
            sizeBytes=12,
            duration=2,
            hasVideo=True,
            hasAudio=False,
        )

    monkeypatch.setattr("downloader_container.service.resolve_direct_media", fake_resolve)
    monkeypatch.setattr("downloader_container.service.download_direct_media", fake_download)
    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    service = DownloaderService(settings, dependency_provider=lambda _settings: {"ready": False})

    result = await service.run(
        JobRunRequest(
            jobId="job-direct-silent",
            sourceUrl="https://www.tiktok.com/@author/video/7578502470108777750",
            telegramChatId="123",
            waitingMessageId=7,
            mode="audio",
            preferredFormat="m4a",
        )
    )

    assert result["errorCode"] == ErrorCode.UNSUPPORTED_MEDIA.value
    assert not (Path(settings.jobs_root) / "job-direct-silent").exists()


@pytest.mark.asyncio
async def test_direct_audio_rejects_unvalidated_provider_url(settings, monkeypatch):
    settings.allowed_source_hosts = frozenset({"tiktok.com", "www.tiktok.com"})
    settings.resolve_source_dns = False
    direct = _direct_audio_media("https://evil.example/video.mp4")
    download_called = False

    async def fake_resolve(*_args, **_kwargs):
        return direct

    async def fake_download(*_args, **_kwargs):
        nonlocal download_called
        download_called = True

    monkeypatch.setattr("downloader_container.service.resolve_direct_media", fake_resolve)
    monkeypatch.setattr("downloader_container.service.download_direct_media", fake_download)
    service = DownloaderService(settings, dependency_provider=lambda _settings: {"ready": False})

    result = await service.run(
        JobRunRequest(
            jobId="job-direct-unsafe",
            sourceUrl="https://www.tiktok.com/@author/video/7578502470108777750",
            telegramChatId="123",
            waitingMessageId=7,
            mode="audio",
            preferredFormat="mp3",
        )
    )

    assert result["errorCode"] == ErrorCode.MEDIA_UNAVAILABLE.value
    assert download_called is False


@pytest.mark.asyncio
async def test_audio_transcode_preserves_last_verified_output_after_later_failures(settings, monkeypatch):
    settings.telegram_upload_limit_bytes = 1
    source_metadata = _video_audio_metadata()
    attempts = 0

    async def fake_process(args, **_kwargs):
        nonlocal attempts
        attempts += 1
        normalized = [str(item) for item in args]
        Path(normalized[-1]).write_bytes(b"good" if attempts == 1 else b"partial")
        if attempts > 1:
            raise ProcessExecutionError(ProcessResult(tuple(normalized), 1, "", "failed"))
        return ProcessResult(tuple(normalized), 0, "", "")

    async def fake_verify(path, **_kwargs):
        path = Path(path)
        if path.name == "source.mp4":
            return source_metadata
        return MediaMetadata(
            filename=path.name,
            mimeType="audio/mpeg",
            sizeBytes=4,
            duration=2,
            hasVideo=False,
            hasAudio=True,
        )

    monkeypatch.setattr("downloader_container.service.run_process", fake_process)
    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    service = DownloaderService(settings)
    request = _transcode_request("job-preserve-audio", "mp3")
    with JobWorkspace(settings.jobs_root, request.job_id, max_bytes=settings.max_temp_disk_bytes) as workspace:
        source = workspace.child("source.mp4")
        source.write_bytes(b"source")
        output, metadata = await service._try_transcode(request, source, source_metadata, workspace)

        assert attempts == 3
        assert output.read_bytes() == b"good"
        assert metadata.filename == "transcoded-96.mp3"
        assert not (workspace.path / "transcoded-64.mp3").exists()
        assert not (workspace.path / "transcoded-48.mp3").exists()


@pytest.mark.asyncio
async def test_m4a_transcode_copies_first_aac_audio_stream(settings, monkeypatch):
    settings.telegram_upload_limit_bytes = 100
    source_metadata = _video_audio_metadata()
    calls: list[list[str]] = []

    async def fake_process(args, **_kwargs):
        normalized = [str(item) for item in args]
        calls.append(normalized)
        Path(normalized[-1]).write_bytes(b"copy")
        return ProcessResult(tuple(normalized), 0, "", "")

    async def fake_verify(path, **_kwargs):
        return _verified_audio_metadata(path)

    monkeypatch.setattr("downloader_container.service.run_process", fake_process)
    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    service = DownloaderService(settings)
    request = _transcode_request("job-copy-m4a")
    with JobWorkspace(settings.jobs_root, request.job_id, max_bytes=settings.max_temp_disk_bytes) as workspace:
        source = workspace.child("source.mp4")
        source.write_bytes(b"source")
        output, metadata = await service._try_transcode(request, source, source_metadata, workspace, title="A clip")

    assert output.name == "transcoded-copy.m4a"
    assert metadata.first_audio_codec == "aac"
    assert len(calls) == 1
    assert calls[0][calls[0].index("-map") + 1] == "0:a:0"
    assert "-vn" in calls[0]
    assert calls[0][calls[0].index("-c:a") + 1] == "copy"
    assert "-b:a" not in calls[0]
    assert "title=A clip" in calls[0]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("codec", "has_video"),
    [("opus", True), ("aac", False)],
)
async def test_m4a_transcode_uses_encoding_when_copy_is_ineligible(settings, monkeypatch, codec, has_video):
    settings.telegram_upload_limit_bytes = 100
    source_metadata = _video_audio_metadata(codec).model_copy(update={"has_video": has_video})
    calls: list[list[str]] = []

    async def fake_process(args, **_kwargs):
        normalized = [str(item) for item in args]
        calls.append(normalized)
        Path(normalized[-1]).write_bytes(b"encoded")
        return ProcessResult(tuple(normalized), 0, "", "")

    async def fake_verify(path, **_kwargs):
        return _verified_audio_metadata(path)

    monkeypatch.setattr("downloader_container.service.run_process", fake_process)
    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    service = DownloaderService(settings)
    request = _transcode_request("job-encode-m4a")
    with JobWorkspace(settings.jobs_root, request.job_id, max_bytes=settings.max_temp_disk_bytes) as workspace:
        source = workspace.child("source.mp4")
        source.write_bytes(b"source")
        output, _metadata = await service._try_transcode(request, source, source_metadata, workspace)

    assert output.name == "transcoded-96.m4a"
    assert len(calls) == 1
    assert calls[0][calls[0].index("-c:a") + 1] == "aac"
    assert calls[0][calls[0].index("-b:a") + 1] == "96k"


@pytest.mark.asyncio
async def test_m4a_copy_failure_falls_back_to_encoding(settings, monkeypatch):
    settings.telegram_upload_limit_bytes = 100
    source_metadata = _video_audio_metadata()
    calls: list[list[str]] = []

    async def fake_process(args, **_kwargs):
        normalized = [str(item) for item in args]
        calls.append(normalized)
        Path(normalized[-1]).write_bytes(b"partial" if len(calls) == 1 else b"encoded")
        if len(calls) == 1:
            raise ProcessExecutionError(ProcessResult(tuple(normalized), 1, "", "failed"))
        return ProcessResult(tuple(normalized), 0, "", "")

    async def fake_verify(path, **_kwargs):
        return _verified_audio_metadata(path)

    monkeypatch.setattr("downloader_container.service.run_process", fake_process)
    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    service = DownloaderService(settings)
    request = _transcode_request("job-failed-copy")
    with JobWorkspace(settings.jobs_root, request.job_id, max_bytes=settings.max_temp_disk_bytes) as workspace:
        source = workspace.child("source.mp4")
        source.write_bytes(b"source")
        output, _metadata = await service._try_transcode(request, source, source_metadata, workspace)
        assert not (workspace.path / "transcoded-copy.m4a").exists()

    assert output.name == "transcoded-96.m4a"
    assert len(calls) == 2
    assert calls[0][calls[0].index("-c:a") + 1] == "copy"
    assert calls[1][calls[1].index("-c:a") + 1] == "aac"


@pytest.mark.asyncio
async def test_m4a_copy_verification_failure_falls_back_to_encoding(settings, monkeypatch):
    settings.telegram_upload_limit_bytes = 100
    source_metadata = _video_audio_metadata()
    calls: list[list[str]] = []

    async def fake_process(args, **_kwargs):
        normalized = [str(item) for item in args]
        calls.append(normalized)
        Path(normalized[-1]).write_bytes(b"output")
        return ProcessResult(tuple(normalized), 0, "", "")

    async def fake_verify(path, **_kwargs):
        if Path(path).name == "transcoded-copy.m4a":
            raise DownloadError(ErrorCode.PROCESSING_FAILED)
        return _verified_audio_metadata(path)

    monkeypatch.setattr("downloader_container.service.run_process", fake_process)
    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    service = DownloaderService(settings)
    request = _transcode_request("job-invalid-copy")
    with JobWorkspace(settings.jobs_root, request.job_id, max_bytes=settings.max_temp_disk_bytes) as workspace:
        source = workspace.child("source.mp4")
        source.write_bytes(b"source")
        output, _metadata = await service._try_transcode(request, source, source_metadata, workspace)
        assert not (workspace.path / "transcoded-copy.m4a").exists()

    assert output.name == "transcoded-96.m4a"
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_oversized_m4a_copy_uses_bitrate_fallback(settings, monkeypatch):
    settings.telegram_upload_limit_bytes = 10
    source_metadata = _video_audio_metadata()
    calls: list[list[str]] = []

    async def fake_process(args, **_kwargs):
        normalized = [str(item) for item in args]
        calls.append(normalized)
        Path(normalized[-1]).write_bytes(b"output")
        return ProcessResult(tuple(normalized), 0, "", "")

    async def fake_verify(path, **_kwargs):
        is_copy = Path(path).name == "transcoded-copy.m4a"
        return _verified_audio_metadata(path, size=20 if is_copy else 8)

    monkeypatch.setattr("downloader_container.service.run_process", fake_process)
    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    service = DownloaderService(settings)
    request = _transcode_request("job-oversized-copy")
    with JobWorkspace(settings.jobs_root, request.job_id, max_bytes=settings.max_temp_disk_bytes) as workspace:
        source = workspace.child("source.mp4")
        source.write_bytes(b"source")
        output, metadata = await service._try_transcode(request, source, source_metadata, workspace)

    assert output.name == "transcoded-96.m4a"
    assert metadata.size_bytes == 8
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_oversized_copy_releases_source_before_bitrate_encode(settings, monkeypatch):
    settings.telegram_upload_limit_bytes = 1
    settings.max_temp_disk_bytes = 10
    source_metadata = _video_audio_metadata()
    calls: list[list[str]] = []

    async def fake_process(args, **_kwargs):
        normalized = [str(item) for item in args]
        calls.append(normalized)
        Path(normalized[-1]).write_bytes(b"copyx" if len(calls) == 1 else b"e")
        return ProcessResult(tuple(normalized), 0, "", "")

    async def fake_verify(path, **_kwargs):
        is_copy = Path(path).name == "transcoded-copy.m4a"
        return _verified_audio_metadata(path, size=2 if is_copy else 1)

    monkeypatch.setattr("downloader_container.service.run_process", fake_process)
    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    service = DownloaderService(settings)
    request = _transcode_request("job-copy-headroom")
    with JobWorkspace(settings.jobs_root, request.job_id, max_bytes=settings.max_temp_disk_bytes) as workspace:
        source = workspace.child("source.mp4")
        source.write_bytes(b"srcxx")
        output, metadata = await service._try_transcode(request, source, source_metadata, workspace)

    assert output.name == "transcoded-96.m4a"
    assert metadata.size_bytes == 1
    assert len(calls) == 2
    assert calls[1][calls[1].index("-i") + 1].endswith("transcoded-copy.m4a")


@pytest.mark.asyncio
async def test_bitrate_fallbacks_reuse_verified_aac_copy(settings, monkeypatch):
    settings.telegram_upload_limit_bytes = 1
    source_metadata = _video_audio_metadata()
    calls: list[list[str]] = []

    async def fake_process(args, **_kwargs):
        normalized = [str(item) for item in args]
        calls.append(normalized)
        Path(normalized[-1]).write_bytes(b"output")
        return ProcessResult(tuple(normalized), 0, "", "")

    async def fake_verify(path, **_kwargs):
        return _verified_audio_metadata(path, size=2)

    monkeypatch.setattr("downloader_container.service.run_process", fake_process)
    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    service = DownloaderService(settings)
    request = _transcode_request("job-reuse-copy")
    with JobWorkspace(settings.jobs_root, request.job_id, max_bytes=settings.max_temp_disk_bytes) as workspace:
        source = workspace.child("source.mp4")
        source.write_bytes(b"source")
        output, _metadata = await service._try_transcode(request, source, source_metadata, workspace)

    assert output.name == "transcoded-48.m4a"
    assert len(calls) == 4
    assert all(call[calls[0].index("-i") + 1].endswith("transcoded-copy.m4a") for call in calls[1:])


@pytest.mark.asyncio
async def test_legacy_direct_resume_keeps_provider_url_private_and_delivers_url(settings, monkeypatch):
    settings.allowed_source_hosts = frozenset({"tiktok.com", "www.tiktok.com"})
    settings.resolve_source_dns = False
    direct_url = "https://v16e.tiktokcdn.com/video.mp4?token=short-lived"
    probe = ProbeInfo(
        id="7578502470108777750",
        title="A clip",
        extractor="tiktok",
        duration=16,
        width=576,
        height=576,
        formats=[ProbeFormat(format_id="h264", ext="mp4", vcodec="h264", filesize=1_000_000)],
    )
    direct = DirectMedia(
        url=direct_url,
        filename="A clip [7578502470108777750].mp4",
        mime_type="video/mp4",
        size_bytes=1_000_000,
        duration=16,
        width=576,
        height=576,
        probe=probe,
    )
    async def fake_resolve(*_args, **_kwargs):
        return direct

    monkeypatch.setattr("downloader_container.service.resolve_direct_media", fake_resolve)
    telegram = DirectTelegram()
    service = DownloaderService(settings, telegram=telegram, dependency_provider=lambda _settings: {"ready": False})

    job = JobRunRequest(
        jobId="job-direct",
        sourceUrl="https://www.tiktok.com/@author/video/7578502470108777750",
        telegramChatId="123",
        waitingMessageId=7,
        mode="video",
        preferredFormat="mp4",
    )
    with JobWorkspace(settings.jobs_root, job.job_id, max_bytes=settings.max_temp_disk_bytes) as workspace:
        _stage_legacy_direct(service, job, direct, workspace)
    prepared = await service.run(job)

    assert prepared["delivery"] == "telegram_url"
    assert prepared["objectKey"] == "staged/job-direct/remote.mp4"
    assert "directUrl" not in prepared
    manifest_path = Path(settings.jobs_root) / "job-direct" / ".manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["directUrl"] == direct_url
    assert stat.S_IMODE(manifest_path.stat().st_mode) == 0o600

    def fail_cleanup(*_args, **_kwargs):
        raise OSError("cleanup unavailable")

    monkeypatch.setattr(JobWorkspace, "cleanup_existing", fail_cleanup)
    delivered = await service.deliver(
        JobDeliveryRequest(
            jobId="job-direct",
            telegramChatId="123",
            objectKey=prepared["objectKey"],
            filename=prepared["filename"],
            mimeType=prepared["mimeType"],
            sizeBytes=prepared["sizeBytes"],
            mode="video",
            deliveryMode="telegram_url",
        )
    )

    assert delivered["status"] == "completed"
    assert delivered["telegramMessageId"] == "777"
    assert delivered["telegramFileId"] == "telegram-file-id"
    assert delivered["telegramMediaMethod"] == "sendVideo"
    assert telegram.urls == [direct_url]
    assert (Path(settings.jobs_root) / "job-direct").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("verified_height", [576, None, 1080])
async def test_explicit_telegram_url_400_uses_one_bounded_multipart_fallback(settings, monkeypatch, verified_height):
    settings.allowed_source_hosts = frozenset({"tiktok.com", "www.tiktok.com"})
    settings.resolve_source_dns = False
    direct_url = "https://v16e.tiktokcdn.com/video.mp4?token=short-lived"
    metadata = {
        "filename": "clip.mp4",
        "mimeType": "video/mp4",
        "sizeBytes": 5,
        "duration": 2,
        "width": 576,
        "height": 576,
        "hasVideo": True,
        "hasAudio": True,
        "formatName": "mp4",
    }
    probe = ProbeInfo(
        id="7578502470108777750",
        title="A clip",
        extractor="tiktok",
        duration=2,
        formats=[ProbeFormat(format_id="h264", ext="mp4", vcodec="h264", filesize=5)],
    )
    direct = DirectMedia(
        url=direct_url,
        filename="clip.mp4",
        mime_type="video/mp4",
        size_bytes=5,
        duration=2,
        width=576,
        height=576,
        probe=probe,
    )

    async def fake_resolve(*_args, **_kwargs):
        return direct

    async def fake_download(_url, target, **_kwargs):
        Path(target).write_bytes(b"video")
        return 5

    async def fake_verify(*_args, **_kwargs):
        from downloader_container.models import MediaMetadata

        return MediaMetadata.model_validate(metadata).model_copy(update={"height": verified_height})

    monkeypatch.setattr("downloader_container.service.resolve_direct_media", fake_resolve)
    monkeypatch.setattr("downloader_container.service.download_direct_media", fake_download)
    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    telegram = RejectedUrlTelegram()
    service = DownloaderService(settings, telegram=telegram, dependency_provider=lambda _settings: {"ready": False})
    job = JobRunRequest(
        jobId="job-direct-fallback",
        sourceUrl="https://www.tiktok.com/@author/video/7578502470108777750",
        telegramChatId="123",
        waitingMessageId=7,
        mode="video",
        maximumHeight=720,
        preferredFormat="mp4",
    )
    with JobWorkspace(settings.jobs_root, job.job_id, max_bytes=settings.max_temp_disk_bytes) as workspace:
        _stage_legacy_direct(service, job, direct, workspace)
    prepared = await service.run(job)
    original_unlink = Path.unlink

    def fail_fallback_cleanup(path, *args, **kwargs):
        if path.name == "clip.mp4":
            raise OSError("cleanup unavailable")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_fallback_cleanup)
    delivered = await service.deliver(
        JobDeliveryRequest(
            jobId="job-direct-fallback",
            telegramChatId="123",
            objectKey=prepared["objectKey"],
            filename=prepared["filename"],
            mimeType=prepared["mimeType"],
            sizeBytes=prepared["sizeBytes"],
            mode="video",
            deliveryMode="telegram_url",
        )
    )

    if verified_height != 576:
        assert delivered["status"] == "failed" and delivered["errorCode"] == "PROCESSING_FAILED"
        assert not telegram.multipart_paths
    else:
        assert delivered["status"] == "completed"
        assert delivered["telegramMessageId"] == "778"
        assert telegram.multipart_paths
    assert not (Path(settings.jobs_root) / "job-direct-fallback").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("source_url", "mode"),
    [
        ("https://www.tiktok.com/@author/video/7578502470108777750", "video"),
        ("https://x.com/author/status/2089598976970670190", "audio"),
    ],
)
async def test_tiktok_and_x_reach_yt_dlp_with_the_shipped_resolver(
    settings, ready_diagnostics, monkeypatch, source_url, mode
):
    settings.allowed_source_hosts = frozenset({"www.tiktok.com", "x.com"})
    probed: list[str] = []

    async def fake_probe(_settings, url, *_args, **_kwargs):
        probed.append(url)
        raise DownloadError(ErrorCode.MEDIA_UNAVAILABLE)

    # resolve_direct_media is deliberately not patched.
    monkeypatch.setattr("downloader_container.service.probe_media", fake_probe)
    service = DownloaderService(settings, dependency_provider=lambda _settings: ready_diagnostics)
    result = await service.run(
        JobRunRequest(jobId=f"job-yt-dlp-{mode}", sourceUrl=source_url, telegramChatId="123", waitingMessageId=7, mode=mode)
    )
    assert result["errorCode"] == "MEDIA_UNAVAILABLE"
    assert probed == [source_url]

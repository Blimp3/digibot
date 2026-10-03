from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from downloader_container.errors import DownloadError, ErrorCode
from downloader_container.models import JobDeliveryRequest, JobRunRequest
from downloader_container.process import ProcessExecutionError, ProcessResult, run_process
from downloader_container.service import DownloaderService
from downloader_container.telegram import TelegramMessage


@pytest.fixture
def uploaded_media(tmp_path, settings, request):
    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        pytest.skip("file integration checks require ffmpeg and ffprobe")
    settings.ffmpeg_path, settings.ffprobe_path = ffmpeg, ffprobe
    kind = getattr(request, "param", "video")
    suffix = {"video": "mp4", "audio": "m4a", "voice": "ogg", "coverart": "mp3"}[kind]
    source = tmp_path / f"original.{suffix}"
    args = [ffmpeg, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3"]
    if kind == "video":
        args += ["-f", "lavfi", "-i", "color=red:s=640x480:r=25:d=3"]
    elif kind == "coverart":
        cover = tmp_path / "cover.jpg"
        subprocess.run([ffmpeg, "-v", "error", "-f", "lavfi", "-i", "color=red:s=640x480",
                        "-frames:v", "1", str(cover)], check=True, capture_output=True)
        args += ["-i", str(cover)]
    if kind == "video":
        args += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]
    elif kind == "coverart":
        args += ["-map", "0:a", "-map", "1:v", "-c:a", "libmp3lame", "-c:v", "copy", "-disposition:v", "attached_pic"]
    else:
        args += ["-c:a", "libopus" if kind == "voice" else "aac"]
    subprocess.run([*args, "-t", "3", str(source)], check=True, capture_output=True)
    if kind == "coverart":
        info = json.loads(subprocess.check_output([ffprobe, "-v", "error", "-show_streams", "-of", "json", str(source)]))
        assert any(stream.get("disposition", {}).get("attached_pic") == 1 for stream in info["streams"])
    return source


def file_request(source, **changes):
    return JobRunRequest.model_validate({
        "jobId": "file-job", "telegramChatId": "123", "waitingMessageId": 7,
        "telegramFile": {"fileId": "PRIVATE_FILE_ID", "fileSize": source.stat().st_size, "fileName": "a title.mov"},
        "mode": "video", "preferredFormat": "mp4", "maximumHeight": 360, **changes,
    })


def install_file_download(monkeypatch, source):
    calls = []

    async def download(source_file, target, **kwargs):
        calls.append(source_file.file_id)
        assert kwargs["bot_token"] == "test-bot-token"
        assert Path(target).name == "telegram-input.bin"
        Path(target).write_bytes(source.read_bytes())
        kwargs["workspace_size"]()
        return source.stat().st_size

    def no_url_lane(*_args, **_kwargs):
        raise AssertionError("Telegram files must bypass public URL validation/proxy/yt-dlp")

    monkeypatch.setattr("downloader_container.service.download_telegram_file", download)
    monkeypatch.setattr("downloader_container.service.validate_source_url", no_url_lane)
    monkeypatch.setattr("downloader_container.service.PublicEgressProxy", no_url_lane)
    return calls, no_url_lane


class FileTelegram:
    async def send_chat_action(self, **_kwargs):
        return None

    async def send_media(self, **kwargs):
        assert "telegram-input.bin" not in {p.name for p in Path(kwargs["path"]).parent.iterdir()}
        return TelegramMessage(99, file_id="output-id", media_method="sendVideo")


@pytest.mark.asyncio
@pytest.mark.parametrize(("uploaded_media", "mode", "fmt", "trim"), [
    ("video", "audio", "m4a", False), ("video", "audio", "mp3", False),
    ("video", "video", "mp4", False), ("video", "video", "mp4", True),
    ("audio", "audio", "m4a", False), ("audio", "audio", "mp3", True),
    ("voice", "audio", "m4a", False), ("coverart", "audio", "mp3", False),
], indirect=["uploaded_media"])
async def test_uploaded_file_transcodes_stages_resumes_and_delivers(settings, uploaded_media, monkeypatch, mode, fmt, trim):
    downloads, no_url_lane = install_file_download(monkeypatch, uploaded_media)
    args_seen = []

    async def capture_process(args, **kwargs):
        args_seen.append(args)
        return await run_process(args, **kwargs)

    monkeypatch.setattr("downloader_container.service.run_process", capture_process)
    service = DownloaderService(settings, telegram=FileTelegram(), dependency_provider=no_url_lane)
    request = file_request(uploaded_media, mode=mode, preferredFormat=fmt,
                           trimStartSeconds=1 if trim else None, trimEndSeconds=2 if trim else None)
    prepared = await service.run(request)
    assert prepared["status"] == "prepared", prepared
    assert prepared["delivery"] == "telegram"
    if mode == "video":
        assert prepared["height"] == 360
    assert prepared["duration"] == pytest.approx(1 if trim else 3, abs=0.25)
    directory = Path(settings.jobs_root) / request.job_id
    assert {p.name for p in directory.iterdir()} == {prepared["filename"], ".manifest.json"}
    manifest_text = (directory / ".manifest.json").read_text()
    assert "PRIVATE_FILE_ID" not in manifest_text and "test-bot-token" not in manifest_text
    metadata = json.loads(manifest_text)["metadata"]
    assert metadata["firstAudioCodec"] == ("mp3" if fmt == "mp3" else "aac")
    assert metadata["hasVideo"] is (mode == "video")
    if mode == "video":
        assert metadata["firstVideoCodec"] == "h264"
    assert args_seen
    for args in args_seen:
        i = args.index("-i")
        whitelist_index = args.index("-protocol_whitelist")
        input_options = args[whitelist_index:i]
        assert input_options[:3] == ["-protocol_whitelist", "file", "-f"]
        if input_options[3] == "mov":
            assert input_options[4:] == ["-enable_drefs", "0", "-use_absolute_path", "0"]
        else:
            assert len(input_options) == 4
        assert args[args.index("-map_metadata") + 1] == "-1"
        assert "PRIVATE_FILE_ID" not in " ".join(args)
        assert "copy" not in args
    assert await service.run(request) == prepared
    assert len(downloads) == 1
    delivered = await service.deliver(JobDeliveryRequest(
        jobId=request.job_id, telegramChatId="123", objectKey=prepared["objectKey"],
        filename=prepared["filename"], mimeType=prepared["mimeType"], sizeBytes=prepared["sizeBytes"], mode=mode,
    ))
    assert delivered["status"] == "completed", delivered
    assert not directory.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("uploaded_media", ["audio", "voice", "coverart"], indirect=True)
async def test_audio_or_cover_art_cannot_be_used_as_video(settings, uploaded_media, monkeypatch):
    _, no_url_lane = install_file_download(monkeypatch, uploaded_media)
    service = DownloaderService(settings, dependency_provider=no_url_lane)
    result = await service.run(file_request(uploaded_media))
    assert result["errorCode"] == ErrorCode.UNSUPPORTED_MEDIA.value
    assert not (Path(settings.jobs_root) / "file-job").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["download", "probe", "encode", "deadline"])
async def test_uploaded_input_is_removed_on_failure(settings, uploaded_media, monkeypatch, failure):
    _, no_url_lane = install_file_download(monkeypatch, uploaded_media)
    service = DownloaderService(settings, dependency_provider=no_url_lane)

    async def fail_download(_file, target, **_kwargs):
        Path(target).write_bytes(b"partial")
        raise DownloadError(ErrorCode.DOWNLOAD_FAILED)

    async def fail_probe(*_args, **_kwargs):
        raise DownloadError(ErrorCode.UNSUPPORTED_MEDIA)

    async def fail_encode(args, **_kwargs):
        Path(args[-1]).write_bytes(b"partial output")
        raise ProcessExecutionError(ProcessResult(tuple(args), 1, "", ""))

    if failure == "download":
        monkeypatch.setattr("downloader_container.service.download_telegram_file", fail_download)
    elif failure == "probe":
        monkeypatch.setattr("downloader_container.service.verify_media", fail_probe)
    elif failure == "encode":
        monkeypatch.setattr("downloader_container.service.run_process", fail_encode)
    else:
        from downloader_container.deadline import JobDeadlineExceeded

        async def expire_after_download(_file, target, **_kwargs):
            Path(target).write_bytes(uploaded_media.read_bytes())
            raise JobDeadlineExceeded()

        monkeypatch.setattr("downloader_container.service.download_telegram_file", expire_after_download)
    result = await service.run(file_request(uploaded_media, maximumHeight=720))
    assert result["status"] == "failed", result
    assert not (Path(settings.jobs_root) / "file-job").exists()


@pytest.mark.asyncio
async def test_uploaded_r2_fallback_keeps_only_verified_output_during_upload(settings, uploaded_media, monkeypatch):
    _, no_url_lane = install_file_download(monkeypatch, uploaded_media)
    settings.telegram_upload_limit_bytes = 1
    uploads = []

    class Uploader:
        async def upload(self, **kwargs):
            output = Path(kwargs["path"])
            assert list(output.parent.iterdir()) == [output]
            assert output.name != "telegram-input.bin"
            uploads.append(output.read_bytes())
            return SimpleNamespace(object_key="private/output.mp4", expires_at="2099-01-01T00:00:00Z")

    service = DownloaderService(settings, r2=Uploader(), dependency_provider=no_url_lane)
    result = await service.run(file_request(uploaded_media))
    assert result["status"] == "prepared" and result["delivery"] == "r2", result
    assert result["height"] == 360 and len(uploads) == 1
    assert not (Path(settings.jobs_root) / "file-job").exists()


@pytest.mark.asyncio
async def test_file_input_respects_a_stricter_source_limit_before_fetch(settings, uploaded_media, monkeypatch):
    downloads, no_url_lane = install_file_download(monkeypatch, uploaded_media)
    settings.max_source_download_bytes = 1
    service = DownloaderService(settings, dependency_provider=no_url_lane)
    result = await service.run(file_request(uploaded_media))
    assert result["errorCode"] == ErrorCode.SOURCE_SIZE_LIMIT.value
    assert downloads == []
    assert not (Path(settings.jobs_root) / "file-job").exists()

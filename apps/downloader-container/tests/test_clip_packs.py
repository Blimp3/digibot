from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from pydantic import ValidationError

import test_trimming
from downloader_container.direct_media import DirectMedia
from downloader_container.errors import ErrorCode
from downloader_container.models import JobDeliveryRequest, JobRunRequest, ProbeFormat, ProbeInfo
from downloader_container.process import ProcessExecutionError, ProcessResult, run_process
from downloader_container.service import DownloaderService
from downloader_container.telegram import TelegramApiError, TelegramMessage, build_caption

source_media = test_trimming.source_media


def request_for(source, lane="telegram", ranges=((5, 7), (1, 3))):
    payload = {"jobId": "pack-job", "telegramChatId": "123", "waitingMessageId": 7,
               "mode": "video", "preferredFormat": "mp4", "maximumHeight": 360,
               "clipRanges": [{"startSeconds": start, "endSeconds": end} for start, end in ranges]}
    if lane == "telegram":
        payload["telegramFile"] = {"fileId": "PRIVATE_FILE_ID", "fileSize": source.stat().st_size, "fileName": "Source.mp4"}
    else:
        payload["sourceUrl"] = "https://www.tiktok.com/@author/video/7578502470108777750" if lane == "direct" else "https://www.youtube.com/watch?v=abcdefghijk"
    return JobRunRequest.model_validate(payload)


class AlbumTelegram:
    def __init__(self, outcome="success"):
        self.outcome = outcome
        self.calls = 0
        self.ids = [901, 707, 808]

    async def send_chat_action(self, **_kwargs):
        return None

    async def send_media_group(self, *, chat_id, clips, probe, max_bytes):
        self.calls += 1
        assert chat_id == "123" and len(clips) in {2, 3}
        assert sum(metadata.size_bytes for _, metadata in clips) + 65_536 <= max_bytes <= 49_000_000
        assert all(path.is_file() for path, _ in clips)
        assert len(list(clips[0][0].parent.iterdir())) == len(clips) + 1
        if self.outcome in {"400", "429"}:
            raise TelegramApiError(ErrorCode.TELEGRAM_RATE_LIMITED if self.outcome == "429" else ErrorCode.TELEGRAM_UPLOAD_FAILED,
                                   status_code=int(self.outcome), retry_after=1)
        if self.outcome == "network":
            raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED, outcome="ambiguous")
        if self.outcome == "unexpected":
            raise OSError("response lost")
        ids = self.ids[:len(clips)]
        if self.outcome == "partial":
            ids = ids[:1]
        elif self.outcome == "duplicate":
            ids = [901] * len(clips)
        return [TelegramMessage(value, media_method="sendMediaGroup") for value in ids]

    async def send_media(self, **_kwargs):
        raise AssertionError("A pack must never fall back to individual media")

    async def send_document(self, **_kwargs):
        raise AssertionError("A pack must never fall back to documents")

    async def send_download_link(self, **_kwargs):
        raise AssertionError("A pack must never fall back to R2")


def install_source(settings, source, lane, ready_diagnostics, monkeypatch, telegram=None):
    settings.allowed_source_hosts |= frozenset({"www.tiktok.com"})
    service = DownloaderService(settings, telegram=telegram or AlbumTelegram(), dependency_provider=lambda _: ready_diagnostics)
    downloads = []
    probe = ProbeInfo(title="Pack source", extractor="tiktok" if lane == "direct" else "youtube", duration=8,
                      formats=[ProbeFormat(format_id="1", ext="mp4", vcodec="h264", acodec="aac", height=480, filesize=source.stat().st_size)])
    direct = DirectMedia(url="https://v16e.tiktokcdn.com/video.mp4", filename="clip-01.mp4", mime_type="video/mp4",
                         size_bytes=source.stat().st_size, duration=8, width=640, height=480, probe=probe)

    async def resolve(*_args, **_kwargs):
        return direct if lane == "direct" else None

    async def fetch(_source, target, **kwargs):
        if lane == "direct":
            assert kwargs["max_bytes"] == settings.max_source_download_bytes
        downloads.append(str(target))
        shutil.copyfile(source, target)
        if "workspace_size" in kwargs:
            kwargs["workspace_size"]()
        return source.stat().st_size

    async def probe_media(*_args, **_kwargs):
        return probe

    async def download(_request, _validated, workspace, *_args, **_kwargs):
        # This deliberately collides with the first final clip's name.
        output = workspace.child("clip-01.mp4")
        await fetch(None, output)
        return output

    monkeypatch.setattr(service, "_try_direct_media", resolve)
    monkeypatch.setattr(service, "_download", download)
    monkeypatch.setattr("downloader_container.service.probe_media", probe_media)
    monkeypatch.setattr("downloader_container.service.download_direct_media", fetch)
    monkeypatch.setattr("downloader_container.service.download_telegram_file", fetch)
    return service, downloads


def delivery_request(request, prepared, **changes):
    return JobDeliveryRequest.model_validate({
        "jobId": request.job_id, "telegramChatId": "123", "mode": "video", "deliveryMode": "telegram",
        "objectKey": prepared["objectKey"], "filename": prepared["filename"], "mimeType": prepared["mimeType"],
        "sizeBytes": prepared["sizeBytes"], "clipRanges": [item.model_dump(by_alias=True) for item in request.clip_ranges],
        **changes,
    })


@pytest.mark.asyncio
@pytest.mark.parametrize("source_media", ["640x480"], indirect=True)
@pytest.mark.parametrize("lane", ["yt-dlp", "direct", "telegram"])
@pytest.mark.parametrize("count", [2, 3])
async def test_pack_prepares_all_clips_once_in_submitted_order_then_sends_one_album(settings, source_media, ready_diagnostics, monkeypatch, lane, count):
    telegram = AlbumTelegram()
    service, downloads = install_source(settings, source_media, lane, ready_diagnostics, monkeypatch, telegram)
    request = request_for(source_media, lane, ((5, 7), (1, 3), (7, 10))[:count])
    cut_inputs = []

    async def capture_process(args, **kwargs):
        source = Path(args[args.index("-i") + 1])
        assert source.is_file()
        cut_inputs.append(source)
        assert args[args.index("-map") + 1] == "0:V:0"
        if lane == "telegram":
            assert args[args.index("-f") + 1] == "mov"
            assert args[args.index("-protocol_whitelist") + 1] == "file"
            assert args[args.index("-enable_drefs") + 1] == "0"
        return await run_process(args, **kwargs)

    monkeypatch.setattr("downloader_container.service.run_process", capture_process)
    prepared = await service.run(request)
    assert prepared["status"] == "prepared", prepared
    assert prepared["delivery"] == "telegram" and prepared["clipCount"] == count
    assert prepared["height"] == 360 and prepared["duration"] == pytest.approx(4 if count == 2 else 5, abs=0.1)
    directory = Path(settings.jobs_root) / request.job_id
    manifest_text = (directory / ".manifest.json").read_text()
    assert "PRIVATE_FILE_ID" not in manifest_text
    if request.source_url:
        assert request.source_url not in manifest_text
    manifest = json.loads(manifest_text)
    assert manifest["clipRanges"] == [item.model_dump(by_alias=True) for item in request.clip_ranges]
    assert {p.name for p in directory.iterdir()} == {".manifest.json", *(f"clip-{index:02d}.mp4" for index in range(1, count + 1))}
    assert len(cut_inputs) == count and len(set(cut_inputs)) == 1
    assert len(downloads) == 1 and not cut_inputs[0].exists()
    for index, record in enumerate(manifest["clips"], start=1):
        metadata = record["metadata"]
        assert metadata["firstVideoCodec"] == "h264" and metadata["firstAudioCodec"] == "aac"
        pixel = subprocess.run([settings.ffmpeg_path, "-v", "error", "-i", str(directory / metadata["filename"]),
                                "-frames:v", "1", "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
                               check=True, capture_output=True).stdout
        assert pixel[2 if index != 2 else 0] > 180
    if count == 3:
        from downloader_container.models import MediaMetadata

        last = MediaMetadata.model_validate(manifest["clips"][-1]["metadata"])
        assert last.trim_end_seconds == 8 and last.trim_end_clamped
        assert "Stopped at the end" in build_caption(ProbeInfo(title="Source"), last)
    assert await service.run(request) == prepared
    assert len(downloads) == 1 and len(cut_inputs) == count
    delivered = await service.deliver(delivery_request(request, prepared))
    assert delivered["status"] == "completed", delivered
    assert delivered["telegramMessageIds"] == [str(value) for value in telegram.ids[:count]]
    assert delivered["telegramMessageId"] == "901" and telegram.calls == 1
    assert not directory.exists()


@pytest.mark.asyncio
async def test_pack_does_not_upscale_a_lower_source(settings, source_media, ready_diagnostics, monkeypatch):
    service, _ = install_source(settings, source_media, "telegram", ready_diagnostics, monkeypatch)
    prepared = await service.run(request_for(source_media))
    assert prepared["status"] == "prepared" and prepared["height"] == 120


@pytest.mark.asyncio
@pytest.mark.parametrize("ranges", [((5, 10), (5, 12)), ((1, 3), (9, 10))])
async def test_all_effective_ranges_are_validated_before_any_encode(settings, source_media, ready_diagnostics, monkeypatch, ranges):
    service, downloads = install_source(settings, source_media, "telegram", ready_diagnostics, monkeypatch)

    async def no_encode(*_args, **_kwargs):
        raise AssertionError("Invalid ranges must fail before encoding")

    monkeypatch.setattr("downloader_container.service.run_process", no_encode)
    result = await service.run(request_for(source_media, ranges=ranges))
    assert result["status"] == "failed" and result["errorCode"] in {ErrorCode.INVALID_TIME_RANGE.value, ErrorCode.START_BEYOND_DURATION.value}
    assert len(downloads) == 1 and not (Path(settings.jobs_root) / "pack-job").exists()


def test_requested_duplicate_ranges_are_invalid(source_media):
    with pytest.raises(ValidationError):
        request_for(source_media, ranges=((1, 3), (1, 3)))


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["budget", "second_cut"])
async def test_any_pack_prepare_failure_removes_source_and_all_clips(settings, source_media, ready_diagnostics, monkeypatch, failure):
    service, _ = install_source(settings, source_media, "telegram", ready_diagnostics, monkeypatch)
    if failure == "budget":
        settings.telegram_upload_limit_bytes = 66_000
    else:
        async def fail_second(args, **kwargs):
            if Path(args[-1]).name.startswith("clip-02"):
                Path(args[-1]).write_bytes(b"partial")
                raise ProcessExecutionError(ProcessResult(tuple(args), 1, "", ""))
            return await run_process(args, **kwargs)

        monkeypatch.setattr("downloader_container.service.run_process", fail_second)
    result = await service.run(request_for(source_media))
    assert result["status"] == "failed", result
    assert result["errorCode"] == (ErrorCode.TELEGRAM_FILE_TOO_LARGE.value if failure == "budget" else ErrorCode.PROCESSING_FAILED.value)
    assert not (Path(settings.jobs_root) / "pack-job").exists()


@pytest.mark.asyncio
async def test_pack_resume_binds_order_source_height_and_file_bytes(settings, source_media, ready_diagnostics, monkeypatch):
    service, _ = install_source(settings, source_media, "telegram", ready_diagnostics, monkeypatch)
    request = request_for(source_media)
    prepared = await service.run(request)
    assert prepared["status"] == "prepared", prepared
    assert await service._resume_clip_pack(request.model_copy(update={"clip_ranges": list(reversed(request.clip_ranges))})) is None
    assert await service._resume_clip_pack(request.model_copy(update={"maximum_height": 480})) is None
    changed_source = request.telegram_file.model_copy(update={"file_id": "OTHER_FILE_ID"})
    assert await service._resume_clip_pack(request.model_copy(update={"telegram_file": changed_source})) is None
    assert service._resume_prepared(request.model_copy(update={"clip_ranges": None})) is None
    first = Path(settings.jobs_root) / "pack-job" / "clip-01.mp4"
    data = first.read_bytes()
    first.write_bytes(data[:-1] + bytes([data[-1] ^ 1]))
    assert await service._resume_clip_pack(request) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("mismatch", ["order", "single"])
async def test_delivery_cannot_consume_a_pack_as_single_or_reorder_it(settings, source_media, ready_diagnostics, monkeypatch, mismatch):
    telegram = AlbumTelegram()
    service, _ = install_source(settings, source_media, "telegram", ready_diagnostics, monkeypatch, telegram)
    request = request_for(source_media)
    prepared = await service.run(request)
    ranges = list(reversed([item.model_dump(by_alias=True) for item in request.clip_ranges])) if mismatch == "order" else None
    result = await service.deliver(delivery_request(request, prepared, clipRanges=ranges))
    assert result["status"] == "failed" and telegram.calls == 0
    assert not (Path(settings.jobs_root) / "pack-job").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["400", "429", "network", "partial", "duplicate", "unexpected"])
async def test_album_failures_never_retry_fall_back_or_accept_partial_receipts(settings, source_media, ready_diagnostics, monkeypatch, outcome):
    telegram = AlbumTelegram(outcome)
    service, _ = install_source(settings, source_media, "telegram", ready_diagnostics, monkeypatch, telegram)
    request = request_for(source_media)
    prepared = await service.run(request)
    result = await service.deliver(delivery_request(request, prepared))
    assert result["status"] == "failed" and telegram.calls == 1
    assert result["outcome"] == ("rejected" if outcome in {"400", "429"} else "ambiguous")
    assert "retryAfterSeconds" not in result and result["retryable"] is False
    assert not (Path(settings.jobs_root) / "pack-job").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("source_media", ["640x480"], indirect=True)
async def test_each_compressed_clip_is_renamed_before_the_next_compression(settings, source_media, ready_diagnostics, monkeypatch):
    settings.telegram_upload_limit_bytes = 65_536 + 2 * 30_000
    service, _ = install_source(settings, source_media, "telegram", ready_diagnostics, monkeypatch)
    compressed = []
    transcode = service._try_transcode

    async def record_compression(*args, **kwargs):
        output, metadata = await transcode(*args, **kwargs)
        compressed.append(output)
        if len(compressed) == 2:
            assert (Path(settings.jobs_root) / "pack-job" / "clip-01.mp4").is_file()
        return output, metadata

    monkeypatch.setattr(service, "_try_transcode", record_compression)
    result = await service.run(request_for(source_media))
    assert result["status"] == "prepared", result
    assert len(compressed) == 2
    manifest = json.loads((Path(settings.jobs_root) / "pack-job" / ".manifest.json").read_text())
    assert all(item["metadata"]["sizeBytes"] <= 30_000 for item in manifest["clips"])


@pytest.mark.asyncio
async def test_single_file_manifest_cannot_be_consumed_as_a_pack(settings, source_media, ready_diagnostics, monkeypatch):
    telegram = AlbumTelegram()
    service, _ = install_source(settings, source_media, "telegram", ready_diagnostics, monkeypatch, telegram)
    pack = request_for(source_media)
    prepared = await service.run(pack.model_copy(update={"clip_ranges": None}))
    assert prepared["status"] == "prepared", prepared
    assert await service._resume_clip_pack(pack) is None
    result = await service.deliver(delivery_request(pack, prepared))
    assert result["status"] == "failed" and telegram.calls == 0


@pytest.mark.asyncio
async def test_overlapping_distinct_ranges_keep_the_requested_order(settings, source_media, ready_diagnostics, monkeypatch):
    service, _ = install_source(settings, source_media, "telegram", ready_diagnostics, monkeypatch)
    request = request_for(source_media, ranges=((2, 5), (1, 4)))
    prepared = await service.run(request)
    assert prepared["status"] == "prepared" and prepared["duration"] == pytest.approx(6, abs=0.1)
    manifest = json.loads((Path(settings.jobs_root) / "pack-job" / ".manifest.json").read_text())
    assert [item["metadata"]["trimStartSeconds"] for item in manifest["clips"]] == [2, 1]


@pytest.mark.asyncio
async def test_direct_pack_resolver_uses_the_existing_trimmed_source_limit(settings, source_media, monkeypatch):
    service = DownloaderService(settings)
    limits = []

    async def resolve(*_args, **kwargs):
        limits.append(kwargs["max_bytes"])
        return None

    monkeypatch.setattr("downloader_container.service.resolve_direct_media", resolve)
    request = request_for(source_media, "direct")
    await service._try_direct_media(request, proxy_url="http://127.0.0.1:1")
    await service._try_direct_media(request.model_copy(update={"clip_ranges": None}), proxy_url="http://127.0.0.1:1")
    assert limits == [settings.max_source_download_bytes, min(settings.telegram_url_limit_bytes, settings.max_source_download_bytes)]

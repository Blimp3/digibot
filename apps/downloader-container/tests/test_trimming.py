from __future__ import annotations

import array
import asyncio
import json
import shutil
import subprocess
from pathlib import Path

import pytest
from pydantic import ValidationError

from downloader_container.direct_media import DirectMedia
from downloader_container.errors import DownloadError, ErrorCode
from downloader_container.ffprobe import verify_media
from downloader_container.models import JobRunRequest, MediaMode, PreferredFormat, ProbeFormat, ProbeInfo
from downloader_container.probe import DownloadPlan
from downloader_container.process import ProcessExecutionError, ProcessResult, run_process
from downloader_container.security import validate_source_url
from downloader_container.service import DownloaderService
from downloader_container.telegram import build_caption
from downloader_container.workspace import JobWorkspace


def request(**changes):
    return JobRunRequest.model_validate({
        "jobId": "trim-test", "sourceUrl": "https://www.youtube.com/watch?v=abcdefghijk",
        "telegramChatId": "123", "waitingMessageId": 7, "mode": "audio",
        "preferredFormat": "m4a", "trimStartSeconds": 5, "trimEndSeconds": 7, **changes,
    })


@pytest.mark.parametrize("changes", [
    {"trimStartSeconds": None}, {"trimEndSeconds": None}, {"trimStartSeconds": True},
    {"trimStartSeconds": 1.5}, {"trimEndSeconds": "7"}, {"trimStartSeconds": -1},
    {"trimEndSeconds": 86401}, {"trimEndSeconds": 5}, {"trimEndSeconds": 4},
    {"mode": "video", "preferredFormat": "original"},
])
def test_invalid_trim_contract(changes):
    with pytest.raises(ValidationError):
        request(**changes)


@pytest.fixture
def source_media(tmp_path, settings, request):
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("real trimming checks require ffmpeg and ffprobe")
    settings.ffmpeg_path = shutil.which("ffmpeg")
    settings.ffprobe_path = shutil.which("ffprobe")
    source = tmp_path / "source.mp4"
    # A long GOP makes a seek to second 5 land between keyframes. Both picture
    # and tone change at second 4, so checking length alone cannot pass this test.
    subprocess.run([
        settings.ffmpeg_path, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"color=c=red:s={getattr(request, 'param', '160x120')}:r=25:d=8",
        "-f", "lavfi", "-i", "aevalsrc=sin(2*PI*if(lt(t\\,4)\\,440\\,880)*t):s=48000:d=8",
        "-vf", "drawbox=c=blue:t=fill:enable='gte(t,4)'", "-c:v", "libx264",
        "-g", "250", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", str(source),
    ], check=True, capture_output=True)
    return source


@pytest.mark.asyncio
@pytest.mark.parametrize(("mode", "fmt", "end"), [
    ("audio", "m4a", 7), ("audio", "mp3", 20), ("video", "mp4", 7), ("video", "mp4", 20),
])
async def test_real_cut_selects_requested_picture_and_audio(settings, source_media, mode, fmt, end):
    service = DownloaderService(settings)
    job = request(mode=mode, preferredFormat=fmt, trimEndSeconds=end)
    with JobWorkspace(settings.jobs_root, job.job_id, max_bytes=settings.max_temp_disk_bytes) as workspace:
        source = workspace.child("source.mp4")
        shutil.copyfile(source_media, source)
        metadata = await verify_media(source, ffprobe_path=settings.ffprobe_path, timeout_seconds=10, cwd=workspace.path)
        output, cut = await service._trim_media(job, source, metadata, workspace, title="Sample")
        assert cut.duration == pytest.approx(min(end, 8) - 5, abs=0.1)
        assert cut.trim_end_clamped is (end > 8)
        assert cut.trim_end_seconds == min(end, 8)
        assert cut.has_video is (mode == "video")
        assert cut.first_audio_codec == ("mp3" if fmt == "mp3" else "aac")
        assert not source.exists()
        pcm = subprocess.run([
            settings.ffmpeg_path, "-v", "error", "-i", str(output), "-t", "1",
            "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1",
        ], check=True, capture_output=True).stdout
        samples = array.array("h", pcm)
        crossings = sum(a <= 0 < b for a, b in zip(samples, samples[1:], strict=False))
        assert 860 <= crossings <= 900  # second 5 contains 880 Hz, not 440 Hz
        if mode == "video":
            pixel = subprocess.run([
                settings.ffmpeg_path, "-v", "error", "-i", str(output), "-frames:v", "1",
                "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
            ], check=True, capture_output=True).stdout
            assert pixel[2] > 180 and pixel[0] < 50
        caption = build_caption(ProbeInfo(title="Sample"), cut)
        assert "Clip: 00:00:05" in caption
        assert ("Stopped at the end" in caption) is (end > 8)
        fractional_end = cut.model_copy(update={"trim_end_seconds": 5.9, "trim_end_clamped": True})
        assert "Clip: 00:00:05–00:00:05.9" in build_caption(ProbeInfo(title="Sample"), fractional_end)


@pytest.mark.asyncio
@pytest.mark.parametrize("direct_lane", [False, True])
async def test_trim_prepare_stages_local_cut_and_resumes_same_range(settings, source_media, monkeypatch, ready_diagnostics, direct_lane):
    settings.allowed_source_hosts |= frozenset({"www.tiktok.com"})
    job = request(mode="video", preferredFormat="mp4", trimEndSeconds=20,
                  sourceUrl="https://www.tiktok.com/@author/video/7578502470108777750" if direct_lane else "https://www.youtube.com/watch?v=abcdefghijk")
    probe = ProbeInfo(id="sample", title="Sample", extractor="tiktok" if direct_lane else "youtube", duration=8,
                      formats=[ProbeFormat(format_id="1", ext="mp4", vcodec="h264", acodec="aac", filesize=source_media.stat().st_size, height=120)])
    direct = DirectMedia(url="https://v16e.tiktokcdn.com/video.mp4", filename="sample.mp4", mime_type="video/mp4",
                         size_bytes=source_media.stat().st_size, duration=8, width=160, height=120, probe=probe)

    async def resolve(*_args, **_kwargs):
        return direct if direct_lane else None

    async def probe_source(*_args, **_kwargs):
        return probe

    async def download_direct(_url, target, **_kwargs):
        shutil.copyfile(source_media, target)
        return source_media.stat().st_size

    sections: list[str | None] = []

    async def download(_request, _validated, workspace, *_args, download_sections=None, **_kwargs):
        sections.append(download_sections)
        output = workspace.child("source.mp4")
        if download_sections is None:
            shutil.copyfile(source_media, output)
        else:  # what yt-dlp's ffmpeg downloader does for a section
            start, end = (float(value) for value in download_sections.lstrip("*").split("-"))
            subprocess.run([settings.ffmpeg_path, "-v", "error", "-ss", str(start), "-t", str(end - start),
                            "-i", str(source_media), "-c", "copy", "-f", "mp4", str(output)], check=True)
        return output

    service = DownloaderService(settings)
    monkeypatch.setattr(service, "_try_direct_media", resolve)
    monkeypatch.setattr(service, "diagnostics", lambda: ready_diagnostics)
    monkeypatch.setattr(service, "_runtime", lambda: ("deno", "/usr/local/bin/deno"))
    monkeypatch.setattr(service, "_download", download)
    monkeypatch.setattr("downloader_container.service.probe_media", probe_source)
    monkeypatch.setattr("downloader_container.service.download_direct_media", download_direct)
    validated = validate_source_url(job.source_url, allowed_hosts=settings.allowed_source_hosts, resolve_dns=False)
    result = await service._run_active(job, validated, proxy_url="http://127.0.0.1:1")
    assert result["delivery"] == "telegram"
    assert result["duration"] == pytest.approx(3, abs=0.1)
    manifest = json.loads((Path(settings.jobs_root) / job.job_id / ".manifest.json").read_text())
    assert manifest["trimStartSeconds"] == 5 and manifest["trimEndSeconds"] == 20
    assert manifest["metadata"]["trimEndClamped"] is True
    assert "directUrl" not in manifest
    assert sections == ([] if direct_lane else ["*3.000-10.000"])
    # The stream-copied section starts on the only keyframe (0 s); second 5 must still be blue.
    pixel = subprocess.run([
        settings.ffmpeg_path, "-v", "error", "-i", str(Path(settings.jobs_root) / job.job_id / result["filename"]),
        "-frames:v", "1", "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
    ], check=True, capture_output=True).stdout
    assert pixel[2] > 180 and pixel[0] < 50
    assert service._resume_prepared(job) == result
    assert service._resume_prepared(request(trimEndSeconds=7)) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("section_outcome", ["webm", "failed", "truncated"])
async def test_trim_section_falls_back_to_full_source(settings, source_media, monkeypatch, ready_diagnostics, section_outcome):
    job = request(mode="video", preferredFormat="mp4", trimEndSeconds=7)
    probe = ProbeInfo(id="sample", title="Sample", extractor="youtube", duration=8,
                      formats=[ProbeFormat(format_id="1", ext="mp4", vcodec="h264", acodec="aac", filesize=1, height=120)])
    sections: list[str | None] = []

    async def probe_source(*_args, info_json, **_kwargs):
        info_json.write_text("{}", encoding="utf-8")
        return probe

    async def download(_request, _validated, workspace, *_args, download_sections=None, info_json=None, **_kwargs):
        sections.append(download_sections)
        assert info_json.is_file()
        if download_sections is None:
            output = workspace.child("source.mp4")
            shutil.copyfile(source_media, output)
            return output
        if section_outcome == "failed":
            workspace.child("partial.part").write_bytes(b"x")
            raise DownloadError(ErrorCode.DOWNLOAD_FAILED)
        if section_outcome == "truncated":  # yt-dlp exits 0 when ffmpeg stops early
            output = workspace.child("section.mp4")
            subprocess.run([settings.ffmpeg_path, "-v", "error", "-ss", "3", "-t", "3", "-i", str(source_media),
                            "-c", "copy", "-f", "mp4", str(output)], check=True)
            return output
        output = workspace.child("source.webm")  # non-MP4 sections start at a keyframe
        output.write_bytes(b"not exact")
        return output

    service = DownloaderService(settings)
    monkeypatch.setattr(service, "_try_direct_media", lambda *_args, **_kwargs: asyncio.sleep(0))
    monkeypatch.setattr(service, "diagnostics", lambda: ready_diagnostics)
    monkeypatch.setattr(service, "_runtime", lambda: ("deno", "/usr/local/bin/deno"))
    monkeypatch.setattr(service, "_download", download)
    monkeypatch.setattr("downloader_container.service.probe_media", probe_source)
    validated = validate_source_url(job.source_url, allowed_hosts=settings.allowed_source_hosts, resolve_dns=False)
    result = await service._run_active(job, validated, proxy_url="http://127.0.0.1:1")
    assert sections == ["*3.000-9.000", None]
    assert result["duration"] == pytest.approx(2, abs=0.1)
    assert sorted(child.name for child in (Path(settings.jobs_root) / job.job_id).iterdir()) == [".manifest.json", result["filename"]]


@pytest.mark.asyncio
@pytest.mark.parametrize("sections", ["*3.000-9.000", None])
async def test_youtube_section_refusal_retries_web_embedded_section(settings, monkeypatch, sections):
    # yt-dlp reports ffmpeg's 403 on a section only as "ffmpeg exited"; full downloads still fail fast.
    job = request(mode="video", preferredFormat="mp4", trimEndSeconds=7)
    calls: list[tuple[str, ...]] = []

    async def refused_then_ok(args, **_kwargs):
        calls.append(tuple(args))
        if len(calls) == 1:
            raise ProcessExecutionError(ProcessResult(tuple(args), 1, "", "ERROR: ffmpeg exited with code 1"))
        output = Path(args[args.index("--output") + 1]).parent / "section.mp4"
        output.write_bytes(b"media")
        return ProcessResult(tuple(args), 0, str(output), "")

    monkeypatch.setattr("downloader_container.service.run_process", refused_then_ok)
    validated = validate_source_url(job.source_url, allowed_hosts=settings.allowed_source_hosts, resolve_dns=False)
    plan = DownloadPlan(MediaMode.VIDEO, "best", PreferredFormat.MP4, 360)
    with JobWorkspace(settings.jobs_root, job.job_id, max_bytes=settings.max_temp_disk_bytes) as workspace:
        download = DownloaderService(settings)._download(
            job, validated, workspace, plan, "deno", "/usr/local/bin/deno",
            proxy_url="http://127.0.0.1:1", download_sections=sections,
        )
        if sections is None:
            with pytest.raises(DownloadError):
                await download
        else:
            assert (await download).parent.name == "youtube-web-embedded"
    assert len(calls) == (1 if sections is None else 2)
    if sections is not None:
        assert [call[call.index("--download-sections") + 1] for call in calls] == [sections, sections]
        assert "youtube:player_client=web_embedded" in calls[1]


@pytest.mark.asyncio
async def test_bad_cut_never_returns_full_source(settings, source_media, monkeypatch):
    service = DownloaderService(settings)
    with JobWorkspace(settings.jobs_root, "trim-test", max_bytes=settings.max_temp_disk_bytes) as workspace:
        source = workspace.child("source.mp4")
        shutil.copyfile(source_media, source)
        metadata = await verify_media(source, ffprobe_path=settings.ffprobe_path, timeout_seconds=10, cwd=workspace.path)
        for duration, code in [(5, ErrorCode.START_BEYOND_DURATION), (settings.max_duration_seconds + 1, ErrorCode.DURATION_LIMIT)]:
            with pytest.raises(DownloadError) as failure:
                await service._trim_media(request(), source, metadata.model_copy(update={"duration": duration}), workspace, title="Sample")
            assert failure.value.code == code
            assert source.exists()

        async def bad_verify(*_args, **_kwargs):
            return metadata  # truncated process accidentally retained the full duration

        monkeypatch.setattr("downloader_container.service.verify_media", bad_verify)
        with pytest.raises(DownloadError) as failure:
            await service._trim_media(request(), source, metadata, workspace, title="Sample")
        assert failure.value.code == ErrorCode.PROCESSING_FAILED
        assert source.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("source_media", ["1280x720"], indirect=True)
@pytest.mark.parametrize("lane", ["yt-dlp", "direct-over-cap", "direct-unknown", "direct-underreported"])
@pytest.mark.parametrize("trim", [False, True])
async def test_video_ceiling_scales_under_upload_limit_in_every_prepare_lane(
    settings, source_media, ready_diagnostics, monkeypatch, lane, trim,
):
    settings.allowed_source_hosts |= frozenset({"www.tiktok.com"})
    job = request(mode="video", preferredFormat="mp4", maximumHeight=360,
                  trimStartSeconds=5 if trim else None, trimEndSeconds=7 if trim else None,
                  sourceUrl="https://www.tiktok.com/@author/video/7578502470108777750" if lane != "yt-dlp" else "https://www.youtube.com/watch?v=abcdefghijk")
    probe = ProbeInfo(id="sample", title="Sample", extractor="tiktok" if lane != "yt-dlp" else "youtube", duration=8,
                      formats=[ProbeFormat(format_id="1", ext="mp4", vcodec="h264", acodec="aac", filesize=source_media.stat().st_size, height=480)])
    direct = DirectMedia(url="https://v16e.tiktokcdn.com/video.mp4", filename="sample.mp4", mime_type="video/mp4",
                         size_bytes=source_media.stat().st_size, duration=8, width=640,
                         height=None if lane == "direct-unknown" else 120 if lane == "direct-underreported" else 480, probe=probe)

    async def resolve(*_args, **_kwargs):
        return None if lane == "yt-dlp" else direct

    async def probe_source(*_args, **_kwargs):
        return probe

    async def download_direct(_url, target, **kwargs):
        assert kwargs["max_bytes"] == (settings.max_source_download_bytes if trim else min(
            settings.telegram_url_limit_bytes, settings.max_source_download_bytes
        ))
        shutil.copyfile(source_media, target)
        return source_media.stat().st_size

    async def download(_request, _validated, workspace, plan, *_args, **_kwargs):
        assert plan.maximum_height == 360
        assert "height<=?480" in plan.format_selector
        output = workspace.child("source.mp4")
        shutil.copyfile(source_media, output)
        return output

    service = DownloaderService(settings)
    monkeypatch.setattr(service, "_try_direct_media", resolve)
    monkeypatch.setattr(service, "diagnostics", lambda: ready_diagnostics)
    monkeypatch.setattr(service, "_runtime", lambda: ("deno", "/usr/local/bin/deno"))
    monkeypatch.setattr(service, "_download", download)
    monkeypatch.setattr("downloader_container.service.probe_media", probe_source)
    monkeypatch.setattr("downloader_container.service.download_direct_media", download_direct)
    validated = validate_source_url(job.source_url, allowed_hosts=settings.allowed_source_hosts, resolve_dns=False)
    assert source_media.stat().st_size < settings.telegram_upload_limit_bytes
    result = await service._run_active(job, validated, proxy_url="http://127.0.0.1:1")
    assert result["delivery"] == "telegram" and result["height"] == 360
    assert result["duration"] == pytest.approx(2 if trim else 8, abs=0.1)
    manifest_path = Path(settings.jobs_root) / job.job_id / ".manifest.json"
    manifest = json.loads(manifest_path.read_text())
    assert manifest["maximumHeight"] == 360 and "directUrl" not in manifest
    assert service._resume_prepared(job) == result
    assert service._resume_prepared(job.model_copy(update={"maximum_height": 480})) is None
    manifest["metadata"]["height"] = None
    manifest_path.write_text(json.dumps(manifest))
    assert service._resume_prepared(job) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("source_media", ["160x120", "640x480"], indirect=True)
async def test_size_fallback_retains_capped_encode_for_r2_without_upscaling(settings, source_media, monkeypatch):
    settings.telegram_upload_limit_bytes = 1  # Every real encode must use the R2 branch.
    service = DownloaderService(settings)
    job = request(mode="video", preferredFormat="mp4", maximumHeight=360,
                  trimStartSeconds=None, trimEndSeconds=None)

    async def fail_last_attempt(args, **kwargs):
        if args[args.index("-crf") + 1] == "35":
            raise ProcessExecutionError(ProcessResult(tuple(args), 1, "", "encoding failed"))
        return await run_process(args, **kwargs)

    monkeypatch.setattr("downloader_container.service.run_process", fail_last_attempt)
    with JobWorkspace(settings.jobs_root, job.job_id, max_bytes=settings.max_temp_disk_bytes) as workspace:
        source = workspace.child("source.mp4")
        shutil.copyfile(source_media, source)
        metadata = await verify_media(source, ffprobe_path=settings.ffprobe_path, timeout_seconds=10, cwd=workspace.path)
        output, encoded = await service._try_transcode(job, source, metadata, workspace)
        assert output.name == ("source.mp4" if metadata.height <= 360 else "transcoded-32.mp4")
        assert output.is_file()
        assert encoded.size_bytes > settings.telegram_upload_limit_bytes
        assert encoded.height == min(metadata.height, 360)
        assert source.is_file()
        assert not workspace.child("transcoded-28.mp4").exists()


@pytest.mark.asyncio
async def test_budget_capped_encode_fits_hard_content_on_the_first_attempt(settings, source_media, monkeypatch):
    # Noise defeats CRF alone: uncapped CRF 35 of this clip is ~400 kB.
    settings.telegram_upload_limit_bytes = 300_000
    service = DownloaderService(settings)
    job = request(mode="video", preferredFormat="mp4", maximumHeight=360, trimStartSeconds=None, trimEndSeconds=None)
    encodes: list[tuple[str, ...]] = []

    async def count_encodes(args, **kwargs):
        encodes.append(tuple(args))
        return await run_process(args, **kwargs)

    monkeypatch.setattr("downloader_container.service.run_process", count_encodes)
    with JobWorkspace(settings.jobs_root, job.job_id, max_bytes=settings.max_temp_disk_bytes) as workspace:
        source = workspace.child("source.mp4")
        subprocess.run([
            settings.ffmpeg_path, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=4,noise=alls=40:allf=t", "-f", "lavfi", "-i", "sine=d=4",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-pix_fmt", "yuv420p", "-c:a", "aac", str(source),
        ], check=True, capture_output=True)
        metadata = await verify_media(source, ffprobe_path=settings.ffprobe_path, timeout_seconds=10, cwd=workspace.path)
        output, encoded = await service._try_transcode(job, source, metadata, workspace)
    assert len(encodes) == 1 and "-maxrate" in encodes[0]
    assert output.name == "transcoded-28.mp4"
    assert encoded.size_bytes <= settings.telegram_upload_limit_bytes


@pytest.mark.asyncio
async def test_unknown_direct_height_uses_ffprobe_without_reencoding_a_fitting_source(settings, source_media, monkeypatch):
    job = request(mode="video", preferredFormat="mp4", maximumHeight=360,
                  trimStartSeconds=None, trimEndSeconds=None)
    direct = DirectMedia(url="https://v16e.tiktokcdn.com/video.mp4", filename="Sample.mp4", mime_type="video/mp4",
                         size_bytes=source_media.stat().st_size, duration=8, width=None, height=None,
                         probe=ProbeInfo(title="Sample", extractor="tiktok", duration=8))

    async def download_direct(_url, target, **_kwargs):
        shutil.copyfile(source_media, target)
        return source_media.stat().st_size

    async def no_encode(*_args, **_kwargs):
        raise AssertionError("A verified fitting MP4 needs no re-encoding")

    monkeypatch.setattr("downloader_container.service.download_direct_media", download_direct)
    monkeypatch.setattr("downloader_container.service.run_process", no_encode)
    service = DownloaderService(settings)
    validated = validate_source_url(job.source_url, allowed_hosts=settings.allowed_source_hosts, resolve_dns=False)
    with JobWorkspace(settings.jobs_root, job.job_id, max_bytes=settings.max_temp_disk_bytes) as workspace:
        result = await service._stage_direct_file(job, direct, validated, workspace, proxy_url="http://127.0.0.1:1")
        assert result["delivery"] == "telegram" and result["height"] == 120
        assert workspace.child(result["filename"]).read_bytes() == source_media.read_bytes()

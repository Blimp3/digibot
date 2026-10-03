from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from downloader_container.captions import MAX_CAPTION_BYTES, parse_captions, select_track, source_captions
from downloader_container.errors import DownloadError
from downloader_container.models import JobDeliveryRequest, JobRunRequest, ProbeInfo
from downloader_container.process import ProcessExecutionError, ProcessResult
from downloader_container.service import DownloaderService


def job(**changes):
    return JobRunRequest.model_validate({
        "jobId": "captions-test", "sourceUrl": "https://example.com/video",
        "telegramChatId": "123", "waitingMessageId": 1, "mode": "audio",
        "operation": "transcript", "transcriptMethod": "captions", **changes,
    })


def track(language="en", **changes):
    return {language: [{"url": "https://example.com/captions.vtt", "ext": "vtt", **changes}]}


def test_selection_provenance_and_language():
    probe = ProbeInfo(subtitles=track("en-GB"), automatic_captions={**track("en"), **track("fr", url="https://example.com/?tlang=fr")})
    assert select_track(ProbeInfo(subtitles=track(url="https://example.com/?kind=asr")), None)[1] == "Automatic captions"
    assert select_track(probe, None)[:2] == ("en-GB", "Publisher-provided captions")
    assert select_track(probe, "EN")[:2] == ("en", "Automatic captions")
    assert select_track(ProbeInfo(subtitles=track("en-GB")), "en")[0] == "en-GB"
    assert select_track(ProbeInfo(subtitles=track("en")), "en-US")[0] == "en"
    assert select_track(ProbeInfo(automatic_captions=track("en-orig")), None)[:2] == ("en", "Automatic captions")
    with pytest.raises(DownloadError) as error:
        select_track(probe, "fr")
    assert error.value.code == "CAPTION_LANGUAGE_UNAVAILABLE"
    assert "Available: en, en-GB." in error.value.safe_message
    with pytest.raises(DownloadError):
        select_track(ProbeInfo(subtitles=track("en-GB")), "en-US")
    with pytest.raises(DownloadError) as error:
        select_track(ProbeInfo(automatic_captions=track("fr", url="https://example.com/?tlang=fr")), None)
    assert error.value.code == "CAPTIONS_UNAVAILABLE"


@pytest.mark.parametrize("extension,content", [
    ("vtt", b"WEBVTT\n\n00:00.000 --> 00:01.000 align:start\n<v Speaker>Hello &amp; <b>world</b>\n\n00:00.500 --> 00:02.000\nHello &amp; world\n"),
    ("srt", b"1\r\n00:00:00,000 --> 00:00:02,000\r\nHello &amp; <b>world</b>\r\n"),
    ("json3", json.dumps({"events": [{"tStartMs": 0, "dDurationMs": 2000, "segs": [{"utf8": "Hello & world"}]}]}).encode()),
])
def test_normalizes_formats_and_duplicate_rolling_cues(extension, content):
    segments = parse_captions(content, extension, duration=3)
    assert len(segments) == 1
    assert segments[0].text == "Hello & world" and segments[0].start_seconds == 0 and segments[0].end_seconds == 2


@pytest.mark.parametrize("content", [
    b"not captions", b"WEBVTT\n\n00:02.000 --> 00:01.000\nWrong", b"WEBVTT\n\n00:03.000 --> 00:09.000\nWrong",
    b"WEBVTT\n\n00:00.000 --> 00:01.000\n\xff", b"WEBVTT\n\n00:00.000 --> 00:01.000\n\x00",
    b"x" * (MAX_CAPTION_BYTES + 1),
    b"WEBVTT\n\n00:01.000 --> 00:02.000\nA\n\n00:00.000 --> 00:01.000\nB",
])
def test_rejects_malformed_captions(content):
    with pytest.raises(DownloadError):
        parse_captions(content, "vtt", duration=3)


@pytest.mark.parametrize("changes", [
    {"operation": "download"}, {"transcriptMethod": "bad"}, {"transcriptMethod": "whisper", "captionLanguage": "en"},
    {"captionLanguage": "en\nInjected"}, {"captionLanguage": "x"}, {"trimStartSeconds": 0, "trimEndSeconds": 3},
])
def test_contract_rejects_incompatible_fields(changes):
    with pytest.raises(ValidationError):
        job(**changes)


@pytest.mark.asyncio
async def test_markdown_and_duration_bound(settings, tmp_path, monkeypatch):
    async def fetch(*args, **kwargs):
        return b"WEBVTT\n\n00:00.000 --> 00:02.000\nHello world"
    monkeypatch.setattr("downloader_container.captions.fetch_caption", fetch)
    probe = ProbeInfo(title="Test", extractor="youtube", duration=3, subtitles=track())
    document, preview = await source_captions(probe, tmp_path, language=None, proxy_url="http://proxy", settings=settings)
    assert "Method: Publisher-provided captions\nLanguage: en\n" in document.read_text()
    assert "[00:00:00.000] Hello world" in document.read_text()
    assert preview == "Publisher-provided captions · en\n\nHello world"
    for duration in (None, float("nan"), 0, 901):
        probe.duration = duration
        with pytest.raises(DownloadError):
            await source_captions(probe, tmp_path, language=None, proxy_url="http://proxy", settings=settings)


@pytest.mark.asyncio
async def test_caps_prepare_skips_media_and_binds_manifest(settings, ready_diagnostics, monkeypatch):
    service = DownloaderService(settings, dependency_provider=lambda _settings: ready_diagnostics)
    async def no_media(*args, **kwargs):
        pytest.fail("captions must not resolve or download full media")
    async def probe(args, **kwargs):
        assert "--ignore-no-formats-error" in args and "--proxy" in args
        return ProcessResult(tuple(args), 0, json.dumps({"title": "Caps", "extractor": "test", "duration": 3, "formats": [], "subtitles": track()}), "", False)
    async def fetch(*args, **kwargs):
        return b"WEBVTT\n\n00:00.000 --> 00:02.000\nHello"
    monkeypatch.setattr(service, "_try_direct_media", no_media)
    monkeypatch.setattr("downloader_container.probe.run_process", probe)
    monkeypatch.setattr("downloader_container.captions.fetch_caption", fetch)
    request = job(captionLanguage="en")
    result = await service.run(request)
    assert result["status"] == "prepared"
    assert service._resume_prepared(request) == result
    assert service._resume_prepared(job(captionLanguage="fr")) is None
    assert service._resume_prepared(job(transcriptMethod="whisper")) is None
    directory = Path(settings.jobs_root) / request.job_id
    assert {p.suffix for p in directory.iterdir()} == {".md", ".json"}
    manifest = json.loads((directory / ".manifest.json").read_text())
    assert manifest["transcriptMethod"] == "captions" and manifest["captionLanguage"] == "en"
    settings.job_operation = "transcript"
    assert service._resume_prepared(request) is None
    assert (await service.run(request))["errorCode"] == "INVALID_REQUEST"
    delivery = JobDeliveryRequest(jobId=request.job_id, telegramChatId="123", mode="audio", operation="transcript", transcriptMethod="captions", captionLanguage="en", objectKey=result["objectKey"], filename=result["filename"], mimeType=result["mimeType"])
    assert (await service.deliver(delivery))["errorCode"] == "INVALID_REQUEST"


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["download", "transcript"])
async def test_media_and_whisper_keep_strict_probe(settings, ready_diagnostics, monkeypatch, operation):
    settings.job_operation = operation
    service = DownloaderService(settings, dependency_provider=lambda _settings: ready_diagnostics)
    async def no_direct(*args, **kwargs):
        return None
    async def probe(args, **kwargs):
        assert "--ignore-no-formats-error" not in args
        raise ProcessExecutionError(ProcessResult(tuple(args), 1, "", "Sign in to confirm you are not a bot"))
    monkeypatch.setattr(service, "_try_direct_media", no_direct)
    monkeypatch.setattr("downloader_container.probe.run_process", probe)
    request = JobRunRequest(jobId="strict-probe", sourceUrl="https://example.com/video", telegramChatId="123", waitingMessageId=1, mode="audio", operation=operation)
    result = await service.run(request)
    assert result["errorCode"] == "LOGIN_REQUIRED"


@pytest.mark.asyncio
@pytest.mark.parametrize("scenario", [
    "ok", "http_initial", "http_redirect", "private_redirect", "translation",
    "query_flood", "too_large", "redirect_loop",
])
async def test_caption_fetch_bounds(settings, monkeypatch, scenario):
    import httpx

    from downloader_container.captions import fetch_caption

    calls = []
    real_client = httpx.AsyncClient

    def handler(request):
        calls.append(str(request.url))
        if scenario == "http_redirect":
            return httpx.Response(302, headers={"location": "http://example.com/captions"})
        if scenario == "private_redirect":
            return httpx.Response(302, headers={"location": "http://127.0.0.1/private"})
        if scenario == "translation":
            return httpx.Response(302, headers={"location": "https://example.com/captions?tlang=fr"})
        if scenario == "redirect_loop":
            return httpx.Response(302, headers={"location": "/loop"})
        if scenario == "too_large":
            return httpx.Response(200, content=b"x" * (MAX_CAPTION_BYTES + 1))
        return httpx.Response(200, content=b"WEBVTT")

    def client(**kwargs):
        assert kwargs["proxy"] == "http://proxy" and kwargs["trust_env"] is False
        return real_client(transport=httpx.MockTransport(handler))

    monkeypatch.setattr("downloader_container.captions.httpx.AsyncClient", client)
    if scenario == "ok":
        assert await fetch_caption("https://example.com/captions", proxy_url="http://proxy", settings=settings) == b"WEBVTT"
    else:
        initial_url = "http://example.com/captions" if scenario == "http_initial" else "https://example.com/captions"
        if scenario == "query_flood":
            initial_url += "?" + "&".join(f"key{i}=value" for i in range(101))
        with pytest.raises(DownloadError):
            await fetch_caption(initial_url, proxy_url="http://proxy", settings=settings)
        expected_calls = 6 if scenario == "redirect_loop" else 0 if scenario in {"http_initial", "query_flood"} else 1
        assert len(calls) == expected_calls


def test_caption_json_and_cue_bounds():
    for content in (b'{"events": [{"tStartMs": true, "dDurationMs": 10, "segs": []}]}', b'{"events": [{"tStartMs": 0, "dDurationMs": 1e999, "segs": [{"utf8":"x"}]}]}', b'{"events": "invalid"}'):
        with pytest.raises(DownloadError):
            parse_captions(content, "json3", duration=3)
    content = b"WEBVTT\n\n" + b"00:00.000 --> 00:01.000\nx\n\n" * 10001
    with pytest.raises(DownloadError):
        parse_captions(content, "vtt", duration=3)


def test_unclosed_tag_run_is_linear_and_preserved():
    text = "<" * 20_000
    content = f"WEBVTT\n\n00:00.000 --> 00:01.000\n{text}".encode()
    assert parse_captions(content, "vtt", duration=3)[0].text == text


def test_youtube_vtt_empty_initial_payload_line():
    content = b"WEBVTT\n\n00:00:00.160 --> 00:00:02.350 align:start position:0%\n\nPython<00:00:00.500> is great\n\n00:00:02.350 --> 00:00:02.360\nPython is great\n"
    segments = parse_captions(content, "vtt", duration=3)
    assert len(segments) == 1
    assert segments[0].text == "Python is great"
    assert segments[0].start_seconds == .160 and segments[0].end_seconds == 2.360


def test_vtt_blank_payload_accepts_the_cue_limit():
    content = b"WEBVTT\n\n" + b"00:00.000 --> 00:01.000\n\nx\n\n" * 10000
    assert parse_captions(content, "vtt", duration=3)[0].text == "x"
    with pytest.raises(DownloadError):
        parse_captions(content + b"00:00.000 --> 00:01.000\n\nx\n\n", "vtt", duration=3)


def test_empty_vtt_cue_does_not_consume_following_timing():
    content = b"WEBVTT\n\n00:00.000 --> 00:01.000\n\n00:01.000 --> 00:02.000\nSecond cue\n"
    segments = parse_captions(content, "vtt", duration=3)
    assert len(segments) == 1 and segments[0].start_seconds == 1
    assert segments[0].text == "Second cue"


@pytest.mark.parametrize("content", [
    b"WEBVTT\n\nOrphan text\n",
    b"WEBVTT\n\n00:00.000 --> 00:01.000\nText\n\nOrphan text\n",
    b"WEBVTT\n\n00:00.000 --> 00:01.000\n\ninvalid --> timestamp\nText\n",
])
def test_vtt_pending_payload_keeps_malformed_blocks_invalid(content):
    with pytest.raises(DownloadError):
        parse_captions(content, "vtt", duration=3)


@pytest.mark.parametrize("extension,content", [
    ("vtt", b"WEBVTT\n\n00:02:19.760 --> 00:02:25.160\nFinal words\n"),
    ("json3", json.dumps({"events": [{"tStartMs": 139760, "dDurationMs": 5400, "segs": [{"utf8": "Final words"}]}]}).encode()),
])
def test_source_display_tail_clips_at_duration(extension, content):
    segment, = parse_captions(content, extension, duration=143)
    assert segment.start_seconds == 139.760 and segment.end_seconds == 143


@pytest.mark.parametrize("start,length", [(-1, 1000), (143000, 1000), (144000, 1000), (1000, -1), (1000, 0), (float("nan"), 1000), (1000, float("inf"))])
def test_display_tail_clipping_keeps_invalid_times_rejected(start, length):
    content = json.dumps({"events": [{"tStartMs": start, "dDurationMs": length, "segs": [{"utf8": "Words"}]}]}).encode()
    with pytest.raises(DownloadError):
        parse_captions(content, "json3", duration=143)

from __future__ import annotations

import io
import json
import logging
from pathlib import Path

import pytest

from downloader_container.errors import (
    DownloadError,
    ErrorCode,
    ErrorStage,
    FailureReason,
    error_from_process_output,
)
from downloader_container.logging_utils import LOGGER, ProcessName, log_event
from downloader_container.models import JobRunRequest, MediaMetadata, ProbeFormat, ProbeInfo
from downloader_container.probe import probe_media
from downloader_container.process import ProcessExecutionError, ProcessResult
from downloader_container.service import DownloaderService


@pytest.fixture
def captured_events():
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    LOGGER.addHandler(handler)
    try:
        yield stream
    finally:
        LOGGER.removeHandler(handler)


def test_process_classifier_has_bounded_reason() -> None:
    blocked = error_from_process_output("ERROR: Sign in to confirm you are not a bot")
    assert blocked.code == ErrorCode.LOGIN_REQUIRED
    assert blocked.error_stage == ErrorStage.DOWNLOAD_PROCESS
    assert blocked.failure_reason == FailureReason.AUTH_REQUIRED

    tiktok_login = error_from_process_output(
        "ERROR: TikTok is requiring login for access to this content. Use --cookies-from-browser",
        probe=True,
    )
    assert tiktok_login.code == ErrorCode.LOGIN_REQUIRED
    assert tiktok_login.error_stage == ErrorStage.PROBE
    assert tiktok_login.failure_reason == FailureReason.AUTH_REQUIRED

    limited = error_from_process_output("ERROR: HTTP Error 429: Too Many Requests")
    assert limited.code == ErrorCode.SOURCE_RATE_LIMITED
    assert limited.failure_reason == FailureReason.SOURCE_RATE_LIMITED
    assert limited.retryable

    forbidden = error_from_process_output("ERROR: HTTP Error 403: Forbidden")
    assert forbidden.code == ErrorCode.DOWNLOAD_FAILED
    assert forbidden.failure_reason == FailureReason.HTTP_FORBIDDEN


@pytest.mark.parametrize(("output", "reason"), [
    ("ERROR: Requested format is not available", FailureReason.NO_FORMATS),
    ("WARNING: n challenge solving failed", FailureReason.JS_CHALLENGE_FAILED),
    ("ERROR: Unable to download webpage: Connection refused", FailureReason.NETWORK_ERROR),
    ("ERROR: Video unavailable", FailureReason.SOURCE_UNAVAILABLE),
    ("ERROR: Unsupported URL", FailureReason.UNSUPPORTED_SOURCE),
    ("ERROR: unrecognized provider failure", FailureReason.PROCESS_FAILED),
])
def test_probe_categories_preserve_public_failure(output, reason) -> None:
    failure = error_from_process_output(output + " https://private.invalid/?token=secret", probe=True)
    assert failure.code == ErrorCode.MEDIA_UNAVAILABLE
    assert failure.retryable is True
    assert failure.diagnostic_fields() == {"error_stage": "probe", "failure_reason": reason.value}
    assert "secret" not in json.dumps(failure.as_dict())


def test_diagnostic_response_fields_reject_unbounded_process_values() -> None:
    failure = DownloadError(ErrorCode.MEDIA_UNAVAILABLE, process_name="/private/token", process_exit_code=True)
    failure.process_timed_out = "secret"  # type: ignore[assignment]
    assert failure.diagnostic_fields() == {"error_stage": "probe", "failure_reason": "source_unavailable"}
    failure.process_exit_code = 2**32
    assert "process_exit_code" not in failure.diagnostic_fields()


@pytest.mark.asyncio
@pytest.mark.parametrize(("stdout", "reason"), [
    ("not JSON https://private.invalid/?token=secret", FailureReason.INVALID_PROBE_OUTPUT),
    ('{"id": [], "title": "secret", "formats": "invalid"}', FailureReason.INVALID_PROBE_METADATA),
])
async def test_invalid_probe_response_keeps_exit_status_without_output(settings, monkeypatch, tmp_path, stdout, reason) -> None:
    async def invalid_probe(args, **_kwargs):
        return ProcessResult(tuple(args), 0, stdout, "private stderr")

    monkeypatch.setattr("downloader_container.probe.run_process", invalid_probe)
    with pytest.raises(DownloadError) as caught:
        await probe_media(settings, "https://youtu.be/example", "deno", settings.deno_path, cwd=tmp_path)
    assert caught.value.code == ErrorCode.MEDIA_UNAVAILABLE
    assert caught.value.diagnostic_fields() == {
        "error_stage": "probe", "failure_reason": reason.value,
        "process_name": "yt-dlp", "process_exit_code": 0, "process_timed_out": False,
    }
    assert "secret" not in json.dumps(caught.value.diagnostic_fields())


@pytest.mark.asyncio
@pytest.mark.parametrize(("timed_out", "output_limited", "code", "reason"), [
    (False, False, "MEDIA_UNAVAILABLE", "no_formats"),
    (True, False, "DOWNLOAD_TIMEOUT", "timeout"),
    (False, True, "SOURCE_SIZE_LIMIT", "limit_exceeded"),
])
async def test_probe_failure_diagnostics_cross_preparation_response_safely(
    settings, ready_diagnostics, monkeypatch, captured_events, timed_out, output_limited, code, reason,
) -> None:
    async def failed_probe(args, **_kwargs):
        raise ProcessExecutionError(ProcessResult(
            tuple(args), -15 if timed_out else 1,
            "https://private.invalid/?token=secret",
            "ERROR: Requested format is not available; cookie=secret; private-title.mp4",
            timed_out=timed_out, output_limited=output_limited,
        ))

    monkeypatch.setattr("downloader_container.probe.run_process", failed_probe)
    service = DownloaderService(settings, dependency_provider=lambda _settings: ready_diagnostics)
    result = await service.run(JobRunRequest(
        jobId="job-probe-diagnostics", sourceUrl="https://youtu.be/example", telegramChatId="123",
        waitingMessageId=7, mode="video", maximumHeight=360, preferredFormat="mp4",
    ))
    assert result["status"] == "failed"
    assert result["errorCode"] == code
    assert result["diagnostics"] == {
        "error_stage": "probe", "failure_reason": reason, "process_name": "yt-dlp",
        "process_exit_code": -15 if timed_out else 1, "process_timed_out": timed_out,
    }
    failed = next(json.loads(line) for line in captured_events.getvalue().splitlines() if json.loads(line)["event"] == "job_failed")
    assert failed["failure_reason"] == reason
    serialized = json.dumps(result) + captured_events.getvalue()
    for private in ("private.invalid", "secret", "private-title.mp4", "cookie=", "telegram_chat_id"):
        assert private not in serialized


def test_structured_failure_log_is_redacted_and_enum_bounded(captured_events) -> None:
    raw_url = "https://www.youtube.com/watch?v=secret-video-id&token=do-not-log"
    log_event(
        "job_failed",
        job_id="job-safe",
        update_id="telegram-update-must-not-appear",
        source_host="youtube.com",
        source_url=raw_url,
        error_code=ErrorCode.DOWNLOAD_FAILED,
        error_stage=ErrorStage.DOWNLOAD_PROCESS,
        failure_reason=FailureReason.PROCESS_FAILED,
        process_name=ProcessName.YT_DLP,
        process_exit_code=1,
        process_timed_out=False,
        filename="private-title.mp4",
        title="Private title",
        stderr=f"ERROR for {raw_url}",
        exception="secret exception text",
        arbitrary="https://example.invalid/private",
    )

    payload = json.loads(captured_events.getvalue())
    serialized = captured_events.getvalue()
    assert payload["error_stage"] == ErrorStage.DOWNLOAD_PROCESS.value
    assert payload["failure_reason"] == FailureReason.PROCESS_FAILED.value
    assert payload["process_name"] == ProcessName.YT_DLP.value
    assert payload["process_exit_code"] == 1
    assert payload["process_timed_out"] is False
    assert "source_url_hash" not in payload
    assert "source_url" not in payload
    assert "update_id" not in payload
    assert "filename" not in payload
    assert "title" not in payload
    assert "stderr" not in payload
    assert "exception" not in payload
    assert "arbitrary" not in payload
    assert raw_url not in serialized
    assert "private-title.mp4" not in serialized
    assert "secret exception text" not in serialized


def test_invalid_diagnostic_enum_values_are_not_emitted(captured_events) -> None:
    log_event(
        "job_failed",
        error_code="DOWNLOAD_FAILED",
        error_stage="not-a-real-stage",
        failure_reason="not-a-real-reason",
        process_name="/tmp/custom-binary",
        process_exit_code=True,
        process_timed_out="yes",
    )

    payload = json.loads(captured_events.getvalue())
    assert payload["error_code"] == ErrorCode.DOWNLOAD_FAILED.value
    assert payload["error_stage"] == ErrorStage.INTERNAL.value
    assert payload["failure_reason"] == FailureReason.INTERNAL.value
    assert "process_name" not in payload
    assert "process_exit_code" not in payload
    assert "process_timed_out" not in payload


@pytest.mark.asyncio
async def test_download_failure_log_contains_safe_process_diagnostics(settings, ready_diagnostics, monkeypatch, captured_events) -> None:
    async def fake_probe(*_args, **_kwargs):
        return ProbeInfo(
            id="source-id",
            title="A private title",
            extractor="youtube",
            formats=[
                ProbeFormat(format_id="v", ext="mp4", height=360, vcodec="avc1", acodec="none", filesize=10),
            ],
        )

    async def failed_download(args, *, cwd, **_kwargs):
        assert Path(cwd).is_dir()
        raise ProcessExecutionError(
            ProcessResult(
                tuple(args),
                1,
                "https://www.youtube.com/watch?v=raw-url-must-not-log",
                "ERROR: private-title.mp4 https://www.youtube.com/watch?v=raw-url-must-not-log",
            )
        )

    monkeypatch.setattr("downloader_container.service.probe_media", fake_probe)
    monkeypatch.setattr("downloader_container.service.run_process", failed_download)
    service = DownloaderService(
        settings,
        dependency_provider=lambda _settings: ready_diagnostics,
    )
    result = await service.run(
        JobRunRequest(
            jobId="job-log-diagnostics",
            sourceUrl="https://youtu.be/example",
                telegramChatId="123",
            waitingMessageId=7,
            mode="video",
            maximumHeight=360,
            preferredFormat="mp4",
        )
    )

    assert result["status"] == "failed"
    payloads = [json.loads(line) for line in captured_events.getvalue().splitlines()]
    failed = next(payload for payload in payloads if payload["event"] == "job_failed")
    assert failed["error_stage"] == ErrorStage.DOWNLOAD_PROCESS.value
    assert failed["failure_reason"] == FailureReason.PROCESS_FAILED.value
    assert failed["process_name"] == ProcessName.YT_DLP.value
    assert failed["process_exit_code"] == 1
    assert failed["process_timed_out"] is False
    serialized = captured_events.getvalue()
    assert "raw-url-must-not-log" not in serialized
    assert "private-title.mp4" not in serialized
    assert '"telegram_chat_id"' not in serialized


@pytest.mark.asyncio
async def test_youtube_403_retries_once_with_web_embedded_client(settings, ready_diagnostics, monkeypatch, captured_events) -> None:
    async def fake_probe(*_args, info_json=None, **_kwargs):
        info_json.write_text("{}", encoding="utf-8")
        return ProbeInfo(
            id="source-id",
            title="A private title",
            extractor="youtube",
            formats=[
                ProbeFormat(format_id="v", ext="mp4", height=360, vcodec="avc1", acodec="none", filesize=10),
            ],
        )

    calls: list[tuple[str, ...]] = []

    async def retrying_download(args, *, cwd, **_kwargs):
        calls.append(tuple(args))
        if len(calls) == 1:
            raise ProcessExecutionError(
                ProcessResult(tuple(args), 1, "", "ERROR: HTTP Error 403: Forbidden")
            )
        output_template = Path(args[args.index("--output") + 1])
        assert output_template.parent == Path(cwd) / "youtube-web-embedded"
        output = output_template.parent / "safe-output.mp4"
        output.write_bytes(b"media")
        return ProcessResult(tuple(args), 0, str(output), "")

    async def fake_verify(path, **_kwargs):
        from downloader_container.models import MediaMetadata

        return MediaMetadata(
            filename=Path(path).name,
            mimeType="video/mp4",
            sizeBytes=5,
            duration=10,
            height=360,
            hasVideo=True,
            hasAudio=True,
        )

    monkeypatch.setattr("downloader_container.service.probe_media", fake_probe)
    monkeypatch.setattr("downloader_container.service.run_process", retrying_download)
    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    service = DownloaderService(settings, dependency_provider=lambda _settings: ready_diagnostics)
    result = await service.run(
        JobRunRequest(
            jobId="job-youtube-fallback",
            sourceUrl="https://www.youtube.com/watch?v=example",
            telegramChatId="123",
            waitingMessageId=7,
            mode="video",
            maximumHeight=360,
            preferredFormat="mp4",
        )
    )

    assert result["status"] == "prepared"
    assert len(calls) == 2
    job_dir = Path(settings.jobs_root) / "job-youtube-fallback"
    assert calls[0][calls[0].index("--load-info-json") + 1] == str(job_dir / ".probe.info.json")
    assert "https://www.youtube.com/watch?v=example" not in calls[0]
    assert not (job_dir / ".probe.info.json").exists()
    assert "--load-info-json" not in calls[1]
    assert "--extractor-args" in calls[1]
    assert Path(calls[0][calls[0].index("--output") + 1]).parent == Path(settings.jobs_root) / "job-youtube-fallback"
    assert Path(calls[1][calls[1].index("--output") + 1]).parent == Path(settings.jobs_root) / "job-youtube-fallback" / "youtube-web-embedded"
    extractor_index = calls[1].index("--extractor-args")
    assert calls[1][extractor_index + 1] == "youtube:player_client=web_embedded"
    assert calls[1][calls[1].index("--extractor-args") + 2] == "https://www.youtube.com/watch?v=example"
    payloads = [json.loads(line) for line in captured_events.getvalue().splitlines()]
    fallback = next(payload for payload in payloads if payload["event"] == "download_fallback_attempt")
    assert fallback["failure_reason"] == FailureReason.HTTP_FORBIDDEN.value
    assert fallback["fallback"] == "youtube_web_embedded"
    assert "https://www.youtube.com/watch?v=example" not in captured_events.getvalue()


@pytest.mark.asyncio
async def test_non_youtube_403_does_not_retry(settings, ready_diagnostics, monkeypatch) -> None:
    async def fake_probe(*_args, **_kwargs):
        return ProbeInfo(
            id="source-id",
            title="A title",
            extractor="example",
            formats=[ProbeFormat(format_id="v", ext="mp4", height=360, vcodec="avc1", acodec="none", filesize=10)],
        )

    calls = 0

    async def blocked_download(args, **_kwargs):
        nonlocal calls
        calls += 1
        raise ProcessExecutionError(ProcessResult(tuple(args), 1, "", "HTTP Error 403: Forbidden"))

    monkeypatch.setattr("downloader_container.service.probe_media", fake_probe)
    monkeypatch.setattr("downloader_container.service.run_process", blocked_download)
    service = DownloaderService(settings, dependency_provider=lambda _settings: ready_diagnostics)
    result = await service.run(
        JobRunRequest(
            jobId="job-non-youtube-fallback",
            sourceUrl="https://example.com/video",
            telegramChatId="123",
            waitingMessageId=7,
            mode="video",
            maximumHeight=360,
            preferredFormat="mp4",
        )
    )

    assert result["status"] == "failed"
    assert calls == 1


@pytest.mark.asyncio
async def test_operation_timers_log_safe_success_and_failure_events(settings, ready_diagnostics, monkeypatch, captured_events) -> None:
    async def fake_probe(*_args, **_kwargs):
        return ProbeInfo(
            id="source-id",
            title="A private title",
            extractor="example",
            formats=[
                ProbeFormat(format_id="v", ext="mp4", height=360, vcodec="avc1", acodec="none", filesize=10),
                ProbeFormat(format_id="a", ext="m4a", acodec="mp4a", abr=96, filesize=10),
            ],
        )

    async def fake_download(args, *, cwd, **_kwargs):
        output = Path(cwd) / "safe-output.mp4"
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
    monkeypatch.setattr("downloader_container.service.run_process", fake_download)
    monkeypatch.setattr("downloader_container.service.verify_media", fake_verify)
    service = DownloaderService(settings, dependency_provider=lambda _settings: ready_diagnostics)
    prepared = await service.run(
        JobRunRequest(
            jobId="job-timer-success",
            sourceUrl="https://example.com/video",
            telegramChatId="123",
            waitingMessageId=7,
            mode="video",
            maximumHeight=360,
            preferredFormat="mp4",
        )
    )
    assert prepared["status"] == "prepared"

    async def failed_probe(*_args, **_kwargs):
        raise DownloadError(ErrorCode.MEDIA_UNAVAILABLE)

    monkeypatch.setattr("downloader_container.service.probe_media", failed_probe)
    failed = await service.run(
        JobRunRequest(
            jobId="job-timer-failure",
            sourceUrl="https://example.com/video",
            telegramChatId="123",
            waitingMessageId=7,
            mode="video",
        )
    )
    assert failed["status"] == "failed"

    events = [json.loads(line) for line in captured_events.getvalue().splitlines()]
    success_probe = next(event for event in events if event["event"] == "probe_timing" and event.get("job_id") == "job-timer-success")
    success_download = next(event for event in events if event["event"] == "download_timing" and event.get("job_id") == "job-timer-success")
    failed_probe_event = next(event for event in events if event["event"] == "probe_timing" and event.get("job_id") == "job-timer-failure")
    for event in (success_probe, success_download, failed_probe_event):
        assert isinstance(event["operation_ms"], int)
        assert "source_url" not in event
        assert "title" not in event
    assert success_probe["state"] == "probing"
    assert success_download["state"] == "downloading"
    assert failed_probe_event["error_stage"] == ErrorStage.INTERNAL.value

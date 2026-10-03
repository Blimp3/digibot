from __future__ import annotations

import json

import httpx
import pytest
from pydantic import ValidationError

from downloader_container.models import JobDeliveryRequest, JobRunRequest, MediaMetadata, ProbeInfo
from downloader_container.service import DownloaderService
from downloader_container.telegram import TelegramClient
from downloader_container.workspace import JobWorkspace


def transcript_request(**changes):
    return JobRunRequest.model_validate({
        "jobId": "transcript-test", "sourceUrl": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        "telegramChatId": "123", "waitingMessageId": 7, "mode": "audio",
        "operation": "transcript", "preferredFormat": "m4a", **changes,
    })


@pytest.mark.parametrize("changes", [
    {"mode": "video", "preferredFormat": "mp4"},
    {"trimStartSeconds": 0, "trimEndSeconds": 5}, {"operation": "unknown"},
])
def test_transcript_contract_requires_full_source_audio(changes):
    with pytest.raises(ValidationError):
        transcript_request(**changes)


@pytest.mark.asyncio
@pytest.mark.parametrize("tamper", [False, True])
@pytest.mark.parametrize("method", ["whisper", "captions"])
async def test_transcript_resume_document_delivery_and_integrity(settings, tamper, method):
    settings.job_operation = "download" if method == "captions" else "transcript"
    sent = []

    async def handler(request):
        if request.url.path.endswith("/sendChatAction"):
            return httpx.Response(200, json={"ok": True, "result": True})
        assert request.url.path.endswith("/sendDocument")
        body = await request.aread()
        assert b'name="document"; filename="Zoo transcript.md"' in body
        assert b"[00:00:00] All right" in body
        assert b"Timestamped transcript" in body
        sent.append(request.url.path)
        return httpx.Response(200, json={"ok": True, "result": {
            "message_id": 99, "document": {"file_id": "transcript-file"},
        }})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        service = DownloaderService(settings, telegram=TelegramClient("token", client=http))
        job = transcript_request(transcriptMethod=method)
        with JobWorkspace(settings.jobs_root, job.job_id, max_bytes=settings.max_temp_disk_bytes) as workspace:
            document = workspace.child("Zoo transcript.md")
            document.write_text("# Zoo transcript\n\n[00:00:00] All right\n", encoding="utf-8")
            metadata = MediaMetadata(filename=document.name, mimeType="text/markdown",
                                     sizeBytes=document.stat().st_size, duration=19,
                                     transcriptPreview="[00:00:00] All right")
            prepared = await service._stage_telegram(job, document, metadata, ProbeInfo(title="Zoo", extractor="youtube"), workspace)
        assert service._resume_prepared(job) == prepared
        manifest = json.loads((document.parent / ".manifest.json").read_text())
        assert manifest["operation"] == "transcript" and len(manifest["transcriptSha256"]) == 64
        if tamper:
            document.write_text(document.read_text().replace("All right", "All wrong"))
            assert service._resume_prepared(job) is None
        delivery = JobDeliveryRequest(jobId=job.job_id, telegramChatId="123", mode="audio", operation="transcript", transcriptMethod=method,
                                      objectKey=prepared["objectKey"], filename=prepared["filename"],
                                      mimeType=prepared["mimeType"], sizeBytes=prepared["sizeBytes"])
        result = await service.deliver(delivery)
        assert result["status"] == ("failed" if tamper else "completed")
        assert len(sent) == (0 if tamper else 1)
        if not tamper:
            assert result["telegramMediaMethod"] == "sendDocument"
            assert result["telegramMessageId"] == "99"
            assert not document.parent.exists()


@pytest.mark.asyncio
async def test_downloader_rejects_transcript_before_source_fetch(settings):
    result = await DownloaderService(settings).run(transcript_request())
    assert result["status"] == "failed" and result["errorCode"] == "INVALID_REQUEST"


@pytest.mark.asyncio
async def test_transcript_stage_retains_only_verified_markdown(settings, monkeypatch, tmp_path):
    settings.job_operation = "transcript"
    real_jobs_root = tmp_path / "real-media-jobs"
    real_jobs_root.mkdir()
    jobs_root_alias = tmp_path / "media-jobs"
    jobs_root_alias.symlink_to(real_jobs_root, target_is_directory=True)
    settings.jobs_root = str(jobs_root_alias)
    service = DownloaderService(settings)
    job = transcript_request()

    with JobWorkspace(settings.jobs_root, job.job_id, max_bytes=settings.max_temp_disk_bytes) as workspace:
        source = workspace.child("source.m4a")
        source.write_bytes(b"verified source")
        workspace.child("download.part").write_bytes(b"partial")
        fallback = workspace.child("fallback")
        fallback.mkdir()
        (fallback / "partial.webm").write_bytes(b"partial")
        outside = workspace.root.parent / "outside.txt"
        outside.write_text("keep", encoding="utf-8")
        workspace.child("linked-partial").symlink_to(outside)

        async def fake_transcribe(audio_path, output_dir, **_kwargs):
            assert audio_path == source and output_dir == workspace.path
            document = output_dir / "Zoo transcript.md"
            document.write_text("# Zoo transcript\n\n[00:00:00] All right\n", encoding="utf-8")
            return document, "[00:00:00] All right"

        monkeypatch.setattr("downloader_container.transcription.transcribe_audio", fake_transcribe)
        metadata = MediaMetadata(
            filename=source.name, mimeType="audio/mp4", sizeBytes=source.stat().st_size,
            duration=19, hasAudio=True,
        )
        prepared = await service._stage_transcript(
            job, source, metadata, ProbeInfo(title="Zoo", extractor="youtube"), workspace,
        )

    staged = workspace.path
    assert {path.name for path in staged.iterdir()} == {".manifest.json", "Zoo transcript.md"}
    assert outside.read_text(encoding="utf-8") == "keep"
    assert service._resume_prepared(job) == prepared

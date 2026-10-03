from __future__ import annotations

import json
import os
import shutil
import struct
import wave
from pathlib import Path

import pytest

from downloader_container.config import Settings
from downloader_container.deadline import JobDeadline, JobDeadlineExceeded
from downloader_container.errors import DownloadError, ErrorCode
from downloader_container.process import ProcessResult
from downloader_container.process import run_process as real_run_process
from downloader_container.transcription import parse_transcription_json, transcribe_audio


def _document(*segments: tuple[str, str, str]) -> str:
    return json.dumps(
        {
            "transcription": [
                {"timestamps": {"from": start, "to": end}, "text": text}
                for start, end, text in segments
            ]
        }
    )


def _wav(path: Path, pcm: bytes, *, channels=1, width=2, rate=16_000) -> None:
    with wave.open(str(path), "wb") as output:
        output.setparams((channels, width, rate, 0, "NONE", "not compressed"))
        output.writeframes(pcm)


def test_parse_transcription_json_returns_bounded_monotonic_segments() -> None:
    segments = parse_transcription_json(
        _document(
            ("00:00:00,000", "00:00:01,250", " Hello\nworld. "),
            ("00:00:01,250", "00:00:02,500", "Second segment."),
        ),
        duration=2.5,
    )

    assert [(segment.start_seconds, segment.end_seconds, segment.text) for segment in segments] == [
        (0.0, 1.25, "Hello world."),
        (1.25, 2.5, "Second segment."),
    ]


@pytest.mark.parametrize(
    ("document", "duration"),
    [
        (_document(("00:00:01,000", "00:00:00,900", "backwards")), 2),
        (_document(("00:00:00,000", "00:00:01,000", "first"), ("00:00:00,900", "00:00:02,000", "overlap")), 2),
        (_document(("00:00:00,000", "00:00:02,000", "too long")), 1),
        (_document(("00:00:00", "00:00:01,000", "bad format")), 2),
        (_document(("00:00:00,000", "00:00:01,000", "bad\x01text")), 2),
    ],
)
def test_parse_transcription_json_rejects_invalid_segments(document: str, duration: float) -> None:
    with pytest.raises(DownloadError) as failure:
        parse_transcription_json(document, duration=duration)
    assert failure.value.code == ErrorCode.PROCESSING_FAILED


@pytest.mark.asyncio
async def test_transcribe_audio_converts_locally_and_writes_bounded_markdown(tmp_path, monkeypatch, settings):
    source = tmp_path / "source.m4a"
    source.write_bytes(b"verified audio")
    output_dir = tmp_path / "job"
    fixture_json = _document(
        ("00:00:00,000", "00:00:01,200", "Alpha river."),
        ("00:00:01,200", "00:00:03,000", "Copper meadow."),
    )
    process_calls = []

    async def fake_run_process(args, **kwargs):
        args = tuple(str(item) for item in args)
        process_calls.append((args, kwargs))
        if args[0] == settings.ffmpeg_path:
            _wav(Path(args[-1]), b"\x01\x00" * 48_000)
        else:
            base = Path(args[args.index("--output-file") + 1])
            base.with_suffix(".json").write_text(fixture_json, encoding="utf-8")
        return ProcessResult(args, 0, "", "")

    settings.whisper_path = "/usr/local/bin/whisper-cli"
    settings.whisper_model_path = "/opt/whisper/ggml-small.bin"
    settings.whisper_threads = 2
    monkeypatch.setattr("downloader_container.transcription.run_process", fake_run_process)

    path, caption = await transcribe_audio(
        source,
        output_dir,
        title="../A\nTitle",
        source="YouTube",
        duration=3,
        settings=settings,
    )

    assert path == output_dir / "A_Title.md"
    assert path.read_text(encoding="utf-8") == (
        "# ../A Title\n\n"
        "Source: YouTube\n"
        "Duration: 00:00:03.000\n\n"
        "Method: Automatic speech transcription (Whisper small)\n\n"
        "## Transcript\n\n"
        "[00:00:00.000] Alpha river.\n\n"
        "[00:00:01.200] Copper meadow.\n"
    )
    assert caption == "Alpha river. Copper meadow."
    assert len(caption) <= 600
    assert not list(output_dir.glob(".transcription-*"))
    assert process_calls[1][0][process_calls[1][0].index("--threads") + 1] == "2"
    assert process_calls[1][1]["cwd"] == Path(settings.whisper_path).parent


@pytest.mark.asyncio
@pytest.mark.parametrize("sample", [None, (0, 1), (0, -1), (16_000, 1), (16_000, -1), (32_000, 1), (32_000, -1)])
async def test_only_exact_zero_pcm_skips_whisper(tmp_path, monkeypatch, settings, sample):
    source = tmp_path / "source.flac"
    source.write_bytes(b"verified source")
    pcm = bytearray(32_001 * 2)
    if sample is not None:
        struct.pack_into("<h", pcm, sample[0] * 2, sample[1])
    calls = []
    speech = "Do not pay -12.50. L'acqua è fredda."

    async def fake_run_process(args, **kwargs):
        calls.append(args)
        if args[0] == settings.ffmpeg_path:
            _wav(Path(args[-1]), bytes(pcm))
        else:
            Path(args[-1]).with_suffix(".json").write_text(_document(("00:00:00,000", "00:00:02,000", speech)))
        return ProcessResult(tuple(args), 0, "", "")

    monkeypatch.setattr("downloader_container.transcription.run_process", fake_run_process)
    path, caption = await transcribe_audio(source, tmp_path / "out", title="Silence check", source="fixture",
                                          duration=32_001 / 16_000, settings=settings)
    markdown = path.read_text()
    if sample is None:
        assert len(calls) == 1 and caption == ""
        assert "Method: Digital silence check (Whisper skipped)" in markdown
        assert "_(No speech was detected.)_" in markdown
    else:
        assert len(calls) == 2 and caption == speech
        assert "Method: Automatic speech transcription (Whisper small)" in markdown
        assert calls[1][calls[1].index("--language") + 1] == "auto"
        assert "--output-json" in calls[1] and "--vad" not in calls[1]
    assert not list(path.parent.glob(".transcription-*"))


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", ["header", "empty", "stereo", "width", "rate", "truncated", "odd", "duration", "disk"])
async def test_invalid_converted_pcm_fails_before_whisper(tmp_path, monkeypatch, settings, fault):
    source = tmp_path / "source.flac"
    source.write_bytes(b"verified source")
    calls = []
    if fault == "disk":
        settings.max_temp_disk_bytes = 100

    async def fake_run_process(args, **kwargs):
        calls.append(args)
        assert args[0] == settings.ffmpeg_path
        wav = Path(args[-1])
        _wav(wav, b"\x00\x00" * (0 if fault == "empty" else 32_000),
             channels=2 if fault == "stereo" else 1, width=1 if fault == "width" else 2,
             rate=8_000 if fault == "rate" else 16_000)
        data = wav.read_bytes()
        if fault == "header":
            wav.write_bytes(b"not a WAV" + b"\x00" * 64)
        elif fault == "truncated":
            wav.write_bytes(data[:-1])
        elif fault == "odd":
            data = bytearray(data + b"\x00")
            struct.pack_into("<I", data, 4, len(data) - 8)
            struct.pack_into("<I", data, 40, len(data) - 44)
            wav.write_bytes(data)
        return ProcessResult(tuple(args), 0, "", "")

    monkeypatch.setattr("downloader_container.transcription.run_process", fake_run_process)
    with pytest.raises(DownloadError) as error:
        await transcribe_audio(source, tmp_path / "out", title="Invalid", source="fixture",
                               duration=0.5 if fault == "duration" else 2, settings=settings)
    assert error.value.code == (ErrorCode.SOURCE_SIZE_LIMIT if fault == "disk" else ErrorCode.PROCESSING_FAILED)
    assert len(calls) == 1
    assert not list((tmp_path / "out").iterdir())


@pytest.mark.asyncio
async def test_pcm_scan_obeys_deadline_and_cleans_up(tmp_path, monkeypatch, settings):
    source = tmp_path / "source.flac"
    source.write_bytes(b"verified source")
    deadline = JobDeadline.start(100)
    original = wave.Wave_read.readframes

    def expire_after_read(self, frames):
        result = original(self, frames)
        deadline.expires_at = 0
        return result

    async def fake_run_process(args, **kwargs):
        assert args[0] == settings.ffmpeg_path
        _wav(Path(args[-1]), b"\x01\x00" + b"\x00\x00" * 32_000)
        return ProcessResult(tuple(args), 0, "", "")

    monkeypatch.setattr(wave.Wave_read, "readframes", expire_after_read)
    monkeypatch.setattr("downloader_container.transcription.run_process", fake_run_process)
    with pytest.raises(JobDeadlineExceeded):
        await transcribe_audio(source, tmp_path / "out", title="Expired", source="fixture", duration=3,
                               settings=settings, deadline=deadline)
    assert not list((tmp_path / "out").iterdir())


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["zero", "opposite_channels", "below_pcm16", "quiet_with_gaps"])
async def test_silence_decision_applies_to_actual_ffmpeg_output(tmp_path, monkeypatch, settings, kind):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        pytest.skip("FFmpeg is required for the conversion boundary check")
    settings.ffmpeg_path = ffmpeg
    source = tmp_path / "source.wav"
    if kind == "opposite_channels":
        _wav(source, struct.pack("<hh", 100, -100) * 16_000, channels=2)
    elif kind == "below_pcm16":
        _wav(source, b"\x01\x00\x00" * 16_000, width=3)
    else:
        pcm = bytearray(32_000)
        if kind == "quiet_with_gaps":
            for frame in (100, 8_000, 15_900):
                struct.pack_into("<h", pcm, frame * 2, 1)
        _wav(source, bytes(pcm))
    whisper_calls = []

    async def process(args, **kwargs):
        if args[0] == ffmpeg:
            return await real_run_process(args, **kwargs)
        whisper_calls.append(args)
        Path(args[-1]).with_suffix(".json").write_text(_document(("00:00:00,000", "00:00:01,000", "Do not omit.")))
        return ProcessResult(tuple(args), 0, "", "")

    monkeypatch.setattr("downloader_container.transcription.run_process", process)
    path, caption = await transcribe_audio(source, tmp_path / "out", title="Conversion boundary", source="fixture",
                                          duration=1, settings=settings)
    assert len(whisper_calls) == int(kind == "quiet_with_gaps")
    assert caption == ("Do not omit." if kind == "quiet_with_gaps" else "")
    assert not list(path.parent.glob(".transcription-*"))


@pytest.mark.asyncio
async def test_local_small_fixture_engine(tmp_path):
    """Run the real engine when a benchmark fixture/model is explicitly supplied."""

    fixture = os.getenv("TRANSCRIPTION_FIXTURE_WAV")
    model = os.getenv("TRANSCRIPTION_MODEL_PATH")
    whisper = os.getenv("TRANSCRIPTION_WHISPER_PATH", "/opt/homebrew/bin/whisper-cli")
    ffmpeg = os.getenv("TRANSCRIPTION_FFMPEG_PATH", "/opt/homebrew/bin/ffmpeg")
    if not fixture or not model or not Path(fixture).is_file() or not Path(model).is_file():
        pytest.skip("set TRANSCRIPTION_FIXTURE_WAV and TRANSCRIPTION_MODEL_PATH for the local engine check")
    if not Path(whisper).is_file() or not Path(ffmpeg).is_file():
        pytest.skip("local whisper-cli and FFmpeg are unavailable")

    settings = Settings(
        ffmpeg_path=ffmpeg,
        whisper_path=whisper,
        whisper_model_path=model,
        whisper_threads=int(os.getenv("TRANSCRIPTION_THREADS", "1")),
        max_duration_seconds=7_200,
        max_source_download_bytes=500_000_000,
        max_temp_disk_bytes=1_000_000_000,
    )
    path, caption = await transcribe_audio(
        Path(fixture),
        tmp_path,
        title="Synthetic benchmark",
        source="local",
        duration=float(os.getenv("TRANSCRIPTION_FIXTURE_DURATION", "20.31")),
        settings=settings,
    )
    text = path.read_text(encoding="utf-8").lower()
    assert "alpha river" in text
    assert "cloudflare container" in text
    assert len(caption) <= 600

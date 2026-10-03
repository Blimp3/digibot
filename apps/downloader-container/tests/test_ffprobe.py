from __future__ import annotations

import json
import shutil
import subprocess

import pytest

from downloader_container.errors import DownloadError, ErrorCode
from downloader_container.ffprobe import telegram_input_demuxer, verify_media
from downloader_container.process import ProcessResult


@pytest.mark.asyncio
async def test_verify_media_reads_first_audio_codec_and_audio_only_metadata(tmp_path, monkeypatch):
    media = tmp_path / "audio.m4a"
    media.write_bytes(b"audio")

    async def fake_process(args, **_kwargs):
        return ProcessResult(
            tuple(str(item) for item in args),
            0,
            json.dumps(
                {
                    "streams": [{"codec_type": "audio", "codec_name": "aac"}],
                    "format": {"duration": "2.5", "format_name": "mov,mp4,m4a,3gp,3g2,mj2"},
                }
            ),
            "",
        )

    monkeypatch.setattr("downloader_container.ffprobe.run_process", fake_process)
    metadata = await verify_media(media, ffprobe_path="ffprobe", timeout_seconds=1)

    assert metadata.mime_type == "audio/mp4"
    assert metadata.size_bytes == 5
    assert metadata.has_audio is True
    assert metadata.has_video is False
    assert metadata.first_audio_codec == "aac"


@pytest.mark.asyncio
async def test_telegram_input_probe_forces_file_only_demuxer_and_mov_external_refs_off(tmp_path, monkeypatch):
    media = tmp_path / "telegram-input.bin"
    media.write_bytes(b"\x00\x00\x00\x18ftypisom" + b"\x00" * 32)

    async def fake_process(args, **_kwargs):
        assert args[args.index("-protocol_whitelist") + 1] == "file"
        assert args[args.index("-f") + 1] == "mov"
        assert args[args.index("-enable_drefs") + 1] == "0"
        assert args[args.index("-use_absolute_path") + 1] == "0"
        assert args[args.index("-max_streams") + 1] == "16"
        return ProcessResult(tuple(args), 0, json.dumps({
            "streams": [{
                "codec_type": "video", "codec_name": "h264", "width": 3840, "height": 2160,
                "avg_frame_rate": "60000/1001", "duration": "1",
            }],
            "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "1"},
        }), "")

    monkeypatch.setattr("downloader_container.ffprobe.run_process", fake_process)
    metadata = await verify_media(media, ffprobe_path="ffprobe", timeout_seconds=1, telegram_input=True)
    assert metadata.has_video and metadata.first_video_codec == "h264"
    assert metadata.mime_type == "video/mp4" and telegram_input_demuxer(metadata) == "mov"


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [
    b"#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n",
    b"ffconcat version 1.0\nfile /etc/passwd\n",
    b"<MPD><BaseURL>http://127.0.0.1/secret</BaseURL></MPD>",
    b"\x89PNG\r\n\x1a\n",
    b"PK\x03\x04archive",
    b"OggXspoof",
])
async def test_telegram_input_rejects_manifests_images_archives_and_spoofs_before_probe(
    tmp_path, monkeypatch, payload
):
    media = tmp_path / "telegram-input.bin"
    media.write_bytes(payload)
    called = False

    async def fake_process(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("untrusted manifest reached ffprobe")

    monkeypatch.setattr("downloader_container.ffprobe.run_process", fake_process)
    with pytest.raises(DownloadError) as caught:
        await verify_media(media, ffprobe_path="ffprobe", timeout_seconds=1, telegram_input=True)
    assert caught.value.code == ErrorCode.UNSUPPORTED_MEDIA and called is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation",
    ["streams", "duration", "dimension", "frame_rate", "channels", "sample_rate", "format"],
)
async def test_telegram_input_enforces_predecode_resource_ceilings(tmp_path, monkeypatch, mutation):
    media = tmp_path / "telegram-input.bin"
    media.write_bytes(b"OggS" + b"\x00" * 32)
    document = {
        "streams": [
            {"codec_type": "video", "codec_name": "vp9", "width": 1920, "height": 1080,
             "avg_frame_rate": "30/1", "duration": "1"},
            {"codec_type": "audio", "codec_name": "opus", "channels": 2, "sample_rate": "48000", "duration": "1"},
        ],
        "format": {"format_name": "ogg", "duration": "1"},
    }
    if mutation == "streams":
        document["streams"] = [
            {"codec_type": "audio", "codec_name": "opus", "channels": 2, "sample_rate": "48000", "duration": "1"}
            for _ in range(17)
        ]
    elif mutation == "duration":
        document["format"]["duration"] = "7201"
    elif mutation == "dimension":
        document["streams"][0]["width"] = 4096
    elif mutation == "frame_rate":
        document["streams"][0]["avg_frame_rate"] = "61/1"
    elif mutation == "channels":
        document["streams"][1]["channels"] = 9
    elif mutation == "sample_rate":
        document["streams"][1]["sample_rate"] = "192001"
    else:
        document["format"]["format_name"] = "hls"

    async def fake_process(args, **_kwargs):
        return ProcessResult(tuple(args), 0, json.dumps(document), "")

    monkeypatch.setattr("downloader_container.ffprobe.run_process", fake_process)
    with pytest.raises(DownloadError):
        await verify_media(media, ffprobe_path="ffprobe", timeout_seconds=1, telegram_input=True)


@pytest.mark.asyncio
async def test_telegram_input_accepts_portrait_uhd_at_60fps(tmp_path, monkeypatch):
    media = tmp_path / "telegram-input.bin"
    media.write_bytes(b"\x1aE\xdf\xa3" + b"\x00" * 32)

    async def fake_process(args, **_kwargs):
        return ProcessResult(tuple(args), 0, json.dumps({
            "streams": [{
                "codec_type": "video", "codec_name": "vp9", "width": 2160, "height": 3840,
                "avg_frame_rate": "60/1", "duration": "1",
            }],
            "format": {"format_name": "matroska,webm", "duration": "1"},
        }), "")

    monkeypatch.setattr("downloader_container.ffprobe.run_process", fake_process)
    metadata = await verify_media(media, ffprobe_path="ffprobe", timeout_seconds=1, telegram_input=True)
    assert (metadata.width, metadata.height) == (2160, 3840)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("name", "ffmpeg_args", "demuxer", "has_video", "has_audio"),
    [
        ("voice.ogg", ["-f", "lavfi", "-i", "sine=duration=0.25", "-c:a", "libopus"], "ogg", False, True),
        ("video.mp4", ["-f", "lavfi", "-i", "testsrc2=s=160x90:d=0.25", "-c:v", "libx264"], "mov", True, False),
        ("video.webm", ["-f", "lavfi", "-i", "testsrc2=s=160x90:d=0.25", "-c:v", "libvpx-vp9"], "matroska", True, False),
        ("audio.m4a", ["-f", "lavfi", "-i", "sine=duration=0.25", "-c:a", "aac"], "mov", False, True),
        ("audio.mp3", ["-f", "lavfi", "-i", "sine=duration=0.25", "-c:a", "libmp3lame"], "mp3", False, True),
        ("audio.wav", ["-f", "lavfi", "-i", "sine=duration=0.25", "-c:a", "pcm_s16le"], "wav", False, True),
        ("audio.flac", ["-f", "lavfi", "-i", "sine=duration=0.25", "-c:a", "flac"], "flac", False, True),
        ("video.ts", ["-f", "lavfi", "-i", "testsrc2=s=160x90:d=0.25", "-c:v", "mpeg2video"], "mpegts", True, False),
    ],
)
async def test_real_telegram_media_allowlist(name, ffmpeg_args, demuxer, has_video, has_audio, tmp_path):
    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        pytest.skip("real Telegram media check requires ffmpeg and ffprobe")
    generated = tmp_path / name
    process = subprocess.run(
        [ffmpeg, "-v", "error", "-y", *ffmpeg_args, str(generated)],
        capture_output=True,
        check=False,
    )
    if process.returncode:
        pytest.skip(f"local FFmpeg lacks the codec for {name}")
    media = tmp_path / "telegram-input.bin"
    generated.replace(media)
    metadata = await verify_media(media, ffprobe_path=ffprobe, timeout_seconds=5, telegram_input=True)
    assert telegram_input_demuxer(metadata) == demuxer
    assert metadata.has_video is has_video and metadata.has_audio is has_audio


@pytest.mark.asyncio
@pytest.mark.parametrize(("codec", "demuxer", "mime"), [
    ("mjpeg", "image2", "image/jpeg"), ("png", "png_pipe", "image/png"),
    ("gif", "gif", "image/gif"), ("webp", "webp_pipe", "image/webp"),
    ("bmp", "bmp_pipe", "image/bmp"), ("tiff", "tiff_pipe", "image/tiff"),
])
async def test_image_identity_comes_from_codec_and_demuxer(tmp_path, monkeypatch, codec, demuxer, mime):
    media = tmp_path / "misleading.mp4"
    media.write_bytes(b"image")

    async def fake_process(args, **_kwargs):
        return ProcessResult(tuple(args), 0, json.dumps({
            "streams": [{"codec_type": "video", "codec_name": codec, "width": 640, "height": 1280}],
            "format": {"format_name": demuxer},
        }), "")

    monkeypatch.setattr("downloader_container.ffprobe.run_process", fake_process)
    metadata = await verify_media(media, ffprobe_path="ffprobe", timeout_seconds=1)
    assert metadata.mime_type == mime and metadata.has_video is False
    assert metadata.height == 1280


@pytest.mark.asyncio
@pytest.mark.parametrize("suffix", ["jpg", "m4a"])
async def test_real_mp4_renamed_jpeg_cannot_bypass_video_height_limit(tmp_path, suffix):
    import shutil
    import subprocess

    from downloader_container.errors import DownloadError
    from downloader_container.service import DownloaderService

    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        pytest.skip("real spoofed image check requires ffmpeg and ffprobe")
    media = tmp_path / f"portrait.{suffix}"
    subprocess.run([ffmpeg, "-v", "error", "-f", "lavfi", "-i", "color=red:s=640x1280",
                    "-frames:v", "1", "-c:v", "libx264", "-f", "mp4", str(media)], check=True, capture_output=True)
    metadata = await verify_media(media, ffprobe_path=ffprobe, timeout_seconds=5)
    assert metadata.has_video is True and metadata.mime_type == "video/mp4"
    with pytest.raises(DownloadError):
        DownloaderService._validate_video_height(metadata, 360)


@pytest.mark.asyncio
@pytest.mark.parametrize(("suffix", "mime"), [("m4a", "audio/mp4"), ("mp3", "audio/mpeg")])
async def test_audio_cover_art_is_not_playable_video(tmp_path, monkeypatch, suffix, mime):
    media = tmp_path / f"audio.{suffix}"
    media.write_bytes(b"audio")

    async def fake_process(args, **_kwargs):
        return ProcessResult(tuple(args), 0, json.dumps({
            "streams": [
                {"codec_type": "video", "codec_name": "mjpeg", "height": 1280, "disposition": {"attached_pic": 1}},
                {"codec_type": "audio", "codec_name": "aac"},
            ],
            "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2"},
        }), "")

    monkeypatch.setattr("downloader_container.ffprobe.run_process", fake_process)
    metadata = await verify_media(media, ffprobe_path="ffprobe", timeout_seconds=1)
    assert metadata.mime_type == mime and metadata.has_audio is True
    assert metadata.has_video is False and metadata.height is None


@pytest.mark.asyncio
@pytest.mark.parametrize(("codec", "brand", "frames", "mime"), [
    ("av1", "avif", "1", "image/avif"),
    ("hevc", "heic", "1", "image/heic"),
    ("av1", "isom", "1", "video/mp4"),
    ("av1", "avif", "2", "video/mp4"),
    ("h264", "avif", "1", "video/mp4"),
])
async def test_iso_still_image_requires_matching_codec_brand_and_single_frame(tmp_path, monkeypatch, codec, brand, frames, mime):
    media = tmp_path / "media.avif"
    media.write_bytes(b"media")

    async def fake_process(args, **_kwargs):
        return ProcessResult(tuple(args), 0, json.dumps({
            "streams": [{"codec_type": "video", "codec_name": codec, "nb_frames": frames, "height": 1280}],
            "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "tags": {"major_brand": brand}},
        }), "")

    monkeypatch.setattr("downloader_container.ffprobe.run_process", fake_process)
    metadata = await verify_media(media, ffprobe_path="ffprobe", timeout_seconds=1)
    assert metadata.mime_type == mime
    assert metadata.has_video is (mime == "video/mp4")

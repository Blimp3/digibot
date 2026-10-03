from __future__ import annotations

import json

import pytest

from downloader_container.errors import DownloadError, ErrorCode
from downloader_container.formats import choose_telegram_video
from downloader_container.models import MediaMode, PreferredFormat, ProbeInfo
from downloader_container.probe import (
    DownloadPlan,
    build_download_args,
    build_probe_args,
    build_video_selector,
    parse_probe_json,
    runtime_argument,
    yt_dlp_common_args,
)


def _probe() -> ProbeInfo:
    return ProbeInfo.model_validate(
        {
            "id": "abc",
            "title": "A title",
            "extractor": "youtube",
            "duration": 12,
            "formats": [
                {
                    "format_id": "v1080",
                    "ext": "mp4",
                    "height": 1080,
                    "vcodec": "avc1",
                    "acodec": "none",
                    "filesize": 45_000_000,
                },
                {
                    "format_id": "v720",
                    "ext": "mp4",
                    "height": 720,
                    "vcodec": "avc1",
                    "acodec": "none",
                    "filesize": 20_000_000,
                },
                {
                    "format_id": "a",
                    "ext": "m4a",
                    "vcodec": "none",
                    "acodec": "mp4a",
                    "abr": 128,
                    "filesize": 2_000_000,
                },
            ],
        }
    )


def test_probe_json_and_playlist_rejection():
    info = parse_probe_json("notice\n" + json.dumps(_probe().model_dump()))
    assert info.id == "abc"
    with pytest.raises(DownloadError) as caught:
        parse_probe_json(json.dumps({"_type": "playlist", "entries": []}))
    assert caught.value.code == ErrorCode.PLAYLIST_NOT_ALLOWED


def test_image_only_probe_uses_image_plan_without_video_merge():
    probe = ProbeInfo(
        id="image-id",
        title="A photo",
        extractor="instagram",
        formats=[
            {
                "format_id": "image",
                "ext": "jpg",
                "width": 1600,
                "height": 900,
                "vcodec": "mjpeg",
                "acodec": "none",
                "filesize": 250_000,
            }
        ],
    )

    plan, choice = choose_telegram_video(probe, maximum_height=1080)

    assert plan.mode == MediaMode.VIDEO
    assert plan.output_kind == "image"
    assert plan.preferred_format == PreferredFormat.ORIGINAL
    assert plan.format_selector == "best"
    assert choice.extension == "jpg"
    assert choice.height == 900

    class S:
        yt_dlp_path = "/app/.venv/bin/yt-dlp"
        max_source_download_bytes = 500_000_000
        max_retries = 2

    args = build_download_args(
        S(), "https://www.instagram.com/p/example", "/tmp/job", plan, "deno", "/usr/local/bin/deno"
    )
    assert "--merge-output-format" not in args


def test_top_level_image_probe_is_normalized_for_planning():
    info = parse_probe_json(
        json.dumps(
            {
                "id": "image-id",
                "title": "A photo",
                "ext": "png",
                "width": 800,
                "height": 600,
                "url": "https://cdn.example/image.png",
            }
        )
    )

    assert len(info.formats) == 1
    assert info.formats[0].ext == "png"
    assert choose_telegram_video(info)[0].output_kind == "image"


def test_format_selection_falls_back_to_720p_for_estimated_telegram_limit():
    plan, choice = choose_telegram_video(_probe(), maximum_height=1080, max_bytes=46_000_000)
    assert choice.height == 720
    assert plan.maximum_height == 720
    assert "height<=?720" in plan.format_selector


@pytest.mark.parametrize("combined", [False, True])
def test_smaller_ceiling_downloads_smallest_available_larger_source_for_scaling(combined):
    probe = _probe()
    if combined:
        probe.formats = [fmt.model_copy(update={"acodec": "aac"}) for fmt in probe.formats if fmt.height]
    plan, choice = choose_telegram_video(probe, maximum_height=360)
    assert choice.height == 720
    assert plan.maximum_height == 360
    assert "height<=?720" in plan.format_selector


@pytest.mark.parametrize("ceiling", [144, 240])
def test_stricter_global_ceiling_below_360_is_retained(ceiling):
    plan, _choice = choose_telegram_video(_probe(), maximum_height=ceiling)
    assert plan.maximum_height == ceiling


@pytest.mark.parametrize("preferred_format", [PreferredFormat.MP4, PreferredFormat.ORIGINAL])
def test_video_selector_allows_unknown_heights_with_a_maximum(preferred_format):
    selector = build_video_selector(1080, preferred_format)

    assert "[height<=?1080]" in selector
    assert "[height<=1080]" not in selector


@pytest.mark.parametrize(
    ("preferred_format", "expected"),
    [
        (PreferredFormat.MP4, "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b"),
        (PreferredFormat.ORIGINAL, "bv*+ba/b"),
    ],
)
def test_video_selector_without_a_maximum_remains_unfiltered(preferred_format, expected):
    selector = build_video_selector(None, preferred_format)

    assert selector == expected


def test_yt_dlp_args_have_explicit_runtime_and_no_playlist():
    class S:
        yt_dlp_path = "/app/.venv/bin/yt-dlp"
        max_source_download_bytes = 500_000_000
        max_retries = 2

    args = build_probe_args(S(), "https://youtu.be/x", "deno", "/usr/local/bin/deno")
    assert "--no-playlist" in args
    assert "deno:/usr/local/bin/deno" in args
    assert args[-1] == "https://youtu.be/x"
    assert runtime_argument("deno", "/usr/local/bin/deno") == "deno:/usr/local/bin/deno"
    with pytest.raises(ValueError):
        runtime_argument("deno", "deno")


def test_max_filesize_is_decimal_bytes_in_common_probe_and_download(settings, tmp_path):
    plan = DownloadPlan(MediaMode.VIDEO, "best", PreferredFormat.ORIGINAL, None)
    common = yt_dlp_common_args(settings, "deno", "/usr/local/bin/deno")
    probe = build_probe_args(settings, "https://youtu.be/x", "deno", "/usr/local/bin/deno")
    download = build_download_args(
        settings,
        "https://youtu.be/x",
        tmp_path,
        plan,
        "deno",
        "/usr/local/bin/deno",
    )

    for args in (common, probe, download):
        size_index = args.index("--max-filesize") + 1
        assert args[size_index] == "500000000"


def test_yt_dlp_uses_connection_enforcing_proxy(settings):
    args = build_probe_args(
        settings,
        "https://youtu.be/x",
        "deno",
        "/usr/local/bin/deno",
        proxy_url="http://127.0.0.1:43123",
    )
    assert args[args.index("--proxy") + 1] == "http://127.0.0.1:43123"


@pytest.mark.parametrize(
    ("preferred_format", "expected_args"),
    [
        (PreferredFormat.M4A, ["--extract-audio", "--audio-format", "m4a"]),
        (PreferredFormat.MP3, ["--extract-audio", "--audio-format", "mp3"]),
    ],
)
def test_audio_download_uses_requested_conversion_format(settings, tmp_path, preferred_format, expected_args):
    plan = DownloadPlan(MediaMode.AUDIO, "bestaudio", preferred_format, None)
    args = build_download_args(
        settings,
        "https://youtu.be/x",
        tmp_path,
        plan,
        "deno",
        "/usr/local/bin/deno",
    )
    for expected in expected_args:
        assert expected in args
    assert "--embed-metadata" in args

"""Opt-in public-source smoke coverage; never runs in normal test jobs."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from downloader_container.config import Settings
from downloader_container.probe import build_probe_args, probe_media
from downloader_container.security import validate_source_url


@pytest.mark.live
@pytest.mark.skipif(
    os.getenv("RUN_LIVE_MEDIA_TESTS") != "1"
    or not os.getenv("LIVE_YOUTUBE_URL")
    or not os.getenv("LIVE_SECONDARY_URL"),
    reason="set RUN_LIVE_MEDIA_TESTS=1, LIVE_YOUTUBE_URL, and LIVE_SECONDARY_URL",
)
@pytest.mark.asyncio
async def test_opt_in_two_source_probe_uses_explicit_deno(tmp_path: Path) -> None:
    """Probe only caller-supplied URLs with the image's fixed Deno runtime."""

    settings = Settings.from_env()
    settings.max_retries = 0
    settings.probe_timeout_seconds = min(settings.probe_timeout_seconds, 90)
    runtime_path = settings.deno_path
    assert Path(runtime_path).is_absolute()
    assert Path(runtime_path).name == "deno"
    urls = (os.environ["LIVE_YOUTUBE_URL"], os.environ["LIVE_SECONDARY_URL"])
    for source_url in urls:
        validated = validate_source_url(
            source_url,
            allowed_hosts=settings.effective_allowed_source_hosts,
            resolve_dns=settings.resolve_source_dns,
            max_length=settings.max_url_length,
        )
        args = build_probe_args(settings, validated.normalized, "deno", runtime_path)
        assert all(isinstance(argument, str) for argument in args)
        assert args[args.index("--js-runtimes") + 1] == f"deno:{runtime_path}"
        probe = await probe_media(
            settings,
            validated.normalized,
            "deno",
            runtime_path,
            cwd=tmp_path,
        )
        assert probe.id
        assert probe.formats

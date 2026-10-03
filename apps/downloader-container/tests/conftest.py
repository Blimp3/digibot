from __future__ import annotations

import pytest

from downloader_container.config import Settings


@pytest.fixture
def settings(tmp_path):
    return Settings(
        internal_container_secret="test-internal-secret",
        telegram_bot_token="test-bot-token",
        allowed_source_hosts=frozenset({"youtube.com", "www.youtube.com", "youtu.be", "example.com"}),
        resolve_source_dns=False,
        jobs_root=str(tmp_path / "media-jobs"),
        deno_path="/usr/local/bin/deno",
    )


@pytest.fixture
def ready_diagnostics():
    return {
        "ready": True,
        "runtime": {"name": "deno", "path": "/usr/local/bin/deno", "version": "deno 2.8.3"},
        "binaries": {
            "yt-dlp": {"supported": True},
            "deno": {"supported": True},
            "yt-dlp-ejs": {"supported": True},
            "ffmpeg": {"supported": True},
            "ffprobe": {"supported": True},
        },
    }

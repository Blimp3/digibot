"""Bounded metadata-only YouTube collection snapshots; ordinary downloads stay single-item."""

from __future__ import annotations

import json
import re
import uuid
from typing import Literal
from urllib.parse import parse_qs, urlsplit

from pydantic import BaseModel, ConfigDict, Field

from .config import Settings
from .deadline import JobDeadline, activate_deadline
from .egress_proxy import PublicEgressProxy
from .errors import DownloadError, ErrorCode, error_from_process_output
from .probe import yt_dlp_common_args
from .process import ProcessExecutionError, run_process
from .security import validate_source_url
from .workspace import JobWorkspace


class YouTubeCollectionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    source_url: str = Field(alias="sourceUrl", min_length=1, max_length=2048)
    kind: Literal["playlist", "channel"]
    count: int = Field(default=3, strict=True, ge=1, le=5)


def youtube_collection_url(settings: Settings, request: YouTubeCollectionRequest) -> str:
    # Initial hosts are allowlisted here; the existing egress proxy resolves and
    # pins public addresses for every actual connection (including redirects).
    source = validate_source_url(request.source_url, allowed_hosts=settings.effective_allowed_source_hosts, resolve_dns=False)
    url = urlsplit(source.normalized)
    if url.hostname not in {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"} or "\\" in request.source_url:
        raise DownloadError(ErrorCode.INVALID_URL)
    if url.port is not None and url.port != (443 if url.scheme == "https" else 80):
        raise DownloadError(ErrorCode.INVALID_URL)
    if request.kind == "playlist":
        lists = parse_qs(url.query).get("list", [])
        if url.path not in {"/playlist", "/watch"} or len(lists) != 1 or not re.fullmatch(
            r"(?:PL[A-Za-z0-9_-]{10,100}|UU[A-Za-z0-9_-]{22}|OLAK5uy_[A-Za-z0-9_-]{10,100})", lists[0]
        ):
            raise DownloadError(ErrorCode.INVALID_URL)
        canonical = f"https://www.youtube.com/playlist?list={lists[0]}"
    else:
        path = url.path.removesuffix("/").removesuffix("/videos")
        # Known limit: ASCII handles/legacy names; other names use /channel/UC….
        if not re.fullmatch(r"/(?:@[A-Za-z0-9_.-]{3,30}|channel/UC[A-Za-z0-9_-]{22}|(?:c|user)/[A-Za-z0-9_.-]{1,100})", path):
            raise DownloadError(ErrorCode.INVALID_URL)
        canonical = f"https://www.youtube.com{path}/videos"
    return validate_source_url(canonical, allowed_hosts=settings.effective_allowed_source_hosts, resolve_dns=False).normalized


def parse_collection_json(stdout: str, count: int) -> list[str]:
    try:
        raw = json.loads(stdout)
    except ValueError:
        raise DownloadError(ErrorCode.MEDIA_UNAVAILABLE) from None
    if not isinstance(raw, dict) or raw.get("_type") != "playlist" or not isinstance(raw.get("entries"), list):
        raise DownloadError(ErrorCode.MEDIA_UNAVAILABLE)
    entries = raw["entries"]
    if not 1 <= count <= 5 or len(entries) > count:
        raise DownloadError(ErrorCode.SOURCE_SIZE_LIMIT)
    ids: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        video_id = entry.get("id")
        if not isinstance(video_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
            continue
        if entry.get("ie_key") not in {None, "Youtube"} or entry.get("_type") in {"playlist", "multi_video"} or "entries" in entry:
            continue
        if entry.get("availability") not in {None, "public", "unlisted"} or entry.get("is_live") is True or entry.get("live_status") in {"is_live", "is_upcoming", "was_live"}:
            continue
        if video_id not in ids:
            ids.append(video_id)
    if not ids:
        raise DownloadError(ErrorCode.MEDIA_UNAVAILABLE)
    return ids


async def resolve_collection(
    settings: Settings, request: YouTubeCollectionRequest, runtime_name: str, runtime_path: str, deadline_at: float | None,
) -> list[str]:
    source_url = youtube_collection_url(settings, request)
    deadline = JobDeadline.start(20) if deadline_at is None else JobDeadline.from_absolute(deadline_at, maximum_seconds=20)
    with activate_deadline(deadline), JobWorkspace(settings.jobs_root, f"collection-{uuid.uuid4()}", max_bytes=1_000_000) as workspace:
        async with PublicEgressProxy() as proxy:
            # A finite positive slice and flat extraction never visit individual
            # media or continue looking for replacements beyond the chosen slice.
            args = [arg for arg in yt_dlp_common_args(settings, runtime_name, runtime_path, proxy_url=proxy.url) if arg != "--no-playlist"]
            args.extend(["--yes-playlist", "--flat-playlist", "--lazy-playlist", "--playlist-items", f"1:{request.count}",
                         "--dump-single-json", "--skip-download", "--no-cache-dir", "--", source_url])
            try:
                result = await run_process(args, cwd=workspace.path, timeout_seconds=18, term_grace_seconds=1,
                                           max_stdout_bytes=256 * 1024, max_stderr_bytes=32 * 1024,
                                           resource_check=workspace.current_size)
            except ProcessExecutionError as exc:
                if exc.result.timed_out:
                    raise DownloadError(ErrorCode.DOWNLOAD_TIMEOUT) from None
                if exc.result.output_limited:
                    raise DownloadError(ErrorCode.SOURCE_SIZE_LIMIT) from None
                raise error_from_process_output(exc.result.stderr or exc.result.stdout, probe=True) from None
    return parse_collection_json(result.stdout, request.count)

"""Source subtitle tracks only: bounded metadata, fetch, normalization and Markdown."""

from __future__ import annotations

import asyncio
import html
import json
import math
import re
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urljoin, urlsplit

import httpx

from .config import Settings
from .direct_media import _request_bounded
from .errors import DownloadError, ErrorCode
from .models import ProbeInfo
from .security import sanitize_filename, validate_source_url
from .transcription import (
    DEFAULT_MAX_CAPTION_CHARS,
    DEFAULT_MAX_MARKDOWN_BYTES,
    DEFAULT_MAX_SEGMENTS,
    TranscriptSegment,
    _build_caption,
    _build_markdown,
    _display_text,
)

MAX_CAPTION_BYTES = 2_000_000
LANGUAGE_RE = re.compile(r"^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$")
TIMESTAMP_RE = re.compile(r"^(?:(\d{1,2}):)?([0-5]\d):([0-5]\d)[.,](\d{3})$")


def _invalid() -> DownloadError:
    return DownloadError(ErrorCode.PROCESSING_FAILED, detail="invalid source captions")


def select_track(probe: ProbeInfo, language: str | None) -> tuple[str, str, dict[str, Any]]:
    """Exact then base language; publisher tracks win within a language match."""
    candidates: list[tuple[str, str, dict[str, Any]]] = []
    for field, method in (("subtitles", "Publisher-provided captions"), ("automatic_captions", "Automatic captions")):
        tracks = getattr(probe, field, {})
        if not isinstance(tracks, dict) or len(tracks) > 500:
            continue
        for raw_language, formats in tracks.items():
            if not isinstance(raw_language, str):
                continue
            # yt-dlp marks the original automatic YouTube track with -orig.
            key = raw_language.removesuffix("-orig")
            if not LANGUAGE_RE.fullmatch(key) or not isinstance(formats, list) or len(formats) > 100:
                continue
            for track in formats:
                if not isinstance(track, dict) or track.get("ext") not in {"vtt", "srt", "json3"}:
                    continue
                url = track.get("url")
                if not isinstance(url, str) or len(url) > 8192:
                    continue
                try:
                    query = parse_qs(urlsplit(url).query, keep_blank_values=True, max_num_fields=100)
                except ValueError:
                    continue
                if "tlang" in query or track.get("is_translated") or track.get("translated"):
                    continue
                provenance = "Automatic captions" if "asr" in query.get("kind", []) or track.get("is_auto") is True else method
                candidates.append((key, provenance, track))
    if language:
        requested = language.lower()
        matching = [track for track in candidates if track[0].lower() == requested]
        if not matching:
            # A regional request may use a generic base track; a base request may
            # use a regional track. Never replace one explicit region with another.
            matching = [track for track in candidates if (
                track[0].lower() == requested.split("-")[0] if "-" in requested
                else track[0].lower().split("-")[0] == requested
            )]
    else:
        matching = candidates
    if not matching:
        languages = tuple(sorted({track[0] for track in candidates}, key=str.lower)[:12])
        raise DownloadError(
            ErrorCode.CAPTION_LANGUAGE_UNAVAILABLE if language and candidates else ErrorCode.CAPTIONS_UNAVAILABLE,
            available_languages=languages,
        )
    # Stable extractor order is retained within each provenance/format preference.
    return min(matching, key=lambda item: (item[1] == "Automatic captions", {"vtt": 0, "srt": 1, "json3": 2}[item[2]["ext"]]))


def _timestamp(value: str) -> float:
    match = TIMESTAMP_RE.fullmatch(value)
    if not match:
        raise _invalid()
    hours, minutes, seconds, millis = match.groups()
    return int(hours or 0) * 3600 + int(minutes) * 60 + int(seconds) + int(millis) / 1000


def parse_captions(content: bytes, extension: str, *, duration: float) -> tuple[TranscriptSegment, ...]:
    if not 0 < len(content) <= MAX_CAPTION_BYTES or not math.isfinite(duration) or not 0 < duration <= 900:
        raise _invalid()
    try:
        document = content.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
    except UnicodeDecodeError as exc:
        raise _invalid() from exc
    raw: list[tuple[float, float, str]] = []
    if extension == "json3":
        try:
            parsed = json.loads(document)
            events = parsed["events"]
            if not isinstance(events, list) or len(events) > DEFAULT_MAX_SEGMENTS:
                raise _invalid()
            for event in events:
                if not isinstance(event, dict):
                    raise _invalid()
                if "segs" not in event:
                    continue  # JSON3 window definitions are not speech cues.
                start, length = event.get("tStartMs"), event.get("dDurationMs")
                if isinstance(start, bool) or not isinstance(start, int | float) or isinstance(length, bool) or not isinstance(length, int | float):
                    raise _invalid()
                parts = event["segs"]
                if not isinstance(parts, list) or len(parts) > 10000 or any(not isinstance(part, dict) or not isinstance(part.get("utf8"), str) for part in parts):
                    raise _invalid()
                raw.append((start / 1000, (start + length) / 1000, "".join(part["utf8"] for part in parts)))
        except (ValueError, KeyError, TypeError) as exc:
            raise _invalid() from exc
    elif extension in {"vtt", "srt"}:
        blocks = re.split(r"\n[ \t]*\n", document.strip())
        if len(blocks) > 2 * DEFAULT_MAX_SEGMENTS + 100:
            raise _invalid()
        pending_vtt_payload = False
        for block in blocks:
            lines = block.splitlines()
            if not lines:
                continue
            if extension == "vtt" and (lines[0].startswith("WEBVTT") or lines[0] in {"STYLE", "REGION"} or lines[0].startswith("NOTE")):
                continue
            index = 0 if "-->" in lines[0] else 1
            if index >= len(lines) or "-->" not in lines[index]:
                # YouTube rolling VTT can place an empty first payload line
                # after the timing line. Attach only that cue's next text block.
                if pending_vtt_payload and "-->" not in block:
                    start, end, _ = raw[-1]
                    raw[-1] = (start, end, " ".join(lines))
                    pending_vtt_payload = False
                    continue
                raise _invalid()
            times = lines[index].split("-->")
            if len(times) != 2 or not times[1].split():
                raise _invalid()
            raw.append((_timestamp(times[0].strip()), _timestamp(times[1].split()[0]), " ".join(lines[index + 1:])))
            pending_vtt_payload = extension == "vtt" and not raw[-1][2].strip()
    else:
        raise _invalid()
    if len(raw) > DEFAULT_MAX_SEGMENTS:
        raise _invalid()
    segments: list[TranscriptSegment] = []
    previous_start = -1.0
    for start, end, text in raw:
        if not math.isfinite(start) or not math.isfinite(end) or start < previous_start or start < 0 or start >= duration or end <= start:
            raise _invalid()
        previous_start = start
        # Source caption display tails can outlast the video; clip their end,
        # while still rejecting cues that begin outside the source duration.
        end = min(end, duration)
        # Strip subtitle formatting/timestamp tags before entity decoding, keeping
        # escaped literal text intact. Cues may overlap for rolling auto captions.
        text = html.unescape(re.sub(r"<[^<>]*>", "", text))
        if any(ord(char) < 32 and char not in "\t\n\r" for char in text) or "\x7f" in text:
            raise _invalid()
        text = " ".join(text.split())
        if not text:
            continue
        if segments and start <= segments[-1].end_seconds and text == segments[-1].text:
            previous = segments[-1]
            segments[-1] = TranscriptSegment(previous.start_seconds, max(end, previous.end_seconds), text)
        else:
            segments.append(TranscriptSegment(start, end, text))
    if not segments:
        raise DownloadError(ErrorCode.CAPTIONS_UNAVAILABLE)
    return tuple(segments)


async def fetch_caption(url: str, *, proxy_url: str, settings: Settings) -> bytes:
    # The existing proxy resolves and pins every outbound destination. Validate
    # each redirect too; no cookie/header forwarding from extractor metadata.
    async with asyncio.timeout(min(60, settings.probe_timeout_seconds)), httpx.AsyncClient(
        proxy=proxy_url, trust_env=False, follow_redirects=False, timeout=20,
        headers={"Accept-Encoding": "identity"},
    ) as client:
        for _ in range(6):
            url = validate_source_url(url, resolve_dns=False, max_length=8192).normalized
            parsed_url = urlsplit(url)
            if parsed_url.scheme != "https":
                raise DownloadError(ErrorCode.CAPTIONS_UNAVAILABLE)
            try:
                query = parse_qs(parsed_url.query, keep_blank_values=True, max_num_fields=100)
            except ValueError as exc:
                raise DownloadError(ErrorCode.CAPTIONS_UNAVAILABLE) from exc
            if "tlang" in query:
                raise DownloadError(ErrorCode.CAPTIONS_UNAVAILABLE)
            try:
                response = await _request_bounded(client, "GET", url, max_bytes=MAX_CAPTION_BYTES)
            except httpx.HTTPError as exc:
                raise DownloadError(ErrorCode.DOWNLOAD_FAILED) from exc
            if response.status_code in {301, 302, 303, 307, 308}:
                location = response.headers.get("location")
                if not location:
                    raise DownloadError(ErrorCode.CAPTIONS_UNAVAILABLE)
                url = urljoin(url, location)
                continue
            if response.status_code != 200:
                raise DownloadError(ErrorCode.CAPTIONS_UNAVAILABLE)
            return response.content
    raise DownloadError(ErrorCode.CAPTIONS_UNAVAILABLE)


async def source_captions(probe: ProbeInfo, output_dir: Path, *, language: str | None, proxy_url: str, settings: Settings) -> tuple[Path, str]:
    duration = probe.duration
    if duration is None or not math.isfinite(duration) or duration <= 0:
        raise DownloadError(ErrorCode.UNSUPPORTED_MEDIA)
    if duration > 900:
        raise DownloadError(ErrorCode.DURATION_LIMIT)
    selected_language, method, track = select_track(probe, language)
    try:
        content = await fetch_caption(track["url"], proxy_url=proxy_url, settings=settings)
    except TimeoutError as exc:
        raise DownloadError(ErrorCode.DOWNLOAD_TIMEOUT, retryable=True) from exc
    segments = parse_captions(content, track["ext"], duration=duration)
    markdown = _build_markdown(
        title=_display_text(probe.title, fallback="Captions", max_length=180),
        source=_display_text(probe.extractor or "source", fallback="source", max_length=80),
        duration=duration, segments=segments, method=method, language=selected_language,
    ).encode("utf-8")
    if len(markdown) > DEFAULT_MAX_MARKDOWN_BYTES:
        raise DownloadError(ErrorCode.SOURCE_SIZE_LIMIT)
    output = output_dir / (sanitize_filename(probe.title, fallback="captions", max_length=120) + ".md")
    with output.open("xb") as document:
        document.write(markdown)
    prefix = f"{method} · {selected_language}\n\n"
    return output, prefix + _build_caption(segments=segments, limit=DEFAULT_MAX_CAPTION_CHARS - len(prefix))

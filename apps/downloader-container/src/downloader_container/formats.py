"""Deterministic yt-dlp format and Telegram-size selection."""

from __future__ import annotations

from dataclasses import dataclass

from .models import MediaMode, PreferredFormat, ProbeFormat, ProbeInfo
from .probe import (
    IMAGE_EXTENSIONS,
    DownloadPlan,
    build_video_selector,
)


@dataclass(frozen=True, slots=True)
class FormatChoice:
    height: int | None
    extension: str | None
    estimated_size: int | None
    video_format_id: str | None


def estimated_size(fmt: ProbeFormat) -> int | None:
    value = fmt.filesize or fmt.filesize_approx
    if value is None or value < 0:
        return None
    return int(value)


def _format_height(fmt: ProbeFormat) -> int:
    return fmt.height or 0


def _is_video(fmt: ProbeFormat) -> bool:
    # yt-dlp reports JPEG/PNG image streams with a video-like codec (for
    # example ``mjpeg``).  They are still image-only media and must not be
    # sent through the MP4 video selector.
    return bool(fmt.vcodec and fmt.vcodec != "none" and not _is_image(fmt))


def _is_audio(fmt: ProbeFormat) -> bool:
    return bool(fmt.acodec and fmt.acodec != "none")


def _is_image(fmt: ProbeFormat) -> bool:
    extension = (fmt.ext or "").lower().lstrip(".")
    return extension in IMAGE_EXTENSIONS and not _is_audio(fmt)


def _best_audio(formats: list[ProbeFormat], *, preferred_ext: str | None = None) -> ProbeFormat | None:
    audio = [fmt for fmt in formats if _is_audio(fmt) and not _is_video(fmt)]
    if preferred_ext:
        preferred = [fmt for fmt in audio if fmt.ext == preferred_ext]
        if preferred:
            audio = preferred
    return max(audio, key=lambda fmt: (fmt.abr or fmt.tbr or 0, estimated_size(fmt) or 0), default=None)


def _candidate_video_formats(probe: ProbeInfo, maximum_height: int | None) -> list[ProbeFormat]:
    values = [fmt for fmt in probe.formats if _is_video(fmt) and (maximum_height is None or _format_height(fmt) <= maximum_height)]
    # One representative format per height/ext; prefer MP4 for Telegram
    # because it can be sent with sendVideo after remux/merge.
    values.sort(key=lambda fmt: (_format_height(fmt), fmt.ext == "mp4", fmt.tbr or 0, estimated_size(fmt) or 0), reverse=True)
    seen: set[tuple[int, str | None]] = set()
    result: list[ProbeFormat] = []
    for fmt in values:
        key = (_format_height(fmt), fmt.ext)
        if key in seen:
            continue
        seen.add(key)
        result.append(fmt)
    return result


def _candidate_image_formats(probe: ProbeInfo) -> list[ProbeFormat]:
    return [fmt for fmt in probe.formats if _is_image(fmt)]


def _image_area(fmt: ProbeFormat) -> int:
    return (fmt.width or 0) * (fmt.height or 0)


def choose_image_format(probe: ProbeInfo, *, max_bytes: int | None = None) -> FormatChoice | None:
    """Choose a bounded image representation from an image-only probe."""

    candidates = _candidate_image_formats(probe)
    if not candidates:
        return None
    fits: list[ProbeFormat] = []
    if max_bytes is not None:
        for fmt in candidates:
            size = estimated_size(fmt)
            if size is not None and size <= max_bytes:
                fits.append(fmt)
    selected = max(fits or candidates, key=lambda fmt: (_image_area(fmt), estimated_size(fmt) or 0))
    return FormatChoice(
        selected.height,
        selected.ext,
        estimated_size(selected),
        selected.format_id,
    )


def choose_video_format(
    probe: ProbeInfo,
    *,
    maximum_height: int | None,
    preferred_format: PreferredFormat,
    max_bytes: int | None = None,
) -> FormatChoice:
    """Choose the best known candidate, preferring estimated-size fits."""

    candidates = _candidate_video_formats(probe, maximum_height)
    if not candidates:
        larger = _candidate_video_formats(probe, None)
        # Download the smallest available source and enforce the ceiling after
        # FFprobe; a source without a lower rendition still supports scaling.
        candidates = [min(larger, key=_format_height)] if larger else []
    audio = _best_audio(probe.formats, preferred_ext="m4a" if preferred_format == PreferredFormat.MP4 else None)
    if not candidates:
        return FormatChoice(None, None, None, None)

    choices: list[FormatChoice] = []
    for video in candidates:
        video_size = estimated_size(video)
        audio_size = estimated_size(audio) if audio else None
        total = video_size + audio_size if video_size is not None and audio_size is not None else None
        choices.append(
            FormatChoice(
                _format_height(video),
                video.ext,
                total,
                video.format_id,
            )
        )

    if max_bytes is not None:
        known_fits = [choice for choice in choices if choice.estimated_size is not None and choice.estimated_size <= max_bytes]
        if known_fits:
            return max(known_fits, key=lambda choice: choice.height or 0)
    return choices[0]


def telegram_height_candidates(maximum_height: int | None) -> list[int]:
    ceiling = min(maximum_height or 1080, 1080)
    return [height for height in (1080, 720, 480, 360) if height <= ceiling] or [ceiling]


def choose_telegram_video(
    probe: ProbeInfo,
    *,
    maximum_height: int | None = 1080,
    max_bytes: int = 49_000_000,
) -> tuple[DownloadPlan, FormatChoice]:
    # A Telegram default-video request may resolve to a public image-only
    # extractor result.  Keep the request mode unchanged, but use a dedicated
    # image plan so no video/audio merge is attempted.
    if not any(_is_video(fmt) for fmt in probe.formats):
        image = choose_image_format(probe, max_bytes=max_bytes)
        if image is not None:
            return (
                DownloadPlan(
                    MediaMode.VIDEO,
                    "best",
                    PreferredFormat.ORIGINAL,
                    None,
                    output_kind="image",
                ),
                image,
            )
    for height in telegram_height_candidates(maximum_height):
        choice = choose_video_format(
            probe,
            maximum_height=height,
            preferred_format=PreferredFormat.MP4,
            max_bytes=max_bytes,
        )
        if choice.estimated_size is None or choice.estimated_size <= max_bytes:
            selected_height = min(choice.height or height, height)
            return (
                DownloadPlan(
                    MediaMode.VIDEO,
                    build_video_selector(choice.height or height, PreferredFormat.MP4),
                    PreferredFormat.MP4,
                    selected_height,
                ),
                choice,
            )
    # The final result is still checked after download and may be transcoded or
    # moved to R2; selecting 360p is the safest bounded starting point.
    height = telegram_height_candidates(maximum_height)[-1]
    choice = choose_video_format(probe, maximum_height=height, preferred_format=PreferredFormat.MP4, max_bytes=None)
    return (
        DownloadPlan(MediaMode.VIDEO, build_video_selector(choice.height or height, PreferredFormat.MP4), PreferredFormat.MP4, height),
        choice,
    )


def choose_audio_plan(
    probe: ProbeInfo,
    *,
    preferred_format: PreferredFormat,
) -> tuple[DownloadPlan, FormatChoice]:
    audio = _best_audio(probe.formats, preferred_ext=preferred_format.value if preferred_format == PreferredFormat.M4A else None)
    size = estimated_size(audio) if audio else None
    choice = FormatChoice(None, audio.ext if audio else None, size, audio.format_id if audio else None)
    return DownloadPlan(MediaMode.AUDIO, "bestaudio[ext=m4a]/bestaudio/best", preferred_format, None), choice

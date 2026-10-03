from __future__ import annotations

import pytest
from pydantic import ValidationError

from downloader_container.models import JobDeliveryRequest, JobRunRequest, JobSuccess

RANGES = [
    {"startSeconds": 120, "endSeconds": 180},
    {"startSeconds": 30, "endSeconds": 90},
]


def _run(**changes: object) -> JobRunRequest:
    fields: dict[str, object] = {
        "jobId": "clip-pack",
        "sourceUrl": "https://example.com/video",
        "telegramChatId": "123",
        "waitingMessageId": 1,
        "mode": "video",
        "preferredFormat": "mp4",
        "clipRanges": RANGES,
    }
    fields.update(changes)
    return JobRunRequest(**fields)


def _delivery(**changes: object) -> JobDeliveryRequest:
    fields: dict[str, object] = {
        "jobId": "clip-pack",
        "telegramChatId": "123",
        "objectKey": "staged/clip-pack/clip-1.mp4",
        "filename": "clip-1.mp4",
        "mimeType": "video/mp4",
        "sizeBytes": 100,
        "mode": "video",
        "clipRanges": RANGES,
    }
    fields.update(changes)
    return JobDeliveryRequest(**fields)


def test_clip_ranges_preserve_submitted_order_for_url_and_telegram_sources() -> None:
    request = _run()
    assert [(clip.start_seconds, clip.end_seconds) for clip in request.clip_ranges or []] == [(120, 180), (30, 90)]
    assert request.model_dump(by_alias=True)["clipRanges"] == RANGES
    telegram = _run(sourceUrl=None, telegramFile={"fileId": "opaque", "fileSize": 1})
    assert telegram.clip_ranges == request.clip_ranges
    assert _delivery().model_dump(by_alias=True)["clipRanges"] == RANGES


def test_overlapping_distinct_ranges_and_maximum_total_are_valid() -> None:
    ranges = [
        {"startSeconds": 0, "endSeconds": 100},
        {"startSeconds": 50, "endSeconds": 150},
        {"startSeconds": 200, "endSeconds": 300},
    ]
    assert len(_run(clipRanges=ranges).clip_ranges or []) == 3
    assert len(_delivery(clipRanges=ranges).clip_ranges or []) == 3


@pytest.mark.parametrize(
    "ranges",
    [
        [{"startSeconds": 0, "endSeconds": 30}],
        [
            {"startSeconds": 0, "endSeconds": 30},
            {"startSeconds": 40, "endSeconds": 70},
            {"startSeconds": 80, "endSeconds": 110},
            {"startSeconds": 120, "endSeconds": 150},
        ],
        [{"startSeconds": 0, "endSeconds": 30}, {"startSeconds": 0, "endSeconds": 30}],
        [
            {"startSeconds": 0, "endSeconds": 101},
            {"startSeconds": 200, "endSeconds": 301},
            {"startSeconds": 400, "endSeconds": 501},
        ],
        [{"startSeconds": 0, "endSeconds": 121}, {"startSeconds": 200, "endSeconds": 210}],
        [{"startSeconds": 20, "endSeconds": 20}, {"startSeconds": 30, "endSeconds": 40}],
        [{"startSeconds": -1, "endSeconds": 20}, {"startSeconds": 30, "endSeconds": 40}],
        [{"startSeconds": 0, "endSeconds": 86401}, {"startSeconds": 30, "endSeconds": 40}],
        [{"startSeconds": True, "endSeconds": 20}, {"startSeconds": 30, "endSeconds": 40}],
        [{"startSeconds": 0, "endSeconds": 20, "extra": 1}, {"startSeconds": 30, "endSeconds": 40}],
    ],
)
def test_clip_range_shape_and_duration_limits_fail_closed(ranges: list[dict[str, object]]) -> None:
    with pytest.raises(ValidationError):
        _run(clipRanges=ranges)
    with pytest.raises(ValidationError):
        _delivery(clipRanges=ranges)


@pytest.mark.parametrize(
    "changes",
    [
        {"mode": "audio", "preferredFormat": "m4a"},
        {"operation": "transcript", "mode": "audio", "preferredFormat": "m4a"},
        {"trimStartSeconds": 0, "trimEndSeconds": 10},
        {"preferredFormat": "original"},
    ],
)
def test_prepare_clip_ranges_require_an_untrimmed_mp4_video_download(changes: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        _run(**changes)


@pytest.mark.parametrize(
    "changes",
    [
        {"mode": "audio"},
        {"operation": "transcript", "mode": "audio"},
        {"deliveryMode": "r2"},
    ],
)
def test_delivery_clip_ranges_require_direct_telegram_video(changes: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        _delivery(**changes)


def test_clip_count_is_bounded_and_only_marks_direct_telegram_prepares() -> None:
    fields = {"status": "prepared", "delivery": "telegram", "filename": "clip-1.mp4", "mimeType": "video/mp4", "sizeBytes": 100}
    assert JobSuccess(**fields, clipCount=2).clip_count == 2
    assert JobSuccess(**fields).clip_count is None
    for invalid in (True, 1, 4):
        with pytest.raises(ValidationError):
            JobSuccess(**fields, clipCount=invalid)
    with pytest.raises(ValidationError):
        JobSuccess(**{**fields, "delivery": "r2"}, clipCount=2)


def test_ordinary_requests_remain_compatible_without_clip_fields() -> None:
    assert _run(clipRanges=None).clip_ranges is None
    assert _delivery(clipRanges=None).clip_ranges is None

from __future__ import annotations

import pytest

from downloader_container.errors import DownloadError, ErrorCode
from downloader_container.models import MediaMetadata
from downloader_container.service import DownloaderService


def _metadata(duration: float | None) -> MediaMetadata:
    return MediaMetadata(
        filename="clip.mp4",
        mimeType="video/mp4",
        sizeBytes=5,
        duration=duration,
        hasVideo=True,
        hasAudio=True,
    )


def test_final_duration_is_enforced_from_authoritative_metadata(settings) -> None:
    service = DownloaderService(settings)
    service._validate_final_duration(_metadata(10))
    service._validate_final_duration(_metadata(settings.max_duration_seconds))

    with pytest.raises(DownloadError) as over_limit:
        service._validate_final_duration(_metadata(settings.max_duration_seconds + 1))
    assert over_limit.value.code == ErrorCode.DURATION_LIMIT

    invalid_metadata = [
        _metadata(None),
        _metadata(0),
        _metadata(float("inf")),
        _metadata(1).model_copy(update={"duration": float("nan")}),
    ]
    for metadata in invalid_metadata:
        with pytest.raises(DownloadError) as invalid:
            service._validate_final_duration(metadata)
        assert invalid.value.code == ErrorCode.PROCESSING_FAILED

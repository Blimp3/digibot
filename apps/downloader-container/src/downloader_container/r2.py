"""Private R2 fallback upload and expiring HMAC link helpers."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import hmac
import importlib
import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .config import Settings
from .deadline import JobDeadlineExceeded, current_deadline
from .errors import DownloadError, ErrorCode
from .security import sanitize_filename, validate_job_id, validate_service_origin

boto3: Any = None
with contextlib.suppress(ImportError):
    boto3 = importlib.import_module("boto3")

botocore_config: Any = None
with contextlib.suppress(ImportError):
    botocore_config = importlib.import_module("botocore.config")


async def _drain_upload_task(task: asyncio.Task[Any]) -> None:
    """Wait for a shielded blocking upload after its awaiter is cancelled."""

    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            # A second cancellation must not detach the synchronous SDK call.
            continue
        except BaseException:
            # The caller's timeout or cancellation remains authoritative even
            # when the SDK reports a late failure while the task is drained.
            break
    with contextlib.suppress(BaseException):
        task.result()


@dataclass(frozen=True, slots=True)
class R2UploadResult:
    object_key: str
    expires_at: str
    download_url: str | None


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def sign_download_token(
    *,
    object_key: str,
    filename: str,
    expires_at: int,
    secret: str,
) -> str:
    """Create a compact token; source URLs and credentials are never included."""

    if not secret or not object_key.startswith("jobs/") or expires_at <= int(time.time()):
        raise ValueError("invalid token inputs")
    payload = {"k": object_key, "n": sanitize_filename(filename), "e": expires_at}
    encoded = _b64(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signature = _b64(hmac.new(secret.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).digest())
    return f"{encoded}.{signature}"


class R2Uploader:
    def __init__(self, settings: Settings, *, client_factory: Callable[..., Any] | None = None) -> None:
        self.settings = settings
        self._client_factory = client_factory
        self._r2_endpoint = (
            validate_service_origin(
                settings.r2_endpoint,
                allow_loopback_http=True,
                error_code=ErrorCode.R2_UPLOAD_FAILED,
            )
            if settings.r2_endpoint
            else ""
        )
        self._public_base_url = (
            validate_service_origin(
                settings.r2_public_base_url,
                allow_loopback_http=False,
                error_code=ErrorCode.R2_UPLOAD_FAILED,
            )
            if settings.r2_public_base_url
            else ""
        )

    def _client(self, *, timeout_seconds: float | None = None) -> Any:
        if not all((self._r2_endpoint, self.settings.r2_bucket, self.settings.r2_access_key_id, self.settings.r2_secret_access_key)):
            raise DownloadError(ErrorCode.R2_UPLOAD_FAILED)
        factory = self._client_factory
        if factory is None:
            if boto3 is None:
                raise DownloadError(ErrorCode.R2_UPLOAD_FAILED)
            factory = boto3.client
        options: dict[str, Any] = {
            "endpoint_url": self._r2_endpoint,
            "aws_access_key_id": self.settings.r2_access_key_id,
            "aws_secret_access_key": self.settings.r2_secret_access_key,
            "region_name": self.settings.r2_region,
        }
        if timeout_seconds is not None and botocore_config is not None:
            options["config"] = botocore_config.Config(
                connect_timeout=timeout_seconds,
                read_timeout=timeout_seconds,
                retries={"total_max_attempts": 1},
            )
        return factory("s3", **options)

    async def upload(
        self,
        *,
        job_id: str,
        path: str | Path,
        filename: str,
        mime_type: str,
    ) -> R2UploadResult:
        if not self._public_base_url or not self.settings.download_link_hmac_secret:
            raise DownloadError(ErrorCode.R2_UPLOAD_FAILED)
        job_id = validate_job_id(job_id)
        safe_name = sanitize_filename(filename)
        object_key = f"jobs/{job_id}/{safe_name}"
        expires_epoch = int(time.time()) + self.settings.r2_link_lifetime_seconds
        expires_at = datetime.fromtimestamp(expires_epoch, tz=UTC).isoformat().replace("+00:00", "Z")
        try:
            deadline = current_deadline()
            upload_budget = (
                deadline.budget(self.settings.telegram_upload_timeout_seconds)
                if deadline is not None
                else float(self.settings.telegram_upload_timeout_seconds)
            )
            client = self._client(timeout_seconds=upload_budget)
            file_path = Path(path)

            def put() -> None:
                with file_path.open("rb") as handle:
                    client.upload_fileobj(
                        handle,
                        self.settings.r2_bucket,
                        object_key,
                        ExtraArgs={
                            "ContentType": mime_type,
                            "ContentDisposition": f'attachment; filename="{safe_name}"',
                        },
                    )

            # Re-check immediately before scheduling the thread so an expired
            # request cannot start a new provider upload. The task is shielded
            # below because asyncio cannot interrupt the synchronous SDK call.
            if deadline is not None:
                upload_budget = deadline.budget(self.settings.telegram_upload_timeout_seconds)
            upload_task = asyncio.create_task(asyncio.to_thread(put))
            try:
                if deadline is None:
                    await asyncio.shield(upload_task)
                else:
                    await deadline.run(
                        asyncio.shield(upload_task),
                        timeout_seconds=upload_budget,
                    )
            except BaseException:
                await _drain_upload_task(upload_task)
                raise
            if deadline is not None:
                # Do not mint a usable link when the upload won a near-deadline
                # race after the request-wide expiry had already passed.
                deadline.ensure_remaining()
        except DownloadError:
            raise
        except JobDeadlineExceeded:
            raise
        except Exception as exc:
            raise DownloadError(ErrorCode.R2_UPLOAD_FAILED, retryable=True) from exc
        token = sign_download_token(
            object_key=object_key,
            filename=safe_name,
            expires_at=expires_epoch,
            secret=self.settings.download_link_hmac_secret,
        )
        url = f"{self._public_base_url}/download/{token}"
        return R2UploadResult(object_key, expires_at, url)

    def download_url_for(self, *, object_key: str, filename: str, expires_at: int | None = None) -> tuple[str, str]:
        """Create the Worker download URL for an existing private object."""

        expiry = expires_at or (int(time.time()) + self.settings.r2_link_lifetime_seconds)
        if not self._public_base_url or not self.settings.download_link_hmac_secret:
            raise DownloadError(ErrorCode.R2_UPLOAD_FAILED)
        token = sign_download_token(
            object_key=object_key,
            filename=filename,
            expires_at=expiry,
            secret=self.settings.download_link_hmac_secret,
        )
        timestamp = datetime.fromtimestamp(expiry, tz=UTC).isoformat().replace("+00:00", "Z")
        return f"{self._public_base_url}/download/{token}", timestamp

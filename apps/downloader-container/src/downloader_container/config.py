"""Environment-backed configuration with safe defaults and no secret logging."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from .security import DEFAULT_ALLOWED_SOURCE_HOSTS


def _env_int(name: str, default: int, *, minimum: int = 0, maximum: int = 2**63 - 1) -> int:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(minimum, min(maximum, value))


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_hosts(name: str, default: frozenset[str]) -> frozenset[str]:
    raw = os.getenv(name)
    if raw is None:
        return default
    values = {value.strip().lower() for value in raw.split(",") if value.strip()}
    return frozenset(values)


@dataclass(slots=True)
class Settings:
    internal_container_secret: str = ""
    telegram_bot_token: str = ""
    telegram_api_base: str = "https://api.telegram.org"
    deno_path: str = "/usr/local/bin/deno"
    yt_dlp_path: str = "/app/.venv/bin/yt-dlp"
    ffmpeg_path: str = "/usr/bin/ffmpeg"
    ffprobe_path: str = "/usr/bin/ffprobe"
    allowed_source_hosts: frozenset[str] = field(default_factory=lambda: DEFAULT_ALLOWED_SOURCE_HOSTS)
    allow_unlisted_hosts: bool = False
    resolve_source_dns: bool = True
    max_request_body_bytes: int = 16_384
    max_url_length: int = 2_048
    max_duration_seconds: int = 7_200
    max_source_download_bytes: int = 500_000_000
    max_temp_disk_bytes: int = 1_000_000_000
    telegram_upload_limit_bytes: int = 49_000_000
    # Telegram's URL-fetch path has a lower limit than multipart uploads.
    telegram_url_limit_bytes: int = 20_000_000
    direct_resolver_timeout_seconds: int = 15
    # Retry budget passed to a direct-media resolver; providers can emit short
    # 429 bursts. No resolver ships in this edition, so yt-dlp handles sources.
    direct_resolver_retries: int = 5
    # One request-wide cap; individual stages use the smaller remaining time.
    job_timeout_seconds: int = 20 * 60
    download_timeout_seconds: int = 20 * 60
    probe_timeout_seconds: int = 90
    ffmpeg_timeout_seconds: int = 10 * 60
    telegram_upload_timeout_seconds: int = 10 * 60
    process_term_grace_seconds: int = 10
    max_retries: int = 2
    strict_dependencies: bool = False
    job_operation: str = "download"
    whisper_path: str = "/usr/local/bin/whisper-cli"
    whisper_model_path: str = "/opt/whisper/ggml-small.bin"
    whisper_threads: int = 1
    jobs_root: str = "/tmp/media-jobs"
    r2_endpoint: str = ""
    r2_bucket: str = ""
    r2_access_key_id: str = ""
    r2_secret_access_key: str = ""
    r2_region: str = "auto"
    r2_public_base_url: str = ""
    download_link_hmac_secret: str = ""
    r2_link_lifetime_seconds: int = 3_600

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            internal_container_secret=os.getenv("INTERNAL_CONTAINER_SECRET", ""),
            telegram_bot_token=os.getenv("TELEGRAM_BOT_TOKEN", ""),
            telegram_api_base=os.getenv("TELEGRAM_BOT_API_BASE", "https://api.telegram.org").rstrip("/"),
            deno_path=os.getenv("DENO_PATH", "/usr/local/bin/deno"),
            yt_dlp_path=os.getenv("YT_DLP_PATH", "/app/.venv/bin/yt-dlp"),
            ffmpeg_path=os.getenv("FFMPEG_PATH", "/usr/bin/ffmpeg"),
            ffprobe_path=os.getenv("FFPROBE_PATH", "/usr/bin/ffprobe"),
            allowed_source_hosts=_env_hosts("ALLOWED_SOURCE_HOSTS", DEFAULT_ALLOWED_SOURCE_HOSTS),
            allow_unlisted_hosts=_env_bool("ALLOW_UNLISTED_HOSTS", False),
            resolve_source_dns=_env_bool("RESOLVE_SOURCE_DNS", True),
            max_request_body_bytes=_env_int("MAX_REQUEST_BODY_BYTES", 16_384, minimum=1_024),
            max_url_length=_env_int("MAX_URL_LENGTH", 2_048, minimum=64),
            max_duration_seconds=_env_int("MAX_DURATION_SECONDS", 7_200, minimum=1),
            max_source_download_bytes=_env_int("MAX_SOURCE_DOWNLOAD_BYTES", 500_000_000, minimum=1),
            max_temp_disk_bytes=_env_int("MAX_TEMP_DISK_BYTES", 1_000_000_000, minimum=1),
            telegram_upload_limit_bytes=_env_int("TELEGRAM_UPLOAD_LIMIT_BYTES", 49_000_000, minimum=1),
            telegram_url_limit_bytes=_env_int("TELEGRAM_URL_LIMIT_BYTES", 20_000_000, minimum=1),
            direct_resolver_timeout_seconds=_env_int("DIRECT_RESOLVER_TIMEOUT_SECONDS", 15, minimum=1),
            direct_resolver_retries=_env_int("DIRECT_RESOLVER_RETRIES", 5, minimum=0, maximum=10),
            job_timeout_seconds=_env_int("JOB_TIMEOUT_SECONDS", 20 * 60, minimum=1),
            download_timeout_seconds=_env_int("DOWNLOAD_TIMEOUT_SECONDS", 20 * 60, minimum=1),
            probe_timeout_seconds=_env_int("PROBE_TIMEOUT_SECONDS", 90, minimum=1),
            ffmpeg_timeout_seconds=_env_int("FFMPEG_TIMEOUT_SECONDS", 10 * 60, minimum=1),
            telegram_upload_timeout_seconds=_env_int("TELEGRAM_UPLOAD_TIMEOUT_SECONDS", 10 * 60, minimum=1),
            process_term_grace_seconds=_env_int("PROCESS_TERM_GRACE_SECONDS", 10, minimum=1),
            max_retries=_env_int("MAX_RETRIES", 2, minimum=0, maximum=5),
            strict_dependencies=_env_bool("STRICT_DEPENDENCIES", False),
            job_operation=os.getenv("JOB_OPERATION", "download"),
            whisper_path=os.getenv("WHISPER_PATH", "/usr/local/bin/whisper-cli"),
            whisper_model_path=os.getenv("WHISPER_MODEL_PATH", "/opt/whisper/ggml-small.bin"),
            whisper_threads=_env_int("WHISPER_THREADS", 1, minimum=1, maximum=4),
            jobs_root=os.getenv("JOBS_ROOT", "/tmp/media-jobs"),
            r2_endpoint=os.getenv("R2_ENDPOINT", "").rstrip("/"),
            r2_bucket=os.getenv("R2_BUCKET", ""),
            r2_access_key_id=os.getenv("R2_ACCESS_KEY_ID", ""),
            r2_secret_access_key=os.getenv("R2_SECRET_ACCESS_KEY", ""),
            r2_region=os.getenv("R2_REGION", "auto"),
            r2_public_base_url=os.getenv("PUBLIC_WORKER_BASE_URL", "").rstrip("/"),
            download_link_hmac_secret=os.getenv("DOWNLOAD_LINK_HMAC_SECRET", ""),
            r2_link_lifetime_seconds=_env_int("R2_LINK_LIFETIME_SECONDS", 3_600, minimum=60),
        )

    @property
    def effective_allowed_source_hosts(self) -> frozenset[str] | None:
        return None if self.allow_unlisted_hosts else self.allowed_source_hosts

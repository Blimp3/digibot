"""FastAPI application for the private Worker-to-Container API."""

from __future__ import annotations

import asyncio
import math
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from .config import Settings
from .deadline import JobDeadline, JobDeadlineExceeded
from .errors import DownloadError, ErrorCode
from .logging_utils import configure_logging, log_event
from .models import HealthResponse, IntegrationAudioRequest, JobDeliveryRequest, JobRunRequest
from .security import bearer_secret_matches
from .service import DownloaderService
from .workspace import JobWorkspace
from .youtube_collection import YouTubeCollectionRequest, resolve_collection

MAX_SAFE_DEADLINE_EPOCH = 2**53 - 1


def _deadline_from_header(request: Request) -> float | None:
    """Parse the optional shared expiry without changing the legacy JSON body."""

    raw_value = request.headers.get("x-digibot-deadline-at")
    if raw_value is None:
        return None
    try:
        value = float(raw_value)
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid deadline header") from exc
    if not math.isfinite(value) or value <= 0 or value > MAX_SAFE_DEADLINE_EPOCH:
        raise ValueError("invalid deadline header")
    return value


class RequestSizeMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: FastAPI, *, max_bytes: int, request_timeout_seconds: float) -> None:
        super().__init__(app)
        self.max_bytes = max_bytes
        self.request_timeout_seconds = request_timeout_seconds

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > self.max_bytes:
                    return JSONResponse(
                        status_code=413,
                        content=DownloadError(ErrorCode.INVALID_REQUEST).as_dict(),
                    )
            except ValueError:
                return JSONResponse(status_code=400, content=DownloadError(ErrorCode.INVALID_REQUEST).as_dict())
        if request.url.path in {"/v1/jobs/run", "/v1/jobs/deliver", "/v1/integration/audio/prepare", "/v1/youtube/resolve"}:
            try:
                body_timeout = min(20, self.request_timeout_seconds) if request.url.path == "/v1/youtube/resolve" else self.request_timeout_seconds
                deadline_at = _deadline_from_header(request)
                if deadline_at is None:
                    body = await asyncio.wait_for(request.body(), timeout=body_timeout)
                else:
                    deadline = JobDeadline.from_absolute(
                        deadline_at,
                        maximum_seconds=body_timeout,
                    )
                    body = await deadline.run(request.body())
            except (JobDeadlineExceeded, TimeoutError):
                return JSONResponse(status_code=408, content=DownloadError(ErrorCode.DOWNLOAD_TIMEOUT).as_dict())
            except ValueError:
                return JSONResponse(status_code=400, content=DownloadError(ErrorCode.INVALID_REQUEST).as_dict())
            if len(body) > self.max_bytes:
                return JSONResponse(status_code=413, content=DownloadError(ErrorCode.INVALID_REQUEST).as_dict())
        return await call_next(request)


def create_app(settings: Settings | None = None, service: DownloaderService | None = None) -> FastAPI:
    config = settings or Settings.from_env()
    downloader = service or DownloaderService(config)
    collection_active = asyncio.Semaphore(1)
    configure_logging()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        JobWorkspace.cleanup_stale(config.jobs_root)
        diagnostics = downloader.diagnostics()
        log_event("dependency_check", state="startup", ready=bool(diagnostics.get("ready", False)))
        if config.strict_dependencies and not diagnostics.get("ready", False):
            raise RuntimeError("required downloader dependencies are unavailable")
        yield

    app = FastAPI(
        title="Private Downloader Container",
        version="5.0.0",
        openapi_url=None,
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    app.add_middleware(
        RequestSizeMiddleware,  # type: ignore[arg-type]
        max_bytes=config.max_request_body_bytes,
        request_timeout_seconds=config.job_timeout_seconds,
    )

    @app.exception_handler(RequestValidationError)
    async def request_validation_error(_request: Request, _exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(status_code=400, content=DownloadError(ErrorCode.INVALID_REQUEST).as_dict())

    @app.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        diagnostics = downloader.diagnostics()
        return HealthResponse(status="ok" if diagnostics.get("ready") else "degraded", dependencies=diagnostics)

    @app.post("/v1/jobs/run")
    async def run_job(request: Request) -> JSONResponse:
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            return JSONResponse(status_code=415, content=DownloadError(ErrorCode.INVALID_REQUEST).as_dict())
        if not bearer_secret_matches(config.internal_container_secret, request.headers.get("authorization")):
            return JSONResponse(status_code=401, content=DownloadError(ErrorCode.UNAUTHORIZED_REQUEST).as_dict())
        try:
            body = await request.json()
            job = JobRunRequest.model_validate(body)
            deadline_at = _deadline_from_header(request)
            if deadline_at is not None:
                job = job.model_copy(update={"deadline_at": deadline_at})
        except (ValidationError, ValueError):
            return JSONResponse(status_code=400, content=DownloadError(ErrorCode.INVALID_REQUEST).as_dict())
        result = await downloader.run(job)
        return JSONResponse(status_code=200, content=result)

    @app.post("/v1/youtube/resolve")
    async def resolve_youtube(request: Request) -> JSONResponse:
        if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
            return JSONResponse(status_code=415, content=DownloadError(ErrorCode.INVALID_REQUEST).as_dict())
        if not bearer_secret_matches(config.internal_container_secret, request.headers.get("authorization")):
            return JSONResponse(status_code=401, content=DownloadError(ErrorCode.UNAUTHORIZED_REQUEST).as_dict())
        try:
            collection = YouTubeCollectionRequest.model_validate(await request.json())
            deadline_at = _deadline_from_header(request)
        except (ValidationError, ValueError):
            return JSONResponse(status_code=400, content=DownloadError(ErrorCode.INVALID_REQUEST).as_dict())
        try:
            if config.job_operation != "download":
                raise DownloadError(ErrorCode.INVALID_REQUEST)
            if collection_active.locked():
                raise DownloadError(ErrorCode.SOURCE_RATE_LIMITED)
            async with collection_active:
                runtime = downloader.diagnostics().get("runtime")
                if not isinstance(runtime, dict) or not isinstance(runtime.get("path"), str) or runtime.get("name") != "deno":
                    raise DownloadError(ErrorCode.DENO_MISSING)
                ids = await resolve_collection(config, collection, runtime["name"], runtime["path"], deadline_at)
                return JSONResponse(status_code=200, content={"status": "success", "videoIds": ids})
        except (JobDeadlineExceeded, TimeoutError):
            return JSONResponse(status_code=200, content=DownloadError(ErrorCode.DOWNLOAD_TIMEOUT).as_dict())
        except DownloadError as exc:
            return JSONResponse(status_code=200, content=exc.as_dict())
        except Exception:
            return JSONResponse(status_code=200, content=DownloadError(ErrorCode.INTERNAL_ERROR).as_dict())

    @app.post("/v1/jobs/deliver")
    async def deliver_job(request: Request) -> JSONResponse:
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            return JSONResponse(status_code=415, content=DownloadError(ErrorCode.INVALID_REQUEST).as_dict())
        if not bearer_secret_matches(config.internal_container_secret, request.headers.get("authorization")):
            return JSONResponse(status_code=401, content=DownloadError(ErrorCode.UNAUTHORIZED_REQUEST).as_dict())
        try:
            job = JobDeliveryRequest.model_validate(await request.json())
            deadline_at = _deadline_from_header(request)
            if deadline_at is not None:
                job = job.model_copy(update={"deadline_at": deadline_at})
        except (ValidationError, ValueError):
            return JSONResponse(status_code=400, content=DownloadError(ErrorCode.INVALID_REQUEST).as_dict())
        result = await downloader.deliver(job)
        return JSONResponse(status_code=200, content=result)

    @app.post("/v1/integration/audio/prepare")
    async def prepare_integration_audio(request: Request) -> Response:
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            return JSONResponse(status_code=415, content=DownloadError(ErrorCode.INVALID_REQUEST).as_dict())
        if not bearer_secret_matches(config.internal_container_secret, request.headers.get("authorization")):
            return JSONResponse(status_code=401, content=DownloadError(ErrorCode.UNAUTHORIZED_REQUEST).as_dict())
        try:
            job = IntegrationAudioRequest.model_validate(await request.json())
            deadline_at = _deadline_from_header(request)
            if deadline_at is not None:
                job = job.model_copy(update={"deadline_at": deadline_at})
        except (ValidationError, ValueError):
            return JSONResponse(status_code=400, content=DownloadError(ErrorCode.INVALID_REQUEST).as_dict())
        result = await downloader.prepare_integration_audio(job)
        content = result.get("content")
        if not isinstance(content, bytes) or result.get("status") != "prepared":
            return JSONResponse(status_code=200, content={key: value for key, value in result.items() if key != "content"})
        duration = result.get("duration")
        size_bytes = result.get("sizeBytes")
        filename = result.get("filename")
        sha256 = result.get("sha256")
        if not isinstance(duration, float | int) or isinstance(duration, bool) or not isinstance(size_bytes, int) or not isinstance(filename, str) or not isinstance(sha256, str):
            return JSONResponse(status_code=200, content=DownloadError(ErrorCode.PROCESSING_FAILED).as_dict())
        headers = {
            "cache-control": "no-store",
            "x-digibot-media-sha256": sha256,
            "x-digibot-media-byte-length": str(size_bytes),
            "x-digibot-media-duration-seconds": str(duration),
            "x-digibot-media-filename": filename,
            "x-digibot-trim-end-clamped": "true" if result.get("trimEndClamped") is True else "false",
        }
        return Response(content=content, media_type="audio/mpeg", headers=headers)

    return app


app = create_app()

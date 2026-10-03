from __future__ import annotations

import asyncio
import json
import time
from unittest.mock import AsyncMock

import httpx
import pytest

from downloader_container.app import create_app
from downloader_container.service import DownloaderService

VALID_DELIVERY = {
    "jobId": "job-1",
    "telegramChatId": "123",
    "objectKey": "staged/job-1/video.mp4",
    "filename": "video.mp4",
    "mimeType": "video/mp4",
    "mode": "video",
}


@pytest.mark.asyncio
async def test_health_exposes_safe_dependency_data(settings, ready_diagnostics):
    service = DownloaderService(settings, dependency_provider=lambda _settings: ready_diagnostics)
    transport = httpx.ASGITransport(app=create_app(settings, service))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert "token" not in response.text.lower()


@pytest.mark.asyncio
async def test_job_auth_content_type_and_strict_validation(settings, ready_diagnostics):
    service = DownloaderService(settings, dependency_provider=lambda _settings: ready_diagnostics)
    transport = httpx.ASGITransport(app=create_app(settings, service))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        base = {
            "jobId": "job-1",
            "sourceUrl": "https://youtu.be/example",
            "telegramChatId": "123",
            "waitingMessageId": 1,
            "mode": "video",
        }
        assert (await client.post("/v1/jobs/run", content="{}", headers={"content-type": "text/plain"})).status_code == 415
        assert (await client.post("/v1/jobs/run", json=base, headers={"content-type": "application/json", "authorization": "Bearer wrong"})).status_code == 401
        malformed = await client.post(
            "/v1/jobs/run",
            content=b"{not-json",
            headers={
                "content-type": "application/json",
                "authorization": "Bearer test-internal-secret",
            },
        )
        assert malformed.status_code == 400
        assert malformed.json()["errorCode"] == "INVALID_REQUEST"
        invalid = {**base, "unknown": "reject"}
        response = await client.post("/v1/jobs/run", json=invalid, headers={"authorization": "Bearer test-internal-secret"})
    assert response.status_code == 400
    assert response.json()["errorCode"] == "INVALID_REQUEST"


@pytest.mark.asyncio
async def test_deadline_header_preserves_legacy_body_and_rejects_malformed_without_processing(settings, ready_diagnostics):
    service = DownloaderService(settings, dependency_provider=lambda _settings: ready_diagnostics)
    service.run = AsyncMock(return_value={"status": "accepted"})
    transport = httpx.ASGITransport(app=create_app(settings, service))
    base = {
        "jobId": "job-header-deadline",
        "sourceUrl": "https://youtu.be/example",
        "telegramChatId": "123",
        "waitingMessageId": 1,
        "mode": "video",
    }
    headers = {"content-type": "application/json", "authorization": "Bearer test-internal-secret"}
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        for malformed_value in ("", "0", "-1", "nan", "inf", str(2**53), "not-a-number"):
            malformed = await client.post(
                "/v1/jobs/run",
                json=base,
                headers={**headers, "x-digibot-deadline-at": malformed_value},
            )
            assert malformed.status_code == 400
            assert service.run.await_count == 0

        legacy = await client.post("/v1/jobs/run", json=base, headers=headers)
        assert legacy.status_code == 200
        assert service.run.await_count == 1
        assert service.run.await_args.args[0].deadline_at is None

        with_header = await client.post(
            "/v1/jobs/run",
            json=base,
            headers={**headers, "x-digibot-deadline-at": str(time.time() + 60.5)},
        )
        assert with_header.status_code == 200
        assert service.run.await_count == 2
        assert service.run.await_args.args[0].deadline_at == pytest.approx(time.time() + 60.5, abs=1)


@pytest.mark.asyncio
async def test_deadline_header_bounds_request_body_read(settings, ready_diagnostics):
    settings.job_timeout_seconds = 0.05
    service = DownloaderService(settings, dependency_provider=lambda _settings: ready_diagnostics)
    service.run = AsyncMock(return_value={"status": "accepted"})
    transport = httpx.ASGITransport(app=create_app(settings, service))

    async def body():
        yield b"{"
        await asyncio.sleep(1)
        yield b"}"

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/v1/jobs/run",
            content=body(),
            headers={
                "content-type": "application/json",
                "authorization": "Bearer test-internal-secret",
                "x-digibot-deadline-at": str(time.time() + 0.05),
            },
        )
    assert response.status_code == 408
    assert service.run.await_count == 0


@pytest.mark.asyncio
async def test_chunked_delivery_body_is_bounded(settings, ready_diagnostics):
    settings.max_request_body_bytes = 32
    service = DownloaderService(settings, dependency_provider=lambda _settings: ready_diagnostics)
    transport = httpx.ASGITransport(app=create_app(settings, service))

    async def body():
        yield b"x" * 64

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/v1/jobs/deliver",
            content=body(),
            headers={
                "content-type": "application/json",
                "authorization": "Bearer test-internal-secret",
            },
        )
    assert response.status_code == 413
    assert response.json()["errorCode"] == "INVALID_REQUEST"


@pytest.mark.asyncio
async def test_delivery_rejects_wrong_content_type_auth_and_body_without_delivering(settings, ready_diagnostics):
    service = DownloaderService(settings, dependency_provider=lambda _settings: ready_diagnostics)
    service.deliver = AsyncMock(return_value={"status": "delivered"})
    transport = httpx.ASGITransport(app=create_app(settings, service))
    authorized = {"content-type": "application/json", "authorization": "Bearer test-internal-secret"}
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        wrong_type = await client.post("/v1/jobs/deliver", content="{}", headers={**authorized, "content-type": "text/plain"})
        assert wrong_type.status_code == 415
        wrong_secret = await client.post("/v1/jobs/deliver", json={}, headers={**authorized, "authorization": "Bearer wrong"})
        assert wrong_secret.status_code == 401
        assert wrong_secret.json()["errorCode"] == "UNAUTHORIZED_REQUEST"
        assert (await client.post("/v1/jobs/deliver", json={}, headers={"content-type": "application/json"})).status_code == 401
        malformed = await client.post("/v1/jobs/deliver", content=b"{not-json", headers=authorized)
        assert malformed.status_code == 400
        assert malformed.json()["errorCode"] == "INVALID_REQUEST"
        unknown_field = await client.post("/v1/jobs/deliver", json={**VALID_DELIVERY, "unknown": "reject"}, headers=authorized)
        assert unknown_field.status_code == 400
        assert service.deliver.await_count == 0
        # The same body without the extra key is accepted, so the 400 above is the unknown key.
        assert (await client.post("/v1/jobs/deliver", json=VALID_DELIVERY, headers=authorized)).status_code == 200
    assert service.deliver.await_count == 1


@pytest.mark.asyncio
async def test_declared_content_length_is_checked_before_the_route(settings, ready_diagnostics):
    settings.max_request_body_bytes = 1024
    service = DownloaderService(settings, dependency_provider=lambda _settings: ready_diagnostics)
    service.deliver = AsyncMock(return_value={"status": "delivered"})
    transport = httpx.ASGITransport(app=create_app(settings, service))
    authorized = {"content-type": "application/json", "authorization": "Bearer test-internal-secret"}
    body = json.dumps(VALID_DELIVERY).encode()
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        oversized = await client.post("/v1/jobs/deliver", content=body, headers={**authorized, "content-length": "1025"})
        assert oversized.status_code == 413
        assert oversized.json()["errorCode"] == "INVALID_REQUEST"
        malformed = await client.post("/v1/jobs/deliver", content=body, headers={**authorized, "content-length": "two"})
        assert malformed.status_code == 400
        assert malformed.json()["errorCode"] == "INVALID_REQUEST"
    assert service.deliver.await_count == 0

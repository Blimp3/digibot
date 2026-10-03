from __future__ import annotations

import asyncio
import logging
import stat

import httpx
import pytest
from pydantic import ValidationError

from downloader_container.deadline import JobDeadline, JobDeadlineExceeded, activate_deadline
from downloader_container.errors import DownloadError, ErrorCode
from downloader_container.models import JobRunRequest, TelegramFileSource
from downloader_container.telegram_files import download_telegram_file

TOKEN = "123:test-bot-token"
FILE_ID = "opaque-telegram-file-id"


def _job(**source_fields: object) -> JobRunRequest:
    return JobRunRequest(
        jobId="telegram-file-job",
        telegramChatId="123",
        waitingMessageId=1,
        mode="video",
        **source_fields,
    )


def test_job_request_requires_one_bounded_source_and_download_operation() -> None:
    source = {"fileId": FILE_ID, "fileSize": 20_000_000, "fileName": "upload.mp4"}
    assert _job(telegramFile=source).telegram_file == TelegramFileSource.model_validate(source)
    assert _job(sourceUrl="https://example.com/video").telegram_file is None
    for invalid in (
        {},
        {"sourceUrl": "https://example.com/video", "telegramFile": source},
        {"telegramFile": {**source, "fileSize": 20_000_001}},
        {"telegramFile": {**source, "fileSize": True}},
        {"telegramFile": {**source, "fileId": "x" * 257}},
        {"telegramFile": {**source, "fileName": "bad\nname"}},
        {"telegramFile": {**source, "unexpected": "value"}},
        {"telegramFile": source, "operation": "transcript"},
    ):
        with pytest.raises(ValidationError):
            _job(**invalid)


def _response_handler(
    content: bytes,
    *,
    returned_size: int | None = None,
    include_returned_size: bool = True,
    returned_id: str = FILE_ID,
    file_path: str = "documents/file_1.bin",
    get_status: int = 200,
    file_status: int = 200,
):
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/getFile"):
            result = {"file_id": returned_id, "file_path": file_path}
            if include_returned_size:
                result["file_size"] = len(content) if returned_size is None else returned_size
            return httpx.Response(get_status, json={"ok": True, "result": result})
        assert request.url.host == "api.telegram.org"
        assert request.url.path.endswith(f"/{file_path}")
        return httpx.Response(file_status, content=content, headers={"content-length": str(len(content))})

    return handler


@pytest.mark.asyncio
async def test_download_writes_exact_owner_only_regular_file_and_accepts_reissued_id(tmp_path) -> None:
    content = b"telegram-media"
    workspace = tmp_path / "job"
    workspace.mkdir(mode=0o700)
    target = workspace / "input.bin"
    source = TelegramFileSource(fileId=FILE_ID, fileSize=len(content))
    checks = 0

    def workspace_size() -> int:
        nonlocal checks
        checks += 1
        return target.stat().st_size

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(_response_handler(content, returned_id="replacement-valid-file-id")),
        follow_redirects=True,
    ) as client:
        written = await download_telegram_file(
            source,
            target,
            bot_token=TOKEN,
            timeout_seconds=1,
            workspace_size=workspace_size,
            client=client,
        )

    assert written == len(content) and target.read_bytes() == content
    assert stat.S_IMODE(target.stat().st_mode) == 0o600 and target.is_file() and not target.is_symlink()
    assert checks > 0


@pytest.mark.asyncio
async def test_optional_get_file_size_may_be_omitted_but_download_must_still_match(tmp_path) -> None:
    content = b"telegram-media"
    workspace = tmp_path / "job"
    workspace.mkdir(mode=0o700)
    target = workspace / "input.bin"
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(_response_handler(content, include_returned_size=False))
    ) as client:
        written = await download_telegram_file(
            TelegramFileSource(fileId=FILE_ID, fileSize=len(content)),
            target,
            bot_token=TOKEN,
            timeout_seconds=1,
            client=client,
        )
    assert written == len(content) and target.read_bytes() == content


@pytest.mark.asyncio
async def test_oversized_get_file_response_is_rejected_before_download(tmp_path) -> None:
    workspace = tmp_path / "job"
    workspace.mkdir(mode=0o700)
    target = workspace / "input.bin"
    file_requests = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal file_requests
        if request.url.path.endswith("/getFile"):
            return httpx.Response(200, content=b"{" + b" " * (64 * 1024), headers={"content-type": "application/json"})
        file_requests += 1
        return httpx.Response(200, content=b"data")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(DownloadError) as caught:
            await download_telegram_file(
                TelegramFileSource(fileId=FILE_ID, fileSize=4),
                target,
                bot_token=TOKEN,
                timeout_seconds=1,
                client=client,
            )
    assert caught.value.code == ErrorCode.DOWNLOAD_FAILED
    assert file_requests == 0 and not target.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize(("get_status", "file_status"), [(302, 200), (200, 302)])
async def test_redirects_are_rejected_and_partial_target_removed(tmp_path, get_status, file_status) -> None:
    workspace = tmp_path / "job"
    workspace.mkdir(mode=0o700)
    target = workspace / "input.bin"
    source = TelegramFileSource(fileId=FILE_ID, fileSize=4)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            _response_handler(b"data", get_status=get_status, file_status=file_status)
        )
    ) as client:
        with pytest.raises(DownloadError):
            await download_telegram_file(source, target, bot_token=TOKEN, timeout_seconds=1, client=client)
    assert not target.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("content", "declared", "returned_size"),
    [(b"abc", 4, 4), (b"abcde", 4, 4), (b"abcd", 4, 5)],
)
async def test_size_mismatch_is_rejected_without_partial_file(tmp_path, content, declared, returned_size) -> None:
    workspace = tmp_path / "job"
    workspace.mkdir(mode=0o700)
    target = workspace / "input.bin"
    source = TelegramFileSource(fileId=FILE_ID, fileSize=declared)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(_response_handler(content, returned_size=returned_size))
    ) as client:
        with pytest.raises(DownloadError) as caught:
            await download_telegram_file(source, target, bot_token=TOKEN, timeout_seconds=1, client=client)
    assert caught.value.code == ErrorCode.DOWNLOAD_FAILED
    assert not target.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("file_path", ["../secret", "documents/../../secret", "/etc/passwd", "https://evil.test/x", "a\\b"])
async def test_unsafe_telegram_paths_are_rejected_before_file_request(tmp_path, file_path) -> None:
    workspace = tmp_path / "job"
    workspace.mkdir(mode=0o700)
    target = workspace / "input.bin"
    file_requests = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal file_requests
        if request.url.path.endswith("/getFile"):
            return httpx.Response(200, json={"ok": True, "result": {
                "file_id": FILE_ID, "file_size": 4, "file_path": file_path,
            }})
        file_requests += 1
        return httpx.Response(200, content=b"data")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(DownloadError):
            await download_telegram_file(
                TelegramFileSource(fileId=FILE_ID, fileSize=4),
                target,
                bot_token=TOKEN,
                timeout_seconds=1,
                client=client,
            )
    assert file_requests == 0 and not target.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("hang_download", [False, True])
async def test_hung_get_file_or_download_uses_existing_deadline(tmp_path, hang_download) -> None:
    workspace = tmp_path / "job"
    workspace.mkdir(mode=0o700)
    target = workspace / "input.bin"

    async def handler(request: httpx.Request) -> httpx.Response:
        is_download = "/file/bot" in request.url.path
        if is_download == hang_download:
            await asyncio.sleep(1)
        if is_download:
            return httpx.Response(200, content=b"data", headers={"content-length": "4"})
        return httpx.Response(200, json={"ok": True, "result": {
            "file_id": FILE_ID, "file_size": 4, "file_path": "documents/file_1.bin",
        }})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with activate_deadline(JobDeadline.start(0.02)), pytest.raises(JobDeadlineExceeded):
            await download_telegram_file(
                TelegramFileSource(fileId=FILE_ID, fileSize=4),
                target,
                bot_token=TOKEN,
                timeout_seconds=1,
                client=client,
            )
    assert not target.exists()


@pytest.mark.asyncio
async def test_failures_do_not_log_or_expose_token_file_id_or_body(tmp_path, caplog) -> None:
    workspace = tmp_path / "job"
    workspace.mkdir(mode=0o700)
    target = workspace / "input.bin"
    secret_body = "secret-telegram-response-body"

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text=secret_body)

    caplog.set_level(logging.DEBUG)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(DownloadError) as caught:
            await download_telegram_file(
                TelegramFileSource(fileId=FILE_ID, fileSize=4),
                target,
                bot_token=TOKEN,
                timeout_seconds=1,
                client=client,
            )
    exposed = caplog.text + str(caught.value)
    assert TOKEN not in exposed and FILE_ID not in exposed and secret_body not in exposed


@pytest.mark.asyncio
@pytest.mark.parametrize("fail_download", [False, True])
async def test_protocol_errors_are_sanitized_at_both_telegram_stages(tmp_path, caplog, fail_download) -> None:
    workspace = tmp_path / "job"
    workspace.mkdir(mode=0o700)
    target = workspace / "input.bin"

    async def handler(request: httpx.Request) -> httpx.Response:
        is_download = "/file/bot" in request.url.path
        if is_download == fail_download:
            raise httpx.RemoteProtocolError(
                f"protocol failure {TOKEN} {FILE_ID}",
                request=request,
            )
        return httpx.Response(200, json={"ok": True, "result": {
            "file_id": FILE_ID, "file_size": 4, "file_path": "documents/file_1.bin",
        }})

    caplog.set_level(logging.DEBUG)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(DownloadError) as caught:
            await download_telegram_file(
                TelegramFileSource(fileId=FILE_ID, fileSize=4),
                target,
                bot_token=TOKEN,
                timeout_seconds=1,
                client=client,
            )
    exposed = caplog.text + str(caught.value)
    assert caught.value.code == ErrorCode.DOWNLOAD_FAILED
    assert TOKEN not in exposed and FILE_ID not in exposed and not target.exists()


@pytest.mark.asyncio
async def test_workspace_limit_failure_removes_partial_target(tmp_path) -> None:
    workspace = tmp_path / "job"
    workspace.mkdir(mode=0o700)
    target = workspace / "input.bin"

    def workspace_size() -> int:
        raise DownloadError(ErrorCode.SOURCE_SIZE_LIMIT)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(_response_handler(b"telegram-media"))
    ) as client:
        with pytest.raises(DownloadError) as caught:
            await download_telegram_file(
                TelegramFileSource(fileId=FILE_ID, fileSize=len(b"telegram-media")),
                target,
                bot_token=TOKEN,
                timeout_seconds=1,
                workspace_size=workspace_size,
                client=client,
            )
    assert caught.value.code == ErrorCode.SOURCE_SIZE_LIMIT
    assert not target.exists()

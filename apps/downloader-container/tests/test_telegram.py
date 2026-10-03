from __future__ import annotations

import json
from email import policy
from email.parser import BytesParser
from pathlib import Path

import httpx
import pytest

from downloader_container.errors import ErrorCode
from downloader_container.models import MediaMetadata, MediaMode, ProbeInfo
from downloader_container.telegram import TelegramApiError, TelegramClient, build_caption


def _clip_media(tmp_path: Path) -> list[tuple[Path, MediaMetadata]]:
    clips = []
    for index, (start, end) in enumerate(((65, 75), (5, 25)), start=1):
        path = tmp_path / f"clip-{index}.mp4"
        path.write_bytes(bytes([index]) * (10 + index))
        clips.append((path, MediaMetadata(
            filename=f"../unsafe clip {index}.mp4",
            mimeType="video/mp4",
            sizeBytes=path.stat().st_size,
            duration=end - start,
            width=640,
            height=360,
            hasVideo=True,
            hasAudio=True,
            trimStartSeconds=start,
            trimEndSeconds=end,
        )))
    return clips


def _multipart_fields(request: httpx.Request, body: bytes) -> dict[str, object]:
    message = BytesParser(policy=policy.default).parsebytes(
        f"Content-Type: {request.headers['content-type']}\r\nMIME-Version: 1.0\r\n\r\n".encode() + body
    )
    return {
        part.get_param("name", header="content-disposition"): part
        for part in message.iter_parts()
    }


def _group_result(media: list[dict[str, object]]) -> list[dict[str, object]]:
    return [
        {
            "message_id": str(101 + index) if index == 0 else 101 + index,
            "chat": {"id": "123" if index == 0 else 123, "type": "private"},
            "video": {"file_id": f"video-{index + 1}"},
            "media_group_id": "group-1",
            "caption": item["caption"],
        }
        for index, item in enumerate(media)
    ]


@pytest.mark.parametrize(
    "message_id",
    [None, "", "-1", "1.5", "not-a-number", 0, -1, 1.5, True, 2**53],
)
def test_telegram_rejects_malformed_message_ids(message_id):
    with pytest.raises(TelegramApiError) as caught:
        TelegramClient._message_from_result({"message_id": message_id}, "sendVideo", "video")
    assert caught.value.code == ErrorCode.TELEGRAM_UPLOAD_FAILED


def test_telegram_normalizes_numeric_string_message_id():
    message = TelegramClient._message_from_result({"message_id": "123"}, "sendVideo", "video")

    assert message.message_id == 123


@pytest.mark.parametrize(
    ("extractor", "provider"),
    [
        ("vimeo", "Vimeo"),
        ("reddit", "Reddit"),
        ("pinterest", "Pinterest"),
        ("TedTalk", "TED"),
        ("TedEmbed", "TED"),
    ],
)
def test_caption_names_new_catalog_providers(extractor, provider):
    caption = build_caption(
        ProbeInfo(title="Public media", extractor=extractor),
        MediaMetadata(filename="media.mp4", mimeType="video/mp4", sizeBytes=1),
    )
    assert f"Source: {provider}" in caption


@pytest.mark.asyncio
async def test_telegram_multipart_upload_and_message_id(tmp_path):
    received = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        received["content_type"] = request.headers["content-type"]
        received["body"] = await request.aread()
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 99}})

    path = tmp_path / "clip.mp4"
    path.write_bytes(b"media")
    client = TelegramClient("token", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    message = await client.send_media(
        chat_id="123",
        path=path,
        metadata=MediaMetadata(filename="clip.mp4", mimeType="video/mp4", sizeBytes=5, hasVideo=True, hasAudio=True),
        probe=ProbeInfo(title="Clip", extractor="youtube"),
        mode=MediaMode.VIDEO,
    )
    assert message.message_id == 99
    assert b"supports_streaming" in received["body"]
    await client._client.aclose()


@pytest.mark.asyncio
async def test_media_group_preserves_order_captions_exact_size_and_closes_handles(tmp_path, monkeypatch):
    clips = _clip_media(tmp_path)
    opened = []
    original_open = Path.open

    def tracked_open(path, *args, **kwargs):
        handle = original_open(path, *args, **kwargs)
        if path in {clip_path for clip_path, _metadata in clips}:
            opened.append(handle)
        return handle

    monkeypatch.setattr(Path, "open", tracked_open)
    received: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        body = await request.aread()
        fields = _multipart_fields(request, body)
        media = json.loads(fields["media"].get_payload(decode=True))
        received.update({"path": request.url.path, "body": body, "length": int(request.headers["content-length"]), "media": media, "fields": fields})
        return httpx.Response(200, json={"ok": True, "result": _group_result(media)})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        messages = await TelegramClient("token", client=http).send_media_group(
            chat_id="123",
            clips=clips,
            probe=ProbeInfo(title="Requested clips", extractor="youtube"),
            max_bytes=49_000_000,
        )

    assert received["path"].endswith("/sendMediaGroup")
    assert received["length"] == len(received["body"])
    media = received["media"]
    assert [item["media"] for item in media] == ["attach://clip_1", "attach://clip_2"]
    assert media[0]["caption"].startswith("Clip 1/2\n") and "Clip: 00:01:05–00:01:15" in media[0]["caption"]
    assert media[1]["caption"].startswith("Clip 2/2\n") and "Clip: 00:00:05–00:00:25" in media[1]["caption"]
    fields = received["fields"]
    assert fields["clip_1"].get_filename() == "unsafe clip 1.mp4"
    assert fields["clip_2"].get_filename() == "unsafe clip 2.mp4"
    assert [message.message_id for message in messages] == [101, 102]
    assert [message.file_id for message in messages] == ["video-1", "video-2"]
    assert all(message.media_method == "sendMediaGroup" for message in messages)
    assert opened and all(handle.closed for handle in opened)


@pytest.mark.asyncio
async def test_media_group_rejects_exact_multipart_overhead_before_sending(tmp_path):
    clips = _clip_media(tmp_path)
    requests = 0
    exact_length = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal requests, exact_length
        requests += 1
        body = await request.aread()
        exact_length = int(request.headers["content-length"])
        media = json.loads(_multipart_fields(request, body)["media"].get_payload(decode=True))
        return httpx.Response(200, json={"ok": True, "result": _group_result(media)})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = TelegramClient("token", client=http)
        await client.send_media_group(chat_id="123", clips=clips, probe=ProbeInfo(), max_bytes=49_000_000)
        with pytest.raises(TelegramApiError) as caught:
            await client.send_media_group(chat_id="123", clips=clips, probe=ProbeInfo(), max_bytes=exact_length - 1)
    assert requests == 1
    assert caught.value.code == ErrorCode.TELEGRAM_FILE_TOO_LARGE
    assert caught.value.outcome == "rejected"
    assert exact_length > sum(path.stat().st_size for path, _metadata in clips)


@pytest.mark.asyncio
async def test_media_group_rejects_missing_multipart_content_length_before_sending(tmp_path):
    requests = 0

    class MissingLengthClient(httpx.AsyncClient):
        def build_request(self, *args, **kwargs):
            request = super().build_request(*args, **kwargs)
            del request.headers["content-length"]
            return request

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        return httpx.Response(500)

    async with MissingLengthClient(transport=httpx.MockTransport(handler)) as http:
        with pytest.raises(TelegramApiError) as caught:
            await TelegramClient("token", client=http).send_media_group(
                chat_id="123", clips=_clip_media(tmp_path), probe=ProbeInfo(), max_bytes=49_000_000,
            )
    assert requests == 0
    assert caught.value.code == ErrorCode.TELEGRAM_UPLOAD_FAILED
    assert caught.value.outcome == "rejected"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure",
    ["wrong_chat", "duplicate_ids", "missing_video", "mixed_group", "partial", "caption_order"],
)
async def test_media_group_rejects_incomplete_or_mismatched_receipts_as_ambiguous(tmp_path, failure):
    requests = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        body = await request.aread()
        media = json.loads(_multipart_fields(request, body)["media"].get_payload(decode=True))
        result = _group_result(media)
        if failure == "wrong_chat":
            result[1]["chat"] = {"id": 456, "type": "private"}
        elif failure == "duplicate_ids":
            result[1]["message_id"] = result[0]["message_id"]
        elif failure == "missing_video":
            result[1].pop("video")
        elif failure == "mixed_group":
            result[1]["media_group_id"] = "group-2"
        elif failure == "partial":
            result.pop()
        elif failure == "caption_order":
            result[0]["caption"], result[1]["caption"] = result[1]["caption"], result[0]["caption"]
        return httpx.Response(200, json={"ok": True, "result": result})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        with pytest.raises(TelegramApiError) as caught:
            await TelegramClient("token", client=http).send_media_group(
                chat_id="123", clips=_clip_media(tmp_path), probe=ProbeInfo(), max_bytes=49_000_000,
            )
    assert requests == 1
    assert caught.value.code == ErrorCode.TELEGRAM_UPLOAD_FAILED
    assert caught.value.outcome == "ambiguous"


@pytest.mark.asyncio
async def test_media_group_timeout_is_ambiguous_one_shot_and_closes_every_handle(tmp_path, monkeypatch):
    clips = _clip_media(tmp_path)
    opened = []
    requests = 0
    original_open = Path.open

    def tracked_open(path, *args, **kwargs):
        handle = original_open(path, *args, **kwargs)
        if path in {clip_path for clip_path, _metadata in clips}:
            opened.append(handle)
        return handle

    monkeypatch.setattr(Path, "open", tracked_open)

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        raise httpx.ReadTimeout("response lost", request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        with pytest.raises(TelegramApiError) as caught:
            await TelegramClient("token", client=http).send_media_group(
                chat_id="123", clips=clips, probe=ProbeInfo(), max_bytes=49_000_000,
            )
    assert requests == 1
    assert caught.value.code == ErrorCode.TELEGRAM_UPLOAD_FAILED
    assert caught.value.outcome == "ambiguous"
    assert opened and all(handle.closed for handle in opened)


@pytest.mark.asyncio
async def test_media_group_does_not_retry_explicit_telegram_rate_limit(tmp_path):
    requests = 0

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal requests
        requests += 1
        return httpx.Response(429, json={"ok": False, "error_code": 429, "parameters": {"retry_after": 3}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        with pytest.raises(TelegramApiError) as caught:
            await TelegramClient("token", client=http).send_media_group(
                chat_id="123", clips=_clip_media(tmp_path), probe=ProbeInfo(), max_bytes=49_000_000,
            )
    assert requests == 1
    assert caught.value.code == ErrorCode.TELEGRAM_RATE_LIMITED
    assert caught.value.retry_after == 3


@pytest.mark.asyncio
@pytest.mark.parametrize(("extension", "mime_type"), [("m4a", "audio/mp4"), ("mp3", "audio/mpeg")])
async def test_music_is_uploaded_as_an_audio_file(tmp_path, extension, mime_type):
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/sendAudio")
        body = await request.aread()
        assert f'name="audio"; filename="track.{extension}"'.encode() in body
        assert mime_type.encode() in body
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 99}})

    path = tmp_path / f"track.{extension}"
    path.write_bytes(b"audio")
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = TelegramClient("token", client=http)
        message = await client.send_media(
            chat_id="123",
            path=path,
            metadata=MediaMetadata(filename=path.name, mimeType=mime_type, sizeBytes=5, hasAudio=True),
            probe=ProbeInfo(title="Track", extractor="youtube"),
            mode=MediaMode.AUDIO,
        )
    assert message.message_id == 99


@pytest.mark.asyncio
async def test_telegram_document_method_uses_document_multipart_field(tmp_path):
    received = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        received["path"] = request.url.path
        received["body"] = await request.aread()
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 100}})

    path = tmp_path / "clip.mp4"
    path.write_bytes(b"media")
    client = TelegramClient("token", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    message = await client.send_document(
        chat_id="123",
        path=path,
        metadata=MediaMetadata(filename="clip.mp4", mimeType="video/mp4", sizeBytes=5, hasVideo=True, hasAudio=True),
        probe=ProbeInfo(title="Clip", extractor="youtube"),
        mode=MediaMode.VIDEO,
    )
    assert message.message_id == 100
    assert received["path"].endswith("/sendDocument")
    assert b'name="document"' in received["body"]
    await client._client.aclose()


@pytest.mark.asyncio
async def test_telegram_video_url_uses_json_and_returns_file_id():
    received = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        received["content_type"] = request.headers["content-type"]
        received["body"] = await request.aread()
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 103, "video": {"file_id": "telegram-file-id"}}})

    client = TelegramClient("token", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    message = await client.send_video_url(
        chat_id="123",
        url="https://v16e.tiktokcdn.com/video.mp4?token=short-lived",
        metadata=MediaMetadata(filename="clip.mp4", mimeType="video/mp4", sizeBytes=5, hasVideo=True, hasAudio=True),
        probe=ProbeInfo(title="Clip", extractor="tiktok"),
    )

    assert message.message_id == 103
    assert message.file_id == "telegram-file-id"
    assert message.media_method == "sendVideo"
    assert received["content_type"] == "application/json"
    assert b'"video":"https://v16e.tiktokcdn.com/video.mp4?token=short-lived"' in received["body"]
    await client._client.aclose()


@pytest.mark.asyncio
async def test_image_video_request_uses_send_photo_for_jpeg(tmp_path):
    received = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        received["path"] = request.url.path
        received["body"] = await request.aread()
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 101}})

    path = tmp_path / "photo.jpg"
    path.write_bytes(b"image")
    client = TelegramClient("token", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    message = await client.send_media(
        chat_id="123",
        path=path,
        metadata=MediaMetadata(filename=path.name, mimeType="image/jpeg", sizeBytes=5, hasVideo=False),
        probe=ProbeInfo(title="Photo", extractor="instagram"),
        mode=MediaMode.VIDEO,
    )

    assert message.message_id == 101
    assert received["path"].endswith("/sendPhoto")
    assert b'name="photo"' in received["body"]
    await client._client.aclose()


@pytest.mark.asyncio
async def test_non_photo_image_uses_document_fallback(tmp_path):
    received = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        received["path"] = request.url.path
        received["body"] = await request.aread()
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 102}})

    path = tmp_path / "photo.webp"
    path.write_bytes(b"image")
    client = TelegramClient("token", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    message = await client.send_media(
        chat_id="123",
        path=path,
        metadata=MediaMetadata(filename=path.name, mimeType="image/webp", sizeBytes=5, hasVideo=False),
        probe=ProbeInfo(title="Photo", extractor="instagram"),
        mode=MediaMode.VIDEO,
    )

    assert message.message_id == 102
    assert received["path"].endswith("/sendDocument")
    assert b'name="document"' in received["body"]
    await client._client.aclose()


@pytest.mark.asyncio
async def test_telegram_429_is_stable_and_retryable():
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"ok": False, "error_code": 429, "parameters": {"retry_after": 3}})

    client = TelegramClient("token", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    with pytest.raises(TelegramApiError) as caught:
        await client.send_chat_action(chat_id="123", action="upload_video")
    assert caught.value.code == ErrorCode.TELEGRAM_RATE_LIMITED
    assert caught.value.retry_after == 3
    await client._client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status_code", "payload", "outcome"),
    [
        (302, {"ok": True, "result": {"message_id": 104}}, "ambiguous"),
        (404, {"ok": True, "result": {"message_id": 105}}, "rejected"),
        (200, {"ok": 1, "result": {"message_id": 106}}, "ambiguous"),
        (200, {"ok": "true", "result": {"message_id": 107}}, "ambiguous"),
    ],
)
async def test_telegram_success_requires_http_2xx_and_boolean_ok(status_code, payload, outcome):
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json=payload)

    client = TelegramClient("token", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    with pytest.raises(TelegramApiError) as caught:
        await client.send_video_url(
            chat_id="123",
            url="https://v16e.tiktokcdn.com/video.mp4?token=short-lived",
            metadata=MediaMetadata(filename="clip.mp4", mimeType="video/mp4", sizeBytes=5, hasVideo=True, hasAudio=True),
            probe=ProbeInfo(title="Clip", extractor="tiktok"),
        )
    assert caught.value.outcome == outcome
    await client._client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status_code", "payload", "error_code", "retry_after"),
    [
        (200, {"ok": False, "error_code": 429, "parameters": {"retry_after": 3}}, ErrorCode.TELEGRAM_RATE_LIMITED, 3),
        (503, {"ok": False, "error_code": 429, "parameters": {"retry_after": 3}}, ErrorCode.TELEGRAM_UPLOAD_FAILED, None),
    ],
)
async def test_telegram_body_rate_limit_is_only_explicit_in_http_2xx(status_code, payload, error_code, retry_after):
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json=payload)

    client = TelegramClient("token", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    with pytest.raises(TelegramApiError) as caught:
        await client.send_chat_action(chat_id="123", action="upload_video")
    assert caught.value.code == error_code
    assert caught.value.retry_after == retry_after
    await client._client.aclose()


@pytest.mark.asyncio
async def test_telegram_http_429_without_json_is_rate_limited_without_retry_metadata():
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, content=b"not-json")

    client = TelegramClient("token", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    with pytest.raises(TelegramApiError) as caught:
        await client.send_chat_action(chat_id="123", action="upload_video")
    assert caught.value.code == ErrorCode.TELEGRAM_RATE_LIMITED
    assert caught.value.retry_after is None
    assert caught.value.outcome == "rejected"
    await client._client.aclose()

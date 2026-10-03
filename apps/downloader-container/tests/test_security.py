from __future__ import annotations

import base64
import hashlib
import hmac
import json

import pytest

from downloader_container.errors import DownloadError, ErrorCode
from downloader_container.r2 import R2Uploader, sign_download_token
from downloader_container.security import (
    DEFAULT_ALLOWED_SOURCE_HOSTS,
    bearer_secret_matches,
    sanitize_filename,
    timing_safe_equal,
    validate_service_origin,
    validate_source_url,
)
from downloader_container.telegram import TelegramClient


def test_timing_safe_auth_accepts_only_bearer():
    assert timing_safe_equal("secret", "secret")
    assert bearer_secret_matches("secret", "Bearer secret")
    assert not bearer_secret_matches("secret", None)
    assert not bearer_secret_matches("", "Bearer ")
    assert not bearer_secret_matches("secret", "Bearer wrong")
    assert not bearer_secret_matches("secret", "Basic secret")


@pytest.mark.parametrize("url", ["file:///tmp/a", "data:text/plain,x", "ftp://example.com/a", "https://u:p@example.com/a"])
def test_rejects_non_http_or_credentials(url):
    with pytest.raises(DownloadError) as caught:
        validate_source_url(url, resolve_dns=False)
    assert caught.value.code == ErrorCode.INVALID_URL


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/a",
        "http://100.64.0.1/a",
        "http://169.254.169.254/latest",
        "http://[::1]/a",
        "http://[fec0::1]/a",
        "http://localhost/a",
    ],
)
def test_rejects_private_and_metadata_addresses(url):
    with pytest.raises(DownloadError) as caught:
        validate_source_url(url, resolve_dns=False)
    assert caught.value.code == ErrorCode.SOURCE_NETWORK_BLOCKED


@pytest.mark.parametrize(
    ("url", "hostname"),
    [
        ("https://www.youtube.com/watch?v=x", "www.youtube.com"),
        ("https://WWW.VIMEO.COM./123", "www.vimeo.com"),
        ("https://player.vimeo.com/video/123", "player.vimeo.com"),
        ("https://old.reddit.com/r/test/comments/abc/title", "old.reddit.com"),
        ("https://nm.reddit.com/r/test/comments/abc/title", "nm.reddit.com"),
        ("https://www.redditmedia.com/r/test/comments/abc/title", "www.redditmedia.com"),
        ("https://www.pinterest.com/pin/123/", "www.pinterest.com"),
        ("https://co.pinterest.com/pin/123/", "co.pinterest.com"),
        ("https://www.ted.com/talks/example", "www.ted.com"),
        ("https://embed-ssl.ted.com/talks/example", "embed-ssl.ted.com"),
    ],
)
def test_default_source_allowlist_accepts_only_explicit_normalized_hosts(url, hostname):
    assert (
        validate_source_url(url, allowed_hosts=DEFAULT_ALLOWED_SOURCE_HOSTS, resolve_dns=False).hostname
        == hostname
    )


@pytest.mark.parametrize(
    "url",
    [
        "https://evil-youtube.com/watch?v=x",
        "https://evil.youtube.com/watch?v=x",
        "https://vimeo.com.evil.example/123",
        "https://evil.vimeo.com/123",
        "https://reddit.com.evil.example/comments/abc",
        "https://media.reddit.com/comments/abc",
        "https://pinterest.com.evil.example/pin/123",
        "https://images.pinterest.com/pin/123",
        "https://ted.com.evil.example/talks/example",
        "https://ideas.ted.com/example",
        "https://pin.it/example",
        "https://redd.it/example",
        "https://v.redd.it/example",
    ],
)
def test_source_allowlist_rejects_lookalikes_unlisted_subdomains_and_shorteners(url):
    with pytest.raises(DownloadError) as caught:
        validate_source_url(url, allowed_hosts=DEFAULT_ALLOWED_SOURCE_HOSTS, resolve_dns=False)
    assert caught.value.code == ErrorCode.UNSUPPORTED_HOST


def test_host_allowlist_rejects_idna_confusion():
    with pytest.raises(DownloadError):
        validate_source_url("https://xn--localhost-9za.example/a", allowed_hosts={"example.com"}, resolve_dns=False)


def test_filename_and_r2_tokens_are_safe():
    assert sanitize_filename("../../a\x00b?.mp4") == "a_b_.mp4"
    token = sign_download_token(object_key="jobs/job/a.mp4", filename="a.mp4", expires_at=2_000_000_000, secret="s")
    # The Worker verifies this compact shape (tests/security.test.ts in the Worker).
    encoded, signature = token.split(".")
    digest = hmac.new(b"s", encoded.encode("ascii"), hashlib.sha256).digest()
    assert signature == base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
    assert payload == {"k": "jobs/job/a.mp4", "n": "a.mp4", "e": 2_000_000_000}


def test_service_origins_require_https_except_loopback_and_strip_trailing_slash():
    assert validate_service_origin("https://Example.com///") == "https://example.com"
    assert validate_service_origin("http://127.0.0.1:8080", allow_loopback_http=True) == "http://127.0.0.1:8080"
    assert validate_service_origin("http://[::1]:8080", allow_loopback_http=True) == "http://[::1]:8080"
    for value in (
        "http://example.com",
        "https://user:pass@example.com",
        "https://example.com/path",
        "https://example.com?token=x",
        "https://example.com#fragment",
    ):
        with pytest.raises(DownloadError):
            validate_service_origin(value, allow_loopback_http=True)


def test_telegram_and_r2_reject_insecure_or_non_origin_endpoints(settings):
    with pytest.raises(DownloadError) as telegram_error:
        TelegramClient("token", api_base="http://telegram.example")
    assert telegram_error.value.code == ErrorCode.INVALID_REQUEST

    settings.r2_endpoint = "http://127.0.0.1:9000"
    settings.r2_public_base_url = "http://127.0.0.1"
    with pytest.raises(DownloadError) as r2_error:
        R2Uploader(settings)
    assert r2_error.value.code == ErrorCode.R2_UPLOAD_FAILED

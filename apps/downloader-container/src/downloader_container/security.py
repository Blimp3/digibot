"""URL, secret, filename, and path safety helpers."""

from __future__ import annotations

import hmac
import ipaddress
import os
import re
import socket
import unicodedata
from dataclasses import dataclass
from urllib.parse import SplitResult, urlsplit, urlunsplit

from .errors import DownloadError, ErrorCode

MAX_DEFAULT_URL_LENGTH = 2048
_JOB_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9._()\[\]{}+@=,\- ]+")
_WHITESPACE_RE = re.compile(r"\s+")

DEFAULT_ALLOWED_SOURCE_HOSTS = frozenset(
    {
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        "youtu.be",
        "instagram.com",
        "www.instagram.com",
        "tiktok.com",
        "www.tiktok.com",
        "vm.tiktok.com",
        "vt.tiktok.com",
        "x.com",
        "www.x.com",
        "twitter.com",
        "www.twitter.com",
        "vimeo.com",
        "www.vimeo.com",
        "player.vimeo.com",
        "reddit.com",
        "www.reddit.com",
        "old.reddit.com",
        "np.reddit.com",
        "nm.reddit.com",
        "redditmedia.com",
        "www.redditmedia.com",
        "pinterest.com",
        "www.pinterest.com",
        "pinterest.ca",
        "www.pinterest.ca",
        "co.pinterest.com",
        "www.ted.com",
        "embed.ted.com",
        "embed-ssl.ted.com",
    }
)


@dataclass(frozen=True, slots=True)
class ValidatedUrl:
    original: str
    normalized: str
    hostname: str
    port: int | None


def timing_safe_equal(expected: str | bytes, supplied: str | bytes) -> bool:
    """Compare secrets without leaking length or content through early exits."""

    if isinstance(expected, str):
        expected = expected.encode("utf-8")
    if isinstance(supplied, str):
        supplied = supplied.encode("utf-8")
    # compare_digest is constant-time for equal-length values and still avoids
    # content-dependent short-circuiting for unequal lengths.
    return hmac.compare_digest(expected, supplied)


def bearer_secret_matches(expected: str, authorization: str | None) -> bool:
    """Accept only ``Authorization: Bearer <secret>``, as the Worker's Container wrapper sends."""

    scheme, _, value = (authorization or "").partition(" ")
    if not expected or scheme.lower() != "bearer":
        return False
    return timing_safe_equal(expected, value.strip())


def _idna_hostname(raw_hostname: str) -> str:
    hostname = unicodedata.normalize("NFKC", raw_hostname).rstrip(".").lower()
    if not hostname or any(char in hostname for char in "/\\@\x00"):
        raise DownloadError(ErrorCode.INVALID_URL)
    try:
        # IP literals do not pass through the IDNA codec (IPv6 contains ':').
        return str(ipaddress.ip_address(hostname))
    except ValueError:
        pass
    try:
        return hostname.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise DownloadError(ErrorCode.INVALID_URL) from exc


def _split_normalized(url: str) -> SplitResult:
    if len(url) > MAX_DEFAULT_URL_LENGTH:
        raise DownloadError(ErrorCode.INVALID_URL)
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in url):
        raise DownloadError(ErrorCode.INVALID_URL)
    try:
        parsed = urlsplit(url)
    except ValueError as exc:
        raise DownloadError(ErrorCode.INVALID_URL) from exc
    if parsed.scheme.lower() not in {"http", "https"}:
        raise DownloadError(ErrorCode.INVALID_URL)
    if not parsed.hostname or parsed.username is not None or parsed.password is not None:
        raise DownloadError(ErrorCode.INVALID_URL)
    hostname = _idna_hostname(parsed.hostname)
    try:
        port = parsed.port
    except ValueError as exc:
        raise DownloadError(ErrorCode.INVALID_URL) from exc
    if port is not None and not 1 <= port <= 65535:
        raise DownloadError(ErrorCode.INVALID_URL)
    netloc_host = f"[{hostname}]" if ":" in hostname else hostname
    netloc = netloc_host if port is None else f"{netloc_host}:{port}"
    return SplitResult(parsed.scheme.lower(), netloc, parsed.path or "/", parsed.query, parsed.fragment)


def _is_forbidden_ip(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return True
    # Require globally routable destinations. Enumerating only selected
    # special-use ranges is incomplete: for example, Python does not classify
    # the shared CGNAT range 100.64.0.0/10 as private or reserved.
    # Keep explicit metadata and deprecated site-local checks as defense in
    # depth and to make those particularly sensitive cases obvious.
    metadata = {
        ipaddress.ip_address("169.254.169.254"),
        ipaddress.ip_address("169.254.169.253"),
        ipaddress.ip_address("100.100.100.200"),
        ipaddress.ip_address("fd00:ec2::254"),
    }
    deprecated_site_local = ip.version == 6 and ip in ipaddress.ip_network("fec0::/10")
    return bool(
        not ip.is_global
        or ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
        or ip in metadata
        or deprecated_site_local
    )


def _resolve_addresses(hostname: str, port: int | None) -> set[str]:
    try:
        records = socket.getaddrinfo(hostname, port or 443, type=socket.SOCK_STREAM)
    except (OSError, socket.gaierror):
        # yt-dlp will provide the eventual source error.  Do not turn normal
        # DNS outages into an SSRF approval; fail closed for a cloud worker.
        raise DownloadError(ErrorCode.SOURCE_NETWORK_BLOCKED) from None
    return {str(record[4][0]) for record in records if record[4]}


def resolve_public_addresses(hostname: str, port: int | None = None) -> tuple[str, ...]:
    """Resolve a hostname and return only an all-public, connection-ready set.

    Mixed public/private answers fail closed so a caller can safely connect to
    one of the returned IP literals without a second DNS lookup.
    """

    normalized = _idna_hostname(hostname)
    try:
        literal = ipaddress.ip_address(normalized)
    except ValueError:
        literal = None
    addresses = {str(literal)} if literal is not None else _resolve_addresses(normalized, port)
    if not addresses or any(_is_forbidden_ip(address) for address in addresses):
        raise DownloadError(ErrorCode.SOURCE_NETWORK_BLOCKED)
    return tuple(sorted(addresses))


def host_is_allowed(hostname: str, allowed_hosts: set[str] | frozenset[str] | None) -> bool:
    if not allowed_hosts:
        return True
    normalized = _idna_hostname(hostname)
    lowered = {_idna_hostname(item) for item in allowed_hosts if item}
    # Match the Worker's initial-host policy exactly. Internal extractor/CDN
    # destinations are handled by yt-dlp and are not source-input allowlist
    # entries; an apex entry must never authorize arbitrary subdomains.
    return normalized in lowered


def validate_source_url(
    url: str,
    *,
    allowed_hosts: set[str] | frozenset[str] | None = None,
    resolve_dns: bool = True,
    max_length: int = MAX_DEFAULT_URL_LENGTH,
) -> ValidatedUrl:
    """Validate a source URL before passing it to yt-dlp.

    ``resolve_dns`` is injectable for deterministic tests. Production callers
    leave it enabled so a hostname resolving to a private address is rejected.
    """

    if not isinstance(url, str) or len(url) > max_length:
        raise DownloadError(ErrorCode.INVALID_URL)
    parsed = _split_normalized(url)
    hostname = _idna_hostname(parsed.hostname or "")
    if hostname in {"localhost", "localhost.localdomain"}:
        raise DownloadError(ErrorCode.SOURCE_NETWORK_BLOCKED)
    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        literal = None
    if literal is not None and _is_forbidden_ip(hostname):
        raise DownloadError(ErrorCode.SOURCE_NETWORK_BLOCKED)
    if not host_is_allowed(hostname, allowed_hosts):
        raise DownloadError(ErrorCode.UNSUPPORTED_HOST)
    if literal is None and resolve_dns:
        resolve_public_addresses(hostname, parsed.port)
    normalized = urlunsplit(parsed)
    return ValidatedUrl(url, normalized, hostname, parsed.port)


def validate_service_origin(
    value: str,
    *,
    allow_loopback_http: bool = False,
    error_code: ErrorCode = ErrorCode.INVALID_REQUEST,
) -> str:
    """Validate and normalize an internal HTTPS origin.

    Plain HTTP is accepted only for an explicitly local Bot API/R2 endpoint.
    Credentials, paths, query strings, and fragments are never allowed in an
    origin used to construct outbound requests or signed links.
    """

    if not isinstance(value, str) or not value or "?" in value or "#" in value:
        raise DownloadError(error_code)
    try:
        parsed = _split_normalized(value.rstrip("/"))
    except DownloadError:
        raise DownloadError(error_code) from None
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment or not parsed.hostname:
        raise DownloadError(error_code)
    hostname = _idna_hostname(parsed.hostname)
    if parsed.scheme == "http":
        try:
            is_loopback = ipaddress.ip_address(hostname).is_loopback
        except ValueError:
            is_loopback = hostname == "localhost"
        if not allow_loopback_http or not is_loopback:
            raise DownloadError(error_code)
    netloc_host = f"[{hostname}]" if ":" in hostname else hostname
    netloc = netloc_host if parsed.port is None else f"{netloc_host}:{parsed.port}"
    return f"{parsed.scheme}://{netloc}"


def validate_job_id(job_id: str) -> str:
    if not isinstance(job_id, str) or not _JOB_ID_RE.fullmatch(job_id):
        raise DownloadError(ErrorCode.INVALID_REQUEST)
    return job_id


def sanitize_filename(filename: str, fallback: str = "media", max_length: int = 180) -> str:
    """Produce a safe basename for local and R2 output paths."""

    value = unicodedata.normalize("NFKC", filename or "")
    # Treat path separators as basename boundaries before sanitization. This
    # removes traversal prefixes instead of preserving a run of dots.
    value = value.replace("\\", "/").rsplit("/", 1)[-1]
    value = "".join(char if ord(char) >= 0x20 and ord(char) != 0x7F else "_" for char in value)
    value = _SAFE_FILENAME_RE.sub("_", value)
    value = _WHITESPACE_RE.sub(" ", value).strip(" .")
    if value in {"", ".", ".."}:
        value = fallback
    if value.upper().split(".", 1)[0] in {"CON", "PRN", "AUX", "NUL"}:
        value = f"_{value}"
    return value[:max_length].rstrip(" .") or fallback


def safe_child_path(base: str | os.PathLike[str], child: str | os.PathLike[str]) -> str:
    """Resolve a child path and ensure it cannot escape ``base``."""

    base_path = os.path.realpath(os.fspath(base))
    child_path = os.path.realpath(os.fspath(child))
    try:
        common = os.path.commonpath((base_path, child_path))
    except ValueError as exc:
        raise DownloadError(ErrorCode.INVALID_REQUEST) from exc
    if common != base_path:
        raise DownloadError(ErrorCode.INVALID_REQUEST)
    return child_path

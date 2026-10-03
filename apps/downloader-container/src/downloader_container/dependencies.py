"""Runtime dependency discovery and startup diagnostics."""

from __future__ import annotations

import importlib.metadata
import importlib.util
import os
import re
import shutil
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path

from .config import Settings
from .errors import DownloadError, ErrorCode

_VERSION_RE = re.compile(r"(?<!\d)(\d+)(?:\.(\d+))?(?:\.(\d+))?")


@dataclass(frozen=True, slots=True)
class ExecutableDiagnostic:
    name: str
    path: str | None
    version: str | None
    supported: bool
    error: str | None = None

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class RuntimeInfo:
    name: str
    path: str
    version: str


def _version_tuple(value: str | None) -> tuple[int, int, int]:
    if not value:
        return (0, 0, 0)
    match = _VERSION_RE.search(value)
    if not match:
        return (0, 0, 0)
    parts = tuple(int(part or 0) for part in match.groups())
    return (parts[0], parts[1], parts[2])


def _version_text(command_output: str) -> str | None:
    line = next((line.strip() for line in command_output.splitlines() if line.strip()), "")
    return line[:128] or None


def run_fixed_version(path: str, args: tuple[str, ...], *, timeout: float = 5.0) -> tuple[str | None, str | None]:
    """Run a fixed version argument array without invoking a shell."""

    try:
        completed = subprocess.run(
            [path, *args],
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return None, type(exc).__name__
    output = _version_text(completed.stdout) or _version_text(completed.stderr)
    if completed.returncode != 0:
        return output, f"exit:{completed.returncode}"
    return output, None


def resolve_executable(explicit: str | None, name: str, *, extra_paths: tuple[str, ...] = ()) -> str | None:
    """Resolve an executable in preference, PATH, and known absolute locations."""

    candidates: list[str] = []
    if explicit:
        candidates.append(explicit)
    path_match = shutil.which(name)
    if path_match:
        candidates.append(path_match)
    candidates.extend(os.path.join(directory, name) for directory in extra_paths)
    for candidate in candidates:
        try:
            path = str(Path(candidate).expanduser().resolve(strict=True))
        except (OSError, RuntimeError):
            continue
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def _diagnose_binary(name: str, path: str | None, args: tuple[str, ...], minimum: tuple[int, int, int]) -> ExecutableDiagnostic:
    if path is None:
        return ExecutableDiagnostic(name, None, None, False, "not found")
    version, error = run_fixed_version(path, args)
    supported = error is None and _version_tuple(version) >= minimum
    if error is not None and version is None:
        return ExecutableDiagnostic(name, path, None, False, error)
    if not supported and error is None:
        error = f"version below {'.'.join(map(str, minimum))}"
    return ExecutableDiagnostic(name, path, version, supported, error)


def _ejs_diagnostic() -> ExecutableDiagnostic:
    try:
        version = importlib.metadata.version("yt-dlp-ejs")
    except importlib.metadata.PackageNotFoundError:
        version = None
    available = importlib.util.find_spec("yt_dlp_ejs") is not None
    return ExecutableDiagnostic("yt-dlp-ejs", None, version, available, None if available else "not found")


def resolve_js_runtime(settings: Settings) -> RuntimeInfo:
    """Return the supported Deno runtime; the images ship no other JavaScript runtime."""

    deno = resolve_executable(settings.deno_path, "deno", extra_paths=("/usr/local/bin", "/usr/bin"))
    deno_diag = _diagnose_binary("deno", deno, ("--version",), (2, 3, 0))
    if deno_diag.supported and deno_diag.path and deno_diag.version:
        return RuntimeInfo("deno", deno_diag.path, deno_diag.version)
    raise DownloadError(ErrorCode.DENO_MISSING, detail=deno_diag.error, retryable=False)


def collect_dependency_diagnostics(settings: Settings) -> dict[str, object]:
    """Return safe startup/health data (paths and versions only)."""

    yt_dlp = resolve_executable(settings.yt_dlp_path, "yt-dlp", extra_paths=("/usr/local/bin", "/usr/bin"))
    ffmpeg = resolve_executable(settings.ffmpeg_path, "ffmpeg", extra_paths=("/usr/local/bin", "/usr/bin"))
    ffprobe = resolve_executable(settings.ffprobe_path, "ffprobe", extra_paths=("/usr/local/bin", "/usr/bin"))
    deno = resolve_executable(settings.deno_path, "deno", extra_paths=("/usr/local/bin", "/usr/bin"))
    diagnostics = {
        "yt-dlp": _diagnose_binary("yt-dlp", yt_dlp, ("--version",), (2025, 1, 1)),
        "deno": _diagnose_binary("deno", deno, ("--version",), (2, 3, 0)),
        "ffmpeg": _diagnose_binary("ffmpeg", ffmpeg, ("-version",), (4, 0, 0)),
        "ffprobe": _diagnose_binary("ffprobe", ffprobe, ("-version",), (4, 0, 0)),
        "yt-dlp-ejs": _ejs_diagnostic(),
    }
    required = ["yt-dlp", "ffmpeg", "ffprobe", "yt-dlp-ejs"]
    if settings.job_operation == "transcript":
        diagnostics["whisper"] = _diagnose_binary("whisper", settings.whisper_path, ("--help",), (0, 0, 0))
        model = Path(settings.whisper_model_path)
        try:
            # The image build verifies SHA-256; health checks avoid hashing 488 MB on every call.
            model_ready = model.is_file() and model.stat().st_size == 487_601_967
        except OSError:
            model_ready = False
        diagnostics["whisper-model"] = ExecutableDiagnostic(
            "whisper-model", settings.whisper_model_path, "small", model_ready,
            None if model_ready else "model missing or wrong size",
        )
        required.extend(["whisper", "whisper-model"])
    deno_runtime = diagnostics["deno"]
    runtime = deno_runtime if deno_runtime.supported else ExecutableDiagnostic(
        "unavailable", None, None, False, deno_runtime.error or "Deno is installed but unsupported",
    )
    return {
        "runtime": asdict(runtime),
        "binaries": {name: value.as_dict() for name, value in diagnostics.items()},
        "ready": all(
            diagnostics[name].supported for name in required
        )
        and runtime.supported,
    }

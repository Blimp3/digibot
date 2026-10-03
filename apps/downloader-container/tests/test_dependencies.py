from __future__ import annotations

import pytest

from downloader_container import dependencies
from downloader_container.dependencies import ExecutableDiagnostic
from downloader_container.errors import DownloadError, ErrorCode


def _diagnostic(
    name: str,
    path: str | None,
    version: str | None,
    *,
    supported: bool,
    error: str | None = None,
) -> ExecutableDiagnostic:
    return ExecutableDiagnostic(name, path, version, supported, error)


@pytest.mark.parametrize("deno", [
    _diagnostic("deno", None, None, supported=False, error="not found"),
    _diagnostic("deno", "/usr/local/bin/deno", "deno 2.2.0", supported=False, error="version below 2.3.0"),
    _diagnostic("deno", "/usr/local/bin/deno", None, supported=False, error="PermissionError"),
])
def test_unusable_deno_fails_closed(settings, monkeypatch, deno):
    monkeypatch.setattr(dependencies, "resolve_executable", lambda _explicit, _name, **_kwargs: deno.path)
    monkeypatch.setattr(dependencies, "_diagnose_binary", lambda _name, _path, _args, _minimum: deno)

    with pytest.raises(DownloadError) as caught:
        dependencies.resolve_js_runtime(settings)

    assert caught.value.code == ErrorCode.DENO_MISSING


def test_health_is_not_ready_when_deno_is_unsupported(settings, monkeypatch):
    diagnostics = {
        "yt-dlp": _diagnostic("yt-dlp", "/app/.venv/bin/yt-dlp", "2026.7.4", supported=True),
        "deno": _diagnostic(
            "deno",
            "/usr/local/bin/deno",
            "deno 2.2.0",
            supported=False,
            error="version below 2.3.0",
        ),
        "ffmpeg": _diagnostic("ffmpeg", "/usr/bin/ffmpeg", "ffmpeg 8.0", supported=True),
        "ffprobe": _diagnostic("ffprobe", "/usr/bin/ffprobe", "ffprobe 8.0", supported=True),
        "yt-dlp-ejs": _diagnostic("yt-dlp-ejs", None, "0.8.0", supported=True),
    }

    monkeypatch.setattr(
        dependencies,
        "resolve_executable",
        lambda _explicit, name, **_kwargs: f"/usr/local/bin/{name}",
    )
    monkeypatch.setattr(
        dependencies,
        "_diagnose_binary",
        lambda name, _path, _args, _minimum: diagnostics[name],
    )
    monkeypatch.setattr(dependencies, "_ejs_diagnostic", lambda: diagnostics["yt-dlp-ejs"])

    health = dependencies.collect_dependency_diagnostics(settings)

    assert health["ready"] is False
    assert health["runtime"]["name"] == "unavailable"


def test_transcription_health_requires_its_model(settings, monkeypatch, tmp_path):
    monkeypatch.setattr(dependencies, "resolve_executable", lambda _explicit, name, **_kwargs: f"/bin/{name}")
    monkeypatch.setattr(dependencies, "_diagnose_binary", lambda name, path, *_args: _diagnostic(name, path, "1", supported=True))
    monkeypatch.setattr(dependencies, "_ejs_diagnostic", lambda: _diagnostic("yt-dlp-ejs", None, "1", supported=True))
    assert dependencies.collect_dependency_diagnostics(settings)["ready"] is True
    settings.job_operation = "transcript"
    settings.whisper_model_path = str(tmp_path / "missing-model.bin")
    result = dependencies.collect_dependency_diagnostics(settings)
    assert result["ready"] is False
    assert result["binaries"]["whisper-model"]["supported"] is False

"""Per-job temporary directories with traversal and disk-use guards."""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path

from .errors import DownloadError, ErrorCode
from .security import safe_child_path, validate_job_id


class JobWorkspace:
    def __init__(self, root: str | os.PathLike[str], job_id: str, *, max_bytes: int) -> None:
        self.root = Path(root)
        self.job_id = validate_job_id(job_id)
        self.max_bytes = max_bytes
        self.path = self.root / self.job_id
        self._entered = False
        self._retain = False

    def __enter__(self) -> JobWorkspace:
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.path.exists() or self.path.is_symlink():
            raise DownloadError(ErrorCode.INTERNAL_ERROR, detail="job workspace already exists")
        self.path.mkdir(mode=0o700)
        self._entered = True
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        if not self._entered or self._retain:
            self._entered = False
            return
        # Never follow a replacement symlink if an attacker races cleanup.
        if self.path.is_symlink():
            return
        try:
            shutil.rmtree(self.path)
        except FileNotFoundError:
            pass
        finally:
            self._entered = False

    def retain(self) -> None:
        """Keep a successful prepared artifact for the one-shot deliver call."""

        if not self._entered:
            raise RuntimeError("workspace is not active")
        self._retain = True

    @classmethod
    def cleanup_existing(cls, root: str | os.PathLike[str], job_id: str) -> None:
        """Remove one validated job directory after non-retryable delivery."""

        job_id = validate_job_id(job_id)
        path = Path(root) / job_id
        if path.is_symlink():
            return
        try:
            resolved_root = Path(root).resolve(strict=False)
            resolved_path = path.resolve(strict=True)
        except FileNotFoundError:
            return
        if resolved_path.parent != resolved_root:
            raise DownloadError(ErrorCode.INVALID_REQUEST)
        if resolved_path.is_dir():
            shutil.rmtree(resolved_path)

    @classmethod
    def cleanup_stale(cls, root: str | os.PathLike[str], *, max_age_seconds: int = 86_400) -> int:
        """Remove abandoned job directories left by a killed delivery."""

        root_path = Path(root)
        if not root_path.is_dir() or root_path.is_symlink():
            return 0
        cutoff = time.time() - max(60, max_age_seconds)
        removed = 0
        for path in root_path.iterdir():
            if path.is_symlink() or not path.is_dir():
                continue
            try:
                validate_job_id(path.name)
                if path.stat().st_mtime >= cutoff:
                    continue
                cls.cleanup_existing(root_path, path.name)
                removed += 1
            except (DownloadError, OSError):
                continue
        return removed

    def child(self, name: str) -> Path:
        candidate = Path(safe_child_path(self.path, self.path / name))
        if candidate.parent != self.path.resolve():
            raise DownloadError(ErrorCode.INVALID_REQUEST)
        return candidate

    def ensure_within(self, path: str | os.PathLike[str]) -> Path:
        return Path(safe_child_path(self.path, path))

    def prune(self, *keep: str) -> None:
        """Remove every entry except the named direct children."""

        for child in self.path.iterdir():
            if child.name in keep:
                continue
            if child.is_symlink() or not child.is_dir():
                child.unlink()
            else:
                shutil.rmtree(child)

    def current_size(self) -> int:
        total = 0
        for directory, dirs, files in os.walk(self.path, followlinks=False):
            dirs[:] = [entry for entry in dirs if not os.path.islink(os.path.join(directory, entry))]
            for filename in files:
                candidate = os.path.join(directory, filename)
                if os.path.islink(candidate):
                    continue
                try:
                    total += os.path.getsize(candidate)
                except OSError:
                    continue
                if total > self.max_bytes:
                    raise DownloadError(ErrorCode.SOURCE_SIZE_LIMIT)
        return total

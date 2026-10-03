"""Container service entry point and dependency diagnostic command."""

from __future__ import annotations

import argparse
import json
import os
import sys

from .app import create_app
from .config import Settings
from .dependencies import collect_dependency_diagnostics


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Private media downloader Container")
    parser.add_argument("--serve", action="store_true", help="start the HTTP service")
    parser.add_argument("--check-dependencies", action="store_true", help="print safe dependency diagnostics")
    parser.add_argument("--strict-dependencies", action="store_true", help="fail startup when a required dependency is missing")
    args = parser.parse_args(argv)
    settings = Settings.from_env()
    if args.check_dependencies:
        diagnostics = collect_dependency_diagnostics(settings)
        print(json.dumps(diagnostics, sort_keys=True))
        return 0 if diagnostics.get("ready") else 1
    if not args.serve:
        parser.error("choose --serve or --check-dependencies")
    if args.strict_dependencies:
        settings.strict_dependencies = True
    try:
        import uvicorn
    except ImportError:
        print("uvicorn is required to serve", file=sys.stderr)
        return 1
    uvicorn.run(
        create_app(settings),
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8080")),
        log_level=os.getenv("LOG_LEVEL", "info"),
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

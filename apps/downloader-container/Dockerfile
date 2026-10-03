# linux/amd64 is the initial Cloudflare Container target.
FROM --platform=linux/amd64 denoland/deno:bin-2.8.3 AS deno

FROM --platform=linux/amd64 python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/src \
    PATH=/app/.venv/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin \
    DENO_DIR=/tmp/deno \
    DENO_PATH=/usr/local/bin/deno \
    YT_DLP_PATH=/app/.venv/bin/yt-dlp \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    JOBS_ROOT=/tmp/media-jobs \
    PORT=8080

COPY --from=deno /deno /usr/local/bin/deno

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates ffmpeg passwd \
    && rm -rf /var/lib/apt/lists/* \
    && chmod 0755 /usr/local/bin/deno \
    && /usr/local/bin/deno --version

WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY src ./src

RUN python -m pip install --no-cache-dir --disable-pip-version-check 'uv==0.9.26' \
    && uv sync --frozen --no-dev

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin downloader \
    && mkdir -p /tmp/media-jobs /tmp/deno \
    && chown -R downloader:downloader /tmp/media-jobs /tmp/deno

USER downloader
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD ["python", "-m", "downloader_container", "--check-dependencies"]

CMD ["python", "-m", "downloader_container", "--serve", "--strict-dependencies"]

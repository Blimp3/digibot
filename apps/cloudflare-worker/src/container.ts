import { Container } from "@cloudflare/containers";
import { getWorkerConfig } from "./config";
import { constantTimeEqualString } from "./security";

/**
 * Private named container binding. The container image owns the actual
 * yt-dlp/FFmpeg process; this Worker-side class only protects the internal
 * HTTP surface and provides Cloudflare's current Container lifecycle config.
 */
export class DownloaderContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
  enableInternet = true;
  pingEndpoint = "health";
  envVars: Record<string, string> = {};

  override fetch(request: Request): Promise<Response> {
    return guardedContainerFetch(this, request, this.env, containerEnvironment);
  }
}

/**
 * Dedicated transcript runtime. It keeps the Worker authentication boundary,
 * but forwards health to the Python service so readiness observes the actual
 * image rather than only this Durable Object wrapper.
 */
export class TranscriptionContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
  enableInternet = true;
  pingEndpoint = "health";
  envVars: Record<string, string> = {};

  override fetch(request: Request): Promise<Response> {
    return guardedContainerFetch(this, request, this.env, transcriptionContainerEnvironment);
  }
}

/** Shared boundary: unauthenticated GET /health, 404 outside /v1/, bearer secret for /v1/. */
async function guardedContainerFetch(container: Container, request: Request, env: unknown, environment: typeof containerEnvironment): Promise<Response> {
  const url = new URL(request.url);
  container.envVars = environment(env as Record<string, unknown>);
  if (url.pathname === "/health" && request.method === "GET") return container.containerFetch(request);
  if (!url.pathname.startsWith("/v1/")) return new Response("Not Found", { status: 404 });
  const expected = (env as { INTERNAL_CONTAINER_SECRET?: string }).INTERNAL_CONTAINER_SECRET ?? "";
  const supplied = request.headers.get("authorization") ?? "";
  const token = supplied.startsWith("Bearer ") ? supplied.slice("Bearer ".length) : "";
  if (!expected || !token || !constantTimeEqualString(expected, token)) return new Response("Unauthorized", { status: 401 });
  return container.containerFetch(request);
}

export function containerEnvironment(env: Record<string, unknown>): Record<string, string> {
  const names = [
    "INTERNAL_CONTAINER_SECRET",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_BOT_API_BASE",
    "ALLOWED_SOURCE_HOSTS",
    "MAX_REQUEST_BODY_BYTES",
    "MAX_URL_LENGTH",
    "MAX_MEDIA_DURATION_SECONDS",
    "MAX_SOURCE_BYTES",
    "MAX_TEMP_DISK_BYTES",
    "MAX_TELEGRAM_BYTES",
    "JOB_TIMEOUT_SECONDS",
    "DOWNLOAD_TIMEOUT_SECONDS",
    "PROBE_TIMEOUT_SECONDS",
    "FFMPEG_TIMEOUT_SECONDS",
    "TELEGRAM_UPLOAD_TIMEOUT_SECONDS",
    "PROCESS_TERM_GRACE_SECONDS",
    "MAX_RETRIES",
    "STRICT_DEPENDENCIES",
    "R2_LINK_TTL_SECONDS",
    "R2_RETENTION_SECONDS",
    "PUBLIC_WORKER_BASE_URL",
    "R2_ENDPOINT",
    "R2_BUCKET_NAME",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "DOWNLOAD_LINK_HMAC_SECRET",
  ];
  const values = Object.fromEntries(names.flatMap((name) => {
    const value = env[name];
    return typeof value === "string" && value ? [[name, value]] : [];
  }));
  const aliases: Record<string, string> = {
    MAX_DURATION_SECONDS: "MAX_MEDIA_DURATION_SECONDS",
    MAX_SOURCE_DOWNLOAD_BYTES: "MAX_SOURCE_BYTES",
    TELEGRAM_UPLOAD_LIMIT_BYTES: "MAX_TELEGRAM_BYTES",
    R2_BUCKET: "R2_BUCKET_NAME",
    R2_LINK_LIFETIME_SECONDS: "R2_LINK_TTL_SECONDS",
  };
  for (const [alias, source] of Object.entries(aliases)) {
    const value = values[source];
    if (value) values[alias] = value;
  }
  const retention = values.R2_RETENTION_SECONDS;
  if (retention && !values.R2_RETENTION_HOURS) values.R2_RETENTION_HOURS = String(Math.max(1, Math.ceil(Number(retention) / 3600)));
  return values;
}

export function transcriptionContainerEnvironment(env: Record<string, unknown>): Record<string, string> {
  const values = containerEnvironment(env);
  const config = getWorkerConfig(env as never);
  for (const name of [
    "R2_ENDPOINT",
    "R2_BUCKET_NAME",
    "R2_BUCKET",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_LINK_TTL_SECONDS",
    "R2_LINK_LIFETIME_SECONDS",
    "R2_RETENTION_SECONDS",
    "R2_RETENTION_HOURS",
    "DOWNLOAD_LINK_HMAC_SECRET",
    "PUBLIC_WORKER_BASE_URL",
  ]) delete values[name];
  values.JOB_OPERATION = "transcript";
  values.JOB_TIMEOUT_SECONDS = String(config.transcriptionTimeoutSeconds);
  values.MAX_MEDIA_DURATION_SECONDS = String(config.maxTranscriptDurationSeconds);
  values.MAX_DURATION_SECONDS = values.MAX_MEDIA_DURATION_SECONDS;
  values.WHISPER_THREADS = "2";
  return values;
}

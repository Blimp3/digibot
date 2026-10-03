import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({
  Container: class {},
}));

import { containerEnvironment, DownloaderContainer, TranscriptionContainer, transcriptionContainerEnvironment } from "../src/container";

describe("Container environment contract", () => {
  it("passes configured limits and aliases through to the Python service", () => {
    expect(containerEnvironment({
      MAX_REQUEST_BODY_BYTES: "32768",
      MAX_URL_LENGTH: "4096",
      MAX_MEDIA_DURATION_SECONDS: "3600",
      MAX_SOURCE_BYTES: "123456",
      MAX_TEMP_DISK_BYTES: "987654321",
      MAX_TELEGRAM_BYTES: "49000000",
      JOB_TIMEOUT_SECONDS: "1200",
      DOWNLOAD_TIMEOUT_SECONDS: "1200",
      PROBE_TIMEOUT_SECONDS: "90",
      FFMPEG_TIMEOUT_SECONDS: "600",
      TELEGRAM_UPLOAD_TIMEOUT_SECONDS: "600",
      PROCESS_TERM_GRACE_SECONDS: "10",
      MAX_RETRIES: "2",
      STRICT_DEPENDENCIES: "true",
      R2_BUCKET_NAME: "private-media",
      R2_ENDPOINT: "https://account-id.r2.cloudflarestorage.com",
      R2_LINK_TTL_SECONDS: "900",
      R2_RETENTION_SECONDS: "7200",
    })).toMatchObject({
      MAX_REQUEST_BODY_BYTES: "32768",
      MAX_URL_LENGTH: "4096",
      MAX_DURATION_SECONDS: "3600",
      MAX_SOURCE_DOWNLOAD_BYTES: "123456",
      MAX_TEMP_DISK_BYTES: "987654321",
      TELEGRAM_UPLOAD_LIMIT_BYTES: "49000000",
      JOB_TIMEOUT_SECONDS: "1200",
      DOWNLOAD_TIMEOUT_SECONDS: "1200",
      PROBE_TIMEOUT_SECONDS: "90",
      FFMPEG_TIMEOUT_SECONDS: "600",
      TELEGRAM_UPLOAD_TIMEOUT_SECONDS: "600",
      PROCESS_TERM_GRACE_SECONDS: "10",
      MAX_RETRIES: "2",
      STRICT_DEPENDENCIES: "true",
      R2_BUCKET: "private-media",
      R2_ENDPOINT: "https://account-id.r2.cloudflarestorage.com",
      R2_LINK_LIFETIME_SECONDS: "900",
      R2_RETENTION_HOURS: "2",
    });
  });

  it("isolates transcript runtime from R2 credentials and applies bounded ASR settings", () => {
    const values = transcriptionContainerEnvironment({
      MAX_TRANSCRIPT_DURATION_SECONDS: "900",
      TRANSCRIPTION_TIMEOUT_SECONDS: "1800",
      MAX_MEDIA_DURATION_SECONDS: "7200",
      R2_ENDPOINT: "https://r2.example",
      R2_BUCKET_NAME: "private-media",
      R2_ACCESS_KEY_ID: "access",
      R2_SECRET_ACCESS_KEY: "secret",
      DOWNLOAD_LINK_HMAC_SECRET: "hmac",
      GGML_BACKEND_PATH: "/tmp/media-jobs",
    });
    expect(values).toMatchObject({ JOB_OPERATION: "transcript", WHISPER_THREADS: "2", JOB_TIMEOUT_SECONDS: "1800", MAX_MEDIA_DURATION_SECONDS: "900", MAX_DURATION_SECONDS: "900" });
    expect(values).not.toHaveProperty("R2_ENDPOINT");
    expect(values).not.toHaveProperty("R2_ACCESS_KEY_ID");
    expect(values).not.toHaveProperty("R2_SECRET_ACCESS_KEY");
    expect(values).not.toHaveProperty("DOWNLOAD_LINK_HMAC_SECRET");
    expect(values).not.toHaveProperty("GGML_BACKEND_PATH");
  });
});

describe.each([
  ["DownloaderContainer", DownloaderContainer, containerEnvironment],
  ["TranscriptionContainer", TranscriptionContainer, transcriptionContainerEnvironment],
] as const)("%s boundary", (_name, ContainerClass, environment) => {
  function container(env: Record<string, unknown> = { INTERNAL_CONTAINER_SECRET: "secret" }) {
    const instance = Object.create(ContainerClass.prototype) as InstanceType<typeof ContainerClass>;
    const containerFetch = vi.fn(async () => new Response("python"));
    Object.assign(instance, { env, containerFetch });
    return { instance, containerFetch };
  }
  const job = (authorization?: string) => new Request("https://downloader.internal/v1/jobs/run", {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });

  it("boots the container with its own environment and forwards unauthenticated GET /health", async () => {
    // R2 and link-signing secrets reach the downloader only; the transcription builder strips them.
    const env = { INTERNAL_CONTAINER_SECRET: "secret", R2_ACCESS_KEY_ID: "access", R2_SECRET_ACCESS_KEY: "r2-secret", DOWNLOAD_LINK_HMAC_SECRET: "hmac" };
    const { instance, containerFetch } = container(env);
    const response = await instance.fetch(new Request("https://downloader.internal/health"));
    expect(await response.text()).toBe("python");
    expect(containerFetch).toHaveBeenCalledOnce();
    expect(instance.envVars).toEqual(environment(env));
  });

  it("still rejects unknown paths and unauthenticated /v1/ requests", async () => {
    const { instance, containerFetch } = container();
    expect((await instance.fetch(new Request("https://downloader.internal/other"))).status).toBe(404);
    expect((await instance.fetch(job())).status).toBe(401);
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it("forwards /v1/ only with the matching bearer secret", async () => {
    const { instance, containerFetch } = container();
    expect((await instance.fetch(job("Bearer wrong"))).status).toBe(401);
    expect(containerFetch).not.toHaveBeenCalled();
    expect(await (await instance.fetch(job("Bearer secret"))).text()).toBe("python");
    expect(containerFetch).toHaveBeenCalledOnce();
  });

  it("rejects every /v1/ request when the secret is not configured", async () => {
    const { instance, containerFetch } = container({});
    expect((await instance.fetch(job("Bearer "))).status).toBe(401);
    expect((await instance.fetch(job("Bearer secret"))).status).toBe(401);
    expect(containerFetch).not.toHaveBeenCalled();
  });
});

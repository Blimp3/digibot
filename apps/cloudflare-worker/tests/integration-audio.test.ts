import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { encryptSourceUrl } from "../src/crypto";
import { prepareIntegrationAudio, type IntegrationAudioEnv } from "../src/integration-audio";

const ACCOUNT_A = "account-a";
const ACCOUNT_B = "account-b";
const OPERATION_A = "123e4567-e89b-42d3-a456-426614174000";
const OPERATION_B = "123e4567-e89b-42d3-a456-426614174001";

function operation(account_id: string, id: string, segment = { startSeconds: 5, endSeconds: 20 }) {
  return {
    account_id,
    id,
    source_cipher: "pending",
    segment_json: JSON.stringify(segment),
    expires_at: "2099-01-01T00:00:00.000Z",
  } as const;
}

async function environment(content = new TextEncoder().encode("mp3-segment"), expectedOperation = OPERATION_A) {
  const sourceUrl = "https://youtu.be/example";
  const cipher = await encryptSourceUrl("download-secret", sourceUrl);
  const objects = new Map<string, Uint8Array>();
  const calls: Request[] = [];
  const fetch = vi.fn(async (request: Request) => {
    calls.push(request);
    const body = await request.clone().json() as Record<string, unknown>;
    expect(body.sourceUrl).toBe(sourceUrl);
    expect(body.operationId).toBe(expectedOperation);
    const sha = createHash("sha256").update(content).digest("hex");
    return new Response(content, {
      headers: {
        "content-type": "audio/mpeg",
        "x-digibot-media-sha256": sha,
        "x-digibot-media-byte-length": String(content.byteLength),
        "x-digibot-media-duration-seconds": "15.25",
      },
    });
  });
  const put = vi.fn(async (key: string, value: Uint8Array) => { objects.set(key, new Uint8Array(value)); });
  const del = vi.fn(async (key: string) => { objects.delete(key); });
  const env = {
    DOWNLOAD_LINK_HMAC_SECRET: "download-secret",
    INTERNAL_CONTAINER_SECRET: "container-secret",
    DOWNLOADER_CONTAINER: { getByName: vi.fn(() => ({ fetch })) },
    MEDIA_BUCKET: { put, delete: del },
  } as unknown as IntegrationAudioEnv;
  return { env, cipher, sourceUrl, calls, objects, put, del };
}

describe("processing-only integration audio adapter", () => {
  it("decrypts privately, bounds the container call, and stores account-scoped MP3 bytes", async () => {
    const fixture = await environment();
    const result = await prepareIntegrationAudio(fixture.env, { ...operation(ACCOUNT_A, OPERATION_A), source_cipher: fixture.cipher });

    expect(result.input).toEqual({
      version: 1,
      operationId: OPERATION_A,
      action: "check",
      forceRecheck: false,
      media: {
        mediaSha256: createHash("sha256").update("mp3-segment").digest("hex"),
        byteLength: 11,
        mimeType: "audio/mpeg",
        inputKind: "derived_audio_segment",
        audioDurationSeconds: 15.25,
        segment: { startSeconds: 5, endSeconds: 20 },
        fullSourceSha256: null,
      },
    });
    expect(result.tempKey).toBe(`integration/${ACCOUNT_A}/${OPERATION_A}/audio.mp3`);
    expect([...fixture.objects.get(result.tempKey)!]).toEqual([...new TextEncoder().encode("mp3-segment")]);
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]!.url).toContain("/v1/integration/audio/prepare");
    expect(fixture.calls[0]!.headers.get("authorization")).toBe("Bearer container-secret");
    expect(fixture.calls[0]!.headers.get("x-digibot-deadline-at")).toBeTruthy();
  });

  it("keeps different accounts in different temporary namespaces", async () => {
    const first = await environment();
    const resultA = await prepareIntegrationAudio(first.env, { ...operation(ACCOUNT_A, OPERATION_A), source_cipher: first.cipher });
    const second = await environment(new TextEncoder().encode("mp3-segment"), OPERATION_B);
    const resultB = await prepareIntegrationAudio(second.env, { ...operation(ACCOUNT_B, OPERATION_B), source_cipher: second.cipher });

    expect(resultA.tempKey).not.toBe(resultB.tempKey);
    expect(resultA.tempKey).toContain(`/${ACCOUNT_A}/`);
    expect(resultB.tempKey).toContain(`/${ACCOUNT_B}/`);
  });

  it("rejects invalid ranges and exact output size/hash changes before storage", async () => {
    const fixture = await environment();
    await expect(prepareIntegrationAudio(fixture.env, {
      ...operation(ACCOUNT_A, OPERATION_A, { startSeconds: 5, endSeconds: 66 }),
      source_cipher: fixture.cipher,
    })).rejects.toMatchObject({ code: "invalid_audio" });

    const mismatch = await environment(new TextEncoder().encode("different"));
    mismatch.env.DOWNLOADER_CONTAINER = {
      getByName: vi.fn(() => ({
        fetch: vi.fn(async () => new Response(new TextEncoder().encode("different"), {
          headers: {
            "content-type": "audio/mpeg",
            "x-digibot-media-sha256": "0".repeat(64),
            "x-digibot-media-byte-length": "9",
            "x-digibot-media-duration-seconds": "1",
          },
        })),
      })),
    } as unknown as NonNullable<IntegrationAudioEnv["DOWNLOADER_CONTAINER"]>;
    await expect(prepareIntegrationAudio(mismatch.env, { ...operation(ACCOUNT_A, OPERATION_A), source_cipher: mismatch.cipher }))
      .rejects.toMatchObject({ code: "invalid_audio" });
    expect(mismatch.put).not.toHaveBeenCalled();
  });

  it("deletes a partially written object when temporary storage fails", async () => {
    const fixture = await environment();
    fixture.env.MEDIA_BUCKET = {
      put: vi.fn(async () => { throw new Error("storage down"); }),
      delete: fixture.del,
    } as unknown as NonNullable<IntegrationAudioEnv["MEDIA_BUCKET"]>;
    await expect(prepareIntegrationAudio(fixture.env, { ...operation(ACCOUNT_A, OPERATION_A), source_cipher: fixture.cipher }))
      .rejects.toMatchObject({ code: "extraction_unavailable" });
    expect(fixture.del).toHaveBeenCalledWith(`integration/${ACCOUNT_A}/${OPERATION_A}/audio.mp3`);
  });

  it("preserves retryable extraction failures returned in the container result", async () => {
    const fixture = await environment();
    fixture.env.DOWNLOADER_CONTAINER = {
      getByName: () => ({ fetch: async () => Response.json({ status: "failed", retryable: true }) }),
    } as unknown as IntegrationAudioEnv["DOWNLOADER_CONTAINER"];
    await expect(prepareIntegrationAudio(fixture.env, { ...operation(ACCOUNT_A, OPERATION_A), source_cipher: fixture.cipher }))
      .rejects.toMatchObject({ code: "extraction_unavailable", retryable: true });
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it("cancels a stalled audio response before retaining any bytes", async () => {
    const fixture = await environment();
    const cancel = vi.fn();
    fixture.env.DOWNLOADER_CONTAINER = {
      getByName: () => ({ fetch: async () => new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "audio/mpeg", "x-digibot-media-sha256": "0".repeat(64),
          "x-digibot-media-byte-length": "10", "x-digibot-media-duration-seconds": "1" },
      }) }),
    } as unknown as IntegrationAudioEnv["DOWNLOADER_CONTAINER"];
    vi.useFakeTimers();
    try {
      const pending = expect(prepareIntegrationAudio(fixture.env, { ...operation(ACCOUNT_A, OPERATION_A), source_cipher: fixture.cipher }))
        .rejects.toMatchObject({ code: "request_timeout", retryable: true });
      await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(15_000);
      await pending;
      expect(cancel).toHaveBeenCalledOnce();
      expect(fixture.put).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

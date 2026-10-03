import { describe, expect, it, vi } from "vitest";
import { cleanupExpiredR2Jobs, handleDownloadRequest } from "../src/r2";
import { createDownloadToken } from "../src/security";
import type { D1DatabaseLike, D1PreparedStatementLike, Env, JobRecord, R2BucketLike } from "../src/types";

interface CapturedStatement {
  sql: string;
  values: unknown[];
}

function envFor(bucket: R2BucketLike | undefined, db?: D1DatabaseLike): Env {
  return {
    DB: db ?? { prepare: () => { throw new Error("unused"); } },
    MEDIA_BUCKET: bucket,
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_WEBHOOK_SECRET: "secret",
    INTERNAL_CONTAINER_SECRET: "internal",
    ALLOWED_TELEGRAM_USER_IDS: "1,2",
    DOWNLOAD_LINK_HMAC_SECRET: "hmac",
  } as unknown as Env;
}

function cleanupDb(rows: JobRecord[], clearChanges = 1): { db: D1DatabaseLike; calls: CapturedStatement[] } {
  const calls: CapturedStatement[] = [];
  const db: D1DatabaseLike = {
    prepare: (sql) => {
      const call: CapturedStatement = { sql, values: [] };
      calls.push(call);
      const statement: D1PreparedStatementLike = {
        bind: (...values) => {
          call.values = values;
          return statement;
        },
        first: async () => null,
        all: async <T>() => ({ results: rows as T[] }),
        run: async () => ({
          success: true,
          meta: { changes: sql.includes("SET r2_object_key = NULL") ? clearChanges : 0 },
        }),
      };
      return statement;
    },
  };
  return { db, calls };
}

function expiredR2Job(objectKey: string): JobRecord {
  return {
    id: "job-a",
    telegram_update_id: "update-a",
    telegram_user_id: "user-a",
    telegram_chat_id: "chat-a",
    request_message_id: "1",
    waiting_message_id: null,
    result_message_id: "2",
    source_host: "youtube.com",
    source_url_hash: "hash",
    source_url_encrypted: null,
    requested_mode: "video",
    requested_quality: "max-1080p",
    processing_policy_version: "v1",
    cache_valid: 1,
    status: "completed",
    progress: 100,
    output_filename: "video.mp4",
    output_mime_type: "video/mp4",
    output_size_bytes: 100,
    output_duration_seconds: 2,
    r2_object_key: objectKey,
    error_code: null,
    safe_error_message: null,
    created_at: "2026-08-18T00:00:00.000Z",
    updated_at: "2026-08-18T00:01:00.000Z",
    completed_at: "2026-08-18T00:01:00.000Z",
    expires_at: "2026-08-18T01:00:00.000Z",
  };
}

describe("R2 download route", () => {
  async function downloadRequest(method = "GET", range?: string, exp = Math.floor(Date.now() / 1000) + 300): Promise<Request> {
    const token = await createDownloadToken("hmac", {
      objectKey: "jobs/123e4567-e89b-12d3-a456-426614174000/video.mp4",
      filename: "video.mp4", mimeType: "video/mp4", exp,
    });
    return new Request(`https://worker.example/download/${token}`, { method, headers: range ? { range } : {} });
  }

  function rangeBucket() {
    return {
      head: vi.fn(async () => ({ size: 5, etag: "version-1", httpMetadata: { contentType: "video/mp4" } })),
      get: vi.fn(async (_key: string, options?: { range?: { offset: number; length: number } }) => ({
        size: 5,
        body: new Response(options?.range ? "hello".slice(options.range.offset, options.range.offset + options.range.length) : "hello").body,
      })),
      put: async () => undefined,
      delete: async () => undefined,
    };
  }

  it.each([
    ["bytes=1-3", "ell", "bytes 1-3/5"],
    ["bytes=3-", "lo", "bytes 3-4/5"],
    ["bytes=-2", "lo", "bytes 3-4/5"],
    ["bytes=0-99", "hello", "bytes 0-4/5"],
    ["bytes=-99", "hello", "bytes 0-4/5"],
  ])("streams only the requested single range: %s", async (range, body, contentRange) => {
    const bucket = rangeBucket();
    const response = await handleDownloadRequest(await downloadRequest("GET", range), envFor(bucket));
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(contentRange);
    expect(response.headers.get("content-length")).toBe(String(body.length));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe(body);
    expect(bucket.get.mock.calls[0]?.[1]).toMatchObject({ onlyIf: { etagMatches: "version-1" } });
  });

  it.each(["bytes=5-", "bytes=3-1", "bytes=-0", "bytes=", "bytes=0-1,3-4", "items=0-1", "bytes=9007199254740992-", "bytes=0-9007199254740992"])("rejects invalid/multiple ranges without reading object data: %s", async (range) => {
    const bucket = rangeBucket();
    const response = await handleDownloadRequest(await downloadRequest("GET", range), envFor(bucket));
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */5");
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it("serves authenticated HEAD metadata without fetching data, ignoring Range", async () => {
    const bucket = rangeBucket();
    const response = await handleDownloadRequest(await downloadRequest("HEAD", "bytes=1-2"), envFor(bucket));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("5");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(await response.text()).toBe("");
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it("validates tokens before metadata or data access for HEAD and range GET", async () => {
    const bucket = rangeBucket();
    for (const method of ["HEAD", "GET"]) {
      expect((await handleDownloadRequest(await downloadRequest(method, "bytes=1-2", 1), envFor(bucket))).status).toBe(404);
    }
    expect(bucket.head).not.toHaveBeenCalled();
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it("does not serve a replacement object after the metadata version changes", async () => {
    const bucket = { ...rangeBucket(), get: vi.fn(async () => ({ size: 8 })) };
    const response = await handleDownloadRequest(await downloadRequest("GET", "bytes=1-2"), envFor(bucket as unknown as R2BucketLike));
    expect(response.status).toBe(412);
    expect(await response.text()).toBe("");
  });

  it("returns 404 when the object disappears before ranged GET", async () => {
    const bucket = { ...rangeBucket(), get: vi.fn(async () => null) };
    expect((await handleDownloadRequest(await downloadRequest("GET", "bytes=1-2"), envFor(bucket))).status).toBe(404);
  });

  it("streams the object with safe download headers", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.close();
      },
    });
    const bucket: R2BucketLike = {
      get: async () => ({ body, size: 5, httpMetadata: { contentType: "video/mp4" } }),
      put: async () => undefined,
      delete: async () => undefined,
    };
    const token = await createDownloadToken("hmac", {
      objectKey: "jobs/123e4567-e89b-12d3-a456-426614174000/video.mp4",
      filename: "video.mp4",
      mimeType: "video/mp4",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const response = await handleDownloadRequest(new Request(`https://worker.example/download/${token}`), envFor(bucket));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("5");
    expect(response.headers.get("content-disposition")).toContain("video.mp4");
    expect(await response.text()).toBe("hello");
  });

  it("rejects expired and modified tokens", async () => {
    const bucket: R2BucketLike = { get: async () => null, put: async () => undefined, delete: async () => undefined };
    const token = await createDownloadToken("hmac", {
      objectKey: "jobs/123e4567-e89b-12d3-a456-426614174000/video.mp4",
      filename: "video.mp4",
      mimeType: "video/mp4",
      exp: 1,
    });
    const environment = envFor(bucket);
    expect((await handleDownloadRequest(new Request(`https://worker.example/download/${token}`), environment)).status).toBe(404);
    expect((await handleDownloadRequest(new Request(`https://worker.example/download/${token}x`), environment)).status).toBe(404);
  });
});

describe("expired R2 cleanup", () => {
  it("deletes a validated job object, then clears only its pointer and retains metadata", async () => {
    const objectKey = "jobs/job-a/video.mp4";
    const job = expiredR2Job(objectKey);
    const deletedKeys: string[] = [];
    const bucket: R2BucketLike = {
      get: async () => null,
      put: async () => undefined,
      delete: async (key) => {
        deletedKeys.push(key);
      },
    };
    const { db, calls } = cleanupDb([job]);
    const now = new Date("2026-08-19T00:00:00.000Z");

    await expect(cleanupExpiredR2Jobs(envFor(bucket, db), now)).resolves.toBe(1);

    expect(deletedKeys).toEqual([objectKey]);
    expect(calls[0]?.sql).toContain("expires_at <= ?1");
    expect(calls[0]?.sql).toContain("r2_object_key IS NOT NULL");
    const clear = calls.find((call) => call.sql.includes("SET r2_object_key = NULL"));
    expect(clear?.values).toEqual([job.id, objectKey, now.toISOString(), now.toISOString()]);
    expect(calls.some((call) => call.sql.includes("DELETE FROM jobs"))).toBe(false);
  });

  it("retains the row and key when R2 deletion fails", async () => {
    const objectKey = "jobs/job-a/video.mp4";
    const bucket: R2BucketLike = {
      get: async () => null,
      put: async () => undefined,
      delete: vi.fn(async () => {
        throw new Error("R2 unavailable");
      }),
    };
    const { db, calls } = cleanupDb([expiredR2Job(objectKey)]);

    await expect(cleanupExpiredR2Jobs(envFor(bucket, db), new Date("2026-08-19T00:00:00.000Z"))).resolves.toBe(0);

    expect(bucket.delete).toHaveBeenCalledWith(objectKey);
    expect(calls.some((call) => call.sql.includes("SET r2_object_key = NULL"))).toBe(false);
    expect(calls.some((call) => call.sql.includes("DELETE FROM jobs"))).toBe(false);
  });

  it("does not delete an unvalidated object key", async () => {
    const bucket: R2BucketLike = {
      get: async () => null,
      put: async () => undefined,
      delete: vi.fn(async () => undefined),
    };
    const { db, calls } = cleanupDb([expiredR2Job("jobs/another-job/video.mp4")]);

    await expect(cleanupExpiredR2Jobs(envFor(bucket, db), new Date("2026-08-19T00:00:00.000Z"))).resolves.toBe(0);

    expect(bucket.delete).not.toHaveBeenCalled();
    expect(calls.some((call) => call.sql.includes("SET r2_object_key = NULL"))).toBe(false);
  });

  it("retains expired metadata when the bucket binding is unavailable", async () => {
    const { db, calls } = cleanupDb([expiredR2Job("jobs/job-a/video.mp4")]);

    await expect(cleanupExpiredR2Jobs(envFor(undefined, db), new Date("2026-08-19T00:00:00.000Z"))).resolves.toBe(0);

    expect(calls.some((call) => call.sql.includes("SET r2_object_key = NULL"))).toBe(false);
  });

  it("does not clear a newer pointer after deletion of the expired object", async () => {
    const bucket = { get: async () => null, put: async () => undefined, delete: vi.fn(async () => undefined) };
    const { db, calls } = cleanupDb([expiredR2Job("jobs/job-a/video.mp4")], 0);
    expect(await cleanupExpiredR2Jobs(envFor(bucket, db), new Date("2026-08-19T00:00:00Z"))).toBe(0);
    expect(bucket.delete).toHaveBeenCalledOnce();
    expect(calls.find((call) => call.sql.includes("SET r2_object_key = NULL"))?.sql).toContain("r2_object_key = ?2");
  });
});

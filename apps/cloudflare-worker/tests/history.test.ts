import { describe, expect, it, vi } from "vitest";
import { handleDownloaderApi, historyItemForJob } from "../src/history";
import { createDownloaderMiniAppStorage } from "../src/downloader-storage";
import { resolveMiniAppRoute } from "../src/mini-app-router";
import type { DownloaderApiEndpoint } from "../src/mini-app-router";
import type { D1DatabaseLike, D1PreparedStatementLike, Env, JobRecord, R2BucketLike } from "../src/types";

const encoder = new TextEncoder();
const BOT_TOKEN = "history-test-token";
const USER_ID = "12345";

async function hmac(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(keyBytes).buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authorization(userId = USER_ID): Promise<string> {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "opaque-query",
    user: JSON.stringify({ id: Number(userId), first_name: "History" }),
  };
  const dataCheckString = Object.entries(fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = await hmac(encoder.encode("WebAppData"), BOT_TOKEN);
  const hash = hex(await hmac(secretKey, dataCheckString));
  return `tma ${new URLSearchParams({ ...fields, hash }).toString()}`;
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-a",
    telegram_update_id: "update-a",
    telegram_user_id: USER_ID,
    telegram_chat_id: USER_ID,
    request_message_id: "1",
    waiting_message_id: "2",
    result_message_id: "3",
    source_host: "youtube.com",
    source_url_hash: "do-not-expose-hash",
    source_url_encrypted: "do-not-expose-url",
    requested_mode: "video",
    requested_quality: "max-1080p",
    processing_policy_version: "v1",
    cache_valid: 1,
    status: "completed",
    progress: 100,
    output_filename: "safe title.mp4",
    output_mime_type: "video/mp4",
    output_size_bytes: 4096,
    output_duration_seconds: 12,
    r2_object_key: null,
    error_code: null,
    safe_error_message: null,
    created_at: "2026-08-19T10:00:00.000Z",
    updated_at: "2026-08-19T10:01:00.000Z",
    completed_at: "2026-08-19T10:01:00.000Z",
    expires_at: null,
    ...overrides,
  };
}

interface CapturedCall {
  sql: string;
  values: unknown[];
}

function statefulDb(initialRows: JobRecord[]): { db: D1DatabaseLike; calls: CapturedCall[]; rows: JobRecord[] } {
  const calls: CapturedCall[] = [];
  const rows = [...initialRows];
  const db: D1DatabaseLike = {
    prepare: (sql) => {
      const call: CapturedCall = { sql, values: [] };
      calls.push(call);
      const prepared: D1PreparedStatementLike = {
        bind: (...values) => {
          call.values = values;
          return prepared;
        },
        first: async <T>() => {
          if (!sql.includes("FROM jobs")) return null;
          const [id, userId] = call.values;
          return (rows.find((row) => row.id === id && row.telegram_user_id === userId) as T | undefined) ?? null;
        },
        all: async <T>() => {
          const userId = String(call.values[0] ?? "");
          const terminalOnly = sql.includes("status IN ('completed', 'failed')");
          const selected = rows.filter((row) => row.telegram_user_id === userId)
            .filter((row) => !terminalOnly || row.status === "completed" || row.status === "failed");
          return { results: selected as T[] };
        },
        run: async () => {
          if (!sql.includes("DELETE FROM jobs")) return { success: true, meta: { changes: 0 } };
          const [id, userId] = call.values;
          const index = rows.findIndex((row) => row.id === id && row.telegram_user_id === userId
            && (row.status === "completed" || row.status === "failed"));
          if (index < 0) return { success: true, meta: { changes: 0 } };
          rows.splice(index, 1);
          return { success: true, meta: { changes: 1 } };
        },
      };
      return prepared;
    },
  };
  return { db, calls, rows };
}

function environment(db: D1DatabaseLike, bucket?: R2BucketLike): Env {
  return {
    DB: db,
    MEDIA_BUCKET: bucket,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    INTERNAL_CONTAINER_SECRET: "internal-secret",
    ALLOWED_TELEGRAM_USER_IDS: `${USER_ID},67890`,
    DOWNLOAD_LINK_HMAC_SECRET: "download-secret",
  } as unknown as Env;
}

async function request(path: string, method = "GET", userId = USER_ID): Promise<Request> {
  return new Request(`https://worker.example${path}`, {
    method,
    headers: { authorization: await authorization(userId) },
  });
}

function downloaderContext(request: Request, env: Env) {
  const url = new URL(request.url);
  const route = resolveMiniAppRoute(url.pathname);
  if (!route || route.kind !== "api" || route.app.id !== "downloader"
    || !["sources", "history", "history-item"].includes(route.endpoint)) {
    throw new Error("Expected a downloader API route");
  }
  return {
    url,
    user: { appId: "downloader", userId: USER_ID, authDate: Math.floor(Date.now() / 1000) },
    storage: createDownloaderMiniAppStorage(env.DB, env.MEDIA_BUCKET, USER_ID),
    endpoint: route.endpoint as DownloaderApiEndpoint,
    legacy: route.legacy,
    apiPath: route.app.apiPath,
  } as const;
}

async function downloaderApi(request: Request, env: Env): Promise<Response> {
  return handleDownloaderApi(request, downloaderContext(request, env));
}

describe("private history projection", () => {
  it("returns only minimized owner-facing fields and marks expired R2 media", () => {
    const item = historyItemForJob(job({
      source_host: "instagram.com",
      r2_object_key: null,
      expires_at: "2026-08-19T10:02:00.000Z",
    }), new Date("2026-08-19T11:00:00.000Z"));

    expect(item).toEqual({
      historyId: "job-a",
      task: "video",
      outcome: "needs_review",
      provider: "Instagram",
      safeLabel: "safe title.mp4",
      mediaType: "video",
      status: "completed",
      requestedMode: "video",
      createdAt: "2026-08-19T10:00:00.000Z",
      completedAt: "2026-08-19T10:01:00.000Z",
      sizeBytes: 4096,
      fileAvailability: "expired",
    });
    expect(JSON.stringify(item)).not.toContain("do-not-expose");
    expect(JSON.stringify(item)).not.toContain("telegram");
    expect(historyItemForJob(job()).fileAvailability).toBe("not_stored");
    expect(historyItemForJob(job({ status: "downloading", completed_at: null })).fileAvailability).toBe("pending");
  });
});

describe("private history API", () => {
  it("lists only the authenticated user's rows without source URLs, IDs, keys, or internal errors", async () => {
    const { db, calls } = statefulDb([
      job(),
      job({ id: "other-job", telegram_user_id: "99999", telegram_chat_id: "99999", source_url_encrypted: "other-secret" }),
    ]);

    const response = await downloaderApi(await request("/api/history?limit=10"), environment(db));
    const body = await response.json() as { items: Array<{ historyId: string }> };
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.items.map((item) => item.historyId)).toEqual(["job-a"]);
    expect(serialized).not.toContain("do-not-expose");
    expect(serialized).not.toContain("other-secret");
    expect(serialized).not.toContain("telegram_user_id");
    expect(serialized).not.toContain("r2_object_key");
    expect(calls[0]?.sql).toContain("telegram_user_id = ?1");
    expect(calls[0]?.values[0]).toBe(USER_ID);
  });

  it("returns bounded pages with an opaque cursor", async () => {
    const rows = Array.from({ length: 21 }, (_, index) => job({
      id: `job-${String(index).padStart(2, "0")}`,
      created_at: `2026-08-19T10:${String(59 - index).padStart(2, "0")}:00.000Z`,
    }));
    const { db, calls } = statefulDb(rows);

    const response = await downloaderApi(await request("/api/history?limit=20&period=all"), environment(db));
    const body = await response.json() as { items: unknown[]; nextCursor: string | null };

    expect(response.status).toBe(200);
    expect(body.items).toHaveLength(20);
    expect(body.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(body.nextCursor).not.toContain("job-19");

    const firstPageCalls = calls.length;
    const next = await downloaderApi(await request(`/api/history?limit=20&cursor=${body.nextCursor}`), environment(db));
    expect(next.status).toBe(200);
    expect((await next.json() as { summary: unknown }).summary).toBeNull();
    expect(calls.length - firstPageCalls).toBe(1);
  });

  it("keeps canonical and legacy history responses compatible", async () => {
    const { db } = statefulDb([job()]);
    const env = environment(db);
    const legacy = await downloaderApi(await request("/api/history?limit=1&asOf=2026-08-20T00:00:00.000Z"), env);
    const canonical = await downloaderApi(await request("/api/apps/downloader/history?limit=1&asOf=2026-08-20T00:00:00.000Z"), env);
    expect(canonical.status).toBe(legacy.status);
    expect(canonical.headers.get("content-type")).toBe(legacy.headers.get("content-type"));
    expect(canonical.headers.get("cache-control")).toBe(legacy.headers.get("cache-control"));
    await expect(canonical.json()).resolves.toEqual(await legacy.json());
  });

  it("rejects a malformed cursor without querying D1", async () => {
    const { db, calls } = statefulDb([job()]);
    const response = await downloaderApi(await request("/api/history?cursor=not_json"), environment(db));
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("never deletes another user's item", async () => {
    const bucket: R2BucketLike = {
      get: async () => null,
      put: async () => undefined,
      delete: vi.fn(async () => undefined),
    };
    const { db, calls, rows } = statefulDb([
      job({ id: "other-job", telegram_user_id: "99999", telegram_chat_id: "99999", r2_object_key: "jobs/other-job/video.mp4" }),
    ]);

    const response = await downloaderApi(await request("/api/history/other-job", "DELETE"), environment(db, bucket));

    expect(response.status).toBe(404);
    expect(bucket.delete).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(calls[0]?.values).toEqual(["other-job", USER_ID]);
  });

  it("deletes the owner's validated R2 object before its terminal metadata", async () => {
    const operations: string[] = [];
    const bucket: R2BucketLike = {
      get: async () => null,
      put: async () => undefined,
      delete: vi.fn(async (key) => {
        operations.push(`r2:${key}`);
      }),
    };
    const { db, rows } = statefulDb([job({ r2_object_key: "jobs/job-a/video.mp4" })]);
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const prepared = originalPrepare(sql);
      if (!sql.includes("DELETE FROM jobs")) return prepared;
      const originalRun = prepared.run.bind(prepared);
      prepared.run = async () => {
        operations.push("d1:delete");
        return originalRun();
      };
      return prepared;
    };

    const response = await downloaderApi(await request("/api/history/job-a", "DELETE"), environment(db, bucket));

    expect(response.status).toBe(200);
    expect(operations).toEqual(["r2:jobs/job-a/video.mp4", "d1:delete"]);
    expect(rows).toHaveLength(0);
  });

  it("refuses malformed object keys and keeps the row", async () => {
    const bucket: R2BucketLike = {
      get: async () => null,
      put: async () => undefined,
      delete: vi.fn(async () => undefined),
    };
    const { db, rows } = statefulDb([job({ r2_object_key: "jobs/someone-else/video.mp4" })]);

    const response = await downloaderApi(await request("/api/history/job-a", "DELETE"), environment(db, bucket));

    expect(response.status).toBe(409);
    expect(bucket.delete).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
  });

  it("clears only the current user's terminal history and retains active or cross-user rows", async () => {
    const { db, calls, rows } = statefulDb([
      job({ id: "done" }),
      job({ id: "failed", status: "failed", completed_at: null }),
      job({ id: "active", status: "downloading", completed_at: null }),
      job({ id: "other", telegram_user_id: "99999", telegram_chat_id: "99999" }),
    ]);

    const response = await downloaderApi(await request("/api/history", "DELETE"), environment(db));
    const body = await response.json() as { deletedCount: number };

    expect(response.status).toBe(200);
    expect(body.deletedCount).toBe(2);
    expect(rows.map((row) => row.id).sort()).toEqual(["active", "other"]);
    expect(calls.filter((call) => call.sql.includes("DELETE FROM jobs")).every((call) => call.values[1] === USER_ID)).toBe(true);
  });

  it("serves the shared source catalog only to an authenticated Mini App user", async () => {
    const { db } = statefulDb([]);
    const response = await downloaderApi(await request("/api/sources"), environment(db));
    const body = await response.json() as { sources: Array<{ id: string; state: string }> };

    expect(response.status).toBe(200);
    expect(body.sources.find((source) => source.id === "youtube")?.state).toBe("verified");
    expect(body.sources.find((source) => source.id === "x-twitter")?.state).toBe("recognized_unverified");
    for (const id of ["vimeo", "reddit", "pinterest", "ted"]) {
      expect(body.sources.find((source) => source.id === id)?.state).toBe("recognized_unverified");
    }
    expect(JSON.stringify(body)).not.toContain("https://");
  });
});

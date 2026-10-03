import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleDiagnostics } from "../src/diagnostics";
import { claimDispatchIntentForJob, createJobWithUpdateReservation, rescheduleDispatchIntent } from "../src/db";
import { localD1 } from "./helpers/local-d1";
import type { Env } from "../src/types";

let database: Awaited<ReturnType<typeof localD1>>;
beforeAll(async () => { database = await localD1(); }, 30_000);
afterAll(async () => { await database?.dispose(); });

const queueNow = new Date("2026-08-20T00:00:00.000Z");

function queueJob(index: number, requestedOperation: "download" | "transcript", transcriptMethod?: "whisper" | "captions") {
  return {
    id: `123e4567-e89b-42d3-a456-${String(index).padStart(12, "0")}`,
    telegramUpdateId: `diagnostic-queue-${index}`,
    telegramUserId: "diagnostic-user",
    telegramChatId: "diagnostic-chat",
    requestMessageId: String(index),
    sourceHost: "private.example",
    sourceUrlHash: `hash-${index}`,
    sourceUrlEncrypted: "https://private.example/private-title?token=secret",
    requestedMode: "video" as const,
    requestedOperation,
    ...(transcriptMethod ? { transcriptMethod } : {}),
    requestedQuality: "max-1080p",
    createdAt: queueNow.toISOString(),
  };
}

function environment() {
  const list = vi.fn(async (options: unknown) => { void options; return { objects: [{ key: "jobs/job-a/private-title.mp4" }], truncated: true, cursor: "opaque-next" }; });
  const env = { DB: database.db, MEDIA_BUCKET: { list }, MEDIA_CONTAINER: { get: vi.fn() } } as unknown as Env;
  return { env, list };
}

describe("protected diagnostics payload", () => {
  it("reports aggregate state and one bounded orphan page without private keys or Container work", async () => {
    const { env, list } = environment();
    const response = await handleDiagnostics(new Request("https://worker.example/api/apps/downloader/diagnostics?cursor=opaque-prior"), env);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.parse(body)).toMatchObject({ r2: { capability: "disabled", scanned: 1, orphanCandidates: 1, nextCursor: "opaque-next" } });
    expect(body).not.toContain("private-title");
    expect(body).not.toContain("job-a");
    expect(list).toHaveBeenCalledWith({ prefix: "jobs/", limit: 100, cursor: "opaque-prior" });
  });

  it("does not infer verified capability from configured secrets", async () => {
    const { env } = environment();
    const response = await handleDiagnostics(new Request("https://worker.example/api/apps/downloader/diagnostics"), { ...env, R2_ACCESS_KEY_ID: "test-key", R2_SECRET_ACCESS_KEY: "test-secret" });
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ r2: { capability: "configured-unverified" } });
    expect(text).not.toContain("test-key");
    expect(text).not.toContain("test-secret");
  });

  it("rejects oversized cursors before any storage call", async () => {
    const { env, list } = environment();
    expect((await handleDiagnostics(new Request(`https://worker.example/api/apps/downloader/diagnostics?cursor=${"x".repeat(2049)}`), env)).status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it("returns a static failure without exposing provider errors", async () => {
    const { env, list } = environment();
    list.mockRejectedValueOnce(new Error("https://private.example/source?token=secret"));
    const response = await handleDiagnostics(new Request("https://worker.example/api/apps/downloader/diagnostics"), env);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret");
  });

  it("normalizes corrupt diagnostic rows and rejects an invalid provider cursor", async () => {
    const { env, list } = environment();
    list.mockResolvedValueOnce({ objects: [], truncated: false, cursor: "" });
    const invalidEnv = { ...env, DB: {
      prepare: () => ({}), batch: async () => [
        { results: [{ state: "pending", count: 2, oldest_created_at: "https://private.example/?secret=1" }, { state: "private-content", count: 1 }] },
        { results: [] }, { results: [] }, { results: [{ confirmed_unreconciled: -1 }] },
        { results: [{ count: "private-content", oldest_created_at: "invalid" }] },
      ],
    } } as unknown as Env;
    const response = await handleDiagnostics(new Request("https://worker.example/api/apps/downloader/diagnostics"), invalidEnv);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ dispatch: [{ state: "pending", count: 2, oldestCreatedAt: null }], confirmedUnreconciled: 0 });
    expect(body).not.toContain("private");
    list.mockResolvedValueOnce({ objects: [], truncated: true, cursor: "private\ncontent" });
    expect((await handleDiagnostics(new Request("https://worker.example/api/apps/downloader/diagnostics"), env)).status).toBe(503);
  });

  it("caps inspection and excludes active jobs or durable receipt references from orphan candidates", async () => {
    const { env, list } = environment();
    const db = database.db;
    await db.batch([
      db.prepare("INSERT INTO processed_updates (telegram_update_id, job_id, created_at) VALUES ('inspection', 'job-a', ?1)").bind(new Date().toISOString()),
      db.prepare(`INSERT INTO jobs (id, telegram_update_id, telegram_user_id, telegram_chat_id, source_host,
        source_url_hash, requested_mode, status, created_at, updated_at)
        VALUES ('job-a', 'inspection', '12345', '12345', 'example.test', 'hash', 'video', 'received', ?1, ?1)`)
        .bind(new Date().toISOString()),
    ]);
    const request = () => new Request("https://worker.example/api/apps/downloader/diagnostics");
    try {
      expect(await (await handleDiagnostics(request(), env)).json()).toMatchObject({ r2: { orphanCandidates: 0 } });
      await db.batch([
        db.prepare("UPDATE jobs SET status = 'completed' WHERE id = 'job-a'"),
        db.prepare(`INSERT INTO job_deliveries (job_id, state, object_key, created_at, updated_at)
          VALUES ('job-a', 'confirmed', 'jobs/job-a/private-title.mp4', ?1, ?1)`).bind(new Date().toISOString()),
      ]);
      expect(await (await handleDiagnostics(request(), env)).json()).toMatchObject({ r2: { orphanCandidates: 0 } });
      list.mockResolvedValueOnce({ objects: Array.from({ length: 150 }, (_, index) => ({ key: `jobs/orphan-${index}/file.mp4` })), truncated: true, cursor: "opaque-next" });
      expect(await (await handleDiagnostics(request(), env)).json()).toMatchObject({ r2: { scanned: 100, orphanCandidates: 100 } });
    } finally {
      await db.batch([db.prepare("DELETE FROM jobs"), db.prepare("DELETE FROM processed_updates")]);
    }
  }, 30_000);

  it("counts only truly waiting jobs by lane and keeps admitted pending retries out of the projection", async () => {
    const { env } = environment();
    const db = database.db;
    const queuedCaptions = queueJob(100, "transcript", "captions");
    const admittedWhisper = queueJob(101, "transcript", "whisper");
    const limits = {
      maxActiveJobs: 1,
      maxActiveTranscriptions: 1,
      maxJobsPerHour: 10,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    };
    try {
      await createJobWithUpdateReservation(db, queuedCaptions, limits);
      await createJobWithUpdateReservation(db, admittedWhisper, limits);
      const claimed = await claimDispatchIntentForJob(db, admittedWhisper.id, queueNow, 60, limits);
      expect(claimed).toMatchObject({ job_id: admittedWhisper.id, state: "leased" });
      await expect(rescheduleDispatchIntent(
        db,
        admittedWhisper.id,
        claimed!.generation,
        new Date(queueNow.getTime() + 60_000).toISOString(),
        "WORKFLOW_UNAVAILABLE",
        "Workflow binding is unavailable.",
      )).resolves.toBe(true);

      const response = await handleDiagnostics(new Request("https://worker.example/api/apps/downloader/diagnostics"), env);
      const body = await response.text();
      const payload = JSON.parse(body) as Record<string, unknown>;
      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        dispatch: [{ state: "pending", count: 2 }],
        waitingByLane: [{ lane: "source", count: 1 }],
        admissions: { count: 1, lanes: [{ lane: "transcript", count: 1 }] },
      });
      expect(body).not.toContain(queuedCaptions.id);
      expect(body).not.toContain(admittedWhisper.id);
      expect(body).not.toContain(queuedCaptions.sourceHost);
      expect(body).not.toContain(queuedCaptions.sourceUrlEncrypted);
      expect(body).not.toContain("private-title");
      expect(body).not.toContain("diagnostic-user");
      expect(body).not.toContain("diagnostic-chat");
    } finally {
      await db.batch([
        db.prepare("DELETE FROM jobs"),
        db.prepare("DELETE FROM processed_updates"),
        db.prepare("DELETE FROM telegram_notices"),
      ]);
    }
  }, 30_000);
});

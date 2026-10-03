import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteTerminalJobForUser, listActivityJobsForUser, listJobsForUser } from "../src/db";
import { createDownloaderMiniAppStorage } from "../src/downloader-storage";
import { handleDownloaderApi } from "../src/history";
import { activityWindow, formatLatestUserActivity, getLatestUserActivity, getUserActivityStats, parseActivityPeriod } from "../src/stats";
import type { D1BatchDatabaseLike } from "../src/types";
import { localD1 } from "./helpers/local-d1";

const AS_OF = "2026-08-20T12:00:00.000Z";
const SINCE = "2026-08-13T12:00:00.000Z";
const SAME_TIME = "2026-08-19T12:00:00.000Z";
const PACK = JSON.stringify([{ startSeconds: 0, endSeconds: 2 }, { startSeconds: 3, endSeconds: 5 }, { startSeconds: 6, endSeconds: 8 }]);
let db: D1BatchDatabaseLike;
let dispose: () => Promise<void>;

interface Fixture {
  id: string;
  user?: string;
  created?: string;
  status?: string;
  operation?: string;
  method?: string;
  mode?: string;
  mime?: string;
  source?: string;
  ranges?: string;
  receipt?: string | null;
  ids?: string;
}
async function insert(row: Fixture) {
  const created = row.created ?? SAME_TIME;
  await db.batch([
    db.prepare("INSERT INTO processed_updates (telegram_update_id, job_id, created_at) VALUES (?1,?1,?2)").bind(row.id, created),
    db.prepare(`INSERT INTO jobs (id,telegram_update_id,telegram_user_id,telegram_chat_id,source_host,source_kind,
      source_url_hash,source_url_encrypted,requested_mode,requested_operation,transcript_method,
      requested_clip_ranges,status,output_mime_type,created_at,updated_at,completed_at,cache_valid)
      VALUES (?1,?1,?2,?2,?3,?4,'private-hash','private-content',?5,?6,?7,?8,?9,?10,?11,?11,?12,1)`)
      .bind(row.id, row.user ?? "owner", row.source === "telegram_file" ? "telegram" : "youtube.com", row.source ?? "url",
        row.mode ?? "video", row.operation ?? "download", row.method ?? "whisper", row.ranges ?? null,
        row.status ?? "completed", row.mime ?? "video/mp4", created, (row.status ?? "completed") === "completed" ? created : null),
  ]);
  if (row.receipt !== null) await db.prepare(`INSERT INTO job_deliveries (job_id,state,method,telegram_message_id,telegram_message_ids,created_at,updated_at)
    VALUES (?1,?2,'telegram','101',?3,?4,?4)`).bind(row.id, row.receipt ?? "confirmed", row.ids ?? null, created).run();
}

async function history(query: string) {
  const url = new URL(`https://worker.example/api/apps/downloader/history?${query}`);
  return handleDownloaderApi(new Request(url), { url, user: { appId: "downloader", userId: "owner", authDate: 1 },
    storage: createDownloaderMiniAppStorage(db, undefined, "owner"), endpoint: "history", legacy: false, apiPath: "/api/apps/downloader" });
}

describe("retained activity on real D1", () => {
  beforeAll(async () => {
    ({ db, dispose } = await localD1());
    for (let i = 0; i < 105; i++) await insert({ id: `base-${String(i).padStart(3, "0")}` });
    for (const row of [
      { id: "captions", operation: "transcript", method: "captions", mime: "text/markdown" },
      { id: "whisper", operation: "transcript", mime: "text/markdown", status: "uploading" },
      { id: "file", source: "telegram_file", mode: "audio", mime: "audio/mpeg" },
      { id: "pack", ranges: PACK, ids: '["101","102","103"]' },
      { id: "bad-pack", ranges: PACK, ids: '["101","101","103"]' },
      { id: "missing-method" },
      { id: "missing", receipt: null },
      { id: "unknown", status: "uploading", receipt: "unknown" },
      { id: "failed", status: "failed", receipt: "rejected" },
      { id: "waiting", status: "queued", receipt: "not_started" },
      { id: "failed-sending", status: "failed", receipt: "sending" },
      { id: "image", mime: "image/jpeg" },
      { id: "lower", created: SINCE },
      { id: "upper", created: AS_OF },
      { id: "malformed", ranges: '[{"startSeconds":9,"endSeconds":0},{"startSeconds":1,"endSeconds":2}]', ids: '["101","102"]' },
      { id: "before", created: "2026-08-13T11:59:59.999Z" },
      { id: "after", created: "2026-08-20T12:00:00.001Z" },
      { id: "other-owner", user: "other" },
    ]) await insert(row);
    await db.prepare("UPDATE job_deliveries SET method = NULL WHERE job_id = 'missing-method'").run();
  }, 30_000);
  afterAll(async () => { await dispose?.(); });

  it("partitions all matching jobs across tied-time pages, validates receipts, and scopes windows/tasks/owners", async () => {
    const options = { period: "7d" as const, asOf: AS_OF };
    const stats = await getUserActivityStats(db, "owner", options);
    expect(stats).toMatchObject({ accepted: 120, confirmed: 112, failed: 1, unfinished: 1, needsReview: 6, deliveredClips: 3, since: SINCE });
    expect(stats.accepted).toBe(stats.confirmed + stats.failed + stats.unfinished + stats.needsReview);
    await db.prepare("UPDATE job_deliveries SET telegram_message_ids = '[\"101\",\"102\"]' WHERE job_id = 'bad-pack'").run();
    expect((await getUserActivityStats(db, "owner", options)).needsReview).toBe(6);
    expect(stats.bySource).toContainEqual({ label: "Telegram file", count: 1 });
    expect(stats.byTask).toContainEqual({ task: "video", label: "Video", count: 107 });
    for (const item of stats.byTask) {
      const filtered = await getUserActivityStats(db, "owner", { ...options, task: item.task });
      expect(filtered.confirmed).toBe(item.count);
      expect(filtered.byTask).toEqual([item]);
    }
    expect((await getUserActivityStats(db, "owner", { period: "all", asOf: AS_OF })).accepted).toBe(121);
    expect((await getUserActivityStats(db, "owner", { period: "24h", asOf: AS_OF })).accepted).toBe(119);
    expect((await getUserActivityStats(db, "other", options)).accepted).toBe(1);
    const queryTexts: string[] = [];
    const recorded = { prepare(sql: string) { queryTexts.push(sql); return db.prepare(sql); } };
    await listActivityJobsForUser(recorded, "owner", activityWindow(options));
    const plan = await db.prepare(`EXPLAIN QUERY PLAN ${queryTexts[0]}`).bind("owner", AS_OF, SINCE, 100).all<{ detail: string }>();
    expect(plan.results.map((row) => row.detail).join("\n")).toContain("idx_jobs_user_created");
    expect(queryTexts[0]).not.toMatch(/source_url|filename|error|cache_valid/u);
    // Cache eligibility never changes the count or claims that a result was copied.
    await db.prepare("UPDATE jobs SET cache_valid = 0 WHERE id = 'base-000'").run();
    expect((await getUserActivityStats(db, "owner", options)).confirmed).toBe(112);
    expect(await deleteTerminalJobForUser(db, "base-000", "other")).toBe(false);
    expect(await deleteTerminalJobForUser(db, "base-000", "owner")).toBe(true);
    expect((await getUserActivityStats(db, "owner", options)).accepted).toBe(119);
    const latest = await getLatestUserActivity(db, "owner");
    expect(latest).toHaveLength(5);
    expect(JSON.stringify(latest)).not.toMatch(/private-|telegram_message|historyId|filename/u);
    expect(formatLatestUserActivity([{ ...latest[0]!, createdAt: "invalid" }])).toContain("Time unavailable");
  });

  it("binds stable filtered history cursors to the first page's summary window", async () => {
    const first = await history(`period=7d&asOf=${AS_OF}&task=video&limit=2`);
    expect(first.status).toBe(200);
    const initial = await first.json() as { items: { historyId: string; task: string; outcome: string }[]; nextCursor: string; summary: { accepted: number; asOf: string } };
    expect(initial.summary.accepted).toBeGreaterThan(initial.items.length);
    expect(initial.items.every((item) => item.task === "video")).toBe(true);
    const second = await history(`cursor=${initial.nextCursor}&limit=2`);
    const next = await second.json() as typeof initial;
    expect(next.summary).toBeNull(); // the client keeps the first page's summary
    expect(next.items.some((item) => initial.items.some((previous) => previous.historyId === item.historyId))).toBe(false);
    expect((await history(`cursor=${initial.nextCursor}&task=audio`)).status).toBe(400);
    expect((await history(`cursor=${initial.nextCursor}&period=all`)).status).toBe(400);
    expect((await history(`cursor=${initial.nextCursor}&asOf=${SINCE}`)).status).toBe(400);
    expect((await history("asOf=9999-01-01T00:00:00.000Z")).status).toBe(400);
    const page = await listJobsForUser(db, "owner", { window: activityWindow({ period: "all", asOf: AS_OF, task: "captions" }) });
    expect(page.jobs.map((job) => job.id)).toEqual(["captions"]);
  });

  it("rejects invalid periods and does not expose partial totals after a failed page", async () => {
    expect(parseActivityPeriod()).toBe("7d");
    expect(parseActivityPeriod("today")).toBeNull();
    let pages = 0;
    const broken = { prepare(sql: string) { if (++pages > 1) throw new Error("D1 unavailable"); return db.prepare(sql); } };
    await expect(getUserActivityStats(broken, "owner", { period: "all", asOf: AS_OF })).rejects.toThrow("D1 unavailable");
  });
});

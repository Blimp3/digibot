import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchNotices, enqueueNotice, ensureWaitingNotice } from "../src/notices";
import { TelegramApiError } from "../src/telegram";
import { applyMigrationSql } from "./helpers/local-d1";
import { deleteOldProcessedUpdates } from "../src/db";
import type * as TelegramModule from "../src/telegram";
import type { D1BatchDatabaseLike, Env } from "../src/types";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../src/telegram", async (importOriginal) => ({
  ...await importOriginal<typeof TelegramModule>(),
  TelegramClient: class { sendMessage = mocks.send; },
}));

interface Runtime { getD1Database(name: string): Promise<D1BatchDatabaseLike>; dispose(): Promise<void> }
const require = createRequire(import.meta.url);
const miniflare = createRequire(require.resolve("wrangler/package.json"))("miniflare") as {
  Miniflare: new (options: unknown) => Runtime;
  convertV4MiniflareOptions(options: unknown): unknown;
};
let runtime: Runtime;
let db: D1BatchDatabaseLike;
let env: Env;

describe("durable notices on local workerd D1", () => {
  beforeAll(async () => {
    runtime = new miniflare.Miniflare(miniflare.convertV4MiniflareOptions({
      modules: true, script: "export default {fetch(){return new Response('test')}}",
      compatibilityDate: "2026-08-18", d1Databases: ["DB"],
    }));
    db = await runtime.getD1Database("DB");
    await db.prepare("CREATE TABLE processed_updates (telegram_update_id TEXT PRIMARY KEY, job_id TEXT, created_at TEXT NOT NULL)").run();
    await db.prepare(readFileSync(new URL("../migrations/0009_telegram_notices.sql", import.meta.url), "utf8")).run();
    await applyMigrationSql(db, readFileSync(new URL("../migrations/0016_video_quality_prompts.sql", import.meta.url), "utf8"));
    env = { DB: db, TELEGRAM_BOT_TOKEN: "test", TELEGRAM_BOT_API_BASE: "https://api.telegram.org" } as unknown as Env;
  }, 30_000);

  beforeEach(async () => {
    mocks.send.mockReset();
    mocks.send.mockResolvedValue({ message_id: 12 });
    await db.batch([db.prepare("DELETE FROM telegram_notices"), db.prepare("DELETE FROM processed_updates")]);
  });
  afterAll(async () => { await runtime?.dispose(); });

  it("atomically reserves one notice for 100 concurrent duplicate updates", async () => {
    const results = await Promise.all(Array.from({ length: 100 }, () => enqueueNotice(db, "1", "12345", "Busy. Try again later.")));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM telegram_notices").first()).toEqual({ count: 1 });
    expect(mocks.send).not.toHaveBeenCalled();
    await Promise.all([dispatchNotices(env), dispatchNotices(env)]);
    expect(mocks.send).toHaveBeenCalledOnce();
  }, 30_000);

  it("rolls back the reservation if durable notice insertion fails", async () => {
    await expect(enqueueNotice(db, "1", "12345", "x".repeat(4097))).rejects.toThrow();
    expect(await db.prepare("SELECT * FROM processed_updates").first()).toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("recovers a notice after the accepting process exits before sending", async () => {
    await enqueueNotice(db, "1", "12345", "Source rejected.");
    await dispatchNotices(env);
    expect(await db.prepare("SELECT state, message_id FROM telegram_notices").first()).toEqual({ state: "sent", message_id: "12" });
    await dispatchNotices(env);
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it("preserves a long explicit 429 delay and never holds the accepting HTTP work open", async () => {
    await enqueueNotice(db, "1", "12345", "Preparing.");
    mocks.send.mockRejectedValueOnce(new TelegramApiError("sendMessage", 429, { ok: false, error_code: 429, parameters: { retry_after: 86_401 } }));
    await dispatchNotices(env);
    const row = await db.prepare("SELECT state, retry_after_seconds, last_attempt_at_seconds FROM telegram_notices").first<{ state: string; retry_after_seconds: number; last_attempt_at_seconds: number }>();
    expect(row).toMatchObject({ state: "pending", retry_after_seconds: 86_401 });
    await deleteOldProcessedUpdates(db, new Date(Date.now() + 30 * 86400_000).toISOString());
    expect(await db.prepare("SELECT state FROM telegram_notices").first()).toEqual({ state: "pending" });
    await dispatchNotices(env, undefined, new Date((row!.last_attempt_at_seconds + 86_400) * 1000));
    expect(mocks.send).toHaveBeenCalledOnce();
    await dispatchNotices(env, undefined, new Date((row!.last_attempt_at_seconds + 86_401) * 1000));
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it("never retries a lost response or a 5xx body claiming 429", async () => {
    await enqueueNotice(db, "1", "12345", "Busy.");
    mocks.send.mockRejectedValueOnce(new TelegramApiError("sendMessage", 503, { ok: false, error_code: 429, parameters: { retry_after: 1 } }));
    await dispatchNotices(env);
    expect(await db.prepare("SELECT state FROM telegram_notices").first()).toEqual({ state: "unknown" });
    await dispatchNotices(env, undefined, new Date(Date.now() + 86400_000));
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it("keeps a confirmed send one-shot when storing its receipt fails", async () => {
    await enqueueNotice(db, "1", "12345", "Busy.");
    const failedEnv = { ...env, DB: { batch: db.batch.bind(db), prepare: (sql: string) => {
      if (sql.includes("SET state = 'sent'")) throw new Error("D1 unavailable after confirmation");
      return db.prepare(sql);
    } } } as unknown as Env;
    await expect(dispatchNotices(failedEnv)).rejects.toThrow("D1 unavailable");
    await dispatchNotices(env, undefined, new Date(Date.now() + 120_000));
    expect(await db.prepare("SELECT state FROM telegram_notices").first()).toEqual({ state: "unknown" });
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it("recovers the existing waiting receipt after its job pointer write fails", async () => {
    await db.prepare("INSERT INTO processed_updates (telegram_update_id, job_id, created_at) VALUES ('1', 'job-1', ?1)").bind(new Date().toISOString()).run();
    expect(await ensureWaitingNotice(env, "1", "12345", "Preparing.")).toMatchObject({ state: "sent", messageId: "12" });
    // A restarted Workflow asks again after its separate waiting_message_id write failed.
    expect(await ensureWaitingNotice(env, "1", "12345", "Preparing.")).toMatchObject({ state: "sent", messageId: "12" });
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(await db.prepare("SELECT job_id FROM processed_updates").first()).toEqual({ job_id: "job-1" });
  });

  it("returns a durable waiting delay to Workflow instead of repeating a rate-limited send", async () => {
    await db.prepare("INSERT INTO processed_updates (telegram_update_id, job_id, created_at) VALUES ('1', 'job-1', ?1)").bind(new Date().toISOString()).run();
    mocks.send.mockRejectedValueOnce(new TelegramApiError("sendMessage", 429, { ok: false, error_code: 429, parameters: { retry_after: 86_401 } }));
    const notice = await ensureWaitingNotice(env, "1", "12345", "Preparing.");
    expect(notice.state).toBe("pending");
    expect(notice.retryAfterSeconds).toBeGreaterThanOrEqual(86_400);
    expect((await ensureWaitingNotice(env, "1", "12345", "Preparing.")).state).toBe("pending");
    expect(mocks.send).toHaveBeenCalledOnce();
  });
});

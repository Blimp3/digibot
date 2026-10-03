import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTelegramWebhook } from "../src/webhook";
import { dispatchNotices } from "../src/notices";
import { buildPrepareRequest } from "../src/container-contract";
import { cancelVideoQualityPrompt, QualityPromptUnavailableError } from "../src/db";
import { decryptSourceUrl } from "../src/crypto";
import { localD1 } from "./helpers/local-d1";
import type { D1BatchDatabaseLike, Env, JobRecord } from "../src/types";

vi.mock("../src/dispatch", () => ({ dispatchAcceptedJob: vi.fn(async () => undefined) }));
let database: Awaited<ReturnType<typeof localD1>>;
let db: D1BatchDatabaseLike;
let env: Env;
let nextMessage: number;
const sent: { method: string; body: Record<string, unknown> }[] = [];
function request(update: unknown, secret = "webhook-secret"): Request {
  return new Request("https://worker.example/telegram/webhook", { method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret }, body: JSON.stringify(update) });
}
function command(id: number, text = "/video https://youtu.be/abc first 5 minutes", user = 12345): Request {
  return request({ update_id: id, message: { message_id: id, from: { id: user }, chat: { id: user, type: "private" }, text } });
}
function callback(id: number, token: string, messageId = 1001, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { update_id: id, callback_query: { id: `query-${id}`, from: { id: 12345 }, data: token,
    message: { message_id: messageId, date: 1_700_000_000, chat: { id: 12345, type: "private" } }, ...extra } };
}
async function choose(id: number, token: string, messageId = 1001): Promise<Record<string, unknown>> {
  return (await handleTelegramWebhook(request(callback(id, token, messageId)), env)).json();
}
async function token(choice = "720"): Promise<string> {
  return (await db.prepare("SELECT token FROM video_quality_choices WHERE choice = ?1").bind(choice).first<{ token: string }>())!.token;
}
async function count(table: "jobs" | "video_quality_prompts" | "video_quality_choices" | "video_quality_claims" | "processed_updates" | "job_dispatch_intents"): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

describe("video quality picker with local D1 transactions", () => {
  beforeAll(async () => { database = await localD1(); db = database.db; }, 30_000);
  afterAll(async () => { await database?.dispose(); vi.unstubAllGlobals(); });
  beforeEach(async () => {
    await db.batch([db.prepare("DELETE FROM telegram_notices"), db.prepare("DELETE FROM jobs"), db.prepare("DELETE FROM processed_updates")]);
    env = { DB: db, TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      INTERNAL_CONTAINER_SECRET: "internal-secret", ALLOWED_TELEGRAM_USER_IDS: "12345,67890",
      DOWNLOAD_LINK_HMAC_SECRET: "download-hmac", ALLOWED_SOURCE_HOSTS: "youtube.com,youtu.be,music.youtube.com",
      PUBLIC_WORKER_BASE_URL: "https://worker.example", MAX_JOBS_PER_HOUR: "100",
    } as unknown as Env;
    nextMessage = 1000;
    sent.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ method: url.split("/").at(-1)!, body: JSON.parse(init.body as string) as Record<string, unknown> });
      return Response.json({ ok: true, result: { message_id: ++nextMessage } });
    }));
  });

  it("reserves an encrypted expiring prompt and keyboard, with no job before choice", async () => {
    expect(await (await handleTelegramWebhook(command(1), env)).json()).toMatchObject({ qualityPending: true });
    expect(await count("jobs")).toBe(0);
    expect(await count("job_dispatch_intents")).toBe(0);
    expect(await count("video_quality_choices")).toBe(5);
    const prompt = (await db.prepare("SELECT * FROM video_quality_prompts").first<Record<string, string>>())!;
    expect(JSON.stringify(prompt)).not.toContain("https://");
    expect(await decryptSourceUrl("internal-secret", prompt.source_url_encrypted!)).toBe("https://youtu.be/abc");
    expect(Date.parse(prompt.expires_at!) - Date.parse(prompt.created_at!)).toBe(600_000);
    expect(sent[0]!.body.reply_markup).toMatchObject({ inline_keyboard: [
      [{ text: "Automatic (up to 1080p)" }], [{ text: "Up to 720p" }], [{ text: "Up to 480p" }], [{ text: "Up to 360p" }], [{ text: "Cancel" }],
    ] });
    for (const row of (sent[0]!.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard) {
      expect(row[0]!.callback_data).toMatch(/^vq:[0-9a-f]{32}$/u);
      expect(new TextEncoder().encode(row[0]!.callback_data).byteLength).toBeLessThanOrEqual(64);
    }
  });

  it("consumes a valid selection once, preserves original reply/trim, and sends the stored ceiling to Container", async () => {
    await handleTelegramWebhook(command(1), env);
    const choice = await token();
    expect(await choose(2, choice)).toMatchObject({ accepted: true });
    const job = (await db.prepare("SELECT * FROM jobs").first<JobRecord>())!;
    expect(job).toMatchObject({ telegram_update_id: "2", request_message_id: "1", requested_quality: "max-720p", requested_start_seconds: 0,
      requested_end_seconds: 300, processing_policy_version: "v2" });
    expect(buildPrepareRequest({ ...job, waiting_message_id: "1002" }, "https://youtu.be/abc", { defaultMaxHeight: 1080 })).toMatchObject({ maximumHeight: 720, trimEndSeconds: 300 });
    expect(await count("video_quality_prompts")).toBe(0);
    expect(await count("video_quality_choices")).toBe(0);
    expect(await count("video_quality_claims")).toBe(0);
    expect(await db.prepare("SELECT reply_markup FROM telegram_notices WHERE update_id = '1'").first()).toEqual({ reply_markup: null });
    expect(await choose(2, choice)).toMatchObject({ duplicate: true });
    expect(await choose(3, choice)).toMatchObject({ accepted: false });
    expect(await count("jobs")).toBe(1);
  });

  it("persists a URL clip pack through one quality selection without ordinary trim or cache", async () => {
    await handleTelegramWebhook(command(1, "/clips https://youtu.be/abc from 00:20 for 20 seconds; from 00:10 for 20 seconds"), env);
    const prompt = await db.prepare("SELECT * FROM video_quality_prompts").first<Record<string, unknown>>();
    expect(prompt).toMatchObject({ trim_start_seconds: null, trim_end_seconds: null,
      requested_clip_ranges: '[{"startSeconds":20,"endSeconds":40},{"startSeconds":10,"endSeconds":30}]' });
    expect(sent[0]!.body.text).toContain("2 clips");
    await choose(2, await token());
    const admitted = (await db.prepare("SELECT * FROM jobs").first<JobRecord>())!;
    expect(admitted).toMatchObject({ requested_quality: "max-720p", cache_valid: 0, requested_start_seconds: null, requested_end_seconds: null });
    const prepared = buildPrepareRequest({ ...admitted, waiting_message_id: "1002" }, "https://youtu.be/abc", { defaultMaxHeight: 1080 });
    expect(prepared).toMatchObject({ clipRanges: [{ startSeconds: 20, endSeconds: 40 }, { startSeconds: 10, endSeconds: 30 }], maximumHeight: 720 });
    expect(prepared).not.toHaveProperty("trimStartSeconds");
  });

  it("admits exactly one job across concurrent different buttons and callback update IDs", async () => {
    await handleTelegramWebhook(command(1), env);
    const a = await token("720");
    const b = await token("360");
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => choose(10 + i, i % 2 ? a : b)));
    expect(results.filter((result) => result.accepted === true)).toHaveLength(1);
    expect(await count("jobs")).toBe(1);
    expect(await count("job_dispatch_intents")).toBe(1);
    expect(await count("video_quality_claims")).toBe(0);
  });

  it("handles concurrent duplicate commands without superseding the winning prompt", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => handleTelegramWebhook(command(1), env).then((r) => r.json() as Promise<Record<string, unknown>>)));
    expect(results.filter((r) => r.qualityPending)).toHaveLength(1);
    expect(await count("video_quality_prompts")).toBe(1);
    expect(await count("video_quality_choices")).toBe(5);
    expect(sent.filter((r) => r.method === "sendMessage")).toHaveLength(1);
  });

  it.each(["queue", "hourly"])("rolls back selection on the %s cap, keeping it recoverable", async (cap) => {
    const n = cap === "queue" ? 5 : 1;
    for (let i = 0; i < n; i++) await handleTelegramWebhook(command(10 + i, "https://youtu.be/abc"), env);
    if (cap === "hourly") Object.assign(env, { MAX_JOBS_PER_HOUR: "1" });
    await handleTelegramWebhook(command(1), env);
    const choice = await token();
    const message = (await db.prepare("SELECT message_id FROM telegram_notices WHERE update_id = '1'").first<{ message_id: string }>())!.message_id;
    expect(await choose(2, choice, Number(message))).toMatchObject({ accepted: false, error: "SOURCE_RATE_LIMITED" });
    expect(await count("jobs")).toBe(n);
    expect(await count("video_quality_prompts")).toBe(1);
    expect(await db.prepare("SELECT 1 FROM processed_updates WHERE telegram_update_id = '2'").first()).toBeNull();
    expect(await count("video_quality_claims")).toBe(0);
    await db.prepare("UPDATE jobs SET status = 'completed', created_at = '2020-01-01T00:00:00.000Z'").run();
    expect(await choose(2, choice, Number(message))).toMatchObject({ accepted: true });
  });

  it("purges cancellation and superseded source/tokens without enqueueing", async () => {
    await handleTelegramWebhook(command(1), env);
    const oldToken = await token();
    await handleTelegramWebhook(command(2, "/video https://youtu.be/replacement"), env);
    expect(await choose(3, oldToken)).toMatchObject({ accepted: false });
    expect(await count("video_quality_prompts")).toBe(1);
    expect(await choose(4, await token("cancel"), 1002)).toMatchObject({ cancelled: true });
    expect(await count("video_quality_prompts")).toBe(0);
    expect(await count("video_quality_choices")).toBe(0);
    expect(await count("jobs")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM telegram_notices WHERE reply_markup IS NOT NULL").first()).toEqual({ n: 0 });
  });

  it("expires quiet prompts in scheduled dispatch and never sends a stale pending keyboard", async () => {
    const pending: Promise<unknown>[] = [];
    // Preserve a pending outbox by making its first claim fail before Telegram.
    const blockedDb = { prepare: (sql: string) => db.prepare(sql), batch: db.batch.bind(db) };
    const originalPrepare = blockedDb.prepare;
    blockedDb.prepare = (sql) => { if (sql.includes("SELECT update_id, chat_id, text, generation")) throw new Error("interrupted"); return originalPrepare(sql); };
    await handleTelegramWebhook(command(1), { ...env, DB: blockedDb } as unknown as Env, (p) => pending.push(p));
    await Promise.all(pending);
    const choice = await token();
    await dispatchNotices(env, undefined, new Date(Date.now() + 600_001));
    expect(await count("video_quality_prompts")).toBe(0);
    expect(await count("video_quality_choices")).toBe(0);
    expect(sent).toHaveLength(0);
    expect(await choose(2, choice)).toMatchObject({ accepted: false });
    expect(await db.prepare("SELECT state, reply_markup FROM telegram_notices WHERE update_id = '1'").first()).toEqual({ state: "rejected", reply_markup: null });
  });

  it("checks expiry at the database claim even when the request began before expiry", async () => {
    await handleTelegramWebhook(command(1), env);
    const choice = await token("cancel");
    const prompt = (await db.prepare("SELECT id FROM video_quality_prompts").first<{ id: string }>())!;
    await db.prepare("UPDATE video_quality_prompts SET expires_at = ?1").bind(new Date(Date.now() - 1000).toISOString()).run();
    await expect(cancelVideoQualityPrompt(db, { token: choice, promptId: prompt.id, userId: "12345", chatId: "12345", messageId: "1001" },
      "2", new Date(Date.now() - 2000).toISOString())).rejects.toBeInstanceOf(QualityPromptUnavailableError);
    expect(await count("processed_updates")).toBe(1);
    expect(await count("video_quality_claims")).toBe(0);
  });

  it("keeps committed admission one-shot when callback answers and keyboard edits fail", async () => {
    await handleTelegramWebhook(command(1), env);
    const choice = await token();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Telegram unavailable"); }));
    expect(await choose(2, choice)).toMatchObject({ accepted: true });
    expect(await choose(3, choice)).toMatchObject({ accepted: false });
    expect(await count("jobs")).toBe(1);
    expect(await count("video_quality_prompts")).toBe(0);
    expect(await db.prepare("SELECT state FROM telegram_notices WHERE update_id = '2'").first()).toEqual({ state: "unknown" });
  });

  it.each(["unknown", "sending", "pending", "rejected"])("fails closed on a %s notice receipt without resetting or resending it", async (state) => {
    await handleTelegramWebhook(command(1), env);
    const choice = await token();
    await db.prepare("UPDATE telegram_notices SET state = ?1 WHERE update_id = '1'").bind(state).run();
    expect(await choose(2, choice)).toMatchObject({ accepted: false });
    expect(await count("jobs")).toBe(0);
    expect(await count("video_quality_prompts")).toBe(1);
    expect(await db.prepare("SELECT state FROM telegram_notices WHERE update_id = '1'").first()).toEqual({ state });
    expect(sent.filter((r) => r.method === "sendMessage")).toHaveLength(1);
  });

  it("keeps an ambiguous keyboard send unknown and never accepts it as a sent receipt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("lost response"); }));
    await handleTelegramWebhook(command(1), env);
    expect(await db.prepare("SELECT state FROM telegram_notices").first()).toEqual({ state: "unknown" });
    const choice = await token();
    await dispatchNotices(env);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(await choose(2, choice)).toMatchObject({ accepted: false });
    expect(await count("jobs")).toBe(0);
  });

  it("validates callback envelope, authorized sender, private chat, and exact sent message", async () => {
    await handleTelegramWebhook(command(1), env);
    const choice = await token();
    const invalid = [
      callback(2, "vq:720"), callback(3, choice, 1001, { inline_message_id: "inline" }),
      callback(4, choice, 1001, { from: { id: 11111 } }),
      callback(5, choice, 1001, { from: { id: 67890 } }),
      callback(6, choice, 1001, { message: { message_id: 1001, date: 1, chat: { id: 12345, type: "group" } } }),
      callback(7, choice, 1001, { message: { message_id: 1001, date: 0, chat: { id: 12345, type: "private" } } }),
      callback(8, choice, 9999),
      callback(9, choice, 1001, { from: { id: 67890 }, message: { message_id: 1001, date: 1, chat: { id: 67890, type: "private" } } }),
      { update_id: 10, callback_query: [] },
    ];
    for (const update of invalid) expect((await handleTelegramWebhook(request(update), env)).status).toBe(200);
    expect((await handleTelegramWebhook(request(callback(11, choice), "wrong-secret"), env)).status).toBe(403);
    expect(await count("jobs")).toBe(0);
    expect(await count("processed_updates")).toBe(1);
    expect(await choose(12, choice)).toMatchObject({ accepted: true });
  });

  it("retains bare URL and YouTube Music immediate admission", async () => {
    await handleTelegramWebhook(command(1, "https://youtu.be/abc"), env);
    await handleTelegramWebhook(command(2, "https://music.youtube.com/watch?v=abc"), env);
    expect(await count("jobs")).toBe(2);
    expect(await count("video_quality_prompts")).toBe(0);
    expect(await db.prepare("SELECT requested_mode, requested_quality FROM jobs WHERE telegram_update_id = '2'").first()).toEqual({ requested_mode: "audio", requested_quality: "m4a" });
  });

  it.each(["480", "500"])("labels and filters choices below global %s, retaining the canonical cap across config drift", async (height) => {
    Object.assign(env, { DEFAULT_MAX_HEIGHT: height });
    await handleTelegramWebhook(command(1), env);
    expect(sent[0]!.body.reply_markup).toMatchObject({ inline_keyboard: [[{ text: "Automatic (up to 480p)" }], [{ text: "Up to 360p" }], [{ text: "Cancel" }]] });
    expect(await count("video_quality_choices")).toBe(3);
    Object.assign(env, { DEFAULT_MAX_HEIGHT: "1080" });
    expect(await choose(2, await token("automatic"))).toMatchObject({ accepted: true });
    const job = (await db.prepare("SELECT * FROM jobs").first<JobRecord>())!;
    expect(job.requested_quality).toBe("max-480p");
    expect(buildPrepareRequest({ ...job, waiting_message_id: "9" }, "https://youtu.be/abc", { defaultMaxHeight: 1080 }).maximumHeight).toBe(480);
  });

  it.each([["200", 144], ["300", 240]])("supports low global %s with Automatic floor %i and no extra buttons", async (global, ceiling) => {
    Object.assign(env, { DEFAULT_MAX_HEIGHT: global });
    expect(await (await handleTelegramWebhook(command(1), env)).json()).toMatchObject({ qualityPending: true });
    expect(sent[0]!.body.reply_markup).toMatchObject({ inline_keyboard: [[{ text: `Automatic (up to ${ceiling}p)` }], [{ text: "Cancel" }]] });
    Object.assign(env, { DEFAULT_MAX_HEIGHT: "1080" });
    expect(await choose(2, await token("automatic"))).toMatchObject({ accepted: true });
    const job = (await db.prepare("SELECT * FROM jobs").first<JobRecord>())!;
    expect(buildPrepareRequest({ ...job, waiting_message_id: "9" }, "https://youtu.be/abc", { defaultMaxHeight: 1080 }).maximumHeight).toBe(ceiling);
  });

  it.each(["100", "1", "143"])("fails closed before saving a prompt below the supported picker heights (%s)", async (height) => {
    Object.assign(env, { DEFAULT_MAX_HEIGHT: height });
    expect((await handleTelegramWebhook(command(1), env)).status).toBe(500);
    expect(await count("video_quality_prompts")).toBe(0);
    expect(await count("processed_updates")).toBe(0);
  });

  it("rejects arbitrary persisted keyboard JSON before external dispatch", async () => {
    await handleTelegramWebhook(command(1), env);
    await db.prepare("UPDATE telegram_notices SET state = 'pending', reply_markup = ?1 WHERE update_id = '1'")
      .bind(JSON.stringify({ inline_keyboard: [[{ text: "Click", url: "https://evil.example" }]] })).run();
    await dispatchNotices(env);
    expect(sent.filter((r) => r.method === "sendMessage")).toHaveLength(1);
    expect(await db.prepare("SELECT state FROM telegram_notices").first()).toEqual({ state: "rejected" });
  });
});

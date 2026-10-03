import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTelegramWebhook, parseTelegramCommand, parseTelegramCommandDetailed } from "../src/webhook";
import { dispatchNotices } from "../src/notices";
import { buildPrepareRequest } from "../src/container-contract";
import { getWorkerConfig } from "../src/config";
import { deleteOldProcessedUpdates, reserveSearchUpdate } from "../src/db";
import { localD1 } from "./helpers/local-d1";
import type { D1BatchDatabaseLike, Env, JobRecord } from "../src/types";

let database: Awaited<ReturnType<typeof localD1>>;
let db: D1BatchDatabaseLike;
let env: Env;
const create = vi.fn(async () => ({ status: async () => ({ status: "running" }) }));

function updateRequest(text: string, id = 1, userId = 12345, secret = "webhook-secret", chatType = "private", reply?: Record<string, unknown>): Request {
  return new Request("https://worker.example/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({ update_id: id, message: { message_id: id, chat: { id: userId, type: chatType }, from: { id: userId }, text, ...(reply ? { reply_to_message: reply } : {}) } }),
  });
}
const transcript = "# Example\n\nSource: Youtube\nDuration: 00:00:10.000\n\nMethod: Automatic speech transcription (Whisper small)\n\n## Transcript\n\n[00:00:01.000] <b>Climate change & energy</b>\n";
const replyDocument = { message_id: 90, chat: { id: 12345, type: "private" }, document: { file_id: "file_123", file_name: "Example.md", file_size: new TextEncoder().encode(transcript).length } };
function transcriptFetch(uncertainSend = false): void {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/getFile")) return Response.json({ ok: true, result: { ...replyDocument.document, file_path: "documents/file_123.md" } });
    if (url.includes("/file/bot")) return new Response(transcript);
    if (uncertainSend) throw new Error("uncertain Telegram send");
    return Response.json({ ok: true, result: { message_id: 9001 } });
  }));
}
async function count(table: "jobs" | "processed_updates" | "job_dispatch_intents" | "telegram_notices" | "active_job_admissions"): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>())!.count;
}

describe("Telegram webhook with actual local D1 transactions", () => {
  beforeAll(async () => { database = await localD1(); db = database.db; }, 30_000);
  afterAll(async () => { await database?.dispose(); });
  beforeEach(async () => {
    await db.batch([db.prepare("DELETE FROM telegram_notices"), db.prepare("DELETE FROM jobs"), db.prepare("DELETE FROM processed_updates")]);
    create.mockClear();
    env = {
      DB: db, TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      INTERNAL_CONTAINER_SECRET: "internal-secret", ALLOWED_TELEGRAM_USER_IDS: "12345,67890",
      DOWNLOAD_LINK_HMAC_SECRET: "download-hmac", ALLOWED_SOURCE_HOSTS: "youtube.com,youtu.be",
      PUBLIC_WORKER_BASE_URL: "https://worker.example", MEDIA_WORKFLOW: { create },
    } as unknown as Env;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 9001 } }), { status: 200 })));
  });

  it("keeps commands and media mode parsing", () => {
    expect(parseTelegramCommand("https://youtu.be/abc")).toEqual({ kind: "media", mode: "video", sourceUrl: "https://youtu.be/abc" });
    expect(parseTelegramCommand("/audio https://youtube.com/watch?v=abc")).toEqual({ kind: "media", mode: "audio", sourceUrl: "https://youtube.com/watch?v=abc", audioFormat: "m4a" });
    for (const command of ["start", "help", "status", "queue", "sources", "activity"]) expect(parseTelegramCommand(`/${command}@DigiBot`)).toEqual({ kind: command });
    expect(parseTelegramCommand("/stats@DigiBot")).toEqual({ kind: "stats", period: "7d" });
    for (const period of ["24h", "7d", "30d", "all"]) expect(parseTelegramCommand(`/stats@DigiBot ${period.toUpperCase()}`)).toEqual({ kind: "stats", period });
    for (const command of ["/stats 90d", "/stats all extra", "/stats https://youtu.be/abc", "/activity extra"]) expect(parseTelegramCommand(command)).toBeNull();
    expect(parseTelegramCommand("/transcript https://youtu.be/abc")).toEqual({ kind: "transcript", sourceUrl: "https://youtu.be/abc" });
    expect(parseTelegramCommand("/transcript https://youtu.be/abc extra")).toBeNull();
    expect(parseTelegramCommand("/captions@DigiBot https://youtu.be/abc pt-BR")).toEqual({ kind: "captions", sourceUrl: "https://youtu.be/abc", language: "pt-br" });
    expect(parseTelegramCommand("/captions https://youtu.be/abc")).toEqual({ kind: "captions", sourceUrl: "https://youtu.be/abc" });
    expect(parseTelegramCommand("/captions https://youtu.be/abc --all-subs")).toBeNull();
    expect(parseTelegramCommand("/captions https://youtu.be/abc it extra")).toBeNull();
    expect(parseTelegramCommand("/captions https://youtu.be/abc en-US-a-b-c")).toBeNull();
    expect(parseTelegramCommand("/search@DigiBot climate change")).toEqual({ kind: "search", query: "climate change" });
    expect(parseTelegramCommand("/search")).toBeNull();
    expect(parseTelegramCommand(`/search ${"a".repeat(201)}`)).toBeNull();
  });

  it.each([
    ["https://music.youtube.com/watch?v=abc&list=album&si=share", { mode: "audio", audioFormat: "m4a" }],
    ["https://MUSIC.YouTube.com./watch?v=abc", { mode: "audio", audioFormat: "m4a" }],
    ["/video@DigiBot https://music.youtube.com/watch?v=abc", { mode: "video" }],
    ["/audio https://music.youtube.com/watch?v=abc", { mode: "audio", audioFormat: "m4a" }],
    ["/audio@DigiBot https://youtube.com/watch?v=abc MP3", { mode: "audio", audioFormat: "mp3" }],
    ["/audio https://youtube.com/watch?v=abc m4a", { mode: "audio", audioFormat: "m4a" }],
    ["/video https://youtube.com/watch?v=abc first 5 minutes", { mode: "video", trimStartSeconds: 0, trimEndSeconds: 300 }],
    ["/audio https://youtube.com/watch?v=abc mp3 from 12:00 for 5 minutes", { mode: "audio", audioFormat: "mp3", trimStartSeconds: 720, trimEndSeconds: 1020 }],
    ["/audio https://youtube.com/watch?v=abc from 12:00 to 17:00 mp3", { mode: "audio", audioFormat: "mp3", trimStartSeconds: 720, trimEndSeconds: 1020 }],
    ["https://music.youtube.com.evil.example/watch?v=abc", { mode: "video" }],
    ["https://music.youtube.com@evil.example/watch?v=abc", { mode: "video" }],
  ])("selects the requested mode and format for %s", (text, expected) => {
    expect(parseTelegramCommand(text)).toMatchObject({ kind: "media", ...expected });
  });

  it.each([
    "/video https://youtu.be/abc mp3",
    "/audio https://youtu.be/abc wav",
    "/audio https://youtu.be/abc mp3 m4a",
    "/audio https://youtu.be/abc mp3 first 5 minutes mp3",
    "/audio https://youtu.be/abc first mp3 5 minutes",
    "/audio https://youtu.be/abc first 5 mp3 minutes",
    "/audio https://youtu.be/abc https://youtu.be/def",
    "/video https://youtu.be/abc first 5 mp3",
    "https://youtu.be/abc extra",
    "https://[broken",
  ])("rejects invalid media tokens: %s", (text) => {
    expect(parseTelegramCommand(text)).toBeNull();
  });

  it("returns an explicit safe timing error for malformed trim input", () => {
    const result = parseTelegramCommandDetailed("/video https://youtu.be/abc from 12:00 for 5");
    expect(result).toMatchObject({ kind: "error", code: "INVALID_REQUEST" });
    if (result.kind === "error") {
      expect(result.message).toContain("Timing");
      expect(result.message).not.toContain("12:00");
      expect(result.message).not.toContain("for 5");
    }
  });

  it("accepts a YouTube Music track as an audio job and prepares M4A", async () => {
    env = { ...env, ALLOWED_SOURCE_HOSTS: "" } as unknown as Env;
    const sourceUrl = "https://music.youtube.com/watch?v=abc&list=album&si=share";
    const response = await handleTelegramWebhook(updateRequest(sourceUrl), env);
    expect(await response.json()).toMatchObject({ accepted: true });
    const job = (await db.prepare("SELECT * FROM jobs").first<JobRecord>())!;
    expect(job).toMatchObject({ source_host: "music.youtube.com", requested_mode: "audio", requested_quality: "m4a" });
    expect(buildPrepareRequest({ ...job, waiting_message_id: "9001" }, sourceUrl, getWorkerConfig(env))).toMatchObject({
      sourceUrl, mode: "audio", preferredFormat: "m4a",
    });
    expect(await count("job_dispatch_intents")).toBe(1);
  });

  it.each([
    ["/audio https://youtube.com/watch?v=abc", "m4a", "m4a"],
    ["/audio@DigiBot https://youtube.com/watch?v=abc MP3", "mp3", "mp3"],
  ])("admits %s with durable quality %s and container format %s", async (text, quality, preferredFormat) => {
    const response = await handleTelegramWebhook(updateRequest(text), env);
    expect(await response.json()).toMatchObject({ accepted: true });
    const job = (await db.prepare("SELECT * FROM jobs").first<JobRecord>())!;
    expect(job).toMatchObject({ requested_mode: "audio", requested_quality: quality });
    expect(buildPrepareRequest({ ...job, waiting_message_id: "9001" }, "https://youtube.com/watch?v=abc", getWorkerConfig(env))).toMatchObject({ preferredFormat });
  });

  it("admits a transcript as an audio operation on the isolated lane", async () => {
    const response = await handleTelegramWebhook(updateRequest("/transcript https://youtube.com/watch?v=abc", 19), env);
    expect(await response.json()).toMatchObject({ accepted: true });
    const job = (await db.prepare("SELECT * FROM jobs").first<JobRecord>())!;
    expect(job).toMatchObject({ requested_mode: "audio", requested_operation: "transcript", requested_quality: "m4a" });
    expect((await db.prepare("SELECT lane FROM active_job_admissions WHERE job_id = ?1").bind(job.id).first<{ lane: string }>())?.lane).toBe("transcript");
    expect(buildPrepareRequest({ ...job, waiting_message_id: "9001" }, "https://youtube.com/watch?v=abc", getWorkerConfig(env))).toMatchObject({
      operation: "transcript", mode: "audio", preferredFormat: "m4a",
    });
  });

  it("persists caption language and uses the source admission lane", async () => {
    const response = await handleTelegramWebhook(updateRequest("/captions https://youtube.com/watch?v=abc it", 30), env);
    expect(await response.json()).toMatchObject({ accepted: true });
    const job = (await db.prepare("SELECT * FROM jobs").first<JobRecord>())!;
    expect(job).toMatchObject({ requested_operation: "transcript", transcript_method: "captions", caption_language: "it" });
    expect((await db.prepare("SELECT lane FROM active_job_admissions WHERE job_id = ?1").bind(job.id).first<{ lane: string }>())?.lane).toBe("source");
    expect(buildPrepareRequest({ ...job, waiting_message_id: "9001" }, "https://youtube.com/watch?v=abc", getWorkerConfig(env))).toMatchObject({ operation: "transcript", transcriptMethod: "captions", captionLanguage: "it", mode: "audio" });
  });

  it("searches only the replied file, sends plain passages, and retains no private text", async () => {
    env.TELEGRAM_BOT_TOKEN = "123:token";
    transcriptFetch();
    const response = await handleTelegramWebhook(updateRequest("/search climate change", 40, 12345, "webhook-secret", "private", replyDocument), env);
    expect(await response.json()).toEqual({ ok: true, accepted: true });
    const send = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/sendMessage"));
    const payload = JSON.parse(String(send?.[1]?.body));
    expect(payload.text).toContain("[00:00:01.000] <b>Climate change & energy</b>");
    expect(payload).not.toHaveProperty("parse_mode");
    expect(await count("jobs")).toBe(0);
    expect(await count("telegram_notices")).toBe(0);
    const rows = await db.prepare("SELECT * FROM processed_updates").all();
    expect(rows.results).toEqual([{ telegram_update_id: "40", job_id: null, created_at: expect.any(String), search_user_id: "12345", collection_user_id: null }]);
    const calls = vi.mocked(fetch).mock.calls.length;
    expect(await (await handleTelegramWebhook(updateRequest("/search climate change", 40, 12345, "webhook-secret", "private", replyDocument), env)).json()).toMatchObject({ duplicate: true });
    expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it("requires an authorized same-private-chat reply before downloading", async () => {
    const wrongChat = { ...replyDocument, chat: { id: 67890, type: "private" } };
    const replies = [undefined, wrongChat, { ...replyDocument, chat: { id: 12345, type: "group" } }, { ...replyDocument, document: { ...replyDocument.document, file_size: 2_000_001 } }];
    for (const [index, reply] of replies.entries()) {
      expect(await (await handleTelegramWebhook(updateRequest("/search climate", 50 + index, 12345, "webhook-secret", "private", reply), env)).json()).toMatchObject({ accepted: false });
    }
    expect(await (await handleTelegramWebhook(updateRequest("/search climate", 60, 99, "webhook-secret", "private", replyDocument), env)).json()).toMatchObject({ ignored: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not retry or send an error fallback after an uncertain search reply", async () => {
    env.TELEGRAM_BOT_TOKEN = "123:token";
    transcriptFetch(true);
    expect(await (await handleTelegramWebhook(updateRequest("/search climate", 70, 12345, "webhook-secret", "private", replyDocument), env)).json()).toMatchObject({ accepted: true });
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/sendMessage"))).toHaveLength(1);
    expect(await count("telegram_notices")).toBe(0);
    expect(await (await handleTelegramWebhook(updateRequest("/search climate", 70, 12345, "webhook-secret", "private", replyDocument), env)).json()).toMatchObject({ duplicate: true });
  });

  it("atomically enforces search cooldown and hourly bounds, then uses existing receipt cleanup", async () => {
    const now = new Date("2026-09-07T12:00:00.000Z");
    const outcomes = await Promise.all([reserveSearchUpdate(db, "80", "12345", 2, now), reserveSearchUpdate(db, "81", "12345", 2, now)]);
    expect(outcomes.sort()).toEqual(["accepted", "limited"]);
    expect(await reserveSearchUpdate(db, "82", "67890", 2, now)).toBe("accepted");
    expect(await reserveSearchUpdate(db, "83", "12345", 2, new Date(now.getTime() + 30_000))).toBe("accepted");
    expect(await reserveSearchUpdate(db, "84", "12345", 2, new Date(now.getTime() + 60_000))).toBe("limited");
    await deleteOldProcessedUpdates(db, "2026-09-08T00:00:00.000Z");
    expect(await count("processed_updates")).toBe(0);
    const failingDb = { prepare: () => { throw new Error("D1 unavailable"); } };
    await expect(reserveSearchUpdate(failingDb, "85", "12345", 2, now)).rejects.toThrow("D1 unavailable");
  });

  it("persists trim bounds through admission and the Container request", async () => {
    const response = await handleTelegramWebhook(updateRequest("/video https://youtube.com/watch?v=abc first 5 minutes", 20), env);
    expect(await response.json()).toMatchObject({ accepted: true, qualityPending: true });
    const choice = (await db.prepare("SELECT token FROM video_quality_choices WHERE choice = 'automatic'").first<{ token: string }>())!;
    const selected = await handleTelegramWebhook(new Request("https://worker.example/telegram/webhook", {
      method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "webhook-secret" },
      body: JSON.stringify({ update_id: 22, callback_query: { id: "query", data: choice.token, from: { id: 12345 },
        message: { message_id: 9001, date: 1_700_000_000, chat: { id: 12345, type: "private" } } } }),
    }), env);
    expect(await selected.json()).toMatchObject({ accepted: true });
    const job = (await db.prepare("SELECT * FROM jobs").first<JobRecord>())!;
    expect(job).toMatchObject({ requested_start_seconds: 0, requested_end_seconds: 300 });
    expect(buildPrepareRequest({ ...job, waiting_message_id: "9001" }, "https://youtube.com/watch?v=abc", getWorkerConfig(env))).toMatchObject({
      trimStartSeconds: 0,
      trimEndSeconds: 300,
    });
  });

  it("acknowledges an invalid timing phrase with a bounded notice", async () => {
    const response = await handleTelegramWebhook(updateRequest("/video https://youtube.com/watch?v=abc from 12:00 for 5", 21), env);
    expect(await response.json()).toMatchObject({ accepted: false, error: "INVALID_REQUEST" });
    const notice = (await db.prepare("SELECT text FROM telegram_notices").first<{ text: string }>())?.text ?? "";
    expect(notice).toContain("Timing");
    expect(notice).not.toContain("12:00");
    expect(notice).not.toContain("for 5");
    expect(await count("jobs")).toBe(0);
  });

  it("rejects bad authentication and ignores unauthorized or nonprivate users", async () => {
    expect((await handleTelegramWebhook(updateRequest("/help", 1, 12345, "bad"), env)).status).toBe(403);
    for (const request of [updateRequest("/help", 2, 99), updateRequest("/help", 3, 12345, "webhook-secret", "group")]) {
      expect(await (await handleTelegramWebhook(request, env)).json()).toEqual({ ok: true, ignored: true });
    }
    expect(await count("processed_updates")).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves transport validation before durable acceptance", async () => {
    const headers = { "X-Telegram-Bot-Api-Secret-Token": "webhook-secret" };
    expect((await handleTelegramWebhook(new Request("https://worker.example", { method: "GET" }), env)).status).toBe(405);
    expect((await handleTelegramWebhook(new Request("https://worker.example", { method: "POST", headers, body: "text" }), env)).status).toBe(415);
    expect((await handleTelegramWebhook(new Request("https://worker.example", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{" }), env)).status).toBe(400);
    expect((await handleTelegramWebhook(new Request("https://worker.example", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "x".repeat(128 * 1024 + 1) }), env)).status).toBe(413);
    expect(await count("processed_updates")).toBe(0);
  });

  it("atomically accepts 100 concurrent copies as one job/intent and one queue notice", async () => {
    const background: Promise<unknown>[] = [];
    const responses = await Promise.all(Array.from({ length: 100 }, () => handleTelegramWebhook(updateRequest("https://youtu.be/abc"), env, (promise) => { background.push(promise); })));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    await Promise.all(background);
    expect(await count("jobs")).toBe(1);
    expect(await count("processed_updates")).toBe(1);
    expect(await count("job_dispatch_intents")).toBe(1);
    expect(create).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(await count("telegram_notices")).toBe(1);
  }, 30_000);

  it.each(["/start", "/help", "/status", "/queue", "/sources", "/stats", "/stats 24h", "/stats all", "/activity", "not a link", "https://unsupported.example/video"])("durably acknowledges %s before any external notice", async (text) => {
    expect((await handleTelegramWebhook(updateRequest(text), env)).status).toBe(200);
    expect(await count("telegram_notices")).toBe(1);
    expect(await count("jobs")).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    await dispatchNotices(env);
    expect(fetch).toHaveBeenCalledOnce();
    expect(await (await handleTelegramWebhook(updateRequest(text), env)).json()).toEqual({ ok: true, duplicate: true });
  });

  it("shares the newcomer guide for /help and /start without starting a media job", async () => {
    await handleTelegramWebhook(updateRequest("/help", 101), env);
    await handleTelegramWebhook(updateRequest("/start", 102), env);
    const help = (await db.prepare("SELECT text FROM telegram_notices WHERE update_id = '101'").first<{ text: string }>())!.text;
    const start = (await db.prepare("SELECT text FROM telegram_notices WHERE update_id = '102'").first<{ text: string }>())!.text;
    expect(start).toBe(help);
    for (const command of ["/video URL", "/audio URL [m4a|mp3]", "/clips URL", "/transcript URL", "/captions URL", "/search", "/queue", "/status", "/stats [24h|7d|30d|all]", "/activity", "/sources"]) {
      expect(help).toContain(command);
    }
    expect(help).not.toContain("https://");
    expect(help).toContain("/playlist URL [1-5] [video|m4a|mp3]");
    expect(help).toContain("/channel URL [1-5] [video|m4a|mp3]");
    expect(help).toContain("5 unfinished-request limit");
    expect(help).toContain("15 minutes");
    expect(help).toContain("20 MB");
    expect(help.length).toBeLessThanOrEqual(2000);
    expect(help).not.toContain("Provenance");
    // The Provenance block is shown only while connected media is switched on.
    await handleTelegramWebhook(updateRequest("/help", 103), { ...env, INTEGRATION_ENABLED: "true" } as unknown as Env);
    const connected = (await db.prepare("SELECT text FROM telegram_notices WHERE update_id = '103'").first<{ text: string }>())!.text;
    expect(connected).toContain("🖼️ Provenance");
    expect(connected).toContain("tap Check this image, or reply /check");
    expect(connected.length).toBeLessThanOrEqual(2000);
    expect(await count("jobs")).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("formats retained stats and latest activity from only the requesting user's jobs", async () => {
    await handleTelegramWebhook(updateRequest("/audio https://youtu.be/owner-source", 1), env);
    await handleTelegramWebhook(updateRequest("https://youtu.be/other-source", 2, 67890), env);
    await handleTelegramWebhook(updateRequest("https://youtu.be/another-source", 3, 67890), env);
    await db.prepare("UPDATE job_deliveries SET state = 'confirmed', method = 'telegram', telegram_message_id = '101' WHERE job_id = (SELECT id FROM jobs WHERE telegram_user_id = '12345')").run();
    await db.prepare("UPDATE jobs SET output_mime_type = 'audio/mp4' WHERE telegram_user_id = '12345'").run();
    await handleTelegramWebhook(updateRequest("/stats all", 4), env);
    await handleTelegramWebhook(updateRequest("/activity", 5), env);
    const stats = (await db.prepare("SELECT text FROM telegram_notices WHERE update_id = '4'").first<{ text: string }>())!.text;
    const activity = (await db.prepare("SELECT text FROM telegram_notices WHERE update_id = '5'").first<{ text: string }>())!.text;
    expect(stats).toContain("All retained history");
    expect(stats).toContain("Accepted: 1");
    expect(stats).toContain("Confirmed: 1 · Failed: 0");
    expect(stats).toContain("• Audio: 1");
    expect(activity).toContain("Latest accepted jobs (UTC)");
    expect(activity).toContain("Audio · YouTube · Confirmed");
    expect(activity.split("\n").filter((line) => line.includes(" · "))).toHaveLength(1);
    expect(stats + activity).not.toMatch(/owner-source|other-source|another-source|12345|67890|https:/u);
    expect(await count("jobs")).toBe(3);
    await handleTelegramWebhook(updateRequest("/help", 6), env);
    const help = (await db.prepare("SELECT text FROM telegram_notices WHERE update_id = '6'").first<{ text: string }>())!.text;
    expect(help).toContain("/stats [24h|7d|30d|all]");
    expect(help.length).toBeLessThanOrEqual(4096);
  });

  it("queues a second user's busy-lane job with a durable position while keeping one admission", async () => {
    await handleTelegramWebhook(updateRequest("https://youtu.be/first"), env);
    const response = await handleTelegramWebhook(updateRequest("https://youtu.be/second", 2, 67890), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true });
    expect(await count("jobs")).toBe(2);
    expect(await count("active_job_admissions")).toBe(1);
    expect(create).toHaveBeenCalledOnce();
    expect((await db.prepare("SELECT text FROM telegram_notices WHERE update_id = '2'").first<{ text: string }>())!.text).toMatch(/position.*1/iu);
  }, 30_000);

  it("bounds unfinished jobs independently of the hourly cap and scopes queue/status to their owner", async () => {
    env.MAX_JOBS_PER_HOUR = "20";
    for (let index = 1; index <= 5; index += 1) {
      expect(await (await handleTelegramWebhook(updateRequest(`https://youtu.be/job${index}`, index), env)).json()).toMatchObject({ accepted: true });
    }
    expect(await (await handleTelegramWebhook(updateRequest("https://youtu.be/sixth", 6), env)).json()).toMatchObject({ accepted: false });
    expect(await count("jobs")).toBe(5);
    expect((await db.prepare("SELECT text FROM telegram_notices WHERE update_id = '6'").first<{ text: string }>())!.text).toContain("5 unfinished");
    await handleTelegramWebhook(updateRequest("https://youtube.com/watch?v=private-other-user", 7, 67890), env);
    await handleTelegramWebhook(updateRequest("/queue", 8), env);
    const queueText = (await db.prepare("SELECT text FROM telegram_notices WHERE update_id = '8'").first<{ text: string }>())!.text;
    expect(queueText.match(/^\d+\./gmu)).toHaveLength(5);
    expect(queueText).toContain("position 4");
    expect(queueText).not.toContain("youtube.com");
    expect(queueText).not.toContain("private-other-user");
    await handleTelegramWebhook(updateRequest("/status", 9), env);
    expect((await db.prepare("SELECT text FROM telegram_notices WHERE update_id = '9'").first<{ text: string }>())!.text).toContain("position 4");
  }, 30_000);

  it("keeps the hourly quota user scoped and reports a durable reason", async () => {
    env = { ...env, MAX_ACTIVE_JOBS: "3", MAX_JOBS_PER_HOUR: "1" } as unknown as Env;
    await handleTelegramWebhook(updateRequest("https://youtu.be/first"), env);
    const response = await handleTelegramWebhook(updateRequest("https://youtu.be/second", 2), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: false });
    expect((await db.prepare("SELECT text FROM telegram_notices WHERE update_id = '2'").first<{ text: string }>())!.text).toContain("hourly");
    expect((await handleTelegramWebhook(updateRequest("https://youtu.be/third", 3, 67890), env)).status).toBe(200);
    expect(await count("jobs")).toBe(2);
  });

  it("never acknowledges acceptance when the atomic D1 write fails", async () => {
    const failedEnv = { ...env, DB: { prepare: (sql: string) => db.prepare(sql), batch: async () => { throw new Error("D1 unavailable"); } } } as unknown as Env;
    for (const text of ["https://youtu.be/abc", "/help", "https://unsupported.example/video"]) {
      expect((await handleTelegramWebhook(updateRequest(text), failedEnv)).status).toBe(500);
    }
    expect(await count("processed_updates")).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports uncertainty through /status without claiming delivery succeeded", async () => {
    await handleTelegramWebhook(updateRequest("https://youtu.be/abc"), env);
    await db.prepare("UPDATE job_deliveries SET state = 'unknown'").run();
    await handleTelegramWebhook(updateRequest("/status", 2), env);
    expect((await db.prepare("SELECT text FROM telegram_notices WHERE update_id = '2'").first<{ text: string }>())!.text).toContain("outcome unknown");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not wait for a stalled Workflow create before acknowledging HTTP", async () => {
    const pending: Promise<unknown>[] = [];
    let backgroundSettled = false;
    const stalled = { ...env, MEDIA_WORKFLOW: { create: () => new Promise(() => {}) } } as unknown as Env;
    const response = await handleTelegramWebhook(updateRequest("https://youtu.be/abc"), stalled, (promise) => {
      pending.push(promise.finally(() => { backgroundSettled = true; }));
    });
    expect(response.status).toBe(200);
    expect(pending).toHaveLength(1);
    expect(backgroundSettled).toBe(false);
    await Promise.all(pending);
    expect(await count("job_dispatch_intents")).toBe(1);
    expect(fetch).toHaveBeenCalledOnce();
  }, 30_000);
});

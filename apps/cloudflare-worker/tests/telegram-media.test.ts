import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTelegramWebhook, parseTelegramCommandDetailed } from "../src/webhook";
import { buildPrepareRequest } from "../src/container-contract";
import { decryptSourceUrl } from "../src/crypto";
import { dispatchNotices } from "../src/notices";
import { setJobCompleted, setJobFailure } from "../src/db";
import { localD1 } from "./helpers/local-d1";
import type { D1BatchDatabaseLike, Env, JobRecord } from "../src/types";

vi.mock("../src/dispatch", () => ({ dispatchAcceptedJob: vi.fn(async () => undefined) }));
let database: Awaited<ReturnType<typeof localD1>>;
let db: D1BatchDatabaseLike;
let env: Env;
const metadata = { file_id: "private-telegram-file-id_123456", file_size: 1200, file_name: "Private recording.mp4", mime_type: "video/mp4" };
const reply = { message_id: 90, chat: { id: 12345, type: "private" }, from: { id: 98765 }, video: metadata,
  forward_origin: { type: "channel", chat: { id: -100111, type: "channel" }, message_id: 8 }, caption: "/audio https://youtu.be/ignored" };
function request(message: Record<string, unknown>, updateId = 1, secret = "webhook-secret"): Request {
  return new Request("https://worker.example/telegram/webhook", { method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({ update_id: updateId, message: { message_id: updateId, from: { id: 12345 }, chat: { id: 12345, type: "private" }, ...message } }) });
}
async function convert(text = "/audio mp3 first 30 seconds", replyMessage: unknown = reply, id = 1): Promise<Record<string, unknown>> {
  return (await handleTelegramWebhook(request({ text, reply_to_message: replyMessage }, id), env)).json();
}
async function count(table: "jobs" | "processed_updates" | "telegram_notices" | "video_quality_prompts" | "video_quality_choices" | "job_dispatch_intents"): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}
async function job(): Promise<JobRecord> {
  return (await db.prepare("SELECT * FROM jobs").first<JobRecord>())!;
}
async function select(id: number, choice: string): Promise<Record<string, unknown>> {
  const row = (await db.prepare("SELECT token FROM video_quality_choices WHERE choice = ?1").bind(choice).first<{ token: string }>())!;
  const response = await handleTelegramWebhook(new Request("https://worker.example/telegram/webhook", { method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "webhook-secret" },
    body: JSON.stringify({ update_id: id, callback_query: { id: `query-${id}`, data: row.token, from: { id: 12345 },
      message: { message_id: 9001, date: 1_700_000_000, chat: { id: 12345, type: "private" } } } }) }), env);
  return response.json();
}

describe("reply conversion of Telegram media on local D1", () => {
  beforeAll(async () => { database = await localD1(); db = database.db; }, 30_000);
  afterAll(async () => { await database?.dispose(); vi.unstubAllGlobals(); });
  beforeEach(async () => {
    await db.batch([db.prepare("DELETE FROM telegram_notices"), db.prepare("DELETE FROM jobs"), db.prepare("DELETE FROM processed_updates")]);
    env = { DB: db, TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      INTERNAL_CONTAINER_SECRET: "internal-secret", ALLOWED_TELEGRAM_USER_IDS: "12345,67890",
      DOWNLOAD_LINK_HMAC_SECRET: "download-hmac", ALLOWED_SOURCE_HOSTS: "youtube.com,youtu.be",
      PUBLIC_WORKER_BASE_URL: "https://worker.example", MAX_JOBS_PER_HOUR: "100",
    } as unknown as Env;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, result: { message_id: 9001 } })));
  });

  it.each(["video", "audio", "voice", "document"])("gives instructions for direct or forwarded %s without executing captions or starting a job", async (field) => {
    for (const forwarded of [false, true]) {
      const id = forwarded ? 2 : 1;
      const message = { [field]: metadata, caption: "/video https://youtu.be/private-caption", text: "/audio https://youtu.be/also-ignored",
        ...(forwarded ? { forward_origin: { type: "user", sender_user: { id: 98765 } } } : {}) };
      expect(await (await handleTelegramWebhook(request(message, id), env)).json()).toMatchObject({ accepted: true });
      expect(await (await handleTelegramWebhook(request(message, id), env)).json()).toMatchObject({ duplicate: true });
    }
    expect(await count("jobs")).toBe(0);
    expect(await count("video_quality_prompts")).toBe(0);
    expect(await count("job_dispatch_intents")).toBe(0);
    const notices = await db.prepare("SELECT * FROM telegram_notices").all<Record<string, unknown>>();
    expect(notices.results).toHaveLength(2);
    for (const notice of notices.results) {
      expect(notice.text).toContain("Reply to this file");
      expect(notice.text).toContain("20 MB");
    }
    expect(JSON.stringify(notices)).not.toContain(metadata.file_id);
    expect(JSON.stringify(notices)).not.toContain(metadata.file_name);
    await dispatchNotices(env);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    for (const [url] of vi.mocked(fetch).mock.calls) expect(String(url)).toMatch(/\/sendMessage$/u);
  });

  it("guides Markdown uploads to reply search without admitting or retaining any document", async () => {
    const documents = [
      { file_name: "publisher.md", file_size: 435 },
      { file_name: "notes.pdf", file_size: 435 },
      { file_name: "archive.zip", file_size: 435 },
      { file_name: "oversize.md", file_size: 2_000_001 },
    ];
    for (const [index, document] of documents.entries()) {
      const result = await (await handleTelegramWebhook(request({ document: { ...metadata, mime_type: "text/plain", ...document },
        caption: "/search climate change" }, index + 1), env)).json();
      expect(result).toMatchObject({ accepted: index === 0 });
      const notice = (await db.prepare("SELECT text FROM telegram_notices WHERE update_id = ?1").bind(String(index + 1)).first<{ text: string }>())!;
      expect(notice.text).toContain(index === 0 ? "/search climate change" : "does not look like audio or video");
      expect(notice.text).not.toContain(document.file_name);
      expect(notice.text).not.toContain(metadata.file_id);
    }
    expect(await count("jobs")).toBe(0);
    expect(await count("video_quality_prompts")).toBe(0);
    expect(await count("job_dispatch_intents")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM processed_updates WHERE search_user_id IS NOT NULL").first()).toEqual({ n: 0 });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it.each([
    ["/audio", "m4a", undefined, undefined],
    ["/audio@DigiBot MP3", "mp3", undefined, undefined],
    ["/audio m4a first 30 seconds", "m4a", 0, 30],
    ["/audio from 1:00 to 2:00 mp3", "mp3", 60, 120],
  ])("parses %s only with reply context and reuses the existing trim contract", (text, audioFormat, start, end) => {
    expect(parseTelegramCommandDetailed(text as string, true)).toMatchObject({ kind: "command", command: {
      kind: "media", mode: "audio", sourceUrl: null, audioFormat,
      ...(start !== undefined ? { trimStartSeconds: start, trimEndSeconds: end } : {}),
    } });
    expect(parseTelegramCommandDetailed(text as string).kind).toBe("error");
  });

  it("admits audio with scoped encrypted file metadata, format and timing", async () => {
    expect(await convert()).toMatchObject({ accepted: true });
    const admitted = await job();
    expect(admitted).toMatchObject({ source_kind: "telegram_file", source_host: "telegram", requested_mode: "audio",
      requested_operation: "download", requested_quality: "mp3", requested_start_seconds: 0, requested_end_seconds: 30, cache_valid: 0 });
    const decrypted = (await decryptSourceUrl("internal-secret", admitted.source_url_encrypted!))!;
    expect(JSON.parse(decrypted)).toEqual({ fileId: metadata.file_id, fileSize: 1200, fileName: metadata.file_name });
    expect(JSON.stringify(admitted)).not.toContain(metadata.file_id);
    expect(JSON.stringify(admitted)).not.toContain(metadata.file_name);
    const prepared = buildPrepareRequest({ ...admitted, waiting_message_id: "9001" }, decrypted, { defaultMaxHeight: 1080 });
    expect(prepared).toMatchObject({ telegramFile: { fileId: metadata.file_id, fileSize: 1200, fileName: metadata.file_name }, mode: "audio", preferredFormat: "mp3", trimStartSeconds: 0, trimEndSeconds: 30 });
    expect(prepared).not.toHaveProperty("sourceUrl");
    expect(prepared).not.toHaveProperty("transcriptMethod");
    for (const [url] of vi.mocked(fetch).mock.calls) expect(String(url)).not.toMatch(/getFile|\/file\/bot/u);
  });

  it("keeps video file kind/payload through the quality prompt and one-shot callback admission", async () => {
    expect(await convert("/video from 00:05 to 00:15")).toMatchObject({ qualityPending: true });
    expect(await count("jobs")).toBe(0);
    const prompt = (await db.prepare("SELECT * FROM video_quality_prompts").first<Record<string, unknown>>())!;
    expect(prompt).toMatchObject({ source_kind: "telegram_file", source_host: "telegram", trim_start_seconds: 5, trim_end_seconds: 15 });
    expect(JSON.stringify(prompt)).not.toContain(metadata.file_id);
    expect(await select(2, "720")).toMatchObject({ accepted: true });
    const admitted = await job();
    expect(admitted).toMatchObject({ source_kind: "telegram_file", requested_quality: "max-720p", request_message_id: "1", cache_valid: 0,
      requested_start_seconds: 5, requested_end_seconds: 15 });
    const decrypted = (await decryptSourceUrl("internal-secret", admitted.source_url_encrypted!))!;
    expect(buildPrepareRequest({ ...admitted, waiting_message_id: "9001" }, decrypted, { defaultMaxHeight: 1080 })).toMatchObject({ telegramFile: { fileId: metadata.file_id }, maximumHeight: 720 });
    expect(await count("video_quality_prompts")).toBe(0);
    expect(await count("video_quality_choices")).toBe(0);
    expect(await convert("/video from 00:05 to 00:15")).toMatchObject({ duplicate: true });
    expect(await count("jobs")).toBe(1);
  });

  it("admits a reply-to-file clip pack with encrypted source and one quality choice", async () => {
    expect(await convert("/clips first 2 seconds; from 00:03 for 2 seconds")).toMatchObject({ qualityPending: true });
    expect(await select(2, "720")).toMatchObject({ accepted: true });
    const admitted = await job();
    expect(admitted).toMatchObject({ source_kind: "telegram_file", cache_valid: 0, requested_start_seconds: null, requested_end_seconds: null });
    const decrypted = (await decryptSourceUrl("internal-secret", admitted.source_url_encrypted!))!;
    expect(buildPrepareRequest({ ...admitted, waiting_message_id: "9001" }, decrypted, { defaultMaxHeight: 1080 })).toMatchObject({ telegramFile: { fileId: metadata.file_id }, clipRanges: [{ startSeconds: 0, endSeconds: 2 }, { startSeconds: 3, endSeconds: 5 }] });
    expect(await count("jobs")).toBe(1);
  });

  it("deduplicates concurrent reply commands into one queued job and dispatch intent", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => convert()));
    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(await count("jobs")).toBe(1);
    expect(await count("job_dispatch_intents")).toBe(1);
    expect(await count("processed_updates")).toBe(1);
  });

  it("scopes file hashes to the actual authorized user and chat", async () => {
    await convert();
    const first = await job();
    const second = await handleTelegramWebhook(request({ text: "/audio", from: { id: 67890 }, chat: { id: 67890, type: "private" },
      reply_to_message: { ...reply, chat: { id: 67890, type: "private" } } }, 2), env);
    expect(await second.json()).toMatchObject({ accepted: true });
    const later = (await db.prepare("SELECT * FROM jobs WHERE telegram_update_id = '2'").first<JobRecord>())!;
    expect(later.source_url_hash).not.toBe(first.source_url_hash);
  });

  it.each([
    ["foreign chat", { ...reply, chat: { id: 67890, type: "private" } }],
    ["group", { ...reply, chat: { id: 12345, type: "group" } }],
    ["missing chat", { ...reply, chat: undefined }],
    ["invalid message id", { ...reply, message_id: 0 }],
    ["photo", { message_id: 90, chat: reply.chat, photo: [metadata] }],
    ["archive", { message_id: 90, chat: reply.chat, document: { ...metadata, file_name: "archive.zip", mime_type: "application/zip" } }],
    ["album", { ...reply, media_group_id: "group" }],
    ["animation", { ...reply, animation: metadata }],
    ["sticker", { message_id: 90, chat: reply.chat, sticker: metadata }],
    ["multiple media", { ...reply, audio: metadata }],
    ["malformed object", { ...reply, video: [] }],
    ["unknown size", { ...reply, video: { ...metadata, file_size: undefined } }],
    ["oversize", { ...reply, video: { ...metadata, file_size: 20_000_001 } }],
    ["zero size", { ...reply, video: { ...metadata, file_size: 0 } }],
    ["negative size", { ...reply, video: { ...metadata, file_size: -1 } }],
    ["unsafe size", { ...reply, video: { ...metadata, file_size: Number.MAX_SAFE_INTEGER + 1 } }],
    ["fractional size", { ...reply, video: { ...metadata, file_size: 1.5 } }],
    ["string size", { ...reply, video: { ...metadata, file_size: "1200" } }],
    ["boolean size", { ...reply, video: { ...metadata, file_size: true } }],
    ["missing id", { ...reply, video: { ...metadata, file_id: undefined } }],
    ["long id", { ...reply, video: { ...metadata, file_id: "x".repeat(257) } }],
    ["control in id", { ...reply, video: { ...metadata, file_id: "before\nafter" } }],
    ["long name", { ...reply, video: { ...metadata, file_name: "x".repeat(191) } }],
    ["control in name", { ...reply, video: { ...metadata, file_name: "before\u0000after" } }],
  ])("rejects %s before queueing or fetching", async (_name, invalidReply) => {
    expect(await convert("/audio", invalidReply)).toMatchObject({ accepted: false });
    expect(await count("jobs")).toBe(0);
    expect(await count("video_quality_prompts")).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(JSON.stringify(await db.prepare("SELECT text FROM telegram_notices").first())).not.toContain(metadata.file_id);
  });

  it("uses MIME or extension as document hints and accepts a bounded voice without a filename", async () => {
    const sources = [
      { document: { ...metadata, file_name: "recording.MKV", mime_type: "application/octet-stream" } },
      { document: { ...metadata, file_name: "recording", mime_type: "audio/ogg" } },
      { voice: { file_id: metadata.file_id, file_size: 20_000_000 } },
    ];
    for (const [index, media] of sources.entries()) expect(await convert("/audio", { message_id: 90, chat: reply.chat, ...media }, index + 1)).toMatchObject({ accepted: true });
    expect(await count("jobs")).toBe(3);
  });

  it("never gains authorization from forwarding metadata or an original sender", async () => {
    for (const message of [
      { from: { id: 11111 }, chat: { id: 11111, type: "private" } },
      { from: { id: 67890 }, chat: { id: 12345, type: "private" } },
      { from: { id: 12345 }, chat: { id: 12345, type: "group" } },
    ]) {
      const result = await handleTelegramWebhook(request({ ...message, text: "/audio", reply_to_message: reply,
        forward_origin: { type: "user", sender_user: { id: 12345 } } }), env);
      expect(await result.json()).toMatchObject({ ignored: true });
    }
    expect((await handleTelegramWebhook(request({ text: "/audio", reply_to_message: reply }, 1, "wrong-secret"), env)).status).toBe(403);
    expect(await count("processed_updates")).toBe(0);
    expect(await count("jobs")).toBe(0);
  });

  it("keeps explicit URL commands independent of replied media and excludes file transcription", async () => {
    const malformedReply = { ...reply, video: { file_id: "invalid", file_size: undefined } };
    expect(await convert("/audio https://youtu.be/abc mp3", malformedReply)).toMatchObject({ accepted: true });
    expect(await job()).toMatchObject({ source_kind: "url", source_host: "youtu.be", requested_quality: "mp3", cache_valid: 1 });
    expect(await convert("/transcript", reply, 2)).toMatchObject({ accepted: false });
    expect(await convert("/captions", reply, 3)).toMatchObject({ accepted: false });
    expect(await count("jobs")).toBe(1);
  });

  it.each(["completed", "failed"])("purges the encrypted file payload on terminal %s", async (status) => {
    await convert();
    const admitted = await job();
    if (status === "completed") await setJobCompleted(db, admitted.id);
    else await setJobFailure(db, admitted.id, "UNSUPPORTED_MEDIA", "That file is not supported.");
    expect(await job()).toMatchObject({ status, source_kind: "telegram_file", source_url_encrypted: null, cache_valid: 0 });
  });

  it.each(["cancel", "expire", "supersede"])("purges pending file sources on %s", async (action) => {
    await convert("/video");
    if (action === "cancel") expect(await select(2, "cancel")).toMatchObject({ cancelled: true });
    else if (action === "expire") await dispatchNotices(env, undefined, new Date(Date.now() + 600_001));
    else await convert("/video https://youtu.be/replacement", reply, 2);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM video_quality_prompts WHERE source_kind = 'telegram_file'").first()).toEqual({ n: 0 });
    expect(await count("jobs")).toBe(0);
    if (action !== "supersede") expect(await count("video_quality_choices")).toBe(0);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { getUserQueue } from "../src/db";
import { dispatchAcceptedJob } from "../src/dispatch";
import { handleIntegrationRequest, type IntegrationGatewayEnv } from "../src/integration";
import {
  admitIntegrationInvite,
  approveIntegrationPairing,
  createIntegrationInvitation,
  createIntegrationPairing,
  exchangeIntegrationPairing,
  type IntegrationPrincipal,
  type IntegrationSessionCredentials,
} from "../src/integration-auth";
import { createLensLinkDownload } from "../src/integration-link";
import { bytesToBase64Url } from "../src/security";
import { handleTelegramWebhook } from "../src/webhook";
import { localD1 } from "./helpers/local-d1";
import type { D1BatchDatabaseLike, JobRecord } from "../src/types";

vi.mock("../src/dispatch", async (importOriginal) => ({
  ...(await importOriginal() as object),
  dispatchAcceptedJob: vi.fn(async () => undefined),
}));
// The Worker entry point pulls in runtime-only bindings that the Node test environment cannot load.
vi.mock("../src/container", () => ({ DownloaderContainer: class DownloaderContainer {}, TranscriptionContainer: class TranscriptionContainer {} }));
vi.mock("../src/workflow", () => ({ MediaJobWorkflow: class MediaJobWorkflow {} }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
vi.mock("../src/retired-durable-objects", () => ({ NewsScheduler: class NewsScheduler {} }));

const OWNER = "12345";
const INVITED = "67890";
const LEGACY_SECOND = "67891";
const NOW = Math.floor(Date.now() / 1000);
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const PATH = "/api/integration/link-downloads";
const OPERATION_A = "11111111-1111-4111-8111-111111111111";
const OPERATION_B = "22222222-2222-4222-8222-222222222222";
const OPERATION_C = "33333333-3333-4333-8333-333333333333";
const INVALID_RANGE = "That trim range is invalid. Choose a positive range within 24 hours.";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const QUEUE_NOTICE = "Queued in the download/captions queue. Position when accepted: 1. Starts automatically.";
const SHARED_JOB_COLUMNS = `telegram_user_id, telegram_chat_id, source_host, source_url_hash, source_kind, requested_mode, requested_quality,
  requested_operation, transcript_method, caption_language, requested_start_seconds, requested_end_seconds, requested_clip_ranges,
  status, progress, processing_policy_version, cache_valid`;

type SentMessage = { chat_id: string; text: string };

let database: Awaited<ReturnType<typeof localD1>>;
let db: D1BatchDatabaseLike;
let env: IntegrationGatewayEnv;
let sentMessages: SentMessage[];
let pairingSeed = 0;

function operationId(index: number): string {
  return `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

function testEnvironment(): IntegrationGatewayEnv {
  return {
    DB: db,
    INTEGRATION_ENABLED: "true",
    INTEGRATION_ALLOWED_ORIGINS: ORIGIN,
    PUBLIC_WORKER_BASE_URL: "https://worker.example",
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    INTERNAL_CONTAINER_SECRET: "internal-secret",
    DOWNLOAD_LINK_HMAC_SECRET: "download-hmac",
    ALLOWED_TELEGRAM_USER_IDS: `${OWNER},${LEGACY_SECOND}`,
    ALLOWED_SOURCE_HOSTS: "youtube.com,youtu.be,music.youtube.com",
    TELEGRAM_BOT_API_BASE: "https://api.telegram.org",
    MAX_JOBS_PER_HOUR: "20",
  } as unknown as IntegrationGatewayEnv;
}

async function invitedAccount(): Promise<void> {
  const invitation = await createIntegrationInvitation(env, { issuerTelegramUserId: OWNER }, NOW);
  if (!invitation) throw new Error("Expected an owner invitation");
  const account = await admitIntegrationInvite(env, { telegramUserId: INVITED, privateChatId: INVITED, inviteToken: invitation.inviteToken }, NOW);
  if (account?.admissionSource !== "invitation") throw new Error("Expected an invited account");
}

/** A real device session: the owner's legacy account is created on approval, an invited one must exist already. */
async function pairedSession(telegramUserId: string): Promise<IntegrationSessionCredentials> {
  pairingSeed += 1;
  const verifier = bytesToBase64Url(new Uint8Array(32).fill(pairingSeed));
  const pairing = await createIntegrationPairing(env, { verifier, deviceName: `Lens ${pairingSeed}` }, NOW);
  const approved = await approveIntegrationPairing(env, {
    pairId: pairing.pairId, confirmationCode: pairing.confirmationCode, telegramUserId, privateChatId: telegramUserId,
  }, NOW);
  if (!approved) throw new Error("Expected an approved pairing");
  const session = await exchangeIntegrationPairing(env, { pairId: pairing.pairId, verifier }, NOW);
  if (!session) throw new Error("Expected a device session");
  return session;
}

function linkRequest(token: string, body: unknown, origin: string | null = ORIGIN): Request {
  const headers = new Headers({ authorization: `Bearer ${token}`, "content-type": "application/json" });
  if (origin !== null) headers.set("origin", origin);
  return new Request(`https://worker.example${PATH}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function post(token: string, body: unknown, origin: string | null = ORIGIN): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await handleIntegrationRequest(linkRequest(token, body, origin), env);
  if (!response) throw new Error("Expected an integration response");
  const json = await response.json() as Record<string, unknown>;
  const message = (json.error as { message?: string } | undefined)?.message;
  // Lens shows DigiBot's message verbatim and caps it at 1000 characters.
  if (message !== undefined) expect(message.length).toBeLessThanOrEqual(1000);
  return { status: response.status, json };
}

function webhookRequest(text: string, updateId: number, userId: string): Request {
  return new Request("https://worker.example/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "webhook-secret" },
    body: JSON.stringify({ update_id: updateId, message: { message_id: updateId, chat: { id: Number(userId), type: "private" }, from: { id: Number(userId) }, text } }),
  });
}

async function count(table: "jobs" | "processed_updates" | "telegram_notices"): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>())!.count;
}

async function job(id: unknown): Promise<JobRecord> {
  const row = await db.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<JobRecord>();
  if (!row) throw new Error(`Expected job ${String(id)}`);
  return row;
}

beforeAll(async () => {
  database = await localD1();
  db = database.db;
}, 30_000);

afterAll(async () => {
  await database?.dispose();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await db.batch([
    "DELETE FROM telegram_notices", "DELETE FROM active_job_admissions", "DELETE FROM job_dispatch_intents", "DELETE FROM job_deliveries",
    "DELETE FROM jobs", "DELETE FROM processed_updates", "DELETE FROM integration_sessions", "DELETE FROM integration_pairing_claims",
    "DELETE FROM integration_pairings", "DELETE FROM integration_invitation_claims", "DELETE FROM integration_invitations",
    "DELETE FROM integration_rate_limits", "DELETE FROM integration_accounts",
  ].map((sql) => db.prepare(sql)));
  sentMessages = [];
  env = testEnvironment();
  vi.mocked(dispatchAcceptedJob).mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/sendMessage")) sentMessages.push(JSON.parse(String(init?.body)) as SentMessage);
    return Response.json({ ok: true, result: { message_id: 800 + sentMessages.length } });
  }));
});

describe("Lens link downloads through the connected session", () => {
  it("queues the owner's and an invited account's page links as jobs bound to their own user and chat", async () => {
    const owner = await pairedSession(OWNER);
    await invitedAccount();
    const invited = await pairedSession(INVITED);

    const ownerResponse = await post(owner.accessToken, { operationId: OPERATION_A, sourceUrl: "https://youtu.be/owner-clip" });
    expect(ownerResponse.status).toBe(202);
    expect(ownerResponse.json).toEqual({ jobId: expect.stringMatching(UUID_V4), state: "queued" });
    expect(await job(ownerResponse.json.jobId)).toMatchObject({
      telegram_update_id: `lens:${owner.accountId}:${OPERATION_A}`, telegram_user_id: OWNER, telegram_chat_id: OWNER, request_message_id: null,
      source_host: "youtu.be", source_kind: "url", requested_mode: "video", requested_quality: "max-1080p", requested_operation: "download", status: "queued",
    });

    const invitedResponse = await post(invited.accessToken, { operationId: OPERATION_B, sourceUrl: "https://music.youtube.com/watch?v=track&si=share" });
    expect(invitedResponse.status).toBe(202);
    expect(await job(invitedResponse.json.jobId)).toMatchObject({
      telegram_update_id: `lens:${invited.accountId}:${OPERATION_B}`, telegram_user_id: INVITED, telegram_chat_id: INVITED,
      source_host: "music.youtube.com", requested_mode: "audio", requested_quality: "m4a", requested_operation: "download",
    });
    expect(dispatchAcceptedJob).toHaveBeenCalledTimes(2);
  });

  it("creates the same job a bare link pasted in the Telegram chat creates, minus the /queue hint", async () => {
    const owner = await pairedSession(OWNER);
    const sourceUrl = "https://youtube.com/watch?v=same-shape";
    const lens = await post(owner.accessToken, { operationId: OPERATION_A, sourceUrl });
    expect(lens.status).toBe(202);
    const telegram = await handleTelegramWebhook(webhookRequest(sourceUrl, 41, OWNER), env);
    expect(await telegram.json()).toMatchObject({ accepted: true });
    const telegramJob = await db.prepare("SELECT id FROM jobs WHERE telegram_update_id = '41'").first<{ id: string }>();
    const shape = (id: unknown) => db.prepare(`SELECT ${SHARED_JOB_COLUMNS} FROM jobs WHERE id = ?1`).bind(id).first();
    expect(await shape(lens.json.jobId)).toEqual(await shape(telegramJob!.id));
    const notices = await db.prepare("SELECT update_id, text FROM telegram_notices ORDER BY update_id").all<{ update_id: string; text: string }>();
    expect(notices.results).toEqual([
      { update_id: "41", text: "Queued in the download/captions queue. Position when accepted: 2. Use /queue for current status. Starts automatically." },
      { update_id: `lens:${owner.accountId}:${OPERATION_A}`, text: QUEUE_NOTICE },
    ]);
  });

  it("queues an MP3, a clip and an MP3 clip of the same link as audio or trimmed jobs sharing the media-cache key", async () => {
    const owner = await pairedSession(OWNER);
    const sourceUrl = "https://youtu.be/outputs";
    const video = await post(owner.accessToken, { operationId: operationId(1), sourceUrl });
    const mp3 = await post(owner.accessToken, { operationId: operationId(2), sourceUrl, output: "mp3" });
    const clip = await post(owner.accessToken, { operationId: operationId(3), sourceUrl, startSeconds: 0, endSeconds: 10 });
    const mp3Clip = await post(owner.accessToken, { operationId: operationId(4), sourceUrl, output: "mp3", startSeconds: 65, endSeconds: 86400 });
    for (const response of [video, mp3, clip, mp3Clip]) expect(response.status).toBe(202);
    const videoJob = await job(video.json.jobId);
    expect(videoJob).toMatchObject({ requested_mode: "video", requested_quality: "max-1080p", requested_start_seconds: null, requested_end_seconds: null });
    expect(await job(mp3.json.jobId)).toMatchObject({
      requested_mode: "audio", requested_quality: "mp3", requested_start_seconds: null, requested_end_seconds: null, requested_clip_ranges: null,
      requested_operation: "download", source_kind: "url", source_url_hash: videoJob.source_url_hash, cache_valid: 1,
    });
    expect(await job(clip.json.jobId)).toMatchObject({
      requested_mode: "video", requested_quality: "max-1080p", requested_start_seconds: 0, requested_end_seconds: 10, requested_clip_ranges: null,
      source_url_hash: videoJob.source_url_hash, cache_valid: 1,
    });
    expect(await job(mp3Clip.json.jobId)).toMatchObject({
      requested_mode: "audio", requested_quality: "mp3", requested_start_seconds: 65, requested_end_seconds: 86400, requested_clip_ranges: null,
      source_url_hash: videoJob.source_url_hash,
    });
    // music.youtube.com keeps its M4A default for a clip and still honours mp3 (finished jobs leave the five-unfinished bound).
    await db.prepare("UPDATE jobs SET status = 'completed'").run();
    const musicUrl = "https://music.youtube.com/watch?v=outputs";
    const musicClip = await post(owner.accessToken, { operationId: operationId(5), sourceUrl: musicUrl, startSeconds: 5, endSeconds: 20 });
    const musicMp3 = await post(owner.accessToken, { operationId: operationId(6), sourceUrl: musicUrl, output: "mp3" });
    expect(await job(musicClip.json.jobId)).toMatchObject({ requested_mode: "audio", requested_quality: "m4a", requested_start_seconds: 5, requested_end_seconds: 20 });
    expect(await job(musicMp3.json.jobId)).toMatchObject({ requested_mode: "audio", requested_quality: "mp3", requested_start_seconds: null, requested_end_seconds: null });
    expect(await count("jobs")).toBe(6);
    expect(dispatchAcceptedJob).toHaveBeenCalledTimes(6);
  });

  it("creates the same job a Telegram '/audio URL mp3 from 00:05 to 00:20' command creates", async () => {
    const owner = await pairedSession(OWNER);
    const sourceUrl = "https://youtube.com/watch?v=same-mp3-clip";
    const lens = await post(owner.accessToken, { operationId: OPERATION_A, sourceUrl, output: "mp3", startSeconds: 5, endSeconds: 20 });
    expect(lens.status).toBe(202);
    const telegram = await handleTelegramWebhook(webhookRequest(`/audio ${sourceUrl} mp3 from 00:05 to 00:20`, 43, OWNER), env);
    expect(await telegram.json()).toMatchObject({ accepted: true });
    const telegramJob = await db.prepare("SELECT id FROM jobs WHERE telegram_update_id = '43'").first<{ id: string }>();
    const shape = (id: unknown) => db.prepare(`SELECT ${SHARED_JOB_COLUMNS} FROM jobs WHERE id = ?1`).bind(id).first();
    expect(await shape(lens.json.jobId)).toEqual(await shape(telegramJob!.id));
    expect(await shape(lens.json.jobId)).toMatchObject({ requested_mode: "audio", requested_quality: "mp3", requested_start_seconds: 5, requested_end_seconds: 20 });
  });

  it("keeps the same operationId separate per account and isolates each user's queue", async () => {
    const owner = await pairedSession(OWNER);
    await invitedAccount();
    const invited = await pairedSession(INVITED);
    const body = { operationId: OPERATION_A, sourceUrl: "https://youtu.be/shared-id" };
    const ownerResponse = await post(owner.accessToken, body);
    const invitedResponse = await post(invited.accessToken, body);
    expect(ownerResponse.status).toBe(202);
    expect(invitedResponse.status).toBe(202);
    expect(ownerResponse.json.jobId).not.toBe(invitedResponse.json.jobId);
    expect(await count("jobs")).toBe(2);
    expect((await getUserQueue(db, OWNER)).map((entry) => entry.id)).toEqual([ownerResponse.json.jobId]);
    expect((await getUserQueue(db, INVITED)).map((entry) => entry.id)).toEqual([invitedResponse.json.jobId]);
  });

  it("caps an invited account at five link jobs an hour while the owner keeps the configured limit", async () => {
    const owner = await pairedSession(OWNER);
    await invitedAccount();
    const invited = await pairedSession(INVITED);
    for (let index = 1; index <= 5; index += 1) {
      for (const session of [owner, invited]) {
        const accepted = await post(session.accessToken, { operationId: operationId(index), sourceUrl: `https://youtu.be/hour${index}` });
        expect(accepted.status).toBe(202);
        // Finished jobs leave the unfinished bound; only the hourly window counts them.
        await db.prepare("UPDATE jobs SET status = 'completed' WHERE id = ?1").bind(accepted.json.jobId).run();
      }
    }
    const invitedSixth = await post(invited.accessToken, { operationId: operationId(6), sourceUrl: "https://youtu.be/hour6" });
    expect(invitedSixth.status).toBe(429);
    expect(invitedSixth.json).toEqual({ error: { code: "job_limit", message: "Your hourly request limit is reached. Try again later.", retryable: true } });
    const ownerSixth = await post(owner.accessToken, { operationId: operationId(6), sourceUrl: "https://youtu.be/hour6" });
    expect(ownerSixth.status).toBe(202);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE telegram_user_id = ?1").bind(INVITED).first()).toEqual({ count: 5 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE telegram_user_id = ?1").bind(OWNER).first()).toEqual({ count: 6 });
  });

  it("shares the owner's hourly window with their Telegram jobs", async () => {
    const owner = await pairedSession(OWNER);
    env = { ...env, MAX_JOBS_PER_HOUR: "1" } as unknown as IntegrationGatewayEnv;
    expect(await (await handleTelegramWebhook(webhookRequest("https://youtu.be/pasted-first", 42, OWNER), env)).json()).toMatchObject({ accepted: true });
    const limited = await post(owner.accessToken, { operationId: OPERATION_A, sourceUrl: "https://youtu.be/from-lens" });
    expect(limited.status).toBe(429);
    expect(limited.json).toMatchObject({ error: { code: "job_limit", message: expect.stringContaining("hourly") } });
    expect(await count("jobs")).toBe(1);
  });

  it("bounds unfinished link jobs at five", async () => {
    const owner = await pairedSession(OWNER);
    for (let index = 1; index <= 5; index += 1) {
      expect((await post(owner.accessToken, { operationId: operationId(index), sourceUrl: `https://youtu.be/queued${index}` })).status).toBe(202);
    }
    const sixth = await post(owner.accessToken, { operationId: operationId(6), sourceUrl: "https://youtu.be/queued6" });
    expect(sixth.status).toBe(429);
    expect(sixth.json).toEqual({ error: { code: "job_limit", message: "You already have 5 unfinished jobs. Try again after one finishes.", retryable: true } });
    expect(await count("jobs")).toBe(5);
    expect(await count("processed_updates")).toBe(5);
    expect(dispatchAcceptedJob).toHaveBeenCalledTimes(5);
  });

  it("replays the same action with the same jobId and one row, and rejects another link under that action", async () => {
    const owner = await pairedSession(OWNER);
    const body = { operationId: OPERATION_A, sourceUrl: "https://youtu.be/replayed" };
    const first = await post(owner.accessToken, body);
    expect(first.status).toBe(202);
    const replay = await post(owner.accessToken, body);
    expect(replay.status).toBe(202);
    expect(replay.json).toEqual(first.json);
    expect(await count("jobs")).toBe(1);
    expect(await count("telegram_notices")).toBe(1);
    expect(dispatchAcceptedJob).toHaveBeenCalledTimes(1);

    const conflict = await post(owner.accessToken, { operationId: OPERATION_A, sourceUrl: "https://youtu.be/different" });
    expect(conflict.status).toBe(409);
    expect(conflict.json).toEqual({ error: { code: "operation_conflict", message: "This action ID is already bound to a different link, output or trim.", retryable: false } });
    expect(await count("jobs")).toBe(1);
  });

  it("rejects the same action with another output or trim, and replays it only with the identical request", async () => {
    const owner = await pairedSession(OWNER);
    const sourceUrl = "https://youtu.be/bound-output";
    const video = await post(owner.accessToken, { operationId: OPERATION_A, sourceUrl });
    const clip = await post(owner.accessToken, { operationId: OPERATION_B, sourceUrl, output: "mp3", startSeconds: 5, endSeconds: 20 });
    expect(video.status).toBe(202);
    expect(clip.status).toBe(202);
    for (const [operation, body] of [
      [OPERATION_A, { operationId: OPERATION_A, sourceUrl, output: "mp3" }],
      [OPERATION_A, { operationId: OPERATION_A, sourceUrl, startSeconds: 5, endSeconds: 20 }],
      [OPERATION_B, { operationId: OPERATION_B, sourceUrl, startSeconds: 5, endSeconds: 20 }],
      [OPERATION_B, { operationId: OPERATION_B, sourceUrl, output: "mp3" }],
      [OPERATION_B, { operationId: OPERATION_B, sourceUrl, output: "mp3", startSeconds: 5, endSeconds: 21 }],
    ] as const) {
      const conflict = await post(owner.accessToken, body);
      expect(conflict.status, `${operation} ${JSON.stringify(body)}`).toBe(409);
      expect(conflict.json).toMatchObject({ error: { code: "operation_conflict", retryable: false } });
    }
    const replay = await post(owner.accessToken, { operationId: OPERATION_B, sourceUrl, output: "mp3", startSeconds: 5, endSeconds: 20 });
    expect(replay.status).toBe(202);
    expect(replay.json).toEqual(clip.json);
    expect(await count("jobs")).toBe(2);
    expect(dispatchAcceptedJob).toHaveBeenCalledTimes(2);
  });

  it("rejects the same action when only the output or only the start of the trim differs", async () => {
    const owner = await pairedSession(OWNER);
    // Each conflict differs from its bound request in one column only, so dropping any single comparison in
    // replayedLinkDownload fails here: on music.youtube.com, mp3 keeps the audio mode and changes only the quality.
    const musicUrl = "https://music.youtube.com/watch?v=bound-m4a";
    const sourceUrl = "https://youtu.be/bound-start";
    const music = await post(owner.accessToken, { operationId: OPERATION_A, sourceUrl: musicUrl });
    const clip = await post(owner.accessToken, { operationId: OPERATION_B, sourceUrl, startSeconds: 5, endSeconds: 20 });
    expect(music.status).toBe(202);
    expect(clip.status).toBe(202);
    expect(await job(music.json.jobId)).toMatchObject({ requested_mode: "audio", requested_quality: "m4a" });
    for (const body of [
      { operationId: OPERATION_A, sourceUrl: musicUrl, output: "mp3" },
      { operationId: OPERATION_B, sourceUrl, startSeconds: 4, endSeconds: 20 },
    ]) {
      const conflict = await post(owner.accessToken, body);
      expect(conflict.status, JSON.stringify(body)).toBe(409);
      expect(conflict.json).toMatchObject({ error: { code: "operation_conflict", retryable: false } });
    }
    expect(await count("jobs")).toBe(2);
    expect(dispatchAcceptedJob).toHaveBeenCalledTimes(2);
  });

  it("resolves two concurrent sends of the same action to one job", async () => {
    const owner = await pairedSession(OWNER);
    const body = { operationId: OPERATION_A, sourceUrl: "https://youtu.be/raced" };
    const [first, second] = await Promise.all([post(owner.accessToken, body), post(owner.accessToken, body)]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.json).toEqual(first.json);
    expect(await count("jobs")).toBe(1);
    expect(await count("processed_updates")).toBe(1);
  });

  it.each([
    ["an unsupported host", "https://vimeo.com/123456", "unsupported_source", "That source is not enabled for this private bot."],
    ["a loopback address", "http://127.0.0.1/video.mp4", "invalid_url", "Send one valid HTTP or HTTPS media URL."],
    ["the cloud metadata address", "http://169.254.169.254/latest/meta-data", "invalid_url", "Send one valid HTTP or HTTPS media URL."],
  ])("rejects %s before admission", async (_label, sourceUrl, code, message) => {
    const owner = await pairedSession(OWNER);
    const response = await post(owner.accessToken, { operationId: OPERATION_A, sourceUrl });
    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error: { code, message, retryable: false } });
    expect(await count("jobs")).toBe(0);
    expect(dispatchAcceptedJob).not.toHaveBeenCalled();
  });

  it.each([
    ["an extra key", { operationId: OPERATION_A, sourceUrl: "https://youtu.be/extra", chatId: OWNER }],
    ["a missing link", { operationId: OPERATION_A }],
    ["a malformed action ID", { operationId: "not-an-action-id", sourceUrl: "https://youtu.be/malformed" }],
    ["a non-string link", { operationId: OPERATION_A, sourceUrl: 42 }],
    ["an array body", [OPERATION_A, "https://youtu.be/array"]],
  ])("rejects a body with %s as invalid_request", async (_label, body) => {
    const owner = await pairedSession(OWNER);
    const response = await post(owner.accessToken, body);
    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({ error: { code: "invalid_request", retryable: false } });
    expect(await count("jobs")).toBe(0);
    expect(await count("processed_updates")).toBe(0);
  });

  it.each([
    ["the output m4a", { output: "m4a" }, "Send the output mp3, or leave it out."],
    ["the output MP3 in capitals", { output: "MP3" }, "Send the output mp3, or leave it out."],
    ["a null output", { output: null }, "Send the output mp3, or leave it out."],
    ["a numeric output", { output: 1 }, "Send the output mp3, or leave it out."],
    ["an end at the start", { startSeconds: 10, endSeconds: 10 }, INVALID_RANGE],
    ["an end before the start", { startSeconds: 20, endSeconds: 5 }, INVALID_RANGE],
    ["a start without an end", { startSeconds: 5 }, INVALID_RANGE],
    ["an end without a start", { endSeconds: 20 }, INVALID_RANGE],
    ["a null end", { startSeconds: 5, endSeconds: null }, INVALID_RANGE],
    ["a fractional start", { startSeconds: 5.5, endSeconds: 20 }, INVALID_RANGE],
    ["a numeric string", { startSeconds: "5", endSeconds: 20 }, INVALID_RANGE],
    ["a negative start", { startSeconds: -1, endSeconds: 20 }, INVALID_RANGE],
    ["an end beyond 24 hours", { startSeconds: 0, endSeconds: 86401 }, INVALID_RANGE],
  ])("rejects %s as invalid_request without queuing", async (_label, options, message) => {
    const owner = await pairedSession(OWNER);
    const response = await post(owner.accessToken, { operationId: OPERATION_C, sourceUrl: "https://youtu.be/bad-options", ...options });
    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error: { code: "invalid_request", message, retryable: false } });
    expect(await count("jobs")).toBe(0);
    expect(await count("processed_updates")).toBe(0);
    expect(dispatchAcceptedJob).not.toHaveBeenCalled();
  });

  it("refuses a legacy owner removed from the live allowlist before replay or admission, leaving invited accounts alone", async () => {
    const owner = await pairedSession(OWNER);
    await invitedAccount();
    const invited = await pairedSession(INVITED);
    const body = { operationId: OPERATION_A, sourceUrl: "https://youtu.be/before-removal" };
    expect((await post(owner.accessToken, body)).status).toBe(202);

    env = { ...env, ALLOWED_TELEGRAM_USER_IDS: `${LEGACY_SECOND},67892` } as unknown as IntegrationGatewayEnv;
    for (const attempt of [body, { operationId: OPERATION_B, sourceUrl: "https://youtu.be/after-removal" }]) {
      const removed = await post(owner.accessToken, attempt);
      expect(removed.status).toBe(403);
      expect(removed.json).toEqual({ error: { code: "forbidden", message: "This Telegram account is no longer enabled for DigiBot downloads.", retryable: false } });
    }
    expect(await db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE telegram_user_id = ?1").bind(OWNER).first()).toEqual({ count: 1 });

    const unaffected = await post(invited.accessToken, { operationId: OPERATION_A, sourceUrl: "https://youtu.be/invited-still-works" });
    expect(unaffected.status).toBe(202);
    expect(await job(unaffected.json.jobId)).toMatchObject({ telegram_user_id: INVITED, telegram_chat_id: INVITED });
    expect(dispatchAcceptedJob).toHaveBeenCalledTimes(2);
  });

  it("checks the live allowlist before reading the body, so a de-listed owner's malformed body gets 403", async () => {
    const owner = await pairedSession(OWNER);
    const malformed = () => handleIntegrationRequest(new Request(`https://worker.example${PATH}`, {
      method: "POST", headers: { authorization: `Bearer ${owner.accessToken}`, "content-type": "application/json", origin: ORIGIN }, body: "{not json",
    }), env);
    const listed = await malformed();
    expect(listed?.status).toBe(400);
    expect(await listed?.json()).toMatchObject({ error: { code: "invalid_json" } });

    env = { ...env, ALLOWED_TELEGRAM_USER_IDS: `${LEGACY_SECOND},67892` } as unknown as IntegrationGatewayEnv;
    const delisted = await malformed();
    expect(delisted?.status).toBe(403);
    expect(await delisted?.json()).toMatchObject({ error: { code: "forbidden" } });
    expect(await count("jobs")).toBe(0);
  });

  it("gives a principal with an unexpected admission source the invited hourly cap, even on the allowlist", async () => {
    // The database CHECK allows only the two known sources, so this guards the code path rather than a stored row.
    const principal = {
      accountId: crypto.randomUUID(), telegramUserId: OWNER, chatId: OWNER, admissionSource: "unexpected_source",
      sessionId: crypto.randomUUID(), authMethod: "device_session",
    } as unknown as IntegrationPrincipal;
    const send = (index: number) => createLensLinkDownload(new Request(`https://worker.example${PATH}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId: operationId(index), sourceUrl: `https://youtu.be/unexpected${index}` }),
    }), env, principal);
    for (let index = 1; index <= 5; index += 1) {
      const accepted = await send(index);
      await db.prepare("UPDATE jobs SET status = 'completed' WHERE id = ?1").bind(accepted.jobId).run();
    }
    // The hourly window, not the 5-unfinished bound, which also answers 429 job_limit.
    await expect(send(6)).rejects.toMatchObject({ status: 429, code: "job_limit", message: expect.stringContaining("hourly") });
    expect(await count("jobs")).toBe(5);
  });

  it("rejects a foreign origin and a revoked session without queuing", async () => {
    const owner = await pairedSession(OWNER);
    const body = { operationId: OPERATION_A, sourceUrl: "https://youtu.be/denied" };
    const foreign = await post(owner.accessToken, body, "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(foreign.status).toBe(403);
    expect(foreign.json).toMatchObject({ error: { code: "origin_denied" } });

    await db.prepare("UPDATE integration_sessions SET revoked_at = ?1 WHERE id = ?2").bind(NOW, owner.sessionId).run();
    const revoked = await post(owner.accessToken, body);
    expect(revoked.status).toBe(401);
    expect(revoked.json).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    expect(await count("jobs")).toBe(0);
    expect(dispatchAcceptedJob).not.toHaveBeenCalled();
  });

  it("notifies the principal's own chat without the /queue hint, dispatches once and logs no user ids", async () => {
    await invitedAccount();
    const invited = await pairedSession(INVITED);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await post(invited.accessToken, { operationId: OPERATION_A, sourceUrl: "https://youtu.be/notice" });
    expect(response.status).toBe(202);
    expect(await db.prepare("SELECT update_id, chat_id, text, state FROM telegram_notices").all()).toMatchObject({
      results: [{ update_id: `lens:${invited.accountId}:${OPERATION_A}`, chat_id: INVITED, text: QUEUE_NOTICE, state: "sent" }],
    });
    expect(sentMessages).toEqual([expect.objectContaining({ chat_id: INVITED, text: QUEUE_NOTICE })]);
    expect(dispatchAcceptedJob).toHaveBeenCalledTimes(1);
    // Identity checks only: deep-comparing the miniflare D1 proxy inside env would call into the runtime.
    expect(vi.mocked(dispatchAcceptedJob).mock.calls[0]?.[0]).toBe(env);
    expect(vi.mocked(dispatchAcceptedJob).mock.calls[0]?.[1]).toBe(response.json.jobId);
    const accepted = log.mock.calls.flatMap(([line]) => {
      try { return [JSON.parse(String(line)) as Record<string, unknown>]; } catch { return []; }
    }).filter((entry) => entry.event === "lens_link_job_accepted");
    expect(accepted).toEqual([expect.objectContaining({ job_id: response.json.jobId, source_host: "youtu.be", state: "queued" })]);
    expect(JSON.stringify(accepted)).not.toMatch(new RegExp(`${INVITED}|${OWNER}|${invited.accountId}`, "u"));
  });

  it("threads waitUntil from the Worker entry point so the response does not wait for dispatch", async () => {
    const owner = await pairedSession(OWNER);
    const pending: Promise<unknown>[] = [];
    let settled = false;
    vi.mocked(dispatchAcceptedJob).mockImplementationOnce(() => new Promise((resolve) => { setTimeout(resolve, 20); }));
    const context = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise.finally(() => { settled = true; })); }, passThroughOnException: () => undefined };
    const response = await worker.fetch(linkRequest(owner.accessToken, { operationId: OPERATION_A, sourceUrl: "https://youtu.be/background" }), env, context as unknown as ExecutionContext);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ state: "queued" });
    expect(pending).toHaveLength(1);
    expect(settled).toBe(false);
    await Promise.all(pending);
    expect(dispatchAcceptedJob).toHaveBeenCalledTimes(1);
    expect(sentMessages).toHaveLength(1);
  });

  it("keeps Telegram downloader commands closed to invited accounts", async () => {
    await invitedAccount();
    const queue = await handleTelegramWebhook(webhookRequest("/queue", 50, INVITED), env);
    expect(await queue.json()).toMatchObject({ accepted: false, error: "INTEGRATION_COMMAND_REQUIRED" });
    expect(sentMessages.at(-1)).toMatchObject({ chat_id: INVITED, text: expect.stringContaining("Use /link UUID to connect Lens") });
    const pasted = await handleTelegramWebhook(webhookRequest("https://youtu.be/pasted-by-invited", 51, INVITED), env);
    expect(await pasted.json()).toMatchObject({ accepted: false, error: "INTEGRATION_COMMAND_REQUIRED" });
    expect(await count("jobs")).toBe(0);
    expect(dispatchAcceptedJob).not.toHaveBeenCalled();
  });
});

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { INTEGRATION_AUTH_POLICY, createIntegrationInvitation, createIntegrationPairing, integrationAccountForTelegram } from "../src/integration-auth";
import { attachIntegrationMedia, hashIntegrationBytes, registerIntegrationOperation, type IntegrationInput } from "../src/integration-store";
import { handleIntegrationTelegramUpdate, deterministicUUID } from "../src/integration-telegram";
import { bytesToBase64Url } from "../src/security";
import { localD1 } from "./helpers/local-d1";
import type { D1BatchDatabaseLike, R2BucketLike, R2ObjectLike, TelegramUpdate } from "../src/types";
import { processIntegrationOperation, type IntegrationEnv, type IntegrationStep, type IntegrationWorkflowParams } from "../src/integration-media";

const OWNER = "12345";
const INVITED = "67890";
const LEGACY_SECOND = "67891";
const BOT_ID = 999;
const NOW = Math.floor(Date.now() / 1000);
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const evidence = (JSON.parse(readFileSync(new URL("./fixtures/integration-envelope-v1.json", import.meta.url), "utf8")) as { result: { evidence: unknown } }).result.evidence;
const step: IntegrationStep = { do: async (_name, _options, callback) => callback() };

type TelegramCall = { url: string; body: unknown };

let database: Awaited<ReturnType<typeof localD1>>;
let db: D1BatchDatabaseLike;
let env: IntegrationEnv;
let telegramCalls: TelegramCall[];
let workflowCalls: Array<{ id: string; params: unknown }>;
let verifierCalls: Array<{ path: string; mediaKind: string | null }>;
let objects: Map<string, Uint8Array>;
let sourceBytes: Uint8Array;
let failDelete = false;

function requestUpdate(update: TelegramUpdate): TelegramUpdate {
  return update;
}

function message(updateId: number, userId: string, text: string, extra: Record<string, unknown> = {}): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: Number(userId) },
      chat: { id: Number(userId), type: "private" },
      text,
      ...extra,
    },
  };
}

function lastSentText(): string | undefined {
  return (telegramCalls.filter((call) => call.url.endsWith("/sendMessage")).at(-1)?.body as { text?: string } | undefined)?.text;
}

function replyDocument(userId = OWNER, fileId = "incoming-image"): Record<string, unknown> {
  return {
    message_id: 700,
    from: { id: Number(userId) },
    chat: { id: Number(userId), type: "private" },
    document: { file_id: fileId, file_size: sourceBytes.byteLength, mime_type: "image/gif", file_name: "claimed.gif" },
  };
}

function bucket(): R2BucketLike {
  return {
    async get(key): Promise<R2ObjectLike | null> {
      const value = objects.get(key);
      return value ? { body: new Response(new Blob([new Uint8Array(value)])).body, size: value.byteLength } : null;
    },
    async put(key, value): Promise<void> {
      if (value instanceof Uint8Array) objects.set(key, new Uint8Array(value));
      else if (value instanceof ArrayBuffer) objects.set(key, new Uint8Array(value.slice(0)));
      else if (value instanceof Blob) objects.set(key, new Uint8Array(await value.arrayBuffer()));
      else objects.set(key, new Uint8Array(await new Response(value).arrayBuffer()));
    },
    async delete(key): Promise<void> {
      if (failDelete) throw new Error("synthetic R2 delete failure");
      objects.delete(key);
    },
  };
}

function telegramResult(url: string): Response {
  if (url.endsWith("/getMe")) return Response.json({ ok: true, result: { id: BOT_ID, username: "DigiBot" } });
  if (url.endsWith("/getFile")) return Response.json({ ok: true, result: { file_path: "photos/incoming.png", file_size: sourceBytes.byteLength } });
  if (url.includes("/file/bot")) return new Response(sourceBytes.slice());
  if (url.endsWith("/sendMessage")) return Response.json({ ok: true, result: { message_id: 800 + telegramCalls.length, chat: { id: Number(OWNER) } } });
  if (url.endsWith("/answerCallbackQuery") || url.endsWith("/editMessageReplyMarkup")) return Response.json({ ok: true, result: true });
  if (url.endsWith("/sendDocument")) return Response.json({ ok: true, result: { message_id: 900, chat: { id: Number(OWNER) }, document: { file_id: "sent-document" } } });
  return Response.json({ ok: true, result: true });
}

function testEnvironment(): IntegrationEnv {
  return {
    DB: db,
    TELEGRAM_BOT_TOKEN: `${BOT_ID}:test-token`,
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    INTERNAL_CONTAINER_SECRET: "internal-secret",
    DOWNLOAD_LINK_HMAC_SECRET: "download-hmac",
    ALLOWED_TELEGRAM_USER_IDS: `${OWNER},${LEGACY_SECOND}`,
    ALLOWED_SOURCE_HOSTS: "youtube.com,youtu.be",
    TELEGRAM_BOT_API_BASE: "https://api.telegram.org",
    INTEGRATION_ENABLED: "true",
    PUBLIC_WORKER_BASE_URL: "https://worker.example",
    MEDIA_BUCKET: bucket(),
    PROVENANCE_VERIFIER: {
      fetch: vi.fn(async (request: Request) => {
        verifierCalls.push({ path: new URL(request.url).pathname, mediaKind: request.headers.get("x-integration-media-kind") });
        if (new URL(request.url).pathname === "/verify-image") return Response.json({ result: evidence, cache: null });
        const form = await request.formData();
        return Response.json({
          mediaSha256: form.get("imageSha256"),
          byteLength: Number(form.get("byteLength")),
          mimeType: form.get("validatedMimeType"),
          audioDurationSeconds: null,
        });
      }),
    },
    INTEGRATION_WORKFLOW: {
      create: vi.fn(async (value: { id: string; params: unknown }) => { workflowCalls.push(value); }),
      get: vi.fn(),
    },
  } as unknown as IntegrationEnv;
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
    db.prepare("DELETE FROM integration_sessions"),
    db.prepare("DELETE FROM integration_pairing_claims"),
    db.prepare("DELETE FROM integration_pairings"),
    db.prepare("DELETE FROM integration_invitation_claims"),
    db.prepare("DELETE FROM integration_invitations"),
    db.prepare("DELETE FROM integration_rate_limits"),
    db.prepare("DELETE FROM integration_operations"),
    db.prepare("DELETE FROM integration_archives"),
    db.prepare("DELETE FROM integration_media"),
    db.prepare("DELETE FROM integration_accounts"),
  ]);
  telegramCalls = [];
  workflowCalls = [];
  verifierCalls = [];
  objects = new Map();
  sourceBytes = PNG.slice();
  failDelete = false;
  env = testEnvironment();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { /* multipart bodies stay opaque in this test. */ }
    }
    telegramCalls.push({ url, body });
    return telegramResult(url);
  }));
});

describe("Telegram integration History, statistics and retry", () => {
  function withDb(overrides: Partial<D1BatchDatabaseLike>): IntegrationEnv {
    return { ...env, DB: { prepare: (sql: string) => db.prepare(sql), batch: db.batch.bind(db), ...overrides } } as unknown as IntegrationEnv;
  }

  function failingQuery(fragment: string): IntegrationEnv {
    return withDb({ prepare: (sql: string) => {
      if (sql.includes(fragment)) throw new Error("D1 unavailable");
      return db.prepare(sql);
    } });
  }

  function checkInput(operationId: string): IntegrationInput {
    return {
      version: 1, operationId, action: "check", forceRecheck: false,
      media: { mediaSha256: hashIntegrationBytes(PNG), byteLength: PNG.byteLength, mimeType: "image/png", inputKind: "original", audioDurationSeconds: null, segment: null, fullSourceSha256: null },
    };
  }

  it("answers a tap with the could-not-start toast when the check throws", async () => {
    await integrationAccountForTelegram(env, { telegramUserId: OWNER, privateChatId: OWNER }, NOW);
    const chat = { id: Number(OWNER), type: "private" };
    const tap = requestUpdate({
      update_id: 54,
      callback_query: {
        id: "callback-54", from: { id: Number(OWNER) }, data: "ic:check",
        message: { message_id: 92, chat, date: NOW - 60, reply_to_message: { message_id: 703, chat, photo: [{ file_id: "large-photo", width: 100, height: 100 }] } },
      },
    });
    const result = await handleIntegrationTelegramUpdate(tap, failingQuery("FROM integration_operations WHERE account_id = ?1 AND id = ?2"));
    expect(await result?.json()).toMatchObject({ accepted: false, error: "INTERNAL_ERROR" });
    expect(telegramCalls.filter((call) => call.url.endsWith("/answerCallbackQuery")).map((call) => call.body))
      .toEqual([{ callback_query_id: "callback-54", text: "The check could not start." }]);
    expect(telegramCalls.filter((call) => call.url.endsWith("/editMessageReplyMarkup"))).toHaveLength(1);
    expect(workflowCalls).toHaveLength(0);
  });

  it("rejects an unknown /history period and falls back when History is unavailable", async () => {
    const valid = await handleIntegrationTelegramUpdate(message(1, OWNER, "/history 7D"), env);
    expect(await valid?.json()).toMatchObject({ history: true });
    expect(lastSentText()).toBe("No integration actions in the selected period.");

    const invalid = await handleIntegrationTelegramUpdate(message(2, OWNER, "/history 1y"), env);
    expect(await invalid?.json()).toMatchObject({ accepted: false, error: "INVALID_PERIOD" });
    expect(lastSentText()).toBe("Use /history [24h|7d|30d|all].");

    const unavailable = await handleIntegrationTelegramUpdate(message(3, OWNER, "/history"), failingQuery("ORDER BY requested_at DESC, id DESC"));
    expect(await unavailable?.json()).toMatchObject({ accepted: false, error: "HISTORY_UNAVAILABLE" });
    expect(lastSentText()).toBe("History is temporarily unavailable.");
  });

  it("rejects an unknown /checkstats period and falls back when statistics are unavailable", async () => {
    const valid = await handleIntegrationTelegramUpdate(message(1, OWNER, "/checkstats 24H"), env);
    expect(await valid?.json()).toMatchObject({ stats: true });
    expect(lastSentText()).toMatch(/^Check statistics \(24h\)\nChecks requested: 0\n/u);

    const invalid = await handleIntegrationTelegramUpdate(message(2, OWNER, "/checkstats week"), env);
    expect(await invalid?.json()).toMatchObject({ accepted: false, error: "INVALID_PERIOD" });
    expect(lastSentText()).toBe("Use /checkstats [24h|7d|30d|all].");

    const unavailable = await handleIntegrationTelegramUpdate(message(3, OWNER, "/checkstats"), failingQuery("AS checksRequested"));
    expect(await unavailable?.json()).toMatchObject({ accepted: false, error: "STATS_UNAVAILABLE" });
    expect(lastSentText()).toBe("Statistics are temporarily unavailable.");
  });

  it("rejects /checkretry for a malformed ID or a missing or deleted action", async () => {
    const account = await integrationAccountForTelegram(env, { telegramUserId: OWNER, privateChatId: OWNER }, NOW);
    if (!account) throw new Error("Expected owner account");
    const malformed = await handleIntegrationTelegramUpdate(message(1, OWNER, "/checkretry 00000000-0000-0000-0000-000000000000"), env);
    expect(await malformed?.json()).toMatchObject({ accepted: false, error: "INVALID_REQUEST" });
    expect(lastSentText()).toBe("Use /checkretry UUID from History.");

    const deletedId = "33333333-3333-4333-8333-333333333333";
    await registerIntegrationOperation(db, account, { input: checkInput(deletedId) }, new Date().toISOString());
    await db.prepare("UPDATE integration_operations SET deleted_at = ?1, input_json = NULL WHERE account_id = ?2 AND id = ?3")
      .bind(new Date().toISOString(), account.accountId, deletedId).run();
    for (const [updateId, operationId] of [[2, crypto.randomUUID()], [3, deletedId]] as const) {
      const result = await handleIntegrationTelegramUpdate(message(updateId, OWNER, `/checkretry ${operationId}`), env);
      expect(await result?.json()).toMatchObject({ accepted: false, error: "NOT_FOUND" });
      expect(lastSentText()).toBe("That action was not found in your History.");
    }
    expect(workflowCalls).toHaveLength(0);
  });

  it("reports a /checkretry error without dispatching the action", async () => {
    const account = await integrationAccountForTelegram(env, { telegramUserId: OWNER, privateChatId: OWNER }, NOW);
    if (!account) throw new Error("Expected owner account");
    const unadmittedId = "44444444-4444-4444-8444-444444444444";
    await registerIntegrationOperation(db, account, { input: checkInput(unadmittedId) }, new Date().toISOString());
    const unadmitted = await handleIntegrationTelegramUpdate(message(1, OWNER, `/checkretry ${unadmittedId}`), env);
    expect(await unadmitted?.json()).toMatchObject({ accepted: false, error: "RETRY_UNAVAILABLE" });
    expect(lastSentText()).toBe("This upload was not admitted. Select the exact file to start a new action.");

    const failedId = "55555555-5555-4555-8555-555555555555";
    const input = checkInput(failedId);
    const operation = await registerIntegrationOperation(db, account, { input }, new Date().toISOString());
    await attachIntegrationMedia(db, operation, input, `integration/${account.accountId}/${failedId}/telegram-image`);
    await db.prepare("UPDATE integration_operations SET status = 'failed' WHERE account_id = ?1 AND id = ?2").bind(account.accountId, failedId).run();
    const broken = withDb({ batch: async () => { throw new Error("D1 unavailable"); } });
    const unexpected = await handleIntegrationTelegramUpdate(message(2, OWNER, `/checkretry ${failedId}`), broken);
    expect(await unexpected?.json()).toMatchObject({ accepted: false, error: "RETRY_UNAVAILABLE" });
    expect(lastSentText()).toBe("This action cannot be retried yet.");
    expect(await db.prepare("SELECT status FROM integration_operations WHERE account_id = ?1 AND id = ?2").bind(account.accountId, failedId).first())
      .toEqual({ status: "failed" });
    expect(workflowCalls).toHaveLength(0);
  });
});

describe("Telegram integration admission and image checks", () => {
  it("shows bounded shared History with evidence and offers an explicit check for a bare image", async () => {
    const prompt = await handleIntegrationTelegramUpdate(message(90, OWNER, "", { photo: [{ file_id: "incoming-image" }] }), env);
    expect(await prompt?.json()).toMatchObject({ checkAvailable: true });
    expect(workflowCalls).toHaveLength(0);
    const promptBody = telegramCalls.find((call) => call.url.endsWith("/sendMessage"))?.body as { text: string };
    expect(promptBody).toMatchObject({
      reply_parameters: { message_id: 90, allow_sending_without_reply: true },
      reply_markup: { inline_keyboard: [[{ text: "Check this image", callback_data: "ic:check" }]] },
    });
    expect(promptBody.text).toMatch(/^Tap "Check this image", or reply to this image with \/check, .*PNG, JPEG, or WebP up to 4 MiB; HEIC is not supported\. Telegram recompresses photos and strips Content Credentials, so send the image as a File for a reliable check\. /u);
    expect(promptBody.text).toContain("Zero Data Retention");
    for (let index = 0; index < 6; index++) {
      await handleIntegrationTelegramUpdate(message(100 + index, OWNER, "/check", { reply_to_message: replyDocument() }), env);
      await db.prepare("UPDATE integration_operations SET reserved_bytes = 0").run();
    }
    await db.prepare("UPDATE integration_operations SET result_json = ?1, status = 'completed'").bind(JSON.stringify({
      cacheSource: "server_cache", originallyCheckedAt: "2026-09-16T10:00:00.000Z",
      evidence: { summary: "No supported provenance signal was detected." },
    })).run();
    await handleIntegrationTelegramUpdate(message(110, OWNER, "/history"), env);
    const last = telegramCalls.filter((call) => call.url.endsWith("/sendMessage")).at(-1)?.body as {
      text: string; reply_markup: { inline_keyboard: Array<Array<{ web_app: { url: string } }>> };
    };
    expect(last.text.match(/State:/gu)).toHaveLength(5);
    expect(last.text.length).toBeLessThan(4096);
    expect(last.text).toContain("No supported provenance signal was detected.");
    expect(last.text).toContain("server_cache; checked 2026-09-16T10:00:00.000Z");
    expect(last.reply_markup.inline_keyboard[0]?.[0]?.web_app.url).toBe("https://worker.example/apps/downloader?view=integration");
  });

  it("does nothing when the integration flag is disabled", async () => {
    expect(await handleIntegrationTelegramUpdate(message(1, OWNER, "/history"), { ...env, INTEGRATION_ENABLED: "false" })).toBeNull();
    expect(telegramCalls).toHaveLength(0);
  });

  it("admits one-use invitations and keeps invited users out of legacy commands", async () => {
    const invitation = await createIntegrationInvitation(env, { issuerTelegramUserId: OWNER }, NOW);
    if (!invitation) throw new Error("Expected invitation");
    const admitted = await handleIntegrationTelegramUpdate(message(1, INVITED, `/start ${invitation.inviteToken}`), env);
    expect(await admitted?.json()).toMatchObject({ admitted: true });
    expect(await db.prepare("SELECT admission_source FROM integration_accounts WHERE telegram_user_id = ?1").bind(INVITED).first()).toEqual({ admission_source: "invitation" });

    const blocked = await handleIntegrationTelegramUpdate(message(2, INVITED, "/help"), env);
    expect(await blocked?.json()).toMatchObject({ accepted: false, error: "INTEGRATION_COMMAND_REQUIRED" });
  });

  it("shows a pairing code and approves only the matching private callback", async () => {
    const account = await integrationAccountForTelegram(env, { telegramUserId: OWNER, privateChatId: OWNER }, NOW);
    if (!account) throw new Error("Expected owner account");
    const verifier = bytesToBase64Url(new Uint8Array(32).fill(4));
    const pairing = await createIntegrationPairing(env, { verifier, deviceName: "Lens" }, NOW);
    const linked = await handleIntegrationTelegramUpdate(message(10, OWNER, `/link ${pairing.pairId}`), env);
    expect(await linked?.json()).toMatchObject({ pairing: pairing.pairId });
    const sent = telegramCalls.find((call) => call.url.endsWith("/sendMessage"));
    const callbackData = (sent?.body as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } })?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
    expect(callbackData).toMatch(/^ia:approve:/u);
    const callback = await handleIntegrationTelegramUpdate(requestUpdate({
      update_id: 11,
      callback_query: {
        id: "callback-1",
        from: { id: Number(OWNER) },
        data: callbackData,
        message: { message_id: 88, chat: { id: Number(OWNER), type: "private" } },
      },
    }), env);
    expect(await callback?.json()).toMatchObject({ approved: true });
    expect(await db.prepare("SELECT approved_account_id FROM integration_pairings WHERE id = ?1").bind(pairing.pairId).first()).toMatchObject({ approved_account_id: account.accountId });
  });

  it("checks exact document and photo bytes while ignoring claimed MIME metadata", async () => {
    const account = await integrationAccountForTelegram(env, { telegramUserId: OWNER, privateChatId: OWNER }, NOW);
    if (!account) throw new Error("Expected owner account");
    const documentResult = await handleIntegrationTelegramUpdate(message(20, OWNER, "/check", { reply_to_message: replyDocument() }), env);
    expect(await documentResult?.json()).toMatchObject({ accepted: true });
    const documentNotice = telegramCalls.filter((call) => call.url.endsWith("/sendMessage")).at(-1);
    expect((documentNotice?.body as { text?: string })?.text).toMatch(/exact Telegram document bytes/iu);
    const documentId = deterministicUUID(account.accountId, 20);
    const documentInput = await db.prepare("SELECT input_json FROM integration_operations WHERE account_id = ?1 AND id = ?2").bind(account.accountId, documentId).first<{ input_json: string }>();
    expect(JSON.parse(documentInput!.input_json)).toMatchObject({ media: { mimeType: "image/png", inputKind: "original", mediaSha256: hashIntegrationBytes(PNG) } });
    // The contract fixture's recorded /validate request comes from this path (integration-http.test.ts), not from Lens uploads.
    expect(verifierCalls).toEqual([{ path: "/validate", mediaKind: "image" }]);
    expect(workflowCalls[0]).toMatchObject({ params: { operationId: documentId, replyToMessageId: 700 } });
    const callsAfterFirstCheck = telegramCalls.length;
    const duplicate = await handleIntegrationTelegramUpdate(message(20, OWNER, "/check", { reply_to_message: replyDocument() }), env);
    expect(await duplicate?.json()).toMatchObject({ duplicate: true, operationId: documentId });
    expect(telegramCalls).toHaveLength(callsAfterFirstCheck);

    const help = await handleIntegrationTelegramUpdate(message(22, OWNER, "/check"), env);
    expect(await help?.json()).toMatchObject({ accepted: false, error: "INVALID_MEDIA" });
    const helpNotice = telegramCalls.filter((call) => call.url.endsWith("/sendMessage")).at(-1);
    expect((helpNotice?.body as { text?: string })?.text).toMatch(/configured provider|Zero Data Retention|AI-generated/iu);

    const photoResult = await handleIntegrationTelegramUpdate(message(21, OWNER, "/check", {
      reply_to_message: {
        message_id: 701,
        chat: { id: Number(OWNER), type: "private" },
        photo: [{ file_id: "small-photo", width: 10, height: 10 }, { file_id: "large-photo", width: 100, height: 100 }],
      },
    }), env);
    expect(await photoResult?.json()).toMatchObject({ accepted: true });
    const photoInput = await db.prepare("SELECT input_json FROM integration_operations WHERE account_id = ?1 AND id = ?2")
      .bind(account.accountId, deterministicUUID(account.accountId, 21)).first<{ input_json: string }>();
    expect(JSON.parse(photoInput!.input_json)).toMatchObject({ media: { inputKind: "telegram_photo_copy", mimeType: "image/png" } });
    const photoNotice = telegramCalls.filter((call) => call.url.endsWith("/sendMessage")).at(-1);
    expect((photoNotice?.body as { text?: string })?.text).toMatch(/Telegram photo copy/iu);
    expect(workflowCalls).toHaveLength(2);
    expect(workflowCalls[1]).toMatchObject({ params: { replyToMessageId: 701 } });
    expect(objects.get(`integration/${account.accountId}/${documentId}/telegram-image`)).toEqual(PNG);
  });

  it("keeps the checked image as the saved copy: no document is sent back and a later photo check reuses it", async () => {
    const account = await integrationAccountForTelegram(env, { telegramUserId: OWNER, privateChatId: OWNER }, NOW);
    if (!account) throw new Error("Expected owner account");
    // Run the dispatched Workflow in-process so the archive step is observed end to end.
    const process = async (operationId: string): Promise<void> => {
      const dispatched = workflowCalls.find((call) => (call.params as { operationId: string }).operationId === operationId);
      if (!dispatched) throw new Error(`Expected a dispatch for ${operationId}`);
      await processIntegrationOperation(env, dispatched.params as IntegrationWorkflowParams, step);
    };
    const archiveRow = () => db.prepare("SELECT * FROM integration_archives WHERE account_id = ?1").bind(account.accountId).all<Record<string, unknown>>();

    const documentResult = await handleIntegrationTelegramUpdate(message(60, OWNER, "/check", { reply_to_message: replyDocument() }), env);
    expect(await documentResult?.json()).toMatchObject({ accepted: true });
    const documentId = deterministicUUID(account.accountId, 60);
    const archives = (await archiveRow()).results;
    expect(archives).toHaveLength(1);
    expect(archives[0]).toMatchObject({
      id: hashIntegrationBytes(`${account.accountId}\0${hashIntegrationBytes(PNG)}`), kind: "automatic", delivery_state: "confirmed", integrity_state: "verified",
      round_trip_sha256: hashIntegrationBytes(PNG), attempt_started_at: null, error_json: null,
    });
    expect(JSON.parse(archives[0]!.receipt_json as string)).toEqual({ botId: String(BOT_ID), chatId: OWNER, messageId: "700", fileId: "incoming-image", sender: "user" });
    await process(documentId);
    const verdict = telegramCalls.filter((call) => call.url.endsWith("/sendMessage")).at(-1)?.body as { text: string; reply_parameters: { message_id: number } };
    expect(verdict.reply_parameters.message_id).toBe(700);
    expect(verdict.text).toMatch(/^No supported signal detected\n/u);
    expect(await db.prepare("SELECT status, temp_key, reserved_bytes, archive_id FROM integration_operations WHERE account_id = ?1 AND id = ?2").bind(account.accountId, documentId).first())
      .toEqual({ status: "completed", temp_key: null, reserved_bytes: 0, archive_id: archives[0]!.id });

    const photoResult = await handleIntegrationTelegramUpdate(message(61, OWNER, "/check", {
      reply_to_message: { message_id: 701, chat: { id: Number(OWNER), type: "private" }, photo: [{ file_id: "large-photo", width: 100, height: 100 }] },
    }), env);
    expect(await photoResult?.json()).toMatchObject({ accepted: true });
    const photoId = deterministicUUID(account.accountId, 61);
    await process(photoId);
    // The first copy stays the saved copy; the photo check of the same bytes reuses it untouched.
    expect((await archiveRow()).results).toEqual(archives);
    expect(await db.prepare("SELECT status, temp_key, reserved_bytes, archive_id FROM integration_operations WHERE account_id = ?1 AND id = ?2").bind(account.accountId, photoId).first())
      .toEqual({ status: "completed", temp_key: null, reserved_bytes: 0, archive_id: archives[0]!.id });
    expect(telegramCalls.some((call) => call.url.endsWith("/sendDocument"))).toBe(false);
    // One getFile per check for the bytes themselves; no archive round trip.
    expect(telegramCalls.filter((call) => call.url.endsWith("/getFile"))).toHaveLength(2);
    expect(telegramCalls.filter((call) => call.url.endsWith("/sendMessage")).map((call) => (call.body as { reply_parameters?: { message_id: number } }).reply_parameters?.message_id))
      .toEqual([undefined, 700, undefined, 701]);
    expect(objects.size).toBe(0);
  });

  it("prompts for a captioned image without starting a check and rejects bytes over 4 MiB", async () => {
    await integrationAccountForTelegram(env, { telegramUserId: OWNER, privateChatId: OWNER }, NOW);
    const captioned = await handleIntegrationTelegramUpdate(message(30, OWNER, "", {
      caption: "/check",
      photo: [{ file_id: "caption-photo", width: 100, height: 100 }],
    }), env);
    expect(await captioned?.json()).toMatchObject({ checkAvailable: true });
    expect((telegramCalls.at(-1)?.body as { reply_parameters?: unknown }).reply_parameters).toEqual({ message_id: 30, allow_sending_without_reply: true });
    const documentPrompt = await handleIntegrationTelegramUpdate(message(32, OWNER, "", {
      caption: "please check", document: { file_id: "captioned-document", mime_type: "image/webp" },
    }), env);
    expect(await documentPrompt?.json()).toMatchObject({ checkAvailable: true });
    expect(lastSentText()).not.toMatch(/recompresses photos/u);
    expect(telegramCalls.some((call) => call.url.endsWith("/getFile"))).toBe(false);
    expect(workflowCalls).toHaveLength(0);
    sourceBytes = new Uint8Array(4 * 1024 * 1024 + 1);
    const oversized = await handleIntegrationTelegramUpdate(message(31, OWNER, "/check", { reply_to_message: replyDocument(OWNER, "too-large") }), env);
    expect(await oversized?.json()).toMatchObject({ accepted: false, error: "INVALID_MEDIA" });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM integration_operations").first()).toEqual({ count: 0 });
  });

  it("starts one check per prompt: a redelivered tap and a second tap both answer duplicate", async () => {
    const account = await integrationAccountForTelegram(env, { telegramUserId: OWNER, privateChatId: OWNER }, NOW);
    if (!account) throw new Error("Expected owner account");
    const prompt = {
      message_id: 88, chat: { id: Number(OWNER), type: "private" }, date: NOW - 60,
      reply_to_message: { message_id: 701, chat: { id: Number(OWNER), type: "private" }, photo: [{ file_id: "large-photo", width: 100, height: 100 }] },
    };
    const tap = (updateId: number) => requestUpdate({
      update_id: updateId,
      callback_query: { id: `callback-${updateId}`, from: { id: Number(OWNER) }, data: "ic:check", message: prompt },
    });
    // Keyed on the prompt, not on the tap's update_id, so a second tap cannot start a second paid check.
    const operationId = deterministicUUID(account.accountId, "ic:88");
    const first = await handleIntegrationTelegramUpdate(tap(50), env);
    expect(await first?.json()).toMatchObject({ accepted: true, operationId });
    const stored = await db.prepare("SELECT input_json, request_hash FROM integration_operations WHERE account_id = ?1 AND id = ?2")
      .bind(account.accountId, operationId).first<{ input_json: string; request_hash: string }>();
    expect(JSON.parse(stored!.input_json)).toMatchObject({ media: { inputKind: "telegram_photo_copy", mimeType: "image/png" } });
    // The request hash is bound to the prompt's own date, so a tap redelivered in another second re-registers
    // the same operation instead of answering 409 operation_conflict.
    expect(stored!.request_hash).toBe(hashIntegrationBytes(JSON.stringify([new Date((NOW - 60) * 1000).toISOString(), JSON.parse(stored!.input_json)])));
    expect(workflowCalls).toEqual([expect.objectContaining({ params: expect.objectContaining({ operationId, replyToMessageId: 701 }) })]);
    const toasts = () => telegramCalls.filter((call) => call.url.endsWith("/answerCallbackQuery")).map((call) => call.body);
    expect(toasts()).toEqual([{ callback_query_id: "callback-50", text: "Check started. The verdict will normally be replied under the image; /history always keeps it." }]);
    expect(telegramCalls.filter((call) => call.url.endsWith("/editMessageReplyMarkup")).map((call) => call.body))
      .toEqual([{ chat_id: OWNER, message_id: "88", reply_markup: { inline_keyboard: [] } }]);

    for (const again of [tap(50), tap(51)]) {
      const result = await handleIntegrationTelegramUpdate(again, env);
      expect(await result?.json()).toMatchObject({ duplicate: true, operationId });
    }
    expect(telegramCalls.filter((call) => call.url.endsWith("/getFile"))).toHaveLength(1);
    expect(workflowCalls).toHaveLength(1);
    expect(toasts().slice(1)).toEqual([
      { callback_query_id: "callback-50", text: "This check is already running." },
      { callback_query_id: "callback-51", text: "This check is already running." },
    ]);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM integration_operations").first()).toEqual({ count: 1 });
  });

  it("answers a tap without a reply image, or on a prompt older than 24 h, with the /check fallback", async () => {
    await integrationAccountForTelegram(env, { telegramUserId: OWNER, privateChatId: OWNER }, NOW);
    const chat = { id: Number(OWNER), type: "private" };
    const image = { message_id: 702, chat, photo: [{ file_id: "large-photo", width: 100, height: 100 }] };
    const taps = [
      [51, { message_id: 89, chat, date: NOW - 60 }, "INVALID_MEDIA"],
      [52, { message_id: 90, chat, date: NOW - 24 * 60 * 60 - 1, reply_to_message: image }, "PROMPT_EXPIRED"],
      [53, { message_id: 91, chat, date: 0, reply_to_message: image }, "PROMPT_EXPIRED"],
    ] as const;
    for (const [updateId, callbackMessage, error] of taps) {
      const result = await handleIntegrationTelegramUpdate(requestUpdate({
        update_id: updateId,
        callback_query: { id: `callback-${updateId}`, from: { id: Number(OWNER) }, data: "ic:check", message: callbackMessage },
      }), env);
      expect(await result?.json()).toMatchObject({ accepted: false, error });
    }
    expect(telegramCalls.filter((call) => call.url.endsWith("/answerCallbackQuery")).map((call) => (call.body as { text: string }).text))
      .toEqual(["Reply to the image with /check", "Reply to the image with /check", "Reply to the image with /check"]);
    expect(telegramCalls.filter((call) => call.url.endsWith("/editMessageReplyMarkup"))).toHaveLength(3);
    expect(telegramCalls.some((call) => call.url.endsWith("/getFile"))).toBe(false);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM integration_operations").first()).toEqual({ count: 0 });
  });

  it("releases the admission slot when a check fails before its bytes are stored", async () => {
    const account = await integrationAccountForTelegram(env, { telegramUserId: OWNER, privateChatId: OWNER }, NOW);
    if (!account) throw new Error("Expected owner account");
    const rejecting = { ...env, PROVENANCE_VERIFIER: { fetch: async () => new Response("rejected", { status: 400 }) } } as unknown as IntegrationEnv;
    for (let index = 0; index < 4; index++) {
      const result = await handleIntegrationTelegramUpdate(message(70 + index, OWNER, "/check", { reply_to_message: replyDocument() }), rejecting);
      expect(await result?.json()).toMatchObject({ accepted: false, error: "invalid_media" });
    }
    expect(await db.prepare("SELECT COUNT(*) AS failed, SUM(reserved_bytes) AS reserved, COUNT(temp_key) AS retained FROM integration_operations WHERE account_id = ?1 AND status = 'failed'")
      .bind(account.accountId).first()).toEqual({ failed: 4, reserved: 0, retained: 0 });
    expect(objects.size).toBe(0);
    // Four failed admissions no longer hold the account's four retained-input slots for 24 hours.
    const admitted = await handleIntegrationTelegramUpdate(message(74, OWNER, "/check", { reply_to_message: replyDocument() }), env);
    expect(await admitted?.json()).toMatchObject({ accepted: true });
    expect(workflowCalls).toHaveLength(1);
  });

  it("releases a stored object when attaching fails, or hands it to the sweep when R2 refuses to delete it", async () => {
    const account = await integrationAccountForTelegram(env, { telegramUserId: OWNER, privateChatId: OWNER }, NOW);
    if (!account) throw new Error("Expected owner account");
    const row = (operationId: string) => db.prepare("SELECT status, temp_key, reserved_bytes, expires_at > ?3 AS live FROM integration_operations WHERE account_id = ?1 AND id = ?2")
      .bind(account.accountId, operationId, new Date().toISOString()).first();
    // Registration, the claim and the failure record use single statements; only attachIntegrationMedia batches.
    const brokenAttach = { ...env, DB: { prepare: (sql: string) => db.prepare(sql), batch: async () => { throw new Error("D1 unavailable"); } } } as unknown as IntegrationEnv;

    const released = await handleIntegrationTelegramUpdate(message(80, OWNER, "/check", { reply_to_message: replyDocument() }), brokenAttach);
    expect(await released?.json()).toMatchObject({ accepted: false, error: "telegram_check_failed" });
    expect(await row(deterministicUUID(account.accountId, 80))).toEqual({ status: "failed", temp_key: null, reserved_bytes: 0, live: 1 });
    expect(objects.size).toBe(0);

    failDelete = true;
    const kept = await handleIntegrationTelegramUpdate(message(81, OWNER, "/check", { reply_to_message: replyDocument() }), brokenAttach);
    expect(await kept?.json()).toMatchObject({ accepted: false, error: "telegram_check_failed" });
    const keptId = deterministicUUID(account.accountId, 81);
    const key = `integration/${account.accountId}/${keptId}/telegram-image`;
    // The key is recorded as temp_key with its 24 h expiry, which is what cleanupIntegrationMedia reaps (integration-store.test.ts).
    expect(await row(keptId)).toEqual({ status: "failed", temp_key: key, reserved_bytes: PNG.byteLength, live: 1 });
    expect(objects.has(key)).toBe(true);
    const retry = await handleIntegrationTelegramUpdate(message(82, OWNER, `/checkretry ${keptId}`), env);
    expect(await retry?.json()).toMatchObject({ accepted: false, error: "RETRY_UNAVAILABLE" });
  });

  it("keeps the reservation of attached bytes when only the dispatch fails, so /checkretry can resume", async () => {
    const account = await integrationAccountForTelegram(env, { telegramUserId: OWNER, privateChatId: OWNER }, NOW);
    if (!account) throw new Error("Expected owner account");
    const undispatchable = { ...env, INTEGRATION_WORKFLOW: undefined } as unknown as IntegrationEnv;
    const result = await handleIntegrationTelegramUpdate(message(83, OWNER, "/check", { reply_to_message: replyDocument() }), undispatchable);
    expect(await result?.json()).toMatchObject({ accepted: false, error: "integration_unavailable" });
    const operationId = deterministicUUID(account.accountId, 83);
    const key = `integration/${account.accountId}/${operationId}/telegram-image`;
    expect(await db.prepare("SELECT status, temp_key, reserved_bytes, admitted_at IS NOT NULL AS admitted FROM integration_operations WHERE account_id = ?1 AND id = ?2")
      .bind(account.accountId, operationId).first()).toEqual({ status: "failed", temp_key: key, reserved_bytes: PNG.byteLength, admitted: 1 });
    expect(objects.has(key)).toBe(true);

    const retried = await handleIntegrationTelegramUpdate(message(84, OWNER, `/checkretry ${operationId}`), env);
    expect(await retried?.json()).toMatchObject({ retried: true, operationId });
    expect(workflowCalls).toEqual([expect.objectContaining({ params: expect.objectContaining({ operationId, generation: 1 }) })]);
  });

  it("releases an object that a throwing R2 put stored anyway, or hands it to the sweep when the delete fails too", async () => {
    const account = await integrationAccountForTelegram(env, { telegramUserId: OWNER, privateChatId: OWNER }, NOW);
    if (!account) throw new Error("Expected owner account");
    // A put that throws is ambiguous: the object may exist, which is why the admission tracks the key before the call.
    const storingPut = { ...env, MEDIA_BUCKET: { ...env.MEDIA_BUCKET, put: async (key: string, value: Uint8Array) => {
      await env.MEDIA_BUCKET.put(key, value);
      throw new Error("R2 put timed out");
    } } } as unknown as IntegrationEnv;
    const row = (operationId: string) => db.prepare("SELECT status, temp_key, reserved_bytes FROM integration_operations WHERE account_id = ?1 AND id = ?2")
      .bind(account.accountId, operationId).first();

    const released = await handleIntegrationTelegramUpdate(message(90, OWNER, "/check", { reply_to_message: replyDocument() }), storingPut);
    expect(await released?.json()).toMatchObject({ accepted: false, error: "telegram_check_failed" });
    expect(await row(deterministicUUID(account.accountId, 90))).toEqual({ status: "failed", temp_key: null, reserved_bytes: 0 });
    expect(objects.size).toBe(0);

    failDelete = true;
    const kept = await handleIntegrationTelegramUpdate(message(91, OWNER, "/check", { reply_to_message: replyDocument() }), storingPut);
    expect(await kept?.json()).toMatchObject({ accepted: false, error: "telegram_check_failed" });
    const keptId = deterministicUUID(account.accountId, 91);
    const key = `integration/${account.accountId}/${keptId}/telegram-image`;
    expect(await row(keptId)).toEqual({ status: "failed", temp_key: key, reserved_bytes: PNG.byteLength });
    expect(objects.has(key)).toBe(true);
  });

  it("does not replay or expose a deleted action when the Telegram update is redelivered", async () => {
    const account = await integrationAccountForTelegram(env, { telegramUserId: OWNER, privateChatId: OWNER }, NOW);
    if (!account) throw new Error("Expected owner account");
    const updateId = 32;
    const operationId = deterministicUUID(account.accountId, updateId);
    const input: IntegrationInput = {
      version: 1, operationId, action: "check", forceRecheck: false,
      media: { mediaSha256: hashIntegrationBytes(PNG), byteLength: PNG.byteLength, mimeType: "image/png", inputKind: "original", audioDurationSeconds: null, segment: null, fullSourceSha256: null },
    };
    await registerIntegrationOperation(db, account, { input }, new Date().toISOString());
    await db.prepare(`UPDATE integration_operations SET deleted_at = ?1, input_json = NULL, result_json = NULL,
      source_cipher = NULL, segment_json = NULL, error_json = NULL WHERE account_id = ?2 AND id = ?3`)
      .bind(new Date().toISOString(), account.accountId, operationId).run();
    const before = telegramCalls.length;
    const result = await handleIntegrationTelegramUpdate(message(updateId, OWNER, "/check", { reply_to_message: replyDocument() }), env);
    expect(await result?.json()).toMatchObject({ accepted: false, error: "OPERATION_DELETED" });
    expect(telegramCalls.slice(before).filter((call) => call.url.endsWith("/getFile"))).toHaveLength(0);
    const notice = telegramCalls.slice(before).find((call) => call.url.endsWith("/sendMessage"));
    expect((notice?.body as { text?: string })?.text).toMatch(/action was deleted/iu);
  });

  it("reconciles only a current-bot document whose downloaded bytes match the archive", async () => {
    const account = await integrationAccountForTelegram(env, { telegramUserId: OWNER, privateChatId: OWNER }, NOW);
    if (!account) throw new Error("Expected owner account");
    const operationId = "11111111-1111-4111-8111-111111111111";
    const input: IntegrationInput = {
      version: 1, operationId, action: "check", forceRecheck: false,
      media: { mediaSha256: hashIntegrationBytes(PNG), byteLength: PNG.byteLength, mimeType: "image/png", inputKind: "original", audioDurationSeconds: null, segment: null, fullSourceSha256: null },
    };
    const operation = await registerIntegrationOperation(db, account, { input }, new Date().toISOString());
    await attachIntegrationMedia(db, operation, input, `integration/${account.accountId}/${operationId}/telegram-image`, new Date());
    await db.prepare("UPDATE integration_operations SET status = 'failed' WHERE account_id = ?1 AND id = ?2").bind(account.accountId, operationId).run();
    await db.prepare("UPDATE integration_archives SET delivery_state = 'unknown' WHERE account_id = ?1 AND id = ?2")
      .bind(account.accountId, hashIntegrationBytes(`${account.accountId}\0${input.media.mediaSha256}`)).run();

    const result = await handleIntegrationTelegramUpdate(message(40, OWNER, `/reconcile ${operationId}`, {
      reply_to_message: {
        message_id: 901,
        from: { id: BOT_ID, is_bot: true },
        chat: { id: Number(OWNER), type: "private" },
        document: { file_id: "saved-document", file_size: PNG.byteLength },
      },
    }), env);
    expect(await result?.json()).toMatchObject({ accepted: true, reconciled: true });
    const archive = await db.prepare("SELECT delivery_state, integrity_state, round_trip_sha256, receipt_json FROM integration_archives WHERE account_id = ?1")
      .bind(account.accountId).first<{ delivery_state: string; integrity_state: string; round_trip_sha256: string; receipt_json: string }>();
    expect(archive).toMatchObject({ delivery_state: "confirmed", integrity_state: "verified", round_trip_sha256: hashIntegrationBytes(PNG) });
    expect(JSON.parse(archive!.receipt_json)).toMatchObject({ botId: String(BOT_ID), chatId: OWNER, messageId: "901", fileId: "saved-document" });
    const unrepairedCheck = await db.prepare("SELECT status, error_json, temp_key, reserved_bytes FROM integration_operations WHERE account_id = ?1 AND id = ?2")
      .bind(account.accountId, operationId).first<{ status: string; error_json: string | null; temp_key: string | null; reserved_bytes: number }>();
    expect(unrepairedCheck).toMatchObject({ status: "failed", temp_key: `integration/${account.accountId}/${operationId}/telegram-image` });
    expect(unrepairedCheck?.error_json).toBeNull();
    expect(unrepairedCheck?.reserved_bytes).toBeGreaterThan(0);
    expect(telegramCalls.some((call) => call.url.endsWith("/sendDocument"))).toBe(false);
  });

  it("repairs a reconciled download and releases its reservation only after the R2 delete", async () => {
    const account = await integrationAccountForTelegram(env, { telegramUserId: OWNER, privateChatId: OWNER }, NOW);
    if (!account) throw new Error("Expected owner account");
    const operationId = "22222222-2222-4222-8222-222222222222";
    const input: IntegrationInput = {
      version: 1, operationId, action: "download", forceRecheck: false,
      media: { mediaSha256: hashIntegrationBytes(PNG), byteLength: PNG.byteLength, mimeType: "image/png", inputKind: "original", audioDurationSeconds: null, segment: null, fullSourceSha256: null },
    };
    const operation = await registerIntegrationOperation(db, account, { input }, new Date().toISOString());
    const tempKey = `integration/${account.accountId}/${operationId}/telegram-image`;
    await attachIntegrationMedia(db, operation, input, tempKey, new Date());
    await env.MEDIA_BUCKET.put(tempKey, PNG);
    await db.prepare("UPDATE integration_operations SET status = 'failed', error_json = ?1 WHERE account_id = ?2 AND id = ?3")
      .bind(JSON.stringify({ code: "archive_unknown", message: "Delivery was uncertain.", retryable: false }), account.accountId, operationId).run();
    await db.prepare("UPDATE integration_archives SET delivery_state = 'unknown' WHERE account_id = ?1 AND id = ?2")
      .bind(account.accountId, hashIntegrationBytes(`${account.accountId}\0${input.action === "download" ? operationId : input.media.mediaSha256}`)).run();

    failDelete = true;
    const result = await handleIntegrationTelegramUpdate(message(41, OWNER, `/reconcile ${operationId}`, {
      reply_to_message: {
        message_id: 902,
        from: { id: BOT_ID, is_bot: true },
        chat: { id: Number(OWNER), type: "private" },
        document: { file_id: "saved-download", file_size: PNG.byteLength },
      },
    }), env);
    expect(await result?.json()).toMatchObject({ accepted: true, reconciled: true });
    const retained = await db.prepare("SELECT status, error_json, temp_key, reserved_bytes FROM integration_operations WHERE account_id = ?1 AND id = ?2")
      .bind(account.accountId, operationId).first<{ status: string; error_json: string | null; temp_key: string | null; reserved_bytes: number }>();
    expect(retained).toMatchObject({ status: "completed", error_json: null, temp_key: tempKey });
    expect(retained?.reserved_bytes).toBeGreaterThan(0);
    expect(objects.has(tempKey)).toBe(true);

    failDelete = false;
    const retried = await handleIntegrationTelegramUpdate(message(42, OWNER, `/reconcile ${operationId}`, {
      reply_to_message: {
        message_id: 902,
        from: { id: BOT_ID, is_bot: true },
        chat: { id: Number(OWNER), type: "private" },
        document: { file_id: "saved-download", file_size: PNG.byteLength },
      },
    }), env);
    expect(await retried?.json()).toMatchObject({ accepted: true, reconciled: true });
    const repaired = await db.prepare("SELECT status, error_json, temp_key, reserved_bytes FROM integration_operations WHERE account_id = ?1 AND id = ?2")
      .bind(account.accountId, operationId).first<{ status: string; error_json: string | null; temp_key: string | null; reserved_bytes: number }>();
    expect(repaired).toEqual({ status: "completed", error_json: null, temp_key: null, reserved_bytes: 0 });
    expect(objects.has(tempKey)).toBe(false);
  });
});

describe("Telegram integration owner commands and Lens linking", () => {
  async function admitInvited(): Promise<void> {
    const invitation = await createIntegrationInvitation(env, { issuerTelegramUserId: OWNER }, NOW);
    if (!invitation) throw new Error("Expected invitation");
    const admitted = await handleIntegrationTelegramUpdate(message(1, INVITED, `/start ${invitation.inviteToken}`), env);
    expect(await admitted?.json()).toMatchObject({ admitted: true });
  }

  it("refuses /invite and /revokeinvite from an invitation-admitted account", async () => {
    await admitInvited();
    const ownerInvitation = await createIntegrationInvitation(env, { issuerTelegramUserId: OWNER }, NOW);
    if (!ownerInvitation) throw new Error("Expected invitation");

    // The account's admission source decides, even if its user ID is later added to the allowlist.
    for (const current of [env, { ...env, ALLOWED_TELEGRAM_USER_IDS: `${OWNER},${INVITED}` }]) {
      const invite = await handleIntegrationTelegramUpdate(message(2, INVITED, "/invite"), current);
      expect(await invite?.json()).toMatchObject({ accepted: false, error: "FORBIDDEN" });
      expect(lastSentText()).toBe("Only the DigiBot owner can issue invitations.");
      const revoke = await handleIntegrationTelegramUpdate(message(3, INVITED, `/revokeinvite ${ownerInvitation.invitationId}`), current);
      expect(await revoke?.json()).toMatchObject({ accepted: false, error: "FORBIDDEN" });
      expect(lastSentText()).toBe("Only the DigiBot owner can revoke invitations.");
    }

    expect(await db.prepare("SELECT COUNT(*) AS count FROM integration_invitations").first()).toEqual({ count: 2 });
    expect(await db.prepare("SELECT revoked_at FROM integration_invitations WHERE id = ?1").bind(ownerInvitation.invitationId).first())
      .toEqual({ revoked_at: null });
  });

  it("lets the owner issue an invitation and revoke it before it is used", async () => {
    const invite = await handleIntegrationTelegramUpdate(message(1, OWNER, "/invite"), env);
    const { invitationId } = await invite!.json() as { invitationId: string };
    const inviteToken = lastSentText()?.match(/\/start (inv_[A-Za-z0-9_-]{43})/u)?.[1];
    expect(inviteToken).toBeDefined();
    expect(lastSentText()).toContain(`/revokeinvite ${invitationId}`);

    const revoked = await handleIntegrationTelegramUpdate(message(2, OWNER, `/revokeinvite ${invitationId}`), env);
    expect(await revoked?.json()).toMatchObject({ revoked: true });
    expect(lastSentText()).toBe("Invitation revoked.");
    const again = await handleIntegrationTelegramUpdate(message(3, OWNER, `/revokeinvite ${invitationId}`), env);
    expect(await again?.json()).toMatchObject({ revoked: false });

    expect(await handleIntegrationTelegramUpdate(message(4, INVITED, `/start ${inviteToken}`), env)).toBeNull();
    expect(await db.prepare("SELECT COUNT(*) AS count FROM integration_accounts WHERE telegram_user_id = ?1").bind(INVITED).first())
      .toEqual({ count: 0 });
  });

  it("rejects /link with a malformed UUID or an unknown or expired pairing", async () => {
    for (const [updateId, text] of [[1, "/link"], [2, "/link 00000000-0000-0000-0000-000000000000"]] as const) {
      const result = await handleIntegrationTelegramUpdate(message(updateId, OWNER, text), env);
      expect(await result?.json()).toMatchObject({ accepted: false, error: "INVALID_REQUEST" });
      expect(lastSentText()).toBe("Use /link UUID from the Lens pairing screen.");
    }

    const verifier = bytesToBase64Url(new Uint8Array(32).fill(5));
    const expired = await createIntegrationPairing(env, { verifier, deviceName: "Lens" }, NOW - INTEGRATION_AUTH_POLICY.pairingTtlSeconds - 1);
    for (const [updateId, pairId] of [[3, crypto.randomUUID()], [4, expired.pairId]] as const) {
      const result = await handleIntegrationTelegramUpdate(message(updateId, OWNER, `/link ${pairId}`), env);
      expect(await result?.json()).toMatchObject({ accepted: false, error: "PAIRING_NOT_FOUND" });
      expect(lastSentText()).toBe("That pairing is unavailable or expired. Start a new link from Lens.");
    }
    expect(telegramCalls.some((call) => (call.body as { reply_markup?: unknown }).reply_markup !== undefined)).toBe(false);
  });

  it("answers /start inv_ from a linked account without spending the invitation", async () => {
    await admitInvited();
    const unused = await createIntegrationInvitation(env, { issuerTelegramUserId: OWNER }, NOW);
    if (!unused) throw new Error("Expected invitation");

    for (const [updateId, userId] of [[2, OWNER], [3, INVITED]] as const) {
      const result = await handleIntegrationTelegramUpdate(message(updateId, userId, `/start ${unused.inviteToken}`), env);
      expect(await result?.json()).toMatchObject({ admitted: true });
      expect(lastSentText()).toMatch(/already linked to DigiBot/u);
    }
    expect(await db.prepare("SELECT telegram_user_id, admission_source FROM integration_accounts ORDER BY telegram_user_id").all())
      .toMatchObject({ results: [{ telegram_user_id: OWNER, admission_source: "legacy_allowlist" }, { telegram_user_id: INVITED, admission_source: "invitation" }] });
    expect(await db.prepare("SELECT consumed_at FROM integration_invitations WHERE id = ?1").bind(unused.invitationId).first())
      .toEqual({ consumed_at: null });
  });
});

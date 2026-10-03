import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveIntegrationPairing,
  getIntegrationPairingSummary,
  INTEGRATION_AUTH_POLICY,
  type IntegrationSessionCredentials,
} from "../src/integration-auth";
import { handleIntegrationRequest } from "../src/integration";
import { attachIntegrationMedia, hashIntegrationBytes, INTEGRATION_CHECK_BYTES, registerIntegrationOperation, type IntegrationInput } from "../src/integration-store";
import { bytesToBase64Url } from "../src/security";
import type { D1BatchDatabaseLike, R2BucketLike, R2ObjectLike } from "../src/types";
import { processIntegrationOperation, validateIntegrationCheck, type IntegrationEnv, type IntegrationStep } from "../src/integration-media";
import { AUDIO_POLICY, IMAGE_POLICY } from "../src/integration-verifier";
import { localD1 } from "./helpers/local-d1";
import { testFixedLengthStream } from "./helpers/fixed-length-stream";

const NOW = Math.floor(Date.now() / 1000);
const OWNER = "12345";
const OTHER = "67890";
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const WRONG_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 4, 5, 6]);
const CREATED_AT = new Date(NOW * 1000).toISOString();

type WorkflowCall = { id: string; params: unknown; retention: unknown };
type VerifierRequestContract = { parts: Array<[string, unknown]> };
type OperationContract = { operationId: string; envelope: { result: { resultRef: string } | null } | null };
type ApiContract = {
  policyVersions: unknown;
  verifierRequests: { validate: VerifierRequestContract; verifyImage: VerifierRequestContract };
  pairing: Record<string, string>;
  session: Record<string, string>;
  awaitingUpload: OperationContract;
  completedCheck: OperationContract;
  completedDownload: OperationContract;
  failed: OperationContract;
  history: unknown;
  stats: unknown;
  deleteOk: unknown;
  linkDownload: { request: { method: string; path: string; body: unknown }; status: number; response: { jobId: string; state: string } };
};

const contractText = readFileSync(new URL("./fixtures/integration-api-v1.json", import.meta.url), "utf8");
const contract = JSON.parse(contractText) as ApiContract;
const contractSha256 = "408f9fdac058e10d06ff4072883babb27ced004ad58be1113217a3066e69d0f9";
const CONTRACT_NOW = new Date("2026-09-16T10:00:00.000Z");
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/u;

let db: D1BatchDatabaseLike;
let dispose: () => Promise<void>;
let env: IntegrationEnv;
let objects: Map<string, Uint8Array>;
let providerCalls: Array<{ path: string; accountId: string }>;
let workflowCalls: WorkflowCall[];

const immediateStep: IntegrationStep = {
  do: async (_name, _options, callback) => callback(),
};

function r2Bucket(): R2BucketLike {
  return {
    async get(key): Promise<R2ObjectLike | null> {
      const value = objects.get(key);
      if (!value) return null;
      const copy = new Uint8Array(value.byteLength);
      copy.set(value);
      return { body: new Response(copy.buffer).body, size: copy.byteLength };
    },
    async put(key, value): Promise<void> {
      if (value instanceof Uint8Array) {
        objects.set(key, new Uint8Array(value));
        return;
      }
      const bytes = new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
      objects.set(key, bytes);
    },
    async delete(key): Promise<void> { objects.delete(key); },
    async list(): Promise<{ objects: Array<{ key: string; uploaded?: Date }>; truncated: boolean }> {
      return { objects: [], truncated: false };
    },
  };
}

function gatewayEnv(): IntegrationEnv {
  return {
    DB: db,
    INTEGRATION_ENABLED: "true",
    INTEGRATION_ALLOWED_ORIGINS: ORIGIN,
    PUBLIC_WORKER_BASE_URL: "https://worker.example",
    TELEGRAM_BOT_TOKEN: "123456:test",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    INTERNAL_CONTAINER_SECRET: "container-secret",
    DOWNLOAD_LINK_HMAC_SECRET: "download-secret",
    ALLOWED_TELEGRAM_USER_IDS: `${OWNER},${OTHER}`,
    ALLOWED_SOURCE_HOSTS: "youtube.com,youtu.be",
    TELEGRAM_BOT_API_BASE: "https://api.telegram.org",
    MAX_TELEGRAM_BYTES: "49000000",
    MEDIA_BUCKET: r2Bucket(),
    PROVENANCE_VERIFIER: {
      fetch: vi.fn(async (request: Request) => {
        const accountId = request.headers.get("x-integration-account-id") ?? "";
        providerCalls.push({ path: new URL(request.url).pathname, accountId });
        if (new URL(request.url).pathname === "/validate") {
          const form = await request.formData();
          return Response.json({
            mediaSha256: form.get("imageSha256"),
            byteLength: Number(form.get("byteLength")),
            mimeType: form.get("validatedMimeType"),
            audioDurationSeconds: request.headers.get("x-integration-media-kind") === "audio" ? 5 : null,
          });
        }
        return Response.json({ result: {}, cache: null });
      }),
    },
    INTEGRATION_WORKFLOW: {
      create: vi.fn(async (value: WorkflowCall) => { workflowCalls.push(value); }),
      get: vi.fn(),
    },
  } as unknown as IntegrationEnv;
}

function input(operationId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    operationId,
    action: "check",
    forceRecheck: false,
    media: {
      mediaSha256: hashIntegrationBytes(PNG),
      byteLength: PNG.byteLength,
      mimeType: "image/png",
      inputKind: "original",
      audioDurationSeconds: null,
      segment: null,
      fullSourceSha256: null,
    },
    ...overrides,
  };
}

function request(
  token: string,
  path: string,
  options: { method?: string; body?: BodyInit; contentType?: string; createdAt?: string } = {},
): Request {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (options.contentType) headers.set("content-type", options.contentType);
  if (options.createdAt) headers.set("x-integration-created-at", options.createdAt);
  return new Request(`https://worker.example${path}`, { method: options.method ?? "GET", headers, body: options.body });
}

function jsonRequest(token: string, path: string, body: unknown, method = "POST"): Request {
  return request(token, path, {
    method,
    contentType: "application/json",
    createdAt: CREATED_AT,
    body: JSON.stringify(body),
  });
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function authJson(path: string, body: unknown, seed: number): Request {
  return new Request(`https://worker.example${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "cf-connecting-ip": `198.51.100.${seed}`,
    },
    body: JSON.stringify(body),
  });
}

async function pairedSession(telegramUserId: string, seed: number): Promise<IntegrationSessionCredentials> {
  const verifier = bytesToBase64Url(new Uint8Array(32).fill(seed));
  const created = await handleIntegrationRequest(authJson("/api/integration/pairings", {
    verifier, deviceName: `HTTP ${seed}`,
  }, seed), env);
  expect(created?.status).toBe(201);
  const pairing = await responseJson(created!);
  expect(pairing).toMatchObject({
    pairId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
    confirmationCode: expect.stringMatching(/^\d{6}$/u),
  });
  const persistedTiming = await db.prepare("SELECT created_at, expires_at FROM integration_pairings WHERE id = ?1")
    .bind(pairing.pairId as string).first<{ created_at: number; expires_at: number }>();
  if (!persistedTiming) throw new Error("Expected pairing timing row");
  expect(persistedTiming.expires_at - persistedTiming.created_at).toBe(INTEGRATION_AUTH_POLICY.pairingTtlSeconds);
  expect(pairing.expiresAt).toBe(new Date(persistedTiming.expires_at * 1000).toISOString());
  expect(pairing).not.toHaveProperty("ok");
  expect(pairing).not.toHaveProperty("pairing");
  const summary = await getIntegrationPairingSummary(env, {
    pairId: pairing.pairId as string, telegramUserId, privateChatId: telegramUserId,
  }, NOW);
  expect(summary?.confirmationCode).toBe(pairing.confirmationCode);
  await expect(approveIntegrationPairing(env, {
    pairId: pairing.pairId as string,
    confirmationCode: pairing.confirmationCode as string,
    telegramUserId,
    privateChatId: telegramUserId,
  }, NOW)).resolves.toMatchObject({ telegramUserId });
  const exchanged = await handleIntegrationRequest(authJson(
    `/api/integration/pairings/${pairing.pairId as string}/exchange`, { verifier }, seed), env);
  expect(exchanged?.status).toBe(200);
  const session = await responseJson(exchanged!);
  expect(session).toMatchObject({
    tokenType: "Bearer",
    accountId: expect.any(String),
    sessionId: expect.any(String),
    accessToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    refreshToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
  });
  expect(session).not.toHaveProperty("ok");
  expect(session).not.toHaveProperty("session");
  return session as unknown as IntegrationSessionCredentials;
}

beforeAll(async () => {
  ({ db, dispose } = await localD1());
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
  objects = new Map();
  providerCalls = [];
  workflowCalls = [];
  testFixedLengthStream();
  env = gatewayEnv();
});

afterAll(async () => {
  await dispose();
  vi.unstubAllGlobals();
});

describe("authenticated integration HTTP gateway", () => {
  it("registers, uploads, queues, replays, and conflicts through the real session boundary", async () => {
    const session = await pairedSession(OWNER, 1);
    const operationId = "11111111-1111-4111-8111-111111111111";
    const body = input(operationId);

    const registered = await handleIntegrationRequest(jsonRequest(session.accessToken, "/api/integration/operations", body), env);
    expect(registered?.status).toBe(201);
    expect(await responseJson(registered!)).toMatchObject({ operationId, state: "awaiting_upload" });

    const reread = vi.spyOn(env.MEDIA_BUCKET, "get");
    const uploaded = await handleIntegrationRequest(request(session.accessToken, `/api/integration/operations/${operationId}/media`, {
      method: "PUT", contentType: "image/png", body: new Blob([PNG], { type: "image/png" }),
    }), env);
    expect(uploaded?.status).toBe(202);
    expect(await responseJson(uploaded!)).toMatchObject({ operationId, state: "queued" });
    expect(providerCalls).toEqual([]);
    expect(reread).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT status, admitted_at FROM integration_operations WHERE id = ?1").bind(operationId).first())
      .toEqual({ status: "queued", admitted_at: expect.any(String) });
    expect(workflowCalls).toHaveLength(1);
    expect(workflowCalls[0]).toMatchObject({ retention: { successRetention: "1 day", errorRetention: "1 day" } });

    const replay = await handleIntegrationRequest(jsonRequest(session.accessToken, "/api/integration/operations", body), env);
    expect(replay?.status).toBe(200);
    expect(await responseJson(replay!)).toMatchObject({ operationId, state: "queued" });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM integration_operations WHERE id = ?1").bind(operationId).first()).toEqual({ count: 1 });

    const changed = await handleIntegrationRequest(jsonRequest(session.accessToken, "/api/integration/operations", input(operationId, { forceRecheck: true })), env);
    expect(changed?.status).toBe(409);
    expect(await responseJson(changed!)).toMatchObject({ error: { code: "operation_conflict" } });
  });

  it("preserves deliberate Download outcomes when its Telegram copy is deleted", async () => {
    const session = await pairedSession(OWNER, 8);
    const mediaSha256 = hashIntegrationBytes(PNG);
    let sendFailure = false;
    const telegramFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/sendDocument")) {
        await new Response(init?.body).arrayBuffer();
        if (sendFailure) return Response.json({ ok: false, error_code: 400, description: "rejected" }, { status: 400 });
        return Response.json({ ok: true, result: { message_id: 501, chat: { id: 12345 }, document: { file_id: "saved-file-501" } } });
      }
      if (url.endsWith("/getFile")) {
        return Response.json({ ok: true, result: { file_id: "saved-file-501", file_path: "documents/saved.png", file_size: PNG.byteLength } });
      }
      if (url.includes("/file/bot")) return new Response(PNG.slice());
      if (url.endsWith("/deleteMessage")) return Response.json({ ok: true, result: true });
      throw new Error(`Unexpected Telegram request: ${url}`);
    });
    vi.stubGlobal("fetch", telegramFetch as unknown as typeof fetch);

    try {
      const operationId = "77777777-7777-4777-8777-777777777777";
      const registered = await handleIntegrationRequest(jsonRequest(session.accessToken, "/api/integration/operations", input(operationId, { action: "download" })), env);
      expect(registered?.status).toBe(201);
      const uploaded = await handleIntegrationRequest(request(session.accessToken, `/api/integration/operations/${operationId}/media`, {
        method: "PUT", contentType: "image/png", body: new Blob([PNG], { type: "image/png" }),
      }), env);
      expect(uploaded?.status).toBe(202);
      const queued = await db.prepare("SELECT run_generation FROM integration_operations WHERE id = ?1 AND account_id = ?2")
        .bind(operationId, session.accountId).first<{ run_generation: number }>();
      await processIntegrationOperation(env, { accountId: session.accountId, operationId, generation: queued?.run_generation ?? 0 }, immediateStep);

      const before = await handleIntegrationRequest(request(session.accessToken, "/api/integration/stats"), env);
      expect(await responseJson(before!)).toMatchObject({ downloadsRequested: 1, downloadsConfirmed: 1, downloadsFailed: 0, savedOriginals: 1 });

      const deleted = await handleIntegrationRequest(request(session.accessToken, `/api/integration/media/${mediaSha256}/archive`, { method: "DELETE" }), env);
      expect(deleted?.status).toBe(200);
      const afterDelete = await handleIntegrationRequest(request(session.accessToken, "/api/integration/stats"), env);
      expect(await responseJson(afterDelete!)).toMatchObject({ downloadsRequested: 1, downloadsConfirmed: 1, downloadsFailed: 0, savedOriginals: 0 });
      const history = await handleIntegrationRequest(request(session.accessToken, "/api/integration/history?period=all"), env);
      expect(await responseJson(history!)).toMatchObject({
        operations: [expect.objectContaining({
          operationId,
          state: "completed",
          archive: expect.objectContaining({
            deliveryState: "failed",
            documentReceipt: null,
            integrityState: "not_checked",
            error: expect.objectContaining({ code: "archive_deleted" }),
          }),
        })],
      });

      sendFailure = true;
      const failedOperationId = "88888888-8888-4888-8888-888888888888";
      const failedRegistered = await handleIntegrationRequest(jsonRequest(session.accessToken, "/api/integration/operations", input(failedOperationId, { action: "download" })), env);
      expect(failedRegistered?.status).toBe(201);
      const failedUploaded = await handleIntegrationRequest(request(session.accessToken, `/api/integration/operations/${failedOperationId}/media`, {
        method: "PUT", contentType: "image/png", body: new Blob([PNG], { type: "image/png" }),
      }), env);
      expect(failedUploaded?.status).toBe(202);
      const failedQueued = await db.prepare("SELECT run_generation FROM integration_operations WHERE id = ?1 AND account_id = ?2")
        .bind(failedOperationId, session.accountId).first<{ run_generation: number }>();
      await processIntegrationOperation(env, { accountId: session.accountId, operationId: failedOperationId, generation: failedQueued?.run_generation ?? 0 }, immediateStep);

      const afterFailure = await handleIntegrationRequest(request(session.accessToken, "/api/integration/stats"), env);
      expect(await responseJson(afterFailure!)).toMatchObject({ downloadsRequested: 2, downloadsConfirmed: 1, downloadsFailed: 1, savedOriginals: 0 });
      expect(telegramFetch.mock.calls.filter(([input]) => String(input).endsWith("/sendDocument"))).toHaveLength(2);
      expect(telegramFetch.mock.calls.filter(([input]) => String(input).endsWith("/deleteMessage"))).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses to delete a saved copy the user sent and shows its receipt with four keys", async () => {
    const session = await pairedSession(OWNER, 12);
    const account = { accountId: session.accountId, telegramUserId: OWNER, chatId: OWNER };
    const operationId = "99999999-9999-4999-8999-999999999994";
    const value = input(operationId) as unknown as IntegrationInput;
    const operation = await registerIntegrationOperation(db, account, { input: value }, CREATED_AT);
    // A Telegram check keeps the user's own image message as the saved copy.
    const saved = { botId: "123456", chatId: OWNER, messageId: "700", fileId: "incoming-image" };
    await attachIntegrationMedia(db, operation, value, `integration/${session.accountId}/${operationId}/telegram-image`, new Date(), saved);
    const archives = () => db.prepare("SELECT * FROM integration_archives WHERE account_id = ?1").bind(session.accountId).all<Record<string, unknown>>();
    const before = (await archives()).results;
    expect(before).toHaveLength(1);
    const telegramFetch = vi.fn(async (input: RequestInfo | URL) => { throw new Error(`Unexpected Telegram request: ${String(input)}`); });
    vi.stubGlobal("fetch", telegramFetch as unknown as typeof fetch);
    try {
      const deleted = await handleIntegrationRequest(request(session.accessToken, `/api/integration/media/${hashIntegrationBytes(PNG)}/archive`, { method: "DELETE" }), env);
      expect(deleted?.status).toBe(404);
      expect(await responseJson(deleted!)).toEqual({ error: { code: "not_found", message: "No saved document sent by the bot was found. A copy you sent yourself stays in Telegram.", retryable: false } });
      expect(telegramFetch).not.toHaveBeenCalled();
      expect((await archives()).results).toEqual(before);

      const history = await responseJson((await handleIntegrationRequest(request(session.accessToken, "/api/integration/history?period=all"), env))!);
      const operations = history.operations as Array<{ operationId: string; archive: { deliveryState: string; integrityState: string; documentReceipt: Record<string, string> } }>;
      expect(operations.map((item) => item.operationId)).toEqual([operationId]);
      expect(operations[0]?.archive).toMatchObject({ deliveryState: "confirmed", integrityState: "verified", documentReceipt: saved });
      expect(Object.keys(operations[0]!.archive.documentReceipt).sort()).toEqual(["botId", "chatId", "fileId", "messageId"]);
      const snapshot = await responseJson((await handleIntegrationRequest(request(session.accessToken, `/api/integration/operations/${operationId}`), env))!);
      expect(Object.keys((snapshot.archive as { documentReceipt: Record<string, string> }).documentReceipt).sort()).toEqual(["botId", "chatId", "fileId", "messageId"]);
      const stats = await responseJson((await handleIntegrationRequest(request(session.accessToken, "/api/integration/stats"), env))!);
      expect(stats).toMatchObject({ checksRequested: 1, savedOriginals: 1 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps every operation endpoint account-scoped", async () => {
    const owner = await pairedSession(OWNER, 2);
    const other = await pairedSession(OTHER, 3);
    const operationId = "22222222-2222-4222-8222-222222222222";
    const registered = await handleIntegrationRequest(jsonRequest(owner.accessToken, "/api/integration/operations", input(operationId)), env);
    expect(registered?.status).toBe(201);
    const mediaPath = `/api/integration/operations/${operationId}/media`;
    const operationPath = `/api/integration/operations/${operationId}`;

    for (const response of [
      await handleIntegrationRequest(request(other.accessToken, operationPath), env),
      await handleIntegrationRequest(request(other.accessToken, mediaPath, { method: "PUT", contentType: "image/png", body: new Blob([PNG], { type: "image/png" }) }), env),
      await handleIntegrationRequest(request(other.accessToken, `${operationPath}/retry`, { method: "POST" }), env),
      await handleIntegrationRequest(request(other.accessToken, `/api/integration/history/${operationId}`, { method: "DELETE" }), env),
    ]) {
      expect(response?.status).toBe(404);
      expect(await responseJson(response!)).toMatchObject({ error: { code: "not_found" } });
    }
    expect((await handleIntegrationRequest(request(owner.accessToken, operationPath), env))?.status).toBe(200);
    expect(await db.prepare("SELECT deleted_at FROM integration_operations WHERE id = ?1").bind(operationId).first()).toEqual({ deleted_at: null });
  });

  it("denies expired and revoked device sessions before reading account data", async () => {
    const expired = await pairedSession(OWNER, 4);
    await db.prepare("UPDATE integration_sessions SET access_expires_at = ?1 WHERE id = ?2").bind(NOW - 1, expired.sessionId).run();
    const expiredResponse = await handleIntegrationRequest(request(expired.accessToken, "/api/integration/history"), env);
    expect(expiredResponse?.status).toBe(401);
    expect(await responseJson(expiredResponse!)).toMatchObject({ error: { code: "UNAUTHORIZED" } });

    const revoked = await pairedSession(OTHER, 5);
    await db.prepare("UPDATE integration_sessions SET revoked_at = ?1 WHERE id = ?2").bind(NOW, revoked.sessionId).run();
    const revokedResponse = await handleIntegrationRequest(request(revoked.accessToken, "/api/integration/history"), env);
    expect(revokedResponse?.status).toBe(401);
    expect(await responseJson(revokedResponse!)).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("registers processing-only audio as a Check without verifier/provider access", async () => {
    const session = await pairedSession(OWNER, 6);
    const response = await handleIntegrationRequest(jsonRequest(session.accessToken, "/api/integration/audio-segments", {
      operationId: "33333333-3333-4333-8333-333333333333",
      sourceUrl: "https://youtube.com/watch?v=abc",
      startSeconds: 0,
      endSeconds: 15,
    }), env);
    expect(response?.status).toBe(202);
    expect(await responseJson(response!)).toMatchObject({ action: "check", state: "queued" });
    expect(await db.prepare("SELECT action, admitted_at FROM integration_operations WHERE id = ?1")
      .bind("33333333-3333-4333-8333-333333333333").first()).toMatchObject({ action: "check", admitted_at: expect.any(String) });
    const stats = await handleIntegrationRequest(request(session.accessToken, "/api/integration/stats"), env);
    expect(stats?.status).toBe(200);
    expect(await responseJson(stats!)).toMatchObject({ checksRequested: 1, downloadsRequested: 0 });
    expect(providerCalls).toHaveLength(0);
    expect(workflowCalls).toHaveLength(1);
  });

  it("rejects unsupported, oversized, and hash-mismatched checks before admission", async () => {
    const session = await pairedSession(OWNER, 7);
    const unsupported = await handleIntegrationRequest(jsonRequest(session.accessToken, "/api/integration/operations", input("44444444-4444-4444-8444-444444444444", {
      media: { ...(input("55555555-5555-4555-8555-555555555555").media as Record<string, unknown>), mimeType: "image/gif" },
    })), env);
    expect(unsupported?.status).toBe(400);

    const oversized = await handleIntegrationRequest(jsonRequest(session.accessToken, "/api/integration/operations", input("55555555-5555-4555-8555-555555555555", {
      media: { ...(input("66666666-6666-4666-8666-666666666666").media as Record<string, unknown>), byteLength: INTEGRATION_CHECK_BYTES + 1 },
    })), env);
    expect(oversized?.status).toBe(400);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM integration_operations").first()).toEqual({ count: 0 });

    const operationId = "66666666-6666-4666-8666-666666666666";
    const registered = await handleIntegrationRequest(jsonRequest(session.accessToken, "/api/integration/operations", input(operationId)), env);
    expect(registered?.status).toBe(201);
    const path = `/api/integration/operations/${operationId}/media`;
    const mismatch = await handleIntegrationRequest(request(session.accessToken, path, {
      method: "PUT", contentType: "image/png", body: new Blob([WRONG_PNG], { type: "image/png" }),
    }), env);
    expect(mismatch?.status).toBe(400);
    expect(await responseJson(mismatch!)).toMatchObject({ error: { code: "hash_mismatch" } });

    const tooLarge = await handleIntegrationRequest(request(session.accessToken, path, {
      method: "PUT", contentType: "image/png", body: new Blob([new Uint8Array([...PNG, 7])], { type: "image/png" }),
    }), env);
    expect(tooLarge?.status).toBe(413);
    const operation = await db.prepare("SELECT status, admitted_at, temp_key FROM integration_operations WHERE id = ?1")
      .bind(operationId).first<{ status: string; admitted_at: string | null; temp_key: string | null }>();
    expect(operation).toEqual({ status: "awaiting_upload", admitted_at: null, temp_key: null });
    expect(providerCalls).toHaveLength(0);
    expect(objects.size).toBe(0);
  });

  it("keeps /validate for audio Check uploads and none for Download uploads", async () => {
    const session = await pairedSession(OWNER, 10);
    const audio = new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]);
    const uploads = [
      { operationId: "99999999-9999-4999-8999-999999999991", bytes: audio, mimeType: "audio/mpeg", body: input("99999999-9999-4999-8999-999999999991", {
        media: { ...(input("99999999-9999-4999-8999-999999999991").media as Record<string, unknown>),
          mediaSha256: hashIntegrationBytes(audio), byteLength: audio.byteLength, mimeType: "audio/mpeg", audioDurationSeconds: 5 },
      }), calls: ["/validate"] },
      { operationId: "99999999-9999-4999-8999-999999999992", bytes: PNG, mimeType: "image/png",
        body: input("99999999-9999-4999-8999-999999999992", { action: "download" }), calls: [] },
    ];
    for (const upload of uploads) {
      providerCalls = [];
      const registered = await handleIntegrationRequest(jsonRequest(session.accessToken, "/api/integration/operations", upload.body), env);
      expect(registered?.status).toBe(201);
      const uploaded = await handleIntegrationRequest(request(session.accessToken, `/api/integration/operations/${upload.operationId}/media`, {
        method: "PUT", contentType: upload.mimeType, body: new Blob([upload.bytes], { type: upload.mimeType }),
      }), env);
      expect(uploaded?.status).toBe(202);
      expect(providerCalls.map((call) => call.path)).toEqual(upload.calls);
      expect(await db.prepare("SELECT status, admitted_at FROM integration_operations WHERE id = ?1").bind(upload.operationId).first())
        .toEqual({ status: "queued", admitted_at: expect.any(String) });
    }
  });

  it("rejects a WebP header shorter than Lens accepts before admission", async () => {
    const session = await pairedSession(OWNER, 11);
    const operationId = "99999999-9999-4999-8999-999999999993";
    const short = new TextEncoder().encode("RIFFWEBP");
    const registered = await handleIntegrationRequest(jsonRequest(session.accessToken, "/api/integration/operations", input(operationId, {
      media: { ...(input(operationId).media as Record<string, unknown>), mediaSha256: hashIntegrationBytes(short), byteLength: short.byteLength, mimeType: "image/webp" },
    })), env);
    expect(registered?.status).toBe(201);
    const uploaded = await handleIntegrationRequest(request(session.accessToken, `/api/integration/operations/${operationId}/media`, {
      method: "PUT", contentType: "image/webp", body: new Blob([short], { type: "image/webp" }),
    }), env);
    expect(uploaded?.status).toBe(400);
    expect(await responseJson(uploaded!)).toMatchObject({ error: { code: "invalid_media" } });
    expect(await db.prepare("SELECT status, admitted_at FROM integration_operations WHERE id = ?1").bind(operationId).first())
      .toEqual({ status: "awaiting_upload", admitted_at: null });
    expect(objects.size).toBe(0);
  });
});

describe("INTEGRATION-API-001 gateway and verifier contract fixture", () => {
  it("pins the fixture bytes and the shared policy versions", () => {
    expect(createHash("sha256").update(contractText).digest("hex")).toBe(contractSha256);
    expect(contract.policyVersions).toEqual({ image: IMAGE_POLICY, audio: AUDIO_POLICY });
  });

  it("matches every normalized live response and verifier request", async () => {
    // Freeze only Date so every server timestamp is reproducible; random IDs and tokens are aliased below.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(CONTRACT_NOW);
    const aliases = new Map<string, string>();
    const alias = (live: unknown, pattern: RegExp, placeholder: string): void => {
      expect(live).toMatch(pattern);
      aliases.set(live as string, placeholder);
    };
    const normalized = (value: unknown): unknown => JSON.parse(JSON.stringify(value), (_key, item: unknown) => (
      typeof item === "string" ? aliases.get(item) ?? item : item));
    const live = async (response: Response | null, status: number): Promise<Record<string, unknown>> => {
      expect(response?.status).toBe(status);
      return responseJson(response!);
    };
    const filePart = contract.verifierRequests.validate.parts.find(([name]) => name === "file")?.[1] as { base64: string };
    const image = Uint8Array.from(Buffer.from(filePart.base64, "base64"));

    const verifierRequests: unknown[] = [];
    env = { ...env, PROVENANCE_VERIFIER: {
      fetch: async (verifierRequest: Request) => {
        const url = new URL(verifierRequest.url);
        const parts: Array<[string, unknown]> = [];
        for (const [name, value] of await verifierRequest.formData()) {
          parts.push([name, typeof value === "string" ? value
            : { filename: value.name, type: value.type, base64: Buffer.from(await value.arrayBuffer()).toString("base64") }]);
        }
        // Record every header; only the random multipart boundary is replaced.
        const headers = Object.fromEntries([...verifierRequest.headers].map(([name, value]) => (
          [name, name === "content-type" ? value.replace(/boundary=[^;]+/u, "boundary=<boundary>") : value])));
        verifierRequests.push({ method: verifierRequest.method, path: url.pathname + url.search, headers, parts });
        if (url.pathname === "/validate") {
          const fields = Object.fromEntries(parts) as Record<string, string>;
          return Response.json({ mediaSha256: fields.imageSha256, byteLength: Number(fields.byteLength), mimeType: fields.validatedMimeType, audioDurationSeconds: null });
        }
        const checkedAt = CONTRACT_NOW.toISOString();
        return Response.json({
          result: {
            verdict: "no_supported_openai_signal", summary: "No supported provenance signal was detected.", signals: [], warnings: [],
            checkedAt, requestId: "22222222-2222-4222-8222-222222222222",
            contentCredentials: {
              status: "not_present", signatureValid: false, contentBindingValid: false, signerTrusted: false, issuer: null,
              actions: [], aiDeclaration: null, validationCodes: [], trustListVersion: "fixture-v1",
            },
          },
          cache: { source: "fresh", originallyCheckedAt: checkedAt, expiresAt: "2026-10-16T10:00:00.000Z", verificationPolicyVersion: IMAGE_POLICY, resultSchemaVersion: 2 },
        });
      },
    } } as unknown as IntegrationEnv;
    let sendFailure = false;
    let sent = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/sendDocument")) {
        await new Response(init?.body).arrayBuffer();
        if (sendFailure) return Response.json({ ok: false, error_code: 400, description: "rejected" }, { status: 400 });
        sent += 1;
        return Response.json({ ok: true, result: { message_id: 100 + sent, chat: { id: Number(OWNER) }, document: { file_id: `saved-file-${100 + sent}` } } });
      }
      if (url.endsWith("/getFile")) return Response.json({ ok: true, result: { file_id: "saved-file", file_path: "documents/saved.png", file_size: image.byteLength } });
      if (url.includes("/file/bot")) return new Response(image.slice());
      // The link download's queue notice.
      if (url.endsWith("/sendMessage")) return Response.json({ ok: true, result: { message_id: 99, chat: { id: Number(OWNER) } } });
      throw new Error(`Unexpected Telegram request: ${url}`);
    }) as unknown as typeof fetch);

    try {
      const verifier = bytesToBase64Url(new Uint8Array(32).fill(9));
      const pairing = await live(await handleIntegrationRequest(authJson("/api/integration/pairings", { verifier, deviceName: "Contract" }, 9), env), 201);
      alias(pairing.pairId, UUID_V4, contract.pairing.pairId!);
      alias(pairing.confirmationCode, /^\d{6}$/u, contract.pairing.confirmationCode!);
      expect(normalized(pairing)).toEqual(contract.pairing);
      await expect(approveIntegrationPairing(env, {
        pairId: pairing.pairId as string, confirmationCode: pairing.confirmationCode as string, telegramUserId: OWNER, privateChatId: OWNER,
      }, CONTRACT_NOW.getTime() / 1000)).resolves.toMatchObject({ telegramUserId: OWNER });
      const session = await live(await handleIntegrationRequest(authJson(`/api/integration/pairings/${pairing.pairId as string}/exchange`, { verifier }, 9), env), 200);
      alias(session.accountId, UUID_V4, contract.session.accountId!);
      alias(session.sessionId, UUID_V4, contract.session.sessionId!);
      alias(session.accessToken, OPAQUE_TOKEN, contract.session.accessToken!);
      alias(session.refreshToken, OPAQUE_TOKEN, contract.session.refreshToken!);
      expect(normalized(session)).toEqual(contract.session);

      const token = session.accessToken as string;
      const register = (operationId: string, action: "check" | "download") => handleIntegrationRequest(request(token, "/api/integration/operations", {
        method: "POST", contentType: "application/json", createdAt: CONTRACT_NOW.toISOString(),
        body: JSON.stringify(input(operationId, { action, media: { ...(input(operationId).media as Record<string, unknown>), mediaSha256: hashIntegrationBytes(image), byteLength: image.byteLength } })),
      }), env);
      const uploadAndProcess = async (operationId: string): Promise<void> => {
        const uploaded = await handleIntegrationRequest(request(token, `/api/integration/operations/${operationId}/media`, {
          method: "PUT", contentType: "image/png", body: new Blob([image], { type: "image/png" }),
        }), env);
        expect(uploaded?.status).toBe(202);
        const queued = await db.prepare("SELECT run_generation FROM integration_operations WHERE id = ?1")
          .bind(operationId).first<{ run_generation: number }>();
        await processIntegrationOperation(env, { accountId: session.accountId as string, operationId, generation: queued?.run_generation ?? 0 }, immediateStep);
      };
      const snapshot = async (operationId: string) => live(await handleIntegrationRequest(request(token, `/api/integration/operations/${operationId}`), env), 200);

      const checkId = contract.awaitingUpload.operationId;
      expect(normalized(await live(await register(checkId, "check"), 201))).toEqual(contract.awaitingUpload);
      await uploadAndProcess(checkId);
      const completedCheck = await snapshot(checkId) as unknown as OperationContract;
      alias(completedCheck.envelope?.result?.resultRef, UUID_V4, contract.completedCheck.envelope!.result!.resultRef);
      expect(normalized(completedCheck)).toEqual(contract.completedCheck);
      expect(normalized(await live(await handleIntegrationRequest(request(token, "/api/integration/history"), env), 200))).toEqual(contract.history);

      for (const [expected, failing] of [[contract.completedDownload, false], [contract.failed, true]] as const) {
        sendFailure = failing;
        expect((await register(expected.operationId, "download"))?.status).toBe(201);
        await uploadAndProcess(expected.operationId);
        expect(normalized(await snapshot(expected.operationId))).toEqual(expected);
      }
      expect(normalized(await live(await handleIntegrationRequest(request(token, "/api/integration/stats"), env), 200))).toEqual(contract.stats);
      expect(await live(await handleIntegrationRequest(request(token, `/api/integration/history/${contract.failed.operationId}`, { method: "DELETE" }), env), 200))
        .toEqual(contract.deleteOk);
      // Last, so its legacy job row cannot change the statistics above.
      const link = contract.linkDownload;
      const queued = await live(await handleIntegrationRequest(request(token, link.request.path, {
        method: link.request.method, contentType: "application/json", body: JSON.stringify(link.request.body),
      }), env), link.status);
      alias(queued.jobId, UUID_V4, link.response.jobId);
      expect(normalized(queued)).toEqual(link.response);
      // Image Check uploads no longer send /validate; the Telegram /check path still sends this exact request.
      const admitted = await db.prepare("SELECT input_json FROM integration_operations WHERE id = ?1").bind(checkId).first<{ input_json: string }>();
      await validateIntegrationCheck(env, session.accountId as string, JSON.parse(admitted!.input_json) as IntegrationInput, image);
      expect(normalized(verifierRequests)).toEqual([contract.verifierRequests.verifyImage, contract.verifierRequests.validate]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

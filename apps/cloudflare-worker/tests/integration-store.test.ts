import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { integrationAccountForTelegram } from "../src/integration-auth";
import { deleteIntegrationHistory, integrationHistory, integrationOriginAllowed, integrationStats, retryIntegrationOperation } from "../src/integration";
import { dispatchIntegrationOperation, integrationWorkflowId, processIntegrationOperation, type IntegrationEnv, type IntegrationStep } from "../src/integration-media";
import { attachIntegrationMedia, getIntegrationOperation, hashIntegrationBytes, integrationArchiveFor, integrationOperationSnapshot, parseIntegrationInput, registerIntegrationOperation, type IntegrationAccount, type IntegrationInput, type IntegrationOperation, type IntegrationSavedCopy } from "../src/integration-store";
import type { D1BatchDatabaseLike } from "../src/types";
import { testFixedLengthStream } from "./helpers/fixed-length-stream";
import { localD1 } from "./helpers/local-d1";
import { cleanupIntegrationMedia, recoverIntegrationOperations } from "../src/integration-workflow";
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));

const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
// The Telegram image message a /check answered; its bytes are the ones checked, so it is the saved copy.
const SAVED: IntegrationSavedCopy = { botId: "123456", chatId: "12345", messageId: "700", fileId: "incoming-image" };
const evidence = (JSON.parse(readFileSync(new URL("./fixtures/integration-envelope-v1.json", import.meta.url), "utf8")) as { result: { evidence: unknown } }).result.evidence;
let db: D1BatchDatabaseLike;
let dispose: () => Promise<void>;
let env: IntegrationEnv;
let account: IntegrationAccount;
let other: IntegrationAccount;
let objects: Map<string, Uint8Array>;
let providerCalls = 0;
let sends = 0;
let getFiles = 0;
const step: IntegrationStep = { do: async (_name, _options, callback) => callback() };
function input(action: "check" | "download" = "check", id = crypto.randomUUID()): IntegrationInput {
  return { version: 1, operationId: id, action, forceRecheck: false, media: {
    mediaSha256: hashIntegrationBytes(bytes), byteLength: bytes.length, mimeType: "image/png", inputKind: "original",
    audioDurationSeconds: null, segment: null, fullSourceSha256: null,
  } };
}
async function admit(value = input(), owner = account, saved?: IntegrationSavedCopy): Promise<IntegrationOperation> {
  const op = await registerIntegrationOperation(db, owner, { input: value }, new Date().toISOString());
  const key = `integration/${owner.accountId}/${op.id}/test`;
  objects.set(key, bytes.slice());
  await attachIntegrationMedia(db, op, value, key, new Date(), saved);
  return (await getIntegrationOperation(db, owner.accountId, op.id))!;
}
async function run(op: IntegrationOperation, checkpoint = step): Promise<void> {
  await processIntegrationOperation(env, { accountId: op.account_id, operationId: op.id, generation: op.run_generation }, checkpoint);
}

beforeAll(async () => { ({ db, dispose } = await localD1()); });
afterAll(async () => { await dispose(); vi.unstubAllGlobals(); });
beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM integration_operations"), db.prepare("DELETE FROM integration_archives"), db.prepare("DELETE FROM integration_media")]);
  objects = new Map(); providerCalls = 0; sends = 0; getFiles = 0; testFixedLengthStream();
  env = {
    DB: db, INTEGRATION_ENABLED: "true", INTEGRATION_ALLOWED_ORIGINS: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    TELEGRAM_BOT_TOKEN: "123456:test", ALLOWED_TELEGRAM_USER_IDS: "12345,67890", PUBLIC_WORKER_BASE_URL: "https://gateway.example",
    TELEGRAM_BOT_API_BASE: "https://api.telegram.org", MAX_TELEGRAM_BYTES: "49000000",
    MEDIA_BUCKET: { get: async (key: string) => objects.has(key) ? { body: new Blob([objects.get(key)! as Uint8Array<ArrayBuffer>]).stream() } : null,
      put: async (key: string, value: ReadableStream<Uint8Array> | Uint8Array) => { objects.set(key, value instanceof Uint8Array ? value.slice() : new Uint8Array(await new Response(value).arrayBuffer())); },
      delete: async (key: string) => { objects.delete(key); }, list: async () => ({ objects: [], truncated: false }) },
    INTEGRATION_WORKFLOW: { create: vi.fn(async () => ({})) },
    PROVENANCE_VERIFIER: { fetch: async () => { providerCalls++; return Response.json({ result: evidence, cache: null }); } },
  } as unknown as IntegrationEnv;
  account = (await integrationAccountForTelegram(env, { telegramUserId: "12345", privateChatId: "12345" }))!;
  other = (await integrationAccountForTelegram(env, { telegramUserId: "67890", privateChatId: "67890" }))!;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.body instanceof ReadableStream) await new Response(init.body).arrayBuffer();
    const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
    if (path.endsWith("/sendDocument")) { sends++; return Response.json({ ok: true, result: { message_id: 42, chat: { id: 12345, type: "private" }, document: { file_id: "saved-file" } } }); }
    if (path.endsWith("/getFile")) { getFiles++; return Response.json({ ok: true, result: { file_id: "saved-file", file_path: "documents/saved.png", file_size: bytes.length } }); }
    if (path.endsWith("/saved.png")) return new Response(bytes);
    throw new Error("Unexpected network access");
  }));
});

describe("integration durable state", () => {
  it("strictly validates input kinds, sizes and derived-audio ranges", () => {
    const value = input();
    expect(parseIntegrationInput(value, 49_000_000)).toEqual(value);
    for (const media of [{ ...value.media, inputKind: ["original"] }, { ...value.media, byteLength: 4_194_305 },
      { ...value.media, segment: { startSeconds: 0, endSeconds: 20 } }]) {
      expect(() => parseIntegrationInput({ ...value, media }, 49_000_000)).toThrow();
    }
    expect(() => parseIntegrationInput({ ...value, action: "download", forceRecheck: true }, 49_000_000)).toThrow();
  });
  it("isolates client operation IDs, archives, replays and changed options by account", async () => {
    const value = input();
    const created = new Date().toISOString();
    const [one, two] = await Promise.all([registerIntegrationOperation(db, account, { input: value }, created), registerIntegrationOperation(db, account, { input: value }, created)]);
    expect(one.id).toBe(two.id);
    await expect(registerIntegrationOperation(db, account, { input: { ...value, forceRecheck: true } }, created)).rejects.toMatchObject({ code: "operation_conflict" });
    const third = await registerIntegrationOperation(db, other, { input: value }, created);
    expect(third.account_id).toBe(other.accountId);
    expect(integrationWorkflowId(third)).not.toBe(integrationWorkflowId(one));
    await attachIntegrationMedia(db, one, value, "one"); await attachIntegrationMedia(db, third, value, "two");
    expect((await getIntegrationOperation(db, account.accountId, one.id))?.archive_id).not.toBe((await getIntegrationOperation(db, other.accountId, third.id))?.archive_id);
  });
  it("normalizes equivalent request times and stops deleted or expired admission", async () => {
    const value = input(); const created = new Date().toISOString();
    const op = await registerIntegrationOperation(db, account, { input: value }, created);
    expect((await registerIntegrationOperation(db, account, { input: value }, created.replace("Z", "+00:00"))).id).toBe(op.id);
    await deleteIntegrationHistory(env, account, [op]);
    await expect(attachIntegrationMedia(db, op, value, "late")).rejects.toMatchObject({ code: "operation_expired" });
    await expect(registerIntegrationOperation(db, account, { input: value }, created)).rejects.toMatchObject({ code: "operation_deleted" });
    const expired = await registerIntegrationOperation(db, other, { input: value }, created);
    await db.prepare("UPDATE integration_operations SET expires_at = ?1 WHERE account_id = ?2").bind("2000-01-01T00:00:00.000Z", other.accountId).run();
    await expect(attachIntegrationMedia(db, expired, value, "late")).rejects.toMatchObject({ code: "operation_expired" });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM integration_media").first()).toEqual({ count: 0 });
  });
  it("Download never calls the verifier; a replay keeps one confirmed document", async () => {
    const op = await admit(input("download"));
    await run(op); await run(op);
    expect(providerCalls).toBe(0); expect(sends).toBe(1);
    const latest = (await getIntegrationOperation(db, account.accountId, op.id))!;
    expect((await integrationOperationSnapshot(db, latest)).archive).toMatchObject({ deliveryState: "confirmed", integrityState: "verified", roundTripSha256: hashIntegrationBytes(bytes) });
    expect(latest.status).toBe("completed");
    const check = await admit();
    await run(check);
    expect(check.archive_id).toBe(latest.archive_id);
    expect(providerCalls).toBe(1); expect(sends).toBe(1);
    const newDownload = await admit(input("download"));
    await run(newDownload);
    expect(newDownload.archive_id).not.toBe(latest.archive_id);
    expect(providerCalls).toBe(1); expect(sends).toBe(2);
  });
  it("keeps a Telegram-checked image as its saved copy: nothing is sent and a later Lens-style admit reuses it", async () => {
    const op = await admit(input(), account, SAVED);
    await run(op);
    expect(sends).toBe(0); expect(getFiles).toBe(0); expect(providerCalls).toBe(1);
    const latest = (await getIntegrationOperation(db, account.accountId, op.id))!;
    expect(latest).toMatchObject({ status: "completed", temp_key: null, reserved_bytes: 0 });
    expect(latest.result_json).not.toBeNull();
    const archive = (await integrationArchiveFor(db, latest))!;
    expect(archive).toMatchObject({ kind: "automatic", delivery_state: "confirmed", integrity_state: "verified", round_trip_sha256: hashIntegrationBytes(bytes), attempt_started_at: null, error_json: null });
    expect(JSON.parse(archive.receipt_json!)).toEqual({ ...SAVED, sender: "user" });
    // Lens parses documentReceipt strictly: the sender marker never reaches the API.
    const snapshot = await integrationOperationSnapshot(db, latest);
    expect(snapshot.archive).toMatchObject({ deliveryState: "confirmed", integrityState: "verified", roundTripSha256: hashIntegrationBytes(bytes), documentReceipt: SAVED });
    expect(Object.keys(snapshot.archive.documentReceipt!).sort()).toEqual(["botId", "chatId", "fileId", "messageId"]);
    expect(objects.size).toBe(0);

    const lens = await admit();
    expect(lens.archive_id).toBe(latest.archive_id);
    await run(lens);
    expect(sends).toBe(0); expect(getFiles).toBe(0); expect(providerCalls).toBe(2);
    expect(await integrationArchiveFor(db, lens)).toEqual(archive);
    expect((await getIntegrationOperation(db, account.accountId, lens.id))).toMatchObject({ status: "completed", temp_key: null, reserved_bytes: 0 });
    expect(await integrationStats(env, account, "all")).toMatchObject({ checksRequested: 2, checksCompleted: 2, uniqueMedia: 1, savedOriginals: 1 });
  });
  it("lets a user copy take over a pending or failed archive row and never a sending, unknown or confirmed one", async () => {
    const lens = await admit();
    expect((await integrationArchiveFor(db, lens))?.delivery_state).toBe("pending");
    const user = await admit(input(), account, SAVED);
    expect(user.archive_id).toBe(lens.archive_id);
    expect(await integrationArchiveFor(db, user)).toMatchObject({ delivery_state: "confirmed", integrity_state: "verified", receipt_json: JSON.stringify({ ...SAVED, sender: "user" }), attempt_started_at: null });
    await Promise.all([run(lens), run(user)]);
    expect(sends).toBe(0); expect(getFiles).toBe(0);
    for (const op of [lens, user]) expect(await getIntegrationOperation(db, account.accountId, op.id)).toMatchObject({ status: "completed", temp_key: null, reserved_bytes: 0 });

    const archiveRow = (id: string) => db.prepare("SELECT * FROM integration_archives WHERE id = ?1 AND account_id = ?2").bind(id, account.accountId).first<Record<string, unknown>>();
    const receipt = JSON.stringify({ botId: "123456", chatId: "12345", messageId: "42", fileId: "saved-file" });
    for (const state of ["failed", "sending", "unknown", "confirmed"] as const) {
      await db.batch([db.prepare("DELETE FROM integration_operations"), db.prepare("DELETE FROM integration_archives"), db.prepare("DELETE FROM integration_media")]);
      const seeded = await admit();
      // A fresh failed row, not only a stale one; a confirmed row keeps the bot's receipt and stays unverified so the lookup cannot reuse it.
      await db.prepare("UPDATE integration_archives SET delivery_state = ?1, receipt_json = ?2, error_json = ?3, updated_at = ?4 WHERE id = ?5")
        .bind(state, state === "confirmed" ? receipt : null, state === "failed" ? JSON.stringify({ code: "archive_failed", message: "rejected", retryable: true }) : null,
          new Date(Date.now() + 60_000).toISOString(), seeded.archive_id).run();
      const before = await archiveRow(seeded.archive_id!);
      const taken = await admit(input(), account, SAVED);
      expect(taken.archive_id).toBe(seeded.archive_id);
      const after = await archiveRow(seeded.archive_id!);
      if (state === "failed") {
        expect(after).toMatchObject({ delivery_state: "confirmed", integrity_state: "verified", round_trip_sha256: hashIntegrationBytes(bytes), receipt_json: JSON.stringify({ ...SAVED, sender: "user" }), error_json: null, attempt_started_at: null });
      } else {
        expect(after).toEqual(before);
      }
    }
    expect(sends).toBe(0);
  });
  it("concurrent checks share only their account's archive and count separate actions", async () => {
    const [one, two] = await Promise.all([admit(), admit()]);
    await Promise.all([run(one), run(two)]);
    expect(sends).toBe(1); expect(providerCalls).toBe(2);
    const stats = await integrationStats(env, account, "all");
    expect(stats).toMatchObject({ checksRequested: 2, checksCompleted: 2, downloadsRequested: 0, uniqueMedia: 1, savedOriginals: 1 });
    expect((await integrationHistory(env, other, new URL("https://gateway/api/integration/history?period=all"))).operations).toHaveLength(0);
  });
  it("preserves evidence through archive ambiguity and refuses delivery retry", async () => {
    const op = await admit();
    vi.stubGlobal("fetch", vi.fn(async () => { sends++; throw new Error("connection lost after send"); }));
    await run(op);
    const latest = (await getIntegrationOperation(db, account.accountId, op.id))!;
    expect(latest.result_json).not.toBeNull(); expect(latest.status).toBe("completed");
    expect((await integrationArchiveFor(db, latest))?.delivery_state).toBe("unknown");
    await expect(retryIntegrationOperation(env, account, latest)).rejects.toMatchObject({ code: "archive_unknown" });
    expect(sends).toBe(1);
  });
  it("keeps original delivery independent of failed verification and uses a new retry generation", async () => {
    const op = await admit();
    env.PROVENANCE_VERIFIER = { fetch: async () => new Response("unavailable", { status: 503 }) } as unknown as IntegrationEnv["PROVENANCE_VERIFIER"];
    await run(op);
    const failed = (await getIntegrationOperation(db, account.accountId, op.id))!;
    expect(failed.status).toBe("failed"); expect(failed.temp_key).not.toBeNull();
    expect((await integrationArchiveFor(db, failed))?.integrity_state).toBe("verified");
    await retryIntegrationOperation(env, account, failed);
    const retry = (await getIntegrationOperation(db, account.accountId, op.id))!;
    expect(retry.run_generation).toBe(1);
    await dispatchIntegrationOperation(env, retry);
    expect(env.INTEGRATION_WORKFLOW!.create).toHaveBeenCalledWith(expect.objectContaining({ id: integrationWorkflowId(retry), retention: { successRetention: "1 day", errorRetention: "1 day" } }));
    expect((await integrationStats(env, account, "all")).checksRequested).toBe(1);
  });
  it("resumes a checkpointed result after a failed History write without repeating verification", async () => {
    const op = await admit();
    const checkpoints = new Map<string, unknown>();
    let interruptWrite = true;
    const checkpoint: IntegrationStep = { do: async <T>(name: string, _options: unknown, callback: () => Promise<T>): Promise<T> => {
      if (checkpoints.has(name)) return checkpoints.get(name) as T;
      if (name === "save evidence" && interruptWrite) { interruptWrite = false; throw new Error("D1 unavailable"); }
      const result = await callback(); checkpoints.set(name, result); return result;
    } };
    await expect(run(op, checkpoint)).rejects.toThrow("D1 unavailable");
    expect(providerCalls).toBe(1);
    await run(op, checkpoint);
    expect(providerCalls).toBe(1);
    expect((await getIntegrationOperation(db, account.accountId, op.id))?.result_json).not.toBeNull();
  });
  it("enforces exact origin metadata while leaving identity to authentication", () => {
    const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const request = (headers: Record<string, string>, route = "pairings") => new Request(`https://gateway.example/api/integration/${route}`, { headers });
    expect(integrationOriginAllowed(request({ "x-integration-client-origin": origin }), env)).toBe(true);
    expect(integrationOriginAllowed(request({ origin: "null", "x-integration-client-origin": origin }), env)).toBe(false);
    expect(integrationOriginAllowed(request({ origin: "https://gateway.example", authorization: "tma signed" }), env)).toBe(false);
    expect(integrationOriginAllowed(request({ origin: "https://gateway.example", authorization: "tma signed" }, "history"), env)).toBe(true);
    expect(integrationOriginAllowed(request({ authorization: "Bearer secret" }, "history"), env)).toBe(true);
  });
  it("recovers only the evidence checkpoint and preserves uncertain delivery", async () => {
    const op = await admit();
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    await db.prepare("UPDATE integration_operations SET status = 'processing', provider_started_at = ?1, updated_at = ?1 WHERE id = ?2")
      .bind(old, op.id).run();
    await db.prepare("UPDATE integration_archives SET delivery_state = 'sending' WHERE id = ?1").bind(op.archive_id).run();
    const restart = vi.fn(async () => undefined);
    env.INTEGRATION_WORKFLOW!.get = vi.fn().mockResolvedValue({ status: async () => ({ status: "errored" }), restart });
    await recoverIntegrationOperations(env);
    expect(restart).toHaveBeenCalledExactlyOnceWith({ from: { name: "save evidence" } });
    expect((await integrationArchiveFor(db, op))?.delivery_state).toBe("unknown");
    expect((await getIntegrationOperation(db, account.accountId, op.id))?.status).toBe("processing");
    expect(providerCalls).toBe(0);
    expect(sends).toBe(0);

    await db.prepare("UPDATE integration_operations SET updated_at = ?1 WHERE id = ?2").bind(old, op.id).run();
    restart.mockRejectedValueOnce(new Error("Checkpoint missing"));
    await recoverIntegrationOperations(env);
    expect((await getIntegrationOperation(db, account.accountId, op.id))?.status).toBe("failed");
    expect((await integrationArchiveFor(db, op))?.delivery_state).toBe("unknown");
  });
  it("atomically bounds retained uploads and releases reservations only after successful cleanup", async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => admit()));
    expect(attempts.filter((value) => value.status === "fulfilled")).toHaveLength(4);
    expect(attempts.filter((value) => value.status === "rejected")).toHaveLength(1);
    await db.prepare("UPDATE integration_operations SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    const remove = env.MEDIA_BUCKET.delete;
    env.MEDIA_BUCKET.delete = async () => { throw new Error("R2 unavailable"); };
    await expect(cleanupIntegrationMedia(env)).rejects.toThrow("R2 unavailable");
    await expect(admit()).rejects.toMatchObject({ code: "operation_limit" });
    env.MEDIA_BUCKET.delete = remove;
    await cleanupIntegrationMedia(env);
    expect(objects.size).toBe(0);
    await expect(admit()).resolves.toMatchObject({ status: "queued" });
  });
  it("expires only orphaned pending archives while preserving shared and uncertain delivery", async () => {
    const [expired, live] = await Promise.all([admit(), admit()]);
    expect(expired.archive_id).toBe(live.archive_id);
    await db.prepare("UPDATE integration_operations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1 AND account_id = ?2")
      .bind(expired.id, account.accountId).run();
    await cleanupIntegrationMedia(env);
    expect((await integrationArchiveFor(db, live))?.delivery_state).toBe("pending");

    await db.prepare("UPDATE integration_operations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1 AND account_id = ?2")
      .bind(live.id, account.accountId).run();
    await cleanupIntegrationMedia(env);
    const failed = await integrationArchiveFor(db, live);
    expect(failed?.delivery_state).toBe("failed");
    expect(JSON.parse(failed?.error_json ?? "null")).toMatchObject({ code: "archive_expired", retryable: false });

    for (const state of ["unknown", "sending"] as const) {
      const operation = await admit(input("download"));
      await db.prepare("UPDATE integration_archives SET delivery_state = ?1 WHERE id = ?2 AND account_id = ?3")
        .bind(state, operation.archive_id, account.accountId).run();
      await db.prepare("UPDATE integration_operations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1 AND account_id = ?2")
        .bind(operation.id, account.accountId).run();
      await cleanupIntegrationMedia(env);
      expect((await integrationArchiveFor(db, operation))?.delivery_state).toBe("unknown");
    }
  });
});

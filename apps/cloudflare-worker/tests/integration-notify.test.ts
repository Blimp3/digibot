import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { integrationAccountForTelegram } from "../src/integration-auth";
import { checkVerdictText, processIntegrationOperation, type IntegrationEnv, type IntegrationStep, type IntegrationWorkflowParams } from "../src/integration-media";
import {
  attachIntegrationMedia, getIntegrationOperation, hashIntegrationBytes, integrationArchiveFor, registerIntegrationOperation,
  type IntegrationAccount, type IntegrationInput, type IntegrationOperation, type IntegrationSavedCopy,
} from "../src/integration-store";
import type { IntegrationVerifierResult } from "../src/integration-verifier";
import type { D1BatchDatabaseLike } from "../src/types";
import { testFixedLengthStream } from "./helpers/fixed-length-stream";
import { localD1 } from "./helpers/local-d1";

const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const NOT_PROOF = "No supported signal is not proof of human origin.";
const evidence = (JSON.parse(readFileSync(new URL("./fixtures/integration-envelope-v1.json", import.meta.url), "utf8")) as {
  result: { evidence: IntegrationVerifierResult };
}).result.evidence;
const step: IntegrationStep = { do: async (_name, _options, callback) => callback() };

let db: D1BatchDatabaseLike;
let dispose: () => Promise<void>;
let env: IntegrationEnv;
let account: IntegrationAccount;
let objects: Map<string, Uint8Array>;
let telegramCalls: Array<{ path: string; body: unknown }>;
let verifierStatus: number;
let sendMessageStatus: number;

function input(inputKind: IntegrationInput["media"]["inputKind"] = "original"): IntegrationInput {
  return { version: 1, operationId: crypto.randomUUID(), action: "check", forceRecheck: false, media: {
    mediaSha256: hashIntegrationBytes(BYTES), byteLength: BYTES.byteLength, mimeType: "image/png", inputKind,
    audioDurationSeconds: null, segment: null, fullSourceSha256: null,
  } };
}

async function admit(value = input(), saved?: IntegrationSavedCopy): Promise<IntegrationOperation> {
  const operation = await registerIntegrationOperation(db, account, { input: value }, new Date().toISOString());
  const key = `integration/${account.accountId}/${operation.id}/telegram-image`;
  objects.set(key, BYTES.slice());
  await attachIntegrationMedia(db, operation, value, key, new Date(), saved);
  return (await getIntegrationOperation(db, account.accountId, operation.id))!;
}

async function run(operation: IntegrationOperation, replyToMessageId?: number): Promise<IntegrationOperation> {
  const params: IntegrationWorkflowParams = { accountId: operation.account_id, operationId: operation.id, generation: operation.run_generation };
  await processIntegrationOperation(env, replyToMessageId === undefined ? params : { ...params, replyToMessageId }, step);
  return (await getIntegrationOperation(db, account.accountId, operation.id))!;
}

function paths(): string[] {
  return telegramCalls.map((call) => call.path);
}

beforeAll(async () => { ({ db, dispose } = await localD1()); });
afterAll(async () => { await dispose(); vi.unstubAllGlobals(); });

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM integration_operations"), db.prepare("DELETE FROM integration_archives"),
    db.prepare("DELETE FROM integration_media"), db.prepare("DELETE FROM integration_accounts"),
  ]);
  objects = new Map(); telegramCalls = []; verifierStatus = 200; sendMessageStatus = 200; testFixedLengthStream();
  env = {
    DB: db, INTEGRATION_ENABLED: "true", TELEGRAM_BOT_TOKEN: "123456:test", ALLOWED_TELEGRAM_USER_IDS: "12345,67890",
    PUBLIC_WORKER_BASE_URL: "https://gateway.example", TELEGRAM_BOT_API_BASE: "https://api.telegram.org", MAX_TELEGRAM_BYTES: "49000000",
    MEDIA_BUCKET: {
      get: async (key: string) => objects.has(key) ? { body: new Blob([objects.get(key)! as Uint8Array<ArrayBuffer>]).stream() } : null,
      put: async () => undefined,
      delete: async (key: string) => { objects.delete(key); },
      list: async () => ({ objects: [], truncated: false }),
    },
    PROVENANCE_VERIFIER: { fetch: async () => verifierStatus === 200
      ? Response.json({ result: evidence, cache: null })
      : new Response("unavailable", { status: verifierStatus }) },
  } as unknown as IntegrationEnv;
  account = (await integrationAccountForTelegram(env, { telegramUserId: "12345", privateChatId: "12345" }))!;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.body instanceof ReadableStream) await new Response(init.body).arrayBuffer();
    const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
    telegramCalls.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    if (path.endsWith("/sendMessage")) {
      return sendMessageStatus === 200
        ? Response.json({ ok: true, result: { message_id: 77, chat: { id: 12345, type: "private" } } })
        : Response.json({ ok: false, error_code: sendMessageStatus, description: "rejected" }, { status: sendMessageStatus });
    }
    if (path.endsWith("/sendDocument")) return Response.json({ ok: true, result: { message_id: 42, chat: { id: 12345, type: "private" }, document: { file_id: "saved-file" } } });
    if (path.endsWith("/getFile")) return Response.json({ ok: true, result: { file_id: "saved-file", file_path: "documents/saved.png", file_size: BYTES.length } });
    if (path.endsWith("/saved.png")) return new Response(BYTES);
    throw new Error(`Unexpected network access: ${path}`);
  }));
});

describe("Telegram verdict reply for checks started in Telegram", () => {
  it("replies the verdict under the image once, before the archive copy is sent", async () => {
    const operation = await run(await admit(), 700);
    expect(operation.status).toBe("completed");
    expect(operation.result_json).not.toBeNull();
    expect(paths().filter((path) => path.endsWith("/sendMessage"))).toHaveLength(1);
    expect(paths().findIndex((path) => path.endsWith("/sendMessage"))).toBeLessThan(paths().findIndex((path) => path.endsWith("/sendDocument")));
    const reply = telegramCalls.find((call) => call.path.endsWith("/sendMessage"))?.body as { chat_id: string; text: string; reply_parameters: unknown };
    expect(reply).toMatchObject({ chat_id: "12345", reply_parameters: { message_id: 700, allow_sending_without_reply: true } });
    expect(reply.text).toBe(["No supported signal detected", evidence.summary, "C2PA status: not_present", NOT_PROOF].join("\n"));
    expect((await integrationArchiveFor(db, operation))?.delivery_state).toBe("confirmed");
  });

  it("replies the verdict but sends no document when the checked image is already the saved copy", async () => {
    const saved: IntegrationSavedCopy = { botId: "123456", chatId: "12345", messageId: "700", fileId: "incoming-image" };
    const operation = await run(await admit(input(), saved), 700);
    expect(operation).toMatchObject({ status: "completed", temp_key: null, reserved_bytes: 0 });
    expect(operation.result_json).not.toBeNull();
    expect(paths()).toEqual([expect.stringMatching(/\/sendMessage$/u)]);
    expect(telegramCalls[0]?.body).toMatchObject({ chat_id: "12345", reply_parameters: { message_id: 700, allow_sending_without_reply: true } });
    expect(await integrationArchiveFor(db, operation)).toMatchObject({
      delivery_state: "confirmed", integrity_state: "verified", round_trip_sha256: hashIntegrationBytes(BYTES), receipt_json: JSON.stringify({ ...saved, sender: "user" }),
    });
    expect(objects.size).toBe(0);
  });

  it("sends no reply when the check was not started in Telegram", async () => {
    const operation = await run(await admit());
    expect(operation.status).toBe("completed");
    expect(paths().some((path) => path.endsWith("/sendMessage"))).toBe(false);
    expect(paths().filter((path) => path.endsWith("/sendDocument"))).toHaveLength(1);
  });

  it("still completes the check and its archive when Telegram rejects the reply", async () => {
    sendMessageStatus = 500;
    const operation = await run(await admit(), 700);
    expect(operation.status).toBe("completed");
    expect(operation.result_json).not.toBeNull();
    expect(paths().filter((path) => path.endsWith("/sendMessage"))).toHaveLength(1);
    expect((await integrationArchiveFor(db, operation))?.delivery_state).toBe("confirmed");
  });

  it("reuses the notify checkpoint when recovery restarts the run from save evidence", async () => {
    const operation = await admit();
    const checkpoints = new Map<string, unknown>();
    let interruptWrite = true;
    const checkpoint: IntegrationStep = { do: async <T>(name: string, _options: unknown, callback: () => Promise<T>): Promise<T> => {
      if (checkpoints.has(name)) return checkpoints.get(name) as T;
      if (name === "save evidence" && interruptWrite) { interruptWrite = false; throw new Error("D1 unavailable"); }
      const result = await callback(); checkpoints.set(name, result); return result;
    } };
    const params: IntegrationWorkflowParams = { accountId: operation.account_id, operationId: operation.id, generation: operation.run_generation, replyToMessageId: 700 };
    await expect(processIntegrationOperation(env, params, checkpoint)).rejects.toThrow("D1 unavailable");
    expect(paths().filter((path) => path.endsWith("/sendMessage"))).toHaveLength(1);
    expect(checkpoints.has("notify telegram")).toBe(true);

    await processIntegrationOperation(env, params, checkpoint);
    expect((await getIntegrationOperation(db, account.accountId, operation.id))?.status).toBe("completed");
    expect(paths().filter((path) => path.endsWith("/sendMessage"))).toHaveLength(1);
    expect(paths().filter((path) => path.endsWith("/sendDocument"))).toHaveLength(1);
  });

  it("replies the processing error under the image when verification fails", async () => {
    verifierStatus = 503;
    const operation = await run(await admit(input("telegram_photo_copy")), 701);
    expect(operation.status).toBe("failed");
    const reply = telegramCalls.find((call) => call.path.endsWith("/sendMessage"))?.body as { text: string; reply_parameters: { message_id: number } };
    expect(reply.reply_parameters.message_id).toBe(701);
    expect(reply.text.split("\n")).toEqual([
      "Check failed: Verification failed. Saving the original image continues independently.",
      expect.stringMatching(/^This checked a Telegram photo copy: .*send the image as a File/iu),
      NOT_PROOF,
    ]);
  });
});

describe("checkVerdictText", () => {
  const detected: IntegrationVerifierResult = {
    ...evidence, verdict: "openai_signal_detected", summary: "A supported provenance signal was detected.",
    contentCredentials: { ...evidence.contentCredentials!, status: "verified", signatureValid: true, contentBindingValid: true, signerTrusted: true, issuer: "Truepic" },
  };

  it("covers detected, no-signal, indeterminate, photo copy and error replies", () => {
    expect(checkVerdictText({ evidence: detected }, "original").split("\n")).toEqual([
      "Supported signal detected", "A supported provenance signal was detected.", "C2PA status: verified; signer trusted by the pinned list; issuer: Truepic", NOT_PROOF,
    ]);
    expect(checkVerdictText({ evidence }, "original").split("\n")).toEqual([
      "No supported signal detected", evidence.summary, "C2PA status: not_present", NOT_PROOF,
    ]);
    const withoutCredentials: IntegrationVerifierResult = { ...evidence, verdict: "indeterminate", summary: "" };
    delete withoutCredentials.contentCredentials;
    expect(checkVerdictText({ evidence: withoutCredentials }, "original").split("\n")).toEqual([
      "Evidence is indeterminate", "No evidence summary available.", NOT_PROOF,
    ]);
    const photo = checkVerdictText({ evidence }, "telegram_photo_copy").split("\n");
    expect(photo).toHaveLength(5);
    expect(photo[3]).toMatch(/Telegram recompresses photos and strips Content Credentials/u);
    expect(photo[4]).toBe(NOT_PROOF);
    expect(checkVerdictText({ code: "verification_failed", message: "Verification failed.", retryable: true }, "original").split("\n")).toEqual([
      "Check failed: Verification failed.", NOT_PROOF,
    ]);
  });

  it("names the issuer only when the pinned trust list vouches for the signer", () => {
    // A self-signed manifest can claim any issuer, and Telegram auto-links URLs, @mentions and /commands.
    const claimed = "https://evil.example/@digibot /start";
    const untrusted = checkVerdictText({ evidence: { ...detected,
      contentCredentials: { ...detected.contentCredentials!, signerTrusted: false, issuer: claimed } } }, "original");
    expect(untrusted.split("\n")[2]).toBe("C2PA status: verified (signer not trusted by the pinned list)");
    expect(untrusted).not.toContain(claimed);
    expect(untrusted).not.toContain("evil.example");
    const trustedWithoutName = checkVerdictText({ evidence: { ...detected,
      contentCredentials: { ...detected.contentCredentials!, issuer: null } } }, "original");
    expect(trustedWithoutName.split("\n")[2]).toBe("C2PA status: verified; signer trusted by the pinned list");
    const invalid = checkVerdictText({ evidence: { ...evidence,
      contentCredentials: { ...evidence.contentCredentials!, status: "invalid", issuer: claimed } } }, "original");
    expect(invalid.split("\n")[2]).toBe("C2PA status: invalid");
  });

  it("uses the Mini App's verdict labels", () => {
    const source = readFileSync(new URL("../src/mini-app.ts", import.meta.url), "utf8");
    const literal = source.match(/var integrationVerdictLabels = (\{[^}]*\});/u)?.[1];
    const labels = JSON.parse(literal!.replace(/(\w+):/gu, "\"$1\":")) as Record<string, string>;
    expect(Object.keys(labels).sort()).toEqual(["indeterminate", "no_supported_openai_signal", "openai_signal_detected"]);
    for (const [verdict, label] of Object.entries(labels)) {
      expect(checkVerdictText({ evidence: { ...evidence, verdict: verdict as IntegrationVerifierResult["verdict"] } }, "original").split("\n")[0]).toBe(label);
    }
  });
});

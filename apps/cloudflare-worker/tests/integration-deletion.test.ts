import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { integrationAccountForTelegram } from "../src/integration-auth";
import { deleteIntegrationHistory } from "../src/integration";
import { processIntegrationOperation, type IntegrationEnv, type IntegrationStep } from "../src/integration-media";
import {
  attachIntegrationMedia,
  getIntegrationOperation,
  hashIntegrationBytes,
  integrationArchiveFor,
  registerIntegrationOperation,
  type IntegrationAccount,
  type IntegrationInput,
  type IntegrationOperation,
} from "../src/integration-store";
import type { D1BatchDatabaseLike } from "../src/types";
import { localD1 } from "./helpers/local-d1";

const telegram = vi.hoisted(() => ({
  sendDocumentStream: vi.fn(),
  downloadFile: vi.fn(),
}));

vi.mock("../src/telegram", () => {
  class TelegramApiError extends Error {
    readonly outcome = "ambiguous";
  }
  return {
    TelegramApiError,
    TelegramClient: class {
      readonly sendDocumentStream = telegram.sendDocumentStream;
      readonly downloadFile = telegram.downloadFile;
    },
  };
});

const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const step: IntegrationStep = { do: async (_name, _options, callback) => callback() };
let db: D1BatchDatabaseLike;
let dispose: () => Promise<void>;
let env: IntegrationEnv;
let account: IntegrationAccount;
let objects: Map<string, Uint8Array>;

function input(action: "check" | "download" = "download"): IntegrationInput {
  return {
    version: 1,
    operationId: crypto.randomUUID(),
    action,
    forceRecheck: false,
    media: {
      mediaSha256: hashIntegrationBytes(BYTES),
      byteLength: BYTES.byteLength,
      mimeType: "image/png",
      inputKind: "original",
      audioDurationSeconds: null,
      segment: null,
      fullSourceSha256: null,
    },
  };
}

async function admit(value = input()): Promise<IntegrationOperation> {
  const operation = await registerIntegrationOperation(db, account, { input: value }, new Date().toISOString());
  const key = `integration/${account.accountId}/${operation.id}/test`;
  objects.set(key, BYTES.slice());
  await attachIntegrationMedia(db, operation, value, key);
  const admitted = await getIntegrationOperation(db, account.accountId, operation.id);
  if (!admitted) throw new Error("Expected admitted operation");
  return admitted;
}

async function run(operation: IntegrationOperation): Promise<void> {
  await processIntegrationOperation(env, {
    accountId: operation.account_id,
    operationId: operation.id,
    generation: operation.run_generation,
  }, step);
}

beforeAll(async () => { ({ db, dispose } = await localD1()); });
afterAll(async () => dispose());

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM integration_operations"),
    db.prepare("DELETE FROM integration_archives"),
    db.prepare("DELETE FROM integration_media"),
    db.prepare("DELETE FROM integration_accounts"),
  ]);
  objects = new Map();
  telegram.sendDocumentStream.mockReset();
  telegram.downloadFile.mockReset();
  telegram.sendDocumentStream.mockResolvedValue({ messageId: "42", fileId: "saved-file" });
  telegram.downloadFile.mockResolvedValue(BYTES.slice());
  env = {
    DB: db,
    INTEGRATION_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "123456:test",
    ALLOWED_TELEGRAM_USER_IDS: "12345,67890",
    PUBLIC_WORKER_BASE_URL: "https://gateway.example",
    TELEGRAM_BOT_API_BASE: "https://api.telegram.org",
    MAX_TELEGRAM_BYTES: "49000000",
    MEDIA_BUCKET: {
      get: async (key: string) => {
        const value = objects.get(key);
        return value ? { body: new Blob([new Uint8Array(value).buffer]).stream() } : null;
      },
      put: async () => undefined,
      delete: async (key: string) => { objects.delete(key); },
      list: async () => ({ objects: [], truncated: false }),
    },
  } as unknown as IntegrationEnv;
  const admitted = await integrationAccountForTelegram(env, { telegramUserId: "12345", privateChatId: "12345" });
  if (!admitted) throw new Error("Expected integration account");
  account = admitted;
});

describe("integration History deletion", () => {
  it("atomically cancels an orphaned pending archive and releases its retained input", async () => {
    const operation = await admit();
    await deleteIntegrationHistory(env, account, [operation]);

    const deleted = await getIntegrationOperation(db, account.accountId, operation.id);
    expect(deleted).toMatchObject({ input_json: null, result_json: null, temp_key: null, reserved_bytes: 0 });
    expect(deleted?.deleted_at).not.toBeNull();
    expect(await integrationArchiveFor(db, operation)).toMatchObject({
      delivery_state: "failed",
      receipt_json: null,
      error_json: expect.stringContaining("archive_canceled"),
    });
    expect(objects.size).toBe(0);
  });

  it.each(["sending", "unknown"] as const)("blocks deletion while an orphaned archive is %s", async (state) => {
    const operation = await admit();
    await db.prepare("UPDATE integration_archives SET delivery_state = ?1 WHERE id = ?2 AND account_id = ?3")
      .bind(state, operation.archive_id, account.accountId).run();

    await expect(deleteIntegrationHistory(env, account, [operation])).rejects.toMatchObject({
      status: 409,
      code: "archive_reconciliation_required",
    });
    expect((await getIntegrationOperation(db, account.accountId, operation.id))?.deleted_at).toBeNull();
    expect((await integrationArchiveFor(db, operation))?.delivery_state).toBe(state);
    expect(objects.size).toBe(1);
  });

  it("cannot acknowledge deletion during send, then allows it after the receipt is durable", async () => {
    const operation = await admit();
    let release!: () => void;
    let started!: () => void;
    const sending = new Promise<void>((resolve) => { started = resolve; });
    telegram.sendDocumentStream.mockImplementation(async () => {
      started();
      await new Promise<void>((resolve) => { release = resolve; });
      return { messageId: "42", fileId: "saved-file" };
    });

    const running = run(operation);
    await sending;
    await expect(deleteIntegrationHistory(env, account, [operation])).rejects.toMatchObject({
      code: "archive_reconciliation_required",
    });
    release();
    await running;
    expect(await integrationArchiveFor(db, operation)).toMatchObject({
      delivery_state: "confirmed",
      receipt_json: expect.stringContaining('"messageId":"42"'),
    });

    await deleteIntegrationHistory(env, account, [operation]);
    expect((await getIntegrationOperation(db, account.accountId, operation.id))?.deleted_at).not.toBeNull();
  });

  it("preserves a known send receipt when the account is revoked mid-send and stops follow-up access", async () => {
    const operation = await admit();
    let release!: () => void;
    let started!: () => void;
    const sending = new Promise<void>((resolve) => { started = resolve; });
    telegram.sendDocumentStream.mockImplementation(async () => {
      started();
      await new Promise<void>((resolve) => { release = resolve; });
      return { messageId: "84", fileId: "revoked-file" };
    });

    const running = run(operation);
    await sending;
    await db.prepare("UPDATE integration_accounts SET status = 'revoked', revoked_at = ?1 WHERE id = ?2")
      .bind(Math.floor(Date.now() / 1000), account.accountId).run();
    release();
    await running;

    expect(await integrationArchiveFor(db, operation)).toMatchObject({
      delivery_state: "confirmed",
      receipt_json: expect.stringContaining('"fileId":"revoked-file"'),
      integrity_state: "not_checked",
    });
    expect(telegram.downloadFile).not.toHaveBeenCalled();
    await expect(integrationAccountForTelegram(env, {
      telegramUserId: account.telegramUserId,
      privateChatId: account.chatId,
    })).resolves.toBeNull();
  });
});

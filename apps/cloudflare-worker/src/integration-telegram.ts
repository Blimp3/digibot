import { getWorkerConfig } from "./config";
import {
  admitIntegrationInvite,
  approveIntegrationPairing,
  createIntegrationInvitation,
  getIntegrationPairingSummary,
  integrationAccountForTelegram,
  revokeIntegrationInvitation,
  type IntegrationTelegramAccount,
} from "./integration-auth";
import {
  TELEGRAM_PHOTO_CAVEAT,
  dispatchIntegrationOperation,
  integrationImageMime,
  validateIntegrationCheck,
  type IntegrationEnv,
} from "./integration-media";
import {
  INTEGRATION_CHECK_BYTES,
  INTEGRATION_TEMP_MS,
  IntegrationFailure,
  attachIntegrationMedia,
  getIntegrationOperation,
  hashIntegrationBytes,
  integrationArchiveFor,
  registerIntegrationOperation,
  type IntegrationInput,
  type IntegrationOperation,
} from "./integration-store";
import { integrationHistory, integrationStats, retryIntegrationOperation } from "./integration";
import { TelegramApiError, TelegramClient } from "./telegram";
import type { TelegramInlineKeyboardButton, TelegramMessage, TelegramUpdate } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const INVITATION_TOKEN = /^inv_[A-Za-z0-9_-]{43}$/u;
const START_COMMAND = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/iu;
const LINK_COMMAND = /^\/link(?:@[A-Za-z0-9_]+)?(?:\s+([0-9a-f-]{36}))?$/iu;
const INVITE_COMMAND = /^\/invite(?:@[A-Za-z0-9_]+)?$/iu;
const REVOKE_INVITE_COMMAND = /^\/revokeinvite(?:@[A-Za-z0-9_]+)?\s+([0-9a-f-]{36})$/iu;
const CHECK_COMMAND = /^\/check(?:@[A-Za-z0-9_]+)?$/iu;
const HISTORY_COMMAND = /^\/history(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?$/iu;
const STATS_COMMAND = /^\/checkstats(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?$/iu;
const RETRY_COMMAND = /^\/checkretry(?:@[A-Za-z0-9_]+)?\s+([0-9a-f-]{36})$/iu;
const RECONCILE_COMMAND = /^\/reconcile(?:@[A-Za-z0-9_]+)?\s+([0-9a-f-]{36})$/iu;
const APPROVE_CALLBACK = /^ia:approve:([0-9a-f-]{36}):(\d{6})$/iu;
const TELEGRAM_FILE_ID = /^[A-Za-z0-9_-]{1,512}$/u;
const CALLBACK_ID = /^[\s\S]{1,128}$/u;
const CHECK_CALLBACK = "ic:check";
const CHECK_BUTTON: TelegramInlineKeyboardButton = { text: "Check this image", callback_data: CHECK_CALLBACK };
const CHECK_FALLBACK_TOAST = "Reply to the image with /check";

const CHECK_DISCLOSURE = "This provenance check sends the selected bytes to the configured provider for processing under its retention terms; this provider path is not eligible for Zero Data Retention. It reports provenance evidence only and does not establish whether content is AI-generated, a deepfake, or human-made.";
const HELP_TEXT = `Use /link UUID to connect Lens, /checkstats [24h|7d|30d|all] for shared statistics, /history for recent checks, or send a PNG, JPEG, or WebP (up to 4 MiB; HEIC is not supported) and tap "Check this image" under it or reply to it with /check; the verdict is replied under the image. ${TELEGRAM_PHOTO_CAVEAT} ${CHECK_DISCLOSURE} A Telegram document is labeled with the exact bytes received; a Telegram photo is labeled Telegram photo copy.`;

export type IntegrationTelegramWaitUntil = (promise: Promise<unknown>) => void;

function checkPromptText(photo: boolean): string {
  return `Tap "Check this image", or reply to this image with /check, to run a provenance check. The image you sent stays in this chat as the saved copy; no copy of it is sent back. PNG, JPEG, or WebP up to 4 MiB; HEIC is not supported.${photo ? ` ${TELEGRAM_PHOTO_CAVEAT}` : ""} ${CHECK_DISCLOSURE}`;
}

type PrivateIdentity = Readonly<{ telegramUserId: string; privateChatId: string }>;

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function telegramNumericId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d{0,19}$/u.test(value)) return value;
  return null;
}

function privateIdentity(message: TelegramMessage): PrivateIdentity | null {
  if (message.chat?.type !== "private") return null;
  const telegramUserId = telegramNumericId(message.from?.id);
  const privateChatId = telegramNumericId(message.chat.id);
  if (!telegramUserId || !privateChatId || telegramUserId !== privateChatId) return null;
  return { telegramUserId, privateChatId };
}

function privateChat(message: TelegramMessage): string | null {
  if (message.chat?.type !== "private") return null;
  return telegramNumericId(message.chat.id);
}

function callbackRecord(update: TelegramUpdate): Record<string, unknown> | null {
  if (typeof update.callback_query !== "object" || update.callback_query === null || Array.isArray(update.callback_query)) return null;
  return update.callback_query as Record<string, unknown>;
}

function textOfMessage(message: TelegramMessage): string {
  return typeof message.text === "string" ? message.text.trim() : "";
}

function bot(env: IntegrationEnv, requestTimeoutMs = 15_000): TelegramClient {
  return new TelegramClient({ token: env.TELEGRAM_BOT_TOKEN, apiBase: getWorkerConfig(env).telegramApiBase, requestTimeoutMs });
}

// Keyed on the Telegram update that asked, or on the prompt a tap answers ("ic:<message_id>"), so a
// redelivered update and every tap on one prompt map to the same operation.
function deterministicUUID(accountId: string, key: number | string): string {
  const hash = hashIntegrationBytes(`${accountId}\0${key}`);
  const variant = ((Number.parseInt(hash[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export { deterministicUUID };

function validUUID(value: string | undefined): value is string {
  return value !== undefined && UUID.test(value);
}

function callbackMessage(value: unknown): TelegramMessage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as TelegramMessage;
  return privateChat(candidate) && Number.isSafeInteger(candidate.message_id) && candidate.message_id > 0 ? candidate : null;
}

function accountForMessage(env: IntegrationEnv, message: TelegramMessage, nowSeconds: number): Promise<IntegrationTelegramAccount | null> {
  const identity = privateIdentity(message);
  return identity ? integrationAccountForTelegram(env, identity, nowSeconds) : Promise.resolve(null);
}

function sendWork(
  promise: Promise<unknown>,
  waitUntil?: IntegrationTelegramWaitUntil,
): Promise<void> {
  if (waitUntil) {
    waitUntil(promise);
    return Promise.resolve();
  }
  return promise.then(() => undefined);
}

async function sendText(
  env: IntegrationEnv,
  chatId: string,
  text: string,
  waitUntil?: IntegrationTelegramWaitUntil,
  replyMarkup?: { inline_keyboard: TelegramInlineKeyboardButton[][] },
  replyToMessageId?: number,
): Promise<void> {
  await sendWork(bot(env).sendMessage(chatId, text, replyMarkup, replyToMessageId), waitUntil);
}

function safeNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function historyText(value: Awaited<ReturnType<typeof integrationHistory>>): string {
  if (!value.operations.length) return "No integration actions in the selected period.";
  return "Latest actions. Open shared History for full evidence and older actions.\n\n" + value.operations.slice(0, 5).map((operation) => {
    const archive = operation.archive as { deliveryState?: unknown; integrityState?: unknown };
    const media = operation.mediaSha256 ? ` ${String(operation.mediaSha256).slice(0, 12)}` : "";
    const result = operation.envelope?.result as { cacheSource: string; originallyCheckedAt: string; evidence: { summary: string } } | null | undefined;
    const scope = operation.envelope?.media.inputKind ?? "pending input";
    const segment = operation.segment ? `; audio ${operation.segment.startSeconds}–${operation.segment.endSeconds}s only` : "";
    const evidence = result ? `\n${result.evidence.summary.slice(0, 200)}\n${result.cacheSource}; checked ${result.originallyCheckedAt}` : "";
    return `${operation.action === "check" ? "Check" : "Download"} ${operation.operationId}${media}\n${scope}${segment}\nState: ${operation.state}; archive: ${String(archive.deliveryState ?? "not_required")}; integrity: ${String(archive.integrityState ?? "not_checked")}${evidence}`;
  }).join("\n\n") + "\n\nNo supported signal is not proof of human origin.";
}

function statsText(value: Awaited<ReturnType<typeof integrationStats>>): string {
  return [
    `Check statistics (${value.period})`,
    `Checks requested: ${safeNumber(value.checksRequested)}`,
    `Checks completed: ${safeNumber(value.checksCompleted)}`,
    `Checks failed: ${safeNumber(value.checksFailed)}`,
    `Fresh checks: ${safeNumber(value.freshChecks)}`,
    `Cached checks: ${safeNumber(value.cachedChecks)}`,
    `Downloads: ${safeNumber(value.downloadsRequested)} (${safeNumber(value.downloadsConfirmed)} confirmed)`,
    `Legacy downloads: ${safeNumber(value.legacyDownloads)}`,
    `Unique media: ${safeNumber(value.uniqueMedia)}`,
  ].join("\n");
}

function operationSnapshotText(value: { action: "check" | "download"; operationId: string; state: string }): string {
  return `${value.action === "check" ? "Check" : "Download"} ${value.operationId} is ${value.state}.`;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof IntegrationFailure ? error.message : fallback;
}

function fileId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as { file_id?: unknown };
  return typeof candidate.file_id === "string" && TELEGRAM_FILE_ID.test(candidate.file_id) ? candidate.file_id : null;
}

function imageReply(message: TelegramMessage): Readonly<{ fileId: string; inputKind: "original" | "telegram_photo_copy"; replyToMessageId: number }> | null {
  const reply = message.reply_to_message;
  if (!reply || !privateChat(reply) || privateChat(reply) !== privateChat(message)
    || !Number.isSafeInteger(reply.message_id) || reply.message_id <= 0) return null;
  const replyToMessageId = reply.message_id;
  if (reply.document !== undefined && reply.photo === undefined) {
    const id = fileId(reply.document);
    return id ? { fileId: id, inputKind: "original", replyToMessageId } : null;
  }
  if (reply.photo !== undefined && reply.document === undefined && Array.isArray(reply.photo)) {
    const candidates = reply.photo.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item) && fileId(item) !== null);
    const selected = candidates.reduce<Record<string, unknown> | null>((current, candidate) => {
      if (!current) return candidate;
      const currentSize = safeNumber(current.file_size) || safeNumber(current.width) * safeNumber(current.height);
      const candidateSize = safeNumber(candidate.file_size) || safeNumber(candidate.width) * safeNumber(candidate.height);
      return candidateSize >= currentSize ? candidate : current;
    }, null);
    const id = fileId(selected);
    return id ? { fileId: id, inputKind: "telegram_photo_copy", replyToMessageId } : null;
  }
  return null;
}

function operationFailure(error: unknown): { code: string; message: string; retryable: boolean } {
  return error instanceof IntegrationFailure
    ? { code: error.code, message: error.message, retryable: error.retryable }
    : { code: "telegram_check_failed", message: "The image could not be checked. Reply to the exact image and try again.", retryable: true };
}

function operationCreatedAt(message: TelegramMessage): string {
  const timestamp = typeof message.date === "number" && Number.isSafeInteger(message.date) && message.date > 0
    ? message.date * 1000
    : Math.floor(Date.now() / 1000) * 1000;
  return new Date(timestamp).toISOString();
}

async function claimOperationAdmission(env: IntegrationEnv, operation: IntegrationOperation): Promise<string | null> {
  const token = crypto.randomUUID();
  const claimed = await env.DB.prepare(`UPDATE integration_operations SET upload_token = ?1, upload_started_at = ?2
    WHERE id = ?3 AND account_id = ?4 AND status = 'awaiting_upload' AND deleted_at IS NULL AND upload_token IS NULL`)
    .bind(token, new Date().toISOString(), operation.id, operation.account_id).run();
  return claimed.meta?.changes === 1 ? token : null;
}

/**
 * A failed admission releases its reservation at once when nothing is retained: no temp_key and no R2 object left
 * behind. Otherwise the slot (one of four) and its bytes would be held for 24 hours until the scheduled sweep.
 * An object R2 would not delete is recorded as temp_key, so the sweep removes it and the reservation holds until
 * then; bytes attached before the failure keep theirs for a controlled retry.
 */
async function markOperationFailed(env: IntegrationEnv, operation: IntegrationOperation, error: unknown, claimToken: string | null, orphanKey: string | null = null): Promise<void> {
  const failure = operationFailure(error);
  await env.DB.prepare(`UPDATE integration_operations SET status = 'failed', error_json = ?1, updated_at = ?2,
    upload_token = NULL, upload_started_at = NULL, temp_key = COALESCE(temp_key, ?6),
    reserved_bytes = CASE WHEN temp_key IS NULL AND ?6 IS NULL THEN 0 ELSE reserved_bytes END
    WHERE id = ?3 AND account_id = ?4 AND status IN ('awaiting_upload', 'queued') AND deleted_at IS NULL
      AND (?5 IS NULL OR upload_token = ?5)`)
    .bind(JSON.stringify(failure), new Date().toISOString(), operation.id, operation.account_id, claimToken, orphanKey).run();
}

async function releaseOperationAdmission(env: IntegrationEnv, operation: IntegrationOperation, claimToken: string): Promise<void> {
  await env.DB.prepare(`UPDATE integration_operations SET upload_token = NULL, upload_started_at = NULL
    WHERE id = ?1 AND account_id = ?2 AND upload_token = ?3`)
    .bind(operation.id, operation.account_id, claimToken).run();
}

async function handleImageCheck(
  update: TelegramUpdate,
  env: IntegrationEnv,
  account: IntegrationTelegramAccount,
  message: TelegramMessage,
  waitUntil?: IntegrationTelegramWaitUntil,
  operationId = deterministicUUID(account.accountId, update.update_id),
): Promise<Record<string, unknown>> {
  const selected = imageReply(message);
  if (!selected) {
    await sendText(env, account.chatId, `Reply to one PNG, JPEG, or WebP document or photo with /check. Captions alone do not start a check. ${CHECK_DISCLOSURE}`, waitUntil);
    return { ok: true, accepted: false, error: "INVALID_MEDIA" };
  }

  const existing = await getIntegrationOperation(env.DB, account.accountId, operationId);
  if (existing) {
    if (existing.deleted_at !== null) {
      await sendText(env, account.chatId, "That action was deleted. Reply to the image again with /check to start a new action.", waitUntil);
      return { ok: true, accepted: false, error: "OPERATION_DELETED" };
    }
    return { ok: true, duplicate: true, operationId };
  }

  const client = bot(env, 30_000);
  let bytes: Uint8Array;
  try {
    bytes = await client.downloadFile(selected.fileId, INTEGRATION_CHECK_BYTES);
  } catch {
    await sendText(env, account.chatId, "That image could not be retrieved or is larger than 4 MiB. Reply to the exact PNG, JPEG, or WebP and try again.", waitUntil);
    return { ok: true, accepted: false, error: "INVALID_MEDIA" };
  }

  const mediaSha256 = hashIntegrationBytes(bytes);
  const mimeType = integrationImageMime(bytes);
  if (!mimeType) {
    bytes.fill(0);
    await sendText(env, account.chatId, "The received bytes are not a PNG, JPEG, or WebP image.", waitUntil);
    return { ok: true, accepted: false, error: "UNSUPPORTED_MEDIA" };
  }

  const input: IntegrationInput = {
    version: 1,
    operationId,
    action: "check",
    forceRecheck: false,
    media: {
      mediaSha256,
      byteLength: bytes.byteLength,
      mimeType,
      inputKind: selected.inputKind,
      audioDurationSeconds: null,
      segment: null,
      fullSourceSha256: null,
    },
  };
  let operation: IntegrationOperation;
  try {
    operation = await registerIntegrationOperation(env.DB, account, { input }, operationCreatedAt(message));
  } catch (error) {
    bytes.fill(0);
    await sendText(env, account.chatId, errorText(error, "This image check could not be admitted."), waitUntil);
    return { ok: true, accepted: false, error: "INVALID_REQUEST" };
  }

  const claimToken = await claimOperationAdmission(env, operation);
  if (!claimToken) {
    bytes.fill(0);
    return { ok: true, duplicate: true, operationId };
  }

  // The R2 key this admission may hold without D1 tracking it yet: set before the put, which is ambiguous when it
  // throws, and cleared once attachIntegrationMedia has recorded it as temp_key.
  let stored: string | null = null;
  try {
    const validated = await validateIntegrationCheck(env, account.accountId, input, bytes);
    const key = `integration/${account.accountId}/${operation.id}/telegram-image`;
    stored = key;
    await env.MEDIA_BUCKET.put(key, bytes, {
      httpMetadata: { contentType: validated.media.mimeType, cacheControl: "no-store" },
      customMetadata: { mediaSha256: validated.media.mediaSha256, inputKind: validated.media.inputKind },
    });
    // The image message the user sent is the saved copy: getFile already returned these exact bytes and they were
    // hashed above, so the archive is confirmed and verified at once and no copy of the image is sent back; a row a
    // concurrent Lens Check is already sending is left alone (the retry edge is noted in retryIntegrationOperation).
    const saved = { botId: env.TELEGRAM_BOT_TOKEN.split(":", 1)[0] ?? "", chatId: account.chatId, messageId: String(selected.replyToMessageId), fileId: selected.fileId };
    await attachIntegrationMedia(env.DB, operation, validated, key, new Date(), saved);
    stored = null;
    const admitted = await getIntegrationOperation(env.DB, account.accountId, operation.id);
    if (!admitted) throw new IntegrationFailure(503, "operation_unavailable", "The image check could not be admitted.", true);
    // The verdict is replied under the checked image; Lens-started checks never set this.
    const dispatch = dispatchIntegrationOperation(env, admitted, selected.replyToMessageId);
    await sendWork(dispatch, waitUntil);
    await releaseOperationAdmission(env, operation, claimToken);
    const inputLabel = selected.inputKind === "telegram_photo_copy" ? "Telegram photo copy" : "exact Telegram document bytes";
    await sendText(env, account.chatId, `Image check ${operation.id} was accepted (${inputLabel}). The verdict will normally be replied under the image; /history always keeps it.`, waitUntil);
    return { ok: true, accepted: true, operationId };
  } catch (error) {
    // Release the untracked object so the failed admission frees its slot; if R2 refuses, hand the key to the sweep.
    if (stored) {
      try { await env.MEDIA_BUCKET.delete(stored); stored = null; }
      catch { /* The key is recorded as temp_key below and reaped by cleanupIntegrationMedia. */ }
    }
    await markOperationFailed(env, operation, error, claimToken, stored).catch(() => undefined);
    await sendText(env, account.chatId, errorText(error, "The image could not be checked. Reply to the exact image and try again."), waitUntil);
    return { ok: true, accepted: false, error: operationFailure(error).code, operationId };
  } finally {
    bytes.fill(0);
  }
}

/**
 * Reconciliation proves the Telegram receipt independently of processing. A
 * download can therefore be repaired to completed, and a check only when its
 * evidence was already checkpointed. Retained bytes are released after the
 * R2 delete resolves; a failed delete leaves the reservation for cleanup.
 */
async function repairReconciledOperation(env: IntegrationEnv, operation: IntegrationOperation): Promise<boolean> {
  let current: IntegrationOperation | null;
  try {
    current = await getIntegrationOperation(env.DB, operation.account_id, operation.id);
  } catch {
    return true;
  }
  if (!current || current.deleted_at !== null) return false;
  const canComplete = current.action === "download" || (current.action === "check" && current.result_json !== null);
  if (!canComplete) return false;
  let cleanupPending = false;
  try {
    await env.DB.prepare(`UPDATE integration_operations SET status = 'completed', error_json = NULL,
      source_cipher = NULL, updated_at = ?1
      WHERE id = ?2 AND account_id = ?3 AND deleted_at IS NULL`)
      .bind(new Date().toISOString(), current.id, current.account_id).run();
  } catch {
    cleanupPending = true;
  }
  if (current.temp_key) {
    try {
      await env.MEDIA_BUCKET.delete(current.temp_key);
      await env.DB.prepare(`UPDATE integration_operations SET temp_key = NULL, reserved_bytes = 0
        WHERE id = ?1 AND account_id = ?2 AND temp_key = ?3 AND deleted_at IS NULL`)
        .bind(current.id, current.account_id, current.temp_key).run();
    } catch {
      cleanupPending = true;
    }
  } else if (current.reserved_bytes > 0) {
    try {
      await env.DB.prepare(`UPDATE integration_operations SET reserved_bytes = 0
        WHERE id = ?1 AND account_id = ?2 AND temp_key IS NULL AND upload_token IS NULL AND deleted_at IS NULL`)
        .bind(current.id, current.account_id).run();
    } catch {
      cleanupPending = true;
    }
  }
  return cleanupPending;
}

async function handleReconcile(
  env: IntegrationEnv,
  account: IntegrationTelegramAccount,
  message: TelegramMessage,
  operationId: string,
  waitUntil?: IntegrationTelegramWaitUntil,
): Promise<Response> {
  const reply = message.reply_to_message;
  const document = reply && reply.document;
  if (!reply || !privateChat(reply) || privateChat(reply) !== account.chatId
    || !Number.isSafeInteger(reply.message_id) || reply.message_id <= 0 || !document) {
    await sendText(env, account.chatId, "Reply /reconcile to the exact document sent by this bot, with the action ID.", waitUntil);
    return jsonResponse({ ok: true, accepted: false, error: "INVALID_REQUEST" });
  }
  const operation = await getIntegrationOperation(env.DB, account.accountId, operationId);
  const archive = operation ? await integrationArchiveFor(env.DB, operation) : null;
  if (!operation || !archive || !operation.input_json || archive.media_sha256 !== operation.media_sha256
    || !["unknown", "sending", "confirmed"].includes(archive.delivery_state)) {
    await sendText(env, account.chatId, "That action has no reconciliable Telegram document.", waitUntil);
    return jsonResponse({ ok: true, accepted: false, error: "NOT_FOUND" });
  }
  const input = JSON.parse(operation.input_json) as IntegrationInput;
  const fileIdValue = fileId(document);
  if (!fileIdValue || input.media.mediaSha256 !== archive.media_sha256) {
    await sendText(env, account.chatId, "The replied message is not the expected Telegram document.", waitUntil);
    return jsonResponse({ ok: true, accepted: false, error: "HASH_MISMATCH" });
  }
  const client = bot(env, 30_000);
  let currentBot: { id: number; username: string };
  try {
    currentBot = await client.getMe();
  } catch {
    await sendText(env, account.chatId, "Telegram could not confirm the current bot. Try /reconcile again.", waitUntil);
    return jsonResponse({ ok: true, accepted: false, error: "TELEGRAM_UNAVAILABLE" });
  }
  if (telegramNumericId(reply.from?.id) !== String(currentBot.id) || reply.from?.is_bot !== true) {
    await sendText(env, account.chatId, "Reply to the document actually sent by this bot.", waitUntil);
    return jsonResponse({ ok: true, accepted: false, error: "INVALID_RECEIPT" });
  }
  const existingReceipt = archive.delivery_state === "confirmed" ? archive.receipt_json : null;
  if (existingReceipt) {
    try {
      const receipt = JSON.parse(existingReceipt) as Record<string, unknown>;
      if (receipt.botId !== String(currentBot.id) || receipt.chatId !== account.chatId
        || receipt.messageId !== String(reply.message_id) || receipt.fileId !== fileIdValue) {
        await sendText(env, account.chatId, "Reply to the document already recorded for this action.", waitUntil);
        return jsonResponse({ ok: true, accepted: false, error: "INVALID_RECEIPT" });
      }
    } catch {
      await sendText(env, account.chatId, "This archive receipt is unavailable for reconciliation.", waitUntil);
      return jsonResponse({ ok: true, accepted: false, error: "INVALID_RECEIPT" });
    }
  }
  let bytes: Uint8Array;
  try {
    bytes = await client.downloadFile(fileIdValue, input.media.byteLength);
  } catch {
    await sendText(env, account.chatId, "The replied Telegram document could not be retrieved.", waitUntil);
    return jsonResponse({ ok: true, accepted: false, error: "TELEGRAM_UNAVAILABLE" });
  }
  try {
    const digest = hashIntegrationBytes(bytes);
    if (digest !== input.media.mediaSha256 || bytes.byteLength !== input.media.byteLength) {
      await sendText(env, account.chatId, "The replied document bytes do not match this action.", waitUntil);
      return jsonResponse({ ok: true, accepted: false, error: "HASH_MISMATCH" });
    }
    const receipt = JSON.stringify({ botId: String(currentBot.id), chatId: account.chatId, messageId: String(reply.message_id), fileId: fileIdValue });
    const now = new Date().toISOString();
    const changed = await env.DB.prepare(`UPDATE integration_archives SET delivery_state = 'confirmed', receipt_json = ?1,
      integrity_state = 'verified', round_trip_sha256 = ?2, error_json = NULL, updated_at = ?3
      WHERE id = ?4 AND account_id = ?5 AND media_sha256 = ?6 AND delivery_state IN ('unknown', 'sending', 'confirmed')
        AND (delivery_state <> 'confirmed' OR receipt_json = ?7)`)
      .bind(receipt, digest, now, archive.id, account.accountId, input.media.mediaSha256, existingReceipt).run();
    if (!changed.meta?.changes) throw new IntegrationFailure(409, "reconcile_conflict", "This archive changed while it was being reconciled.", true);
    const cleanupPending = await repairReconciledOperation(env, operation);
    await sendText(env, account.chatId, `Telegram document for ${operation.id} is confirmed and its exact bytes are verified.${cleanupPending ? " Temporary media cleanup is pending." : ""}`, waitUntil);
    return jsonResponse({ ok: true, accepted: true, operationId: operation.id, reconciled: true });
  } finally {
    bytes.fill(0);
  }
}

async function handleIntegrationCallback(
  update: TelegramUpdate,
  env: IntegrationEnv,
  waitUntil?: IntegrationTelegramWaitUntil,
): Promise<Response | null> {
  const callback = callbackRecord(update);
  if (!callback || typeof callback.data !== "string") return null;
  const approve = callback.data.match(APPROVE_CALLBACK);
  const pairing = approve ? { pairId: approve[1]!, confirmationCode: approve[2]! } : null;
  if (!pairing && callback.data !== CHECK_CALLBACK) return null;
  const callbackId = typeof callback.id === "string" && CALLBACK_ID.test(callback.id) ? callback.id : null;
  const message = callbackMessage(callback.message);
  const fromId = telegramNumericId((callback.from as { id?: unknown } | undefined)?.id);
  if (!callbackId || !message || !fromId || fromId !== telegramNumericId(message.chat.id)) return jsonResponse({ ok: true, ignored: true });
  if (pairing && !validUUID(pairing.pairId)) return jsonResponse({ ok: true, ignored: true });
  const account = await accountForMessage(env, { ...message, from: { id: Number(fromId) } }, Math.floor(Date.now() / 1000));
  if (!account) return jsonResponse({ ok: true, ignored: true });
  const client = bot(env);
  // Answer the tap and retire the button together; neither outcome changes what was already done.
  const finish = (text: string): Promise<void> => sendWork(Promise.allSettled([
    client.answerCallbackQuery(callbackId, text), client.clearInlineKeyboard(account.chatId, String(message.message_id)),
  ]), waitUntil);
  if (!pairing) {
    // The prompt answers the image, so the tapped message's reply_to_message is the image to check.
    // Telegram omits it for old or inaccessible messages, and a check lives 24 h from its request.
    const fresh = typeof message.date === "number" && message.date * 1000 > Date.now() - INTEGRATION_TEMP_MS;
    if (!fresh || !imageReply(message)) {
      await finish(CHECK_FALLBACK_TOAST);
      return jsonResponse({ ok: true, accepted: false, error: fresh ? "INVALID_MEDIA" : "PROMPT_EXPIRED" });
    }
    // One check per prompt: every tap on it is the same operation, so a second or redelivered tap answers
    // duplicate before any download, and the prompt's own date keeps the request hash stable.
    try {
      const outcome = await handleImageCheck(update, env, account, message, waitUntil, deterministicUUID(account.accountId, `ic:${message.message_id}`));
      await finish(outcome.accepted ? "Check started. The verdict will normally be replied under the image; /history always keeps it."
        : outcome.duplicate ? "This check is already running." : "The check could not start.");
      return jsonResponse(outcome);
    } catch {
      await finish("The check could not start.");
      return jsonResponse({ ok: true, accepted: false, error: "INTERNAL_ERROR" });
    }
  }
  try {
    const approved = await approveIntegrationPairing(env, { ...pairing, telegramUserId: account.telegramUserId, privateChatId: account.chatId });
    await finish(approved ? "Lens link approved." : "This link is unavailable or the code does not match.");
    return jsonResponse({ ok: true, approved: Boolean(approved) });
  } catch {
    await sendWork(client.answerCallbackQuery(callbackId, "The link could not be approved."), waitUntil);
    return jsonResponse({ ok: true, approved: false, error: "INTERNAL_ERROR" });
  }
}

async function handleAccountMessage(
  update: TelegramUpdate,
  env: IntegrationEnv,
  account: IntegrationTelegramAccount,
  message: TelegramMessage,
  waitUntil?: IntegrationTelegramWaitUntil,
): Promise<Response | null> {
  const text = textOfMessage(message);
  const identity = privateIdentity(message);

  const start = text.match(START_COMMAND);
  if (start?.[1]?.startsWith("inv_")) {
    await sendText(env, account.chatId, "This Telegram account is already linked to DigiBot. Use /link UUID to connect another Lens device.", waitUntil);
    return jsonResponse({ ok: true, admitted: true });
  }
  if (LINK_COMMAND.test(text)) {
    const pairId = text.match(LINK_COMMAND)?.[1];
    if (!pairId || !validUUID(pairId)) {
      await sendText(env, account.chatId, "Use /link UUID from the Lens pairing screen.", waitUntil);
      return jsonResponse({ ok: true, accepted: false, error: "INVALID_REQUEST" });
    }
    const summary = await getIntegrationPairingSummary(env, { pairId, telegramUserId: account.telegramUserId, privateChatId: account.chatId });
    if (!summary) {
      await sendText(env, account.chatId, "That pairing is unavailable or expired. Start a new link from Lens.", waitUntil);
      return jsonResponse({ ok: true, accepted: false, error: "PAIRING_NOT_FOUND" });
    }
    const callbackData = `ia:approve:${summary.pairId}:${summary.confirmationCode}`;
    await sendText(env, account.chatId, `Link ${summary.deviceName} only if Lens shows the same code: ${summary.confirmationCode}.`, waitUntil, {
      inline_keyboard: [[{ text: "Approve Lens link", callback_data: callbackData }]],
    });
    return jsonResponse({ ok: true, pairing: summary.pairId });
  }
  if (INVITE_COMMAND.test(text)) {
    if (account.admissionSource !== "legacy_allowlist") {
      await sendText(env, account.chatId, "Only the DigiBot owner can issue invitations.", waitUntil);
      return jsonResponse({ ok: true, accepted: false, error: "FORBIDDEN" });
    }
    const invitation = await createIntegrationInvitation(env, { issuerTelegramUserId: account.telegramUserId });
    if (!invitation) {
      await sendText(env, account.chatId, "Invitations are unavailable for this account.", waitUntil);
      return jsonResponse({ ok: true, accepted: false, error: "FORBIDDEN" });
    }
    await sendText(env, account.chatId, `One-time invitation (expires ${invitation.expiresAt}): /start ${invitation.inviteToken}\nRevoke it: /revokeinvite ${invitation.invitationId}`, waitUntil);
    return jsonResponse({ ok: true, invitationId: invitation.invitationId });
  }
  const revoke = text.match(REVOKE_INVITE_COMMAND);
  if (revoke) {
    if (account.admissionSource !== "legacy_allowlist" || !identity) {
      await sendText(env, account.chatId, "Only the DigiBot owner can revoke invitations.", waitUntil);
      return jsonResponse({ ok: true, accepted: false, error: "FORBIDDEN" });
    }
    const revoked = await revokeIntegrationInvitation(env, { issuerTelegramUserId: account.telegramUserId, invitationId: revoke[1]! });
    await sendText(env, account.chatId, revoked ? "Invitation revoked." : "That invitation is unavailable, already used, or already revoked.", waitUntil);
    return jsonResponse({ ok: true, revoked });
  }
  if (CHECK_COMMAND.test(text)) return jsonResponse(await handleImageCheck(update, env, account, message, waitUntil));
  const history = text.match(HISTORY_COMMAND);
  if (history) {
    const period = history[1]?.toLowerCase() ?? null;
    if (period !== null && !["24h", "7d", "30d", "all"].includes(period)) {
      await sendText(env, account.chatId, "Use /history [24h|7d|30d|all].", waitUntil);
      return jsonResponse({ ok: true, accepted: false, error: "INVALID_PERIOD" });
    }
    try {
      const value = await integrationHistory(env, account, new URL(`https://integration.internal/api/integration/history${period ? `?period=${period}` : ""}`));
      await sendText(env, account.chatId, historyText(value), waitUntil, {
        inline_keyboard: [[{ text: "Open shared History", web_app: {
          url: new URL("/apps/downloader?view=integration", env.PUBLIC_WORKER_BASE_URL).href,
        } }]],
      });
      return jsonResponse({ ok: true, history: true });
    } catch (error) {
      await sendText(env, account.chatId, errorText(error, "History is temporarily unavailable."), waitUntil);
      return jsonResponse({ ok: true, accepted: false, error: "HISTORY_UNAVAILABLE" });
    }
  }
  const stats = text.match(STATS_COMMAND);
  if (stats) {
    const period = stats[1]?.toLowerCase() ?? null;
    if (period !== null && !["24h", "7d", "30d", "all"].includes(period)) {
      await sendText(env, account.chatId, "Use /checkstats [24h|7d|30d|all].", waitUntil);
      return jsonResponse({ ok: true, accepted: false, error: "INVALID_PERIOD" });
    }
    try {
      await sendText(env, account.chatId, statsText(await integrationStats(env, account, period)), waitUntil);
      return jsonResponse({ ok: true, stats: true });
    } catch (error) {
      await sendText(env, account.chatId, errorText(error, "Statistics are temporarily unavailable."), waitUntil);
      return jsonResponse({ ok: true, accepted: false, error: "STATS_UNAVAILABLE" });
    }
  }
  const retry = text.match(RETRY_COMMAND);
  if (retry) {
    if (!validUUID(retry[1])) {
      await sendText(env, account.chatId, "Use /checkretry UUID from History.", waitUntil);
      return jsonResponse({ ok: true, accepted: false, error: "INVALID_REQUEST" });
    }
    const operation = await getIntegrationOperation(env.DB, account.accountId, retry[1]!);
    if (!operation || operation.deleted_at !== null) {
      await sendText(env, account.chatId, "That action was not found in your History.", waitUntil);
      return jsonResponse({ ok: true, accepted: false, error: "NOT_FOUND" });
    }
    try {
      const value = await retryIntegrationOperation(env, account, operation);
      await sendText(env, account.chatId, operationSnapshotText(value), waitUntil);
      return jsonResponse({ ok: true, retried: true, operationId: operation.id });
    } catch (error) {
      await sendText(env, account.chatId, errorText(error, "This action cannot be retried yet."), waitUntil);
      return jsonResponse({ ok: true, accepted: false, error: "RETRY_UNAVAILABLE" });
    }
  }
  const reconcile = text.match(RECONCILE_COMMAND);
  if (reconcile) {
    if (!validUUID(reconcile[1])) {
      await sendText(env, account.chatId, "Use /reconcile UUID from the archive warning, replying to the delivered document.", waitUntil);
      return jsonResponse({ ok: true, accepted: false, error: "INVALID_REQUEST" });
    }
    return handleReconcile(env, account, message, reconcile[1]!, waitUntil);
  }

  const photo = Array.isArray(message.photo);
  if (!text && (photo || (typeof message.document === "object" && message.document !== null && "mime_type" in message.document
    && typeof message.document.mime_type === "string" && /^image\/(?:png|jpeg|webp)$/u.test(message.document.mime_type)))) {
    // A caption never starts a check; the prompt answers the image and only its button or /check does.
    await sendText(env, account.chatId, checkPromptText(photo), waitUntil, { inline_keyboard: [[CHECK_BUTTON]] },
      Number.isSafeInteger(message.message_id) && message.message_id > 0 ? message.message_id : undefined);
    return jsonResponse({ ok: true, accepted: false, checkAvailable: true });
  }

  if (account.admissionSource === "invitation") {
    await sendText(env, account.chatId, HELP_TEXT, waitUntil);
    return jsonResponse({ ok: true, accepted: false, error: "INTEGRATION_COMMAND_REQUIRED" });
  }
  return null;
}

export async function handleIntegrationTelegramUpdate(
  update: TelegramUpdate,
  env: IntegrationEnv,
  waitUntil?: IntegrationTelegramWaitUntil,
): Promise<Response | null> {
  if (env.INTEGRATION_ENABLED !== "true") return null;
  const nowSeconds = Math.floor(Date.now() / 1000);
  try {
    if (update.callback_query !== undefined) return handleIntegrationCallback(update, env, waitUntil);
    const message = update.message;
    if (!message || typeof message !== "object") return null;
    const identity = privateIdentity(message);
    if (!identity) return null;
    const text = textOfMessage(message);
    const start = text.match(START_COMMAND);
    let account = await integrationAccountForTelegram(env, identity, nowSeconds);
    if (!account && start?.[1] && INVITATION_TOKEN.test(start[1])) {
      account = await admitIntegrationInvite(env, { ...identity, inviteToken: start[1] }, nowSeconds);
      if (account) {
        await sendText(env, account.chatId, "Invitation accepted. Your private DigiBot account is ready. Use /link UUID to connect Lens, or reply to an image with /check.", waitUntil);
        return jsonResponse({ ok: true, admitted: true });
      }
    }
    if (!account) return null;
    return handleAccountMessage(update, env, account, message, waitUntil);
  } catch (error) {
    if (error instanceof TelegramApiError) return jsonResponse({ ok: true, accepted: false, error: "TELEGRAM_UNAVAILABLE" });
    return jsonResponse({ ok: true, accepted: false, error: "INTERNAL_ERROR" });
  }
}

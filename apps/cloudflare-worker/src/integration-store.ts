import { createHash } from "node:crypto";
import type { D1BatchDatabaseLike } from "./types";

export const INTEGRATION_CHECK_BYTES = 4 * 1024 * 1024;
export const INTEGRATION_TEMP_MS = 24 * 60 * 60 * 1000;
export const INTEGRATION_REPLAY_MS = 30 * INTEGRATION_TEMP_MS;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const AUDIO_MIMES = new Set(["audio/mpeg", "audio/ogg", "audio/opus", "audio/aac", "audio/flac", "audio/wav", "audio/x-wav"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const SHA256 = /^[a-f0-9]{64}$/u;

export interface IntegrationError { code: string; message: string; retryable: boolean }
export interface IntegrationSegment { startSeconds: number; endSeconds: number }
export interface IntegrationMedia {
  mediaSha256: string; byteLength: number; mimeType: string;
  inputKind: "original" | "telegram_photo_copy" | "screenshot_copy" | "derived_audio_segment";
  audioDurationSeconds: number | null; segment: IntegrationSegment | null; fullSourceSha256: string | null;
}
export interface IntegrationInput {
  version: 1; operationId: string; action: "check" | "download";
  media: IntegrationMedia; forceRecheck: boolean;
}
export interface IntegrationAccount { accountId: string; telegramUserId: string; chatId: string }
export interface IntegrationOperation {
  id: string; account_id: string; action: "check" | "download"; request_hash: string;
  input_json: string | null; segment_json: string | null; source_cipher: string | null;
  media_sha256: string | null; archive_id: string | null;
  status: "awaiting_upload" | "queued" | "processing" | "completed" | "failed";
  requested_at: string; expires_at: string; admitted_at: string | null;
  upload_token: string | null; upload_started_at: string | null; temp_key: string | null;
  result_json: string | null; error_json: string | null; provider_started_at: string | null;
  provider_attempts: number; run_generation: number; reserved_bytes: number;
  updated_at: string; deleted_at: string | null;
}
export interface IntegrationArchive {
  id: string; account_id: string; media_sha256: string; kind: "automatic" | "download";
  delivery_state: "pending" | "sending" | "confirmed" | "failed" | "unknown";
  receipt_json: string | null; integrity_state: "not_checked" | "verified" | "mismatch" | "failed";
  round_trip_sha256: string | null; error_json: string | null;
  attempt_started_at: string | null; created_at: string; updated_at: string;
}

export class IntegrationFailure extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly retryable = false) { super(message); }
}

export function hashIntegrationBytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function integrationId(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function integrationSegment(value: unknown): IntegrationSegment | null {
  if (!record(value) || !exactKeys(value, ["startSeconds", "endSeconds"])) return null;
  const { startSeconds, endSeconds } = value;
  if (typeof startSeconds !== "number" || typeof endSeconds !== "number"
    || !Number.isSafeInteger(startSeconds) || !Number.isSafeInteger(endSeconds)
    || startSeconds < 0 || endSeconds > 86400 || endSeconds <= startSeconds || endSeconds - startSeconds > 60) return null;
  return { startSeconds, endSeconds };
}

/** Validate the network input independently of the extension's validation. */
export function parseIntegrationInput(value: unknown, maxDownloadBytes: number): IntegrationInput {
  const invalid = () => new IntegrationFailure(400, "invalid_request", "Invalid integration media request.");
  if (!record(value) || !exactKeys(value, ["version", "operationId", "action", "media", "forceRecheck"])
    || value.version !== 1 || !integrationId(value.operationId)
    || (value.action !== "check" && value.action !== "download") || !record(value.media)) throw invalid();
  const media = value.media;
  if (!exactKeys(media, ["mediaSha256", "byteLength", "mimeType", "inputKind", "audioDurationSeconds", "segment", "fullSourceSha256"])
    || typeof media.mediaSha256 !== "string" || !SHA256.test(media.mediaSha256)
    || typeof media.byteLength !== "number" || !Number.isSafeInteger(media.byteLength) || media.byteLength <= 0
    || typeof media.mimeType !== "string" || (!IMAGE_MIMES.has(media.mimeType) && !AUDIO_MIMES.has(media.mimeType))
    || typeof media.inputKind !== "string"
    || !["original", "telegram_photo_copy", "screenshot_copy", "derived_audio_segment"].includes(media.inputKind)) throw invalid();
  const audio = AUDIO_MIMES.has(media.mimeType);
  const duration = media.audioDurationSeconds ?? null;
  const segment = media.segment == null ? null : integrationSegment(media.segment);
  const sourceHash = media.fullSourceSha256 ?? null;
  const derived = media.inputKind === "derived_audio_segment";
  const forceRecheck = value.forceRecheck ?? false;
  if (typeof forceRecheck !== "boolean" || (value.action === "download" && forceRecheck)
    || media.byteLength > (value.action === "check" ? INTEGRATION_CHECK_BYTES : maxDownloadBytes)
    || (duration !== null && (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0))
    || (value.action === "check" && audio && (duration === null || Number(duration) > 60))
    || (media.segment != null && segment === null)
    || (sourceHash !== null && (typeof sourceHash !== "string" || !SHA256.test(sourceHash)))
    || (!audio && (duration !== null || segment !== null || sourceHash !== null))
    || (audio && (media.inputKind === "telegram_photo_copy" || media.inputKind === "screenshot_copy"))
    || (derived && (value.action !== "check" || media.mimeType !== "audio/mpeg" || segment === null))
    || (!derived && (segment !== null || sourceHash !== null))) throw invalid();
  return {
    version: 1, operationId: value.operationId.toLowerCase(), action: value.action, forceRecheck,
    media: { mediaSha256: media.mediaSha256, byteLength: media.byteLength, mimeType: media.mimeType,
      inputKind: media.inputKind as IntegrationMedia["inputKind"], audioDurationSeconds: duration as number | null,
      segment, fullSourceSha256: sourceHash as string | null },
  };
}

export function validateIntegrationCreatedAt(value: string | null, now = new Date()): string {
  const timestamp = value === null ? NaN : Date.parse(value);
  if (!Number.isFinite(timestamp) || now.getTime() - timestamp > INTEGRATION_TEMP_MS || timestamp > now.getTime() + 30_000) {
    throw new IntegrationFailure(410, "operation_expired", "Create a new action; this pending action has expired.");
  }
  return new Date(timestamp).toISOString();
}

export async function getIntegrationOperation(db: D1BatchDatabaseLike, accountId: string, id: string): Promise<IntegrationOperation | null> {
  return db.prepare("SELECT * FROM integration_operations WHERE account_id = ?1 AND id = ?2").bind(accountId, id).first<IntegrationOperation>();
}

export async function registerIntegrationOperation(
  db: D1BatchDatabaseLike, account: IntegrationAccount,
  payload: { input: IntegrationInput } | { operationId: string; segment: IntegrationSegment; sourceCipher: string; sourceHash: string },
  createdAt: string, now = new Date(),
): Promise<IntegrationOperation> {
  const normalizedCreatedAt = validateIntegrationCreatedAt(createdAt, now);
  const input = "input" in payload ? payload.input : null;
  const id = input?.operationId ?? (payload as { operationId: string }).operationId;
  const segment = input?.media.segment ?? ("segment" in payload ? payload.segment : null);
  const immutable = input ?? { operationId: id, segment, sourceHash: "sourceHash" in payload ? payload.sourceHash : null };
  const requestHash = hashIntegrationBytes(JSON.stringify([normalizedCreatedAt, immutable]));
  const timestamp = now.toISOString();
  await db.prepare(`INSERT INTO integration_operations
    (id, account_id, action, request_hash, input_json, segment_json, source_cipher, media_sha256, status, requested_at, expires_at, updated_at, admitted_at, reserved_bytes)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?10, CASE WHEN ?5 IS NULL THEN ?10 ELSE NULL END, ?13
    WHERE (SELECT COUNT(*) FROM integration_operations WHERE account_id = ?2 AND requested_at >= ?12) < 20
      AND (SELECT COUNT(*) FROM integration_operations WHERE account_id = ?2 AND reserved_bytes > 0) < 4
      AND (SELECT COALESCE(SUM(reserved_bytes), 0) FROM integration_operations WHERE account_id = ?2) + ?13 <= 98000000
    ON CONFLICT(account_id, id) DO NOTHING`).bind(id, account.accountId, input?.action ?? "check", requestHash,
    input ? JSON.stringify(input) : null, segment ? JSON.stringify(segment) : null,
    "sourceCipher" in payload ? payload.sourceCipher : null, input?.media.mediaSha256 ?? null,
    input ? "awaiting_upload" : "queued", timestamp, new Date(now.getTime() + INTEGRATION_TEMP_MS).toISOString(),
    new Date(now.getTime() - 60 * 60 * 1000).toISOString(), input?.media.byteLength ?? INTEGRATION_CHECK_BYTES).run();
  const existing = await getIntegrationOperation(db, account.accountId, id);
  if (!existing) throw new IntegrationFailure(429, "operation_limit", "The account limit is 20 actions per hour, 4 retained inputs, and 98 MB of temporary media. Finish or delete a pending action before retrying.", true);
  if (existing.request_hash !== requestHash) throw new IntegrationFailure(409, "operation_conflict", "This action ID is already bound to different media or options.");
  if (existing.deleted_at !== null) throw new IntegrationFailure(410, "operation_deleted", "This action was deleted. Start a new action to check again.");
  return existing;
}

/** The Telegram message that already holds the checked bytes, so the check keeps it as its saved copy and sends no copy of it back. */
export interface IntegrationSavedCopy { botId: string; chatId: string; messageId: string; fileId: string }

export async function attachIntegrationMedia(
  db: D1BatchDatabaseLike, operation: IntegrationOperation, input: IntegrationInput, key: string, now = new Date(), saved?: IntegrationSavedCopy,
): Promise<void> {
  const timestamp = now.toISOString();
  const reusable = input.action === "check" && input.media.mimeType.startsWith("image/")
    ? await db.prepare(`SELECT id FROM integration_archives WHERE account_id = ?1 AND media_sha256 = ?2
        AND delivery_state = 'confirmed' AND integrity_state = 'verified' ORDER BY created_at DESC LIMIT 1`)
      .bind(operation.account_id, input.media.mediaSha256).first<{ id: string }>() : null;
  const archiveId = input.media.mimeType.startsWith("image/") || input.action === "download"
    ? reusable?.id ?? hashIntegrationBytes(`${operation.account_id}\0${input.action === "download" ? operation.id : input.media.mediaSha256}`)
    : null;
  const statements = [db.prepare(`INSERT INTO integration_media (account_id, sha256, byte_length, mime_type, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM integration_operations WHERE id = ?6 AND account_id = ?1 AND deleted_at IS NULL AND expires_at > ?5 AND status IN ('awaiting_upload', 'processing', 'queued'))
    ON CONFLICT(account_id, sha256) DO NOTHING`)
    .bind(operation.account_id, input.media.mediaSha256, input.media.byteLength, input.media.mimeType, timestamp, operation.id)];
  // A copy the user already sent is confirmed and verified at once: the checked bytes were fetched from that very
  // message. Its receipt carries sender "user" (stripped by integrationArchiveSnapshot) so a delete never removes the
  // user's own message. It takes over a failed row or the unclaimed pending row of a concurrent Lens Check, never a
  // sending, unknown or confirmed one; without it the row starts pending, as before.
  if (archiveId) statements.push(db.prepare(`INSERT INTO integration_archives
    (id, account_id, media_sha256, kind, delivery_state, receipt_json, integrity_state, round_trip_sha256, created_at, updated_at)
    SELECT ?1, ?2, ?3, ?4, ?8, ?9, ?10, ?11, ?5, ?5
    WHERE EXISTS (SELECT 1 FROM integration_operations WHERE id = ?6 AND account_id = ?2 AND deleted_at IS NULL AND expires_at > ?5 AND status IN ('awaiting_upload', 'processing', 'queued'))
    ON CONFLICT(id) DO UPDATE SET delivery_state = excluded.delivery_state, error_json = NULL, integrity_state = excluded.integrity_state,
      round_trip_sha256 = excluded.round_trip_sha256, receipt_json = excluded.receipt_json, attempt_started_at = NULL, updated_at = excluded.updated_at
    WHERE (integration_archives.delivery_state = 'failed' AND integration_archives.updated_at < ?7)
      OR (excluded.receipt_json IS NOT NULL AND integration_archives.delivery_state IN ('failed', 'pending'))`)
    .bind(archiveId, operation.account_id, input.media.mediaSha256, input.action === "download" ? "download" : "automatic", timestamp, operation.id, operation.requested_at,
      saved ? "confirmed" : "pending", saved ? JSON.stringify({ ...saved, sender: "user" }) : null, saved ? "verified" : "not_checked", saved ? input.media.mediaSha256 : null));
  statements.push(db.prepare(`UPDATE integration_operations SET input_json = ?1, media_sha256 = ?2, archive_id = ?3,
    temp_key = ?4, admitted_at = COALESCE(admitted_at, ?5), status = CASE WHEN status = 'processing' THEN status ELSE 'queued' END, error_json = NULL, updated_at = ?5
    WHERE id = ?6 AND account_id = ?7 AND deleted_at IS NULL AND expires_at > ?5 AND status IN ('awaiting_upload', 'processing', 'queued')`)
    .bind(JSON.stringify(input), input.media.mediaSha256, archiveId, key, timestamp, operation.id, operation.account_id));
  const results = await db.batch(statements);
  if (!results.at(-1)?.meta?.changes) throw new IntegrationFailure(410, "operation_expired", "This action expired or was deleted before its file was admitted.");
}

export async function integrationArchiveFor(db: D1BatchDatabaseLike, operation: IntegrationOperation): Promise<IntegrationArchive | null> {
  return operation.archive_id === null ? null : db.prepare("SELECT * FROM integration_archives WHERE id = ?1 AND account_id = ?2")
    .bind(operation.archive_id, operation.account_id).first<IntegrationArchive>();
}

export function integrationArchiveSnapshot(archive: IntegrationArchive | null) {
  const error = archive?.error_json ? JSON.parse(archive.error_json) as IntegrationError : null;
  // Lens parses documentReceipt strictly, so only the four receipt fields leave the row; the sender marker stays inside.
  const receipt = archive?.receipt_json ? JSON.parse(archive.receipt_json) as IntegrationSavedCopy & { sender?: string } : null;
  return {
    deliveryState: archive?.delivery_state ?? "not_required",
    documentReceipt: receipt ? { botId: receipt.botId, chatId: receipt.chatId, messageId: receipt.messageId, fileId: receipt.fileId } : null,
    integrityState: archive?.integrity_state ?? "not_checked", roundTripSha256: archive?.round_trip_sha256 ?? null,
    error, retryReady: archive?.delivery_state === "failed" && error?.retryable === true,
  };
}

export async function integrationOperationSnapshot(db: D1BatchDatabaseLike, operation: IntegrationOperation) {
  const input = operation.input_json ? JSON.parse(operation.input_json) as IntegrationInput : null;
  const archive = integrationArchiveSnapshot(await integrationArchiveFor(db, operation));
  if (archive.deliveryState === "not_required" && (operation.action === "download" || input?.media.mimeType.startsWith("image/"))) {
    archive.deliveryState = "pending";
  }
  const result = operation.result_json ? JSON.parse(operation.result_json) as unknown : null;
  return {
    version: 1, operationId: operation.id, accountId: operation.account_id, action: operation.action,
    state: operation.status, requestedAt: operation.requested_at, expiresAt: operation.expires_at,
    mediaSha256: operation.media_sha256, segment: operation.segment_json ? JSON.parse(operation.segment_json) as IntegrationSegment : null,
    archive, error: operation.error_json ? JSON.parse(operation.error_json) as IntegrationError : null,
    envelope: input && (result !== null || input.action === "download") ? {
      ...input, accountId: operation.account_id, requestedAt: operation.requested_at, result, archive,
      historySync: { state: "synced", historyId: operation.id, error: null },
    } : null,
  };
}

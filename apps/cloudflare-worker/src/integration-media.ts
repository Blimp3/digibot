import { createHash } from "node:crypto";
import { getWorkerConfig } from "./config";
import { TelegramApiError, TelegramClient } from "./telegram";
import { readIntegrationBytes, readIntegrationJson } from "./integration-io";
import { prepareIntegrationAudio } from "./integration-audio";
import { AUDIO_POLICY, IMAGE_POLICY, parseIntegrationVerifierResponse, type IntegrationVerifierResult } from "./integration-verifier";
import {
  INTEGRATION_CHECK_BYTES, IntegrationFailure, attachIntegrationMedia, getIntegrationOperation,
  hashIntegrationBytes, integrationArchiveFor,
  type IntegrationAccount, type IntegrationInput, type IntegrationMedia, type IntegrationOperation, type IntegrationError,
} from "./integration-store";
import type { Env } from "./types";

export type IntegrationEnv = Env & {
  INTEGRATION_ENABLED?: string;
  PROVENANCE_VERIFIER?: { fetch(request: Request): Promise<Response> };
  INTEGRATION_WORKFLOW?: {
    create(options: { id: string; params: IntegrationWorkflowParams; retention: { successRetention: "1 day"; errorRetention: "1 day" } }): Promise<unknown>;
    get(id: string): Promise<{ status(): Promise<{ status: string }>; restart(options: { from: { name: string } }): Promise<void> }>;
  };
};

/** replyToMessageId is the Telegram image message a /check answered; the verdict is replied under it. */
export interface IntegrationWorkflowParams { accountId: string; operationId: string; generation: number; replyToMessageId?: number }
export interface IntegrationStep {
  do<T>(name: string, options: { retries: { limit: number; delay: string; backoff: "exponential" }; timeout: string }, callback: () => Promise<T>): Promise<T>;
}
const DATABASE_STEP = { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" as const }, timeout: "1 minute" };
const EFFECT_STEP = { retries: { limit: 0, delay: "1 second", backoff: "exponential" as const }, timeout: "25 minutes" };

const UPLOAD_TIMEOUT_MS = 60_000;
// The same labels the Mini App shows (mini-app.ts integrationVerdictLabels); a test keeps them equal.
const VERDICT_LABELS: Record<string, string> = {
  openai_signal_detected: "Supported signal detected",
  no_supported_openai_signal: "No supported signal detected",
  indeterminate: "Evidence is indeterminate",
};
/** Why a Telegram photo is a weaker input than a document; the image prompt and the verdict reply share it. */
export const TELEGRAM_PHOTO_CAVEAT = "Telegram recompresses photos and strips Content Credentials, so send the image as a File for a reliable check.";
const PHOTO_COPY_CAVEAT = `This checked a Telegram photo copy: ${TELEGRAM_PHOTO_CAVEAT}`;
const NOT_PROOF_LINE = "No supported signal is not proof of human origin.";

function telegramClient(env: IntegrationEnv, requestTimeoutMs: number): TelegramClient {
  return new TelegramClient({ token: env.TELEGRAM_BOT_TOKEN, apiBase: getWorkerConfig(env).telegramApiBase, requestTimeoutMs });
}

/** The Telegram reply for a check started in Telegram: the saved evidence or the processing error. */
export function checkVerdictText(value: { evidence: IntegrationVerifierResult } | IntegrationError, inputKind: IntegrationMedia["inputKind"]): string {
  const lines: string[] = [];
  if ("evidence" in value) {
    const { evidence } = value;
    lines.push(VERDICT_LABELS[evidence.verdict] ?? "Evidence is indeterminate", evidence.summary || "No evidence summary available.");
    const credentials = evidence.contentCredentials;
    // Name the issuer only when the pinned trust list vouches for the signer: a
    // self-signed manifest can claim any issuer, and Telegram auto-links text.
    if (credentials) {
      const trust = credentials.signerTrusted
        ? `; signer trusted by the pinned list${credentials.issuer ? `; issuer: ${credentials.issuer}` : ""}`
        : credentials.status === "verified" ? " (signer not trusted by the pinned list)" : "";
      lines.push(`C2PA status: ${credentials.status}${trust}`);
    }
  } else {
    lines.push(`Check failed: ${value.message}`);
  }
  if (inputKind === "telegram_photo_copy") lines.push(PHOTO_COPY_CAVEAT);
  lines.push(NOT_PROOF_LINE);
  return lines.join("\n");
}

export function integrationImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  const text = new TextDecoder("ascii").decode(bytes.subarray(0, 12));
  return bytes.length >= 12 && text.startsWith("RIFF") && text.endsWith("WEBP") ? "image/webp" : null;
}

function verificationForm(input: IntegrationInput, bytes: Uint8Array): FormData {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(bytes)], { type: input.media.mimeType }), input.media.mimeType.startsWith("image/") ? "image" : "audio");
  form.set("imageSha256", input.media.mediaSha256);
  form.set("byteLength", String(input.media.byteLength));
  form.set("validatedMimeType", input.media.mimeType);
  form.set("verificationPolicyVersion", input.media.mimeType.startsWith("image/") ? IMAGE_POLICY : AUDIO_POLICY);
  form.set("forceRecheck", String(input.forceRecheck));
  return form;
}

export async function privateVerifierRequest(env: IntegrationEnv, accountId: string, path: string, body: FormData | string, mediaKind?: string): Promise<Response> {
  if (!env.PROVENANCE_VERIFIER) throw new IntegrationFailure(503, "verifier_unavailable", "Verification is temporarily unavailable.", true);
  return env.PROVENANCE_VERIFIER.fetch(new Request(`https://integration.internal${path}`, {
    method: "POST", body, signal: AbortSignal.timeout(50_000),
    headers: { "X-Integration-Account-Id": accountId,
      ...(mediaKind ? { "X-Integration-Media-Kind": mediaKind } : {}),
      ...(typeof body === "string" ? { "content-type": "application/json" } : {}) },
  }));
}

export async function validateIntegrationCheck(env: IntegrationEnv, accountId: string, input: IntegrationInput, bytes: Uint8Array): Promise<IntegrationInput> {
  const kind = input.media.mimeType.startsWith("image/") ? "image" : "audio";
  const response = await privateVerifierRequest(env, accountId, "/validate", verificationForm(input, bytes), kind);
  if (!response.ok) throw new IntegrationFailure(response.status >= 500 ? 503 : 400, "invalid_media", "The media could not be validated for a provenance check.", response.status >= 500);
  const validated = await readIntegrationJson(response) as { mediaSha256?: unknown; byteLength?: unknown; mimeType?: unknown; audioDurationSeconds?: unknown };
  if (!validated || validated.mediaSha256 !== input.media.mediaSha256 || validated.byteLength !== input.media.byteLength
    || validated.mimeType !== input.media.mimeType
    || (kind === "audio" && (typeof validated.audioDurationSeconds !== "number" || !Number.isFinite(validated.audioDurationSeconds)
      || validated.audioDurationSeconds <= 0 || validated.audioDurationSeconds > 60))) throw new IntegrationFailure(400, "invalid_media", "The media identity or duration did not validate.");
  return { ...input, media: { ...input.media, audioDurationSeconds: kind === "audio" ? validated.audioDurationSeconds as number : null } };
}

/** Stream independent Downloads to R2; avoid buffering a 49 MB image twice. */
export async function storeIntegrationUpload(env: IntegrationEnv, account: IntegrationAccount, operation: IntegrationOperation, request: Request): Promise<void> {
  if (!operation.input_json || operation.deleted_at || Date.parse(operation.expires_at) <= Date.now()) throw new IntegrationFailure(410, "operation_expired", "This upload has expired.");
  if (operation.status !== "awaiting_upload") return;
  const input = JSON.parse(operation.input_json) as IntegrationInput;
  if ((request.headers.get("content-type") ?? "").split(";", 1)[0]?.trim() !== input.media.mimeType || !request.body) throw new IntegrationFailure(400, "invalid_media", "Upload the selected file with its original media type.");
  const uploadToken = crypto.randomUUID();
  const now = new Date().toISOString();
  const claimed = await env.DB.prepare(`UPDATE integration_operations SET upload_token = ?1, upload_started_at = ?2
    WHERE id = ?3 AND account_id = ?4 AND status = 'awaiting_upload' AND deleted_at IS NULL AND expires_at > ?2
      AND (upload_started_at IS NULL OR upload_started_at < ?5)`)
    .bind(uploadToken, now, operation.id, account.accountId, new Date(Date.now() - 2 * UPLOAD_TIMEOUT_MS).toISOString()).run();
  if (!claimed.meta.changes) throw new IntegrationFailure(409, "upload_in_progress", "This file is already being uploaded.", true);
  const key = `integration/${account.accountId}/${operation.id}/${uploadToken}`;
  const hash = createHash("sha256");
  const prefix = new Uint8Array(12);
  let prefixLength = 0;
  let length = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  const bounded = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, stream) {
      length += chunk.byteLength;
      if (length > input.media.byteLength) throw new IntegrationFailure(413, "size_mismatch", "The uploaded file size changed.");
      const take = Math.min(12 - prefixLength, chunk.byteLength);
      prefix.set(chunk.subarray(0, take), prefixLength); prefixLength += take;
      hash.update(chunk); stream.enqueue(chunk);
    },
  }), { signal: controller.signal });
  try {
    const fixed = new FixedLengthStream(input.media.byteLength);
    const piping = bounded.pipeTo(fixed.writable, { signal: controller.signal });
    const stored = await Promise.allSettled([env.MEDIA_BUCKET.put(key, fixed.readable, { httpMetadata: { contentType: input.media.mimeType } }), piping]);
    const failed = stored.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    if (length !== input.media.byteLength || hash.digest("hex") !== input.media.mediaSha256) throw new IntegrationFailure(400, "hash_mismatch", "The uploaded bytes do not match the selected file.");
    if (input.media.mimeType.startsWith("image/") && integrationImageMime(prefix.subarray(0, prefixLength)) !== input.media.mimeType) throw new IntegrationFailure(400, "invalid_media", "The image type does not match its bytes.");
    let validated = input;
    // The stream above enforces an image's exact length, SHA-256 and magic bytes, and /verify-image
    // re-parses the same form, so only audio Checks still need /validate (it measures the duration).
    if (input.action === "check" && !input.media.mimeType.startsWith("image/")) {
      const object = await env.MEDIA_BUCKET.get(key);
      if (!object) throw new IntegrationFailure(503, "media_unavailable", "The temporary file is unavailable.", true);
      const bytes = await readIntegrationBytes(new Response(object.body), INTEGRATION_CHECK_BYTES);
      try { validated = await validateIntegrationCheck(env, account.accountId, input, bytes); }
      finally { bytes.fill(0); }
    }
    await attachIntegrationMedia(env.DB, operation, validated, key);
  } catch (error) {
    try { await env.MEDIA_BUCKET.delete(key); }
    catch {
      await env.DB.prepare(`UPDATE integration_operations SET temp_key = ?1, status = 'failed', error_json = ?2
        WHERE id = ?3 AND account_id = ?4 AND upload_token = ?5`)
        .bind(key, JSON.stringify({ code: "upload_cleanup_pending", message: "Upload cleanup is pending. Start a new action after cleanup completes.", retryable: false }), operation.id, account.accountId, uploadToken).run();
    }
    throw error;
  } finally {
    clearTimeout(timer); controller.abort();
    await env.DB.prepare("UPDATE integration_operations SET upload_token = NULL, upload_started_at = NULL WHERE id = ?1 AND account_id = ?2 AND upload_token = ?3")
      .bind(operation.id, account.accountId, uploadToken).run();
  }
}

export function integrationWorkflowId(operation: Pick<IntegrationOperation, "account_id" | "id" | "run_generation">): string {
  return `${hashIntegrationBytes(`${operation.account_id}\0${operation.id}`)}-${operation.run_generation}`;
}

export async function dispatchIntegrationOperation(env: IntegrationEnv, operation: IntegrationOperation, replyToMessageId?: number): Promise<void> {
  if (!env.INTEGRATION_WORKFLOW) throw new IntegrationFailure(503, "integration_unavailable", "Media processing is temporarily unavailable.", true);
  // A durable row remains queued if dispatch is interrupted; recovery uses this
  // same ID. Explicit retries increment the generation, never the action count.
  try { await env.INTEGRATION_WORKFLOW.create({ id: integrationWorkflowId(operation), params: {
    accountId: operation.account_id, operationId: operation.id, generation: operation.run_generation,
    ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
  }, retention: { successRetention: "1 day", errorRetention: "1 day" } }); }
  catch { /* The queued row remains recoverable under the same instance ID. */ }
}

async function verifyIntegrationOperation(env: IntegrationEnv, operation: IntegrationOperation, input: IntegrationInput): Promise<string> {
  // A crash after provider acceptance must not automatically repeat a paid call.
  if (operation.provider_started_at) throw new IntegrationFailure(409, "verification_unknown", "The previous verification attempt was interrupted. A controlled retry can check the server cache first.", true);
  if (operation.provider_attempts >= 3) throw new IntegrationFailure(429, "verification_limit", "This action has reached its verification retry limit.");
  const object = operation.temp_key ? await env.MEDIA_BUCKET.get(operation.temp_key) : null;
  if (!object) throw new IntegrationFailure(410, "media_expired", "The temporary input is no longer available.");
  const bytes = await readIntegrationBytes(new Response(object.body), INTEGRATION_CHECK_BYTES);
  try {
    if (hashIntegrationBytes(bytes) !== input.media.mediaSha256) throw new IntegrationFailure(409, "hash_mismatch", "The temporary file identity changed.");
    const claim = await env.DB.prepare(`UPDATE integration_operations SET provider_started_at = ?1, provider_attempts = provider_attempts + 1
      WHERE id = ?2 AND account_id = ?3 AND deleted_at IS NULL AND expires_at > ?1 AND provider_started_at IS NULL
      AND EXISTS (SELECT 1 FROM integration_accounts WHERE id = ?3 AND status = 'active')`)
      .bind(new Date().toISOString(), operation.id, operation.account_id).run();
    if (!claim.meta.changes) throw new IntegrationFailure(410, "operation_unavailable", "This action is no longer available.");
    const kind = input.media.mimeType.startsWith("image/") ? "image" : "audio";
    const response = await privateVerifierRequest(env, operation.account_id, `/verify-${kind}`, verificationForm(input, bytes));
    if (!response.ok) throw new IntegrationFailure(503, "verification_failed", "Verification failed. Saving the original image continues independently.", true);
    const payload = parseIntegrationVerifierResponse(await readIntegrationJson(response, 64 * 1024), input);
    return JSON.stringify({
      resultRef: crypto.randomUUID(), accountId: operation.account_id, mediaSha256: input.media.mediaSha256,
      verificationPolicyVersion: kind === "image" ? IMAGE_POLICY : AUDIO_POLICY,
      resultSchemaVersion: kind === "image" ? 2 : 1,
      originallyCheckedAt: payload.result.checkedAt, cacheSource: payload.cache?.source ?? "fresh", evidence: payload.result,
    });
  } finally { bytes.fill(0); }
}

async function archiveIntegrationImage(env: IntegrationEnv, operation: IntegrationOperation, input: IntegrationInput): Promise<void> {
  const archive = await integrationArchiveFor(env.DB, operation);
  if (!archive || archive.delivery_state === "unknown" || archive.delivery_state === "failed") return;
  const account = await env.DB.prepare("SELECT telegram_chat_id FROM integration_accounts WHERE id = ?1 AND status = 'active'")
    .bind(operation.account_id).first<{ telegram_chat_id: string }>();
  if (!account) return;
  const telegram = telegramClient(env, 60_000);
  if (archive.delivery_state === "pending") {
    const claim = await env.DB.prepare(`UPDATE integration_archives SET delivery_state = 'sending', attempt_started_at = ?1, updated_at = ?1
      WHERE id = ?2 AND account_id = ?3 AND delivery_state = 'pending'
      AND EXISTS (SELECT 1 FROM integration_operations WHERE id = ?4 AND account_id = ?3 AND deleted_at IS NULL AND expires_at > ?1)`)
      .bind(new Date().toISOString(), archive.id, operation.account_id, operation.id).run();
    if (!claim.meta.changes) return;
    try {
      const current = await getIntegrationOperation(env.DB, operation.account_id, operation.id);
      const object = current?.temp_key && !current.deleted_at ? await env.MEDIA_BUCKET.get(current.temp_key) : null;
      if (!object) throw new IntegrationFailure(410, "media_expired", "The temporary file is unavailable. Select the exact file again.");
      const admitted = await env.DB.prepare(`SELECT 1 AS allowed FROM integration_operations o JOIN integration_accounts a ON a.id = o.account_id
        WHERE o.id = ?1 AND o.account_id = ?2 AND o.deleted_at IS NULL AND o.expires_at > ?3 AND a.status = 'active'`)
        .bind(operation.id, operation.account_id, new Date().toISOString()).first();
      if (!admitted) throw new IntegrationFailure(410, "operation_unavailable", "This action is no longer available.");
      const receipt = await telegram.sendDocumentStream(account.telegram_chat_id, object.body, input.media.byteLength,
        `original-${input.media.mediaSha256.slice(0, 12)}.${input.media.mimeType === "image/png" ? "png" : input.media.mimeType === "image/jpeg" ? "jpg" : input.media.mimeType === "image/webp" ? "webp" : "audio"}`,
        input.media.mimeType, input.media.mediaSha256);
      const receiptJson = JSON.stringify({ botId: env.TELEGRAM_BOT_TOKEN.split(":", 1)[0], chatId: account.telegram_chat_id, ...receipt });
      const confirmed = await env.DB.prepare(`UPDATE integration_archives SET delivery_state = 'confirmed', receipt_json = ?1, error_json = NULL, updated_at = ?2
        WHERE id = ?3 AND account_id = ?4 AND delivery_state IN ('sending', 'unknown')`)
        .bind(receiptJson, new Date().toISOString(), archive.id, operation.account_id).run();
      if (!confirmed.meta.changes) {
        const current = await integrationArchiveFor(env.DB, operation);
        if (current?.delivery_state !== "confirmed" || current.receipt_json === null) {
          throw new IntegrationFailure(503, "archive_receipt_pending", "Telegram accepted the file, but its receipt still needs reconciliation.", true);
        }
      }
    } catch (error) {
      const definite = error instanceof IntegrationFailure || (error instanceof TelegramApiError && error.outcome === "rejected");
      const failure: IntegrationError = definite
        ? { code: "archive_failed", message: "Telegram did not accept the file. A controlled retry is available while the input is retained.", retryable: !(error instanceof IntegrationFailure) }
        : { code: "archive_unknown", message: "Telegram delivery is uncertain. Reply to the delivered document with /reconcile and the action ID before retrying.", retryable: false };
      await env.DB.prepare("UPDATE integration_archives SET delivery_state = ?1, error_json = ?2, updated_at = ?3 WHERE id = ?4 AND account_id = ?5 AND delivery_state = 'sending'")
        .bind(definite ? "failed" : "unknown", JSON.stringify(failure), new Date().toISOString(), archive.id, operation.account_id).run();
      return;
    }
  }
  const confirmed = await integrationArchiveFor(env.DB, operation);
  if (!confirmed || confirmed.delivery_state !== "confirmed" || confirmed.integrity_state === "verified" || input.media.byteLength > 20_000_000) return;
  const stillRequired = await env.DB.prepare(`SELECT 1 AS active FROM integration_accounts account
    WHERE account.id = ?1 AND account.status = 'active' AND EXISTS (
      SELECT 1 FROM integration_operations operation
      WHERE operation.account_id = account.id AND operation.archive_id = ?2
        AND operation.deleted_at IS NULL AND operation.expires_at > ?3
    )`).bind(operation.account_id, archive.id, new Date().toISOString()).first();
  if (!stillRequired) return;
  try {
    const receipt = JSON.parse(confirmed.receipt_json ?? "null") as { fileId: string };
    const bytes = await telegram.downloadFile(receipt.fileId, input.media.byteLength);
    const digest = hashIntegrationBytes(bytes); bytes.fill(0);
    const matches = digest === input.media.mediaSha256;
    await env.DB.prepare("UPDATE integration_archives SET integrity_state = ?1, round_trip_sha256 = ?2, error_json = ?3, updated_at = ?4 WHERE id = ?5 AND account_id = ?6 AND delivery_state = 'confirmed'")
      .bind(matches ? "verified" : "mismatch", digest, matches ? null : JSON.stringify({ code: "archive_hash_mismatch", message: "The retrieved Telegram document does not match the selected file.", retryable: false }), new Date().toISOString(), archive.id, operation.account_id).run();
  } catch {
    await env.DB.prepare("UPDATE integration_archives SET integrity_state = 'failed', error_json = ?1, updated_at = ?2 WHERE id = ?3 AND account_id = ?4 AND delivery_state = 'confirmed'")
      .bind(JSON.stringify({ code: "archive_integrity_unavailable", message: "Telegram confirmed delivery, but the retrieved file could not be verified.", retryable: true }), new Date().toISOString(), archive.id, operation.account_id).run();
  }
}

function integrationProcessingError(error: unknown): IntegrationError {
  return error instanceof IntegrationFailure
    ? { code: error.code, message: error.message, retryable: error.retryable }
    : { code: "processing_failed", message: "The action could not finish. A controlled retry is available while the input is retained.", retryable: true };
}

export async function processIntegrationOperation(env: IntegrationEnv, params: IntegrationWorkflowParams, step: IntegrationStep): Promise<void> {
  const { accountId, operationId, generation } = params;
  const claimed = await step.do("claim action", DATABASE_STEP, async () => {
    const claim = await env.DB.prepare(`UPDATE integration_operations SET status = 'processing', updated_at = ?1
      WHERE id = ?2 AND account_id = ?3 AND run_generation = ?4 AND status IN ('queued','processing') AND deleted_at IS NULL AND expires_at > ?1
      AND EXISTS (SELECT 1 FROM integration_accounts WHERE id = ?3 AND status = 'active')`)
      .bind(new Date().toISOString(), operationId, accountId, generation).run();
    return Boolean(claim.meta.changes);
  });
  if (!claimed) return;
  const preparationError = await step.do("prepare audio when needed", EFFECT_STEP, async () => {
    const operation = await getIntegrationOperation(env.DB, accountId, operationId);
    if (!operation || operation.deleted_at || operation.run_generation !== generation) return { code: "operation_deleted", message: "This action is no longer available.", retryable: false };
    if (operation.input_json) return null;
    try {
      const prepared = await prepareIntegrationAudio(env, operation);
      try {
        const object = await env.MEDIA_BUCKET.get(prepared.tempKey);
        if (!object) throw new IntegrationFailure(410, "media_expired", "The extracted audio is unavailable.");
        const bytes = await readIntegrationBytes(new Response(object.body), INTEGRATION_CHECK_BYTES);
        let validated: IntegrationInput;
        try { validated = await validateIntegrationCheck(env, accountId, prepared.input, bytes); }
        finally { bytes.fill(0); }
        await attachIntegrationMedia(env.DB, operation, validated, prepared.tempKey);
      } catch (error) { await env.MEDIA_BUCKET.delete(prepared.tempKey).catch(() => undefined); throw error; }
      return null;
    } catch (error) { return integrationProcessingError(error); }
  });
  const outcome = await step.do("verify exact media", EFFECT_STEP, async () => {
    if (preparationError) return { result: null, error: preparationError };
    const operation = await getIntegrationOperation(env.DB, accountId, operationId);
    if (!operation || operation.deleted_at || operation.run_generation !== generation) return { result: null, error: { code: "operation_deleted", message: "This action is no longer available.", retryable: false } };
    if (operation.action === "download" || operation.result_json) return { result: operation.result_json, error: null };
    try { return { result: await verifyIntegrationOperation(env, operation, JSON.parse(operation.input_json!) as IntegrationInput), error: null }; }
    catch (error) { return { result: null, error: integrationProcessingError(error) }; }
  });
  // Known limit: the reply target lives only in this run's params, which D1 never
  // stores, so a cron re-dispatch or a /checkretry run (a new instance) sends no
  // reply; the upgrade path is a nullable reply_to_message_id column. The step
  // runs before "save evidence" so a recovery restart from that step reuses this
  // checkpoint instead of sending the notice again.
  if (params.replyToMessageId !== undefined) await step.do("notify telegram", DATABASE_STEP, async () => {
    const operation = await getIntegrationOperation(env.DB, accountId, operationId);
    if (!operation?.input_json || operation.deleted_at || operation.run_generation !== generation) return;
    const account = await env.DB.prepare("SELECT telegram_chat_id FROM integration_accounts WHERE id = ?1 AND status = 'active'")
      .bind(accountId).first<{ telegram_chat_id: string }>();
    const payload = outcome.result ? JSON.parse(outcome.result) as { evidence: IntegrationVerifierResult } : outcome.error;
    if (!account || !payload) return;
    const text = checkVerdictText(payload, (JSON.parse(operation.input_json) as IntegrationInput).media.inputKind);
    // The outcome is checkpointed and History will show it; a lost notice never fails or repeats the action.
    try { await telegramClient(env, 15_000).sendMessage(account.telegram_chat_id, text, undefined, params.replyToMessageId); }
    catch { /* Telegram rejected or lost the notice. */ }
  });
  // The provider response is checkpointed before D1 persistence. A D1 outage
  // retries only this write and cannot turn completed evidence into a lost call.
  await step.do("save evidence", DATABASE_STEP, async () => {
    if (outcome.result) await env.DB.prepare(`UPDATE integration_operations SET result_json = ?1, updated_at = ?2
      WHERE id = ?3 AND account_id = ?4 AND run_generation = ?5 AND deleted_at IS NULL`)
      .bind(outcome.result, new Date().toISOString(), operationId, accountId, generation).run();
  });
  await step.do("archive original independently", EFFECT_STEP, async () => {
    const operation = await getIntegrationOperation(env.DB, accountId, operationId);
    if (operation?.input_json && !operation.deleted_at && operation.run_generation === generation) {
      await archiveIntegrationImage(env, operation, JSON.parse(operation.input_json) as IntegrationInput);
    }
  });
  await step.do("finish action", DATABASE_STEP, async () => {
    const operation = await getIntegrationOperation(env.DB, accountId, operationId);
    if (!operation || operation.deleted_at || operation.run_generation !== generation) return;
    const archive = await integrationArchiveFor(env.DB, operation);
    const error = outcome.error ?? (operation.action === "download" && archive?.delivery_state !== "confirmed"
      ? { code: archive?.delivery_state === "unknown" || archive?.delivery_state === "sending" ? "archive_unknown" : "archive_failed",
        message: "The download has no confirmed Telegram delivery. See its archive status before retrying.", retryable: archive?.delivery_state === "failed" }
      : null);
    await env.DB.prepare(`UPDATE integration_operations SET status = ?1, error_json = ?2,
      source_cipher = CASE WHEN input_json IS NOT NULL OR ?1 = 'completed' THEN NULL ELSE source_cipher END, updated_at = ?3
      WHERE id = ?4 AND account_id = ?5 AND run_generation = ?6 AND deleted_at IS NULL`)
      .bind(error ? "failed" : "completed", error ? JSON.stringify(error) : null, new Date().toISOString(), operationId, accountId, generation).run();
    const confirmedLargeDownload = operation.action === "download" && archive?.delivery_state === "confirmed"
      && JSON.parse(operation.input_json!).media.byteLength > 20_000_000;
    if (!error && operation.temp_key && (!archive || archive.integrity_state === "verified" || confirmedLargeDownload)) {
      await env.MEDIA_BUCKET.delete(operation.temp_key);
      await env.DB.prepare("UPDATE integration_operations SET temp_key = NULL, reserved_bytes = 0 WHERE id = ?1 AND account_id = ?2 AND temp_key = ?3")
        .bind(operationId, accountId, operation.temp_key).run();
    }
  });
}

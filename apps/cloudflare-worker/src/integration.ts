import { readIntegrationJson } from "./integration-io";
import { createLensLinkDownload } from "./integration-link";
import { authenticateIntegrationRequest, handleIntegrationAuth } from "./integration-auth";
import { getWorkerConfig } from "./config";
import { encryptSourceUrl, hmacSha256Hex } from "./crypto";
import { base64UrlToBytes, bytesToBase64Url } from "./security";
import { activityWindow, parseActivityPeriod } from "./stats";
import { TelegramClient } from "./telegram";
import { validateSourceUrl } from "./url";
import {
  IntegrationFailure, SHA256, getIntegrationOperation, integrationArchiveFor, integrationId,
  integrationOperationSnapshot, integrationSegment, parseIntegrationInput, registerIntegrationOperation,
  validateIntegrationCreatedAt, type IntegrationAccount, type IntegrationOperation,
} from "./integration-store";
import {
  dispatchIntegrationOperation, privateVerifierRequest, storeIntegrationUpload, type IntegrationEnv,
} from "./integration-media";

export type IntegrationGatewayEnv = IntegrationEnv & { INTEGRATION_ALLOWED_ORIGINS?: string };
const PREFIX = "/api/integration";
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/u;
const CORS_HEADERS = "Authorization, Content-Type, X-Integration-Client-Origin, X-Integration-Created-At";

export function integrationJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

/** Origin is CSRF/compatibility metadata, never an authenticated account. */
export function integrationOriginAllowed(request: Request, env: IntegrationGatewayEnv): boolean {
  const values = (env.INTEGRATION_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim());
  if (!values.length || values.some((value) => !EXTENSION_ORIGIN.test(value))) return false;
  const origin = request.headers.get("origin");
  const declared = request.headers.get("x-integration-client-origin");
  if (origin !== null && declared !== null && origin !== declared) return false;
  const effective = origin ?? declared;
  if (effective !== null && values.includes(effective)) return true;
  const isAuthRoute = /^\/api\/integration\/(?:pairings(?:\/[^/]+\/exchange)?|sessions\/refresh)$/u.test(new URL(request.url).pathname);
  if (isAuthRoute) return false;
  const authorization = request.headers.get("authorization") ?? "";
  if (origin === new URL(env.PUBLIC_WORKER_BASE_URL).origin && /^tma /iu.test(authorization)) return true;
  return origin === null && declared === null && /^(?:Bearer |tma )/iu.test(authorization);
}

function cors(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Vary", "Origin");
  const origin = request.headers.get("origin");
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", CORS_HEADERS);
  return new Response(response.body, { status: response.status, headers });
}

export async function handleIntegrationRequest(
  request: Request,
  env: IntegrationGatewayEnv,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;
  if (env.INTEGRATION_ENABLED !== "true") return integrationJson({ error: { code: "integration_disabled", message: "Connected media features are not enabled.", retryable: false } }, 404);
  if (!integrationOriginAllowed(request, env)) return integrationJson({ error: { code: "origin_denied", message: "This client origin is not allowed.", retryable: false } }, 403);
  if (request.method === "OPTIONS") return cors(request, new Response(null, { status: 204 }));
  try {
    const authResponse = await handleIntegrationAuth(request, env);
    if (authResponse) return cors(request, authResponse);
    const authentication = await authenticateIntegrationRequest(request, env);
    if (!authentication.ok) throw new IntegrationFailure(authentication.status, authentication.code, "Link this device to DigiBot, or sign in again.", authentication.status === 429);
    const { accountId, telegramUserId, chatId } = authentication.principal;
    const account: IntegrationAccount = { accountId, telegramUserId, chatId };
    const path = url.pathname.slice(PREFIX.length);
    let response: Response;
    if (path === "/account" && request.method === "GET") {
      response = integrationJson({ accountId, sessionId: authentication.principal.sessionId, legacyAccess: authentication.principal.admissionSource === "legacy_allowlist" });
    } else if (path === "/operations" && request.method === "POST") {
      const input = parseIntegrationInput(await readIntegrationJson(request), Math.min(getWorkerConfig(env).maxTelegramBytes, 49_000_000));
      const operation = await registerIntegrationOperation(env.DB, account, { input }, validateIntegrationCreatedAt(request.headers.get("x-integration-created-at")));
      response = integrationJson(await integrationOperationSnapshot(env.DB, operation), operation.status === "awaiting_upload" ? 201 : 200);
    } else if (path === "/audio-segments" && request.method === "POST") {
      const body = await readIntegrationJson(request) as Record<string, unknown> | null;
      if (!body || Array.isArray(body) || Object.keys(body).some((key) => !["operationId", "sourceUrl", "startSeconds", "endSeconds"].includes(key))
        || !integrationId(body.operationId) || typeof body.sourceUrl !== "string") throw new IntegrationFailure(400, "invalid_request", "Choose one supported source and audio range.");
      const segment = integrationSegment({ startSeconds: body.startSeconds, endSeconds: body.endSeconds });
      if (!segment) throw new IntegrationFailure(400, "invalid_range", "Choose a forward audio range of no more than 60 seconds.");
      let source;
      try { source = validateSourceUrl(body.sourceUrl, getWorkerConfig(env)); }
      catch { throw new IntegrationFailure(400, "unsupported_source", "This video source is not supported."); }
      const operation = await registerIntegrationOperation(env.DB, account, {
        operationId: body.operationId, segment,
        sourceCipher: await encryptSourceUrl(env.DOWNLOAD_LINK_HMAC_SECRET, source.url),
        sourceHash: await hmacSha256Hex(env.DOWNLOAD_LINK_HMAC_SECRET, source.url),
      }, validateIntegrationCreatedAt(request.headers.get("x-integration-created-at")));
      if (operation.status === "queued") await dispatchIntegrationOperation(env, operation);
      response = integrationJson(await integrationOperationSnapshot(env.DB, operation), 202);
    } else if (path === "/link-downloads" && request.method === "POST") {
      response = integrationJson(await createLensLinkDownload(request, env, authentication.principal, waitUntil), 202);
    } else if (path === "/history" && request.method === "GET") {
      response = integrationJson(await integrationHistory(env, account, url));
    } else if (path === "/stats" && request.method === "GET") {
      response = integrationJson(await integrationStats(env, account, url.searchParams.get("period")));
    } else if (path === "/cache" && request.method === "DELETE") {
      const cleared = await privateVerifierRequest(env, accountId, "/cache/clear", "{}");
      if (!cleared.ok) throw new IntegrationFailure(503, "cache_unavailable", "The cache could not be cleared.", true);
      response = integrationJson({ ok: true });
    } else {
      const operationMatch = path.match(/^\/operations\/([^/]+)(?:\/(media|retry))?$/u);
      const historyMatch = path.match(/^\/history\/([^/]+)$/u);
      const mediaMatch = path.match(/^\/media\/([a-f0-9]{64})(\/archive)?$/u);
      if (operationMatch && integrationId(operationMatch[1])) {
        const operation = await ownedOperation(env, account, operationMatch[1]);
        if (!operationMatch[2] && request.method === "GET") response = integrationJson(await integrationOperationSnapshot(env.DB, operation));
        else if (operationMatch[2] === "media" && request.method === "PUT") {
          await storeIntegrationUpload(env, account, operation, request);
          const admitted = await ownedOperation(env, account, operation.id);
          if (admitted.status === "queued") await dispatchIntegrationOperation(env, admitted);
          response = integrationJson(await integrationOperationSnapshot(env.DB, admitted), 202);
        } else if (operationMatch[2] === "retry" && request.method === "POST") {
          response = integrationJson(await retryIntegrationOperation(env, account, operation), 202);
        } else throw new IntegrationFailure(405, "method_not_allowed", "Method not allowed.");
      } else if (historyMatch && integrationId(historyMatch[1]) && request.method === "DELETE") {
        await deleteIntegrationHistory(env, account, [await ownedOperation(env, account, historyMatch[1])]);
        response = integrationJson({ ok: true });
      } else if (mediaMatch && SHA256.test(mediaMatch[1] ?? "") && request.method === "DELETE") {
        if (mediaMatch[2]) await deleteIntegrationArchive(env, account, mediaMatch[1]!);
        else {
          const rows = await env.DB.prepare("SELECT * FROM integration_operations WHERE account_id = ?1 AND media_sha256 = ?2 AND deleted_at IS NULL")
            .bind(accountId, mediaMatch[1]).all<IntegrationOperation>();
          if (!rows.results.length) throw new IntegrationFailure(404, "not_found", "Media not found.");
          await deleteIntegrationHistory(env, account, rows.results);
          const cleared = await privateVerifierRequest(env, accountId, "/cache/clear", "{}");
          if (!cleared.ok) throw new IntegrationFailure(503, "cache_clear_pending", "History was removed; the separate cache clear needs retry.", true);
        }
        response = integrationJson({ ok: true });
      } else throw new IntegrationFailure(404, "not_found", "Integration route not found.");
    }
    return cors(request, response);
  } catch (error) {
    const failure = error instanceof IntegrationFailure ? error : new IntegrationFailure(503, "integration_unavailable", "The connected service is temporarily unavailable.", true);
    return cors(request, integrationJson({ error: { code: failure.code, message: failure.message, retryable: failure.retryable } }, failure.status));
  }
}

async function ownedOperation(env: IntegrationEnv, account: IntegrationAccount, id: string): Promise<IntegrationOperation> {
  const operation = await getIntegrationOperation(env.DB, account.accountId, id);
  if (!operation) throw new IntegrationFailure(404, "not_found", "Action not found.");
  if (operation.deleted_at) throw new IntegrationFailure(410, "operation_deleted", "This action was deleted.");
  return operation;
}

export async function integrationHistory(env: IntegrationEnv, account: IntegrationAccount, url: URL) {
  const period = parseActivityPeriod(url.searchParams.get("period"));
  if (!period) throw new IntegrationFailure(400, "invalid_period", "Choose 24h, 7d, 30d, or all.");
  type HistoryCursor = { requestedAt: string; id: string; asOf: string };
  let cursor: HistoryCursor | null = null;
  const encoded = url.searchParams.get("cursor");
  if (encoded) {
    try {
      if (encoded.length > 1024) throw new Error("cursor");
      const bytes = base64UrlToBytes(encoded);
      cursor = bytes ? JSON.parse(new TextDecoder().decode(bytes)) as HistoryCursor : null;
      if (!cursor || !integrationId(cursor.id) || !Number.isFinite(Date.parse(cursor.requestedAt)) || !Number.isFinite(Date.parse(cursor.asOf))) throw new Error("cursor");
    } catch { throw new IntegrationFailure(400, "invalid_cursor", "Invalid History cursor."); }
  }
  const window = activityWindow({ period, ...(cursor ? { asOf: cursor.asOf } : {}) });
  const rows = await env.DB.prepare(`SELECT * FROM integration_operations WHERE account_id = ?1 AND deleted_at IS NULL
    AND admitted_at IS NOT NULL AND requested_at <= ?2 AND (?3 IS NULL OR requested_at >= ?3)
    AND (?4 IS NULL OR requested_at < ?4 OR (requested_at = ?4 AND id < ?5)) ORDER BY requested_at DESC, id DESC LIMIT 51`)
    .bind(account.accountId, window.asOf, window.since, cursor?.requestedAt ?? null, cursor?.id ?? null).all<IntegrationOperation>();
  const page = rows.results.slice(0, 50);
  const last = page.at(-1);
  return {
    operations: await Promise.all(page.map((row) => integrationOperationSnapshot(env.DB, row))),
    nextCursor: rows.results.length > 50 && last ? bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ requestedAt: last.requested_at, id: last.id, asOf: window.asOf }))) : null,
  };
}

export async function integrationStats(env: IntegrationEnv, account: IntegrationAccount, periodValue: string | null) {
  const period = parseActivityPeriod(periodValue);
  if (!period) throw new IntegrationFailure(400, "invalid_period", "Choose 24h, 7d, 30d, or all.");
  const window = activityWindow({ period });
  type CountKey = "checksRequested" | "checksCompleted" | "checksFailed" | "freshChecks" | "cachedChecks" | "downloadsRequested" | "downloadsConfirmed" | "downloadsFailed" | "uniqueMedia" | "savedOriginals" | "unresolvedArchives";
  const rows = await env.DB.prepare(`SELECT
    COUNT(CASE WHEN o.action = 'check' THEN 1 END) AS checksRequested,
    COUNT(CASE WHEN o.action = 'check' AND o.result_json IS NOT NULL THEN 1 END) AS checksCompleted,
    COUNT(CASE WHEN o.action = 'check' AND o.status = 'failed' AND o.result_json IS NULL THEN 1 END) AS checksFailed,
    COUNT(CASE WHEN o.action = 'check' AND json_extract(o.result_json, '$.cacheSource') = 'fresh' THEN 1 END) AS freshChecks,
    COUNT(CASE WHEN o.action = 'check' AND json_extract(o.result_json, '$.cacheSource') IN ('local_cache','server_cache') THEN 1 END) AS cachedChecks,
    COUNT(CASE WHEN o.action = 'download' THEN 1 END) AS downloadsRequested,
    COUNT(CASE WHEN o.action = 'download' AND (a.delivery_state = 'confirmed' OR json_extract(a.error_json, '$.code') = 'archive_deleted') THEN 1 END) AS downloadsConfirmed,
    COUNT(CASE WHEN o.action = 'download' AND a.delivery_state = 'failed' AND COALESCE(json_extract(a.error_json, '$.code'), '') <> 'archive_deleted' THEN 1 END) AS downloadsFailed,
    COUNT(DISTINCT o.media_sha256) AS uniqueMedia,
    COUNT(DISTINCT CASE WHEN a.integrity_state = 'verified' THEN o.media_sha256 END) AS savedOriginals,
    COUNT(DISTINCT CASE WHEN a.delivery_state = 'unknown' THEN a.id END) AS unresolvedArchives
    FROM integration_operations o LEFT JOIN integration_archives a ON a.id = o.archive_id AND a.account_id = o.account_id
    WHERE o.account_id = ?1 AND o.admitted_at IS NOT NULL AND o.deleted_at IS NULL AND o.requested_at <= ?2 AND (?3 IS NULL OR o.requested_at >= ?3)`)
    .bind(account.accountId, window.asOf, window.since).first<Record<CountKey, number>>();
  if (!rows) throw new IntegrationFailure(503, "stats_unavailable", "Statistics are temporarily unavailable.", true);
  const legacy = await env.DB.prepare(`SELECT COUNT(*) AS total FROM jobs WHERE telegram_user_id = ?1
    AND COALESCE(requested_operation, 'download') = 'download' AND created_at <= ?2 AND (?3 IS NULL OR created_at >= ?3)`)
    .bind(account.telegramUserId, window.asOf, window.since).first<{ total: number }>();
  return { period, since: window.since, asOf: window.asOf, ...rows, legacyDownloads: legacy?.total ?? 0 };
}

export async function deleteIntegrationHistory(env: IntegrationEnv, account: IntegrationAccount, operations: IntegrationOperation[]): Promise<void> {
  const ids = [...new Set(operations.map((operation) => operation.id))];
  if (!ids.length) return;
  if (operations.some((operation) => operation.account_id !== account.accountId)) {
    throw new IntegrationFailure(404, "not_found", "Action not found.");
  }
  const placeholders = ids.map((_, index) => `?${index + 2}`).join(",");
  const now = new Date().toISOString();
  const deleted = await env.DB.batch([
    env.DB.prepare(`UPDATE integration_operations SET deleted_at = ?${ids.length + 2}, input_json = NULL, result_json = NULL,
      source_cipher = NULL, segment_json = NULL, error_json = NULL, updated_at = ?${ids.length + 2}
      WHERE account_id = ?1 AND id IN (${placeholders}) AND deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM integration_operations target
        JOIN integration_archives archive ON archive.id = target.archive_id AND archive.account_id = target.account_id
        WHERE target.account_id = ?1 AND target.id IN (${placeholders}) AND target.deleted_at IS NULL
          AND archive.delivery_state IN ('sending', 'unknown')
          AND NOT EXISTS (
            SELECT 1 FROM integration_operations survivor
            WHERE survivor.account_id = ?1 AND survivor.archive_id = archive.id AND survivor.deleted_at IS NULL
              AND survivor.id NOT IN (${placeholders})
          )
      )`).bind(account.accountId, ...ids, now),
    env.DB.prepare(`UPDATE integration_archives SET delivery_state = 'failed', receipt_json = NULL,
      integrity_state = 'not_checked', round_trip_sha256 = NULL, attempt_started_at = NULL,
      error_json = ?1, updated_at = ?2
      WHERE account_id = ?3 AND delivery_state = 'pending'
        AND id IN (SELECT archive_id FROM integration_operations WHERE account_id = ?3 AND id IN (${ids.map((_, index) => `?${index + 4}`).join(",")}) AND archive_id IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM integration_operations survivor
          WHERE survivor.account_id = ?3 AND survivor.archive_id = integration_archives.id AND survivor.deleted_at IS NULL
        )`).bind(
      JSON.stringify({ code: "archive_canceled", message: "Pending Telegram delivery was canceled with History deletion.", retryable: false }),
      now,
      account.accountId,
      ...ids,
    ),
  ]);
  if ((deleted[0]?.meta?.changes ?? 0) !== ids.length) {
    throw new IntegrationFailure(409, "archive_reconciliation_required", "Telegram delivery is in progress or uncertain. Reconcile it before deleting History.");
  }

  const rows = await env.DB.prepare(`SELECT id, temp_key, upload_token FROM integration_operations
    WHERE account_id = ?1 AND id IN (${placeholders})`).bind(account.accountId, ...ids)
    .all<Pick<IntegrationOperation, "id" | "temp_key" | "upload_token">>();
  for (const operation of rows.results) {
    if (operation.temp_key) {
      await env.MEDIA_BUCKET.delete(operation.temp_key);
      await env.DB.prepare("UPDATE integration_operations SET temp_key = NULL, reserved_bytes = 0 WHERE id = ?1 AND account_id = ?2 AND temp_key = ?3")
        .bind(operation.id, account.accountId, operation.temp_key).run();
    } else {
      await env.DB.prepare("UPDATE integration_operations SET reserved_bytes = 0 WHERE id = ?1 AND account_id = ?2 AND temp_key IS NULL AND upload_token IS NULL")
        .bind(operation.id, account.accountId).run();
    }
  }
}

async function deleteIntegrationArchive(env: IntegrationEnv, account: IntegrationAccount, sha256: string): Promise<void> {
  // A receipt with sender "user" is the image message the user sent for a Telegram check. Bots can delete incoming
  // private messages for 48 hours, so it is never a deletion target; only bot-sent documents are.
  const archives = await env.DB.prepare(`SELECT DISTINCT a.id, a.receipt_json FROM integration_archives a
    WHERE a.account_id = ?1 AND a.media_sha256 = ?2 AND a.delivery_state = 'confirmed' AND a.receipt_json IS NOT NULL
      AND json_extract(a.receipt_json, '$.sender') IS NULL`)
    .bind(account.accountId, sha256).all<{ id: string; receipt_json: string }>();
  if (!archives.results.length) throw new IntegrationFailure(404, "not_found", "No saved document sent by the bot was found. A copy you sent yourself stays in Telegram.");
  const telegram = new TelegramClient({ token: env.TELEGRAM_BOT_TOKEN, apiBase: getWorkerConfig(env).telegramApiBase });
  for (const archive of archives.results) {
    const receipt = JSON.parse(archive.receipt_json) as { chatId: string; messageId: string };
    if (receipt.chatId !== account.chatId) throw new IntegrationFailure(403, "forbidden", "This saved document belongs to another chat.");
    try {
      if (!await telegram.deleteMessage(receipt.chatId, receipt.messageId)) throw new Error("delete refused");
    } catch { throw new IntegrationFailure(409, "telegram_delete_failed", "Telegram could not remove the saved document. History deletion is separate; older documents may need manual deletion in Telegram."); }
    await env.DB.prepare(`UPDATE integration_archives SET delivery_state = 'failed', receipt_json = NULL, integrity_state = 'not_checked', round_trip_sha256 = NULL,
      error_json = ?1, updated_at = ?2 WHERE id = ?3 AND account_id = ?4`)
      .bind(JSON.stringify({ code: "archive_deleted", message: "The saved Telegram document was deleted.", retryable: false }), new Date().toISOString(), archive.id, account.accountId).run();
  }
}

export async function retryIntegrationOperation(env: IntegrationEnv, account: IntegrationAccount, operation: IntegrationOperation) {
  const archive = await integrationArchiveFor(env.DB, operation);
  if (!operation.admitted_at) throw new IntegrationFailure(409, "retry_unavailable", "This upload was not admitted. Select the exact file to start a new action.");
  if (archive?.delivery_state === "unknown" || archive?.delivery_state === "sending") throw new IntegrationFailure(409, "archive_unknown", "Reconcile the delivered document before another send.");
  if (operation.status === "processing" || operation.status === "queued") return integrationOperationSnapshot(env.DB, operation);
  if (operation.status === "completed" && (!archive || (archive.delivery_state === "confirmed" && archive.integrity_state !== "failed"))) return integrationOperationSnapshot(env.DB, operation);
  if (Date.parse(operation.expires_at) <= Date.now() || (!operation.temp_key && !operation.source_cipher && archive?.delivery_state !== "confirmed")) throw new IntegrationFailure(410, "media_expired", "Select the exact file again to start a new action.");
  const now = new Date().toISOString();
  const statements = [];
  // Known limit: a Telegram-started check whose bytes already had a 'sending' row (a concurrent Lens Check of the same
  // image) never applied its user receipt; when that send then fails retryably, this reset lets the retried run
  // send the document after all, with an ordinary bot receipt. Accepted edge: the saved copy exists only in the
  // admission call, so re-applying it here would mean keeping it on the operation (input_json or a column) and
  // stripping it from every snapshot Lens parses strictly.
  if (archive?.delivery_state === "failed") {
    const error = JSON.parse(archive.error_json ?? "null") as { retryable?: boolean } | null;
    if (!error?.retryable) throw new IntegrationFailure(409, "retry_unavailable", "This delivery cannot be retried automatically.");
    statements.push(env.DB.prepare(`UPDATE integration_archives SET delivery_state = 'pending', error_json = NULL, updated_at = ?1
      WHERE id = ?2 AND account_id = ?3 AND delivery_state = 'failed'
      AND EXISTS (SELECT 1 FROM integration_operations WHERE id = ?4 AND account_id = ?3 AND run_generation = ?5 AND status IN ('failed','completed') AND deleted_at IS NULL AND expires_at > ?1)`)
      .bind(now, archive.id, account.accountId, operation.id, operation.run_generation));
  }
  statements.push(env.DB.prepare(`UPDATE integration_operations SET status = 'queued', error_json = NULL, provider_started_at = NULL,
    run_generation = run_generation + 1, updated_at = ?1 WHERE id = ?2 AND account_id = ?3 AND run_generation = ?4
    AND status IN ('failed','completed') AND deleted_at IS NULL AND expires_at > ?1`)
    .bind(now, operation.id, account.accountId, operation.run_generation));
  await env.DB.batch(statements);
  const next = await ownedOperation(env, account, operation.id);
  if (next.status === "queued") await dispatchIntegrationOperation(env, next);
  return integrationOperationSnapshot(env.DB, next);
}

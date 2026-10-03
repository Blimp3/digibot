import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { dispatchIntegrationOperation, integrationWorkflowId, processIntegrationOperation,
  type IntegrationEnv, type IntegrationStep, type IntegrationWorkflowParams } from "./integration-media";
import { INTEGRATION_REPLAY_MS, INTEGRATION_TEMP_MS, type IntegrationOperation } from "./integration-store";

export class IntegrationWorkflow extends WorkflowEntrypoint<IntegrationEnv, IntegrationWorkflowParams> {
  async run(event: WorkflowEvent<IntegrationWorkflowParams>, step: WorkflowStep): Promise<void> {
    await processIntegrationOperation(this.env, event.payload, step as unknown as IntegrationStep);
  }
}

/** Recovery never repeats an uncertain external side effect. */
export async function recoverIntegrationOperations(env: IntegrationEnv): Promise<void> {
  if (env.INTEGRATION_ENABLED !== "true" || !env.INTEGRATION_WORKFLOW) return;
  const now = new Date().toISOString();
  const rows = await env.DB.prepare(`SELECT * FROM integration_operations WHERE deleted_at IS NULL
    AND expires_at > ?1 AND status IN ('queued','processing') ORDER BY updated_at LIMIT 50`).bind(now).all<IntegrationOperation>();
  for (const operation of rows.results) {
    if (operation.status === "queued") { await dispatchIntegrationOperation(env, operation); continue; }
    if (Date.parse(operation.updated_at) > Date.now() - 30 * 60_000) continue;
    let state: string;
    try { state = (await (await env.INTEGRATION_WORKFLOW.get(integrationWorkflowId(operation))).status()).status; }
    catch { continue; }
    if (!["errored", "terminated", "complete"].includes(state)) continue;
    const claimed = await env.DB.prepare(`UPDATE integration_operations SET updated_at = ?1
      WHERE id = ?2 AND account_id = ?3 AND run_generation = ?4 AND updated_at = ?5 AND status = 'processing'
        AND deleted_at IS NULL AND expires_at > ?1
        AND EXISTS (SELECT 1 FROM integration_accounts WHERE id = ?3 AND status = 'active')`)
      .bind(now, operation.id, operation.account_id, operation.run_generation, operation.updated_at).run();
    if (!claimed.meta.changes) continue;
    await env.DB.prepare(`UPDATE integration_archives SET delivery_state = 'unknown', error_json = ?1, updated_at = ?2
      WHERE id = ?3 AND account_id = ?4 AND delivery_state = 'sending'`)
      .bind(JSON.stringify({ code: "archive_unknown", message: "Delivery was interrupted. Reconcile the Telegram document before retrying.", retryable: false }), now, operation.archive_id, operation.account_id).run();
    if (state === "errored" && operation.provider_started_at && !operation.result_json) {
      try {
        // Reuse the durable provider outcome; never restart the paid check or
        // extraction. A missing checkpoint falls through to controlled retry.
        await (await env.INTEGRATION_WORKFLOW.get(integrationWorkflowId(operation))).restart({ from: { name: "save evidence" } });
        continue;
      } catch { /* The platform may have no completed evidence checkpoint. */ }
    }
    await env.DB.prepare(`UPDATE integration_operations SET status = 'failed', error_json = ?1, updated_at = ?2
        WHERE id = ?3 AND account_id = ?4 AND run_generation = ?5 AND status = 'processing' AND deleted_at IS NULL`)
      .bind(JSON.stringify({ code: "processing_interrupted", message: "Processing stopped. Any completed evidence is retained; review the archive status before a controlled retry.", retryable: true }), now, operation.id, operation.account_id, operation.run_generation).run();
  }
}

/** Expiry denies new work immediately; this sweep removes retained bytes. */
export async function cleanupIntegrationMedia(env: IntegrationEnv): Promise<void> {
  const now = new Date().toISOString();
  const expired = await env.DB.prepare(`SELECT * FROM integration_operations WHERE (expires_at <= ?1 OR deleted_at IS NOT NULL)
    AND (upload_started_at IS NULL OR upload_started_at < ?2)
    AND (temp_key IS NOT NULL OR source_cipher IS NOT NULL OR reserved_bytes > 0 OR status IN ('awaiting_upload','queued','processing')) LIMIT 100`)
    .bind(now, new Date(Date.now() - 120_000).toISOString()).all<IntegrationOperation>();
  for (const operation of expired.results) {
    if (operation.temp_key) await env.MEDIA_BUCKET.delete(operation.temp_key);
    await env.DB.batch([
      env.DB.prepare(`UPDATE integration_archives SET delivery_state = 'unknown', error_json = ?1, updated_at = ?2
        WHERE id = ?3 AND account_id = ?4 AND delivery_state = 'sending'`)
        .bind(JSON.stringify({ code: "archive_unknown", message: "Delivery is uncertain and temporary media expired. Reconcile the existing document; do not resend this action.", retryable: false }), now, operation.archive_id, operation.account_id),
      env.DB.prepare(`UPDATE integration_archives SET delivery_state = 'failed', error_json = ?1, updated_at = ?2
        WHERE id = ?3 AND account_id = ?4 AND delivery_state = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM integration_operations live
            WHERE live.account_id = ?4 AND live.archive_id = ?3 AND live.deleted_at IS NULL
              AND live.expires_at > ?2 AND live.temp_key IS NOT NULL
          )`)
        .bind(JSON.stringify({ code: "archive_expired", message: "Temporary media expired before Telegram delivery could start.", retryable: false }), now, operation.archive_id, operation.account_id),
      env.DB.prepare(`UPDATE integration_operations SET temp_key = NULL, source_cipher = NULL, reserved_bytes = 0, upload_token = NULL, upload_started_at = NULL,
        error_json = CASE WHEN status IN ('awaiting_upload','queued','processing') THEN ?1 ELSE error_json END,
        status = CASE WHEN status IN ('awaiting_upload','queued','processing') THEN 'failed' ELSE status END, updated_at = ?2
        WHERE id = ?3 AND account_id = ?4`)
        .bind(JSON.stringify({ code: "operation_expired", message: "Temporary media expired. Select the file again to start a new action.", retryable: false }), now, operation.id, operation.account_id),
    ]);
  }
  // Also reap abandoned uploads that never reached D1 admission. No signed
  // object URL is exposed; the prefix is private to this application.
  // Known limit: scan this small invited-user namespace; use an R2 lifecycle rule
  // if its object count makes a full scheduled scan expensive.
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA_BUCKET.list({ prefix: "integration/", limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const object of page.objects) if (object.uploaded.getTime() <= Date.now() - INTEGRATION_TEMP_MS) await env.MEDIA_BUCKET.delete(object.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM integration_rate_limits WHERE expires_at < ?1").bind(Math.floor(Date.now() / 1000)),
    env.DB.prepare("DELETE FROM integration_pairing_claims WHERE pairing_id IN (SELECT id FROM integration_pairings WHERE expires_at < ?1)").bind(Math.floor(Date.now() / 1000)),
    env.DB.prepare("DELETE FROM integration_pairings WHERE expires_at < ?1").bind(Math.floor(Date.now() / 1000)),
    env.DB.prepare("DELETE FROM integration_sessions WHERE absolute_expires_at < ?1 OR revoked_at < ?1").bind(Math.floor((Date.now() - INTEGRATION_REPLAY_MS) / 1000)),
    env.DB.prepare("DELETE FROM integration_operations WHERE deleted_at < ?1 AND temp_key IS NULL")
      .bind(new Date(Date.now() - INTEGRATION_REPLAY_MS).toISOString()),
    env.DB.prepare(`DELETE FROM integration_media WHERE NOT EXISTS
      (SELECT 1 FROM integration_operations o WHERE o.account_id = integration_media.account_id AND o.media_sha256 = integration_media.sha256)
      AND NOT EXISTS (SELECT 1 FROM integration_archives a WHERE a.account_id = integration_media.account_id AND a.media_sha256 = integration_media.sha256)`),
  ]);
}

import {
  claimDueDispatchIntent,
  confirmedDeliveryMessageIds,
  telegramMessageIds,
  getJob,
  getJobDelivery,
  listStartedDispatchIntents,
  markConfirmedDeliveryConflict,
  markDeliveryUnknown,
  markDispatchComplete,
  markDispatchStarted,
  positiveTelegramMessageId,
  positiveRetryAfterSeconds,
  recordDeliveryConfirmed,
  recordDeliveryRejected,
  rescheduleDispatchIntent,
  setJobCompleted,
  setJobFailure,
} from "./db";
import { clipCountForJob } from "./trim";
import { getWorkerConfig } from "./config";
import { isErrorCode, safeMessageForError, type ErrorCode } from "./errors";
import { logStructured } from "./logging";
import { sanitizeFilename } from "./security";
import type {
  DeliveryMethod,
  DispatchIntentRecord,
  Env,
  JobDeliveryRecord,
  JobRecord,
  WorkflowBindingLike,
  WorkflowInstanceLike,
  WorkflowInstanceStatusLike,
} from "./types";

/** Keep a dispatch claim short; recovery observes the Workflow instead of releasing by age. */
export const DISPATCH_LEASE_SECONDS = 60;
export const DISPATCH_RECOVERY_LIMIT = 20;

const MAX_DISPATCH_BACKOFF_SECONDS = 60;
const WORKFLOW_RPC_TIMEOUT_MS = 10_000;
const MAX_SAFE_OUTPUT_BYTES = 2_000_000_000;

export interface ReconciledWorkflowDelivery {
  method: DeliveryMethod;
  telegramMessageId: string;
  telegramMessageIds?: string[];
  objectKey: string | null;
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  expiresAt: string | null;
}

export type WorkflowResultKind =
  | { kind: "confirmed"; delivery: ReconciledWorkflowDelivery }
  | { kind: "rejected"; errorCode: ErrorCode; retryAfterSeconds?: number }
  | { kind: "unknown" };

function workflowBinding(env: Env): WorkflowBindingLike | null {
  return (env.MEDIA_WORKFLOW as unknown as WorkflowBindingLike | undefined) ?? null;
}

function backoffSeconds(attempts: number): number {
  const exponent = Number.isSafeInteger(attempts) && attempts > 0 ? Math.min(attempts - 1, 5) : 0;
  return Math.min(MAX_DISPATCH_BACKOFF_SECONDS, 2 ** exponent);
}

function nextAttemptAt(now: Date, attempts: number): string {
  return new Date(now.getTime() + backoffSeconds(attempts) * 1_000).toISOString();
}

function isWorkflowInstance(value: unknown): value is WorkflowInstanceLike {
  return typeof value === "object" && value !== null
    && typeof (value as { status?: unknown }).status === "function";
}

async function boundedWorkflowCall<T>(operation: () => Promise<T>, timeoutMs = WORKFLOW_RPC_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("WORKFLOW_RPC_TIMEOUT")), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isWorkflowMissingError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  if (candidate.status === 404 || candidate.code === 404) return true;
  return typeof candidate.message === "string" && /(?:not[ -]?found|does not exist|unknown instance)/iu.test(candidate.message);
}

async function existingWorkflowInstance(binding: WorkflowBindingLike, jobId: string): Promise<WorkflowInstanceLike | null> {
  if (!binding.get) return null;
  try {
    const instance = await boundedWorkflowCall(() => binding.get!(jobId));
    if (!isWorkflowInstance(instance)) return null;
    const status = await boundedWorkflowCall(() => instance.status());
    return status.status === "unknown" ? null : instance;
  } catch {
    return null;
  }
}

/**
 * Start the existing Workflow instance for a claimed intent. A rejected create
 * is followed by get(id), because the create may have committed before its
 * response was lost. The stable job ID is never replaced with a new one.
 */
async function startClaim(env: Env, intent: DispatchIntentRecord, now: Date): Promise<void> {
  const binding = workflowBinding(env);
  if (!binding || (!binding.createBatch && !binding.create)) {
    await rescheduleDispatchIntent(
      env.DB,
      intent.job_id,
      intent.generation,
      nextAttemptAt(now, intent.attempts),
      "WORKFLOW_UNAVAILABLE",
      "Workflow binding is unavailable.",
    );
    return;
  }

  let instance: WorkflowInstanceLike | null = null;
  try {
    if (binding.createBatch) {
      const result = await boundedWorkflowCall(() => binding.createBatch!([{ id: intent.workflow_instance_id, params: { jobId: intent.job_id } }]));
      if (isWorkflowInstance(result)) instance = result;
      else if (Array.isArray(result) && isWorkflowInstance(result[0])) instance = result[0];
    } else if (binding.create) {
      const result = await boundedWorkflowCall(() => binding.create!({ id: intent.workflow_instance_id, params: { jobId: intent.job_id } }));
      if (isWorkflowInstance(result)) instance = result;
    }
  } catch {
    // Duplicate IDs and a lost RPC response are both resolved by the
    // documented instance lookup. Do not make a second logical job ID.
    instance = await existingWorkflowInstance(binding, intent.workflow_instance_id);
    if (!instance) {
      await rescheduleDispatchIntent(
        env.DB,
        intent.job_id,
        intent.generation,
        nextAttemptAt(now, intent.attempts),
        "WORKFLOW_CREATE_UNRESOLVED",
        "Workflow creation was not confirmed.",
      );
      logStructured("media_dispatch_deferred", {
        jobId: intent.job_id,
        state: "pending",
        errorCode: "INTERNAL_ERROR",
      });
      return;
    }
  }

  // A successful create need not return a handle. The stable ID itself is the
  // durable proof that the Workflow request was accepted.
  if (!(await markDispatchStarted(env.DB, intent.job_id, intent.generation))) return;
  const createdAtMs = Date.parse(intent.created_at);
  logStructured("media_dispatch_started", {
    jobId: intent.job_id,
    state: "started",
    ...(Number.isFinite(createdAtMs) ? { operationMs: Math.max(0, now.getTime() - createdAtMs) } : {}),
  });
}

/** Drain due queue heads after a completion or a new accepted request. */
export async function dispatchQueuedJobs(
  env: Env,
  now = new Date(),
  limit = DISPATCH_RECOVERY_LIMIT,
): Promise<void> {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : DISPATCH_RECOVERY_LIMIT;
  const config = getWorkerConfig(env);
  for (let count = 0; count < boundedLimit; count += 1) {
    let intent: DispatchIntentRecord | null;
    try {
      intent = await claimDueDispatchIntent(env.DB, now, DISPATCH_LEASE_SECONDS, {
        maxActiveJobs: config.maxActiveJobs,
        maxActiveTranscriptions: config.maxActiveTranscriptions,
      });
    } catch {
      return;
    }
    if (!intent) return;
    try {
      await startClaim(env, intent, now);
    } catch {
      // Leave the bounded lease to expire. A later scan will fence this actor
      // and inspect the same stable Workflow ID before attempting delivery.
    }
  }
}

/** Try to start the oldest eligible queue heads without making dispatch a prerequisite for HTTP 200. */
export async function dispatchAcceptedJob(env: Env, jobId: string, now = new Date()): Promise<void> {
  try {
    // Drain by lane FIFO so a newly accepted job cannot jump an older queued
    // request merely because its webhook happened to finish first.
    await dispatchQueuedJobs(env, now);
  } catch {
    logStructured("media_dispatch_attempt_failed", {
      jobId,
      state: "pending",
      errorCode: "INTERNAL_ERROR",
    });
    // The lease expires and the minute recovery scan can inspect the same
    // stable intent. Never turn an accepted job into a terminal failure here.
  }
}

function validOutputString(value: unknown, maximum = 320): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) return null;
  if ([...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) return null;
  return value;
}

function validObjectKey(value: unknown, jobId: string): string | null {
  const key = validOutputString(value);
  if (!key || (!key.startsWith(`jobs/${jobId}/`) && !key.startsWith(`staged/${jobId}/`))) return null;
  return key;
}

function validMimeType(value: unknown): string | null {
  const mime = validOutputString(value, 128);
  return mime && /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u.test(mime) ? mime : null;
}

function validSize(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SAFE_OUTPUT_BYTES ? value : null;
}

function validExpiry(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 64) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/** Parse only the small, validated result contract exposed through status().output. */
export function parseWorkflowResult(value: unknown, jobId = "", expectedClipCount = 0): WorkflowResultKind {
  if (typeof value !== "object" || value === null) return { kind: "unknown" };
  const candidate = value as Record<string, unknown>;
  // The status endpoint is a shared trust boundary. A result for another
  // instance (or a legacy result without an instance ID) cannot confirm this
  // job even when its message ID looks valid.
  if (typeof candidate.jobId !== "string" || candidate.jobId !== jobId) return { kind: "unknown" };
  if (candidate.status === "failed" || candidate.status === "failure") {
    const code = candidate.errorCode;
    const errorCode = typeof code === "string" && isErrorCode(code) ? code : "INTERNAL_ERROR";
    const retryAfterSeconds = expectedClipCount === 0 && errorCode === "TELEGRAM_RATE_LIMITED"
      ? positiveRetryAfterSeconds(candidate.retryAfterSeconds)
      : null;
    return {
      kind: "rejected",
      errorCode,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    };
  }
  if (candidate.status !== "completed" && candidate.status !== "success") return { kind: "unknown" };
  const messageId = positiveTelegramMessageId(candidate.telegramMessageId ?? candidate.messageId);
  if (!messageId) return { kind: "unknown" };
  const method = candidate.delivery === "telegram_url" || candidate.delivery === "r2" || candidate.delivery === "telegram"
    ? candidate.delivery
    : "telegram";
  const ids = telegramMessageIds(candidate.telegramMessageIds, expectedClipCount, messageId);
  if (ids === null || (expectedClipCount !== 0 && candidate.delivery !== "telegram")) return { kind: "unknown" };
  const filenameValue = validOutputString(candidate.filename, 180);
  const filename = filenameValue ? sanitizeFilename(filenameValue) : null;
  const mimeType = validMimeType(candidate.mimeType);
  const sizeBytes = validSize(candidate.sizeBytes);
  const objectKey = validObjectKey(candidate.objectKey, jobId);
  const expiresAt = validExpiry(candidate.expiresAt);
  return {
    kind: "confirmed",
    delivery: {
      method,
      telegramMessageId: messageId,
      ...(ids.length ? { telegramMessageIds: ids } : {}),
      objectKey,
      filename,
      mimeType,
      sizeBytes,
      expiresAt,
    },
  };
}

function fallbackDelivery(job: Awaited<ReturnType<typeof getJob>>, stored: JobDeliveryRecord | null): ReconciledWorkflowDelivery | null {
  const ids = job && clipCountForJob(job) !== 0 ? stored && confirmedDeliveryMessageIds(stored, job) : [];
  if (ids === null) return null;
  const messageId = positiveTelegramMessageId(stored?.telegram_message_id ?? job?.result_message_id);
  if (!messageId) return null;
  const method = stored?.method === "telegram_url" || stored?.method === "r2" || stored?.method === "telegram"
    ? stored.method
    : job?.r2_object_key ? "r2" : "telegram";
  return {
    method,
    telegramMessageId: messageId,
    ...(ids.length ? { telegramMessageIds: ids } : {}),
    objectKey: stored?.object_key ?? job?.r2_object_key ?? null,
    filename: stored?.filename ?? job?.output_filename ?? null,
    mimeType: stored?.mime_type ?? job?.output_mime_type ?? null,
    sizeBytes: stored?.size_bytes ?? job?.output_size_bytes ?? null,
    expiresAt: stored?.expires_at ?? job?.expires_at ?? null,
  };
}

function deliveryFields(delivery: ReconciledWorkflowDelivery): Record<string, unknown> {
  return {
    result_message_id: delivery.telegramMessageId,
    progress: 100,
    ...(delivery.filename ? { output_filename: delivery.filename } : {}),
    ...(delivery.mimeType ? { output_mime_type: delivery.mimeType } : {}),
    ...(delivery.sizeBytes !== null ? { output_size_bytes: delivery.sizeBytes } : {}),
    ...(delivery.objectKey !== null ? { r2_object_key: delivery.objectKey } : {}),
    ...(delivery.expiresAt !== null ? { expires_at: delivery.expiresAt } : {}),
  };
}

async function repairConfirmedDelivery(env: Env, intent: DispatchIntentRecord, delivery: ReconciledWorkflowDelivery): Promise<boolean> {
  const stored = await getJobDelivery(env.DB, intent.job_id);
  const current = await getJob(env.DB, intent.job_id);
  if (!current || current.status === "failed") return false;
  const ids = telegramMessageIds(delivery.telegramMessageIds, clipCountForJob(current), delivery.telegramMessageId);
  if (ids === null || (clipCountForJob(current) !== 0 && delivery.method !== "telegram")) return false;
  if (stored?.state === "confirmed" && (stored.telegram_message_id !== delivery.telegramMessageId
    || JSON.stringify(confirmedDeliveryMessageIds(stored, current)) !== JSON.stringify(ids))) {
    // Two different receipts for one job are an operator decision, never an
    // opportunity to overwrite the first confirmed delivery.
    await markConfirmedDeliveryConflict(env.DB, intent.job_id, "conflicting_confirmed_receipt");
    return false;
  }
  if (stored?.state !== "confirmed") {
    const recorded = await recordDeliveryConfirmed(env.DB, intent.job_id, {
      method: delivery.method,
      telegramMessageId: delivery.telegramMessageId,
      telegramMessageIds: delivery.telegramMessageIds,
      objectKey: delivery.objectKey,
      filename: delivery.filename,
      mimeType: delivery.mimeType,
      sizeBytes: delivery.sizeBytes,
      expiresAt: delivery.expiresAt,
    });
    if (!recorded) return false;
  }
  return setJobCompleted(env.DB, intent.job_id, deliveryFields(delivery));
}

async function reconcileKnownFailure(
  env: Env,
  intent: DispatchIntentRecord,
  errorCode: ErrorCode,
  retryAfterSeconds?: number,
): Promise<void> {
  const delivery = await getJobDelivery(env.DB, intent.job_id);
  if (delivery?.state === "confirmed") {
    const current = await getJob(env.DB, intent.job_id);
    const confirmed = fallbackDelivery(current, delivery);
    if (confirmed) await repairConfirmedDelivery(env, intent, confirmed);
    return;
  }
  if (delivery?.state === "sending") {
    await markUnknownForRecovery(env, intent.job_id, "workflow_failed_during_send", delivery.owner_generation ?? undefined);
    return;
  }
  if (delivery?.state === "unknown") return;
  await recordDeliveryRejected(env.DB, intent.job_id, safeMessageForError(errorCode), undefined, retryAfterSeconds);
  await setJobFailure(env.DB, intent.job_id, errorCode, safeMessageForError(errorCode));
}

async function markUnknownForRecovery(env: Env, jobId: string, reason: string, generation?: number): Promise<boolean> {
  const changed = await markDeliveryUnknown(env.DB, jobId, reason, generation);
  if (changed) logStructured("media_delivery_unknown_reconciled", { jobId, state: "unknown" });
  return changed;
}

async function reconcileInstance(env: Env, intent: DispatchIntentRecord, instance: WorkflowInstanceLike): Promise<void> {
  let status: WorkflowInstanceStatusLike;
  try {
    status = await boundedWorkflowCall(() => instance.status());
  } catch {
    // A status transport error does not prove that the Workflow stopped. Keep
    // the started intent for a later observation instead of age releasing it.
    return;
  }
  if (status.status !== "complete" && status.status !== "errored" && status.status !== "terminated") return;

  const current = await getJob(env.DB, intent.job_id);
  const stored = await getJobDelivery(env.DB, intent.job_id);
  if (await settleFromStoredJob(env, intent, current, stored)) return;

  if (status.status === "complete") {
    const parsed = parseWorkflowResult(status.output, intent.job_id, current ? clipCountForJob(current) : -1);
    if (parsed.kind === "confirmed") {
      const repaired = await repairConfirmedDelivery(env, intent, parsed.delivery);
      if (repaired) {
        await markDispatchComplete(env.DB, intent.job_id, intent.generation);
      } else {
        const afterConflict = await getJobDelivery(env.DB, intent.job_id);
        if (afterConflict?.state === "unknown" && afterConflict.unknown_reason === "conflicting_confirmed_receipt") {
          await markDispatchComplete(env.DB, intent.job_id, intent.generation);
        }
      }
      return;
    }
    if (parsed.kind === "rejected") {
      await reconcileKnownFailure(env, intent, parsed.errorCode, parsed.retryAfterSeconds);
      await markDispatchComplete(env.DB, intent.job_id, intent.generation);
      return;
    }
  }

  if (stored?.state === "confirmed") {
    const confirmed = fallbackDelivery(current, stored);
    if (confirmed && await repairConfirmedDelivery(env, intent, confirmed)) {
      await markDispatchComplete(env.DB, intent.job_id, intent.generation);
    }
    return;
  }
  if (stored?.state === "sending") {
    await markUnknownForRecovery(env, intent.job_id, "workflow_terminal_without_receipt", stored.owner_generation ?? undefined);
  } else if (stored?.state !== "unknown") {
    await markUnknownForRecovery(env, intent.job_id, "workflow_terminal_without_valid_result");
  }
  // Unknown delivery deliberately leaves the active admission row in place;
  // only a terminal job transition may release that slot.
  await markDispatchComplete(env.DB, intent.job_id, intent.generation);
}

/**
 * Close an intent whose stored job already decides the outcome: an incomplete
 * clip-pack receipt, or a terminal job. Returns false when the caller decides.
 */
async function settleFromStoredJob(
  env: Env,
  intent: DispatchIntentRecord,
  current: JobRecord | null,
  delivery: JobDeliveryRecord | null,
): Promise<boolean> {
  if (current && clipCountForJob(current) !== 0 && delivery?.state === "confirmed" && confirmedDeliveryMessageIds(delivery, current) === null) {
    await markConfirmedDeliveryConflict(env.DB, intent.job_id, "clip_pack_receipt_incomplete");
    await markDispatchComplete(env.DB, intent.job_id, intent.generation);
    return true;
  }
  if (current?.status !== "completed" && current?.status !== "failed") return false;
  if (delivery?.state === "sending") {
    // A terminal legacy job with an unrecorded send is not proof of a
    // rejection. Preserve the terminal status but surface the delivery as
    // unknown before closing its dispatch intent.
    await markUnknownForRecovery(env, intent.job_id, "terminal_job_without_delivery_receipt", delivery.owner_generation ?? undefined);
  } else if (current.status === "completed" && delivery?.state === "not_started") {
    // A completed legacy row may carry a valid result ID even though the
    // separate receipt row was not backfilled. Repair that evidence; when
    // it is absent, surface the mismatch as unknown.
    const confirmed = fallbackDelivery(current, delivery);
    if (!confirmed || !(await repairConfirmedDelivery(env, intent, confirmed))) {
      await markUnknownForRecovery(env, intent.job_id, "terminal_job_without_delivery_receipt");
    }
  }
  await markDispatchComplete(env.DB, intent.job_id, intent.generation);
  return true;
}

async function reconcileStartedIntent(env: Env, intent: DispatchIntentRecord): Promise<void> {
  const binding = workflowBinding(env);
  if (!binding?.get) return;
  try {
    const instance = await boundedWorkflowCall(() => binding.get!(intent.workflow_instance_id || intent.job_id));
    if (isWorkflowInstance(instance)) await reconcileInstance(env, intent, instance);
  } catch (error) {
    // A definite missing instance after a started intent is an unresolved
    // send state. Keep it explicit and operator-visible; transient get errors
    // leave the intent started for another observation.
    if (!isWorkflowMissingError(error)) return;
    const delivery = await getJobDelivery(env.DB, intent.job_id);
    const current = await getJob(env.DB, intent.job_id);
    if (await settleFromStoredJob(env, intent, current, delivery)) return;
    if (delivery?.state === "confirmed") {
      const confirmed = fallbackDelivery(current, delivery);
      if (confirmed) await repairConfirmedDelivery(env, intent, confirmed);
    } else if (delivery?.state === "rejected") {
      const errorCode = current?.error_code && isErrorCode(current.error_code)
        ? current.error_code
        : "TELEGRAM_UPLOAD_FAILED";
      await setJobFailure(env.DB, intent.job_id, errorCode, safeMessageForError(errorCode));
    } else if (delivery?.state !== "unknown") {
      await markUnknownForRecovery(env, intent.job_id, "workflow_instance_missing");
    }
    await markDispatchComplete(env.DB, intent.job_id, intent.generation);
  }
}

/** Reconcile finished instances first, then claim due intents for bounded recovery. */
export async function recoverAndReconcileDispatches(
  env: Env,
  now = new Date(),
  limit = DISPATCH_RECOVERY_LIMIT,
): Promise<void> {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : DISPATCH_RECOVERY_LIMIT;
  try {
    const started = await listStartedDispatchIntents(env.DB, boundedLimit);
    for (const intent of started) {
      try {
        await reconcileStartedIntent(env, intent);
      } catch {
        // One damaged row must not starve the rest of the bounded recovery scan.
      }
    }
  } catch {
    return;
  }

  await dispatchQueuedJobs(env, now, boundedLimit);
}

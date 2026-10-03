import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { getContainer } from "@cloudflare/containers";
import { decryptSourceUrl } from "./crypto";
import { getWorkerConfig } from "./config";
import {
  claimDeliverySending,
  confirmedDeliveryMessageIds,
  telegramMessageIds,
  markConfirmedDeliveryConflict,
  getJob,
  getJobDelivery,
  getJobDurableState,
  getLatestCompletedJobForMedia,
  markDeliveryUnknown,
  positiveTelegramMessageId,
  positiveRetryAfterSeconds,
  recordDeliveryConfirmed,
  recordDeliveryRejected,
  resetDeliverySending,
  setJobCompleted,
  setJobFailure,
  setJobState,
  updateJob,
} from "./db";
import { ApplicationError, errorCodeFromContainerResult, isErrorCode, mapUnknownError, safeMessageForError, type ErrorCode } from "./errors";
import { r2RetentionExpiry } from "./r2";
import { sanitizeFilename } from "./security";
import { buildContainerDeadlineHeaders, buildDeliveryRequest, buildPrepareRequest } from "./container-contract";
import { TelegramApiError, TelegramClient, telegramErrorToApplicationError } from "./telegram";
import { ensureWaitingNotice } from "./notices";
import { dispatchQueuedJobs } from "./dispatch";
import { initialPreparationMessage, sourceForValidatedUrl } from "./sources";
import { clipCountForJob, formatTrimRequest, isValidTrimRange } from "./trim";
import { logStructured, type ErrorStage, type FailureReason, type WorkflowErrorName } from "./logging";
import type {
  ContainerDeliveryRequest,
  ContainerDeliveryResult,
  ContainerFailureResult,
  ContainerJobRequest,
  ContainerJobResult,
  ContainerSuccessResult,
  ContainerStubLike,
  JobDeliveryRecord,
  Env,
  JobOperation,
  JobRecord,
  WorkflowParams,
} from "./types";

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

// Only these container failures are safe to retry. In particular, yt-dlp's
// generic probe fallback may label a permanent MEDIA_UNAVAILABLE result as
// retryable; allowing that flag through would turn one failure into a 45-50s
// Workflow retry sequence. Keep the allowlist deliberately small and require
// the container to opt in with retryable=true as well.
const RETRYABLE_CONTAINER_ERROR_CODES: ReadonlySet<ErrorCode> = new Set([
  "DOWNLOAD_TIMEOUT",
  "DOWNLOAD_FAILED",
  "SOURCE_RATE_LIMITED",
  "PROCESSING_FAILED",
  "R2_UPLOAD_FAILED",
  "INTERNAL_ERROR",
]);

const PREPARE_RETRY_LIMIT = 3;
const MAX_WORKFLOW_SLEEP_SECONDS = 365 * 24 * 60 * 60;
const MAX_DELIVERY_OUTPUT_BYTES = 2_000_000_000;
const WORKFLOW_DEADLINE_MARGIN_SECONDS = 5;
const MAX_CONTAINER_TIMER_DELAY_MS = 2_147_483_647;

export function workflowTimeoutSeconds(operation: JobOperation, config: ReturnType<typeof getWorkerConfig>): number {
  return operation === "transcript" ? config.transcriptionTimeoutSeconds : config.jobTimeoutSeconds;
}

function operationForJob(job: JobRecord): JobOperation {
  return job.requested_operation === "transcript" ? "transcript" : "download";
}

/**
 * Return one durable, integer Unix expiry for the whole job. The five-second
 * margin leaves the enclosing prepare step room to read the response and run
 * its terminal bookkeeping before its configured timeout expires.
 */
export function createJobDeadlineAt(jobTimeoutSeconds: number, nowMs = Date.now()): number {
  if (!Number.isSafeInteger(jobTimeoutSeconds) || jobTimeoutSeconds <= 0) throw new ApplicationError("INTERNAL_ERROR");
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new ApplicationError("INTERNAL_ERROR");
  const margin = Math.min(WORKFLOW_DEADLINE_MARGIN_SECONDS, Math.max(0, jobTimeoutSeconds - 1));
  const nowSeconds = Math.ceil(nowMs / 1000);
  const deadlineAt = nowSeconds + jobTimeoutSeconds - margin;
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= nowSeconds) throw new ApplicationError("INTERNAL_ERROR");
  return deadlineAt;
}

function deadlineRemainingMs(deadlineAt: number): number {
  const remaining = deadlineAt * 1000 - Date.now();
  return Number.isFinite(remaining) ? remaining : 0;
}

class ContainerRequestDeadlineError extends Error {
  constructor() {
    super("Container request deadline expired");
    this.name = "ContainerRequestDeadlineError";
  }
}

class ContainerResponseBodyError extends Error {
  readonly response: Response;

  constructor(response: Response, cause: unknown) {
    super("Container response body could not be read");
    this.name = "ContainerResponseBodyError";
    this.response = response;
    Object.defineProperty(this, "cause", { value: cause, enumerable: false });
  }
}

async function fetchContainerJson(
  stub: ContainerStubLike,
  request: (signal: AbortSignal) => Request,
  deadlineAt: number,
): Promise<{ response: Response; result: unknown }> {
  const remainingMs = deadlineRemainingMs(deadlineAt);
  if (remainingMs <= 0) throw new ContainerRequestDeadlineError();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ContainerRequestDeadlineError());
    }, Math.max(1, Math.min(remainingMs, MAX_CONTAINER_TIMER_DELAY_MS)));
  });
  const operation = (async () => {
    const response = await stub.fetch(request(controller.signal));
    try {
      return { response, result: await response.json() };
    } catch (error) {
      throw new ContainerResponseBodyError(response, error);
    }
  })();
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A non-idempotent delivery response cannot be replayed without a receipt. */
export class UnknownDeliveryError extends Error {
  readonly reason: string;

  constructor(reason: string, cause?: unknown) {
    super("Telegram delivery outcome is unknown");
    this.name = "UnknownDeliveryError";
    this.reason = reason;
    if (cause !== undefined) Object.defineProperty(this, "cause", { value: cause, enumerable: false });
  }
}

/** A Telegram rejection is safe to classify, but its delay is operator metadata only. */
class RejectedDeliveryError extends ApplicationError {
  readonly retryAfterSeconds: number | undefined;

  constructor(errorCode: ErrorCode, retryAfterSeconds?: number) {
    super(errorCode);
    this.retryAfterSeconds = errorCode === "TELEGRAM_RATE_LIMITED"
      ? positiveRetryAfterSeconds(retryAfterSeconds) ?? undefined
      : undefined;
  }
}

interface WorkflowStepContextLike {
  attempt: number;
  step: { name: string; count: number };
  config: { retries?: { limit: number } };
}

interface WorkflowStepLike {
  do<T>(name: string, callback: (context: WorkflowStepContextLike) => Promise<T>): Promise<T>;
  do<T>(name: string, options: { retries: { limit: number; delay: string; backoff: "linear" | "exponential" }; timeout?: string }, callback: (context: WorkflowStepContextLike) => Promise<T>): Promise<T>;
  sleep?(name: string, duration: string | number): Promise<void>;
}

function isExplicitlyRetryableContainerFailure(errorCode: ErrorCode, requestedRetryable: boolean): boolean {
  return requestedRetryable && RETRYABLE_CONTAINER_ERROR_CODES.has(errorCode);
}

/** Include the stable code in retry errors so a Workflow wrapper cannot erase it. */
function retryableContainerError(errorCode: ErrorCode): ApplicationError {
  return new ApplicationError(errorCode, {
    retryable: true,
    message: `[${errorCode}] ${safeMessageForError(errorCode)}`,
  });
}

function extractWorkflowErrorCode(error: unknown, seen = new Set<object>(), depth = 0): ErrorCode | null {
  if (error instanceof ApplicationError) return error.code;
  if (typeof error !== "object" || error === null || depth > 3 || seen.has(error)) return null;
  seen.add(error);
  const candidate = error as {
    code?: unknown;
    errorCode?: unknown;
    name?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  for (const value of [candidate.code, candidate.errorCode, candidate.name]) {
    if (isErrorCode(value)) return value;
  }
  if (typeof candidate.message === "string") {
    for (const token of candidate.message.split(/[^A-Z0-9_]+/u)) {
      if (isErrorCode(token)) return token;
    }
  }
  return extractWorkflowErrorCode(candidate.cause, seen, depth + 1);
}

/** Preserve the final container code if Workflows wraps the exhausted error. */
function mapWorkflowError(error: unknown): ApplicationError {
  const mapped = mapUnknownError(error);
  if (mapped.code !== "INTERNAL_ERROR" || error instanceof ApplicationError) return mapped;
  const code = extractWorkflowErrorCode(error);
  return code ? new ApplicationError(code, { cause: error }) : mapped;
}

function safeWorkflowErrorName(error: unknown): WorkflowErrorName {
  if (error instanceof ApplicationError) return "ApplicationError";
  if (typeof error === "object" && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (name === "WorkflowInternalError") return "WorkflowInternalError";
    if (name === "AbortError") return "AbortError";
    if (name === "TypeError") return "TypeError";
    if (name === "Error") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.includes("WorkflowInternalError")) return "WorkflowInternalError";
      return "Error";
    }
  }
  return "UnknownError";
}

function failureReasonFor(error: unknown): FailureReason {
  if (error instanceof ApplicationError) return "application_error";
  return safeWorkflowErrorName(error) === "WorkflowInternalError" ? "workflow_wrapper" : "unexpected_error";
}

function terminalFailure(errorCode: ErrorCode): ContainerFailureResult {
  return {
    status: "failed",
    errorCode,
    safeMessage: safeMessageForError(errorCode),
    retryable: false,
  };
}

function preparedResultFromCompletedJob(job: JobRecord): ContainerSuccessResult | null {
  const sizeBytes = job.output_size_bytes;
  if (
    !job.output_filename ||
    !job.output_mime_type ||
    typeof sizeBytes !== "number" ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0 ||
    !positiveTelegramMessageId(job.result_message_id) || clipCountForJob(job) !== 0
  ) return null;
  return {
    status: "prepared",
    delivery: "telegram",
    filename: sanitizeFilename(job.output_filename),
    mimeType: job.output_mime_type,
    sizeBytes,
    duration: job.output_duration_seconds ?? undefined,
  };
}

function deliveryFromRecord(record: JobDeliveryRecord, job: JobRecord): ContainerDeliveryResult | null {
  const ids = confirmedDeliveryMessageIds(record, job);
  if (ids === null) return null;
  const messageId = positiveTelegramMessageId(record.telegram_message_id);
  if (!messageId) return null;
  return {
    status: "completed",
    delivery: record.method ?? (record.object_key ? "r2" : "telegram"),
    telegramMessageId: messageId,
    ...(ids.length ? { telegramMessageIds: ids } : {}),
    ...(record.object_key ? { objectKey: record.object_key } : {}),
    ...(record.filename ? { filename: record.filename } : {}),
    ...(record.mime_type ? { mimeType: record.mime_type } : {}),
    ...(record.size_bytes !== null ? { sizeBytes: record.size_bytes } : {}),
    ...(record.expires_at ? { expiresAt: record.expires_at } : {}),
  };
}

function deliveryOutput(delivery: ContainerDeliveryResult, prepared: ContainerSuccessResult | null, jobId?: string): Record<string, unknown> {
  const messageId = positiveTelegramMessageId(delivery.telegramMessageId);
  return {
    status: "completed",
    ...(jobId ? { jobId } : {}),
    messageId: messageId ?? String(delivery.telegramMessageId),
    telegramMessageId: messageId ?? String(delivery.telegramMessageId),
    ...(delivery.telegramMessageIds ? { telegramMessageIds: delivery.telegramMessageIds } : {}),
    ...(delivery.delivery ? { delivery: delivery.delivery } : {}),
    ...(delivery.objectKey ? { objectKey: delivery.objectKey } : prepared?.objectKey ? { objectKey: prepared.objectKey } : {}),
    ...(delivery.filename ? { filename: delivery.filename } : prepared?.filename ? { filename: prepared.filename } : {}),
    ...(delivery.mimeType ? { mimeType: delivery.mimeType } : prepared?.mimeType ? { mimeType: prepared.mimeType } : {}),
    ...(typeof delivery.sizeBytes === "number" ? { sizeBytes: delivery.sizeBytes } : prepared ? { sizeBytes: prepared.sizeBytes } : {}),
    ...(delivery.expiresAt ? { expiresAt: delivery.expiresAt } : {}),
  };
}

function preparedForReceipt(job: JobRecord, delivery: ContainerDeliveryResult): ContainerSuccessResult {
  return {
    status: "prepared",
    ...(clipCountForJob(job) > 0 ? { clipCount: clipCountForJob(job) } : {}),
    delivery: delivery.delivery ?? (delivery.objectKey ? "r2" : "telegram"),
    objectKey: delivery.objectKey ?? job.r2_object_key ?? `staged/${job.id}/${job.requested_operation === "transcript" ? "transcript.md" : "media.bin"}`,
    filename: sanitizeFilename(delivery.filename ?? job.output_filename ?? "media.bin"),
    mimeType: delivery.mimeType ?? job.output_mime_type ?? "application/octet-stream",
    sizeBytes: delivery.sizeBytes ?? job.output_size_bytes ?? 0,
    ...(delivery.expiresAt ? { expiresAt: delivery.expiresAt } : {}),
    ...(job.output_duration_seconds !== null ? { duration: job.output_duration_seconds ?? undefined } : {}),
  };
}

export class MediaJobWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep): Promise<Record<string, unknown>> {
    const steps = step as unknown as WorkflowStepLike;
    const jobId = event.payload?.jobId;
    if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) return { status: "failed", errorCode: "INTERNAL_ERROR" };
    const started = Date.now();

    const durableState = await steps.do("load job state", async () => getJobDurableState(this.env.DB, jobId));
    const loadedJob = durableState.job;
    if (!loadedJob) return { status: "missing", jobId };
    let job = loadedJob;
    const clipCount = clipCountForJob(job);
    if (clipCount < 0) return { status: "unknown", jobId, reason: "invalid_clip_pack_request" };
    const operation = operationForJob(job);
    const workerConfig = getWorkerConfig(this.env);
    const timeoutSeconds = workflowTimeoutSeconds(job.transcript_method === "captions" ? "download" : operation, workerConfig);
    if (job.status === "completed") {
      const receipt = durableState.delivery;
      const delivery = receipt ? deliveryFromRecord(receipt, job) : null;
      if (clipCount > 0) {
        if (delivery) return deliveryOutput(delivery, null, jobId);
        if (receipt?.state === "confirmed") await markConfirmedDeliveryConflict(this.env.DB, jobId, "clip_pack_receipt_incomplete");
        else await markDeliveryUnknown(this.env.DB, jobId, "clip_pack_receipt_incomplete");
        return { status: "unknown", jobId, reason: "clip_pack_receipt_incomplete" };
      }
      return {
        status: "completed",
        jobId,
        ...(delivery ? { messageId: delivery.telegramMessageId, telegramMessageId: delivery.telegramMessageId } : job.result_message_id ? { messageId: job.result_message_id } : {}),
      };
    }
    if (job.status === "failed") return { status: "failed", jobId, errorCode: job.error_code ?? "INTERNAL_ERROR" };

    const dispatchIntent = durableState.intent;
    const deliveryRecord = durableState.delivery;
    const generation = dispatchIntent?.generation ?? 0;
    if (!dispatchIntent || !deliveryRecord) {
      // The additive migration should make both rows available. A job without
      // either durable owner is explicitly uncertain and must never send.
      return { status: "unknown", jobId, reason: "durable_delivery_state_missing" };
    }
    if (deliveryRecord.state === "unknown") return { status: "unknown", jobId, reason: deliveryRecord.unknown_reason ?? "delivery_unknown" };
    if (deliveryRecord.state === "rejected") {
      return {
        status: "failed",
        jobId,
        errorCode: job.error_code ?? "TELEGRAM_UPLOAD_FAILED",
        ...(positiveRetryAfterSeconds(deliveryRecord.retry_after_seconds) ? { retryAfterSeconds: deliveryRecord.retry_after_seconds } : {}),
      };
    }

    // Once the Container has returned a Telegram message ID, delivery is
    // confirmed and must never be converted into a failed job by later
    // bookkeeping. Workflow checkpoints preserve the confirmed delivery
    // result while the completion write and waiting-message cleanup retry.
    let confirmedDelivery: ContainerDeliveryResult | null = deliveryFromRecord(deliveryRecord, job);
    if (deliveryRecord.state === "confirmed" && !confirmedDelivery) {
      await markConfirmedDeliveryConflict(this.env.DB, jobId, "clip_pack_receipt_incomplete");
      return { status: "unknown", jobId, reason: "clip_pack_receipt_incomplete" };
    }
    let activeErrorStage: ErrorStage = "workflow_setup";
    // A structured Container result is the only proof that preparation ended
    // before a Workflow boundary failure. Keep this false until the prepare
    // checkpoint returns so a wrapped platform error cannot free the claim.
    let prepareOutcomeKnown = false;

    try {
      if (confirmedDelivery) {
        activeErrorStage = "completion_persist";
        const receiptDelivery = confirmedDelivery;
        await steps.do(
          "repair confirmed delivery",
          { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
          async () => {
            await this.markCompleted(jobId, receiptDelivery, preparedForReceipt(job, receiptDelivery));
            return true;
          },
        );
        return deliveryOutput(receiptDelivery, preparedForReceipt(job, receiptDelivery), jobId);
      }

      const requestedTrim = job.requested_start_seconds !== null && job.requested_start_seconds !== undefined
        && job.requested_end_seconds !== null && job.requested_end_seconds !== undefined
        && isValidTrimRange(job.requested_start_seconds, job.requested_end_seconds)
        ? { startSeconds: job.requested_start_seconds, endSeconds: job.requested_end_seconds }
        : null;
      const waitingText = clipCount > 0 ? `Accepted — preparing a clip pack (${clipCount} clips) in the requested order…`
        : job.source_kind === "telegram_file"
        ? `Accepted — preparing ${job.requested_mode}…\nSource: Telegram file${requestedTrim ? `\nTrim: ${formatTrimRequest(requestedTrim)}.` : ""}`
        : initialPreparationMessage(
        sourceForValidatedUrl({ hostname: job.source_host }),
        job.requested_mode,
        requestedTrim,
        operation,
        job.transcript_method,
      );
      if (!job.waiting_message_id) {
        let waitingNotice;
        try {
          waitingNotice = await steps.do(
            "ensure waiting message",
            { retries: { limit: 0, delay: "1 second", backoff: "linear" } },
            async () => {
              const warm = this.warmContainer(job);
              const notice = await ensureWaitingNotice(this.env, job.telegram_update_id, job.telegram_chat_id, waitingText);
              await warm;
              return notice;
            },
          );
        } catch {
          return { status: "unknown", jobId, reason: "waiting_notice_unavailable" };
        }
        let waitingAttempt = 0;
        while (waitingNotice.state === "pending" || waitingNotice.state === "sending") {
          waitingAttempt += 1;
          // The webhook or cron may own the one-shot queue acknowledgment.
          // Observe its receipt; never turn an in-flight send into a retry.
          const delaySeconds = waitingNotice.state === "sending" ? 1 : waitingNotice.retryAfterSeconds;
          if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 0) {
            return { status: "unknown", jobId, reason: "waiting_notice_rate_limit_invalid" };
          }
          if (delaySeconds > 0) {
            if (!steps.sleep) return { status: "unknown", jobId, reason: "waiting_notice_rate_limited" };
            // Workflows cap one sleep at 365 days. Keep the notice's original
            // due time in D1 and re-read it after each bounded chunk so a
            // longer valid retry_after is never shortened or rejected.
            await steps.sleep(`wait for waiting notice rate limit ${waitingAttempt}`, `${Math.min(delaySeconds, MAX_WORKFLOW_SLEEP_SECONDS)} seconds`);
          }
          try {
            waitingNotice = await steps.do(
              `retry waiting message ${waitingAttempt}`,
              { retries: { limit: 0, delay: "1 second", backoff: "linear" } },
              async () => ensureWaitingNotice(this.env, job.telegram_update_id, job.telegram_chat_id, waitingText),
            );
          } catch {
            return { status: "unknown", jobId, reason: "waiting_notice_unavailable" };
          }
        }
        const waitingId = positiveTelegramMessageId(waitingNotice.messageId);
        if (waitingNotice.state !== "sent" || !waitingId) {
          return {
            status: "unknown",
            jobId,
            reason: waitingNotice.state === "rejected" ? "waiting_notice_rejected" : "waiting_notice_unavailable",
          };
        }
        await steps.do("record waiting message", async () => {
          await setJobState(this.env.DB, jobId, "received", { waiting_message_id: waitingId });
          return true;
        });
        job = { ...job, waiting_message_id: waitingId };
      }

      if (loadedJob.status === "queued" && job.waiting_message_id) {
        try {
          await steps.do("show job starting", { retries: { limit: 0, delay: "1 second", backoff: "linear" } }, async () => {
            try { await this.telegramClient().editMessageText(job.telegram_chat_id, job.waiting_message_id!, waitingText); }
            catch { /* A cosmetic, idempotent edit must not interrupt the job or send a replacement. */ }
            return true;
          });
        } catch { /* Cron and /queue remain authoritative if the display checkpoint is lost. */ }
      }

      activeErrorStage = "workflow_queue";
      await steps.do("mark queued", async () => {
        await setJobState(this.env.DB, jobId, "queued");
        return true;
      });

      // A completed result in the same private chat can be copied by Telegram
      // in one API call. This avoids another source probe/download for repeat
      // links while keeping the cache scoped to the exact allowlisted user and
      // chat. copyMessage is deliberately one-shot because a network timeout
      // after acceptance is ambiguous and must not fall back to a second send.
      activeErrorStage = "cache_lookup";
      const reusableJob = operation === "transcript" || (job.source_kind ?? "url") !== "url" || clipCount !== 0
        ? null
        : await steps.do("lookup reusable Telegram media", async () => getLatestCompletedJobForMedia(
          this.env.DB,
          job.telegram_user_id,
          job.telegram_chat_id,
          job.source_url_hash,
          job.requested_mode,
          job.requested_quality,
          job.processing_policy_version,
          job.requested_start_seconds ?? null,
          job.requested_end_seconds ?? null,
        ));
      logStructured("media_cache_lookup", { jobId, state: reusableJob ? "hit" : "miss" });
      const reusablePrepared = reusableJob ? preparedResultFromCompletedJob(reusableJob) : null;
      let preparedResult: ContainerSuccessResult | null = null;
      let copiedDelivery: ContainerDeliveryResult | null = null;
      if (reusableJob && reusablePrepared && !copiedDelivery) {
        activeErrorStage = "telegram_copy";
        const copyAttempt = await steps.do(
          "copy reusable Telegram media",
          { retries: { limit: 0, delay: "1 second", backoff: "linear" } },
          async () => {
            try {
              // The claim deliberately lives in the effect callback. Older
              // Workflow histories may retain the retired separate claim step,
              // but a replay must never trust its cached Boolean result.
              const mayCopy = await claimDeliverySending(this.env.DB, jobId, generation);
              if (!mayCopy) return await this.refusedClaimOutcome(job);
              return { status: "completed" as const, delivery: await this.copyReusableMedia(job, reusableJob, generation) };
            } catch (error) {
              // Keep the ambiguity marker serializable across Workflow
              // checkpoints; a wrapped Error must never reach recovery as a
              // proven rejection.
              if (error instanceof UnknownDeliveryError) return { status: "unknown" as const, reason: error.reason };
              return { status: "unknown" as const, reason: "telegram_copy_attempt_unknown" };
            }
          },
        );
        if (copyAttempt.status === "unknown") throw new UnknownDeliveryError(copyAttempt.reason);
        if (copyAttempt.status === "rejected") return { status: "failed", jobId, errorCode: copyAttempt.errorCode };
        copiedDelivery = copyAttempt.delivery;
        if (copiedDelivery) {
          preparedResult = reusablePrepared;
          // Telegram accepted the copy before the metadata checkpoint. Never
          // turn a later D1 bookkeeping error into a failed delivery.
          confirmedDelivery = copiedDelivery;
        }
      }

      if (!copiedDelivery) {
        if (!job.waiting_message_id) {
          await steps.do("mark missing waiting message", async () => {
            await markDeliveryUnknown(this.env.DB, jobId, "waiting_message_unavailable", generation);
            return true;
          });
          return { status: "unknown", jobId, reason: "waiting_message_unavailable" };
        }
        // This step's persisted result is the sole clock for all prepare
        // retries and final delivery. It starts after any durable waiting
        // notice delay so that a Telegram rate limit does not consume the
        // Container execution budget, while Workflow replays reuse the same
        // expiry rather than silently granting a fresh budget.
        let deadlineAt = typeof job.deadline_at === "number" && Number.isSafeInteger(job.deadline_at) && job.deadline_at > 0
          ? job.deadline_at
          : null;
        if (deadlineAt === null) {
          deadlineAt = await steps.do("create job deadline", async () => createJobDeadlineAt(timeoutSeconds));
          await steps.do("persist job deadline", async () => {
            await updateJob(this.env.DB, jobId, { deadline_at: deadlineAt });
            return true;
          });
          job = { ...job, deadline_at: deadlineAt };
        }
        // Preparation is retryable; it must not send messages or deliver output.
        activeErrorStage = "container_prepare";
        const prepared = await steps.do(
          "container download and prepare",
          { retries: { limit: PREPARE_RETRY_LIMIT, delay: "5 seconds", backoff: "exponential" }, timeout: `${timeoutSeconds} seconds` },
          async (context) => {
            try {
              return await this.prepareMedia(job, deadlineAt);
            } catch (error) {
              // A timeout, transport failure, or interrupted response cannot
              // prove that the Container stopped before it created a staged
              // artifact. Return a terminal marker from this step so
              // Workflow retries do not issue another prepare request.
              if (error instanceof UnknownDeliveryError) return { status: "unknown" as const, reason: error.reason };
              const appError = mapUnknownError(error);
              logStructured("media_prepare_attempt_failed", {
                jobId,
                sourceHost: job.source_host,
                sourceUrlHash: job.source_url_hash,
                state: "downloading",
                errorCode: appError.code,
                retryCount: Math.max(0, context.attempt - 1),
                errorStage: "container_prepare",
                failureReason: failureReasonFor(error),
                workflowAttempt: context.attempt,
                workflowErrorName: safeWorkflowErrorName(error),
              });
              // Resolve permanent failures immediately. On the final attempt,
              // return a serializable terminal result rather than throwing;
              // otherwise Workflows may replace the stable application code
              // with a generic WorkflowInternalError wrapper.
              const retryLimit = context.config.retries?.limit ?? PREPARE_RETRY_LIMIT;
              if ((error instanceof ApplicationError && !error.retryable) || context.attempt > retryLimit) {
                return terminalFailure(appError.code);
              }
              throw error;
            }
          },
        );
        prepareOutcomeKnown = true;

        if (prepared.status === "unknown") {
          try {
            await markDeliveryUnknown(this.env.DB, jobId, prepared.reason, generation);
          } catch {
            // Recovery can persist the explicit unknown state when D1 is
            // temporarily unavailable; never fall through to another send.
          }
          logStructured("media_job_delivery_unknown", {
            jobId,
            sourceHost: job.source_host,
            sourceUrlHash: job.source_url_hash,
            state: "unknown",
            errorStage: "container_prepare",
          });
          return { status: "unknown", jobId, reason: prepared.reason };
        }
        if (prepared.status === "failure" || prepared.status === "failed") {
          const errorCode = errorCodeFromContainerResult(prepared.errorCode);
          throw new ApplicationError(errorCode, { retryable: false });
        }
        if (prepared.status !== "prepared" && prepared.status !== "success" && prepared.status !== "completed") throw new ApplicationError("DOWNLOAD_FAILED");
        preparedResult = prepared;

        activeErrorStage = "prepared_result_persist";
        await steps.do("record prepared result", async () => {
          await this.recordPreparedResult(jobId, prepared);
          return true;
        });

        // Delivery is the non-idempotent final phase. The Container owns the
        // direct multipart upload or private-R2 link send and confirms Telegram.
        // This step is never retried by the Workflow.
        activeErrorStage = "telegram_delivery";
        if (!confirmedDelivery) {
          const deliveryAttempt = await steps.do(
            "container Telegram delivery",
            { retries: { limit: 0, delay: "1 second", backoff: "linear" }, timeout: `${timeoutSeconds} seconds` },
            async () => {
              try {
                // Keep ownership acquisition in this callback so restarting
                // this step cannot reuse an earlier cached claim to send again.
                const mayDeliver = await claimDeliverySending(this.env.DB, jobId, generation);
                if (!mayDeliver) return await this.refusedClaimOutcome(job);
                return { status: "completed" as const, delivery: await this.deliverPrepared(job, prepared, deadlineAt) };
              } catch (error) {
                // Return explicit serializable outcome data from the step.
                // Workflow may wrap thrown errors and discard custom fields;
                // recovery must still distinguish a proven rejection from an
                // ambiguous final send.
                if (error instanceof RejectedDeliveryError) {
                  return {
                    status: "rejected" as const,
                    errorCode: error.code,
                    ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
                  };
                }
                if (error instanceof UnknownDeliveryError) return { status: "unknown" as const, reason: error.reason };
                return { status: "unknown" as const, reason: "container_delivery_attempt_unknown" };
              }
            },
          );
          if (deliveryAttempt.status === "unknown") throw new UnknownDeliveryError(deliveryAttempt.reason);
          if (deliveryAttempt.status === "rejected") throw new RejectedDeliveryError(deliveryAttempt.errorCode, deliveryAttempt.retryAfterSeconds);
          confirmedDelivery = deliveryAttempt.delivery;
        }
      } else {
        // Cache hits still write the output metadata so /status remains as
        // useful as it is for a cold download.
        activeErrorStage = "prepared_result_persist";
        await steps.do("record prepared result", async () => {
          await this.recordPreparedResult(jobId, reusablePrepared as ContainerSuccessResult);
          return true;
        });
      }

      const delivery = confirmedDelivery;
      if (!delivery || !preparedResult) throw new ApplicationError("TELEGRAM_UPLOAD_FAILED");
      const finalPreparedResult = preparedResult;

      // Persist the receipt before changing the legacy job state. This is the
      // recovery anchor when a later completion or cleanup checkpoint fails.
      activeErrorStage = "completion_persist";
      await steps.do(
        "record delivery receipt",
        { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
        async () => {
          const recorded = await recordDeliveryConfirmed(this.env.DB, jobId, {
            method: delivery.delivery ?? (delivery.objectKey ? "r2" : "telegram"),
            telegramMessageId: delivery.telegramMessageId,
            telegramMessageIds: delivery.telegramMessageIds,
            objectKey: delivery.objectKey ?? (clipCount > 0 ? finalPreparedResult.objectKey : null) ?? null,
            filename: delivery.filename ?? finalPreparedResult.filename,
            mimeType: delivery.mimeType ?? finalPreparedResult.mimeType,
            sizeBytes: delivery.sizeBytes ?? finalPreparedResult.sizeBytes,
            expiresAt: delivery.expiresAt ?? finalPreparedResult.expiresAt ?? null,
            ownerGeneration: generation,
          });
          if (!recorded) throw new ApplicationError("INTERNAL_ERROR", { retryable: true });
          return true;
        },
      );

      // Completion is idempotent and must be persisted before deleting the
      // waiting message. If D1 is transiently unavailable, Workflow retries
      // this checkpoint without re-running the non-idempotent delivery.
      activeErrorStage = "completion_persist";
      await steps.do(
        "mark completed",
        { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
        async () => {
          await this.markCompleted(jobId, delivery, finalPreparedResult);
          return true;
        },
      );

      // Deletion is separate from delivery so a retry can never upload the
      // media twice. It is safe to retry: a Telegram 400 "message not found"
      // means another attempt already deleted the message.
      activeErrorStage = "waiting_message_cleanup";
      await steps.do(
        "delete waiting message",
        { retries: { limit: 2, delay: "3 seconds", backoff: "exponential" } },
        async () => this.deleteWaitingMessage(job),
      );
      logStructured("media_job_completed", {
        jobId,
        sourceHost: job.source_host,
        sourceUrlHash: job.source_url_hash,
        state: "completed",
        operationMs: Date.now() - started,
        outputSize: finalPreparedResult.sizeBytes,
      });
      return deliveryOutput(delivery, finalPreparedResult, jobId);
    } catch (error) {
      if (error instanceof UnknownDeliveryError) {
        try {
          await markDeliveryUnknown(this.env.DB, jobId, error.reason, generation);
        } catch {
          // The Workflow result remains explicitly unknown and the recovery
          // scan can persist the state when D1 is available again.
        }
        logStructured("media_job_delivery_unknown", {
          jobId,
          sourceHost: job.source_host,
          sourceUrlHash: job.source_url_hash,
          state: "unknown",
          errorStage: activeErrorStage,
        });
        return { status: "unknown", jobId, reason: error.reason };
      }
      // A Workflow platform timeout can happen around the callback itself,
      // before its serializable marker reaches this code. Treat every
      // unclassified failure in an in-flight Container/copy stage as unknown;
      // only a structured rejection marker is allowed to free the admission.
      if (
        !confirmedDelivery &&
        !(error instanceof RejectedDeliveryError) &&
        (
          activeErrorStage === "telegram_copy" ||
          activeErrorStage === "telegram_delivery" ||
          (activeErrorStage === "container_prepare" && !prepareOutcomeKnown)
        )
      ) {
        let currentDelivery: JobDeliveryRecord | null = null;
        try {
          currentDelivery = await getJobDelivery(this.env.DB, jobId);
        } catch {
          // The unknown result remains the safe operator state when D1 is
          // unavailable during this recovery checkpoint.
        }
        const reason = currentDelivery?.state === "unknown"
          ? currentDelivery.unknown_reason ?? "delivery_unknown"
          : activeErrorStage === "container_prepare"
            ? "container_prepare_workflow_timeout"
            : activeErrorStage === "telegram_copy"
              ? "telegram_copy_workflow_timeout"
              : "container_delivery_workflow_timeout";
        try {
          if (currentDelivery?.state !== "confirmed" && currentDelivery?.state !== "rejected") {
            await markDeliveryUnknown(this.env.DB, jobId, reason, generation);
          }
        } catch {
          // Recovery can persist the explicit unknown state later.
        }
        logStructured("media_job_delivery_unknown", {
          jobId,
          sourceHost: job.source_host,
          sourceUrlHash: job.source_url_hash,
          state: "unknown",
          errorStage: activeErrorStage,
        });
        return { status: "unknown", jobId, reason };
      }
      const directlyMapped = mapUnknownError(error);
      const appError = mapWorkflowError(error);
      const workflowErrorCodeRecovered = directlyMapped.code === "INTERNAL_ERROR" && appError.code !== "INTERNAL_ERROR";
      if (confirmedDelivery) {
        // Telegram accepted the media. Do not overwrite that success with a
        // failed D1 completion/cleanup attempt, and never send the media a
        // second time. The Workflow checkpoint can be reconciled separately.
        logStructured("media_job_delivery_confirmed", {
          jobId,
          sourceHost: job.source_host,
          sourceUrlHash: job.source_url_hash,
          state: "delivered",
          operationMs: Date.now() - started,
          errorCode: appError.code,
          errorStage: activeErrorStage,
          failureReason: failureReasonFor(error),
          workflowErrorName: safeWorkflowErrorName(error),
          workflowErrorCodeRecovered,
        });
        return {
          ...deliveryOutput(confirmedDelivery, null),
          jobId,
          bookkeepingPending: true,
        };
      }
      logStructured("media_job_failed", {
        jobId,
        sourceHost: job.source_host,
        sourceUrlHash: job.source_url_hash,
        state: "failed",
        operationMs: Date.now() - started,
        errorCode: appError.code,
        errorStage: activeErrorStage,
        failureReason: failureReasonFor(error),
        workflowErrorName: safeWorkflowErrorName(error),
        workflowErrorCodeRecovered,
      });
      activeErrorStage = "failure_persist";
      await steps.do(
        "record failure",
        { retries: { limit: 2, delay: "5 seconds", backoff: "linear" } },
        async () => {
          const current = await getJob(this.env.DB, jobId);
          const currentDelivery = await getJobDelivery(this.env.DB, jobId);
          if (currentDelivery?.state === "sending") {
            // Do not write a terminal job failure while the durable delivery
            // row still says a non-idempotent send is in flight. A transient
            // D1 failure must keep the job recoverable/unknown instead.
            const retryAfterSeconds = error instanceof RejectedDeliveryError ? error.retryAfterSeconds : undefined;
            const rejected = await recordDeliveryRejected(this.env.DB, jobId, safeMessageForError(appError.code), generation, retryAfterSeconds);
            if (!rejected) throw new ApplicationError("INTERNAL_ERROR", { retryable: true });
          }
          const failureExpiry = current?.r2_object_key
            ? r2RetentionExpiry(new Date(), getWorkerConfig(this.env).r2RetentionSeconds)
            : null;
          const failed = await setJobFailure(
            this.env.DB,
            jobId,
            appError.code,
            safeMessageForError(appError.code),
            { expires_at: failureExpiry },
            generation,
          );
          if (!failed) throw new ApplicationError("INTERNAL_ERROR", { retryable: true });
          if (current?.waiting_message_id) {
            try {
              const client = this.telegramClient();
              await client.editMessageText(current.telegram_chat_id, current.waiting_message_id, safeMessageForError(appError.code));
            } catch {
              // The job is still marked failed; avoid replacing the useful
              // stable error with a Telegram transport detail.
            }
          }
          return true;
        },
      );
      return {
        status: "failed",
        jobId,
        errorCode: appError.code,
        ...(error instanceof RejectedDeliveryError && error.retryAfterSeconds
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
      };
    } finally {
      try {
        await steps.do("dispatch waiting jobs", { retries: { limit: 0, delay: "1 second", backoff: "linear" } }, async () => {
          await dispatchQueuedJobs(this.env);
          return true;
        });
      } catch { /* The minute recovery scan retries after any dispatch/checkpoint failure. */ }
    }
  }

  /** Another attempt owns the send: report what it recorded and never send again. */
  private async refusedClaimOutcome(job: JobRecord): Promise<
    | { status: "completed"; delivery: ContainerDeliveryResult }
    | { status: "unknown"; reason: string }
    | { status: "rejected"; errorCode: "TELEGRAM_UPLOAD_FAILED"; retryAfterSeconds?: undefined }
  > {
    const currentDelivery = await getJobDelivery(this.env.DB, job.id);
    const alreadyConfirmed = currentDelivery ? deliveryFromRecord(currentDelivery, job) : null;
    if (alreadyConfirmed) return { status: "completed", delivery: alreadyConfirmed };
    if (currentDelivery?.state === "unknown") return { status: "unknown", reason: currentDelivery.unknown_reason ?? "delivery_unknown" };
    if (currentDelivery?.state === "rejected") return { status: "rejected", errorCode: "TELEGRAM_UPLOAD_FAILED" };
    return { status: "unknown", reason: "delivery_claim_unavailable" };
  }

  private async recordPreparedResult(jobId: string, preparedResult: ContainerSuccessResult): Promise<void> {
    await setJobState(this.env.DB, jobId, "processing", {
      output_filename: sanitizeFilename(preparedResult.filename),
      output_mime_type: preparedResult.mimeType,
      output_size_bytes: preparedResult.sizeBytes,
      output_duration_seconds: preparedResult.duration ?? null,
      r2_object_key: preparedResult.delivery === "r2" ? preparedResult.objectKey ?? null : null,
      progress: 90,
      updated_at: new Date().toISOString(),
    });
  }

  private telegramClient(): TelegramClient {
    const config = getWorkerConfig(this.env);
    return new TelegramClient({ token: this.env.TELEGRAM_BOT_TOKEN, apiBase: config.telegramApiBase });
  }

  private async markCompleted(jobId: string, delivery: ContainerDeliveryResult, preparedResult: ContainerSuccessResult): Promise<void> {
    const current = await getJob(this.env.DB, jobId);
    const messageId = positiveTelegramMessageId(delivery.telegramMessageId);
    if (!messageId) throw new UnknownDeliveryError("invalid_confirmed_message_id");
    if (current && clipCountForJob(current) !== 0) {
      const receipt = await getJobDelivery(this.env.DB, jobId);
      const ids = telegramMessageIds(delivery.telegramMessageIds, clipCountForJob(current), messageId);
      if (!receipt || ids === null || JSON.stringify(confirmedDeliveryMessageIds(receipt, current)) !== JSON.stringify(ids)) {
        throw new UnknownDeliveryError("clip_pack_receipt_incomplete");
      }
    }
    // A replay after a successful checkpoint must be a no-op. This also
    // prevents an already-completed job from receiving a newer expiry.
    if (current?.status === "completed" && current.result_message_id === messageId) return;
    const r2ObjectKey = delivery.delivery === "r2"
      ? delivery.objectKey ?? (preparedResult.delivery === "r2" ? preparedResult.objectKey ?? null : null)
      : preparedResult.delivery === "r2" ? preparedResult.objectKey ?? null : null;
    const retentionExpiry = r2ObjectKey
      ? r2RetentionExpiry(new Date(), getWorkerConfig(this.env).r2RetentionSeconds)
      : null;
    await setJobCompleted(this.env.DB, jobId, {
      result_message_id: messageId,
      progress: 100,
      output_filename: sanitizeFilename(delivery.filename ?? preparedResult.filename),
      output_mime_type: delivery.mimeType ?? preparedResult.mimeType,
      output_size_bytes: delivery.sizeBytes ?? preparedResult.sizeBytes,
      output_duration_seconds: preparedResult.duration ?? null,
      r2_object_key: r2ObjectKey,
      expires_at: delivery.expiresAt ?? retentionExpiry,
      updated_at: new Date().toISOString(),
    });
  }

  private containerForJob(job: JobRecord) {
    return job.requested_operation === "transcript" && job.transcript_method !== "captions"
      ? this.env.TRANSCRIPTION_CONTAINER
      : this.env.DOWNLOADER_CONTAINER;
  }

  private warmContainer(job: JobRecord): Promise<void> {
    const container = this.containerForJob(job);
    if (!container) return Promise.resolve();
    return (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const stub = getContainer(container as never, "personal");
        await Promise.race([
          stub.fetch(new Request("https://downloader.internal/health", { method: "GET" })),
          new Promise((resolve) => { timer = setTimeout(resolve, 250); }),
        ]);
      } catch { /* Warm-up is best effort and must never affect the job. */ }
      finally { clearTimeout(timer); }
    })();
  }

  private async prepareMedia(job: JobRecord, deadlineAt: number): Promise<ContainerJobResult> {
    await setJobState(this.env.DB, job.id, "probing");
    const encrypted = job.source_url_encrypted;
    if (!encrypted) throw new ApplicationError("INVALID_URL");
    const decryptedSource = await decryptSourceUrl(this.env.INTERNAL_CONTAINER_SECRET, encrypted);
    if (!decryptedSource) throw new ApplicationError("INVALID_URL");
    await setJobState(this.env.DB, job.id, "downloading");
    const config = getWorkerConfig(this.env);
    const request: ContainerJobRequest = buildPrepareRequest(job, decryptedSource, config, deadlineAt);
    const container = this.containerForJob(job);
    if (!container) throw new ApplicationError("INTERNAL_ERROR", { retryable: true });
    const stub = getContainer(container as never, "personal");
    let response: Response;
    let result: unknown;
    try {
      ({ response, result } = await fetchContainerJson(
        stub,
        (signal) => new Request("https://downloader.internal/v1/jobs/run", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.env.INTERNAL_CONTAINER_SECRET}`,
            ...buildContainerDeadlineHeaders(deadlineAt),
          },
          body: JSON.stringify(request),
          signal,
        }),
        deadlineAt,
      ));
    } catch (error) {
      if (error instanceof ContainerRequestDeadlineError) {
        throw new UnknownDeliveryError("container_prepare_deadline_expired", error);
      }
      if (error instanceof ContainerResponseBodyError) {
        throw new UnknownDeliveryError("container_prepare_response_unknown", error);
      }
      throw new UnknownDeliveryError("container_prepare_request_unknown", error);
    }
    let parsed: ContainerJobResult;
    try {
      parsed = parseContainerResult(result, clipCountForJob(job));
    } catch (error) {
      // A malformed result does not prove that the Container stopped before
      // creating a staged artifact. Preserve the operator gate rather than
      // retrying a request whose execution outcome is unknown.
      throw new UnknownDeliveryError("container_prepare_result_unknown", error);
    }
    if (parsed.status === "failure" || parsed.status === "failed") {
      logStructured("media_container_prepare_failed", {
        jobId: job.id,
        sourceHost: job.source_host,
        state: "downloading",
        errorCode: parsed.errorCode,
        errorStage: "container_prepare",
        containerDiagnostics: (result as ContainerFailureResult).diagnostics,
      });
      if (parsed.retryable) throw retryableContainerError(errorCodeFromContainerResult(parsed.errorCode));
      return parsed;
    }
    if (job.requested_operation === "transcript" && "delivery" in parsed && parsed.delivery !== "telegram") {
      throw new ApplicationError("PROCESSING_FAILED");
    }
    if (!response.ok) throw new ApplicationError("DOWNLOAD_FAILED");
    return parsed;
  }

  private async deliverPrepared(job: JobRecord, prepared: ContainerSuccessResult, deadlineAt: number): Promise<ContainerDeliveryResult> {
    await setJobState(this.env.DB, job.id, "uploading");
    const container = this.containerForJob(job);
    if (!container) throw new ApplicationError("TELEGRAM_UPLOAD_FAILED");
    const request: ContainerDeliveryRequest = buildDeliveryRequest(job, prepared, deadlineAt);
    const stub = getContainer(container as never, "personal");
    let response: Response;
    let result: unknown;
    try {
      ({ response, result } = await fetchContainerJson(
        stub,
        (signal) => new Request("https://downloader.internal/v1/jobs/deliver", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.env.INTERNAL_CONTAINER_SECRET}`,
            ...buildContainerDeadlineHeaders(deadlineAt),
          },
          body: JSON.stringify(request),
          signal,
        }),
        deadlineAt,
      ));
    } catch (error) {
      if (error instanceof ContainerRequestDeadlineError) {
        throw new UnknownDeliveryError("container_delivery_deadline_expired", error);
      }
      if (error instanceof ContainerResponseBodyError) {
        throw new UnknownDeliveryError("container_delivery_response_unknown", error);
      }
      throw new UnknownDeliveryError("container_delivery_request_unknown", error);
    }
    const parsed = parseDeliveryResult(result, job.id, clipCountForJob(job));
    if (parsed.status === "failure" || parsed.status === "failed") {
      if (parsed.outcome !== "rejected") throw new UnknownDeliveryError("container_delivery_outcome_ambiguous");
      throw new RejectedDeliveryError(errorCodeFromContainerResult(parsed.errorCode), parsed.retryAfterSeconds);
    }
    if (!response.ok || (parsed.status !== "success" && parsed.status !== "completed")) throw new UnknownDeliveryError("container_delivery_result_unknown");
    return parsed;
  }

  private async copyReusableMedia(job: JobRecord, reusableJob: JobRecord, generation: number): Promise<ContainerDeliveryResult | null> {
    if (!reusableJob.result_message_id) return null;
    try {
      const copied = await this.telegramClient().copyMessage(
        job.telegram_chat_id,
        reusableJob.telegram_chat_id,
        reusableJob.result_message_id,
      );
      return {
        status: "completed",
        delivery: "telegram",
        telegramMessageId: copied.message_id,
        filename: reusableJob.output_filename ? sanitizeFilename(reusableJob.output_filename) : undefined,
        mimeType: reusableJob.output_mime_type ?? undefined,
        sizeBytes: reusableJob.output_size_bytes ?? undefined,
      };
    } catch (error) {
      // A 400 from copyMessage means the old Telegram message/file is stale.
      // Evict only that reusable pointer, then let this job use the normal
      // source pipeline. Any network/5xx error remains terminal because a
      // second send after an ambiguous response could duplicate the media.
      const provenStaleCopyRejection = error instanceof TelegramApiError
        && error.outcome === "rejected"
        && (error.httpStatus === 400 || (error.httpStatus >= 200 && error.httpStatus < 300 && error.apiErrorCode === 400));
      if (provenStaleCopyRejection) {
        try {
          await updateJob(this.env.DB, reusableJob.id, {
            cache_valid: 0,
            updated_at: new Date().toISOString(),
          });
          await resetDeliverySending(this.env.DB, job.id, generation);
        } catch {
          // The old receipt remains historical even when cache eviction is
          // temporarily unavailable. The current send permit is recovered by
          // the dispatch generation before a cold attempt can proceed.
        }
        return null;
      }
      throw new UnknownDeliveryError("telegram_copy_response_unknown", error);
    }
  }

  private async deleteWaitingMessage(job: JobRecord): Promise<boolean> {
    if (!job.waiting_message_id) return true;
    try {
      const result = await this.telegramClient().deleteMessage(job.telegram_chat_id, job.waiting_message_id);
      // Telegram returns false for a message that is already gone. That is
      // the desired final state, so both booleans are successful here.
      return result === true || result === false;
    } catch (error) {
      if (
        error instanceof TelegramApiError &&
        error.httpStatus === 400 &&
        /message[^\n]*(?:not found|can't be deleted|cannot be deleted)/iu.test(error.description ?? "")
      ) return true;
      throw telegramErrorToApplicationError(error);
    }
  }
}

function parseContainerResult(value: unknown, expectedClipCount = 0): ContainerJobResult {
  if (typeof value !== "object" || value === null) throw new ApplicationError("DOWNLOAD_FAILED", { retryable: true });
  const candidate = value as Partial<ContainerJobResult>;
  if (candidate.status === "failure" || candidate.status === "failed") {
    if (typeof candidate.errorCode !== "string" || typeof candidate.retryable !== "boolean") throw new ApplicationError("DOWNLOAD_FAILED", { retryable: true });
    const errorCode = errorCodeFromContainerResult(candidate.errorCode);
    return {
      status: candidate.status,
      errorCode,
      safeMessage: typeof candidate.safeMessage === "string" ? candidate.safeMessage : safeMessageForError(errorCode),
      retryable: isExplicitlyRetryableContainerFailure(errorCode, candidate.retryable),
    };
  }
  if (
    (candidate.status === "prepared" || candidate.status === "success" || candidate.status === "completed") &&
    (candidate.delivery === "telegram" || candidate.delivery === "telegram_url" || candidate.delivery === "r2") &&
    typeof candidate.filename === "string" &&
    typeof candidate.mimeType === "string" &&
    typeof candidate.sizeBytes === "number" &&
    Number.isSafeInteger(candidate.sizeBytes) &&
    candidate.sizeBytes >= 0
  ) {
    // Prepare must always return a staged, R2, or opaque direct-delivery key
    // for the final delivery call. A missing key is a protocol failure and
    // must not be retried because the prepared artifact may already exist.
    if (!candidate.objectKey) throw new ApplicationError("DOWNLOAD_FAILED");
    if (expectedClipCount !== 0) {
      if ((expectedClipCount !== 2 && expectedClipCount !== 3) || candidate.clipCount !== expectedClipCount || candidate.delivery !== "telegram"
        || candidate.mimeType !== "video/mp4" || candidate.sizeBytes <= 0 || candidate.sizeBytes > 49_000_000
        || typeof candidate.duration !== "number" || !Number.isFinite(candidate.duration) || candidate.duration <= 0
        || candidate.duration > Math.min(120 * expectedClipCount, 300) + 0.25 * expectedClipCount) throw new ApplicationError("DOWNLOAD_FAILED");
    } else if (candidate.clipCount !== undefined) throw new ApplicationError("DOWNLOAD_FAILED");
    return candidate as ContainerSuccessResult;
  }
  throw new ApplicationError("DOWNLOAD_FAILED", { retryable: true });
}

function validDeliveryObjectKey(value: unknown, jobId: string): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 320) return null;
  const prefix = value.startsWith(`jobs/${jobId}/`)
    ? `jobs/${jobId}/`
    : value.startsWith(`staged/${jobId}/`) ? `staged/${jobId}/` : null;
  if (!prefix) return null;
  const filename = value.slice(prefix.length);
  if (!filename || filename.includes("/") || filename.includes("\\") || sanitizeFilename(filename) !== filename) return null;
  return value;
}

function validDeliveryMimeType(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return null;
  return /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u.test(value) ? value : null;
}

function validDeliverySize(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_DELIVERY_OUTPUT_BYTES
    ? value
    : null;
}

function validDeliveryExpiry(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function parseDeliveryResult(value: unknown, jobId = "", expectedClipCount = 0): ContainerDeliveryResult | ContainerFailureResult {
  if (typeof value !== "object" || value === null) throw new UnknownDeliveryError("malformed_delivery_result");
  const candidate = value as Partial<ContainerDeliveryResult> & Partial<ContainerFailureResult>;
  if ((candidate.status === "failure" || candidate.status === "failed") && typeof candidate.errorCode === "string") {
    if (candidate.outcome !== "rejected" && candidate.outcome !== "ambiguous") {
      throw new UnknownDeliveryError("delivery_outcome_unclassified");
    }
    const errorCode = errorCodeFromContainerResult(candidate.errorCode);
    const retryAfterSeconds = expectedClipCount === 0 && errorCode === "TELEGRAM_RATE_LIMITED" && candidate.outcome === "rejected"
      ? positiveRetryAfterSeconds(candidate.retryAfterSeconds)
      : null;
    return {
      status: candidate.status,
      errorCode,
      safeMessage: typeof candidate.safeMessage === "string" ? candidate.safeMessage : safeMessageForError(errorCode),
      retryable: typeof candidate.retryable === "boolean" ? candidate.retryable : false,
      outcome: candidate.outcome,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    };
  }
  if (candidate.status === "failure" || candidate.status === "failed") throw new UnknownDeliveryError("malformed_delivery_failure");
  if (
    (candidate.status === "success" || candidate.status === "completed") &&
    (candidate.delivery === undefined || candidate.delivery === "telegram" || candidate.delivery === "telegram_url" || candidate.delivery === "r2") &&
    (typeof candidate.telegramMessageId === "string" || typeof candidate.telegramMessageId === "number")
  ) {
    const messageId = positiveTelegramMessageId(candidate.telegramMessageId);
    if (!messageId) throw new UnknownDeliveryError("invalid_confirmed_message_id");
    const ids = telegramMessageIds(candidate.telegramMessageIds, expectedClipCount, messageId);
    if (ids === null || (expectedClipCount !== 0 && candidate.delivery !== "telegram")) throw new UnknownDeliveryError("clip_pack_receipt_incomplete");
    const objectKey = validDeliveryObjectKey(candidate.objectKey, jobId);
    const mimeType = validDeliveryMimeType(candidate.mimeType);
    const sizeBytes = validDeliverySize(candidate.sizeBytes);
    const expiresAt = validDeliveryExpiry(candidate.expiresAt);
    return {
      status: candidate.status,
      delivery: candidate.delivery,
      telegramMessageId: messageId,
      ...(ids.length ? { telegramMessageIds: ids } : {}),
      ...(objectKey ? { objectKey } : {}),
      ...(typeof candidate.filename === "string" ? { filename: sanitizeFilename(candidate.filename) } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(sizeBytes !== null ? { sizeBytes } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
  }
  throw new UnknownDeliveryError("malformed_delivery_result");
}

export { parseContainerResult };

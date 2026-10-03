export type ErrorStage =
  | "workflow_setup"
  | "workflow_queue"
  | "cache_lookup"
  | "telegram_copy"
  | "container_prepare"
  | "prepared_result_persist"
  | "telegram_delivery"
  | "completion_persist"
  | "waiting_message_cleanup"
  | "failure_persist";

export type FailureReason = "application_error" | "workflow_wrapper" | "unexpected_error";

export type WorkflowErrorName =
  | "ApplicationError"
  | "WorkflowInternalError"
  | "AbortError"
  | "TypeError"
  | "Error"
  | "UnknownError";

export interface StructuredLogFields {
  jobId?: string;
  sourceHost?: string;
  sourceUrlHash?: string;
  state?: string;
  operationMs?: number;
  outputSize?: number;
  errorCode?: string;
  retryCount?: number;
  telegramHttpStatus?: number;
  telegramApiErrorCode?: number;
  telegramRetryAfterSeconds?: number;
  errorStage?: ErrorStage;
  failureReason?: FailureReason;
  workflowAttempt?: number;
  workflowErrorName?: WorkflowErrorName;
  workflowErrorCodeRecovered?: boolean;
  containerDiagnostics?: unknown;
}

function safeContainerDiagnostics(value: unknown): Record<string, string | number | boolean> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const fields = value as Record<string, unknown>;
  const safe: Record<string, string | number | boolean> = {};
  const stages = ["request", "dependency_check", "direct_resolve", "probe", "format_selection", "download_process", "download_output", "media_verify", "transcode", "staging", "telegram_delivery", "r2_upload", "internal"];
  const reasons = ["invalid_input", "unauthorized", "unsupported_source", "unsupported_media", "auth_required", "media_private", "source_unavailable", "no_formats", "js_challenge_failed", "network_error", "invalid_probe_output", "invalid_probe_metadata", "source_rate_limited", "http_forbidden", "source_blocked", "network_blocked", "limit_exceeded", "timeout", "process_failed", "dependency_missing", "media_processing_failed", "telegram_rate_limited", "telegram_failure", "storage_failure", "internal"];
  if (typeof fields.error_stage === "string" && stages.includes(fields.error_stage)) safe.container_error_stage = fields.error_stage;
  if (typeof fields.failure_reason === "string" && reasons.includes(fields.failure_reason)) safe.container_failure_reason = fields.failure_reason;
  if (typeof fields.process_name === "string" && ["yt-dlp", "ffmpeg", "ffprobe"].includes(fields.process_name)) safe.process_name = fields.process_name;
  if (typeof fields.process_exit_code === "number" && Number.isInteger(fields.process_exit_code)
    && fields.process_exit_code >= -(2 ** 31) && fields.process_exit_code < 2 ** 31) safe.process_exit_code = fields.process_exit_code;
  if (typeof fields.process_timed_out === "boolean") safe.process_timed_out = fields.process_timed_out;
  return safe;
}

/** Emit only allowlisted operational fields; never pass a complete URL/token. */
export function logStructured(event: string, fields: StructuredLogFields = {}): void {
  const payload = {
    event,
    timestamp: new Date().toISOString(),
    ...(fields.jobId ? { job_id: fields.jobId } : {}),
    ...(fields.sourceHost ? { source_host: fields.sourceHost } : {}),
    ...(fields.sourceUrlHash ? { source_url_hash: fields.sourceUrlHash } : {}),
    ...(fields.state ? { state: fields.state } : {}),
    ...(typeof fields.operationMs === "number" ? { operation_ms: fields.operationMs } : {}),
    ...(typeof fields.outputSize === "number" ? { output_size: fields.outputSize } : {}),
    ...(fields.errorCode ? { error_code: fields.errorCode } : {}),
    ...(typeof fields.retryCount === "number" ? { retry_count: fields.retryCount } : {}),
    ...(typeof fields.telegramHttpStatus === "number" ? { telegram_http_status: fields.telegramHttpStatus } : {}),
    ...(typeof fields.telegramApiErrorCode === "number" ? { telegram_api_error_code: fields.telegramApiErrorCode } : {}),
    ...(typeof fields.telegramRetryAfterSeconds === "number" ? { telegram_retry_after_seconds: fields.telegramRetryAfterSeconds } : {}),
    ...(fields.errorStage ? { error_stage: fields.errorStage } : {}),
    ...(fields.failureReason ? { failure_reason: fields.failureReason } : {}),
    ...(typeof fields.workflowAttempt === "number" ? { workflow_attempt: fields.workflowAttempt } : {}),
    ...(fields.workflowErrorName ? { workflow_error_name: fields.workflowErrorName } : {}),
    ...(typeof fields.workflowErrorCodeRecovered === "boolean"
      ? { workflow_error_code_recovered: fields.workflowErrorCodeRecovered }
      : {}),
    ...safeContainerDiagnostics(fields.containerDiagnostics),
  };
  console.log(JSON.stringify(payload));
}

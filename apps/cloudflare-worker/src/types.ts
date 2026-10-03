import type { TrimRange } from "./trim";

/** Public application states. Keep these values stable for status consumers. */
export const JOB_STATES = [
  "received",
  "queued",
  "probing",
  "downloading",
  "processing",
  "uploading",
  "completed",
  "failed",
] as const;

export type JobState = (typeof JOB_STATES)[number];
export type MediaMode = "video" | "audio";
export type JobSourceKind = "url" | "telegram_file";
export type JobOperation = "download" | "transcript";
export type TranscriptMethod = "whisper" | "captions";
export type AdmissionLane = "source" | "transcript";

export const DISPATCH_INTENT_STATES = ["pending", "leased", "started", "complete"] as const;
export type DispatchIntentState = (typeof DISPATCH_INTENT_STATES)[number];

export const DELIVERY_STATES = ["not_started", "sending", "confirmed", "rejected", "unknown"] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];
export type DeliveryMethod = "telegram" | "telegram_url" | "r2";
export type DeliveryOutcome = "rejected" | "ambiguous";

/**
 * The stable keyset cursor used by the private history queries.  The API
 * layer owns encoding this value for clients; database helpers only receive
 * the already-decoded pair so no cursor text is interpolated into SQL.
 */
export interface JobHistoryCursor {
  createdAt: string;
  jobId: string;
}

export type ActivityPeriod = "24h" | "7d" | "30d" | "all";
export type ActivityTask = "video" | "audio" | "image" | "other" | "whisper" | "captions" | "clips";
export type ActivityOutcome = "confirmed" | "failed" | "unfinished" | "needs_review";
export interface ActivityWindow {
  period: ActivityPeriod;
  asOf: string;
  since: string | null;
  task: ActivityTask | null;
}

export interface JobHistoryListOptions {
  limit?: number;
  cursor?: JobHistoryCursor;
  window?: ActivityWindow;
}

export interface JobHistoryPage {
  jobs: HistoryJobRecord[];
  nextCursor: JobHistoryCursor | null;
}

/** Generated binding/variable contract plus secret names not represented in wrangler vars. */
export interface Env extends Omit<Cloudflare.Env, "INTEGRATION_ENABLED" | "INTEGRATION_ALLOWED_ORIGINS"> {
  INTEGRATION_ENABLED?: string;
  INTEGRATION_ALLOWED_ORIGINS?: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  INTERNAL_CONTAINER_SECRET: string;
  ALLOWED_TELEGRAM_USER_IDS: string;
  DOWNLOAD_LINK_HMAC_SECRET: string;

  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

/** Minimal binding contracts keep unit tests independent of workerd classes. */
export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success?: boolean; meta?: { changes?: number } }>;
}

export interface D1BatchResultLike {
  success?: boolean;
  meta?: { changes?: number };
  results?: unknown[];
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}

export interface D1BatchDatabaseLike extends D1DatabaseLike {
  batch(statements: D1PreparedStatementLike[]): Promise<D1BatchResultLike[]>;
}

export interface R2ObjectLike {
  body: ReadableStream<Uint8Array> | null;
  size?: number;
  httpMetadata?: { contentType?: string; contentDisposition?: string };
  httpEtag?: string;
  uploaded?: Date;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
  put(key: string, value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | Blob, options?: Record<string, unknown>): Promise<unknown>;
  delete(key: string): Promise<void>;
  list?(options?: { limit?: number; cursor?: string }): Promise<{ objects: Array<{ key: string; uploaded?: Date }>; truncated: boolean; cursor?: string }>;
}

export interface WorkflowBindingLike {
  create?(options: { id: string; params: WorkflowParams }): Promise<unknown>;
  createBatch?(batch: Array<{ id: string; params: WorkflowParams }>): Promise<unknown>;
  get?(id: string): Promise<WorkflowInstanceLike>;
}

export interface WorkflowInstanceLike {
  id: string;
  status(): Promise<WorkflowInstanceStatusLike>;
}

export interface WorkflowInstanceStatusLike {
  status: "queued" | "running" | "paused" | "errored" | "terminated" | "complete" | "waiting" | "waitingForPause" | "unknown";
  error?: { name: string; message: string };
  output?: unknown;
}

export interface ContainerStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface ContainerNamespaceLike {
  getByName?(name: string): ContainerStubLike;
  get?(id: unknown): ContainerStubLike;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  document?: unknown;
  video?: unknown;
  audio?: unknown;
  voice?: unknown;
  photo?: unknown;
  sticker?: unknown;
  animation?: unknown;
  video_note?: unknown;
  media_group_id?: unknown;
  caption?: unknown;
  forward_origin?: unknown;
  reply_to_message?: TelegramMessage;
  date?: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: unknown;
}

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export interface TelegramInlineKeyboardButton {
  text: string;
  url?: string;
  web_app?: { url: string };
  callback_data?: string;
}

export interface TelegramMessageResult {
  message_id: number;
  chat?: TelegramChat;
}

export interface JobRecord {
  id: string;
  telegram_update_id: string;
  telegram_user_id: string;
  telegram_chat_id: string;
  request_message_id: string | null;
  waiting_message_id: string | null;
  result_message_id: string | null;
  source_host: string;
  source_kind?: JobSourceKind;
  source_url_hash: string;
  source_url_encrypted: string | null;
  requested_mode: MediaMode;
  requested_operation?: JobOperation;
  transcript_method?: TranscriptMethod;
  caption_language?: string | null;
  requested_quality: string | null;
  requested_start_seconds?: number | null;
  requested_end_seconds?: number | null;
  requested_clip_ranges?: string | null;
  processing_policy_version: string;
  cache_valid: number;
  status: JobState;
  progress: number | null;
  output_filename: string | null;
  output_mime_type: string | null;
  output_size_bytes: number | null;
  output_duration_seconds: number | null;
  r2_object_key: string | null;
  error_code: string | null;
  safe_error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  expires_at: string | null;
  deadline_at?: number | null;
}

/** Columns needed by the private history UI and safe terminal cleanup. */
export type HistoryJobRecord = Pick<JobRecord,
  | "id"
  | "source_host"
  | "requested_mode"
  | "requested_operation"
  | "transcript_method"
  | "source_kind"
  | "requested_clip_ranges"
  | "status"
  | "output_filename"
  | "output_mime_type"
  | "output_size_bytes"
  | "r2_object_key"
  | "created_at"
  | "completed_at"
  | "expires_at"
> & ActivityReceiptFields;

export interface ActivityReceiptFields {
  delivery_state?: DeliveryState | null;
  delivery_method?: DeliveryMethod | null;
  telegram_message_id?: string | null;
  telegram_message_ids?: string | null;
}

export type ActivityJobRecord = Pick<JobRecord, "id" | "created_at" | "status" | "source_host" | "source_kind" | "requested_mode" | "requested_operation" | "transcript_method" | "requested_clip_ranges" | "output_mime_type"> & ActivityReceiptFields;

export interface WorkflowParams {
  jobId: string;
}

export interface DispatchIntentRecord {
  job_id: string;
  state: DispatchIntentState;
  generation: number;
  attempts: number;
  available_at: string;
  lease_expires_at: string | null;
  workflow_instance_id: string;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobDeliveryRecord {
  job_id: string;
  state: DeliveryState;
  method: DeliveryMethod | null;
  telegram_message_id: string | null;
  telegram_message_ids?: string | null;
  retry_after_seconds: number | null;
  object_key: string | null;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  expires_at: string | null;
  unknown_reason: string | null;
  owner_generation: number | null;
  created_at: string;
  updated_at: string;
}

export interface TelegramFileSource {
  fileId: string;
  fileSize: number;
  fileName?: string;
}

export type ContainerJobRequest = {
  jobId: string;
  telegramChatId: string;
  waitingMessageId: number;
  mode: MediaMode;
  maximumHeight: number;
  preferredFormat: "mp4" | "m4a" | "mp3";
  operation?: JobOperation;
  transcriptMethod?: TranscriptMethod;
  captionLanguage?: string;
  trimStartSeconds?: number;
  trimEndSeconds?: number;
  clipRanges?: TrimRange[];
  deadlineAt?: number;
} & ({ sourceUrl: string; telegramFile?: never } | { sourceUrl?: never; telegramFile: TelegramFileSource });

export interface ContainerDeliveryRequest {
  jobId: string;
  telegramChatId: string;
  objectKey: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  mode: MediaMode;
  operation?: JobOperation;
  transcriptMethod?: TranscriptMethod;
  captionLanguage?: string;
  deliveryMode: "telegram" | "telegram_url" | "r2";
  clipRanges?: TrimRange[];
  deadlineAt?: number;
}

export interface ContainerSuccessResult {
  status: "prepared" | "success" | "completed";
  delivery: "telegram" | "telegram_url" | "r2";
  telegramMessageId?: string | number;
  clipCount?: number;
  objectKey?: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  duration?: number;
  width?: number;
  height?: number;
  expiresAt?: string;
  title?: string;
  sourcePlatform?: string;
  /** Echoed by newer Containers; the Worker keeps its durable value authoritative. */
  deadlineAt?: number;
}

export interface ContainerFailureResult {
  status: "failure" | "failed";
  errorCode: string;
  safeMessage: string;
  retryable: boolean;
  /** Untrusted internal diagnostics are allowlisted at the logging boundary. */
  diagnostics?: unknown;
  outcome?: DeliveryOutcome;
  /** Preserved only for an explicit, proven Telegram 429 rejection. */
  retryAfterSeconds?: number;
}

export type ContainerJobResult = ContainerSuccessResult | ContainerFailureResult;

export interface ContainerDeliveryResult {
  status: "success" | "completed";
  delivery?: "telegram" | "telegram_url" | "r2";
  telegramMessageId: string | number;
  telegramMessageIds?: Array<string | number>;
  objectKey?: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  expiresAt?: string;
  /** Echoed by newer Containers; older delivery responses omit it. */
  deadlineAt?: number;
}

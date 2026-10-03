import { clipCountForJob, validateClipRanges, type TrimRange } from "./trim";
import type { ErrorCode } from "./errors";
import type {
  ActivityJobRecord,
  ActivityWindow,
  D1BatchDatabaseLike,
  D1DatabaseLike,
  D1PreparedStatementLike,
  AdmissionLane,
  DeliveryMethod,
  DispatchIntentRecord,
  HistoryJobRecord,
  JobHistoryListOptions,
  JobHistoryCursor,
  JobHistoryPage,
  JobDeliveryRecord,
  JobOperation,
  JobSourceKind,
  JobRecord,
  JobState,
  MediaMode,
  TranscriptMethod,
} from "./types";

export const HISTORY_PAGE_DEFAULT_LIMIT = 20;
export const HISTORY_PAGE_MAX_LIMIT = 50;
export const TERMINAL_HISTORY_BATCH_MAX_LIMIT = 100;
export const MEDIA_PROCESSING_POLICY_VERSION = "v2";
export const MAX_UNFINISHED_JOBS_PER_USER = 5;
export const USER_QUEUE_MAX_LIMIT = 10;

/** Avoid loading encrypted URLs, Telegram identifiers, and internal fields for history pages. */
export const HISTORY_LIST_COLUMNS = [
  "id",
  "source_host",
  "requested_mode",
  "requested_operation",
  "transcript_method",
  "source_kind",
  "requested_clip_ranges",
  "status",
  "output_filename",
  "output_mime_type",
  "output_size_bytes",
  "r2_object_key",
  "created_at",
  "completed_at",
  "expires_at",
] as const satisfies readonly (keyof HistoryJobRecord)[];

export interface UserQueueJob {
  id: string;
  source_host: string;
  requested_mode: MediaMode;
  requested_operation: JobOperation;
  transcript_method: TranscriptMethod | null;
  requested_clip_ranges?: string | null;
  status: JobState;
  position: number | null;
  delivery_state: JobDeliveryRecord["state"] | null;
}

const JOB_COLUMNS = [
  "request_message_id",
  "waiting_message_id",
  "result_message_id",
  "status",
  "progress",
  "output_filename",
  "output_mime_type",
  "output_size_bytes",
  "output_duration_seconds",
  "r2_object_key",
  "error_code",
  "safe_error_message",
  "updated_at",
  "completed_at",
  "expires_at",
  "source_url_encrypted",
  "processing_policy_version",
  "cache_valid",
  "deadline_at",
] as const;

type JobColumn = (typeof JOB_COLUMNS)[number];

function statement(db: D1DatabaseLike, sql: string, ...values: unknown[]): D1PreparedStatementLike {
  return db.prepare(sql).bind(...values);
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(value)));
}

/** Keep lane derivation identical for admission, promotion, and projections. */
function jobLaneSql(alias: string): string {
  return `CASE WHEN ${alias}.requested_operation = 'transcript'
    AND COALESCE(${alias}.transcript_method, 'whisper') <> 'captions'
    THEN 'transcript' ELSE 'source' END`;
}

function normalizedAdmissionLane(job: NewJob): AdmissionLane {
  return job.requestedOperation === "transcript" && job.transcriptMethod !== "captions" ? "transcript" : "source";
}

export interface DispatchAdmissionLimits {
  maxActiveJobs?: number;
  maxActiveTranscriptions?: number;
}

function boundedAdmissionLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fallback;
  return value;
}

const ACTIVITY_RECEIPT_COLUMNS = "d.state AS delivery_state, d.method AS delivery_method, d.telegram_message_id, d.telegram_message_ids";

// Keep this ordering aligned with activityTaskForJob: request kind first, then actual output MIME.
const ACTIVITY_TASK_SQL = `CASE
  WHEN j.requested_clip_ranges IS NOT NULL THEN 'clips'
  WHEN j.requested_operation = 'transcript' THEN CASE WHEN j.transcript_method = 'captions' THEN 'captions' ELSE 'whisper' END
  WHEN j.output_mime_type IS NULL OR trim(j.output_mime_type) = '' THEN j.requested_mode
  WHEN lower(trim(j.output_mime_type)) LIKE 'video/%' THEN 'video'
  WHEN lower(trim(j.output_mime_type)) LIKE 'audio/%' THEN 'audio'
  WHEN lower(trim(j.output_mime_type)) LIKE 'image/%' THEN 'image'
  ELSE 'other' END`;

function activityWhere(values: unknown[], window?: ActivityWindow, cursor?: JobHistoryCursor): string {
  let sql = "";
  if (window) {
    values.push(window.asOf);
    sql += ` AND j.created_at <= ?${values.length}`;
    if (window.since) {
      values.push(window.since);
      sql += ` AND j.created_at >= ?${values.length}`;
    }
    if (window.task) {
      values.push(window.task);
      sql += ` AND (${ACTIVITY_TASK_SQL}) = ?${values.length}`;
    }
  }
  if (cursor) {
    values.push(cursor.createdAt, cursor.jobId);
    sql += ` AND (j.created_at < ?${values.length - 1} OR (j.created_at = ?${values.length - 1} AND j.id < ?${values.length}))`;
  }
  return sql;
}

/** Bounded metadata only; never load encrypted URLs or content for activity. */
export async function listActivityJobsForUser(db: D1DatabaseLike, userId: string, window: ActivityWindow, cursor?: JobHistoryCursor, limit = 100): Promise<ActivityJobRecord[]> {
  const values: unknown[] = [userId];
  const filter = activityWhere(values, window, cursor);
  values.push(Math.max(1, Math.min(100, Math.trunc(limit) || 100)));
  return (await statement(db, `SELECT j.id, j.created_at, j.status, j.source_host, j.source_kind,
    j.requested_mode, j.requested_operation, j.transcript_method, j.requested_clip_ranges,
    j.output_mime_type, ${ACTIVITY_RECEIPT_COLUMNS}
    FROM jobs j LEFT JOIN job_deliveries d ON d.job_id = j.id
    WHERE j.telegram_user_id = ?1${filter}
    ORDER BY j.created_at DESC, j.id DESC LIMIT ?${values.length}`, ...values).all<ActivityJobRecord>()).results;
}

async function listHistoryPage(
  db: D1DatabaseLike,
  userId: string,
  options: JobHistoryListOptions | undefined,
  maximumLimit: number,
  statusClause = "",
): Promise<JobHistoryPage> {
  const limit = boundedLimit(options?.limit, HISTORY_PAGE_DEFAULT_LIMIT, maximumLimit);
  const cursor = options?.cursor;
  const values: unknown[] = [userId];
  const filter = activityWhere(values, options?.window, cursor);
  values.push(limit + 1);
  const rows = await statement(
    db,
    `SELECT ${HISTORY_LIST_COLUMNS.map((column) => `j.${column}`).join(", ")}, ${ACTIVITY_RECEIPT_COLUMNS}
     FROM jobs j LEFT JOIN job_deliveries d ON d.job_id = j.id
     WHERE j.telegram_user_id = ?1${statusClause}${filter}
     ORDER BY j.created_at DESC, j.id DESC LIMIT ?${values.length}`,
    ...values,
  ).all<HistoryJobRecord>();
  const hasNext = rows.results.length > limit;
  const jobs = hasNext ? rows.results.slice(0, limit) : rows.results;
  const last = jobs.at(-1);
  return {
    jobs,
    nextCursor: hasNext && last ? { createdAt: last.created_at, jobId: last.id } : null,
  };
}

export async function getJob(db: D1DatabaseLike, jobId: string): Promise<JobRecord | null> {
  return statement(db, "SELECT * FROM jobs WHERE id = ?1", jobId).first<JobRecord>();
}

export async function getLatestJobForUser(db: D1DatabaseLike, userId: string): Promise<JobRecord | null> {
  return statement(db, "SELECT * FROM jobs WHERE telegram_user_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1", userId).first<JobRecord>();
}

/** Return one keyset-paginated history page scoped to one authenticated user. */
export async function listJobsForUser(
  db: D1DatabaseLike,
  userId: string,
  options: JobHistoryListOptions = {},
): Promise<JobHistoryPage> {
  return listHistoryPage(db, userId, options, HISTORY_PAGE_MAX_LIMIT);
}

/**
 * Return a bounded projection of one user's unfinished queue. Positions are
 * lane-local and count only older, still-unadmitted pending jobs; an active
 * admission therefore has a null position. The created-at/ID tuple is used
 * consistently so ordering remains stable across SQLite maintenance.
 */
export async function getUserQueue(
  db: D1DatabaseLike,
  userId: string,
  limit = USER_QUEUE_MAX_LIMIT,
): Promise<UserQueueJob[]> {
  const bounded = boundedLimit(limit, USER_QUEUE_MAX_LIMIT, USER_QUEUE_MAX_LIMIT);
  const lane = jobLaneSql("j");
  const olderLane = jobLaneSql("older");
  const rows = await statement(
    db,
    `SELECT j.id, j.source_host, j.requested_mode, j.requested_operation,
            j.transcript_method, j.requested_clip_ranges, j.status, delivery.state AS delivery_state,
            CASE
              WHEN active.job_id IS NULL
               AND dispatch.state = 'pending'
               AND delivery.state = 'not_started'
               AND j.status NOT IN ('completed', 'failed')
              THEN 1 + (
                SELECT COUNT(*)
                FROM jobs older
                WHERE (older.created_at < j.created_at
                   OR (older.created_at = j.created_at AND older.id < j.id))
                  AND older.status NOT IN ('completed', 'failed')
                  AND ${olderLane} = ${lane}
                  AND NOT EXISTS (
                    SELECT 1 FROM active_job_admissions older_active
                    WHERE older_active.job_id = older.id
                  )
                  AND EXISTS (
                    SELECT 1 FROM job_dispatch_intents older_dispatch
                    WHERE older_dispatch.job_id = older.id
                      AND older_dispatch.state = 'pending'
                  )
                  AND EXISTS (
                    SELECT 1 FROM job_deliveries older_delivery
                    WHERE older_delivery.job_id = older.id
                      AND older_delivery.state = 'not_started'
                  )
              )
              ELSE NULL
            END AS position
     FROM jobs j
     LEFT JOIN active_job_admissions active ON active.job_id = j.id
     LEFT JOIN job_dispatch_intents dispatch ON dispatch.job_id = j.id
     LEFT JOIN job_deliveries delivery ON delivery.job_id = j.id
     WHERE j.telegram_user_id = ?1
       AND j.status NOT IN ('completed', 'failed')
     ORDER BY j.created_at ASC, j.id ASC
     LIMIT ?2`,
    userId,
    bounded,
  ).all<UserQueueJob & { position: number | string | null }>();
  return rows.results.map((row) => ({
    ...row,
    position: row.position === null ? null : Number(row.position),
  }));
}

/** Return terminal history rows in a bounded, user-scoped batch. */
export async function listTerminalJobsForUser(
  db: D1DatabaseLike,
  userId: string,
  options: JobHistoryListOptions = {},
): Promise<JobHistoryPage> {
  return listHistoryPage(
    db,
    userId,
    options,
    TERMINAL_HISTORY_BATCH_MAX_LIMIT,
    " AND j.status IN ('completed', 'failed')",
  );
}

/** Fetch a history row only when it belongs to the authenticated user. */
export async function getJobByIdForUser(db: D1DatabaseLike, jobId: string, userId: string): Promise<HistoryJobRecord | null> {
  return statement(
    db,
    `SELECT ${HISTORY_LIST_COLUMNS.map((column) => `j.${column}`).join(", ")}, ${ACTIVITY_RECEIPT_COLUMNS}
     FROM jobs j LEFT JOIN job_deliveries d ON d.job_id = j.id
     WHERE j.id = ?1 AND j.telegram_user_id = ?2 LIMIT 1`,
    jobId,
    userId,
  ).first<HistoryJobRecord>();
}

/** Return the most recent reusable Telegram result for the same private user/chat. */
export async function getLatestCompletedJobForMedia(
  db: D1DatabaseLike,
  telegramUserId: string,
  telegramChatId: string,
  sourceUrlHash: string,
  requestedMode: MediaMode,
  requestedQuality: string | null,
  processingPolicyVersion = MEDIA_PROCESSING_POLICY_VERSION,
  requestedStartSeconds: number | null = null,
  requestedEndSeconds: number | null = null,
): Promise<JobRecord | null> {
  return statement(
    db,
    `SELECT * FROM jobs
     WHERE telegram_user_id = ?1
       AND telegram_chat_id = ?2
       AND source_url_hash = ?3
       AND requested_mode = ?4
       AND requested_operation = 'download'
       AND source_kind = 'url'
       AND requested_clip_ranges IS NULL
       AND requested_quality IS ?5
       AND processing_policy_version = ?6
       AND requested_start_seconds IS ?7
       AND requested_end_seconds IS ?8
       AND status = 'completed'
       AND cache_valid = 1
       AND result_message_id IS NOT NULL
       AND r2_object_key IS NULL
       AND output_filename IS NOT NULL
       AND output_mime_type IS NOT NULL
       AND output_size_bytes IS NOT NULL
       AND ((requested_mode = 'video' AND output_mime_type LIKE 'video/%')
         OR (requested_mode = 'audio' AND output_mime_type LIKE 'audio/%'))
     ORDER BY completed_at DESC, updated_at DESC
    LIMIT 1`,
    telegramUserId,
    telegramChatId,
    sourceUrlHash,
    requestedMode,
    requestedQuality,
    processingPolicyVersion,
    requestedStartSeconds,
    requestedEndSeconds,
  ).first<JobRecord>();
}


export async function getProcessedUpdate(db: D1DatabaseLike, updateId: string): Promise<{ telegram_update_id: string; job_id: string | null } | null> {
  return statement(db, "SELECT telegram_update_id, job_id FROM processed_updates WHERE telegram_update_id = ?1", updateId).first();
}

export async function countRecentJobs(db: D1DatabaseLike, userId: string, sinceIso: string): Promise<number> {
  const row = await statement(db, "SELECT COUNT(*) AS count FROM jobs WHERE telegram_user_id = ?1 AND created_at >= ?2", userId, sinceIso).first<{ count: number | string }>();
  return Number(row?.count ?? 0);
}

/** Telegram message IDs are positive safe integers even when JSON serializes them as strings. */
export function positiveTelegramMessageId(value: unknown): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : null;
}

/** Canonicalize one bounded ordered pack receipt; an absent array is scalar-only. */
export function telegramMessageIds(value: unknown, expectedCount: number, firstMessageId: unknown): string[] | null {
  if (expectedCount === 0) return value == null ? [] : null;
  if ((expectedCount !== 2 && expectedCount !== 3) || !Array.isArray(value) || value.length !== expectedCount) return null;
  const ids = value.map(positiveTelegramMessageId);
  if (ids.some((id) => id === null) || new Set(ids).size !== expectedCount || ids[0] !== positiveTelegramMessageId(firstMessageId)) return null;
  return ids as string[];
}

/** Empty means a valid scalar receipt; null means no complete confirmation. */
export function confirmedDeliveryMessageIds(record: Pick<JobDeliveryRecord, "state" | "method" | "telegram_message_id" | "telegram_message_ids">, job: Pick<JobRecord, "requested_clip_ranges">): string[] | null {
  if (record.state !== "confirmed" || !positiveTelegramMessageId(record.telegram_message_id)) return null;
  const count = clipCountForJob(job);
  if (count !== 0 && record.method !== "telegram") return null;
  let ids: unknown;
  try { ids = record.telegram_message_ids == null ? undefined : JSON.parse(record.telegram_message_ids) as unknown; }
  catch { return null; }
  return telegramMessageIds(ids, count, record.telegram_message_id);
}

/** Telegram retry metadata is durable only when it is a positive safe integer. */
export function positiveRetryAfterSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export async function getDispatchIntent(db: D1DatabaseLike, jobId: string): Promise<DispatchIntentRecord | null> {
  return statement(db, "SELECT * FROM job_dispatch_intents WHERE job_id = ?1", jobId).first<DispatchIntentRecord>();
}

function dispatchLeaseUntil(now: Date, leaseSeconds: number): string {
  const boundedSeconds = Number.isSafeInteger(leaseSeconds) && leaseSeconds > 0 ? leaseSeconds : 60;
  return new Date(now.getTime() + boundedSeconds * 1_000).toISOString();
}

const DEFAULT_DISPATCH_ADMISSION_LIMITS: Required<DispatchAdmissionLimits> = {
  maxActiveJobs: 1,
  maxActiveTranscriptions: 1,
};

function dispatchAdmissionLimits(limits: DispatchAdmissionLimits): Required<DispatchAdmissionLimits> {
  return {
    maxActiveJobs: boundedAdmissionLimit(limits.maxActiveJobs, DEFAULT_DISPATCH_ADMISSION_LIMITS.maxActiveJobs),
    maxActiveTranscriptions: boundedAdmissionLimit(limits.maxActiveTranscriptions, DEFAULT_DISPATCH_ADMISSION_LIMITS.maxActiveTranscriptions),
  };
}

function dispatchTargetClause(jobId: string | undefined, parameter: number): string {
  return jobId ? ` AND intent.job_id = ?${parameter}` : "";
}

/** Claim a due intent that already owns its admission, preserving lease recovery. */
async function claimAdmittedDispatchIntent(
  db: D1DatabaseLike,
  jobId: string | undefined,
  now: Date,
  leaseSeconds: number,
): Promise<DispatchIntentRecord | null> {
  const nowIso = now.toISOString();
  const leaseUntil = dispatchLeaseUntil(now, leaseSeconds);
  const targetClause = dispatchTargetClause(jobId, 3);
  const rows = await statement(
    db,
    `UPDATE job_dispatch_intents
     SET state = 'leased',
         generation = generation + 1,
         attempts = attempts + 1,
         lease_expires_at = ?2,
         updated_at = ?1
     WHERE job_id = (
       SELECT intent.job_id
       FROM job_dispatch_intents intent
       JOIN jobs candidate_job ON candidate_job.id = intent.job_id
       JOIN job_deliveries candidate_delivery ON candidate_delivery.job_id = intent.job_id
       JOIN active_job_admissions candidate_admission ON candidate_admission.job_id = intent.job_id
       WHERE candidate_job.status NOT IN ('completed', 'failed')
         AND (
           (intent.state = 'pending'
             AND intent.available_at <= ?1
             AND candidate_delivery.state = 'not_started')
           OR
           (intent.state = 'leased'
             AND intent.lease_expires_at IS NOT NULL
             AND intent.lease_expires_at <= ?1
             AND candidate_delivery.state IN ('not_started', 'sending'))
         )${targetClause}
       ORDER BY intent.available_at ASC, candidate_job.created_at ASC, candidate_job.id ASC
       LIMIT 1
     )
       AND state IN ('pending', 'leased')
       AND (
         (state = 'pending' AND available_at <= ?1)
         OR (state = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?1)
       )
       AND EXISTS (
         SELECT 1 FROM jobs current_job
         WHERE current_job.id = job_dispatch_intents.job_id
           AND current_job.status NOT IN ('completed', 'failed')
       )
       AND EXISTS (
         SELECT 1 FROM active_job_admissions current_admission
         WHERE current_admission.job_id = job_dispatch_intents.job_id
       )
       AND EXISTS (
         SELECT 1 FROM job_deliveries current_delivery
         WHERE current_delivery.job_id = job_dispatch_intents.job_id
           AND (
             (job_dispatch_intents.state = 'pending' AND current_delivery.state = 'not_started')
             OR (job_dispatch_intents.state = 'leased' AND current_delivery.state IN ('not_started', 'sending'))
           )
       )
     RETURNING *`,
    nowIso,
    leaseUntil,
    ...(jobId ? [jobId] : []),
  ).all<DispatchIntentRecord>();
  return rows.results[0] ?? null;
}

/**
 * Promote one unadmitted queue head and lease it in one D1 transaction. The
 * INSERT is deliberately first: the lease trigger rejects any old Worker
 * path that tries to skip the matching active admission. SQLite's
 * last_insert_rowid()/changes() pair identifies exactly the row inserted by
 * the preceding statement without a second race-prone read.
 */
async function claimUnadmittedDispatchIntent(
  db: D1BatchDatabaseLike,
  jobId: string | undefined,
  now: Date,
  leaseSeconds: number,
  limits: DispatchAdmissionLimits,
): Promise<DispatchIntentRecord | null> {
  const nowIso = now.toISOString();
  const leaseUntil = dispatchLeaseUntil(now, leaseSeconds);
  const { maxActiveJobs, maxActiveTranscriptions } = dispatchAdmissionLimits(limits);
  const targetClause = jobId ? " AND intent.job_id = ?5" : "";
  const lane = jobLaneSql("candidate_job");
  const olderLane = jobLaneSql("older_job");
  const results = await db.batch([
    statement(
      db,
      `INSERT INTO active_job_admissions (job_id, created_at, lane)
       SELECT intent.job_id, ?1, ${lane}
       FROM job_dispatch_intents intent
       JOIN jobs candidate_job ON candidate_job.id = intent.job_id
       JOIN job_deliveries candidate_delivery ON candidate_delivery.job_id = intent.job_id
       WHERE intent.state = 'pending'
         AND intent.available_at <= ?2
         AND candidate_job.status NOT IN ('completed', 'failed')
         AND candidate_delivery.state = 'not_started'
         AND NOT EXISTS (
           SELECT 1 FROM active_job_admissions candidate_admission
           WHERE candidate_admission.job_id = intent.job_id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM jobs older_job
           WHERE (older_job.created_at < candidate_job.created_at
              OR (older_job.created_at = candidate_job.created_at AND older_job.id < candidate_job.id))
             AND older_job.status NOT IN ('completed', 'failed')
             AND ${olderLane} = ${lane}
             AND NOT EXISTS (
               SELECT 1 FROM active_job_admissions older_admission
               WHERE older_admission.job_id = older_job.id
             )
             AND EXISTS (
               SELECT 1 FROM job_dispatch_intents older_intent
               WHERE older_intent.job_id = older_job.id
                 AND older_intent.state = 'pending'
             )
             AND EXISTS (
               SELECT 1 FROM job_deliveries older_delivery
               WHERE older_delivery.job_id = older_job.id
                 AND older_delivery.state = 'not_started'
             )
         )
         AND (
           (${lane} = 'transcript' AND
             (SELECT COUNT(*) FROM active_job_admissions WHERE lane = 'transcript') < ?4)
           OR
           (${lane} = 'source' AND
             (SELECT COUNT(*) FROM active_job_admissions WHERE lane = 'source') < ?3)
         )${targetClause}
       ORDER BY candidate_job.created_at ASC, candidate_job.id ASC
       LIMIT 1`,
      nowIso,
      nowIso,
      maxActiveJobs,
      maxActiveTranscriptions,
      ...(jobId ? [jobId] : []),
    ),
    statement(
      db,
      `UPDATE job_dispatch_intents
       SET state = 'leased',
           generation = generation + 1,
           attempts = attempts + 1,
           lease_expires_at = ?2,
           updated_at = ?1
       WHERE changes() > 0
         AND job_id = (
           SELECT job_id
           FROM active_job_admissions
           WHERE rowid = last_insert_rowid()
         )
         AND state = 'pending'
         AND available_at <= ?1
         AND EXISTS (
           SELECT 1 FROM jobs current_job
           WHERE current_job.id = job_dispatch_intents.job_id
             AND current_job.status NOT IN ('completed', 'failed')
         )
         AND EXISTS (
           SELECT 1 FROM job_deliveries current_delivery
           WHERE current_delivery.job_id = job_dispatch_intents.job_id
             AND current_delivery.state = 'not_started'
         )
         AND EXISTS (
           SELECT 1 FROM active_job_admissions current_admission
           WHERE current_admission.job_id = job_dispatch_intents.job_id
         )
       RETURNING *`,
      nowIso,
      leaseUntil,
    ),
  ]);
  const row = results[1]?.results?.[0];
  return row && typeof row === "object" ? row as DispatchIntentRecord : null;
}

/** Atomically claim one due dispatch intent and fence older claimants by generation. */
export async function claimDueDispatchIntent(
  db: D1BatchDatabaseLike,
  now = new Date(),
  leaseSeconds = 60,
  limits: DispatchAdmissionLimits = {},
): Promise<DispatchIntentRecord | null> {
  const admitted = await claimAdmittedDispatchIntent(db, undefined, now, leaseSeconds);
  return admitted ?? claimUnadmittedDispatchIntent(db, undefined, now, leaseSeconds, limits);
}

/** Claim a newly accepted job for the short webhook dispatch attempt. */
export async function claimDispatchIntentForJob(
  db: D1BatchDatabaseLike,
  jobId: string,
  now = new Date(),
  leaseSeconds = 60,
  limits: DispatchAdmissionLimits = {},
): Promise<DispatchIntentRecord | null> {
  const admitted = await claimAdmittedDispatchIntent(db, jobId, now, leaseSeconds);
  return admitted ?? claimUnadmittedDispatchIntent(db, jobId, now, leaseSeconds, limits);
}

function changed(result: { meta?: { changes?: number } }): boolean {
  return (result.meta?.changes ?? 0) > 0;
}

export async function markDispatchStarted(db: D1DatabaseLike, jobId: string, generation: number): Promise<boolean> {
  const result = await statement(
    db,
    `UPDATE job_dispatch_intents
     SET state = 'started', lease_expires_at = NULL, workflow_instance_id = ?1, updated_at = ?3
     WHERE job_id = ?1 AND generation = ?2 AND state = 'leased'`,
    jobId,
    generation,
    new Date().toISOString(),
  ).run();
  return changed(result);
}

export async function rescheduleDispatchIntent(
  db: D1DatabaseLike,
  jobId: string,
  generation: number,
  availableAt: string,
  errorCode: string,
  errorMessage: string,
): Promise<boolean> {
  const result = await statement(
    db,
    `UPDATE job_dispatch_intents
     SET state = 'pending', lease_expires_at = NULL, available_at = ?3,
         last_error_code = ?4, last_error_message = ?5, updated_at = ?3
     WHERE job_id = ?1 AND generation = ?2 AND state = 'leased'`,
    jobId,
    generation,
    availableAt,
    errorCode.slice(0, 80),
    errorMessage.slice(0, 240),
  ).run();
  return changed(result);
}

export async function markDispatchComplete(db: D1DatabaseLike, jobId: string, generation?: number): Promise<boolean> {
  const generationClause = typeof generation === "number" ? " AND generation = ?2" : "";
  const values = typeof generation === "number" ? [jobId, generation] : [jobId];
  const result = await statement(
    db,
    `UPDATE job_dispatch_intents
     SET state = 'complete', lease_expires_at = NULL, updated_at = ?${values.length + 1}
     WHERE job_id = ?1${generationClause} AND state <> 'complete'`,
    ...values,
    new Date().toISOString(),
  ).run();
  return changed(result);
}

/**
 * List started work plus pre-start rows that already have terminal job or
 * delivery evidence. The latter covers a lost create acknowledgement without
 * mistaking a genuinely queued, unadmitted not_started job for old work.
 */
export async function listStartedDispatchIntents(db: D1DatabaseLike, limit = 50): Promise<DispatchIntentRecord[]> {
  const bounded = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 50;
  const rows = await statement(
    db,
    `SELECT intent.*
     FROM job_dispatch_intents intent
     JOIN jobs job ON job.id = intent.job_id
     JOIN job_deliveries delivery ON delivery.job_id = intent.job_id
     WHERE intent.state IN ('started', 'pending', 'leased')
       AND (
         intent.state = 'started'
         OR job.status IN ('completed', 'failed')
         OR delivery.state <> 'not_started'
       )
     ORDER BY intent.updated_at ASC, intent.job_id ASC
     LIMIT ?1`,
    bounded,
  ).all<DispatchIntentRecord>();
  return rows.results;
}

export async function getJobDelivery(db: D1DatabaseLike, jobId: string): Promise<JobDeliveryRecord | null> {
  return statement(db, "SELECT * FROM job_deliveries WHERE job_id = ?1", jobId).first<JobDeliveryRecord>();
}

/** Read the job, dispatch intent, and delivery rows for one job in a single D1 round trip. */
export async function getJobDurableState(
  db: D1BatchDatabaseLike,
  jobId: string,
): Promise<{ job: JobRecord | null; intent: DispatchIntentRecord | null; delivery: JobDeliveryRecord | null }> {
  const [job, intent, delivery] = await db.batch([
    statement(db, "SELECT * FROM jobs WHERE id = ?1", jobId),
    statement(db, "SELECT * FROM job_dispatch_intents WHERE job_id = ?1", jobId),
    statement(db, "SELECT * FROM job_deliveries WHERE job_id = ?1", jobId),
  ]);
  return {
    job: (job?.results?.[0] as JobRecord | undefined) ?? null,
    intent: (intent?.results?.[0] as DispatchIntentRecord | undefined) ?? null,
    delivery: (delivery?.results?.[0] as JobDeliveryRecord | undefined) ?? null,
  };
}

/**
 * Fence jobs written by an older Worker during the migration cutover. New
 * admission writes create both rows atomically, while this repair makes a
 * partially upgraded schema explicit without ever starting a second send.
 */
export async function repairMissingDurableState(db: D1BatchDatabaseLike, now = new Date(), limit = 100): Promise<number> {
  const bounded = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 100;
  const nowIso = now.toISOString();
  const results = await db.batch([
    statement(db, `UPDATE job_deliveries SET state = 'unknown', unknown_reason = 'clip_pack_receipt_incomplete',
      retry_after_seconds = NULL, owner_generation = NULL, updated_at = ?1
      WHERE state = 'confirmed' AND job_id IN (SELECT id FROM jobs WHERE requested_clip_ranges IS NOT NULL)
        AND (method <> 'telegram' OR method IS NULL OR telegram_message_ids IS NULL
          OR json_array_length(telegram_message_ids) <> (SELECT json_array_length(requested_clip_ranges) FROM jobs WHERE id = job_id)
          OR CAST(json_extract(telegram_message_ids, '$[0]') AS TEXT) IS NOT telegram_message_id
          OR (SELECT COUNT(DISTINCT CAST(value AS TEXT)) FROM json_each(telegram_message_ids)) <> json_array_length(telegram_message_ids)
          OR EXISTS (SELECT 1 FROM json_each(telegram_message_ids) WHERE type NOT IN ('text', 'integer')
            OR CAST(value AS TEXT) NOT GLOB '[1-9]*' OR CAST(value AS TEXT) GLOB '*[^0-9]*'
            OR length(CAST(value AS TEXT)) > 16
            OR (length(CAST(value AS TEXT)) = 16 AND CAST(value AS TEXT) > '9007199254740991')))
      `, nowIso),
    // An old request can finish its Telegram send after this repair has
    // recorded an explicit unknown state. Promote only that exact cutover
    // marker from the legacy job's validated receipt; this repairs bookkeeping
    // without reopening the intent or issuing another send.
    statement(
      db,
      `UPDATE job_deliveries
       SET state = 'confirmed',
           method = (SELECT CASE WHEN r2_object_key IS NOT NULL THEN 'r2' ELSE 'telegram' END FROM jobs WHERE jobs.id = job_deliveries.job_id),
           telegram_message_id = (SELECT result_message_id FROM jobs WHERE jobs.id = job_deliveries.job_id),
           object_key = (SELECT r2_object_key FROM jobs WHERE jobs.id = job_deliveries.job_id),
           filename = (SELECT output_filename FROM jobs WHERE jobs.id = job_deliveries.job_id),
           mime_type = (SELECT output_mime_type FROM jobs WHERE jobs.id = job_deliveries.job_id),
           size_bytes = (
             SELECT CASE
               WHEN typeof(output_size_bytes) = 'integer'
                    AND output_size_bytes BETWEEN 0 AND 9007199254740991
                 THEN output_size_bytes
               ELSE NULL
             END
             FROM jobs WHERE jobs.id = job_deliveries.job_id
           ),
           expires_at = (SELECT expires_at FROM jobs WHERE jobs.id = job_deliveries.job_id),
           unknown_reason = NULL, owner_generation = NULL, updated_at = ?1
       WHERE state = 'unknown'
         AND unknown_reason = 'legacy_active_missing_durable_state'
         AND job_id IN (
           SELECT id FROM jobs
           WHERE status = 'completed'
             AND requested_clip_ranges IS NULL
             AND result_message_id GLOB '[1-9]*'
             AND result_message_id NOT GLOB '*[^0-9]*'
             AND length(result_message_id) <= 16
             AND (length(result_message_id) < 16 OR result_message_id <= '9007199254740991')
         )`,
      nowIso,
    ),
    statement(
      db,
      `INSERT OR IGNORE INTO job_dispatch_intents (
         job_id, state, generation, attempts, available_at, lease_expires_at,
         workflow_instance_id, last_error_code, last_error_message, created_at, updated_at
       )
       SELECT id, 'complete', 0, 0, created_at, NULL, id, NULL,
              'legacy job missing durable dispatch state', created_at, ?1
       FROM jobs
       WHERE NOT EXISTS (SELECT 1 FROM job_dispatch_intents WHERE job_id = jobs.id)
       ORDER BY created_at ASC, id ASC
       LIMIT ?2`,
      nowIso,
      bounded,
    ),
    statement(
      db,
      `INSERT OR IGNORE INTO job_deliveries (
         job_id, state, method, telegram_message_id, object_key, filename,
         mime_type, size_bytes, expires_at, unknown_reason, owner_generation,
         created_at, updated_at
       )
       SELECT id,
              CASE
                WHEN status = 'completed'
                     AND requested_clip_ranges IS NULL
                     AND result_message_id GLOB '[1-9]*'
                     AND result_message_id NOT GLOB '*[^0-9]*'
                     AND length(result_message_id) <= 16
                     AND (length(result_message_id) < 16 OR result_message_id <= '9007199254740991')
                  THEN 'confirmed'
                ELSE 'unknown'
              END,
              CASE WHEN status = 'completed' AND r2_object_key IS NOT NULL THEN 'r2' ELSE 'telegram' END,
              CASE
                WHEN status = 'completed'
                     AND requested_clip_ranges IS NULL
                     AND result_message_id GLOB '[1-9]*'
                     AND result_message_id NOT GLOB '*[^0-9]*'
                     AND length(result_message_id) <= 16
                     AND (length(result_message_id) < 16 OR result_message_id <= '9007199254740991')
                  THEN result_message_id
                ELSE NULL
              END,
              CASE WHEN status = 'completed' THEN r2_object_key ELSE NULL END,
              CASE WHEN status = 'completed' THEN output_filename ELSE NULL END,
              CASE WHEN status = 'completed' THEN output_mime_type ELSE NULL END,
              CASE
                WHEN status = 'completed'
                     AND typeof(output_size_bytes) = 'integer'
                     AND output_size_bytes BETWEEN 0 AND 9007199254740991
                  THEN output_size_bytes
                ELSE NULL
              END,
              CASE WHEN status = 'completed' THEN expires_at ELSE NULL END,
              CASE
                WHEN status IN ('received', 'queued', 'probing', 'downloading', 'processing', 'uploading')
                  THEN 'legacy_active_missing_durable_state'
                ELSE 'legacy_missing_delivery_state'
              END,
              NULL, created_at, ?1
       FROM jobs
       WHERE NOT EXISTS (SELECT 1 FROM job_deliveries WHERE job_id = jobs.id)
       ORDER BY created_at ASC, id ASC
       LIMIT ?2`,
      nowIso,
      bounded,
    ),
  ]);
  return results.reduce((total, result) => total + (result.meta?.changes ?? 0), 0);
}

/** Set the one allowed final-send owner before performing a non-idempotent call. */
export async function claimDeliverySending(db: D1DatabaseLike, jobId: string, generation: number): Promise<boolean> {
  const result = await statement(
    db,
    `UPDATE job_deliveries
     SET state = 'sending', owner_generation = ?2, unknown_reason = NULL, updated_at = ?3
     WHERE job_id = ?1 AND state = 'not_started'
       AND EXISTS (
         SELECT 1 FROM job_dispatch_intents
         WHERE job_id = ?1 AND generation = ?2 AND state IN ('leased', 'started')
       )`,
    jobId,
    generation,
    new Date().toISOString(),
  ).run();
  return changed(result);
}

export async function resetDeliverySending(db: D1DatabaseLike, jobId: string, generation: number): Promise<boolean> {
  const result = await statement(
    db,
    `UPDATE job_deliveries
     SET state = 'not_started', retry_after_seconds = NULL, owner_generation = NULL, updated_at = ?3
     WHERE job_id = ?1 AND state = 'sending' AND owner_generation = ?2`,
    jobId,
    generation,
    new Date().toISOString(),
  ).run();
  return changed(result);
}

export interface ConfirmedDeliveryInput {
  method: DeliveryMethod;
  telegramMessageId: unknown;
  telegramMessageIds?: unknown;
  objectKey?: string | null;
  filename?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  expiresAt?: string | null;
  ownerGeneration?: number;
}

/** Fence unowned state to the current dispatch while retaining owned late-receipt repair. */
function deliveryGenerationGuard(parameter: number): string {
  return ` AND (
       owner_generation = ?${parameter}
       OR (owner_generation IS NULL AND EXISTS (
         SELECT 1 FROM job_dispatch_intents
         WHERE job_id = ?1 AND generation = ?${parameter} AND state IN ('leased', 'started')
       ))
     )`;
}

export async function recordDeliveryConfirmed(db: D1DatabaseLike, jobId: string, input: ConfirmedDeliveryInput): Promise<boolean> {
  const messageId = positiveTelegramMessageId(input.telegramMessageId);
  if (!messageId) return false;
  const job = await getJob(db, jobId);
  if (!job) return false;
  const count = clipCountForJob(job);
  const ids = telegramMessageIds(input.telegramMessageIds, count, messageId);
  if (ids === null || (count !== 0 && input.method !== "telegram")) return false;
  const generationClause = typeof input.ownerGeneration === "number" ? deliveryGenerationGuard(12) : "";
  const values: unknown[] = [
    jobId,
    input.method,
    messageId,
    input.objectKey ?? null,
    input.filename ?? null,
    input.mimeType ?? null,
    input.sizeBytes ?? null,
    input.expiresAt ?? null,
    new Date().toISOString(),
    ids.length ? JSON.stringify(ids) : null,
    job.requested_clip_ranges ?? null,
  ];
  if (typeof input.ownerGeneration === "number") values.push(input.ownerGeneration);
  const result = await statement(
    db,
    `UPDATE job_deliveries
     SET state = 'confirmed', method = ?2, telegram_message_id = ?3, telegram_message_ids = ?10,
         object_key = ?4, filename = ?5, mime_type = ?6, size_bytes = ?7,
         expires_at = ?8, retry_after_seconds = NULL, unknown_reason = NULL, owner_generation = NULL, updated_at = ?9
     WHERE job_id = ?1 AND state IN ('not_started', 'sending', 'unknown')${generationClause}
       AND EXISTS (SELECT 1 FROM jobs WHERE id = ?1 AND requested_clip_ranges IS ?11)`,
    ...values,
  ).run();
  if (changed(result)) return true;
  const current = await getJobDelivery(db, jobId);
  return current?.state === "confirmed" && current.telegram_message_id === messageId
    && JSON.stringify(confirmedDeliveryMessageIds(current, job)) === JSON.stringify(ids);
}

export async function recordDeliveryRejected(
  db: D1DatabaseLike,
  jobId: string,
  reason: string,
  ownerGeneration?: number,
  retryAfterSeconds?: number,
): Promise<boolean> {
  const generationClause = typeof ownerGeneration === "number" ? deliveryGenerationGuard(5) : "";
  const values: unknown[] = [jobId, reason.slice(0, 240), positiveRetryAfterSeconds(retryAfterSeconds), new Date().toISOString()];
  if (typeof ownerGeneration === "number") values.push(ownerGeneration);
  const result = await statement(
    db,
    `UPDATE job_deliveries
     SET state = 'rejected', unknown_reason = ?2, retry_after_seconds = ?3, owner_generation = NULL, updated_at = ?4
     WHERE job_id = ?1 AND state IN ('not_started', 'sending')${generationClause}`,
    ...values,
  ).run();
  return changed(result);
}

export async function markDeliveryUnknown(
  db: D1DatabaseLike,
  jobId: string,
  reason: string,
  ownerGeneration?: number,
): Promise<boolean> {
  const generationClause = typeof ownerGeneration === "number" ? deliveryGenerationGuard(4) : "";
  const values: unknown[] = [jobId, reason.slice(0, 240), new Date().toISOString()];
  if (typeof ownerGeneration === "number") values.push(ownerGeneration);
  const result = await statement(
    db,
    `UPDATE job_deliveries
     SET state = 'unknown', retry_after_seconds = NULL, unknown_reason = ?2, updated_at = ?3
     WHERE job_id = ?1 AND state IN ('not_started', 'sending')${generationClause}`,
    ...values,
  ).run();
  if (changed(result)) return true;
  const current = await getJobDelivery(db, jobId);
  return current?.state === "unknown";
}

/** Preserve a first receipt while surfacing a conflicting later receipt. */
export async function markConfirmedDeliveryConflict(db: D1DatabaseLike, jobId: string, reason: string): Promise<boolean> {
  const result = await statement(
    db,
    `UPDATE job_deliveries
     SET state = 'unknown', retry_after_seconds = NULL, unknown_reason = ?2, owner_generation = NULL, updated_at = ?3
     WHERE job_id = ?1 AND state = 'confirmed'`,
    jobId,
    reason.slice(0, 240),
    new Date().toISOString(),
  ).run();
  if (changed(result)) return true;
  const current = await getJobDelivery(db, jobId);
  return current?.state === "unknown" && current.unknown_reason === reason.slice(0, 240);
}

export class ActiveJobLimitError extends Error {
  readonly lane: "source" | "transcript";

  constructor(lane: "source" | "transcript" = "source") {
    super(lane === "transcript"
      ? "The active transcription limit has been reached."
      : "The global active-job limit has been reached.");
    this.name = "ActiveJobLimitError";
    this.lane = lane;
  }
}

export class QueueLimitError extends Error {
  constructor() {
    super("The unfinished-job queue limit has been reached.");
    this.name = "QueueLimitError";
  }
}

export class HourlyJobLimitError extends Error {
  constructor() {
    super("The per-user hourly job limit has been reached.");
    this.name = "HourlyJobLimitError";
  }
}

export interface NewJob {
  id: string;
  telegramUpdateId: string;
  telegramUserId: string;
  telegramChatId: string;
  /** The Telegram message that asked for the job; a gateway request has none. */
  requestMessageId?: string | null;
  sourceHost: string;
  sourceKind?: JobSourceKind;
  sourceUrlHash: string;
  sourceUrlEncrypted: string;
  requestedMode: MediaMode;
  requestedOperation?: JobOperation;
  transcriptMethod?: TranscriptMethod;
  captionLanguage?: string | null;
  requestedQuality: string;
  requestedStartSeconds?: number | null;
  requestedEndSeconds?: number | null;
  requestedClipRanges?: TrimRange[] | null;
  processingPolicyVersion?: string;
  /** Set false for clients without Telegram commands, so the queue notice skips the /queue hint. */
  queueCommandHint?: boolean;
  createdAt: string;
}

export interface JobAdmissionLimits {
  maxActiveJobs: number;
  maxActiveTranscriptions?: number;
  maxJobsPerHour: number;
  hourlyWindowStart: string;
}

/** Claim once before fetching a file; the existing receipt cleanup owns retention. */
export async function reserveSearchUpdate(
  db: D1DatabaseLike, updateId: string, userId: string, hourlyLimit: number, now = new Date(),
): Promise<"accepted" | "duplicate" | "limited"> {
  return reserveLookupUpdate(db, updateId, userId, hourlyLimit, "search_user_id", now);
}

export async function reserveCollectionUpdate(
  db: D1DatabaseLike, updateId: string, userId: string, hourlyLimit: number, now = new Date(),
): Promise<"accepted" | "duplicate" | "limited"> {
  return reserveLookupUpdate(db, updateId, userId, hourlyLimit, "collection_user_id", now);
}

async function reserveLookupUpdate(
  db: D1DatabaseLike, updateId: string, userId: string, hourlyLimit: number,
  column: "search_user_id" | "collection_user_id", now: Date,
): Promise<"accepted" | "duplicate" | "limited"> {
  try {
    const row = await statement(db, `INSERT INTO processed_updates
      (telegram_update_id, job_id, created_at, ${column})
      SELECT ?1, NULL, ?2, ?3
      WHERE NOT EXISTS (SELECT 1 FROM processed_updates WHERE ${column} = ?3 AND created_at > ?4)
        AND (SELECT COUNT(*) FROM processed_updates WHERE ${column} = ?3 AND created_at >= ?5) < ?6
      RETURNING telegram_update_id`,
    updateId, now.toISOString(), userId,
    new Date(now.getTime() - 30_000).toISOString(),
    new Date(now.getTime() - 3_600_000).toISOString(), hourlyLimit).first();
    if (row) return "accepted";
  } catch (error) {
    if (await getProcessedUpdate(db, updateId)) return "duplicate";
    throw error;
  }
  return await getProcessedUpdate(db, updateId) ? "duplicate" : "limited";
}

function newJobStatement(db: D1DatabaseLike, job: NewJob): D1PreparedStatementLike {
  const clipRanges = job.requestedClipRanges == null ? null : JSON.stringify(validateClipRanges(job.requestedClipRanges));
  return statement(
    db,
    `INSERT INTO jobs (
      id, telegram_update_id, telegram_user_id, telegram_chat_id,
      request_message_id, source_host, source_url_hash, source_url_encrypted,
      requested_mode, requested_quality, requested_start_seconds, requested_end_seconds,
      requested_operation, transcript_method, caption_language,
      status, progress, created_at, updated_at,
      processing_policy_version, cache_valid, source_kind, requested_clip_ranges
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?16, ?17, 'queued', 0, ?14, ?14, ?15,
      CASE WHEN ?18 = 'telegram_file' OR ?19 IS NOT NULL THEN 0 ELSE 1 END, ?18, ?19)`,
    job.id,
    job.telegramUpdateId,
    job.telegramUserId,
    job.telegramChatId,
    job.requestMessageId ?? null,
    job.sourceHost,
    job.sourceUrlHash,
    job.sourceUrlEncrypted,
    job.requestedMode,
    job.requestedQuality,
    job.requestedStartSeconds ?? null,
    job.requestedEndSeconds ?? null,
    job.requestedOperation ?? "download",
    job.createdAt,
    job.processingPolicyVersion ?? MEDIA_PROCESSING_POLICY_VERSION,
    job.transcriptMethod ?? "whisper",
    job.captionLanguage ?? null,
    job.sourceKind ?? "url",
    clipRanges,
  );
}

function queueNoticeStatement(db: D1DatabaseLike, job: NewJob): D1PreparedStatementLike {
  const lane = jobLaneSql("current_job");
  const olderLane = jobLaneSql("older");
  const hint = job.queueCommandHint === false ? "" : " Use /queue for current status.";
  const text = job.requestedOperation === "transcript" && job.transcriptMethod !== "captions"
    ? `Queued in the Whisper transcription queue. Position when accepted: {position}.${hint} Starts automatically.`
    : `Queued in the download/captions queue. Position when accepted: {position}.${hint} Starts automatically.`;
  return statement(
    db,
    `INSERT INTO telegram_notices (update_id, chat_id, text, created_at, updated_at)
     SELECT ?1, ?2,
       replace(?3, '{position}', CAST(1 + (
         SELECT COUNT(*)
         FROM jobs older
         WHERE (older.created_at < current_job.created_at
            OR (older.created_at = current_job.created_at AND older.id < current_job.id))
           AND older.status NOT IN ('completed', 'failed')
           AND ${olderLane} = ${lane}
           AND NOT EXISTS (
             SELECT 1 FROM active_job_admissions older_active
             WHERE older_active.job_id = older.id
           )
           AND EXISTS (
             SELECT 1 FROM job_dispatch_intents older_dispatch
             WHERE older_dispatch.job_id = older.id
               AND older_dispatch.state = 'pending'
           )
           AND EXISTS (
             SELECT 1 FROM job_deliveries older_delivery
             WHERE older_delivery.job_id = older.id
               AND older_delivery.state = 'not_started'
           )
       ) AS TEXT)),
       ?4, ?4
     FROM jobs current_job
     WHERE current_job.id = ?5`,
    job.telegramUpdateId,
    job.telegramChatId,
    text,
    job.createdAt,
    job.id,
  );
}

/** Atomically reserve admission, the Telegram update ID, and its job.
 *
 * D1 batches are transactions: a uniqueness, queue-cap, hourly, or insert
 * failure rolls back every statement, so no orphan deduplication or queue
 * row is left behind. Lane slots are acquired later by promotion.
 */
export async function createJobWithUpdateReservation(
  db: D1BatchDatabaseLike,
  job: NewJob,
  limits: JobAdmissionLimits,
  qualitySelection?: QualitySelection,
): Promise<void> {
  return createJobsWithUpdateReservations(db, [job], limits, qualitySelection);
}

/** All items share one transaction; a cap or duplicate rolls back the entire batch. */
export async function createJobsWithUpdateReservations(
  db: D1BatchDatabaseLike,
  jobs: readonly NewJob[],
  limits: JobAdmissionLimits,
  qualitySelection?: QualitySelection,
): Promise<void> {
  if (!jobs.length || jobs.length > MAX_UNFINISHED_JOBS_PER_USER || (qualitySelection && jobs.length !== 1)) throw new Error("Invalid job batch");
  if (jobs.some(job => job.telegramUserId !== jobs[0]!.telegramUserId || job.telegramChatId !== jobs[0]!.telegramChatId)) throw new Error("Mixed-owner job batch");
  for (const job of jobs) {
    const lane = normalizedAdmissionLane(job);
    const activeLimit = lane === "transcript"
      ? limits.maxActiveTranscriptions ?? 1
      : limits.maxActiveJobs;
    // A zero-sized lane is disabled, rather than an infinite queue.
    if (!Number.isSafeInteger(activeLimit) || activeLimit <= 0) throw new ActiveJobLimitError(lane);
  }
  try {
    await db.batch(jobs.flatMap(job => [
      ...(qualitySelection ? qualityClaimStatements(db, qualitySelection, job.telegramUpdateId, job.createdAt) : []),
      statement(
        db,
        "INSERT INTO processed_updates (telegram_update_id, job_id, created_at) VALUES (?1, ?2, ?3)",
        job.telegramUpdateId,
        job.id,
        job.createdAt,
      ),
      statement(
        db,
        `INSERT INTO job_admission_guards (job_id, kind)
         VALUES (
           CASE
             WHEN (SELECT COUNT(*) FROM jobs WHERE telegram_user_id = ?1 AND created_at >= ?2) < ?3
             THEN ?4
             ELSE NULL
           END,
           'hourly'
         )`,
        job.telegramUserId,
        limits.hourlyWindowStart,
        limits.maxJobsPerHour,
        job.id,
      ),
      newJobStatement(db, job),
      statement(
        db,
        `INSERT INTO job_deliveries (job_id, state, created_at, updated_at)
         VALUES (?1, 'not_started', ?2, ?2)`,
        job.id,
        job.createdAt,
      ),
      statement(
        db,
        `INSERT INTO job_dispatch_intents (
          job_id, state, generation, attempts, available_at, lease_expires_at,
          workflow_instance_id, last_error_code, last_error_message, created_at, updated_at
        ) VALUES (?1, 'pending', 0, 0, ?2, NULL, ?1, NULL, NULL, ?2, ?2)`,
        job.id,
        job.createdAt,
      ),
      queueNoticeStatement(db, job),
      statement(db, "DELETE FROM job_admission_guards WHERE job_id = ?1", job.id),
      ...(qualitySelection ? [statement(db, "DELETE FROM video_quality_claims WHERE id = ?1", job.telegramUpdateId)] : []),
    ]));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("VIDEO_QUALITY_PROMPT_UNAVAILABLE")) throw new QualityPromptUnavailableError();
    if (message.includes("OUTSTANDING_JOB_LIMIT")) throw new QueueLimitError();
    if (message.includes("HOURLY_JOB_LIMIT")) throw new HourlyJobLimitError();
    throw error;
  }
}

export async function updateJob(db: D1DatabaseLike, jobId: string, fields: Partial<Record<JobColumn, unknown>>): Promise<void> {
  const entries = Object.entries(fields).filter(([column]) => (JOB_COLUMNS as readonly string[]).includes(column)) as Array<[JobColumn, unknown]>;
  if (!entries.length) return;
  const assignments = entries.map(([column], index) => `${column} = ?${index + 2}`).join(", ");
  await statement(db, `UPDATE jobs SET ${assignments} WHERE id = ?1`, jobId, ...entries.map(([, value]) => value)).run();
}

async function updateActiveJob(
  db: D1DatabaseLike,
  jobId: string,
  fields: Partial<Record<JobColumn, unknown>>,
  allowConfirmedDelivery = false,
  dispatchGeneration?: number,
): Promise<boolean> {
  const entries = Object.entries(fields).filter(([column]) => (JOB_COLUMNS as readonly string[]).includes(column)) as Array<[JobColumn, unknown]>;
  if (!entries.length) return false;
  const assignments = entries.map(([column], index) => `${column} = ?${index + 2}`).join(", ");
  const confirmedGuard = allowConfirmedDelivery
    ? ""
    : " AND NOT EXISTS (SELECT 1 FROM job_deliveries WHERE job_id = ?1 AND state = 'confirmed')";
  const generationParameter = entries.length + 2;
  const generationGuard = typeof dispatchGeneration === "number"
    ? ` AND (
       EXISTS (SELECT 1 FROM job_deliveries WHERE job_id = ?1 AND state = 'rejected')
       OR (
         EXISTS (SELECT 1 FROM job_deliveries WHERE job_id = ?1 AND state = 'not_started')
         AND EXISTS (
           SELECT 1 FROM job_dispatch_intents
           WHERE job_id = ?1 AND generation = ?${generationParameter} AND state IN ('leased', 'started')
         )
       )
     )`
    : "";
  const result = await statement(
    db,
    `UPDATE jobs SET ${assignments}
     WHERE id = ?1 AND status NOT IN ('completed', 'failed')${confirmedGuard}${generationGuard}`,
    jobId,
    ...entries.map(([, value]) => value),
    ...(typeof dispatchGeneration === "number" ? [dispatchGeneration] : []),
  ).run();
  return changed(result);
}

export async function setJobState(db: D1DatabaseLike, jobId: string, status: JobState, fields: Partial<Record<JobColumn, unknown>> = {}): Promise<boolean> {
  return updateActiveJob(db, jobId, { ...fields, status, updated_at: new Date().toISOString() });
}

export async function setJobFailure(
  db: D1DatabaseLike,
  jobId: string,
  code: ErrorCode,
  safeMessage: string,
  fields: Partial<Record<JobColumn, unknown>> = {},
  dispatchGeneration?: number,
): Promise<boolean> {
  return updateActiveJob(db, jobId, {
    ...fields,
    status: "failed",
    error_code: code,
    safe_error_message: safeMessage,
    source_url_encrypted: null,
    updated_at: new Date().toISOString(),
  }, false, dispatchGeneration);
}

export async function setJobCompleted(db: D1DatabaseLike, jobId: string, fields: Partial<Record<JobColumn, unknown>> = {}): Promise<boolean> {
  const job = await getJob(db, jobId);
  if (job && clipCountForJob(job) !== 0) {
    const receipt = await getJobDelivery(db, jobId);
    if (!receipt || confirmedDeliveryMessageIds(receipt, job) === null) return false;
  }
  const now = new Date().toISOString();
  return updateActiveJob(
    db,
    jobId,
    { ...fields, status: "completed", completed_at: now, source_url_encrypted: null, updated_at: now },
    true,
  );
}

export async function deleteExpiredJobs(db: D1DatabaseLike, nowIso: string, limit = 100): Promise<JobRecord[]> {
  const boundedCleanupLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.trunc(limit))) : 100;
  const rows = await statement(
    db,
    "SELECT * FROM jobs WHERE expires_at IS NOT NULL AND expires_at <= ?1 AND r2_object_key IS NOT NULL ORDER BY expires_at LIMIT ?2",
    nowIso,
    boundedCleanupLimit,
  ).all<JobRecord>();
  return rows.results;
}

/** Clear only the expired object's key after its R2 deletion succeeds.
 *
 * The expected key and expiry predicate make this update idempotent and
 * prevent a stale cleanup attempt from clearing a newer value. The job row,
 * including its past expires_at timestamp, is deliberately retained so the
 * history API can present the item as expired.
 */
export async function clearExpiredJobR2ObjectKey(
  db: D1DatabaseLike,
  jobId: string,
  objectKey: string,
  nowIso: string,
): Promise<boolean> {
  const result = await statement(
    db,
    `UPDATE jobs
     SET r2_object_key = NULL, updated_at = ?4
     WHERE id = ?1
       AND r2_object_key = ?2
       AND expires_at IS NOT NULL
       AND expires_at <= ?3`,
    jobId,
    objectKey,
    nowIso,
    nowIso,
  ).run();
  return (result.meta?.changes ?? 0) > 0;
}

/** Delete one terminal history row only when it belongs to the given user. */
export async function deleteTerminalJobForUser(db: D1DatabaseLike, jobId: string, userId: string): Promise<boolean> {
  const result = await statement(
    db,
    `DELETE FROM jobs
     WHERE id = ?1
       AND telegram_user_id = ?2
       AND status IN ('completed', 'failed')`,
    jobId,
    userId,
  ).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function deleteOldProcessedUpdates(db: D1DatabaseLike, beforeIso: string): Promise<void> {
  // Job-linked IDs are retained for replay protection; only command-only
  // updates (whose job_id is NULL) are safe to age out under the FK. A
  // durable notice still in-flight owns its update row until it reaches a
  // terminal notice state, regardless of age.
  await statement(
    db,
    `DELETE FROM processed_updates
     WHERE created_at < ?1
       AND job_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM telegram_notices
         WHERE telegram_notices.update_id = processed_updates.telegram_update_id
           AND telegram_notices.state IN ('pending', 'sending', 'unknown')
       )`,
    beforeIso,
  ).run();
}

export function formatJobStatus(job: JobRecord | null): string {
  if (!job) return "No media jobs found.";
  const error = job.status === "failed" && job.safe_error_message ? `\n${job.safe_error_message}` : "";
  const progress = typeof job.progress === "number" ? ` (${job.progress}%)` : "";
  return `Job ${job.status}${progress}${error}`;
}

export const VIDEO_QUALITY_CHOICES = [
  { choice: "automatic", height: 1080 },
  { choice: "720", height: 720 },
  { choice: "480", height: 480 },
  { choice: "360", height: 360 },
  { choice: "cancel", height: null },
] as const;
export type VideoQualityChoice = typeof VIDEO_QUALITY_CHOICES[number]["choice"];

export interface QualitySelection {
  token: string;
  promptId: string;
  userId: string;
  chatId: string;
  messageId: string;
}

export interface QualityPromptRecord {
  id: string;
  user_id: string;
  chat_id: string;
  update_id: string;
  request_message_id: string;
  source_host: string;
  source_url_hash: string;
  source_url_encrypted: string;
  trim_start_seconds: number | null;
  trim_end_seconds: number | null;
  expires_at: string;
  maximum_height: number;
  source_kind: JobSourceKind;
  requested_clip_ranges: string | null;
  choice: VideoQualityChoice;
}

export class QualityPromptUnavailableError extends Error {
  constructor() {
    super("The quality prompt is unavailable.");
    this.name = "QualityPromptUnavailableError";
  }
}

/** Supersession, tokens, source, receipt and keyboard become durable together. */
export async function createVideoQualityPrompt(db: D1BatchDatabaseLike, job: NewJob, maximumHeight: number): Promise<void> {
  if (!Number.isSafeInteger(maximumHeight)) throw new Error("Invalid video quality ceiling");
  const ceiling = [1080, 720, 480, 360, 240, 144].find((height) => height <= maximumHeight);
  if (!ceiling) throw new Error("Invalid video quality ceiling");
  const choices = VIDEO_QUALITY_CHOICES.filter(({ choice, height }) => choice === "automatic" || height === null || height < ceiling)
    .map(({ choice, height }) => ({ choice, token: `vq:${crypto.randomUUID().replaceAll("-", "")}`,
      text: choice === "cancel" ? "Cancel" : choice === "automatic" ? `Automatic (up to ${ceiling}p)` : `Up to ${height}p` }));
  const clipRanges = job.requestedClipRanges == null ? null : JSON.stringify(validateClipRanges(job.requestedClipRanges));
  const expiresAt = new Date(Date.parse(job.createdAt) + 10 * 60_000).toISOString();
  await db.batch([
    statement(db, "INSERT INTO processed_updates (telegram_update_id, job_id, created_at) VALUES (?1, NULL, ?2)", job.telegramUpdateId, job.createdAt),
    statement(db, `UPDATE telegram_notices SET reply_markup = NULL,
      state = CASE WHEN state = 'pending' THEN 'rejected' ELSE state END, updated_at = ?2
      WHERE update_id IN (SELECT update_id FROM video_quality_prompts WHERE user_id = ?1)`, job.telegramUserId, job.createdAt),
    statement(db, "DELETE FROM video_quality_prompts WHERE user_id = ?1", job.telegramUserId),
    statement(db, `INSERT INTO video_quality_prompts
      (id, user_id, chat_id, update_id, request_message_id, source_host, source_url_hash, source_url_encrypted,
       trim_start_seconds, trim_end_seconds, created_at, expires_at, maximum_height, source_kind, requested_clip_ranges)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
    job.id, job.telegramUserId, job.telegramChatId, job.telegramUpdateId, job.requestMessageId,
    job.sourceHost, job.sourceUrlHash, job.sourceUrlEncrypted, job.requestedStartSeconds ?? null,
    job.requestedEndSeconds ?? null, job.createdAt, expiresAt, ceiling, job.sourceKind ?? "url", clipRanges),
    ...choices.map(({ choice, token }) => statement(db,
      "INSERT INTO video_quality_choices (token, prompt_id, choice) VALUES (?1, ?2, ?3)", token, job.id, choice)),
    statement(db, `INSERT INTO telegram_notices (update_id, chat_id, text, reply_markup, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?5)`, job.telegramUpdateId, job.telegramChatId,
    `${job.requestedClipRanges ? `Choose one quality for all ${job.requestedClipRanges.length} clips. ` : "Choose the video quality. "}These are maximum heights, subject to what the source provides. The choice expires in 10 minutes; a new /video or /clips replaces it.`,
    JSON.stringify({ inline_keyboard: choices.map(({ token, text }) => [{ text, callback_data: token }]) }), job.createdAt),
  ]);
}

export async function getVideoQualityPrompt(db: D1DatabaseLike, token: string): Promise<QualityPromptRecord | null> {
  return statement(db, `SELECT p.*, c.choice FROM video_quality_prompts p
    JOIN video_quality_choices c ON c.prompt_id = p.id WHERE c.token = ?1`, token).first<QualityPromptRecord>();
}

function qualityClaimStatements(db: D1DatabaseLike, selection: QualitySelection, updateId: string, now: string): D1PreparedStatementLike[] {
  return [
    statement(db, `INSERT INTO video_quality_claims (id, valid)
      VALUES (?1, CASE WHEN EXISTS (
        SELECT 1 FROM video_quality_choices c JOIN video_quality_prompts p ON p.id = c.prompt_id
        JOIN telegram_notices n ON n.update_id = p.update_id
        WHERE c.token = ?2 AND p.id = ?3 AND p.user_id = ?4 AND p.chat_id = ?5
          AND p.expires_at > ?7 AND p.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          AND n.chat_id = ?5 AND n.state = 'sent' AND n.message_id = ?6
      ) THEN 1 ELSE 0 END)`, updateId, selection.token, selection.promptId,
    selection.userId, selection.chatId, selection.messageId, now),
    statement(db, `UPDATE telegram_notices SET reply_markup = NULL, updated_at = ?2
      WHERE update_id = (SELECT update_id FROM video_quality_prompts WHERE id = ?1)`, selection.promptId, now),
    statement(db, "DELETE FROM video_quality_prompts WHERE id = ?1", selection.promptId),
  ];
}

export async function cancelVideoQualityPrompt(db: D1BatchDatabaseLike, selection: QualitySelection, updateId: string, now: string): Promise<void> {
  try {
    await db.batch([
      ...qualityClaimStatements(db, selection, updateId, now),
      statement(db, "INSERT INTO processed_updates (telegram_update_id, job_id, created_at) VALUES (?1, NULL, ?2)", updateId, now),
      statement(db, "DELETE FROM video_quality_claims WHERE id = ?1", updateId),
    ]);
  } catch (error) {
    if (String(error).includes("VIDEO_QUALITY_PROMPT_UNAVAILABLE")) throw new QualityPromptUnavailableError();
    throw error;
  }
}

/** Called by the existing minute notice recovery schedule, including quiet chats. */
export async function expireVideoQualityPrompts(db: D1BatchDatabaseLike, now: string): Promise<void> {
  await db.batch([
    statement(db, `UPDATE telegram_notices SET reply_markup = NULL,
      state = CASE WHEN state = 'pending' THEN 'rejected' ELSE state END, updated_at = ?1
      WHERE update_id IN (SELECT update_id FROM video_quality_prompts WHERE expires_at <= ?1)`, now),
    statement(db, "DELETE FROM video_quality_prompts WHERE expires_at <= ?1", now),
  ]);
}

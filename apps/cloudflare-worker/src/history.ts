import { activityOutcomeForJob, activityTaskForJob, activityWindow, parseActivityPeriod, parseActivityTask } from "./stats";
import { clipCountForJob } from "./trim";
import type { AuthorizedMiniAppPrincipal } from "./mini-app-authorization";
import type { DownloaderMiniAppStorage } from "./downloader-storage";
import { base64UrlToBytes, bytesToBase64Url, sanitizeFilename } from "./security";
import { SOURCE_CATALOG, sourceForValidatedUrl } from "./sources";
import type {
  ActivityWindow,
  ActivityTask,
  ActivityOutcome,
  HistoryJobRecord,
  JobHistoryCursor,
  JobState,
} from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HISTORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const MAX_CLEAR_BATCHES = 100;

type FileAvailability = "available" | "expired" | "not_stored" | "pending" | "not_available";

export interface HistoryItem {
  historyId: string;
  task: ActivityTask;
  outcome: ActivityOutcome;
  provider: string;
  safeLabel: string | null;
  mediaType: "video" | "audio" | "transcript" | "other";
  status: JobState;
  requestedMode: "video" | "audio";
  operation?: "download" | "transcript";
  clipCount?: number;
  createdAt: string;
  completedAt: string | null;
  sizeBytes: number | null;
  fileAvailability: FileAvailability;
}

export interface DownloaderMiniAppContext {
  url: URL;
  user: AuthorizedMiniAppPrincipal;
  storage: DownloaderMiniAppStorage;
  endpoint: "sources" | "history" | "history-item";
  legacy: boolean;
  apiPath: string;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      vary: "Authorization",
    },
  });
}

export function apiError(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

export function unauthorizedMiniAppResponse(): Response {
  return apiError(401, "UNAUTHORIZED", "Telegram authentication is required.");
}

function safeIso(value: string | null): string | null {
  if (!value || value.length > 40) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function mediaTypeFor(job: HistoryJobRecord): HistoryItem["mediaType"] {
  if (job.requested_operation === "transcript") return "transcript";
  if (job.output_mime_type?.startsWith("video/")) return "video";
  if (job.output_mime_type?.startsWith("audio/")) return "audio";
  if (!job.output_mime_type) return job.requested_mode;
  return "other";
}

function availabilityFor(job: HistoryJobRecord, now: Date): FileAvailability {
  if (job.status !== "completed" && job.status !== "failed") return "pending";
  if (job.status === "failed") return "not_available";
  const expiresAt = safeIso(job.expires_at);
  if (expiresAt && new Date(expiresAt).getTime() <= now.getTime()) return "expired";
  if (job.r2_object_key && expiresAt) return "available";
  return "not_stored";
}

export function historyItemForJob(job: HistoryJobRecord, now = new Date()): HistoryItem {
  const source = sourceForValidatedUrl({ hostname: job.source_host });
  const filename = job.output_filename ? sanitizeFilename(job.output_filename, "").slice(0, 180) || null : null;
  const clipCount = clipCountForJob(job);
  const safeLabel = clipCount > 0 ? `Clip pack (${clipCount} clips)${filename ? ` — ${filename}` : ""}`.slice(0, 180) : filename;
  return {
    historyId: job.id,
    task: activityTaskForJob(job),
    outcome: activityOutcomeForJob(job),
    provider: job.source_kind === "telegram_file" ? "Telegram file" : source?.displayName ?? "Configured source",
    safeLabel,
    mediaType: mediaTypeFor(job),
    status: job.status,
    requestedMode: job.requested_mode,
    ...(clipCount > 0 ? { clipCount } : {}),
    ...(job.requested_operation === "transcript" ? { operation: "transcript" as const } : {}),
    createdAt: safeIso(job.created_at) ?? new Date(0).toISOString(),
    completedAt: safeIso(job.completed_at),
    sizeBytes: Number.isSafeInteger(job.output_size_bytes) && Number(job.output_size_bytes) >= 0
      ? Number(job.output_size_bytes)
      : null,
    fileAvailability: availabilityFor(job, now),
  };
}

interface ActivityCursor extends JobHistoryCursor { window: ActivityWindow }

function encodeCursor(cursor: JobHistoryCursor, window: ActivityWindow): string {
  return bytesToBase64Url(encoder.encode(JSON.stringify({ v: 2, c: cursor.createdAt, i: cursor.jobId, p: window.period, a: window.asOf, t: window.task })));
}

function decodeCursor(value: string | null, now: Date): ActivityCursor | null | undefined {
  if (value === null || value === "") return undefined;
  if (value.length > 512) return null;
  const bytes = base64UrlToBytes(value);
  if (!bytes || bytes.byteLength > 384) return null;
  try {
    const parsed = JSON.parse(decoder.decode(bytes)) as { v?: unknown; c?: unknown; i?: unknown; p?: unknown; a?: unknown; t?: unknown };
    if (parsed.v !== 2 || typeof parsed.c !== "string" || typeof parsed.i !== "string"
      || typeof parsed.p !== "string" || typeof parsed.a !== "string" || (parsed.t !== null && typeof parsed.t !== "string")) return null;
    const period = parseActivityPeriod(parsed.p);
    const task = parseActivityTask(parsed.t);
    if (!period || task === undefined || !HISTORY_ID_PATTERN.test(parsed.i) || safeIso(parsed.c) !== parsed.c) return null;
    const window = activityWindow({ period, task, asOf: parsed.a }, now);
    if (parsed.c > window.asOf || (window.since && parsed.c < window.since)) return null;
    return { createdAt: parsed.c, jobId: parsed.i, window };
  } catch { return null; }
}

function parseLimit(value: string | null): number | undefined | null {
  if (value === null || value === "") return undefined;
  if (!/^\d{1,3}$/u.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= 50 ? parsed : null;
}

async function deleteOwnedTerminalJob(storage: DownloaderMiniAppStorage, job: HistoryJobRecord): Promise<"deleted" | "conflict" | "unavailable"> {
  if (job.status !== "completed" && job.status !== "failed") return "conflict";
  const objectKey = job.r2_object_key;
  if (objectKey) {
    // R2 deletion is intentionally first. If the following user-scoped D1
    // delete fails, a retry performs the same idempotent object delete.
    const objectResult = await storage.deleteHistoryMediaObject(job.id, objectKey);
    if (objectResult === "invalid") return "conflict";
    if (objectResult === "unavailable") return "unavailable";
  }
  try {
    return await storage.deleteHistoryItem(job.id) ? "deleted" : "conflict";
  } catch {
    return "unavailable";
  }
}

async function listHistory(url: URL, storage: DownloaderMiniAppStorage): Promise<Response> {
  const now = new Date();
  const limit = parseLimit(url.searchParams.get("limit"));
  const cursor = decodeCursor(url.searchParams.get("cursor"), now);
  const period = parseActivityPeriod(url.searchParams.get("period"));
  const task = parseActivityTask(url.searchParams.get("task"));
  if (limit === null || cursor === null || period === null || task === undefined) return apiError(400, "INVALID_REQUEST", "The history request is invalid.");
  let window: ActivityWindow;
  try {
    window = cursor?.window ?? activityWindow({ period, task, asOf: url.searchParams.get("asOf") ?? undefined }, now);
    if (cursor && ((url.searchParams.has("period") && period !== window.period)
      || (url.searchParams.has("task") && task !== window.task)
      || (url.searchParams.has("asOf") && url.searchParams.get("asOf") !== window.asOf))) throw new RangeError("Cursor filters changed");
  } catch { return apiError(400, "INVALID_REQUEST", "The history request is invalid."); }
  try {
    const page = await storage.listHistory({ limit, cursor, window });
    // A cursor page shares the first page's frozen window; the client keeps that summary.
    const summary = cursor ? null : await storage.getActivityStats(window);
    return jsonResponse({
      items: page.jobs.map((job) => historyItemForJob(job, now)),
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor, window) : null,
      summary,
    });
  } catch {
    return apiError(503, "HISTORY_UNAVAILABLE", "History is temporarily unavailable.");
  }
}

async function deleteOneHistoryItem(storage: DownloaderMiniAppStorage, historyId: string): Promise<Response> {
  if (!HISTORY_ID_PATTERN.test(historyId)) return apiError(404, "NOT_FOUND", "History item not found.");
  let job: HistoryJobRecord | null;
  try {
    job = await storage.getHistoryItem(historyId);
  } catch {
    return apiError(503, "HISTORY_UNAVAILABLE", "History is temporarily unavailable.");
  }
  if (!job) return apiError(404, "NOT_FOUND", "History item not found.");
  const result = await deleteOwnedTerminalJob(storage, job);
  if (result === "deleted") return jsonResponse({ deleted: true });
  if (result === "conflict") return apiError(409, "NOT_DELETABLE", "This history item cannot be deleted yet.");
  return apiError(503, "HISTORY_UNAVAILABLE", "History is temporarily unavailable.");
}

async function clearHistory(storage: DownloaderMiniAppStorage): Promise<Response> {
  let deletedCount = 0;
  for (let batch = 0; batch < MAX_CLEAR_BATCHES; batch += 1) {
    let jobs: HistoryJobRecord[];
    try {
      jobs = (await storage.listTerminalHistory({ limit: 100 })).jobs;
    } catch {
      return apiError(503, "HISTORY_UNAVAILABLE", "History is temporarily unavailable.");
    }
    if (jobs.length === 0) return jsonResponse({ deleted: true, deletedCount });
    for (const job of jobs) {
      const result = await deleteOwnedTerminalJob(storage, job);
      if (result !== "deleted") {
        return result === "conflict"
          ? apiError(409, "NOT_DELETABLE", "History could not be cleared safely.")
          : apiError(503, "HISTORY_UNAVAILABLE", "History is temporarily unavailable.");
      }
      deletedCount += 1;
    }
  }
  return apiError(503, "HISTORY_UNAVAILABLE", "History is temporarily unavailable.");
}

/** Handle a downloader request after the Worker has authenticated Telegram once. */
export async function handleDownloaderApi(request: Request, context: DownloaderMiniAppContext): Promise<Response> {
  const { endpoint, legacy } = context;
  if (endpoint === "sources") {
    if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
    return jsonResponse({
      sources: SOURCE_CATALOG.map(({ id, displayName, state, coverage, note }) => ({
        id,
        displayName,
        state,
        coverage,
        note,
      })),
    });
  }
  if (endpoint === "history") {
    if (request.method === "GET") return listHistory(context.url, context.storage);
    if (request.method === "DELETE") return clearHistory(context.storage);
    return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
  }
  if (request.method !== "DELETE") return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");

  const prefix = legacy ? "/api/history/" : `${context.apiPath}/history/`;
  let historyId: string;
  try {
    historyId = decodeURIComponent(context.url.pathname.slice(prefix.length));
  } catch {
    return apiError(404, "NOT_FOUND", "History item not found.");
  }
  return deleteOneHistoryItem(context.storage, historyId);
}

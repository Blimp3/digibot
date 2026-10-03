import { getWorkerConfig } from "./config";
import { encryptSourceUrl, hmacSha256Hex } from "./crypto";
import {
  ActiveJobLimitError, HourlyJobLimitError, QueueLimitError, createJobWithUpdateReservation, getJob, getProcessedUpdate, type NewJob,
} from "./db";
import { dispatchAcceptedJob } from "./dispatch";
import { ApplicationError, safeMessageForError } from "./errors";
import type { IntegrationPrincipal } from "./integration-auth";
import { readIntegrationJson } from "./integration-io";
import { IntegrationFailure, integrationId } from "./integration-store";
import { logStructured } from "./logging";
import { dispatchNotices } from "./notices";
import { TelegramApiError, telegramErrorToApplicationError } from "./telegram";
import { parseAllowedTelegramUserIds } from "./telegram-user-ids";
import { isValidTrimRange, type TrimRange } from "./trim";
import type { Env } from "./types";
import { validateSourceUrl } from "./url";

/** Invited accounts get only this downloader path, so their hourly cap stays small. */
export const LENS_LINK_INVITED_JOBS_PER_HOUR = 5;
const LINK_BODY_KEYS: readonly string[] = ["operationId", "sourceUrl", "output", "startSeconds", "endSeconds"];

export interface LensLinkDownload { jobId: string; state: "queued" }

/** The columns a replay of the same action must match: the link, its output and its trim. */
type LinkJobRequest = Required<Pick<NewJob, "sourceUrlHash" | "requestedMode" | "requestedQuality" | "requestedStartSeconds" | "requestedEndSeconds">>;

/** Queue the page link as the bare-URL job a link pasted in the Telegram chat creates. */
export async function createLensLinkDownload(
  request: Request,
  env: Env,
  principal: IntegrationPrincipal,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<LensLinkDownload> {
  // The owner tier follows the live allowlist, as Telegram does: a legacy account
  // removed from it keeps its session but loses downloads, like its chat commands.
  const owner = principal.admissionSource === "legacy_allowlist"
    && parseAllowedTelegramUserIds(env.ALLOWED_TELEGRAM_USER_IDS)?.has(principal.telegramUserId) === true;
  if (principal.admissionSource === "legacy_allowlist" && !owner) {
    throw new IntegrationFailure(403, "forbidden", "This Telegram account is no longer enabled for DigiBot downloads.");
  }
  const body = await readIntegrationJson(request);
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((key) => !LINK_BODY_KEYS.includes(key))
    || !integrationId((body as Record<string, unknown>).operationId) || typeof (body as Record<string, unknown>).sourceUrl !== "string") {
    throw new IntegrationFailure(400, "invalid_request", "Send one action ID and one page link.");
  }
  const { operationId, sourceUrl, output } = body as { operationId: string; sourceUrl: string; output?: unknown };
  // Only "mp3" changes the output; the key left out keeps the bare-link default.
  if (Object.hasOwn(body, "output") && output !== "mp3") throw new IntegrationFailure(400, "invalid_request", "Send the output mp3, or leave it out.");
  const trim = linkTrimRange(body as Record<string, unknown>);
  const config = getWorkerConfig(env);
  let source;
  try { source = validateSourceUrl(sourceUrl, config); }
  catch (error) {
    if (error instanceof ApplicationError && error.code === "UNSUPPORTED_HOST") throw new IntegrationFailure(400, "unsupported_source", safeMessageForError("UNSUPPORTED_HOST"));
    throw new IntegrationFailure(400, "invalid_url", safeMessageForError("INVALID_URL"));
  }
  // Only the authenticated principal names the user and chat; the body never does.
  const updateId = `lens:${principal.accountId}:${operationId.toLowerCase()}`;
  const music = source.sourceHost === "music.youtube.com";
  const mp3 = output === "mp3";
  const requested: LinkJobRequest = {
    // The hash is also the media-cache key, so a Lens MP3 reuses a Telegram /audio mp3 result.
    sourceUrlHash: await hmacSha256Hex(env.INTERNAL_CONTAINER_SECRET, source.url),
    requestedMode: mp3 || music ? "audio" : "video",
    requestedQuality: mp3 ? "mp3" : music ? "m4a" : `max-${config.defaultMaxHeight}p`,
    requestedStartSeconds: trim?.startSeconds ?? null,
    requestedEndSeconds: trim?.endSeconds ?? null,
  };
  const replayed = await replayedLinkDownload(env, updateId, requested);
  if (replayed) return replayed;

  const now = new Date();
  const job: NewJob = {
    id: crypto.randomUUID(),
    telegramUpdateId: updateId,
    telegramUserId: principal.telegramUserId,
    telegramChatId: principal.chatId,
    sourceHost: source.sourceHost,
    sourceKind: "url",
    ...requested,
    sourceUrlEncrypted: await encryptSourceUrl(env.INTERNAL_CONTAINER_SECRET, source.url),
    requestedOperation: "download",
    queueCommandHint: false,
    createdAt: now.toISOString(),
  };
  try {
    await createJobWithUpdateReservation(env.DB, job, {
      maxActiveJobs: config.maxActiveJobs,
      maxActiveTranscriptions: config.maxActiveTranscriptions,
      maxJobsPerHour: owner ? config.maxJobsPerHour : Math.min(LENS_LINK_INVITED_JOBS_PER_HOUR, config.maxJobsPerHour),
      hourlyWindowStart: new Date(now.getTime() - 3_600_000).toISOString(),
    });
  } catch (error) {
    if (error instanceof QueueLimitError) throw new IntegrationFailure(429, "job_limit", "You already have 5 unfinished jobs. Try again after one finishes.", true);
    if (error instanceof HourlyJobLimitError) throw new IntegrationFailure(429, "job_limit", "Your hourly request limit is reached. Try again later.", true);
    if (error instanceof ActiveJobLimitError) throw new IntegrationFailure(503, "job_limit", "This processing queue is currently unavailable. Try again later.", true);
    // A concurrent replay of the same action may have won the unique-key race;
    // the D1 batch is atomic, so the losing attempt left no row behind.
    const raced = await replayedLinkDownload(env, updateId, requested);
    if (raced) return raced;
    throw error;
  }

  const dispatch = Promise.allSettled([dispatchNotices(env, updateId), dispatchAcceptedJob(env, job.id)]).then((results) => {
    const failed = results.find((result) => result.status === "rejected");
    if (!failed) return;
    logStructured("lens_link_job_dispatch_deferred", {
      jobId: job.id,
      sourceHost: source.sourceHost,
      sourceUrlHash: job.sourceUrlHash,
      errorCode: failed.reason instanceof TelegramApiError ? telegramErrorToApplicationError(failed.reason).code : "INTERNAL_ERROR",
    });
  });
  if (waitUntil) waitUntil(dispatch);
  else await dispatch;
  logStructured("lens_link_job_accepted", { jobId: job.id, sourceHost: source.sourceHost, sourceUrlHash: job.sourceUrlHash, state: "queued" });
  return { jobId: job.id, state: "queued" };
}

/** A clip needs both bounds; one bound, a non-integer or an empty or over-long range is rejected like a Telegram timing phrase. */
function linkTrimRange(body: Record<string, unknown>): TrimRange | null {
  if (!Object.hasOwn(body, "startSeconds") && !Object.hasOwn(body, "endSeconds")) return null;
  const { startSeconds, endSeconds } = body;
  if (!isValidTrimRange(startSeconds, endSeconds)) throw new IntegrationFailure(400, "invalid_request", safeMessageForError("INVALID_TIME_RANGE"));
  return { startSeconds, endSeconds: endSeconds as number };
}

/** The same action and request return the admitted job; the same action with another link, output or trim is a conflict. */
async function replayedLinkDownload(env: Env, updateId: string, requested: LinkJobRequest): Promise<LensLinkDownload | null> {
  const processed = await getProcessedUpdate(env.DB, updateId);
  if (!processed) return null;
  const job = processed.job_id ? await getJob(env.DB, processed.job_id) : null;
  if (!job || job.source_url_hash !== requested.sourceUrlHash || job.requested_mode !== requested.requestedMode
    || job.requested_quality !== requested.requestedQuality || (job.requested_start_seconds ?? null) !== requested.requestedStartSeconds
    || (job.requested_end_seconds ?? null) !== requested.requestedEndSeconds) {
    throw new IntegrationFailure(409, "operation_conflict", "This action ID is already bound to a different link, output or trim.");
  }
  return { jobId: job.id, state: "queued" };
}

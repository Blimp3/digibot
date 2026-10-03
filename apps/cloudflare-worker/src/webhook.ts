import { encryptSourceUrl, hmacSha256Hex } from "./crypto";
import { validateTelegramFile } from "./container-contract";
import { getWorkerConfig } from "./config";
import { ApplicationError, mapUnknownError, safeMessageForError, type ErrorCode } from "./errors";
import {
  ActiveJobLimitError,
  cancelVideoQualityPrompt,
  createVideoQualityPrompt,
  expireVideoQualityPrompts,
  getVideoQualityPrompt,
  confirmedDeliveryMessageIds,
  QualityPromptUnavailableError,
  VIDEO_QUALITY_CHOICES,
  type NewJob,
  countRecentJobs,
  createJobWithUpdateReservation,
  createJobsWithUpdateReservations,
  formatJobStatus,
  getJobDelivery,
  getLatestJobForUser,
  getProcessedUpdate,
  getUserQueue,
  HourlyJobLimitError,
  QueueLimitError,
  reserveSearchUpdate,
  reserveCollectionUpdate,
} from "./db";
import { constantTimeEqualString } from "./security";
import { logStructured } from "./logging";
import { dispatchAcceptedJob } from "./dispatch";
import { formatSourceCatalog } from "./sources";
import { dispatchNotices, enqueueNotice, ensureWaitingNotice } from "./notices";
import { formatLatestUserActivity, formatUserActivityStats, getLatestUserActivity, getUserActivityStats, parseActivityPeriod, type ActivityPeriod } from "./stats";
import { TelegramApiError, TelegramClient, telegramErrorToApplicationError } from "./telegram";
import { searchTranscriptDocument, TranscriptSearchError, validateTranscriptDocument, validateTranscriptQuery } from "./transcript-search";
import { parseAllowedTelegramUserIds } from "./telegram-user-ids";
import { clipCountForJob, parseClipRanges, storedClipRanges, parseTrimTiming, type TrimRange } from "./trim";
import type { Env, JobOperation, JobSourceKind, MediaMode, TelegramFileSource, TelegramMessage, TelegramUpdate } from "./types";
import { extractSingleUrl, normalizeHostname, validateSourceUrl } from "./url";
import { MAX_YOUTUBE_ITEMS, resolveYouTubeCollection, youtubeCollectionUrl, type YouTubeCollectionCommand } from "./youtube-collection";
import { handleIntegrationTelegramUpdate } from "./integration-telegram";

const MAX_WEBHOOK_BODY_BYTES = 128 * 1024;
const ACCEPTED_CONTENT_TYPE = /^application\/json(?:\s*;|$)/iu;

export type ParsedTelegramCommand =
  | YouTubeCollectionCommand
  | { kind: "start" | "help" | "status" | "queue" | "sources" | "activity" }
  | { kind: "stats"; period: ActivityPeriod }
  | { kind: "transcript"; sourceUrl: string }
  | { kind: "captions"; sourceUrl: string; language?: string }
  | { kind: "search"; query: string }
  | { kind: "media"; mode: "video"; sourceUrl: string | null; pickQuality?: true; clipRanges?: TrimRange[]; trimStartSeconds?: number; trimEndSeconds?: number }
  | { kind: "media"; mode: "audio"; sourceUrl: string | null; audioFormat: "m4a" | "mp3"; trimStartSeconds?: number; trimEndSeconds?: number };

export type TelegramCommandParseResult =
  | { kind: "command"; command: ParsedTelegramCommand }
  | { kind: "error"; code: "INVALID_REQUEST" | "UNSUPPORTED_MEDIA"; message: string };

type TelegramCommandErrorCode = "INVALID_REQUEST" | "UNSUPPORTED_MEDIA";

function parseMediaUrl(sourceUrl: string): string | null {
  if (!URL.canParse(sourceUrl)) return null;
  return normalizeHostname(new URL(sourceUrl).hostname);
}

function parseError(message: string, code: TelegramCommandErrorCode = "INVALID_REQUEST"): TelegramCommandParseResult {
  return { kind: "error", code, message };
}

function mediaWithTrim<T extends Extract<ParsedTelegramCommand, { kind: "media" }>>(media: T, trim: TrimRange | null): T {
  return trim ? { ...media, trimStartSeconds: trim.startSeconds, trimEndSeconds: trim.endSeconds } as T : media;
}

function parseMediaCommand(mode: MediaMode, sourceUrl: string | null, args: readonly string[]): TelegramCommandParseResult {
  if (mode === "video") {
    if (args.some((token) => /^(?:m4a|mp3)$/iu.test(token))) {
      return parseError("Audio formats apply only to /audio commands. Use /video URL followed by timing.");
    }
    const timing = args.length ? parseTrimTiming(args) : null;
    if (timing && !timing.ok) return parseError(timing.message);
    return {
      kind: "command",
      command: mediaWithTrim({ kind: "media", mode, sourceUrl, pickQuality: true }, timing?.ok ? timing.range : null),
    };
  }

  const formatIndexes = args.flatMap((token, index) => /^(?:m4a|mp3)$/iu.test(token) ? [index] : []);
  if (formatIndexes.length > 1) return parseError("Choose one audio format, m4a or mp3, and place it before or after the timing phrase.");
  const formatIndex = formatIndexes[0];
  if (formatIndex !== undefined && formatIndex !== 0 && formatIndex !== args.length - 1) {
    return parseError("Place the audio format at the start or end of the command, outside the timing phrase.");
  }
  const audioFormat = formatIndex === undefined ? "m4a" : (args[formatIndex] ?? "").toLowerCase() as "m4a" | "mp3";
  const timingTokens = formatIndex === undefined
    ? args
    : args.filter((_, index) => index !== formatIndex);
  const timing = timingTokens.length ? parseTrimTiming(timingTokens) : null;
  if (timing && !timing.ok) return parseError(timing.message);
  return {
    kind: "command",
    command: mediaWithTrim({ kind: "media", mode, sourceUrl, audioFormat }, timing?.ok ? timing.range : null),
  };
}

/** Parse a Telegram command and retain a safe, user-facing timing error. */
export function parseTelegramCommandDetailed(text: string, allowReplyMedia = false): TelegramCommandParseResult {
  const normalized = text.trim();
  if (!normalized) return parseError("Send one public media URL or a supported command.", "UNSUPPORTED_MEDIA");
  const command = normalized.match(/^\/(start|help|status|queue|sources|activity)(?:@[A-Za-z0-9_]+)?$/iu);
  if (command?.[1]) return { kind: "command", command: { kind: command[1].toLowerCase() as "start" | "help" | "status" | "queue" | "sources" | "activity" } };
  const statsCommand = normalized.match(/^\/stats(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/isu);
  if (statsCommand) {
    const period = parseActivityPeriod(statsCommand[1]?.trim().toLowerCase());
    return period ? { kind: "command", command: { kind: "stats", period } }
      : parseError("Use /stats [24h|7d|30d|all]. The default is 7 days; all means retained activity history.");
  }
  const collectionCommand = normalized.match(/^\/(playlist|channel)(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/isu);
  if (collectionCommand) {
    const [sourceUrl = "", count = "3", format = "video", ...extra] = (collectionCommand[2] ?? "").trim().split(/\s+/u);
    if (!parseMediaUrl(sourceUrl) || !/^[1-5]$/u.test(count) || !/^(?:video|m4a|mp3)$/iu.test(format) || extra.length) {
      return parseError("Use /playlist YOUTUBE_URL [1-5] [video|m4a|mp3] or /channel YOUTUBE_URL [1-5] [video|m4a|mp3]. Defaults: 3 items, video.");
    }
    return { kind: "command", command: { kind: "youtube_collection", collection: collectionCommand[1]!.toLowerCase() as "playlist" | "channel",
      sourceUrl, count: Number(count), format: format.toLowerCase() as YouTubeCollectionCommand["format"] } };
  }
  const captionsCommand = normalized.match(/^\/captions(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/isu);
  if (captionsCommand) {
    const [candidate = "", language, ...extra] = (captionsCommand[1] ?? "").trim().split(/\s+/u);
    const sourceUrl = extractSingleUrl(candidate);
    if (!sourceUrl || sourceUrl !== candidate || !parseMediaUrl(sourceUrl) || extra.length
      || (language !== undefined && (language.length > 35 || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/u.test(language)))) {
      return parseError("Use /captions URL [language], for example /captions https://youtu.be/VIDEO it. Sources must be up to 15 minutes.");
    }
    return { kind: "command", command: { kind: "captions", sourceUrl, ...(language ? { language: language.toLowerCase() } : {}) } };
  }
  const searchCommand = normalized.match(/^\/search(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/isu);
  if (searchCommand) {
    const query = (searchCommand[1] ?? "").trim();
    try { validateTranscriptQuery(query); } catch {
      return parseError("Reply to a DigiBot Markdown file with /search followed by 1–200 characters, for example /search climate change.");
    }
    return { kind: "command", command: { kind: "search", query } };
  }
  const transcriptCommand = normalized.match(/^\/transcript(?:@[A-Za-z0-9_]+)?\s+(.+)$/isu);
  if (transcriptCommand?.[1]) {
    const sourceUrl = extractSingleUrl(transcriptCommand[1].trim());
    if (!sourceUrl || sourceUrl !== transcriptCommand[1].trim() || !parseMediaUrl(sourceUrl)) {
      return parseError("Use /transcript followed by one valid HTTP or HTTPS media URL.", "UNSUPPORTED_MEDIA");
    }
    return { kind: "command", command: { kind: "transcript", sourceUrl } };
  }
  const clipsCommand = normalized.match(/^\/clips(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/isu);
  if (clipsCommand) {
    const args = (clipsCommand[1] ?? "").trim();
    const first = args.match(/^\S+/u)?.[0] ?? "";
    const candidate = extractSingleUrl(first);
    const sourceUrl = candidate === first && candidate && parseMediaUrl(candidate) ? candidate : null;
    if (!sourceUrl && !allowReplyMedia) return parseError("Use /clips URL followed by 2–3 semicolon-separated timing ranges, or reply to a file with /clips and the ranges.");
    try {
      const clipRanges = parseClipRanges(sourceUrl ? args.slice(first.length).trim() : args);
      return { kind: "command", command: { kind: "media", mode: "video", sourceUrl, pickQuality: true, clipRanges } };
    } catch (error) {
      return parseError(error instanceof RangeError ? error.message : "Choose valid clip ranges.");
    }
  }
  const mediaCommand = normalized.match(/^\/(video|audio)(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/isu);
  if (mediaCommand?.[1]) {
    const tokens = mediaCommand[2]?.trim() ? mediaCommand[2].trim().split(/\s+/u) : [];
    const candidate = tokens[0] ?? "";
    const sourceUrl = extractSingleUrl(candidate);
    const mode = mediaCommand[1].toLowerCase() as MediaMode;
    if (sourceUrl && sourceUrl === candidate && parseMediaUrl(sourceUrl)) return parseMediaCommand(mode, sourceUrl, tokens.slice(1));
    if (allowReplyMedia && !tokens.some((token) => /^https?:/iu.test(token))) return parseMediaCommand(mode, null, tokens);
    return parseError("Use a public media URL, or reply to one audio or video file with /audio [m4a|mp3] [timing] or /video [timing].", "UNSUPPORTED_MEDIA");
  }
  const sourceUrl = extractSingleUrl(normalized);
  if (!sourceUrl || sourceUrl !== normalized) return parseError("Send one public media URL or a supported command.", "UNSUPPORTED_MEDIA");
  const host = parseMediaUrl(sourceUrl);
  if (!host) return parseError("Send one valid HTTP or HTTPS media URL.", "UNSUPPORTED_MEDIA");
  return {
    kind: "command",
    command: host === "music.youtube.com"
      ? { kind: "media", mode: "audio", sourceUrl, audioFormat: "m4a" }
      : { kind: "media", mode: "video", sourceUrl },
  };
}

export function parseTelegramCommand(text: string): ParsedTelegramCommand | null {
  const result = parseTelegramCommandDetailed(text);
  return result.kind === "command" ? result.command : null;
}

export function parseAllowedUserIds(value: string | undefined): ReadonlySet<string> | null {
  return parseAllowedTelegramUserIds(value);
}

export function telegramNumericId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?\d{1,20}$/u.test(value)) return value;
  return null;
}

function isAllowedTelegramMessage(message: TelegramMessage, allowedUserIds: ReadonlySet<string>): { userId: string; chatId: string } | null {
  const userId = telegramNumericId(message.from?.id);
  const chatId = telegramNumericId(message.chat?.id);
  if (!userId || !chatId || message.chat?.type !== "private" || !allowedUserIds.has(userId)) return null;
  if (userId !== chatId) return null;
  return { userId, chatId };
}

const TELEGRAM_MEDIA_FIELDS = ["video", "audio", "voice", "document"] as const;
const UNSUPPORTED_TELEGRAM_MEDIA_FIELDS = ["photo", "sticker", "animation", "video_note", "media_group_id"] as const;
const TELEGRAM_FILE_INSTRUCTIONS = "Reply to this file with /audio [m4a|mp3] [timing] or /video [timing] to convert it. Example: /audio mp3 first 30 seconds. /video asks for quality. One audio or video file up to 20 MB per request.";

function hasTelegramMedia(message: TelegramMessage): boolean {
  return [...TELEGRAM_MEDIA_FIELDS, ...UNSUPPORTED_TELEGRAM_MEDIA_FIELDS].some((key) => message[key] !== undefined);
}

function telegramFileFromMessage(message: TelegramMessage): TelegramFileSource {
  const fields = TELEGRAM_MEDIA_FIELDS.filter((key) => message[key] !== undefined);
  if (fields.length !== 1 || UNSUPPORTED_TELEGRAM_MEDIA_FIELDS.some((key) => message[key] !== undefined)) {
    throw new ApplicationError("UNSUPPORTED_MEDIA", { message: "Send one video, audio, voice message, or audio/video document. Albums, photos, stickers, animations, and archives are not supported." });
  }
  const raw = message[fields[0]!];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApplicationError("INVALID_REQUEST");
  const media = raw as Record<string, unknown>;
  const file = validateTelegramFile({ fileId: media.file_id, fileSize: media.file_size,
    ...(media.file_name !== undefined ? { fileName: media.file_name } : {}) });
  if (fields[0] === "document") {
    const mime = typeof media.mime_type === "string" ? media.mime_type : "";
    const mediaMime = /^(?:audio|video)\/[A-Za-z0-9.+-]{1,100}$/u.test(mime);
    const mediaExtension = /\.(?:mp4|m4v|mov|webm|mkv|avi|mpg|mpeg|3gp|mp3|m4a|aac|wav|flac|ogg|oga|opus|weba)$/iu.test(file.fileName ?? "");
    if (!mediaMime && !mediaExtension) throw new ApplicationError("UNSUPPORTED_MEDIA", { message: "That document does not look like audio or video. Send one audio/video file up to 20 MB; archives and other documents are not supported." });
  }
  return file;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new ApplicationError("INTERNAL_ERROR", { status: 413, message: "Request body too large" });
  }
  if (!request.body) throw new ApplicationError("INTERNAL_ERROR", { status: 400, message: "Missing body" });
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value) {
        size += next.value.byteLength;
        if (size > MAX_WEBHOOK_BODY_BYTES) throw new ApplicationError("INTERNAL_ERROR", { status: 413, message: "Request body too large" });
        chunks.push(next.value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new ApplicationError("INTERNAL_ERROR", { status: 400, message: "Invalid JSON" });
  }
}

function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TelegramUpdate>;
  return typeof candidate.update_id === "number" && Number.isSafeInteger(candidate.update_id) && candidate.update_id >= 0;
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function helpText(connectedMedia = false): string {
  return `👋 DigiBot quick guide

Send a public media link to download a video.
YouTube Music tracks save as M4A audio automatically.

🎬 Media

/video URL — choose quality and download video.
/audio URL [m4a|mp3] — save audio; M4A is the default.
/video URL from 12:00 to 17:00 — trim a video.
/audio URL mp3 first 5 minutes — trim an MP3.
/clips URL from 00:00 to 00:02; from 00:03 for 2 seconds — make a pack of 2–3 clips. Also works as a reply to a file.

📚 YouTube batches only

/playlist URL [1-5] [video|m4a|mp3] — first listed items.
/channel URL [1-5] [video|m4a|mp3] — latest videos (not Shorts/live tabs).
Defaults: 3 items, automatic video up to 1080p. Example: /playlist URL 3 m4a.
Each item uses one queue/hourly slot; the whole batch must fit your 5 unfinished-request limit. Unavailable/duplicate items can reduce the count. No automatic full-playlist or channel download.

🎙️ Transcripts and captions

/transcript URL — turn speech into text with timestamps.
/captions URL [language] — get publisher-provided or automatic source captions.
Full transcript and caption source requests are limited to 15 minutes.

🔎 Search

Reply to a DigiBot .md transcript with /search climate change to find passages and timestamps. Keep your file; no transcript archive is stored.

📎 Replied files

Send or forward one audio/video file or voice message up to 20 MB, then reply with /audio [m4a|mp3] [timing] or /video [timing] to start. Video asks for quality.

${connectedMedia ? "🖼️ Provenance\n\nSend a PNG, JPEG or WebP (4 MiB max, no HEIC) and tap Check this image, or reply /check. Send photos as a File: Telegram strips Content Credentials.\n\n" : ""}📋 Jobs and sources

/queue — your waiting and running requests.
/status — your latest request.
/stats [24h|7d|30d|all] — your request stats.
/activity — your five latest requests.
/sources — supported sites and limits.`;
}

function queueJobStatus(job: Awaited<ReturnType<typeof getUserQueue>>[number]): string {
  if (job.delivery_state === "unknown") return "Outcome unknown; awaiting review.";
  if (job.position !== null) return `Queued, position ${job.position}. Starts automatically.`;
  return job.status === "received" || job.status === "queued" ? "Starting." : `${job.status}.`;
}

export async function handleTelegramWebhook(
  request: Request,
  env: Env,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  if (request.method !== "POST") return jsonResponse({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
  const suppliedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!env.TELEGRAM_WEBHOOK_SECRET || !suppliedSecret || !constantTimeEqualString(env.TELEGRAM_WEBHOOK_SECRET, suppliedSecret)) return jsonResponse({ ok: false, error: "UNAUTHORIZED" }, 403);
  const contentType = request.headers.get("content-type") ?? "";
  if (!ACCEPTED_CONTENT_TYPE.test(contentType)) return jsonResponse({ ok: false, error: "UNSUPPORTED_MEDIA_TYPE" }, 415);

  let rawUpdate: unknown;
  try {
    rawUpdate = await readJsonBody(request);
  } catch (error) {
    const appError = mapUnknownError(error);
    return jsonResponse({ ok: false, error: appError.status === 413 ? "BODY_TOO_LARGE" : "INVALID_JSON" }, appError.status === 413 ? 413 : 400);
  }
  if (!isTelegramUpdate(rawUpdate)) return jsonResponse({ ok: true, ignored: true });
  const update = rawUpdate;
  const integrationResponse = await handleIntegrationTelegramUpdate(update, env, waitUntil);
  if (integrationResponse) return integrationResponse;
  const allowedUserIds = parseAllowedUserIds(env.ALLOWED_TELEGRAM_USER_IDS);
  if (!allowedUserIds) return jsonResponse({ ok: true, ignored: true });
  if (update.callback_query !== undefined) return handleQualityCallback(update, allowedUserIds, env, waitUntil);
  if (typeof update.message !== "object" || update.message === null) return jsonResponse({ ok: true, ignored: true });
  const message = update.message;
  const allowed = isAllowedTelegramMessage(message, allowedUserIds);
  if (!allowed) return jsonResponse({ ok: true, ignored: true });
  const parsedCommand = parseTelegramCommandDetailed(typeof message.text === "string" ? message.text : "", message.reply_to_message !== undefined);
  const command = parsedCommand.kind === "command" ? parsedCommand.command : null;

  const config = getWorkerConfig(env);
  const updateId = String(update.update_id);
  const db = env.DB;
  let existing;
  try { existing = await getProcessedUpdate(db, updateId); }
  catch { return jsonResponse({ ok: false, error: "INTERNAL_ERROR" }, 500); }
  if (existing) {
    logStructured("telegram_update_duplicate");
    return jsonResponse({ ok: true, duplicate: true });
  }

  async function acknowledgeNotice(text: string, error?: string): Promise<Response> {
    try {
      if (!(await enqueueNotice(db, updateId, allowed!.chatId, text))) return jsonResponse({ ok: true, duplicate: true });
    } catch {
      return jsonResponse({ ok: false, error: "INTERNAL_ERROR" }, 500);
    }
    if (waitUntil) waitUntil(dispatchNotices(env, updateId).catch(() => {
      logStructured("telegram_notice_dispatch_deferred", { state: "pending" });
    }));
    return jsonResponse({ ok: true, accepted: !error, ...(error ? { error, message: text } : {}) });
  }

  // Attachment captions never execute commands or turn embedded URLs into jobs.
  if (hasTelegramMedia(message)) {
    if (message.document !== undefined
      && [...TELEGRAM_MEDIA_FIELDS.filter((key) => key !== "document"), ...UNSUPPORTED_TELEGRAM_MEDIA_FIELDS].every((key) => message[key] === undefined)) {
      try {
        validateTranscriptDocument(message.document);
        return acknowledgeNotice("Reply to a DigiBot Markdown file with /search climate change for matching passages and timestamps. No transcript archive is kept.");
      } catch { /* Other attachments retain the media validation and instructions below. */ }
    }
    try { telegramFileFromMessage(message); }
    catch (error) {
      const appError = mapUnknownError(error);
      return acknowledgeNotice(appError.message, appError.code);
    }
    return acknowledgeNotice(TELEGRAM_FILE_INSTRUCTIONS);
  }
  if (parsedCommand.kind === "error") return acknowledgeNotice(parsedCommand.message, parsedCommand.code);
  if (!command) return acknowledgeNotice(helpText(env.INTEGRATION_ENABLED === "true"), "UNSUPPORTED_MEDIA");

  if (command.kind === "youtube_collection") {
    try {
      command.sourceUrl = youtubeCollectionUrl(command.sourceUrl, command.collection, config);
    } catch {
      return acknowledgeNotice("Use a public YouTube playlist URL or a channel /@handle or /channel/UC… URL. Mixes, feeds and other sites are not supported.", "INVALID_URL");
    }
    try {
      if ((await getUserQueue(db, allowed.userId)).length + command.count > MAX_YOUTUBE_ITEMS) {
        return acknowledgeNotice("The whole batch must fit your 5 unfinished requests. Check /queue, choose fewer items, or wait.", "SOURCE_RATE_LIMITED");
      }
      if ((await countRecentJobs(db, allowed.userId, new Date(Date.now() - 3_600_000).toISOString())) + command.count > config.maxJobsPerHour) {
        return acknowledgeNotice("The whole batch would exceed your hourly request limit. Choose fewer items or try later.", "SOURCE_RATE_LIMITED");
      }
      const reservation = await reserveCollectionUpdate(db, updateId, allowed.userId, config.maxJobsPerHour);
      if (reservation === "duplicate") return jsonResponse({ ok: true, duplicate: true });
      if (reservation === "limited") return acknowledgeNotice("Wait 30 seconds between YouTube collection lookups. The hourly lookup limit also applies.", "SOURCE_RATE_LIMITED");
    } catch { return jsonResponse({ ok: false, error: "INTERNAL_ERROR" }, 500); }
    // Known limit: lookup is one-shot within 20s, not a durable crawler. Check /queue
    // and repeat explicitly after interruption; admitted item jobs are durable.
    const work = runYouTubeCollection(env, command, updateId, allowed.userId, allowed.chatId, String(message.message_id))
      .catch(() => logStructured("telegram_notice_dispatch_deferred", { state: "pending" }));
    if (waitUntil) waitUntil(work);
    else await work;
    return jsonResponse({ ok: true, accepted: true, collectionPending: true });
  }

  if (command.kind === "search") {
    const reply = message.reply_to_message;
    if (!reply || reply.chat?.type !== "private" || telegramNumericId(reply.chat.id) !== allowed.chatId) {
      return acknowledgeNotice("Reply to a DigiBot Markdown file with /search followed by the words to find.", "INVALID_REQUEST");
    }
    try { validateTranscriptDocument(reply.document); } catch (error) {
      return acknowledgeNotice(error instanceof TranscriptSearchError ? error.message : "Reply to a DigiBot Markdown file up to 2 MB.", "INVALID_REQUEST");
    }
    let admission: "accepted" | "duplicate" | "limited";
    try { admission = await reserveSearchUpdate(db, updateId, allowed.userId, config.maxJobsPerHour); }
    catch { return jsonResponse({ ok: false, error: "INTERNAL_ERROR" }, 500); }
    if (admission === "duplicate") return jsonResponse({ ok: true, duplicate: true });
    if (admission === "limited") {
      return acknowledgeNotice("Wait 30 seconds between searches. The hourly search limit also applies; try again later.", "SOURCE_RATE_LIMITED");
    }
    // Known limit: an admitted search is one-shot and held only in memory; users
    // repeat explicitly after interruption rather than persisting private text.
    const search = (async (): Promise<void> => {
      const client = new TelegramClient({ token: env.TELEGRAM_BOT_TOKEN, requestTimeoutMs: 7_000 });
      let text: string;
      try { text = await searchTranscriptDocument(env.TELEGRAM_BOT_TOKEN, reply.document, command.query); }
      catch (error) {
        text = error instanceof TranscriptSearchError ? error.message : "The file could not be searched. Reply to the file and try again.";
      }
      // Once sending starts, an uncertain result must never trigger a fallback.
      try {
        await client.sendMessage(allowed.chatId, text);
        logStructured("transcript_search_delivered", { state: "confirmed" });
      } catch {
        logStructured("transcript_search_delivery_unconfirmed", { state: "unknown" });
      }
    })();
    if (waitUntil) waitUntil(search);
    else await search;
    return jsonResponse({ ok: true, accepted: true });
  }

  if (command.kind === "start" || command.kind === "help" || command.kind === "status" || command.kind === "queue" || command.kind === "sources" || command.kind === "stats" || command.kind === "activity") {
    let text: string;
    try {
      if (command.kind === "status") {
        const job = await getLatestJobForUser(db, allowed.userId);
        const delivery = job ? await getJobDelivery(db, job.id) : null;
        const queued = job && job.status !== "completed" && job.status !== "failed"
          ? (await getUserQueue(db, allowed.userId)).find((entry) => entry.id === job.id)
          : undefined;
        const clipCount = job ? clipCountForJob(job) : 0;
        text = delivery?.state === "unknown" || (clipCount !== 0 && (!delivery || (delivery.state === "confirmed" && confirmedDeliveryMessageIds(delivery, job!) === null)))
          ? "Job outcome unknown. No automatic resend will occur; this job needs review."
          : delivery?.state === "confirmed" ? "Job completed. Telegram delivery is confirmed."
            : queued ? queueJobStatus(queued) : formatJobStatus(job);
        if (clipCount > 0) text = `Clip pack (${clipCount} clips): ${text}`;
      }
      else if (command.kind === "queue") {
        const jobs = await getUserQueue(db, allowed.userId);
        text = jobs.length ? jobs.map((job, index) => {
          const clipCount = clipCountForJob(job);
          const kind = clipCount > 0 ? `Clip pack (${clipCount})` : job.requested_operation === "transcript"
            ? job.transcript_method === "captions" ? "Captions" : "Whisper"
            : job.requested_mode === "audio" ? "Audio" : "Video";
          return `${index + 1}. ${kind} (${job.source_host}): ${queueJobStatus(job)}`;
        }).join("\n") + "\nPositions count waiting jobs in each processing queue; running jobs are separate."
          : "You have no unfinished jobs.";
      }
      else if (command.kind === "sources") text = formatSourceCatalog();
      else if (command.kind === "stats") text = formatUserActivityStats(await getUserActivityStats(db, allowed.userId, { period: command.period }));
      else if (command.kind === "activity") text = formatLatestUserActivity(await getLatestUserActivity(db, allowed.userId));
      else text = helpText(env.INTEGRATION_ENABLED === "true");
    } catch { return jsonResponse({ ok: false, error: "INTERNAL_ERROR" }, 500); }
    return acknowledgeNotice(text);
  }

  if (command.kind !== "media" && command.kind !== "transcript" && command.kind !== "captions") return jsonResponse({ ok: false, error: "UNSUPPORTED_MEDIA" }, 400);

  const operation: JobOperation = command.kind === "media" ? "download" : "transcript";
  const mode: MediaMode = command.kind === "media" ? command.mode : "audio";
  const requestedQuality = command.kind !== "media" ? "m4a" : command.mode === "video" ? `max-${config.defaultMaxHeight}p` : command.audioFormat;

  let source: { value: string; sourceHost: string; kind: JobSourceKind; hashInput: string };
  try {
    if (command.kind === "media" && command.sourceUrl === null) {
      const reply = message.reply_to_message;
      if (!reply || reply.chat?.type !== "private" || telegramNumericId(reply.chat.id) !== allowed.chatId
        || !Number.isSafeInteger(reply.message_id) || reply.message_id <= 0) {
        return acknowledgeNotice("Reply to one audio or video file in this private chat to convert it.", "INVALID_REQUEST");
      }
      const file = telegramFileFromMessage(reply);
      source = { value: JSON.stringify(file), sourceHost: "telegram", kind: "telegram_file",
        hashInput: `telegram-file:v1\0${allowed.userId}\0${allowed.chatId}\0${file.fileId}` };
    } else {
      const validated = validateSourceUrl(command.sourceUrl!, config);
      source = { value: validated.url, sourceHost: validated.sourceHost, kind: "url", hashInput: validated.url };
    }
  } catch (error) {
    const appError = mapUnknownError(error);
    return acknowledgeNotice(command.kind === "media" && command.sourceUrl === null ? appError.message : safeMessageForError(appError.code), appError.code);
  }

  const now = new Date();
  const since = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  // The hourly query is a fast rejection for the common case. The same
  // constraint is re-checked in the atomic D1 admission batch below so two
  // concurrent requests cannot both pass this read and exceed the limit.
  try {
    if (!(command.kind === "media" && command.mode === "video" && command.pickQuality)
      && (await countRecentJobs(db, allowed.userId, since)) >= config.maxJobsPerHour) {
      return acknowledgeNotice("Your hourly request limit is reached. Try again later.", "SOURCE_RATE_LIMITED");
    }
  } catch { return jsonResponse({ ok: false, error: "INTERNAL_ERROR" }, 500); }
  const jobId = crypto.randomUUID();
  let encryptedSourceUrl: string;
  let sourceHash: string;
  try {
    encryptedSourceUrl = await encryptSourceUrl(env.INTERNAL_CONTAINER_SECRET, source.value);
    sourceHash = await hmacSha256Hex(env.INTERNAL_CONTAINER_SECRET, source.hashInput);
  } catch {
    return jsonResponse({ ok: false, error: "INTERNAL_ERROR" }, 500);
  }
  const newJob: NewJob = {
    id: jobId,
    telegramUpdateId: updateId,
    telegramUserId: allowed.userId,
    telegramChatId: allowed.chatId,
    requestMessageId: String(message.message_id),
    sourceHost: source.sourceHost,
    sourceKind: source.kind,
    sourceUrlHash: sourceHash,
    sourceUrlEncrypted: encryptedSourceUrl,
    requestedMode: mode,
    requestedOperation: operation,
    ...(command.kind === "captions" ? { transcriptMethod: "captions" as const, captionLanguage: command.language ?? null } : {}),
    requestedQuality,
    requestedStartSeconds: command.kind === "media" ? command.trimStartSeconds ?? null : null,
    requestedEndSeconds: command.kind === "media" ? command.trimEndSeconds ?? null : null,
    requestedClipRanges: command.kind === "media" && command.mode === "video" ? command.clipRanges ?? null : null,
    createdAt: now.toISOString(),
  };
  try {
    if (command.kind === "media" && command.mode === "video" && command.pickQuality) {
      await createVideoQualityPrompt(db, newJob, config.defaultMaxHeight);
      const dispatch = dispatchNotices(env, updateId).catch(() => {
        logStructured("telegram_notice_dispatch_deferred", { state: "pending" });
      });
      if (waitUntil) waitUntil(dispatch);
      else await dispatch;
      return jsonResponse({ ok: true, accepted: true, qualityPending: true });
    }
    await createJobWithUpdateReservation(db, newJob, {
      maxActiveJobs: config.maxActiveJobs,
      maxActiveTranscriptions: config.maxActiveTranscriptions,
      maxJobsPerHour: config.maxJobsPerHour,
      hourlyWindowStart: since,
    });
  } catch (error) {
    if (error instanceof QueueLimitError || error instanceof ActiveJobLimitError || error instanceof HourlyJobLimitError) {
      return acknowledgeNotice(error instanceof QueueLimitError
        ? "You already have 5 unfinished jobs. Check /queue and try again after one finishes."
        : error instanceof ActiveJobLimitError
          ? "This processing queue is currently unavailable. Try again later."
        : "Your hourly request limit is reached. Try again later.",
      error instanceof ActiveJobLimitError && error.lane === "transcript" ? "TRANSCRIPT_RATE_LIMITED" : "SOURCE_RATE_LIMITED");
    }
    try {
      // A concurrent delivery of the same Telegram update may have won the
      // unique-key race. The D1 batch is atomic, so there is no orphan row to
      // clean up when our attempt loses.
      if (await getProcessedUpdate(db, updateId)) return jsonResponse({ ok: true, duplicate: true });
    } catch {
      // Preserve the stable internal response when D1 itself is unavailable.
    }
    return jsonResponse({ ok: false, error: "INTERNAL_ERROR" }, 500);
  }

  const dispatch = Promise.allSettled([dispatchNotices(env, updateId), dispatchAcceptedJob(env, jobId)]).then((results) => {
    const failed = results.find((result) => result.status === "rejected");
    if (!failed) return;
    logStructured("telegram_job_dispatch_deferred", {
      jobId,
      sourceHost: source.sourceHost,
      sourceUrlHash: sourceHash,
      errorCode: telegramErrorCode(failed.reason),
    });
  });
  if (waitUntil) waitUntil(dispatch);
  else await dispatch;
  logStructured("telegram_job_accepted", {
    jobId,
    sourceHost: source.sourceHost,
    sourceUrlHash: sourceHash,
    state: "queued",
  });
  return jsonResponse({ ok: true, accepted: true, jobId });
}

async function runYouTubeCollection(env: Env, command: YouTubeCollectionCommand, updateId: string, userId: string, chatId: string, messageId: string): Promise<void> {
  const config = getWorkerConfig(env);
  let jobs: NewJob[] = [];
  let notice: string;
  try {
    // The outbox survives an interrupted lookup and tells the user how to recover.
    const [, urls] = await Promise.all([
      ensureWaitingNotice(env, updateId, chatId,
        `Looking up at most ${command.count} YouTube items. If no result appears within 30 seconds, check /queue before sending the command again.`),
      resolveYouTubeCollection(env, command),
    ]);
    const now = Date.now();
    jobs = await Promise.all(urls.map(async (url, index): Promise<NewJob> => {
      const validated = validateSourceUrl(url, config);
      return {
        id: crypto.randomUUID(), telegramUpdateId: `${updateId}:youtube:${index + 1}`, telegramUserId: userId, telegramChatId: chatId,
        requestMessageId: messageId, sourceKind: "url", sourceHost: validated.sourceHost,
        sourceUrlHash: await hmacSha256Hex(env.INTERNAL_CONTAINER_SECRET, validated.url),
        sourceUrlEncrypted: await encryptSourceUrl(env.INTERNAL_CONTAINER_SECRET, validated.url),
        requestedMode: command.format === "video" ? "video" : "audio", requestedOperation: "download",
        requestedQuality: command.format === "video" ? `max-${config.defaultMaxHeight}p` : command.format,
        // Stable queue order without changing the shared FIFO comparator.
        createdAt: new Date(now + index).toISOString(),
      };
    }));
    await createJobsWithUpdateReservations(env.DB, jobs, {
      maxActiveJobs: config.maxActiveJobs, maxActiveTranscriptions: config.maxActiveTranscriptions,
      maxJobsPerHour: config.maxJobsPerHour, hourlyWindowStart: new Date(now - 3_600_000).toISOString(),
    });
    notice = `Queued ${jobs.length} YouTube ${command.format === "video" ? "video" : command.format.toUpperCase()} item${jobs.length === 1 ? "" : "s"} in listed order, each as a separate request.${jobs.length < command.count ? " The selected slice had fewer usable distinct items; nothing beyond it was added." : ""} Use /queue for progress.`;
  } catch (error) {
    jobs = [];
    notice = error instanceof QueueLimitError ? "Nothing from this batch was queued: it no longer fits your 5 unfinished requests. Check /queue and choose fewer items."
      : error instanceof HourlyJobLimitError ? "Nothing from this batch was queued: your hourly request limit was reached. Try later."
        : error instanceof ActiveJobLimitError ? "The download queue is unavailable. Nothing from this batch was queued."
          : `${safeMessageForError(mapUnknownError(error).code)} Collection lookup/queue confirmation did not finish. Check /queue before retrying; no automatic retry will occur.`;
  }
  await enqueueNotice(env.DB, `${updateId}:youtube:result`, chatId, notice);
  await Promise.allSettled([
    dispatchNotices(env, `${updateId}:youtube:result`),
    ...jobs.flatMap(job => [dispatchNotices(env, job.telegramUpdateId), dispatchAcceptedJob(env, job.id)]),
  ]);
}

async function handleQualityCallback(
  update: TelegramUpdate, allowedUserIds: ReadonlySet<string>, env: Env,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const raw = update.callback_query;
  if (!raw || typeof raw !== "object") return jsonResponse({ ok: true, ignored: true });
  const callback = raw as Record<string, unknown>;
  if (typeof callback.id !== "string" || callback.id.length < 1 || callback.id.length > 128
    || typeof callback.data !== "string" || !/^vq:[0-9a-f]{32}$/u.test(callback.data)
    || callback.inline_message_id !== undefined || !callback.message || typeof callback.message !== "object"
    || !callback.from || typeof callback.from !== "object") return jsonResponse({ ok: true, ignored: true });
  const message = callback.message as TelegramMessage;
  const userId = telegramNumericId((callback.from as { id?: unknown }).id);
  const chatId = telegramNumericId(message.chat?.id);
  if (!userId || !allowedUserIds.has(userId) || userId !== chatId || message.chat?.type !== "private"
    || !Number.isSafeInteger(message.message_id) || message.message_id <= 0
    || !Number.isSafeInteger(message.date) || Number(message.date) <= 0) return jsonResponse({ ok: true, ignored: true });
  const updateId = String(update.update_id);
  const messageId = String(message.message_id);
  const now = new Date();
  const config = getWorkerConfig(env);
  const client = new TelegramClient({ token: env.TELEGRAM_BOT_TOKEN, apiBase: config.telegramApiBase });
  async function reply(text: string, body: Record<string, unknown>, clear = false, jobId?: string): Promise<Response> {
    const work = Promise.allSettled([
      client.answerCallbackQuery(callback.id as string, text),
      ...(clear ? [client.clearInlineKeyboard(chatId!, messageId)] : []),
      ...(jobId ? [dispatchNotices(env, updateId), dispatchAcceptedJob(env, jobId)] : []),
    ]).then(() => undefined);
    if (waitUntil) waitUntil(work);
    else await work;
    return jsonResponse({ ok: true, ...body });
  }
  try {
    if (await getProcessedUpdate(env.DB, updateId)) return reply("This choice was already handled.", { duplicate: true });
    await expireVideoQualityPrompts(env.DB, now.toISOString());
    const prompt = await getVideoQualityPrompt(env.DB, callback.data);
    if (!prompt || prompt.user_id !== userId || prompt.chat_id !== chatId) {
      return reply("This choice is unavailable. Send /video again.", { accepted: false });
    }
    const selection = { token: callback.data, promptId: prompt.id, userId, chatId, messageId };
    if (prompt.choice === "cancel") {
      await cancelVideoQualityPrompt(env.DB, selection, updateId, now.toISOString());
      return reply("Video request cancelled.", { cancelled: true }, true);
    }
    const quality = VIDEO_QUALITY_CHOICES.find(({ choice }) => choice === prompt.choice);
    if (!quality?.height) return reply("This choice is unavailable. Send /video again.", { accepted: false });
    const jobId = crypto.randomUUID();
    await createJobWithUpdateReservation(env.DB, {
      id: jobId, telegramUpdateId: updateId, telegramUserId: userId, telegramChatId: chatId,
      requestMessageId: prompt.request_message_id, sourceHost: prompt.source_host, sourceKind: prompt.source_kind,
      sourceUrlHash: prompt.source_url_hash, sourceUrlEncrypted: prompt.source_url_encrypted,
      requestedMode: "video", requestedOperation: "download", requestedQuality: `max-${Math.min(quality.height, prompt.maximum_height)}p`,
      requestedStartSeconds: prompt.trim_start_seconds, requestedEndSeconds: prompt.trim_end_seconds,
      requestedClipRanges: storedClipRanges(prompt.requested_clip_ranges),
      createdAt: now.toISOString(),
    }, {
      maxActiveJobs: config.maxActiveJobs, maxActiveTranscriptions: config.maxActiveTranscriptions,
      maxJobsPerHour: config.maxJobsPerHour,
      hourlyWindowStart: new Date(now.getTime() - 3_600_000).toISOString(),
    }, selection);
    return reply("Video request queued.", { accepted: true, jobId }, true, jobId);
  } catch (error) {
    if (error instanceof QueueLimitError || error instanceof HourlyJobLimitError || error instanceof ActiveJobLimitError) {
      return reply(error instanceof QueueLimitError
        ? "You already have 5 unfinished jobs. Try this choice again after one finishes."
        : "Your request limit is reached. Try this choice again later.", { accepted: false, error: "SOURCE_RATE_LIMITED" });
    }
    try {
      if (await getProcessedUpdate(env.DB, updateId)) return reply("This choice was already handled.", { duplicate: true });
    } catch { /* Return a retryable failure if the database is unavailable. */ }
    if (error instanceof QualityPromptUnavailableError) {
      return reply("This choice is unavailable. Send /video again.", { accepted: false });
    }
    return jsonResponse({ ok: false, error: "INTERNAL_ERROR" }, 500);
  }
}

export function telegramErrorCode(error: unknown): ErrorCode {
  return error instanceof TelegramApiError ? telegramErrorToApplicationError(error).code : "INTERNAL_ERROR";
}

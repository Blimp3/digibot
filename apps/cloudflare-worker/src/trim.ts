export const MAX_TRIM_SECONDS = 86_400;

export interface TrimRange {
  startSeconds: number;
  endSeconds: number;
}

export type TrimParseErrorCode = "syntax" | "value" | "range";

export type TrimParseResult =
  | { ok: true; range: TrimRange }
  | { ok: false; code: TrimParseErrorCode; message: string };

export const TRIM_TIMING_HELP =
  "Timing: use ‘first <duration>’, ‘from <timestamp> for <duration>’, or ‘from <timestamp> to <timestamp>’. Use positive whole seconds, minutes, hours, or MM:SS/HH:MM:SS timestamps up to 24 hours; MM:SS means minutes:seconds.";

function failure(code: TrimParseErrorCode, message: string): TrimParseResult {
  return { ok: false, code, message: `${message} ${TRIM_TIMING_HELP}` };
}

function parseTimestamp(value: string): number | null {
  let match = /^(\d+):(\d{2})$/u.exec(value);
  if (match) {
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    if (!Number.isSafeInteger(minutes) || seconds >= 60) return null;
    const total = minutes * 60 + seconds;
    return Number.isSafeInteger(total) && total <= MAX_TRIM_SECONDS ? total : null;
  }
  match = /^(\d+):(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (!Number.isSafeInteger(hours) || minutes >= 60 || seconds >= 60) return null;
  const total = hours * 3600 + minutes * 60 + seconds;
  return Number.isSafeInteger(total) && total <= MAX_TRIM_SECONDS ? total : null;
}

function parseDuration(tokens: readonly string[]): { seconds: number } | { code: TrimParseErrorCode; message: string } {
  if (tokens.length === 1) {
    const timestamp = parseTimestamp(tokens[0] ?? "");
    if (timestamp !== null) {
      return timestamp > 0
        ? { seconds: timestamp }
        : { code: "value", message: "The duration must be positive." };
    }
    return { code: "syntax", message: "A duration needs a unit or a valid timestamp." };
  }
  if (tokens.length !== 2) return { code: "syntax", message: "The duration must be one value." };
  const amountText = tokens[0] ?? "";
  const unit = (tokens[1] ?? "").toLowerCase();
  if (!/^\d+$/u.test(amountText)) return { code: "value", message: "Durations must use positive whole numbers." };
  const amount = Number(amountText);
  if (!Number.isSafeInteger(amount) || amount <= 0) return { code: "value", message: "The duration must be positive." };
  const multiplier = unit === "second" || unit === "seconds"
    ? 1
    : unit === "minute" || unit === "minutes"
      ? 60
      : unit === "hour" || unit === "hours"
        ? 3600
        : null;
  if (multiplier === null) return { code: "syntax", message: "Use seconds, minutes, or hours for a duration." };
  const seconds = amount * multiplier;
  if (!Number.isSafeInteger(seconds) || seconds > MAX_TRIM_SECONDS) {
    return { code: "range", message: "Timing values must be no more than 24 hours." };
  }
  return { seconds };
}

function resultForRange(startSeconds: number, endSeconds: number): TrimParseResult {
  if (!isValidTrimRange(startSeconds, endSeconds)) {
    return failure("range", "The trim must start before it ends and stay within 24 hours.");
  }
  return { ok: true, range: { startSeconds, endSeconds } };
}

/** Parse the bounded timing phrases accepted after a media URL. */
export function parseTrimTiming(input: string | readonly string[]): TrimParseResult {
  const tokens = (typeof input === "string" ? input.trim().split(/\s+/u) : [...input]).filter(Boolean);
  const phrase = tokens[0]?.toLowerCase();
  if (phrase === "first") {
    const duration = parseDuration(tokens.slice(1));
    return "seconds" in duration
      ? resultForRange(0, duration.seconds)
      : failure(duration.code, duration.message);
  }
  if (phrase !== "from") return failure("syntax", "Timing must start with ‘first’ or ‘from’.");
  if (tokens.length < 4) return failure("syntax", "The timing phrase is incomplete.");
  const startSeconds = parseTimestamp(tokens[1] ?? "");
  if (startSeconds === null) return failure("value", "The start must be a MM:SS or HH:MM:SS timestamp within 24 hours.");
  const relation = tokens[2]?.toLowerCase();
  if (relation === "for") {
    const duration = parseDuration(tokens.slice(3));
    return "seconds" in duration
      ? resultForRange(startSeconds, startSeconds + duration.seconds)
      : failure(duration.code, duration.message);
  }
  if (relation === "to") {
    if (tokens.length !== 4) return failure("syntax", "A ‘to’ timing phrase needs one end timestamp.");
    const endSeconds = parseTimestamp(tokens[3] ?? "");
    return endSeconds === null
      ? failure("value", "The end must be a MM:SS or HH:MM:SS timestamp within 24 hours.")
      : resultForRange(startSeconds, endSeconds);
  }
  return failure("syntax", "Use ‘for’ with a duration or ‘to’ with an end timestamp.");
}

export function isValidTrimSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TRIM_SECONDS;
}

export function isValidTrimRange(startSeconds: unknown, endSeconds: unknown): startSeconds is number {
  return isValidTrimSeconds(startSeconds) && isValidTrimSeconds(endSeconds) && startSeconds < endSeconds;
}

export function formatTrimTimestamp(seconds: number): string {
  if (!isValidTrimSeconds(seconds)) throw new RangeError("Invalid trim timestamp");
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

export function formatTrimDuration(seconds: number): string {
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > MAX_TRIM_SECONDS) throw new RangeError("Invalid trim duration");
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

export function formatTrimRequest(range: TrimRange): string {
  if (!isValidTrimRange(range.startSeconds, range.endSeconds)) throw new RangeError("Invalid trim range");
  return `from ${formatTrimTimestamp(range.startSeconds)} to ${formatTrimTimestamp(range.endSeconds)} (${formatTrimDuration(range.endSeconds - range.startSeconds)}; end stops at media end if shorter)`;
}

/** Validate ordered clip ranges without sorting or silently merging overlaps. */
export function validateClipRanges(value: unknown): TrimRange[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) throw new RangeError("Choose 2–3 clip ranges separated by semicolons.");
  const ranges: TrimRange[] = [];
  const seen = new Set<string>();
  let duration = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).sort().join() !== "endSeconds,startSeconds") throw new RangeError("Each clip needs one start and end timestamp.");
    const { startSeconds, endSeconds } = entry as Record<string, unknown>;
    if (!isValidTrimRange(startSeconds, endSeconds)) throw new RangeError("Clip timing must be a positive range within 24 hours.");
    const length = (endSeconds as number) - startSeconds;
    if (length > 120) throw new RangeError("Each clip can be up to 120 seconds.");
    const key = `${startSeconds}:${endSeconds}`;
    if (seen.has(key)) throw new RangeError("Choose distinct clip ranges; exact duplicates are not allowed.");
    seen.add(key);
    duration += length;
    ranges.push({ startSeconds, endSeconds: endSeconds as number });
  }
  if (duration > 300) throw new RangeError("The clip pack can total up to 300 seconds.");
  return ranges;
}

export function parseClipRanges(text: string): TrimRange[] {
  if (text.length > 1024) throw new RangeError("Choose 2–3 short timing phrases separated by semicolons.");
  const phrases = text.split(";");
  if (phrases.length < 2 || phrases.length > 3) throw new RangeError("Choose 2–3 clip ranges separated by semicolons.");
  return validateClipRanges(phrases.map((phrase) => {
    const result = parseTrimTiming(phrase);
    if (!result.ok) throw new RangeError(result.message);
    return result.range;
  }));
}

export function storedClipRanges(value: string | null | undefined): TrimRange[] | null {
  if (value == null) return null;
  if (value.length > 1024) throw new RangeError("Invalid stored clip ranges.");
  return validateClipRanges(JSON.parse(value) as unknown);
}

/** -1 keeps malformed durable requests distinct from ordinary single media. */
export function clipCountForJob(job: { requested_clip_ranges?: string | null }): number {
  try { return storedClipRanges(job.requested_clip_ranges)?.length ?? 0; }
  catch { return -1; }
}

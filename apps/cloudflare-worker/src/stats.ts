import { confirmedDeliveryMessageIds, listActivityJobsForUser } from "./db";
import { clipCountForJob } from "./trim";
import { sourceForValidatedUrl } from "./sources";
import type { ActivityJobRecord, ActivityPeriod, ActivityTask, ActivityOutcome, ActivityWindow, D1DatabaseLike, JobHistoryCursor } from "./types";
export type { ActivityPeriod, ActivityTask, ActivityOutcome } from "./types";

export const STATS_SOURCE_LABELS = [
  "YouTube",
  "YouTube Music",
  "Instagram",
  "TikTok",
  "X/Twitter",
  "Vimeo",
  "Reddit",
  "Pinterest",
  "TED",
  "Other/Unknown",
] as const;

export type StatsSourceLabel = (typeof STATS_SOURCE_LABELS)[number];

export interface StatsBreakdownItem<TLabel extends string = string> {
  label: TLabel;
  count: number;
}

function normalizedHostname(sourceHost: string | null | undefined): string {
  return typeof sourceHost === "string" ? sourceHost.trim().toLowerCase().replace(/\.$/u, "") : "";
}

/**
 * Classify only the stored source host. Instagram is intentionally not
 * labelled as Reel: terminal jobs no longer retain the original URL path,
 * and the existing schema has no durable subtype field.
 */
export function statsSourceLabelForHost(sourceHost: string | null | undefined): StatsSourceLabel {
  const displayName = sourceForValidatedUrl({ hostname: normalizedHostname(sourceHost) })?.displayName;
  return STATS_SOURCE_LABELS.find((label) => label === displayName) ?? "Other/Unknown";
}

function orderedBreakdown<TLabel extends string>(
  counts: ReadonlyMap<TLabel, number>,
  preferredOrder: readonly TLabel[],
): StatsBreakdownItem<TLabel>[] {
  const order = new Map(preferredOrder.map((label, index) => [label, index]));
  return [...counts.entries()]
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => {
      const leftOrder = order.get(left) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = order.get(right) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.localeCompare(right);
    })
    .map(([label, count]) => ({ label, count }));
}

export const ACTIVITY_TASK_LABELS: Record<ActivityTask, string> = {
  video: "Video", audio: "Audio", image: "Image", other: "Other media",
  whisper: "Whisper", captions: "Source captions", clips: "Clip pack",
};

export function parseActivityPeriod(value?: string | null): ActivityPeriod | null {
  if (value == null || value === "") return "7d";
  return value === "24h" || value === "7d" || value === "30d" || value === "all" ? value : null;
}

export function parseActivityTask(value?: string | null): ActivityTask | null | undefined {
  if (value == null || value === "" || value === "all") return null;
  return Object.hasOwn(ACTIVITY_TASK_LABELS, value) ? value as ActivityTask : undefined;
}

export function activityWindow(options: { period?: ActivityPeriod; asOf?: string; task?: ActivityTask | null } = {}, now = new Date()): ActivityWindow {
  const period = options.period ?? "7d";
  const asOf = options.asOf ?? now.toISOString();
  const timestamp = Date.parse(asOf);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== asOf || timestamp > now.getTime()
    || parseActivityPeriod(period) !== period || parseActivityTask(options.task) === undefined) throw new RangeError("Invalid activity window");
  return { period, asOf, since: period === "all" ? null : new Date(timestamp - ({ "24h": 1, "7d": 7, "30d": 30 }[period] * 86400_000)).toISOString(), task: options.task ?? null };
}

export function activityTaskForJob(job: ActivityJobRecord): ActivityTask {
  if (job.requested_clip_ranges != null) return "clips";
  if (job.requested_operation === "transcript") return job.transcript_method === "captions" ? "captions" : "whisper";
  const mime = job.output_mime_type?.trim().toLowerCase();
  if (!mime) return job.requested_mode;
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("image/")) return "image";
  return "other";
}

export function activityOutcomeForJob(job: ActivityJobRecord): ActivityOutcome {
  if (!job.delivery_state || job.delivery_state === "unknown" || clipCountForJob(job) < 0) return "needs_review";
  if (job.delivery_state === "confirmed") {
    if (job.delivery_method !== "telegram" && job.delivery_method !== "telegram_url" && job.delivery_method !== "r2") return "needs_review";
    return confirmedDeliveryMessageIds({ state: job.delivery_state, method: job.delivery_method ?? null,
      telegram_message_id: job.telegram_message_id ?? null, telegram_message_ids: job.telegram_message_ids }, job) !== null ? "confirmed" : "needs_review";
  }
  if (job.status === "completed" || (job.status === "failed" && job.delivery_state === "sending")) return "needs_review";
  return job.status === "failed" ? "failed" : "unfinished";
}

export function activitySourceForJob(job: ActivityJobRecord): string {
  return job.source_kind === "telegram_file" ? "Telegram file" : statsSourceLabelForHost(job.source_host);
}

export interface UserActivityStats extends ActivityWindow {
  accepted: number;
  confirmed: number;
  failed: number;
  unfinished: number;
  needsReview: number;
  byTask: { task: ActivityTask; label: string; count: number }[];
  bySource: StatsBreakdownItem[];
  deliveredClips: number;
}

/** Counts retained accepted jobs; breakdowns count confirmed jobs only. */
export async function getUserActivityStats(db: D1DatabaseLike, userId: string, options: { period?: ActivityPeriod; asOf?: string; task?: ActivityTask | null } = {}): Promise<UserActivityStats> {
  const window = activityWindow(options);
  const stats: UserActivityStats = { ...window, accepted: 0, confirmed: 0, failed: 0, unfinished: 0, needsReview: 0, byTask: [], bySource: [], deliveredClips: 0 };
  const tasks = new Map<ActivityTask, number>();
  const sources = new Map<string, number>();
  let cursor: JobHistoryCursor | undefined;
  // Known limit: O(retained jobs), bounded pages; outcomes are not a transactional snapshot.
  // Add a validated durable summary only if history scale requires it. Errors must reject, never return partial totals.
  for (;;) {
    const rows = await listActivityJobsForUser(db, userId, window, cursor);
    for (const job of rows) {
      stats.accepted++;
      const outcome = activityOutcomeForJob(job);
      if (outcome === "needs_review") stats.needsReview++;
      else stats[outcome]++;
      if (outcome !== "confirmed") continue;
      const task = activityTaskForJob(job);
      tasks.set(task, (tasks.get(task) ?? 0) + 1);
      const source = activitySourceForJob(job);
      sources.set(source, (sources.get(source) ?? 0) + 1);
      stats.deliveredClips += Math.max(0, clipCountForJob(job));
    }
    if (rows.length < 100) break;
    const last = rows.at(-1)!;
    cursor = { createdAt: last.created_at, jobId: last.id };
  }
  stats.byTask = (Object.keys(ACTIVITY_TASK_LABELS) as ActivityTask[]).filter((task) => tasks.has(task))
    .map((task) => ({ task, label: ACTIVITY_TASK_LABELS[task], count: tasks.get(task)! }));
  stats.bySource = orderedBreakdown(sources, [...STATS_SOURCE_LABELS, "Telegram file"]);
  return stats;
}

export function formatUserActivityStats(stats: UserActivityStats): string {
  const period = stats.period === "all" ? "All retained history" : `Last ${stats.period}`;
  const lines = [`${period} · jobs accepted`, `As of: ${stats.asOf.slice(0, 19).replace("T", " ")} UTC`, `Accepted: ${stats.accepted}`, `Confirmed: ${stats.confirmed} · Failed: ${stats.failed}`,
    `Unfinished: ${stats.unfinished} · Needs review: ${stats.needsReview}`];
  if (stats.byTask.length) lines.push("", "Confirmed jobs by task:", ...stats.byTask.map((item) => `• ${item.label}: ${item.count}`));
  if (stats.bySource.length) lines.push("", "Confirmed jobs by source:", ...stats.bySource.map((item) => `• ${item.label}: ${item.count}`));
  if (stats.deliveredClips) lines.push(`Clips delivered in confirmed packs: ${stats.deliveredClips}`);
  lines.push("", "Current recorded outcomes. Counts are jobs; a clip pack is one job. Deleted history is excluded.");
  return lines.join("\n");
}

export async function getLatestUserActivity(db: D1DatabaseLike, userId: string, limit = 5) {
  const jobs = await listActivityJobsForUser(db, userId, activityWindow({ period: "all" }), undefined, Math.max(1, Math.min(5, Math.trunc(limit) || 5)));
  return jobs.map((job) => {
    const task = activityTaskForJob(job);
    const outcome = activityOutcomeForJob(job);
    return { createdAt: job.created_at, task, label: ACTIVITY_TASK_LABELS[task], source: activitySourceForJob(job), outcome,
      clipCount: outcome === "confirmed" ? Math.max(0, clipCountForJob(job)) : 0 };
  });
}

export function formatLatestUserActivity(rows: Awaited<ReturnType<typeof getLatestUserActivity>>): string {
  if (!rows.length) return "No retained activity yet. Deleted history is excluded.";
  const labels: Record<ActivityOutcome, string> = { confirmed: "Confirmed", failed: "Failed", unfinished: "Unfinished", needs_review: "Needs review" };
  return ["Latest accepted jobs (UTC)", ...rows.map((row) => {
    const date = new Date(row.createdAt);
    const when = Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 16).replace("T", " ") : "Time unavailable";
    return `${when} · ${row.label}${row.clipCount ? ` (${row.clipCount} clips)` : ""} · ${row.source} · ${labels[row.outcome]}`;
  }), "", "Current recorded outcomes. Deleted history is excluded."].join("\n");
}

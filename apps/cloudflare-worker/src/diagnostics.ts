import { apiError } from "./history";
import { validateR2ObjectKey } from "./r2";
import { DELIVERY_STATES, DISPATCH_INTENT_STATES, type Env } from "./types";

const validCursor = (value: string) => value.length > 0 && value.length <= 2048 && !/[^\x21-\x7e]/u.test(value);
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
function states(rows: Record<string, unknown>[], allowed: readonly string[]) {
  return rows.filter((row) => typeof row.state === "string" && allowed.includes(row.state)).map((row) => ({
    state: row.state, count: count(row.count), ...(Object.hasOwn(row, "oldest_created_at") ? { oldestCreatedAt: timestamp(row.oldest_created_at) } : {}),
  }));
}
function laneCounts(rows: Record<string, unknown>[]) {
  return rows.filter((row) => row.lane === "source" || row.lane === "transcript").map((row) => ({
    lane: row.lane, count: count(row.count),
  }));
}

/** Called only after the existing downloader-owner Telegram authentication. */
export async function handleDiagnostics(request: Request, env: Env): Promise<Response> {
  const cursor = new URL(request.url).searchParams.get("cursor");
  if (cursor !== null && !validCursor(cursor)) return apiError(400, "INVALID_CURSOR", "Invalid inspection cursor.");
  try {
    const summaries = await env.DB.batch<Record<string, unknown>>([
      env.DB.prepare("SELECT state, COUNT(*) AS count, MIN(created_at) AS oldest_created_at FROM job_dispatch_intents GROUP BY state"),
      env.DB.prepare("SELECT state, COUNT(*) AS count FROM job_deliveries GROUP BY state"),
      env.DB.prepare("SELECT state, COUNT(*) AS count FROM telegram_notices GROUP BY state"),
      env.DB.prepare(`SELECT COUNT(*) AS confirmed_unreconciled FROM job_deliveries d JOIN jobs j ON j.id = d.job_id
        WHERE d.state = 'confirmed' AND j.status <> 'completed'`),
      env.DB.prepare("SELECT COUNT(*) AS count, MIN(created_at) AS oldest_created_at FROM active_job_admissions"),
      env.DB.prepare("SELECT lane, COUNT(*) AS count FROM active_job_admissions GROUP BY lane"),
      env.DB.prepare(`SELECT CASE WHEN j.requested_operation = 'transcript'
          AND COALESCE(j.transcript_method, 'whisper') <> 'captions'
        THEN 'transcript' ELSE 'source' END AS lane, COUNT(*) AS count
        FROM jobs j
        JOIN job_dispatch_intents dispatch ON dispatch.job_id = j.id
        JOIN job_deliveries delivery ON delivery.job_id = j.id
        WHERE j.status NOT IN ('completed', 'failed')
          AND dispatch.state = 'pending'
          AND delivery.state = 'not_started'
          AND NOT EXISTS (
            SELECT 1 FROM active_job_admissions admission
            WHERE admission.job_id = j.id
          )
        GROUP BY lane`),
    ]);
    // Known limit: one 100-object page per request; use the returned opaque cursor
    // for larger buckets. Inspection never deletes candidate objects.
    const page = await env.MEDIA_BUCKET.list({ prefix: "jobs/", limit: 100, ...(cursor ? { cursor } : {}) });
    if (page.truncated && !validCursor(page.cursor)) throw new Error("Invalid storage cursor");
    const objects = page.objects.slice(0, 100);
    const references = objects.length ? await env.DB.batch(objects.map((object) => env.DB.prepare(`SELECT 1 AS present FROM jobs
      WHERE r2_object_key = ?1 OR (id = ?2 AND status NOT IN ('completed', 'failed'))
      UNION ALL SELECT 1 AS present FROM job_deliveries WHERE object_key = ?1 LIMIT 1`)
      .bind(object.key, object.key.split("/")[1] ?? ""))) : [];
    const orphanCandidates = objects.filter((object, index) => {
      const jobId = object.key.split("/")[1] ?? "";
      return validateR2ObjectKey(object.key, jobId) && references[index]?.results.length === 0;
    }).length;
    return new Response(JSON.stringify({
      dispatch: states(summaries[0]!.results, DISPATCH_INTENT_STATES), delivery: states(summaries[1]!.results, DELIVERY_STATES),
      notices: states(summaries[2]!.results, ["pending", "sending", "sent", "rejected", "unknown"]),
      confirmedUnreconciled: count(summaries[3]!.results[0]?.confirmed_unreconciled),
      admissions: {
        count: count(summaries[4]!.results[0]?.count),
        oldestCreatedAt: timestamp(summaries[4]!.results[0]?.oldest_created_at),
        lanes: laneCounts(summaries[5]?.results ?? []),
      },
      waitingByLane: laneCounts(summaries[6]?.results ?? []),
      r2: {
        capability: env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY ? "configured-unverified" : "disabled",
        verificationEvidence: "A separately approved E2E release record is required for verified status.",
        scanned: objects.length, orphanCandidates,
        nextCursor: page.truncated ? page.cursor : null,
      },
    }), { headers: { "content-type": "application/json", "cache-control": "private, no-store", vary: "Authorization" } });
  } catch {
    return apiError(503, "DIAGNOSTICS_UNAVAILABLE", "Operator inspection is temporarily unavailable.");
  }
}

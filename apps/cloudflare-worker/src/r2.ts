import { clearExpiredJobR2ObjectKey, deleteExpiredJobs, deleteOldProcessedUpdates } from "./db";
import { safeContentDisposition, sanitizeFilename, verifyDownloadToken } from "./security";
import type { Env } from "./types";

export async function handleDownloadRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
  const token = new URL(request.url).pathname.split("/").pop() ?? "";
  if (!token || !env.DOWNLOAD_LINK_HMAC_SECRET) return new Response("Not Found", { status: 404 });
  const payload = await verifyDownloadToken(env.DOWNLOAD_LINK_HMAC_SECRET, token);
  if (!payload) return new Response("Not Found", { status: 404 });
  const bucket = env.MEDIA_BUCKET;
  if (!bucket) return new Response("Storage unavailable", { status: 503 });
  const rangeHeader = request.method === "GET" ? request.headers.get("range") : null;
  const metadata = request.method === "HEAD" || rangeHeader !== null ? await bucket.head(payload.objectKey) : null;
  if ((request.method === "HEAD" || rangeHeader !== null) && !metadata) return new Response("Not Found", { status: 404 });
  const range = rangeHeader !== null && metadata ? singleRange(rangeHeader, metadata.size) : null;
  if (rangeHeader !== null && !range) return new Response(null, {
    status: 416,
    headers: { "content-range": `bytes */${metadata!.size}`, "accept-ranges": "bytes", "cache-control": "private, no-store" },
  });
  const object = request.method === "HEAD" ? metadata : await bucket.get(payload.objectKey, range ? {
    range,
    onlyIf: { etagMatches: metadata!.etag },
  } : undefined);
  if (!object) return new Response("Not Found", { status: 404 });
  if (request.method === "GET" && !("body" in object)) return new Response(null, { status: 412, headers: { "cache-control": "private, no-store" } });

  const headers = new Headers({
    "cache-control": "private, no-store",
    "content-type": object.httpMetadata?.contentType ?? payload.mimeType,
    "content-disposition": safeContentDisposition(payload.filename),
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
  });
  const length = range?.length ?? object.size;
  if (typeof length === "number" && Number.isSafeInteger(length) && length >= 0) headers.set("content-length", String(length));
  if (range) headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
  return new Response(request.method === "HEAD" ? null : (object as R2ObjectBody).body, { status: range ? 206 : 200, headers });
}

/** Multiple ranges are deliberately rejected; objects stay streamed. */
function singleRange(header: string, size: number): { offset: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header);
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(size) || size <= 0) return null;
  const start = match[1] ? Number(match[1]) : null;
  const end = match[2] ? Number(match[2]) : null;
  if ((start !== null && !Number.isSafeInteger(start)) || (end !== null && !Number.isSafeInteger(end))) return null;
  if (start === null) return end && end > 0 ? { offset: Math.max(0, size - end), length: Math.min(size, end) } : null;
  if (start >= size || (end !== null && end < start)) return null;
  return { offset: start, length: Math.min(end ?? size - 1, size - 1) - start + 1 };
}

export async function cleanupExpiredR2Jobs(env: Env, now = new Date()): Promise<number> {
  const nowIso = now.toISOString();
  const rows = await deleteExpiredJobs(env.DB, nowIso);
  let deleted = 0;
  for (const job of rows) {
    const objectKey = job.r2_object_key;
    // Never turn a database value into an arbitrary bucket key. A malformed
    // row is retained for diagnosis and does not cause an unbounded delete.
    if (!objectKey || !env.MEDIA_BUCKET || !validateR2ObjectKey(objectKey, job.id)) continue;
    try {
      await env.MEDIA_BUCKET.delete(objectKey);
    } catch {
      // Keep both the row and key so a later scheduled run retries cleanup.
      continue;
    }
    // Delete the object before clearing its database pointer. If this write
    // fails, the next run safely repeats an idempotent R2 delete and retries
    // the conditional clear; the history row is never removed.
    if (await clearExpiredJobR2ObjectKey(env.DB, job.id, objectKey, nowIso)) deleted += 1;
  }
  await deleteOldProcessedUpdates(env.DB, new Date(now.getTime() - 7 * 86400 * 1000).toISOString());
  return deleted;
}

export function r2RetentionExpiry(now: Date, retentionSeconds: number): string {
  return new Date(now.getTime() + retentionSeconds * 1000).toISOString();
}

export function validateR2ObjectKey(value: string, jobId: string): boolean {
  return value === `jobs/${jobId}/${sanitizeFilename(value.split("/").pop() ?? "media.bin")}`;
}

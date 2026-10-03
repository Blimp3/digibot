import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getLatestCompletedJobForMedia } from "../src/db";
import type { D1BatchDatabaseLike } from "../src/types";
import { localD1 } from "./helpers/local-d1";

let db: D1BatchDatabaseLike;
let dispose: () => Promise<void>;

const CREATED_AT = "2026-08-20T00:00:00.000Z";

interface CacheRow {
  id: string;
  updateId: string;
  userId: string;
  chatId: string;
  quality: string | null;
  startSeconds?: number | null;
  endSeconds?: number | null;
  policy: string;
  cacheValid: number;
  operation?: "download" | "transcript";
}

const rows: CacheRow[] = [
  { id: "123e4567-e89b-42d3-a456-000000000201", updateId: "cache-201", userId: "u1", chatId: "c1", quality: "max-1080p", policy: "v1", cacheValid: 1 },
  { id: "123e4567-e89b-42d3-a456-000000000202", updateId: "cache-202", userId: "u1", chatId: "c1", quality: "720p", policy: "v1", cacheValid: 1 },
  { id: "123e4567-e89b-42d3-a456-000000000203", updateId: "cache-203", userId: "u1", chatId: "c1", quality: null, policy: "v1", cacheValid: 1 },
  { id: "123e4567-e89b-42d3-a456-000000000204", updateId: "cache-204", userId: "u1", chatId: "c1", quality: "max-1080p", policy: "v2", cacheValid: 1 },
  { id: "123e4567-e89b-42d3-a456-000000000205", updateId: "cache-205", userId: "u2", chatId: "c1", quality: "max-1080p", policy: "v1", cacheValid: 1 },
  { id: "123e4567-e89b-42d3-a456-000000000206", updateId: "cache-206", userId: "u1", chatId: "c2", quality: "max-1080p", policy: "v1", cacheValid: 1 },
  { id: "123e4567-e89b-42d3-a456-000000000207", updateId: "cache-207", userId: "u1", chatId: "c1", quality: "max-1080p", policy: "v1", cacheValid: 0 },
];

async function insertRow(row: CacheRow): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO processed_updates (telegram_update_id, job_id, created_at) VALUES (?1, ?2, ?3)").bind(row.updateId, row.id, CREATED_AT),
    db.prepare(
      `INSERT INTO jobs (
        id, telegram_update_id, telegram_user_id, telegram_chat_id,
        source_host, source_url_hash, source_url_encrypted, requested_mode,
        requested_quality, requested_operation, requested_start_seconds, requested_end_seconds,
        status, progress, result_message_id,
        output_filename, output_mime_type, output_size_bytes,
        processing_policy_version, cache_valid, created_at, updated_at, completed_at
      ) VALUES (?1, ?2, ?3, ?4, 'youtu.be', 'same-hash', 'encrypted', 'video',
        ?5, ?6, ?7, ?8, 'completed', 100, '42', 'video.mp4', 'video/mp4', 100,
        ?9, ?10, ?11, ?11, ?11)`,
    ).bind(row.id, row.updateId, row.userId, row.chatId, row.quality, row.operation ?? "download", row.startSeconds ?? null, row.endSeconds ?? null, row.policy, row.cacheValid, CREATED_AT),
  ]);
}

describe("reusable media cache scope on local workerd D1", () => {
  beforeAll(async () => {
    ({ db, dispose } = await localD1());
    for (const row of rows) await insertRow(row);
  }, 30_000);

  afterAll(async () => { await dispose?.(); });

  it("uses the scoped index for the real cache query without a sorting scan", async () => {
    let query = "";
    const recordingDb = { prepare(sql: string) { query = sql; return db.prepare(sql); } };
    const result = await getLatestCompletedJobForMedia(recordingDb, "u1", "c1", "same-hash", "video", "max-1080p", "v1");
    expect(result?.id).toBe(rows[0]?.id);
    const plan = await db.prepare(`EXPLAIN QUERY PLAN ${query}`)
      .bind("u1", "c1", "same-hash", "video", "max-1080p", "v1", null, null).all<{ detail: string }>();
    expect(plan.results?.map((row) => row.detail).join("\n")).toContain("idx_jobs_reusable_media");
    expect(plan.results?.map((row) => row.detail).join("\n")).not.toContain("TEMP B-TREE");
  });

  it("requires exact user, chat, quality, policy, and a valid cache row", async () => {
    const result = await getLatestCompletedJobForMedia(db, "u1", "c1", "same-hash", "video", "max-1080p", "v1");
    expect(result?.id).toBe(rows[0]?.id);
    await expect(getLatestCompletedJobForMedia(db, "u1", "c1", "same-hash", "video", "720p", "v1")).resolves.toMatchObject({ id: rows[1]?.id });
    await expect(getLatestCompletedJobForMedia(db, "u1", "c1", "same-hash", "video", null, "v1")).resolves.toMatchObject({ id: rows[2]?.id });
    await expect(getLatestCompletedJobForMedia(db, "u1", "c1", "same-hash", "video", "max-1080p", "v2")).resolves.toMatchObject({ id: rows[3]?.id });
    await expect(getLatestCompletedJobForMedia(db, "u2", "c1", "same-hash", "video", "max-1080p", "v1")).resolves.toMatchObject({ id: rows[4]?.id });
    await expect(getLatestCompletedJobForMedia(db, "u1", "c2", "same-hash", "video", "max-1080p", "v1")).resolves.toMatchObject({ id: rows[5]?.id });
    await db.prepare("UPDATE jobs SET cache_valid = 0 WHERE id = ?1").bind(rows[0]?.id).run();
    await expect(getLatestCompletedJobForMedia(db, "u1", "c1", "same-hash", "video", "max-1080p", "v1")).resolves.toBeNull();
  });

  it("never reuses a completed transcript as downloadable media", async () => {
    const transcript: CacheRow = {
      ...rows[0]!,
      id: "123e4567-e89b-42d3-a456-000000000212",
      updateId: "cache-212",
      operation: "transcript",
      policy: "transcript-only-test",
    };
    await insertRow(transcript);
    await expect(getLatestCompletedJobForMedia(db, "u1", "c1", "same-hash", "video", "max-1080p", transcript.policy)).resolves.toBeNull();
  });

  it("never offers a Telegram-upload result to the URL cache even if eligibility is mistakenly enabled", async () => {
    const uploaded = { ...rows[0]!, id: "123e4567-e89b-42d3-a456-000000000213", updateId: "cache-213", policy: "telegram-file-test" };
    await insertRow(uploaded);
    await db.prepare("UPDATE jobs SET source_kind = 'telegram_file', cache_valid = 1 WHERE id = ?1").bind(uploaded.id).run();
    await expect(getLatestCompletedJobForMedia(db, "u1", "c1", "same-hash", "video", "max-1080p", uploaded.policy)).resolves.toBeNull();
  });

  it("keeps M4A and MP3 audio cache entries separate through requested quality", async () => {
    const audioRows = [
      { ...rows[0]!, id: "123e4567-e89b-42d3-a456-000000000208", updateId: "cache-208", quality: "m4a" },
      { ...rows[0]!, id: "123e4567-e89b-42d3-a456-000000000209", updateId: "cache-209", quality: "mp3" },
    ];
    for (const row of audioRows) {
      await db.batch([
        db.prepare("INSERT INTO processed_updates (telegram_update_id, job_id, created_at) VALUES (?1, ?2, ?3)").bind(row.updateId, row.id, CREATED_AT),
        db.prepare(
          `INSERT INTO jobs (
            id, telegram_update_id, telegram_user_id, telegram_chat_id,
            source_host, source_url_hash, source_url_encrypted, requested_mode,
            requested_quality, status, progress, result_message_id,
            output_filename, output_mime_type, output_size_bytes,
            processing_policy_version, cache_valid, created_at, updated_at, completed_at
          ) VALUES (?1, ?2, ?3, ?4, 'youtube.com', 'audio-hash', 'encrypted', 'audio',
            ?5, 'completed', 100, ?6, ?7, ?8, 100, ?9, 1, ?10, ?10, ?10)`,
        ).bind(row.id, row.updateId, row.userId, row.chatId, row.quality, "42", `audio.${row.quality}`, row.quality === "m4a" ? "audio/mp4" : "audio/mpeg", row.policy, CREATED_AT),
      ]);
    }
    await expect(getLatestCompletedJobForMedia(db, "u1", "c1", "audio-hash", "audio", "m4a", "v1")).resolves.toMatchObject({ id: audioRows[0]!.id, requested_quality: "m4a" });
    await expect(getLatestCompletedJobForMedia(db, "u1", "c1", "audio-hash", "audio", "mp3", "v1")).resolves.toMatchObject({ id: audioRows[1]!.id, requested_quality: "mp3" });
  });

  it("keeps full and distinct trim ranges separate from one another", async () => {
    await db.prepare("UPDATE jobs SET cache_valid = 1 WHERE id = ?1").bind(rows[0]!.id).run();
    const trimRows = [
      { ...rows[0]!, id: "123e4567-e89b-42d3-a456-000000000210", updateId: "cache-210", startSeconds: 0, endSeconds: 300 },
      { ...rows[0]!, id: "123e4567-e89b-42d3-a456-000000000211", updateId: "cache-211", startSeconds: 720, endSeconds: 1020 },
    ];
    for (const row of trimRows) await insertRow(row);
    await expect(getLatestCompletedJobForMedia(db, "u1", "c1", "same-hash", "video", "max-1080p", "v1", null, null)).resolves.toMatchObject({ id: rows[0]!.id });
    await expect(getLatestCompletedJobForMedia(db, "u1", "c1", "same-hash", "video", "max-1080p", "v1", 0, 300)).resolves.toMatchObject({ id: trimRows[0]!.id });
    await expect(getLatestCompletedJobForMedia(db, "u1", "c1", "same-hash", "video", "max-1080p", "v1", 720, 1020)).resolves.toMatchObject({ id: trimRows[1]!.id });
    await expect(getLatestCompletedJobForMedia(db, "u1", "c1", "same-hash", "video", "max-1080p", "v1", 0, 301)).resolves.toBeNull();
  });

  it("enforces a nullable, safe trim pair in D1", async () => {
    await expect(db.prepare("UPDATE jobs SET requested_start_seconds = 1 WHERE id = ?1").bind(rows[1]!.id).run()).rejects.toThrow();
    await expect(db.prepare("UPDATE jobs SET requested_start_seconds = 0, requested_end_seconds = 86401 WHERE id = ?1").bind(rows[1]!.id).run()).rejects.toThrow();
  });
});

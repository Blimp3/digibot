import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { repairMissingDurableState } from "../src/db";
import { recoverAndReconcileDispatches } from "../src/dispatch";
import type { D1BatchDatabaseLike, Env } from "../src/types";
import { localD1 } from "./helpers/local-d1";

let db: D1BatchDatabaseLike;
let dispose: () => Promise<void>;

const CREATED_AT = "2026-08-20T00:00:00.000Z";
const HISTORICAL_NEWS_MIGRATIONS = readFileSync(new URL("fixtures/historical-news-migrations.sql", import.meta.url), "utf8");
const HISTORICAL_NEWS_SENTINEL = `INSERT INTO news_sources (
  id, display_name, canonical_url, status, created_at, updated_at
) VALUES ('historical-sentinel', 'Historical Sentinel',
  'https://example.com/historical-sentinel', 'enabled',
  '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z');`;

function legacySql(): string {
  const rows = [
    {
      id: "123e4567-e89b-42d3-a456-000000000101",
      updateId: "legacy-completed-valid",
      status: "completed",
      resultId: "321",
      filename: "video.mp4",
      mime: "video/mp4",
      size: "100",
    },
    {
      id: "123e4567-e89b-42d3-a456-000000000102",
      updateId: "legacy-completed-malformed",
      status: "completed",
      resultId: "0",
      filename: "video.mp4",
      mime: "video/mp4",
      size: "100",
    },
    {
      id: "123e4567-e89b-42d3-a456-000000000103",
      updateId: "legacy-uploading",
      status: "uploading",
      resultId: "NULL",
      filename: "NULL",
      mime: "NULL",
      size: "NULL",
    },
    {
      id: "123e4567-e89b-42d3-a456-000000000104",
      updateId: "legacy-received",
      status: "received",
      resultId: "NULL",
      filename: "NULL",
      mime: "NULL",
      size: "NULL",
    },
    {
      id: "123e4567-e89b-42d3-a456-000000000107",
      updateId: "legacy-completed-invalid-size",
      status: "completed",
      resultId: "654",
      filename: "video.mp4",
      mime: "video/mp4",
      size: "-1",
    },
  ];
  return rows.map((row) => [
    `INSERT INTO processed_updates (telegram_update_id, job_id, created_at) VALUES ('${row.updateId}', '${row.id}', '${CREATED_AT}');`,
    `INSERT INTO jobs (id, telegram_update_id, telegram_user_id, telegram_chat_id, request_message_id, source_host, source_url_hash, source_url_encrypted, requested_mode, requested_quality, status, progress, output_filename, output_mime_type, output_size_bytes, created_at, updated_at, result_message_id) VALUES ('${row.id}', '${row.updateId}', '12345', '12345', '7', 'youtu.be', 'hash-${row.id}', 'v1.encrypted', 'video', 'max-1080p', '${row.status}', 100, ${row.filename === "NULL" ? "NULL" : `'${row.filename}'`}, ${row.mime === "NULL" ? "NULL" : `'${row.mime}'`}, ${row.size}, '${CREATED_AT}', '${CREATED_AT}', ${row.resultId});`,
    ...(row.status === "completed" || row.status === "received" || row.status === "uploading"
      ? [`INSERT INTO active_job_admissions (job_id, created_at) VALUES ('${row.id}', '${CREATED_AT}');`]
      : []),
  ]).flat().join("\n");
}

describe("0008 legacy active state backfill", () => {
  beforeAll(async () => {
    ({ db, dispose } = await localD1([HISTORICAL_NEWS_MIGRATIONS, HISTORICAL_NEWS_SENTINEL, legacySql()]));
  }, 30_000);

  afterAll(async () => { await dispose?.(); });

  it("does not auto-start an old webhook job that may still be sending", async () => {
    await expect(db.prepare("SELECT display_name FROM news_sources WHERE id = 'historical-sentinel'").first()).resolves.toEqual({ display_name: "Historical Sentinel" });
    await expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'news_outbox'").first()).resolves.toEqual({ name: "news_outbox" });
    const rows = await db.prepare(
      "SELECT job_id, state, workflow_instance_id FROM job_dispatch_intents ORDER BY job_id",
    ).all<{ job_id: string; state: string; workflow_instance_id: string }>();
    expect(rows.results).toHaveLength(5);
    expect(rows.results.every((row) => row.state === "complete")).toBe(true);
    expect(rows.results.every((row) => row.workflow_instance_id === row.job_id)).toBe(true);

    const deliveries = await db.prepare(
      "SELECT job_id, state, telegram_message_id, size_bytes, unknown_reason FROM job_deliveries ORDER BY job_id",
    ).all<{ job_id: string; state: string; telegram_message_id: string | null; size_bytes: number | null; unknown_reason: string | null }>();
    expect(deliveries.results).toHaveLength(5);
    expect(deliveries.results[0]).toMatchObject({ state: "confirmed", telegram_message_id: "321" });
    expect(deliveries.results[1]).toMatchObject({ state: "unknown", telegram_message_id: null });
    expect(deliveries.results[1]).toMatchObject({ unknown_reason: "legacy_receipt_unvalidated" });
    expect(deliveries.results[2]).toMatchObject({ state: "unknown", unknown_reason: "legacy_active_before_durable_dispatch" });
    expect(deliveries.results[3]).toMatchObject({ state: "unknown", unknown_reason: "legacy_active_before_durable_dispatch" });
    expect(deliveries.results[4]).toMatchObject({ state: "confirmed", telegram_message_id: "654", size_bytes: null });
  });

  it("leaves an old job without durable rows untouched when only the minute recovery scan runs", async () => {
    const id = "123e4567-e89b-42d3-a456-000000000108";
    await db.batch([
      db.prepare("INSERT INTO processed_updates (telegram_update_id, job_id, created_at) VALUES (?1, ?2, ?3)").bind("legacy-recovery-only", id, CREATED_AT),
      db.prepare(
        `INSERT INTO jobs (
          id, telegram_update_id, telegram_user_id, telegram_chat_id,
          request_message_id, source_host, source_url_hash, source_url_encrypted,
          requested_mode, requested_quality, status, progress, created_at, updated_at
        ) VALUES (?1, ?2, '12345', '12345', '7', 'youtu.be', 'legacy-recovery-only',
          'v1.encrypted', 'video', 'max-1080p', 'failed', 0, ?3, ?3)`,
      ).bind(id, "legacy-recovery-only", CREATED_AT),
    ]);

    await recoverAndReconcileDispatches({ DB: db } as unknown as Env, new Date("2026-08-20T00:01:30.000Z"), 10);

    await expect(db.prepare("SELECT COUNT(*) AS count FROM job_dispatch_intents WHERE job_id = ?1").bind(id).first()).resolves.toEqual({ count: 0 });
    await expect(db.prepare("SELECT COUNT(*) AS count FROM job_deliveries WHERE job_id = ?1").bind(id).first()).resolves.toEqual({ count: 0 });
    await repairMissingDurableState(db, new Date("2026-08-20T00:01:45.000Z"), 10);
    await expect(db.prepare("SELECT COUNT(*) AS count FROM job_dispatch_intents WHERE job_id = ?1").bind(id).first()).resolves.toEqual({ count: 1 });
  });

  it("repairs an old job inserted after migration before recovery scans it", async () => {
    const id = "123e4567-e89b-42d3-a456-000000000105";
    await db.batch([
      db.prepare("INSERT INTO processed_updates (telegram_update_id, job_id, created_at) VALUES (?1, ?2, ?3)").bind("legacy-after-migration", id, CREATED_AT),
      db.prepare(
        `INSERT INTO jobs (
          id, telegram_update_id, telegram_user_id, telegram_chat_id,
          request_message_id, source_host, source_url_hash, source_url_encrypted,
          requested_mode, requested_quality, status, progress, created_at, updated_at
        ) VALUES (?1, ?2, '12345', '12345', '7', 'youtu.be', 'legacy-after',
          'v1.encrypted', 'video', 'max-1080p', 'received', 0, ?3, ?3)`,
      ).bind(id, "legacy-after-migration", CREATED_AT),
      db.prepare("INSERT INTO active_job_admissions (job_id, created_at) VALUES (?1, ?2)").bind(id, CREATED_AT),
    ]);

    await repairMissingDurableState(db, new Date("2026-08-20T00:01:00.000Z"), 10);
    await recoverAndReconcileDispatches({ DB: db } as unknown as Env, new Date("2026-08-20T00:01:00.000Z"), 10);

    await expect(db.prepare("SELECT state FROM job_dispatch_intents WHERE job_id = ?1").bind(id).first()).resolves.toEqual({ state: "complete" });
    await expect(db.prepare("SELECT state, unknown_reason FROM job_deliveries WHERE job_id = ?1").bind(id).first()).resolves.toEqual({
      state: "unknown",
      unknown_reason: "legacy_active_missing_durable_state",
    });
  });

  it("promotes only the fenced cutover marker when the old request later records a receipt", async () => {
    const id = "123e4567-e89b-42d3-a456-000000000106";
    await db.batch([
      db.prepare("INSERT INTO processed_updates (telegram_update_id, job_id, created_at) VALUES (?1, ?2, ?3)").bind("legacy-late-receipt", id, CREATED_AT),
      db.prepare(
        `INSERT INTO jobs (
          id, telegram_update_id, telegram_user_id, telegram_chat_id,
          request_message_id, source_host, source_url_hash, source_url_encrypted,
          requested_mode, requested_quality, status, progress, created_at, updated_at
        ) VALUES (?1, ?2, '12345', '12345', '7', 'youtu.be', 'legacy-late',
          'v1.encrypted', 'video', 'max-1080p', 'received', 0, ?3, ?3)`,
      ).bind(id, "legacy-late-receipt", CREATED_AT),
      db.prepare("INSERT INTO active_job_admissions (job_id, created_at) VALUES (?1, ?2)").bind(id, CREATED_AT),
    ]);

    await repairMissingDurableState(db, new Date("2026-08-20T00:02:00.000Z"), 10);
    await recoverAndReconcileDispatches({ DB: db } as unknown as Env, new Date("2026-08-20T00:02:00.000Z"), 10);
    await db.prepare(
      "UPDATE jobs SET status = 'completed', result_message_id = '987', output_filename = 'late.mp4', output_mime_type = 'video/mp4', output_size_bytes = 987, r2_object_key = NULL, expires_at = '2026-08-21T00:00:00.000Z' WHERE id = ?1",
    ).bind(id).run();

    await repairMissingDurableState(db, new Date("2026-08-20T00:03:00.000Z"), 10);
    await recoverAndReconcileDispatches({ DB: db } as unknown as Env, new Date("2026-08-20T00:03:00.000Z"), 10);

    await expect(db.prepare("SELECT state, telegram_message_id, filename, unknown_reason FROM job_deliveries WHERE job_id = ?1").bind(id).first()).resolves.toEqual({
      state: "confirmed",
      telegram_message_id: "987",
      filename: "late.mp4",
      unknown_reason: null,
    });
    await expect(db.prepare("SELECT state FROM job_dispatch_intents WHERE job_id = ?1").bind(id).first()).resolves.toEqual({ state: "complete" });
  });
});

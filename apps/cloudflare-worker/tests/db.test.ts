import { describe, expect, it } from "vitest";
import { localD1 } from "./helpers/local-d1";
import {
  HISTORY_LIST_COLUMNS,
  HISTORY_PAGE_MAX_LIMIT,
  TERMINAL_HISTORY_BATCH_MAX_LIMIT,
  createJobWithUpdateReservation,
  deleteTerminalJobForUser,
  getDispatchIntent,
  getJob,
  getJobDelivery,
  getJobDurableState,
  getJobByIdForUser,
  getLatestCompletedJobForMedia,
  listJobsForUser,
  listTerminalJobsForUser,
} from "../src/db";
import type { D1DatabaseLike, D1PreparedStatementLike, JobRecord } from "../src/types";

describe("media reuse lookup", () => {
  it("scopes reusable results to the exact user/chat/mode and excludes R2 links", async () => {
    let sql = "";
    let values: unknown[] = [];
    const statement: D1PreparedStatementLike = {
      bind: (...next) => {
        values = next;
        return statement;
      },
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ success: true }),
    };
    const db: D1DatabaseLike = {
      prepare: (query) => {
        sql = query;
        return statement;
      },
    };

    await getLatestCompletedJobForMedia(db, "12345", "12345", "hash", "video", "max-1080p", "v1");

    expect(values).toEqual(["12345", "12345", "hash", "video", "max-1080p", "v1", null, null]);
    expect(sql).toContain("telegram_user_id = ?1");
    expect(sql).toContain("telegram_chat_id = ?2");
    expect(sql).toContain("source_url_hash = ?3");
    expect(sql).toContain("requested_mode = ?4");
    expect(sql).toContain("requested_quality IS ?5");
    expect(sql).toContain("processing_policy_version = ?6");
    expect(sql).toContain("requested_start_seconds IS ?7");
    expect(sql).toContain("requested_end_seconds IS ?8");
    expect(sql).toContain("cache_valid = 1");
    expect(sql).toContain("status = 'completed'");
    expect(sql).toContain("r2_object_key IS NULL");
    expect(sql).toContain("output_mime_type LIKE 'video/%'");
  });
});

interface CapturedStatement {
  sql: string;
  values: unknown[];
}

function fakeDb(options: { rows?: JobRecord[]; first?: JobRecord | null; changes?: number } = {}): { db: D1DatabaseLike; calls: CapturedStatement[] } {
  const calls: CapturedStatement[] = [];
  const db: D1DatabaseLike = {
    prepare: (sql) => {
      const call: CapturedStatement = { sql, values: [] };
      calls.push(call);
      const statement: D1PreparedStatementLike = {
        bind: (...values) => {
          call.values = values;
          return statement;
        },
        first: async <T>() => (options.first as T | null | undefined) ?? null,
        all: async <T>() => ({ results: (options.rows ?? []) as T[] }),
        run: async () => ({ success: true, meta: { changes: options.changes ?? 0 } }),
      };
      return statement;
    },
  };
  return { db, calls };
}

function jobRow(id: string, createdAt: string): JobRecord {
  return { id, created_at: createdAt } as unknown as JobRecord;
}

describe("user-scoped history queries", () => {
  it("uses a bounded keyset page ordered by created_at and id", async () => {
    const rows = Array.from({ length: HISTORY_PAGE_MAX_LIMIT + 1 }, (_, index) => jobRow(`job-${index}`, `2026-08-19T00:${String(index).padStart(2, "0")}:00.000Z`));
    const cursor = { createdAt: "2026-08-18T23:59:00.000Z", jobId: "before" };
    const { db, calls } = fakeDb({ rows });

    const page = await listJobsForUser(db, "user-1", { limit: HISTORY_PAGE_MAX_LIMIT + 100, cursor });

    expect(page.jobs).toHaveLength(HISTORY_PAGE_MAX_LIMIT);
    expect(page.nextCursor).toEqual({ createdAt: rows[HISTORY_PAGE_MAX_LIMIT - 1]?.created_at, jobId: rows[HISTORY_PAGE_MAX_LIMIT - 1]?.id });
    expect(calls[0]?.sql).toContain("telegram_user_id = ?1");
    expect(calls[0]?.sql).toContain(`SELECT ${HISTORY_LIST_COLUMNS.map((column) => `j.${column}`).join(", ")}`);
    expect(calls[0]?.sql).not.toContain("SELECT * FROM jobs");
    expect(calls[0]?.sql).toContain("j.created_at < ?2 OR (j.created_at = ?2 AND j.id < ?3)");
    expect(calls[0]?.sql).toContain("ORDER BY j.created_at DESC, j.id DESC");
    expect(calls[0]?.values).toEqual(["user-1", cursor.createdAt, cursor.jobId, HISTORY_PAGE_MAX_LIMIT + 1]);
  });

  it("uses the same narrow projection for owner-scoped deletion lookup", async () => {
    const row = jobRow("job-a", "2026-08-19T00:00:00.000Z");
    const { db, calls } = fakeDb({ first: row });

    await getJobByIdForUser(db, "job-a", "user-1");

    expect(calls[0]?.sql).toContain(`SELECT ${HISTORY_LIST_COLUMNS.map((column) => `j.${column}`).join(", ")}`);
    expect(calls[0]?.sql).not.toContain("SELECT * FROM jobs");
  });

  it("returns an opaque next cursor only when an extra row exists", async () => {
    const rows = [jobRow("job-a", "2026-08-19T00:02:00.000Z"), jobRow("job-b", "2026-08-19T00:01:00.000Z"), jobRow("job-c", "2026-08-19T00:00:00.000Z")];
    const { db, calls } = fakeDb({ rows });

    const page = await listJobsForUser(db, "user-1", { limit: 2 });

    expect(page.jobs.map((job) => job.id)).toEqual(["job-a", "job-b"]);
    expect(page.nextCursor).toEqual({ createdAt: rows[1]?.created_at, jobId: rows[1]?.id });
    expect(calls[0]?.values).toEqual(["user-1", 3]);
  });

  it("filters terminal batches and caps their size", async () => {
    const { db, calls } = fakeDb({ rows: [jobRow("job-a", "2026-08-19T00:00:00.000Z")] });

    await listTerminalJobsForUser(db, "user-1", { limit: TERMINAL_HISTORY_BATCH_MAX_LIMIT + 1 });

    expect(calls[0]?.sql).toContain("status IN ('completed', 'failed')");
    expect(calls[0]?.sql).toContain("ORDER BY j.created_at DESC, j.id DESC");
    expect(calls[0]?.values).toEqual(["user-1", TERMINAL_HISTORY_BATCH_MAX_LIMIT + 1]);
  });

  it("gets a row only for the requested user", async () => {
    const row = jobRow("job-a", "2026-08-19T00:00:00.000Z");
    const { db, calls } = fakeDb({ first: row });

    await expect(getJobByIdForUser(db, "job-a", "user-1")).resolves.toBe(row);

    expect(calls[0]?.sql).toContain("j.id = ?1 AND j.telegram_user_id = ?2");
    expect(calls[0]?.values).toEqual(["job-a", "user-1"]);
  });

  it("deletes only terminal rows belonging to the requested user", async () => {
    const { db, calls } = fakeDb({ changes: 1 });

    await expect(deleteTerminalJobForUser(db, "job-a", "user-1")).resolves.toBe(true);

    expect(calls[0]?.sql).toContain("telegram_user_id = ?2");
    expect(calls[0]?.sql).toContain("status IN ('completed', 'failed')");
    expect(calls[0]?.values).toEqual(["job-a", "user-1"]);
  });

  it("reports false when the row is absent, cross-user, or active", async () => {
    const { db } = fakeDb({ changes: 0 });

    await expect(deleteTerminalJobForUser(db, "job-a", "user-2")).resolves.toBe(false);
  });
});

describe("getJobDurableState", () => {
  it("returns the same rows as the individual helpers in one batch", async () => {
    const { db, dispose } = await localD1();
    try {
      const id = "123e4567-e89b-42d3-a456-000000000301";
      const created = "2026-01-01T00:00:00.000Z";
      await createJobWithUpdateReservation(db, {
        id, telegramUpdateId: "durable-1", telegramUserId: "12345", telegramChatId: "12345", requestMessageId: "7",
        sourceHost: "youtu.be", sourceUrlHash: "hash", sourceUrlEncrypted: "v1.encrypted", requestedMode: "video",
        requestedQuality: "max-1080p", createdAt: created,
      }, { maxActiveJobs: 10, maxJobsPerHour: 10, hourlyWindowStart: "2025-12-31T00:00:00.000Z" });

      const state = await getJobDurableState(db, id);
      expect(state.job).not.toBeNull();
      expect(state.intent).not.toBeNull();
      expect(state.delivery).not.toBeNull();
      expect(state).toEqual({
        job: await getJob(db, id),
        intent: await getDispatchIntent(db, id),
        delivery: await getJobDelivery(db, id),
      });
      expect(await getJobDurableState(db, "123e4567-e89b-42d3-a456-000000000399")).toEqual({ job: null, intent: null, delivery: null });
    } finally {
      await dispose();
    }
  }, 30_000);
});

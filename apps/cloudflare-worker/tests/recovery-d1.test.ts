import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ActiveJobLimitError,
  HourlyJobLimitError,
  QueueLimitError,
  claimDispatchIntentForJob,
  createJobWithUpdateReservation,
  getUserQueue,
} from "../src/db";
import type { D1BatchDatabaseLike } from "../src/types";
import { localD1 } from "./helpers/local-d1";

let db: D1BatchDatabaseLike;
let dispose: () => Promise<void>;

const now = "2026-08-20T00:00:00.000Z";

function job(index: number, updateId = String(index), requestedOperation: "download" | "transcript" = "download") {
  const id = `123e4567-e89b-42d3-a456-${String(index).padStart(12, "0")}`;
  return {
    id,
    telegramUpdateId: updateId,
    telegramUserId: "12345",
    telegramChatId: "12345",
    requestMessageId: String(index + 100),
    sourceHost: "youtu.be",
    sourceUrlHash: `hash-${index}`,
    sourceUrlEncrypted: "v1.encrypted",
    requestedMode: "video" as const,
    requestedOperation,
    requestedQuality: "max-1080p",
    createdAt: now,
  };
}

async function count(table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number | string }>();
  return Number(row?.count ?? 0);
}

async function clearDatabase(): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM jobs"),
    db.prepare("DELETE FROM processed_updates"),
    db.prepare("DELETE FROM job_admission_guards"),
  ]);
}

describe("M1 admission and durable state on local workerd D1", () => {
  beforeAll(async () => {
    ({ db, dispose } = await localD1());
  }, 30_000);

  beforeEach(clearDatabase);
  afterAll(async () => { await dispose?.(); });

  it("admits exactly one job for 100 concurrent duplicate Telegram updates", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, (_, index) => createJobWithUpdateReservation(db, job(index, "duplicate-update"), {
        maxActiveJobs: 200,
        maxJobsPerHour: 200,
        hourlyWindowStart: "2026-08-19T23:00:00.000Z",
      })),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await count("jobs")).toBe(1);
    expect(await count("processed_updates")).toBe(1);
    expect(await count("active_job_admissions")).toBe(0);
    expect(await count("job_dispatch_intents")).toBe(1);
    expect(await count("job_deliveries")).toBe(1);
  }, 30_000);

  it("rolls back the update, semaphore, and durable rows when active admission fails", async () => {
    await expect(createJobWithUpdateReservation(db, job(1), {
      maxActiveJobs: 0,
      maxJobsPerHour: 10,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    })).rejects.toBeInstanceOf(ActiveJobLimitError);

    expect(await count("jobs")).toBe(0);
    expect(await count("processed_updates")).toBe(0);
    expect(await count("active_job_admissions")).toBe(0);
    expect(await count("job_dispatch_intents")).toBe(0);
    expect(await count("job_deliveries")).toBe(0);
  });

  it("keeps source and transcript queue lanes independent until promotion", async () => {
    await createJobWithUpdateReservation(db, job(11, "source-lane"), {
      maxActiveJobs: 1,
      maxActiveTranscriptions: 1,
      maxJobsPerHour: 10,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });
    await createJobWithUpdateReservation(db, job(12, "transcript-lane", "transcript"), {
      maxActiveJobs: 1,
      maxActiveTranscriptions: 1,
      maxJobsPerHour: 10,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });
    await createJobWithUpdateReservation(db, job(13, "second-transcript", "transcript"), {
      maxActiveJobs: 1,
      maxActiveTranscriptions: 1,
      maxJobsPerHour: 10,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });
    expect(await count("jobs")).toBe(3);
    expect(await count("active_job_admissions")).toBe(0);
  });

  it("rolls back all writes when the hourly admission guard fails", async () => {
    await expect(createJobWithUpdateReservation(db, job(2), {
      maxActiveJobs: 10,
      maxJobsPerHour: 0,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    })).rejects.toBeInstanceOf(HourlyJobLimitError);

    expect(await count("jobs")).toBe(0);
    expect(await count("processed_updates")).toBe(0);
    expect(await count("active_job_admissions")).toBe(0);
    expect(await count("job_dispatch_intents")).toBe(0);
    expect(await count("job_deliveries")).toBe(0);
  });

  it("rolls back the reservation when a later job insert fails", async () => {
    const first = job(3, "first-update");
    await createJobWithUpdateReservation(db, first, {
      maxActiveJobs: 10,
      maxJobsPerHour: 10,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });

    const duplicateJobId = { ...job(4, "second-update"), id: first.id };
    await expect(createJobWithUpdateReservation(db, duplicateJobId, {
      maxActiveJobs: 10,
      maxJobsPerHour: 10,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    })).rejects.toThrow();

    expect(await count("jobs")).toBe(1);
    expect(await count("processed_updates")).toBe(1);
    expect(await count("active_job_admissions")).toBe(0);
    expect(await count("job_dispatch_intents")).toBe(1);
    expect(await count("job_deliveries")).toBe(1);
  });

  it("caps unfinished jobs per user independently of the hourly limit", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) => createJobWithUpdateReservation(db, job(40 + index, `queue-${index}`), {
        maxActiveJobs: 1,
        maxJobsPerHour: 20,
        hourlyWindowStart: "2026-08-19T23:00:00.000Z",
      })),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((result) => result.status === "rejected" && result.reason instanceof QueueLimitError)).toHaveLength(1);
    expect(await count("jobs")).toBe(5);
    expect(await count("processed_updates")).toBe(5);
    expect(await count("telegram_notices")).toBe(5);
    expect(await count("active_job_admissions")).toBe(0);
  }, 30_000);

  it("records the accepted queue position and refreshes it after promotion", async () => {
    const first = job(50, "position-first");
    const second = job(51, "position-second");
    await createJobWithUpdateReservation(db, first, {
      maxActiveJobs: 1,
      maxJobsPerHour: 20,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });
    await createJobWithUpdateReservation(db, second, {
      maxActiveJobs: 1,
      maxJobsPerHour: 20,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });

    await expect(db.prepare("SELECT text FROM telegram_notices WHERE update_id = ?1").bind(first.telegramUpdateId).first()).resolves.toMatchObject({ text: expect.stringContaining("Position when accepted: 1") });
    await expect(db.prepare("SELECT text FROM telegram_notices WHERE update_id = ?1").bind(second.telegramUpdateId).first()).resolves.toMatchObject({ text: expect.stringContaining("Position when accepted: 2") });
    await expect(getUserQueue(db, first.telegramUserId)).resolves.toMatchObject([
      { id: first.id, position: 1, delivery_state: "not_started" },
      { id: second.id, position: 2, delivery_state: "not_started" },
    ]);

    await expect(claimDispatchIntentForJob(db, first.id, new Date(now), 60, { maxActiveJobs: 1 })).resolves.toMatchObject({ job_id: first.id, state: "leased" });
    await expect(getUserQueue(db, first.telegramUserId)).resolves.toMatchObject([
      { id: first.id, position: null },
      { id: second.id, position: 1 },
    ]);
  });
});

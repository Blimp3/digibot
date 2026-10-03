import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimDeliverySending,
  claimDispatchIntentForJob,
  createJobWithUpdateReservation,
  getDispatchIntent,
  getJob,
  getJobDelivery,
  listStartedDispatchIntents,
  markDispatchStarted,
  markDeliveryUnknown,
  recordDeliveryConfirmed,
  recordDeliveryRejected,
  setJobFailure,
} from "../src/db";
import {
  dispatchAcceptedJob,
  dispatchQueuedJobs,
  parseWorkflowResult,
  recoverAndReconcileDispatches,
} from "../src/dispatch";
import type { D1BatchDatabaseLike, Env, WorkflowBindingLike, WorkflowInstanceLike } from "../src/types";
import { localD1 } from "./helpers/local-d1";

let db: D1BatchDatabaseLike;
let dispose: () => Promise<void>;

const NOW = new Date("2026-08-20T00:00:00.000Z");

function job(index: number) {
  const id = `123e4567-e89b-42d3-a456-${String(index).padStart(12, "0")}`;
  return {
    id,
    telegramUpdateId: `update-${index}`,
    telegramUserId: "12345",
    telegramChatId: "12345",
    requestMessageId: String(index + 100),
    sourceHost: "youtu.be",
    sourceUrlHash: `hash-${index}`,
    sourceUrlEncrypted: "v1.encrypted",
    requestedMode: "video" as const,
    requestedQuality: "max-1080p",
    createdAt: NOW.toISOString(),
  };
}

async function supersededJob(index: number) {
  const accepted = job(index);
  await createJobWithUpdateReservation(db, accepted, {
    maxActiveJobs: 10,
    maxJobsPerHour: 10,
    hourlyWindowStart: "2026-08-19T23:00:00.000Z",
  });
  const first = await claimDispatchIntentForJob(db, accepted.id, NOW, 60);
  const second = await claimDispatchIntentForJob(db, accepted.id, new Date(NOW.getTime() + 61_000), 60);
  expect(first?.generation).toBe(1);
  expect(second?.generation).toBe(2);
  await expect(markDispatchStarted(db, accepted.id, second!.generation)).resolves.toBe(true);
  return { accepted, first: first!, second: second! };
}

async function startedJob(index: number) {
  const accepted = job(index);
  await createJobWithUpdateReservation(db, accepted, {
    maxActiveJobs: 10,
    maxJobsPerHour: 10,
    hourlyWindowStart: "2026-08-19T23:00:00.000Z",
  });
  const createBatch = vi.fn(async () => undefined);
  await dispatchAcceptedJob(env({ createBatch }), accepted.id, NOW);
  const started = await getDispatchIntent(db, accepted.id);
  expect(started?.state).toBe("started");
  return { accepted, createBatch, generation: started!.generation };
}

function rejectedWorkflow(jobId: string): WorkflowBindingLike["get"] {
  return vi.fn(async (id: string) => instance(id, async () => ({
    status: "complete" as const,
    output: { status: "failed", jobId, outcome: "rejected", errorCode: "TELEGRAM_UPLOAD_FAILED" },
  })));
}

async function clearDatabase(): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM jobs"),
    db.prepare("DELETE FROM processed_updates"),
    db.prepare("DELETE FROM job_admission_guards"),
  ]);
}

function env(binding: WorkflowBindingLike, overrides: Record<string, string> = {}): Env {
  return { DB: db, MEDIA_WORKFLOW: binding, ...overrides } as unknown as Env;
}

function instance(
  id: string,
  status: () => Promise<{ status: "queued" | "running" | "complete" | "errored" | "terminated" | "unknown"; output?: unknown }>,
): WorkflowInstanceLike {
  return { id, status };
}

describe("durable dispatch and recovery on local workerd D1", () => {
  beforeAll(async () => {
    ({ db, dispose } = await localD1());
  }, 30_000);

  beforeEach(clearDatabase);
  afterAll(async () => { await dispose?.(); });

  it("uses the stable job ID and verifies status after a lost create response", async () => {
    const accepted = job(1);
    await createJobWithUpdateReservation(db, accepted, {
      maxActiveJobs: 10,
      maxJobsPerHour: 10,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });
    const status = vi.fn(async () => ({ status: "queued" as const }));
    const get = vi.fn(async (id: string) => instance(id, status));
    const createBatch = vi.fn(async () => { throw new Error("response lost"); });

    await dispatchAcceptedJob(env({ createBatch, get }), accepted.id, NOW);

    expect(createBatch).toHaveBeenCalledWith([{ id: accepted.id, params: { jobId: accepted.id } }]);
    expect(get).toHaveBeenCalledWith(accepted.id);
    expect(status).toHaveBeenCalledOnce();
    await expect(getDispatchIntent(db, accepted.id)).resolves.toMatchObject({
      state: "started",
      generation: 1,
      workflow_instance_id: accepted.id,
    });
  });

  it("keeps an unverified lost create pending until get plus status proves existence", async () => {
    const accepted = job(2);
    await createJobWithUpdateReservation(db, accepted, {
      maxActiveJobs: 10,
      maxJobsPerHour: 10,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });
    const status = vi.fn(async () => ({ status: "unknown" as const }));
    const get = vi.fn(async (id: string) => instance(id, status));
    const create = vi.fn(async () => { throw new Error("response lost"); });

    await dispatchAcceptedJob(env({ create, get }), accepted.id, NOW);

    expect(create).toHaveBeenCalledWith({ id: accepted.id, params: { jobId: accepted.id } });
    expect(get).toHaveBeenCalledWith(accepted.id);
    expect(status).toHaveBeenCalledOnce();
    await expect(getDispatchIntent(db, accepted.id)).resolves.toMatchObject({
      state: "pending",
      generation: 1,
      last_error_code: "WORKFLOW_CREATE_UNRESOLVED",
    });
  });

  it("fences stale lease generations before allowing the one final-send owner", async () => {
    const accepted = job(3);
    await createJobWithUpdateReservation(db, accepted, {
      maxActiveJobs: 10,
      maxJobsPerHour: 10,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });
    const first = await claimDispatchIntentForJob(db, accepted.id, NOW, 60);
    const second = await claimDispatchIntentForJob(db, accepted.id, new Date(NOW.getTime() + 61_000), 60);

    expect(first?.generation).toBe(1);
    expect(second?.generation).toBe(2);
    await expect(markDispatchStarted(db, accepted.id, first!.generation)).resolves.toBe(false);
    await expect(markDispatchStarted(db, accepted.id, second!.generation)).resolves.toBe(true);
    await expect(claimDeliverySending(db, accepted.id, first!.generation)).resolves.toBe(false);
    await expect(claimDeliverySending(db, accepted.id, second!.generation)).resolves.toBe(true);
  });

  it("does not let a stale generation mark the newer unclaimed delivery unknown", async () => {
    const { accepted, first, second } = await supersededJob(30);

    await expect(markDeliveryUnknown(db, accepted.id, "stale_unknown", first.generation)).resolves.toBe(false);
    await expect(getJobDelivery(db, accepted.id)).resolves.toMatchObject({ state: "not_started", owner_generation: null });
    await expect(claimDeliverySending(db, accepted.id, second.generation)).resolves.toBe(true);
  });

  it("does not let a stale rejection release the newer generation's admission", async () => {
    const { accepted, first, second } = await supersededJob(34);

    await expect(recordDeliveryRejected(db, accepted.id, "stale_rejection", first.generation)).resolves.toBe(false);
    await expect(setJobFailure(db, accepted.id, "MEDIA_UNAVAILABLE", "stale failure", {}, first.generation)).resolves.toBe(false);

    await expect(getJobDelivery(db, accepted.id)).resolves.toMatchObject({ state: "not_started", owner_generation: null });
    await expect(getJob(db, accepted.id)).resolves.not.toMatchObject({ status: "failed" });
    await expect(db.prepare("SELECT COUNT(*) AS count FROM active_job_admissions WHERE job_id = ?1").bind(accepted.id).first()).resolves.toEqual({ count: 1 });
    await expect(claimDeliverySending(db, accepted.id, second.generation)).resolves.toBe(true);
  });

  it("does not let a stale unowned receipt overwrite the newer generation", async () => {
    const { accepted, first, second } = await supersededJob(35);

    await expect(recordDeliveryConfirmed(db, accepted.id, {
      method: "telegram",
      telegramMessageId: "999",
      ownerGeneration: first.generation,
    })).resolves.toBe(false);

    await expect(getJobDelivery(db, accepted.id)).resolves.toMatchObject({ state: "not_started", telegram_message_id: null });
    await expect(claimDeliverySending(db, accepted.id, second.generation)).resolves.toBe(true);
  });

  it("keeps an unknown delivery admitted even for the current generation", async () => {
    const accepted = job(36);
    await createJobWithUpdateReservation(db, accepted, {
      maxActiveJobs: 10,
      maxJobsPerHour: 10,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });
    const current = await claimDispatchIntentForJob(db, accepted.id, NOW, 60);
    await expect(markDispatchStarted(db, accepted.id, current!.generation)).resolves.toBe(true);
    await expect(markDeliveryUnknown(db, accepted.id, "operator_review", current!.generation)).resolves.toBe(true);

    await expect(setJobFailure(db, accepted.id, "INTERNAL_ERROR", "must remain unknown", {}, current!.generation)).resolves.toBe(false);
    await expect(getJobDelivery(db, accepted.id)).resolves.toMatchObject({ state: "unknown" });
    await expect(getJob(db, accepted.id)).resolves.not.toMatchObject({ status: "failed" });
    await expect(db.prepare("SELECT COUNT(*) AS count FROM active_job_admissions WHERE job_id = ?1").bind(accepted.id).first()).resolves.toEqual({ count: 1 });
  });

  it("accepts a validated late receipt from the generation that owned the send", async () => {
    const accepted = job(31);
    await createJobWithUpdateReservation(db, accepted, {
      maxActiveJobs: 10,
      maxJobsPerHour: 10,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });
    const first = await claimDispatchIntentForJob(db, accepted.id, NOW, 60);
    await expect(claimDeliverySending(db, accepted.id, first!.generation)).resolves.toBe(true);
    const second = await claimDispatchIntentForJob(db, accepted.id, new Date(NOW.getTime() + 61_000), 60);
    await expect(markDispatchStarted(db, accepted.id, second!.generation)).resolves.toBe(true);
    await expect(markDeliveryUnknown(db, accepted.id, "late_receipt_pending", first!.generation)).resolves.toBe(true);

    await expect(recordDeliveryConfirmed(db, accepted.id, {
      method: "telegram",
      telegramMessageId: "321",
      ownerGeneration: first!.generation,
    })).resolves.toBe(true);
    await expect(getJobDelivery(db, accepted.id)).resolves.toMatchObject({
      state: "confirmed",
      telegram_message_id: "321",
      owner_generation: null,
    });
    await expect(claimDeliverySending(db, accepted.id, second!.generation)).resolves.toBe(false);
  });

  it("preserves explicit unowned recovery for legacy and operator decisions", async () => {
    const unknownJob = job(32);
    const rejectedJob = job(33);
    for (const accepted of [unknownJob, rejectedJob]) {
      await createJobWithUpdateReservation(db, accepted, {
        maxActiveJobs: 10,
        maxJobsPerHour: 10,
        hourlyWindowStart: "2026-08-19T23:00:00.000Z",
      });
    }

    await expect(markDeliveryUnknown(db, unknownJob.id, "operator_review")).resolves.toBe(true);
    await expect(recordDeliveryConfirmed(db, unknownJob.id, {
      method: "telegram",
      telegramMessageId: "654",
    })).resolves.toBe(true);
    await expect(recordDeliveryRejected(db, rejectedJob.id, "legacy_rejection")).resolves.toBe(true);
    await expect(getJobDelivery(db, unknownJob.id)).resolves.toMatchObject({ state: "confirmed", telegram_message_id: "654" });
    await expect(getJobDelivery(db, rejectedJob.id)).resolves.toMatchObject({ state: "rejected" });
  });

  it("repairs a confirmed Workflow result in D1 and never resends it", async () => {
    const accepted = job(4);
    await createJobWithUpdateReservation(db, accepted, {
      maxActiveJobs: 10,
      maxJobsPerHour: 10,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });
    const createBatch = vi.fn(async () => undefined);
    await dispatchAcceptedJob(env({ createBatch }), accepted.id, NOW);
    const started = await getDispatchIntent(db, accepted.id);
    expect(started?.state).toBe("started");
    await expect(claimDeliverySending(db, accepted.id, started!.generation)).resolves.toBe(true);

    const status = vi.fn(async () => ({
      status: "complete" as const,
      output: {
        status: "completed",
        jobId: accepted.id,
        delivery: "telegram",
        telegramMessageId: "321",
        filename: "video.mp4",
        mimeType: "video/mp4",
        sizeBytes: 100,
      },
    }));
    const get = vi.fn(async (id: string) => instance(id, status));
    const workerEnv = env({ createBatch, get });

    await recoverAndReconcileDispatches(workerEnv, NOW, 10);

    await expect(getJobDelivery(db, accepted.id)).resolves.toMatchObject({
      state: "confirmed",
      telegram_message_id: "321",
    });
    await expect(getJob(db, accepted.id)).resolves.toMatchObject({ status: "completed", result_message_id: "321" });
    await expect(getDispatchIntent(db, accepted.id)).resolves.toMatchObject({ state: "complete" });
    await expect(db.prepare("SELECT COUNT(*) AS count FROM active_job_admissions").first()).resolves.toEqual({ count: 0 });

    await recoverAndReconcileDispatches(workerEnv, new Date(NOW.getTime() + 120_000), 10);
    expect(createBatch).toHaveBeenCalledOnce();
  });

  it("marks a terminal Workflow with no validated receipt unknown and never replays it", async () => {
    const accepted = job(5);
    await createJobWithUpdateReservation(db, accepted, {
      maxActiveJobs: 10,
      maxJobsPerHour: 10,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });
    const createBatch = vi.fn(async () => undefined);
    await dispatchAcceptedJob(env({ createBatch }), accepted.id, NOW);
    const started = await getDispatchIntent(db, accepted.id);
    await expect(claimDeliverySending(db, accepted.id, started!.generation)).resolves.toBe(true);

    const status = vi.fn(async () => ({ status: "complete" as const, output: { status: "completed" } }));
    const get = vi.fn(async (id: string) => instance(id, status));
    const workerEnv = env({ createBatch, get });
    await recoverAndReconcileDispatches(workerEnv, NOW, 10);

    await expect(getJobDelivery(db, accepted.id)).resolves.toMatchObject({ state: "unknown" });
    await expect(getJob(db, accepted.id)).resolves.toMatchObject({ status: "queued" });
    await expect(getDispatchIntent(db, accepted.id)).resolves.toMatchObject({ state: "complete" });
    await recoverAndReconcileDispatches(workerEnv, new Date(NOW.getTime() + 86_400_000), 10);
    expect(createBatch).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
  });

  it("preserves the first receipt and closes a conflicting confirmed result for operator review", async () => {
    const accepted = job(7);
    await createJobWithUpdateReservation(db, accepted, {
      maxActiveJobs: 10,
      maxJobsPerHour: 10,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });
    const createBatch = vi.fn(async () => undefined);
    await dispatchAcceptedJob(env({ createBatch }), accepted.id, NOW);
    const started = await getDispatchIntent(db, accepted.id);
    await expect(claimDeliverySending(db, accepted.id, started!.generation)).resolves.toBe(true);
    await expect(recordDeliveryConfirmed(db, accepted.id, {
      method: "telegram",
      telegramMessageId: "100",
      filename: "first.mp4",
      mimeType: "video/mp4",
      sizeBytes: 100,
      ownerGeneration: started!.generation,
    })).resolves.toBe(true);

    const status = vi.fn(async () => ({
      status: "complete" as const,
      output: { status: "completed", jobId: accepted.id, delivery: "telegram", telegramMessageId: "200" },
    }));
    const get = vi.fn(async (id: string) => instance(id, status));
    await recoverAndReconcileDispatches(env({ createBatch, get }), NOW, 10);

    await expect(getJobDelivery(db, accepted.id)).resolves.toMatchObject({
      state: "unknown",
      telegram_message_id: "100",
      unknown_reason: "conflicting_confirmed_receipt",
    });
    await expect(getDispatchIntent(db, accepted.id)).resolves.toMatchObject({ state: "complete" });
    await expect(getJob(db, accepted.id)).resolves.toMatchObject({ status: "queued", result_message_id: null });
  });

  it("records a proven Workflow rejection without treating it as an ambiguous send", async () => {
    const accepted = job(8);
    await createJobWithUpdateReservation(db, accepted, {
      maxActiveJobs: 10,
      maxJobsPerHour: 10,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });
    const createBatch = vi.fn(async () => undefined);
    await dispatchAcceptedJob(env({ createBatch }), accepted.id, NOW);
    const status = vi.fn(async () => ({
      status: "complete" as const,
      output: {
        status: "failed",
        jobId: accepted.id,
        outcome: "rejected",
        errorCode: "TELEGRAM_UPLOAD_FAILED",
      },
    }));
    const get = vi.fn(async (id: string) => instance(id, status));

    await recoverAndReconcileDispatches(env({ createBatch, get }), NOW, 10);

    await expect(getJobDelivery(db, accepted.id)).resolves.toMatchObject({ state: "rejected" });
    await expect(getJob(db, accepted.id)).resolves.toMatchObject({ status: "failed", error_code: "TELEGRAM_UPLOAD_FAILED" });
    await expect(getDispatchIntent(db, accepted.id)).resolves.toMatchObject({ state: "complete" });
  });

  it("retains only a valid long final-delivery 429 delay and never schedules a resend", async () => {
    const accepted = job(11);
    await createJobWithUpdateReservation(db, accepted, {
      maxActiveJobs: 10,
      maxJobsPerHour: 10,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });
    const createBatch = vi.fn(async () => undefined);
    await dispatchAcceptedJob(env({ createBatch }), accepted.id, NOW);
    const status = vi.fn(async () => ({
      status: "complete" as const,
      output: {
        status: "failed",
        jobId: accepted.id,
        errorCode: "TELEGRAM_RATE_LIMITED",
        retryAfterSeconds: 86_401,
      },
    }));
    const get = vi.fn(async (id: string) => instance(id, status));

    await recoverAndReconcileDispatches(env({ createBatch, get }), NOW, 10);

    await expect(getJobDelivery(db, accepted.id)).resolves.toMatchObject({
      state: "rejected",
      retry_after_seconds: 86_401,
    });
    await expect(getDispatchIntent(db, accepted.id)).resolves.toMatchObject({ state: "complete" });
    await recoverAndReconcileDispatches(env({ createBatch, get }), new Date(NOW.getTime() + 86_402_000), 10);
    expect(createBatch).toHaveBeenCalledOnce();
  });

  it("does not schedule malformed final-delivery retry metadata", async () => {
    expect(parseWorkflowResult({
      status: "failed",
      jobId: "job-a",
      errorCode: "TELEGRAM_RATE_LIMITED",
      retryAfterSeconds: "86401",
    }, "job-a")).toEqual({ kind: "rejected", errorCode: "TELEGRAM_RATE_LIMITED" });
    expect(parseWorkflowResult({
      status: "failed",
      jobId: "job-a",
      errorCode: "R2_UPLOAD_FAILED",
      retryAfterSeconds: 86_401,
    }, "job-a")).toEqual({ kind: "rejected", errorCode: "R2_UPLOAD_FAILED" });
  });

  it("preserves a known presend failure when its delivery permit was never claimed", async () => {
    const accepted = job(9);
    await createJobWithUpdateReservation(db, accepted, {
      maxActiveJobs: 10,
      maxJobsPerHour: 10,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });
    const createBatch = vi.fn(async () => undefined);
    await dispatchAcceptedJob(env({ createBatch }), accepted.id, NOW);
    await expect(setJobFailure(db, accepted.id, "MEDIA_UNAVAILABLE", "The source media is unavailable.")).resolves.toBe(true);
    const status = vi.fn(async () => ({ status: "complete" as const, output: { status: "failed", jobId: accepted.id, outcome: "rejected", errorCode: "MEDIA_UNAVAILABLE" } }));
    const get = vi.fn(async (id: string) => instance(id, status));

    await recoverAndReconcileDispatches(env({ createBatch, get }), NOW, 10);

    await expect(getJob(db, accepted.id)).resolves.toMatchObject({ status: "failed", error_code: "MEDIA_UNAVAILABLE" });
    await expect(getJobDelivery(db, accepted.id)).resolves.toMatchObject({ state: "not_started" });
    await expect(getDispatchIntent(db, accepted.id)).resolves.toMatchObject({ state: "complete" });
  });

  it("repairs a failed terminal job with a sending delivery to durable unknown", async () => {
    const accepted = job(10);
    await createJobWithUpdateReservation(db, accepted, {
      maxActiveJobs: 10,
      maxJobsPerHour: 10,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });
    const createBatch = vi.fn(async () => undefined);
    await dispatchAcceptedJob(env({ createBatch }), accepted.id, NOW);
    const started = await getDispatchIntent(db, accepted.id);
    await expect(claimDeliverySending(db, accepted.id, started!.generation)).resolves.toBe(true);
    await expect(setJobFailure(db, accepted.id, "TELEGRAM_UPLOAD_FAILED", "The media delivery failed.")).resolves.toBe(true);
    const status = vi.fn(async () => ({ status: "errored" as const }));
    const get = vi.fn(async (id: string) => instance(id, status));

    await recoverAndReconcileDispatches(env({ createBatch, get }), NOW, 10);

    await expect(getJob(db, accepted.id)).resolves.toMatchObject({ status: "failed", error_code: "TELEGRAM_UPLOAD_FAILED" });
    await expect(getJobDelivery(db, accepted.id)).resolves.toMatchObject({ state: "unknown", unknown_reason: "terminal_job_without_delivery_receipt" });
    await expect(getDispatchIntent(db, accepted.id)).resolves.toMatchObject({ state: "complete" });
  });

  it("rejects Workflow status output for another or missing job ID", () => {
    expect(parseWorkflowResult({ status: "completed", telegramMessageId: "1" }, "job-a")).toEqual({ kind: "unknown" });
    expect(parseWorkflowResult({ status: "completed", jobId: "job-b", telegramMessageId: "1" }, "job-a")).toEqual({ kind: "unknown" });
    expect(parseWorkflowResult({ status: "failed", jobId: "job-b", errorCode: "TELEGRAM_UPLOAD_FAILED" }, "job-a")).toEqual({ kind: "unknown" });
  });

  it("read-only reconciles terminal pending work without re-leasing a queued row", async () => {
    const accepted = job(72);
    await createJobWithUpdateReservation(db, accepted, {
      maxActiveJobs: 1,
      maxJobsPerHour: 20,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });
    await expect(db.prepare(`UPDATE jobs SET status = 'completed', result_message_id = '321', completed_at = ?1, updated_at = ?1 WHERE id = ?2`).bind(NOW.toISOString(), accepted.id).run()).resolves.toMatchObject({ meta: { changes: 1 } });

    const get = vi.fn(async () => { throw { status: 404 }; });
    await recoverAndReconcileDispatches(env({ get }), NOW, 10);

    await expect(get).toHaveBeenCalledOnce();
    await expect(getJobDelivery(db, accepted.id)).resolves.toMatchObject({ state: "confirmed", telegram_message_id: "321" });
    await expect(getDispatchIntent(db, accepted.id)).resolves.toMatchObject({ state: "complete" });
    await expect(db.prepare("SELECT COUNT(*) AS count FROM active_job_admissions").first()).resolves.toEqual({ count: 0 });
  });

  it("releases an admitted nonterminal job after a proven rejected delivery and missing Workflow", async () => {
    const accepted = job(73);
    await createJobWithUpdateReservation(db, accepted, {
      maxActiveJobs: 1,
      maxJobsPerHour: 20,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });
    const claimed = await claimDispatchIntentForJob(db, accepted.id, NOW, 60, { maxActiveJobs: 1 });
    expect(claimed?.state).toBe("leased");
    await expect(recordDeliveryRejected(db, accepted.id, "Telegram rejected the delivery.")).resolves.toBe(true);

    const get = vi.fn(async () => { throw { status: 404 }; });
    await recoverAndReconcileDispatches(env({ get }), NOW, 10);

    await expect(getJob(db, accepted.id)).resolves.toMatchObject({ status: "failed", error_code: "TELEGRAM_UPLOAD_FAILED" });
    await expect(getJobDelivery(db, accepted.id)).resolves.toMatchObject({ state: "rejected" });
    await expect(getDispatchIntent(db, accepted.id)).resolves.toMatchObject({ state: "complete" });
    await expect(db.prepare("SELECT COUNT(*) AS count FROM active_job_admissions").first()).resolves.toEqual({ count: 0 });
  });

  it("excludes a genuinely queued not_started job from read-only reconciliation", async () => {
    const accepted = job(74);
    await createJobWithUpdateReservation(db, accepted, {
      maxActiveJobs: 1,
      maxJobsPerHour: 20,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });

    await expect(listStartedDispatchIntents(db, 10)).resolves.toEqual([]);
  });

  it("keeps a live old upload leased for later status observation", async () => {
    const accepted = job(6);
    await createJobWithUpdateReservation(db, accepted, {
      maxActiveJobs: 10,
      maxJobsPerHour: 10,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });
    const createBatch = vi.fn(async () => undefined);
    await dispatchAcceptedJob(env({ createBatch }), accepted.id, NOW);
    const started = await getDispatchIntent(db, accepted.id);
    await expect(claimDeliverySending(db, accepted.id, started!.generation)).resolves.toBe(true);

    const status = vi.fn(async () => ({ status: "running" as const }));
    const get = vi.fn(async (id: string) => instance(id, status));
    await recoverAndReconcileDispatches(env({ createBatch, get }), new Date(NOW.getTime() + 86_400_000), 10);

    await expect(getDispatchIntent(db, accepted.id)).resolves.toMatchObject({ state: "started" });
    await expect(getJobDelivery(db, accepted.id)).resolves.toMatchObject({ state: "sending" });
    await expect(getJob(db, accepted.id)).resolves.toMatchObject({ status: "queued" });
    await expect(db.prepare("SELECT COUNT(*) AS count FROM active_job_admissions").first()).resolves.toEqual({ count: 1 });
  });

  it("keeps a newer webhook behind an older unadmitted queue head", async () => {
    const first = job(40);
    const second = job(41);
    for (const accepted of [first, second]) {
      await createJobWithUpdateReservation(db, accepted, {
        maxActiveJobs: 1,
        maxJobsPerHour: 20,
        hourlyWindowStart: "2026-08-19T23:00:00.000Z",
      });
    }

    await expect(claimDispatchIntentForJob(db, second.id, NOW, 60, { maxActiveJobs: 1 })).resolves.toBeNull();
    await expect(claimDispatchIntentForJob(db, first.id, NOW, 60, { maxActiveJobs: 1 })).resolves.toMatchObject({ job_id: first.id, state: "leased" });
    await expect(claimDispatchIntentForJob(db, second.id, NOW, 60, { maxActiveJobs: 1 })).resolves.toBeNull();
  });

  it("promotes FIFO source and transcript heads independently and unblocks after failure", async () => {
    const sourceHead = job(50);
    const captionHead = { ...job(51), requestedOperation: "transcript" as const, transcriptMethod: "captions" as const };
    const whisperHead = { ...job(52), requestedOperation: "transcript" as const, transcriptMethod: "whisper" as const };
    const sourceTail = job(53);
    for (const accepted of [sourceHead, captionHead, whisperHead, sourceTail]) {
      await createJobWithUpdateReservation(db, accepted, {
        maxActiveJobs: 1,
        maxActiveTranscriptions: 1,
        maxJobsPerHour: 20,
        hourlyWindowStart: "2026-08-19T23:00:00.000Z",
      });
    }

    const createBatch = vi.fn<NonNullable<WorkflowBindingLike["createBatch"]>>(async () => undefined);
    await dispatchQueuedJobs(env({ createBatch }), NOW, 10);
    expect(createBatch.mock.calls.map(([request]) => request[0]?.id)).toEqual([sourceHead.id, whisperHead.id]);
    await expect(db.prepare("SELECT lane, COUNT(*) AS count FROM active_job_admissions GROUP BY lane ORDER BY lane").all()).resolves.toMatchObject({
      results: [{ lane: "source", count: 1 }, { lane: "transcript", count: 1 }],
    });

    await expect(recordDeliveryRejected(db, sourceHead.id, "source_failed")).resolves.toBe(true);
    await expect(setJobFailure(db, sourceHead.id, "MEDIA_UNAVAILABLE", "source failed")).resolves.toBe(true);
    await dispatchQueuedJobs(env({ createBatch }), NOW, 10);
    expect(createBatch.mock.calls.map(([request]) => request[0]?.id)).toEqual([sourceHead.id, whisperHead.id, captionHead.id]);
    await expect(getDispatchIntent(db, captionHead.id)).resolves.toMatchObject({ state: "started" });
    await expect(getDispatchIntent(db, sourceTail.id)).resolves.toMatchObject({ state: "pending" });
  });

  it("keeps concurrent cron and webhook promotion to one FIFO source head", async () => {
    const first = job(60);
    const second = job(61);
    for (const accepted of [first, second]) {
      await createJobWithUpdateReservation(db, accepted, {
        maxActiveJobs: 1,
        maxJobsPerHour: 20,
        hourlyWindowStart: "2026-08-19T23:00:00.000Z",
      });
    }
    const createBatch = vi.fn<NonNullable<WorkflowBindingLike["createBatch"]>>(async () => undefined);
    const [cron, webhook] = await Promise.all([
      dispatchQueuedJobs(env({ createBatch }), NOW, 10),
      claimDispatchIntentForJob(db, second.id, NOW, 60, { maxActiveJobs: 1 }),
    ]);
    void cron;
    expect(webhook).toBeNull();
    expect(createBatch.mock.calls.map(([request]) => request[0]?.id)).toEqual([first.id]);
    await expect(getDispatchIntent(db, first.id)).resolves.toMatchObject({ state: "started" });
    await expect(getDispatchIntent(db, second.id)).resolves.toMatchObject({ state: "pending" });
  });

  it("rejects an old direct lease that has no matching active admission", async () => {
    const accepted = job(70);
    await createJobWithUpdateReservation(db, accepted, {
      maxActiveJobs: 1,
      maxJobsPerHour: 20,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });

    await expect(db.prepare(`UPDATE job_dispatch_intents
      SET state = 'leased', generation = generation + 1, lease_expires_at = ?1, updated_at = ?1
      WHERE job_id = ?2`).bind(NOW.toISOString(), accepted.id).run()).rejects.toThrow("DISPATCH_ADMISSION_REQUIRED");
    await expect(getDispatchIntent(db, accepted.id)).resolves.toMatchObject({ state: "pending", generation: 0 });
    await expect(db.prepare("SELECT COUNT(*) AS count FROM active_job_admissions").first()).resolves.toEqual({ count: 0 });
  });

  it("repairs a confirmed delivery when the Workflow reports a rejection and never resends it", async () => {
    const { accepted, createBatch, generation } = await startedJob(80);
    await expect(claimDeliverySending(db, accepted.id, generation)).resolves.toBe(true);
    await expect(recordDeliveryConfirmed(db, accepted.id, {
      method: "telegram",
      telegramMessageId: "456",
      ownerGeneration: generation,
    })).resolves.toBe(true);
    const workerEnv = env({ createBatch, get: rejectedWorkflow(accepted.id) });

    await recoverAndReconcileDispatches(workerEnv, NOW, 10);

    await expect(getJobDelivery(db, accepted.id)).resolves.toMatchObject({ state: "confirmed", telegram_message_id: "456" });
    await expect(getJob(db, accepted.id)).resolves.toMatchObject({ status: "completed", result_message_id: "456", error_code: null });
    await expect(getDispatchIntent(db, accepted.id)).resolves.toMatchObject({ state: "complete" });
    await expect(db.prepare("SELECT COUNT(*) AS count FROM active_job_admissions").first()).resolves.toEqual({ count: 0 });
    await recoverAndReconcileDispatches(workerEnv, new Date(NOW.getTime() + 120_000), 10);
    expect(createBatch).toHaveBeenCalledOnce();
  });

  it("marks a send the Workflow reports as rejected unknown instead of failing the job", async () => {
    const { accepted, createBatch, generation } = await startedJob(81);
    await expect(claimDeliverySending(db, accepted.id, generation)).resolves.toBe(true);

    await recoverAndReconcileDispatches(env({ createBatch, get: rejectedWorkflow(accepted.id) }), NOW, 10);

    await expect(getJobDelivery(db, accepted.id)).resolves.toMatchObject({ state: "unknown", unknown_reason: "workflow_failed_during_send" });
    await expect(getJob(db, accepted.id)).resolves.toMatchObject({ status: "queued", error_code: null });
    await expect(getDispatchIntent(db, accepted.id)).resolves.toMatchObject({ state: "complete" });
    await expect(db.prepare("SELECT COUNT(*) AS count FROM active_job_admissions").first()).resolves.toEqual({ count: 1 });
  });

  it("leaves an already unknown delivery unchanged when the Workflow reports a rejection", async () => {
    const { accepted, createBatch, generation } = await startedJob(82);
    await expect(markDeliveryUnknown(db, accepted.id, "operator_review", generation)).resolves.toBe(true);

    await recoverAndReconcileDispatches(env({ createBatch, get: rejectedWorkflow(accepted.id) }), NOW, 10);

    await expect(getJobDelivery(db, accepted.id)).resolves.toMatchObject({ state: "unknown", unknown_reason: "operator_review" });
    await expect(getJob(db, accepted.id)).resolves.toMatchObject({ status: "queued", error_code: null });
    await expect(getDispatchIntent(db, accepted.id)).resolves.toMatchObject({ state: "complete" });
    await expect(db.prepare("SELECT COUNT(*) AS count FROM active_job_admissions").first()).resolves.toEqual({ count: 1 });
  });

  it.each([
    ["no Workflow binding", () => ({ DB: db }) as unknown as Env],
    ["a binding that cannot create", () => env({ get: vi.fn() })],
  ])("reschedules a claimed intent as WORKFLOW_UNAVAILABLE with %s", async (_label, workerEnv) => {
    const accepted = job(83);
    await createJobWithUpdateReservation(db, accepted, {
      maxActiveJobs: 10,
      maxJobsPerHour: 10,
      hourlyWindowStart: "2026-08-19T23:00:00.000Z",
    });

    await dispatchAcceptedJob(workerEnv(), accepted.id, NOW);

    await expect(getDispatchIntent(db, accepted.id)).resolves.toMatchObject({
      state: "pending",
      generation: 1,
      lease_expires_at: null,
      available_at: new Date(NOW.getTime() + 1_000).toISOString(),
      last_error_code: "WORKFLOW_UNAVAILABLE",
      last_error_message: "Workflow binding is unavailable.",
    });
  });

  it.each([
    new Error("Workflow instance not found"),
    new Error("instance does not exist"),
    new Error("Unknown instance"),
    { code: 404 },
  ])("treats %o from get as a missing Workflow instance", async (failure) => {
    const { accepted } = await startedJob(84);
    const get = vi.fn(async () => { throw failure; });

    await recoverAndReconcileDispatches(env({ get }), NOW, 10);

    await expect(getJobDelivery(db, accepted.id)).resolves.toMatchObject({ state: "unknown", unknown_reason: "workflow_instance_missing" });
    await expect(getDispatchIntent(db, accepted.id)).resolves.toMatchObject({ state: "complete" });
  });

  it("keeps the intent started after a transient Workflow lookup error", async () => {
    const { accepted } = await startedJob(85);
    const get = vi.fn(async () => { throw new Error("network connection lost"); });

    await recoverAndReconcileDispatches(env({ get }), NOW, 10);

    expect(get).toHaveBeenCalledOnce();
    await expect(getJobDelivery(db, accepted.id)).resolves.toMatchObject({ state: "not_started" });
    await expect(getDispatchIntent(db, accepted.id)).resolves.toMatchObject({ state: "started" });
  });

  it("marks a terminal Workflow with an invalid result unknown before the send was claimed", async () => {
    const { accepted, createBatch } = await startedJob(86);
    const status = vi.fn(async () => ({ status: "complete" as const, output: { status: "completed" } }));
    const workerEnv = env({ createBatch, get: vi.fn(async (id: string) => instance(id, status)) });

    await recoverAndReconcileDispatches(workerEnv, NOW, 10);

    await expect(getJobDelivery(db, accepted.id)).resolves.toMatchObject({ state: "unknown", unknown_reason: "workflow_terminal_without_valid_result" });
    await expect(getJob(db, accepted.id)).resolves.toMatchObject({ status: "queued" });
    await expect(getDispatchIntent(db, accepted.id)).resolves.toMatchObject({ state: "complete" });
    await expect(db.prepare("SELECT COUNT(*) AS count FROM active_job_admissions").first()).resolves.toEqual({ count: 1 });
    await recoverAndReconcileDispatches(workerEnv, new Date(NOW.getTime() + 86_400_000), 10);
    expect(createBatch).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledOnce();
  });
});

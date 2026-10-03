import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  containerFetch: vi.fn(),
  decryptSourceUrl: vi.fn(async () => "https://youtu.be/example"),
  ensureWaitingNotice: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    readonly env: unknown;

    constructor(env: unknown) {
      this.env = env;
    }
  },
}));
vi.mock("@cloudflare/containers", () => ({ getContainer: vi.fn(() => ({ fetch: mocks.containerFetch })) }));
vi.mock("../src/crypto", () => ({ decryptSourceUrl: mocks.decryptSourceUrl }));
vi.mock("../src/notices", () => ({ ensureWaitingNotice: mocks.ensureWaitingNotice }));

import {
  claimDeliverySending,
  claimDispatchIntentForJob,
  createJobWithUpdateReservation,
  getDispatchIntent,
  getJob,
  getJobDelivery,
} from "../src/db";
import type { D1BatchDatabaseLike, Env } from "../src/types";
import { MediaJobWorkflow } from "../src/workflow";
import { localD1 } from "./helpers/local-d1";

const JOB_ID = "123e4567-e89b-12d3-a456-426614174000";
const CREATED_AT = "2026-01-01T00:00:00.000Z";

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function env(db: D1BatchDatabaseLike): Env {
  return {
    DB: db,
    DOWNLOADER_CONTAINER: {},
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    INTERNAL_CONTAINER_SECRET: "internal-secret",
    ALLOWED_TELEGRAM_USER_IDS: "12345",
    DOWNLOAD_LINK_HMAC_SECRET: "download-hmac",
    ALLOWED_SOURCE_HOSTS: "youtube.com,youtu.be",
    DEFAULT_MAX_HEIGHT: "1080",
    R2_RETENTION_SECONDS: "86400",
    PUBLIC_WORKER_BASE_URL: "https://worker.example",
  } as unknown as Env;
}

function workflowFor(workerEnv: Env): MediaJobWorkflow {
  const workflow = Object.create(MediaJobWorkflow.prototype) as MediaJobWorkflow & { env: Env };
  workflow.env = workerEnv;
  return workflow;
}

/** Cache successful step returns by deterministic name, like Workflows. */
class CachedStep {
  readonly cache = new Map<string, unknown>();

  constructor(
    private readonly prior?: Map<string, unknown>,
    private readonly loseCheckpoint?: string,
    private readonly afterCallback?: (name: string) => Promise<void>,
  ) {}

  async do<T>(name: string, optionsOrCallback: unknown, maybeCallback?: (context: unknown) => Promise<T>): Promise<T> {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback as (context: unknown) => Promise<T> : maybeCallback;
    if (!callback) throw new Error(`missing callback for ${name}`);
    const prior = this.prior?.get(name);
    if (prior !== undefined) return prior as T;
    const value = await callback({ attempt: 1, step: { name, count: 1 }, config: { retries: { limit: 0 } } });
    await this.afterCallback?.(name);
    if (name === this.loseCheckpoint) throw new Error("lost step checkpoint after external send");
    this.cache.set(name, value);
    return value;
  }

  async sleep(): Promise<void> {}
}

describe("real D1 Workflow named-step replay boundary", () => {
  let db: D1BatchDatabaseLike;
  let dispose: () => Promise<void>;

  beforeEach(async () => {
    ({ db, dispose } = await localD1());
    mocks.containerFetch.mockReset();
    mocks.containerFetch.mockImplementation(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/v1/jobs/run")) {
        return response({
          status: "prepared",
          delivery: "telegram",
          objectKey: `staged/${JOB_ID}/video.mp4`,
          filename: "video.mp4",
          mimeType: "video/mp4",
          sizeBytes: 100,
        });
      }
      return response({ status: "completed", telegramMessageId: String(900 + mocks.containerFetch.mock.calls.length) });
    });
    vi.stubGlobal("fetch", vi.fn(async () => response({ ok: true, result: true })));
    await createJobWithUpdateReservation(db, {
      id: JOB_ID,
      telegramUpdateId: "42",
      telegramUserId: "12345",
      telegramChatId: "12345",
      requestMessageId: "7",
      sourceHost: "youtu.be",
      sourceUrlHash: "hash",
      sourceUrlEncrypted: "v1.encrypted",
      requestedMode: "video",
      requestedQuality: "max-1080p",
      createdAt: CREATED_AT,
    }, { maxActiveJobs: 10, maxJobsPerHour: 10, hourlyWindowStart: "2025-12-31T00:00:00.000Z" });
    await claimDispatchIntentForJob(db, JOB_ID, new Date(CREATED_AT));
    await db.prepare("UPDATE job_dispatch_intents SET state = 'started', generation = 1 WHERE job_id = ?1").bind(JOB_ID).run();
    await db.prepare("UPDATE jobs SET waiting_message_id = '8' WHERE id = ?1").bind(JOB_ID).run();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await dispose?.();
  });

  it("does not repeat delivery when the effect commits but its step checkpoint is lost", async () => {
    const worker = workflowFor(env(db));
    const first = new CachedStep(undefined, "container Telegram delivery");
    const firstResult = await worker.run({ payload: { jobId: JOB_ID } } as never, first as never);
    expect(firstResult).toMatchObject({ status: "unknown", reason: "container_delivery_workflow_timeout" });
    expect(await getJobDelivery(db, JOB_ID)).toMatchObject({ state: "unknown" });

    const replayResult = await worker.run(
      { payload: { jobId: JOB_ID } } as never,
      new CachedStep(first.cache) as never,
    );

    expect(replayResult).toMatchObject({ status: "unknown" });
    expect(mocks.containerFetch.mock.calls.filter(([request]) => new URL((request as Request).url).pathname.endsWith("/v1/jobs/deliver"))).toHaveLength(1);
  });

  it("uses an out-of-band confirmed receipt instead of replaying a cached stale delivery read", async () => {
    const worker = workflowFor(env(db));
    const first = new CachedStep(undefined, "container Telegram delivery");
    await worker.run({ payload: { jobId: JOB_ID } } as never, first as never);
    await db.prepare(
      "UPDATE job_deliveries SET state = 'confirmed', telegram_message_id = '999', method = 'telegram' WHERE job_id = ?1",
    ).bind(JOB_ID).run();

    const replayResult = await worker.run(
      { payload: { jobId: JOB_ID } } as never,
      new CachedStep(first.cache) as never,
    );

    expect(replayResult).toMatchObject({ status: "completed", messageId: "999" });
    expect(mocks.containerFetch.mock.calls.filter(([request]) => new URL((request as Request).url).pathname.endsWith("/v1/jobs/deliver"))).toHaveLength(1);
    expect(await getJobDelivery(db, JOB_ID)).toMatchObject({ state: "confirmed", telegram_message_id: "999" });
  });

  it("does not let a stale Workflow failure release the newer generation's admission", async () => {
    mocks.containerFetch.mockImplementation(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/v1/jobs/run")) {
        return response({
          status: "failure",
          errorCode: "MEDIA_UNAVAILABLE",
          safeMessage: "The source media is unavailable.",
          retryable: false,
        });
      }
      throw new Error("delivery must not run");
    });
    const step = new CachedStep(undefined, undefined, async (name) => {
      if (name !== "load job state") return;
      await db.prepare(
        "UPDATE job_dispatch_intents SET state = 'started', generation = 2 WHERE job_id = ?1",
      ).bind(JOB_ID).run();
    });

    await expect(workflowFor(env(db)).run({ payload: { jobId: JOB_ID } } as never, step as never)).rejects.toThrow();

    await expect(getDispatchIntent(db, JOB_ID)).resolves.toMatchObject({ state: "started", generation: 2 });
    await expect(getJobDelivery(db, JOB_ID)).resolves.toMatchObject({ state: "not_started", owner_generation: null });
    await expect(getJob(db, JOB_ID)).resolves.not.toMatchObject({ status: "failed" });
    await expect(db.prepare("SELECT COUNT(*) AS count FROM active_job_admissions WHERE job_id = ?1").bind(JOB_ID).first()).resolves.toEqual({ count: 1 });
    await expect(claimDeliverySending(db, JOB_ID, 2)).resolves.toBe(true);
  });
});

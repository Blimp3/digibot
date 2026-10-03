import { beforeEach, describe, expect, it, vi } from "vitest";
import type { D1BatchDatabaseLike, D1BatchResultLike, D1PreparedStatementLike, DispatchIntentRecord, Env, JobDeliveryRecord, JobRecord } from "../src/types";

const mocks = vi.hoisted(() => ({
  decryptSourceUrl: vi.fn(async () => "https://youtu.be/example"),
  getContainer: vi.fn(),
  ensureWaitingNotice: vi.fn(),
  dispatchQueuedJobs: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    readonly env: unknown;

    constructor(env: unknown) {
      this.env = env;
    }
  },
}));
vi.mock("@cloudflare/containers", () => ({ getContainer: mocks.getContainer }));
vi.mock("../src/crypto", () => ({ decryptSourceUrl: mocks.decryptSourceUrl }));
vi.mock("../src/notices", () => ({ ensureWaitingNotice: mocks.ensureWaitingNotice }));
vi.mock("../src/dispatch", () => ({ dispatchQueuedJobs: mocks.dispatchQueuedJobs }));

import { createJobDeadlineAt, MediaJobWorkflow, parseDeliveryResult } from "../src/workflow";
import { ApplicationError } from "../src/errors";

const JOB_ID = "123e4567-e89b-12d3-a456-426614174000";

const baseJob: JobRecord = {
  id: JOB_ID,
  telegram_update_id: "42",
  telegram_user_id: "12345",
  telegram_chat_id: "12345",
  request_message_id: "7",
  waiting_message_id: "8",
  result_message_id: null,
  source_host: "youtu.be",
  source_url_hash: "hash",
  source_url_encrypted: "v1.encrypted",
  requested_mode: "video",
  requested_operation: "download",
  requested_quality: "max-1080p",
  processing_policy_version: "v1",
  cache_valid: 1,
  status: "received",
  progress: 0,
  output_filename: null,
  output_mime_type: null,
  output_size_bytes: null,
  output_duration_seconds: null,
  r2_object_key: null,
  error_code: null,
  safe_error_message: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  completed_at: null,
  expires_at: null,
  deadline_at: null,
};

class FakeD1 implements D1BatchDatabaseLike {
  row: JobRecord = structuredClone(baseJob);
  reusableJob: JobRecord | null = null;
  delivery: JobDeliveryRecord = {
    job_id: JOB_ID,
    state: "not_started",
    method: null,
    telegram_message_id: null,
    retry_after_seconds: null,
    object_key: null,
    filename: null,
    mime_type: null,
    size_bytes: null,
    expires_at: null,
    unknown_reason: null,
    owner_generation: null,
    created_at: baseJob.created_at,
    updated_at: baseJob.updated_at,
  };
  dispatch: DispatchIntentRecord = {
    job_id: JOB_ID,
    state: "started",
    generation: 1,
    attempts: 1,
    available_at: baseJob.created_at,
    lease_expires_at: null,
    workflow_instance_id: JOB_ID,
    last_error_code: null,
    last_error_message: null,
    created_at: baseJob.created_at,
    updated_at: baseJob.updated_at,
  };
  failCompletionWrites = false;

  async batch(statements: D1PreparedStatementLike[]): Promise<D1BatchResultLike[]> {
    return Promise.all(statements.map(async (statement) => {
      const row = await statement.first<Record<string, unknown>>();
      return { success: true, results: row ? [row] : [] };
    }));
  }

  prepare(query: string): D1PreparedStatementLike {
    const values: unknown[] = [];
    const statement: D1PreparedStatementLike = {
      bind: (...next) => {
        values.push(...next);
        return statement;
      },
      first: async <T>() => {
        if (query.includes("FROM jobs") && query.includes("source_url_hash = ?3")) return this.reusableJob as T | null;
        if (query.includes("FROM job_deliveries")) return this.delivery as T;
        if (query.includes("FROM job_dispatch_intents")) return this.dispatch as T;
        if (query.includes("FROM jobs WHERE id")) return this.row as T;
        return null;
      },
      all: async <T>() => ({ results: [] as T[] }),
      run: async () => {
        if (this.failCompletionWrites && values.includes("completed")) throw new Error("D1 unavailable");
        if (query.includes("UPDATE job_dispatch_intents")) {
          if (query.includes("state = 'started'")) this.dispatch = { ...this.dispatch, state: "started", workflow_instance_id: String(values[0]) };
          if (query.includes("state = 'complete'")) this.dispatch = { ...this.dispatch, state: "complete" };
          return { success: true, meta: { changes: 1 } };
        }
        if (query.includes("UPDATE job_deliveries")) {
          if (query.includes("SET state = 'sending'")) {
            const claimed = this.delivery.job_id === values[0]
              && this.delivery.state === "not_started"
              && this.dispatch.job_id === values[0]
              && this.dispatch.generation === values[1]
              && (this.dispatch.state === "leased" || this.dispatch.state === "started");
            if (claimed) this.delivery = { ...this.delivery, state: "sending", owner_generation: Number(values[1]) };
            return { success: true, meta: { changes: claimed ? 1 : 0 } };
          }
          if (query.includes("SET state = 'not_started'")) this.delivery = { ...this.delivery, state: "not_started", owner_generation: null };
          if (query.includes("state = 'confirmed'")) this.delivery = {
            ...this.delivery,
            state: "confirmed",
            method: values[1] as JobDeliveryRecord["method"],
            telegram_message_id: String(values[2]),
            telegram_message_ids: values[9] as string | null,
            retry_after_seconds: null,
            object_key: values[3] as string | null,
            filename: values[4] as string | null,
            mime_type: values[5] as string | null,
            size_bytes: values[6] as number | null,
            expires_at: values[7] as string | null,
            owner_generation: null,
          };
          if (query.includes("state = 'rejected'")) this.delivery = {
            ...this.delivery,
            state: "rejected",
            unknown_reason: String(values[1]),
            retry_after_seconds: typeof values[2] === "number" ? values[2] : null,
            owner_generation: null,
          };
          if (!query.includes("state = 'rejected'") && query.includes("state IN ('not_started', 'sending')")) this.delivery = {
            ...this.delivery,
            state: "unknown",
            retry_after_seconds: null,
            unknown_reason: String(values[1]),
          };
          return { success: true, meta: { changes: 1 } };
        }
        if (query.includes("UPDATE jobs SET")) {
          const target = this.reusableJob?.id === values[0] ? this.reusableJob : this.row;
          for (const match of query.matchAll(/([a-z0-9_]+) = \?(\d+)/gu)) {
            const column = match[1] as keyof JobRecord | undefined;
            const valueIndex = Number(match[2]) - 1;
            if (column && valueIndex >= 0 && target) (target as unknown as Record<string, unknown>)[column] = values[valueIndex];
          }
        }
        return { success: true, meta: { changes: 1 } };
      },
    };
    return statement;
  }
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function withHealth(containerFetch: (request: Request) => Promise<Response>): { fetch: (request: Request) => Promise<Response> } {
  return { fetch: async (request) => (new URL(request.url).pathname === "/health" ? response({ ok: true }) : containerFetch(request)) };
}

function env(db: FakeD1, container: { fetch: (request: Request) => Promise<Response> }): Env {
  return {
    DB: db,
    DOWNLOADER_CONTAINER: {},
    TRANSCRIPTION_CONTAINER: {},
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    INTERNAL_CONTAINER_SECRET: "internal-secret",
    ALLOWED_TELEGRAM_USER_IDS: "12345,67890",
    DOWNLOAD_LINK_HMAC_SECRET: "download-hmac",
    ALLOWED_SOURCE_HOSTS: "youtube.com,youtu.be",
    DEFAULT_MAX_HEIGHT: "1080",
    R2_RETENTION_SECONDS: "86400",
    PUBLIC_WORKER_BASE_URL: "https://worker.example",
    __container: container,
  } as unknown as Env;
}

class FakeStep {
  readonly calls: Array<{ name: string; options?: unknown }> = [];
  readonly sleeps: Array<{ name: string; duration: string | number }> = [];
  private readonly replayAfterSuccessNames = new Set<string>();
  private readonly replayedAfterSuccessNames = new Set<string>();

  constructor(
    private readonly wrapFinalErrors = false,
    private readonly throwBeforeNames: readonly string[] = [],
    private readonly throwBeforeError: Error = new Error("Attempt failed due to internal workflows error"),
  ) {}

  replayAfterSuccess(name: string): this {
    this.replayAfterSuccessNames.add(name);
    return this;
  }

  async do<T>(name: string, optionsOrCallback: unknown, maybeCallback?: (context: unknown) => Promise<T>): Promise<T> {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback as (context: unknown) => Promise<T> : maybeCallback;
    if (!callback) throw new Error(`missing callback for ${name}`);
    this.calls.push({ name, options: typeof optionsOrCallback === "function" ? undefined : optionsOrCallback });
    if (this.throwBeforeNames.includes(name)) {
      throw this.throwBeforeError;
    }
    const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback as { retries?: { limit?: number } };
    const retryLimit = Math.max(0, options?.retries?.limit ?? 0);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const context = {
          attempt: attempt + 1,
          step: { name, count: 1 },
          config: { retries: { limit: retryLimit } },
        };
        const result = await callback(context);
        if (this.replayAfterSuccessNames.has(name) && !this.replayedAfterSuccessNames.has(name)) {
          // Model a lost current-step checkpoint: earlier step results remain
          // persisted, but Workflow executes this external-effect callback again.
          this.replayedAfterSuccessNames.add(name);
          return await callback({ ...context, attempt: attempt + 2 });
        }
        return result;
      } catch (error) {
        if (attempt >= retryLimit) {
          if (this.wrapFinalErrors && error instanceof Error) {
            const wrapped = new Error("Attempt failed due to internal workflows error");
            wrapped.name = "WorkflowInternalError";
            throw wrapped;
          }
          throw error;
        }
      }
    }
  }

  async sleep(name: string, duration: string | number): Promise<void> {
    this.sleeps.push({ name, duration });
  }
}

function workflowFor(workerEnv: Env): MediaJobWorkflow {
  const workflow = Object.create(MediaJobWorkflow.prototype) as MediaJobWorkflow & { env: Env };
  workflow.env = workerEnv;
  return workflow;
}

function reusableCompletedJob(): JobRecord {
  return {
    ...structuredClone(baseJob),
    id: "223e4567-e89b-12d3-a456-426614174000",
    status: "completed",
    result_message_id: "90",
    output_filename: "video.mp4",
    output_mime_type: "video/mp4",
    output_size_bytes: 100,
    output_duration_seconds: 4,
    r2_object_key: null,
    completed_at: "2026-01-01T00:01:00.000Z",
  };
}

describe("MediaJobWorkflow delivery split", () => {
  beforeEach(() => {
    mocks.decryptSourceUrl.mockResolvedValue("https://youtu.be/example");
    mocks.getContainer.mockReset();
    mocks.ensureWaitingNotice.mockReset();
    mocks.dispatchQueuedJobs.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/deleteMessage")) return response({ ok: true, result: true });
      if (url.endsWith("/editMessageText")) return response({ ok: true, result: true });
      return response({ ok: true, result: true });
    }));
  });

  it.each([undefined, ["321"], ["321", "321"], ["322", "323"]].map((ids) => [ids] as const))("never resends an album with incomplete receipt %j", async (ids) => {
    const db = new FakeD1();
    db.row.requested_clip_ranges = '[{"startSeconds":0,"endSeconds":2},{"startSeconds":3,"endSeconds":5}]';
    const containerFetch = vi.fn()
      .mockResolvedValueOnce(response({ status: "prepared", delivery: "telegram", objectKey: `staged/${JOB_ID}/clip-0.mp4`, filename: "clips.mp4", mimeType: "video/mp4", sizeBytes: 100, duration: 4, clipCount: 2 }))
      .mockResolvedValueOnce(response({ status: "completed", delivery: "telegram", telegramMessageId: "321", telegramMessageIds: ids }));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    const workflow = workflowFor(env(db, container));
    const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, new FakeStep() as never);
    expect(result).toMatchObject({ status: "unknown" });
    expect(db.delivery.state).toBe("unknown");
    expect(containerFetch.mock.calls.filter(([input]) => (input instanceof Request ? input.url : String(input)).endsWith("/deliver"))).toHaveLength(1);
    await workflow.run({ payload: { jobId: JOB_ID } } as never, new FakeStep() as never);
    expect(containerFetch.mock.calls.filter(([input]) => (input instanceof Request ? input.url : String(input)).endsWith("/deliver"))).toHaveLength(1);
  });

  it("confirms every album ID together and never uses the single-media cache", async () => {
    const db = new FakeD1();
    db.row.requested_clip_ranges = '[{"startSeconds":0,"endSeconds":2},{"startSeconds":3,"endSeconds":5}]';
    db.reusableJob = reusableCompletedJob();
    const containerFetch = vi.fn()
      .mockResolvedValueOnce(response({ status: "prepared", delivery: "telegram", objectKey: `staged/${JOB_ID}/clip-0.mp4`, filename: "clips.mp4", mimeType: "video/mp4", sizeBytes: 100, duration: 4, clipCount: 2 }))
      .mockResolvedValueOnce(response({ status: "completed", delivery: "telegram", telegramMessageId: "321", telegramMessageIds: ["321", "322"] }));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    const step = new FakeStep();
    expect(await workflowFor(env(db, container)).run({ payload: { jobId: JOB_ID } } as never, step as never)).toMatchObject({ status: "completed", telegramMessageIds: ["321", "322"] });
    expect(db.delivery).toMatchObject({ state: "confirmed", telegram_message_ids: '["321","322"]' });
    expect(step.calls.some(({ name }) => name === "lookup reusable Telegram media" || name === "copy reusable Telegram media")).toBe(false);
  });

  it("does not accept a completed legacy pack with only its first message ID", async () => {
    const db = new FakeD1();
    db.row = { ...db.row, status: "completed", result_message_id: "321", requested_clip_ranges: '[{"startSeconds":0,"endSeconds":2},{"startSeconds":3,"endSeconds":5}]' };
    db.delivery = { ...db.delivery, state: "confirmed", method: "telegram", telegram_message_id: "321", telegram_message_ids: null };
    const containerFetch = vi.fn();
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    expect(await workflowFor(env(db, container)).run({ payload: { jobId: JOB_ID } } as never, new FakeStep() as never)).toMatchObject({ status: "unknown" });
    expect(containerFetch).not.toHaveBeenCalled();
  });

  describe("durable state early paths", () => {
    async function runEarly(mutate: (db: FakeD1) => void) {
      const db = new FakeD1();
      mutate(db);
      const containerFetch = vi.fn();
      const container = { fetch: containerFetch };
      mocks.getContainer.mockReturnValue(container);
      const step = new FakeStep();
      const result = await workflowFor(env(db, container)).run({ payload: { jobId: JOB_ID } } as never, step as never);
      expect(step.calls.map(({ name }) => name)).toEqual(["load job state"]);
      expect(containerFetch).not.toHaveBeenCalled();
      return result;
    }

    it("returns missing before touching intent or delivery", async () => {
      expect(await runEarly((db) => { db.row = null as unknown as JobRecord; })).toEqual({ status: "missing", jobId: JOB_ID });
    });

    it("reuses the batched delivery for a completed job", async () => {
      const result = await runEarly((db) => {
        db.row = { ...db.row, status: "completed", result_message_id: "77" };
        db.delivery = { ...db.delivery, state: "confirmed", method: "telegram", telegram_message_id: "321" };
      });
      expect(result).toMatchObject({ status: "completed", jobId: JOB_ID, messageId: "321", telegramMessageId: "321" });
    });

    it("returns the stored error for a failed job", async () => {
      expect(await runEarly((db) => { db.row = { ...db.row, status: "failed", error_code: "MEDIA_UNAVAILABLE" }; }))
        .toEqual({ status: "failed", jobId: JOB_ID, errorCode: "MEDIA_UNAVAILABLE" });
    });

    it("reports unknown delivery without sending", async () => {
      expect(await runEarly((db) => { db.delivery = { ...db.delivery, state: "unknown", unknown_reason: "container_delivery_workflow_timeout" }; }))
        .toEqual({ status: "unknown", jobId: JOB_ID, reason: "container_delivery_workflow_timeout" });
    });

    it("reports rejected delivery as failed with its retry hint", async () => {
      expect(await runEarly((db) => { db.delivery = { ...db.delivery, state: "rejected", retry_after_seconds: 9 }; }))
        .toEqual({ status: "failed", jobId: JOB_ID, errorCode: "TELEGRAM_UPLOAD_FAILED", retryAfterSeconds: 9 });
    });

    it.each(["dispatch", "delivery"] as const)("never sends when the %s row is missing", async (missing) => {
      expect(await runEarly((db) => { (db as unknown as Record<string, unknown>)[missing] = null; }))
        .toEqual({ status: "unknown", jobId: JOB_ID, reason: "durable_delivery_state_missing" });
    });
  });

  describe("container warm-up", () => {
    const prepared = () => response({ status: "prepared", delivery: "telegram", objectKey: `staged/${JOB_ID}/video.mp4`, filename: "video.mp4", mimeType: "video/mp4", sizeBytes: 100 });

    function coldRun(health: (request: Request) => Promise<Response>) {
      const db = new FakeD1();
      db.row.waiting_message_id = null;
      mocks.ensureWaitingNotice.mockResolvedValue({ state: "sent", messageId: "55", retryAfterSeconds: 0 });
      const healthFetch = vi.fn(health);
      const workFetch = vi.fn()
        .mockResolvedValueOnce(prepared())
        .mockResolvedValueOnce(response({ status: "completed", telegramMessageId: "321" }));
      const container = { fetch: (request: Request) => (new URL(request.url).pathname === "/health" ? healthFetch(request) : workFetch(request)) };
      mocks.getContainer.mockReturnValue(container);
      const run = () => workflowFor(env(db, container)).run({ payload: { jobId: JOB_ID } } as never, new FakeStep() as never);
      return { healthFetch, workFetch, run };
    }

    it("pings /health once for a cold job inside the notice step", async () => {
      const { healthFetch, workFetch, run } = coldRun(async () => response({ ok: true }));
      expect(await run()).toMatchObject({ status: "completed", messageId: "321" });
      expect(healthFetch).toHaveBeenCalledOnce();
      expect(healthFetch.mock.calls[0]?.[0]).toMatchObject({ method: "GET" });
      expect(workFetch).toHaveBeenCalledTimes(2);
    });

    it("does not ping when the waiting message already exists", async () => {
      const db = new FakeD1();
      const workFetch = vi.fn()
        .mockResolvedValueOnce(prepared())
        .mockResolvedValueOnce(response({ status: "completed", telegramMessageId: "321" }));
      const container = { fetch: workFetch };
      mocks.getContainer.mockReturnValue(container);
      await workflowFor(env(db, container)).run({ payload: { jobId: JOB_ID } } as never, new FakeStep() as never);
      expect(workFetch.mock.calls.filter(([request]) => new URL(request.url).pathname === "/health")).toHaveLength(0);
    });

    it("ignores a failed warm-up", async () => {
      const { run } = coldRun(async () => { throw new Error("container boot failed"); });
      expect(await run()).toMatchObject({ status: "completed", messageId: "321" });
    });

    it("stops waiting for a warm-up that never answers", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { run } = coldRun(() => new Promise<Response>(() => undefined));
        const pending = run();
        await vi.advanceTimersByTimeAsync(250);
        expect(await pending).toMatchObject({ status: "completed", messageId: "321" });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("creates an integer deadline with a five-second bookkeeping margin", () => {
    const nowMs = 1_700_000_000_123;
    expect(createJobDeadlineAt(1_200, nowMs)).toBe(1_700_001_196);
    expect(createJobDeadlineAt(1, nowMs)).toBe(1_700_000_002);
  });

  it("chunks waiting-notice sleeps at the Workflow limit without shortening a long retry", async () => {
    const db = new FakeD1();
    db.row.waiting_message_id = null;
    mocks.ensureWaitingNotice
      .mockResolvedValueOnce({ state: "pending", messageId: null, retryAfterSeconds: Number.MAX_SAFE_INTEGER })
      .mockResolvedValueOnce({ state: "pending", messageId: null, retryAfterSeconds: Number.MAX_SAFE_INTEGER })
      .mockResolvedValueOnce({ state: "sent", messageId: "55", retryAfterSeconds: 0 });
    const containerFetch = vi.fn()
      .mockResolvedValueOnce(response({
        status: "prepared",
        delivery: "telegram",
        objectKey: `staged/${JOB_ID}/video.mp4`,
        filename: "video.mp4",
        mimeType: "video/mp4",
        sizeBytes: 100,
      }))
      .mockResolvedValueOnce(response({ status: "completed", telegramMessageId: "321" }));
    const container = withHealth(containerFetch);
    mocks.getContainer.mockReturnValue(container);
    const workflow = workflowFor(env(db, container));
    const step = new FakeStep();

    const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: "completed", messageId: "321" });
    expect(step.sleeps).toEqual([
      { name: "wait for waiting notice rate limit 1", duration: "31536000 seconds" },
      { name: "wait for waiting notice rate limit 2", duration: "31536000 seconds" },
    ]);
    expect(new Set(step.sleeps.map(({ name }) => name)).size).toBe(2);
    expect(mocks.ensureWaitingNotice).toHaveBeenCalledTimes(3);
  });

  it.each(["sent", "unknown"] as const)("observes a concurrent queue notice until %s without sending a replacement", async (state) => {
    const db = new FakeD1();
    db.row = { ...db.row, status: "queued", waiting_message_id: null };
    mocks.ensureWaitingNotice
      .mockResolvedValueOnce({ state: "sending", messageId: null, retryAfterSeconds: 0 })
      .mockResolvedValueOnce({ state, messageId: state === "sent" ? "55" : null, retryAfterSeconds: 0 });
    const containerFetch = vi.fn()
      .mockResolvedValueOnce(response({ status: "prepared", delivery: "telegram", objectKey: `staged/${JOB_ID}/video.mp4`, filename: "video.mp4", mimeType: "video/mp4", sizeBytes: 100 }))
      .mockResolvedValueOnce(response({ status: "completed", telegramMessageId: "321" }));
    const container = withHealth(containerFetch);
    mocks.getContainer.mockReturnValue(container);
    const dispatchStatuses: string[] = [];
    mocks.dispatchQueuedJobs.mockImplementationOnce(async () => {
      dispatchStatuses.push(db.row.status);
      throw new Error("temporary dispatch failure");
    });
    const step = new FakeStep();

    const result = await workflowFor(env(db, container)).run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: state === "sent" ? "completed" : "unknown" });
    expect(step.sleeps.map(({ duration }) => duration)).toEqual(["1 seconds"]);
    expect(mocks.ensureWaitingNotice).toHaveBeenCalledTimes(2);
    expect(containerFetch).toHaveBeenCalledTimes(state === "sent" ? 2 : 0);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/sendMessage"))).toBe(false);
    expect(mocks.dispatchQueuedJobs).toHaveBeenCalledOnce();
    expect(dispatchStatuses).toEqual([state === "sent" ? "completed" : "queued"]);
  });

  it("retries preparation, never retries delivery, and deletes waiting only after confirmed delivery", async () => {
    const db = new FakeD1();
    const containerFetch = vi.fn()
      .mockResolvedValueOnce(response({
        status: "prepared",
        delivery: "telegram",
        objectKey: `staged/${JOB_ID}/video.mp4`,
        filename: "video.mp4",
        mimeType: "video/mp4",
        sizeBytes: 100,
      }))
      .mockResolvedValueOnce(response({ status: "completed", telegramMessageId: "321" }));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    const workerEnv = env(db, container);
    const workflow = workflowFor(workerEnv);
    const step = new FakeStep();

    const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: "completed", jobId: JOB_ID, messageId: "321" });
    expect(db.row.r2_object_key).toBeNull();
    expect(db.row.expires_at).toBeNull();
    expect(step.calls.map(({ name }) => name)).toEqual([
      "load job state",
      "mark queued",
      "lookup reusable Telegram media",
      "create job deadline",
      "persist job deadline",
      "container download and prepare",
      "record prepared result",
      "container Telegram delivery",
      "record delivery receipt",
      "mark completed",
      "delete waiting message",
      "dispatch waiting jobs",
    ]);
    expect((step.calls.find(({ name }) => name === "container download and prepare")?.options as { retries: { limit: number } }).retries.limit).toBe(3);
    expect((step.calls.find(({ name }) => name === "container download and prepare")?.options as { timeout: string }).timeout).toBe("1200 seconds");
    expect((step.calls.find(({ name }) => name === "container Telegram delivery")?.options as { retries: { limit: number } }).retries.limit).toBe(0);
    expect((step.calls.find(({ name }) => name === "mark completed")?.options as { retries: { limit: number } }).retries.limit).toBe(3);
    expect(containerFetch).toHaveBeenCalledTimes(2);
    const prepareBody = JSON.parse(String(containerFetch.mock.calls[0]?.[0] instanceof Request ? await containerFetch.mock.calls[0]?.[0].text() : ""));
    const deliveryBody = JSON.parse(String(containerFetch.mock.calls[1]?.[0] instanceof Request ? await containerFetch.mock.calls[1]?.[0].text() : ""));
    expect(prepareBody).toMatchObject({ jobId: JOB_ID, sourceUrl: "https://youtu.be/example", mode: "video" });
    expect(prepareBody).not.toHaveProperty("deadlineAt");
    expect(deliveryBody).not.toHaveProperty("deadlineAt");
    const prepareDeadlineAt = (containerFetch.mock.calls[0]?.[0] as Request).headers.get("X-DigiBot-Deadline-At");
    const deliveryDeadlineAt = (containerFetch.mock.calls[1]?.[0] as Request).headers.get("X-DigiBot-Deadline-At");
    expect(prepareDeadlineAt).toBe(deliveryDeadlineAt);
    expect(Number.isSafeInteger(Number(prepareDeadlineAt))).toBe(true);
    expect(Number(prepareDeadlineAt)).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(deliveryBody).toEqual({
      jobId: JOB_ID,
      telegramChatId: "12345",
      objectKey: `staged/${JOB_ID}/video.mp4`,
      filename: "video.mp4",
      mimeType: "video/mp4",
      sizeBytes: 100,
      mode: "video",
      deliveryMode: "telegram",
    });
    const telegramCalls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(telegramCalls.some((url) => url.endsWith("/deleteMessage"))).toBe(true);
    expect(telegramCalls.findIndex((url) => url.endsWith("/deleteMessage"))).toBeGreaterThan(-1);
  });

  it.each(["whisper", "captions"] as const)("routes %s preparation and delivery to its own container and timeout", async (method) => {
    const db = new FakeD1();
    db.row = {
      ...baseJob,
      requested_mode: "audio",
      requested_operation: "transcript",
      transcript_method: method,
      caption_language: method === "captions" ? "it" : null,
      requested_quality: "m4a",
    };
    const containerFetch = vi.fn()
      .mockResolvedValueOnce(response({
        status: "prepared",
        delivery: "telegram",
        objectKey: `staged/${JOB_ID}/Example transcript.md`,
        filename: "Example transcript.md",
        mimeType: "text/markdown",
        sizeBytes: 123,
      }))
      .mockResolvedValueOnce(response({ status: "completed", delivery: "telegram", telegramMessageId: "654" }));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    const workerEnv = env(db, container);
    const step = new FakeStep();

    const result = await workflowFor(workerEnv).run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: "completed", jobId: JOB_ID, messageId: "654" });
    expect(step.calls.map(({ name }) => name)).not.toContain("lookup reusable Telegram media");
    const binding = method === "captions" ? workerEnv.DOWNLOADER_CONTAINER : workerEnv.TRANSCRIPTION_CONTAINER;
    const timeout = method === "captions" ? "1200 seconds" : "1800 seconds";
    expect((step.calls.find(({ name }) => name === "container download and prepare")?.options as { timeout: string }).timeout).toBe(timeout);
    expect((step.calls.find(({ name }) => name === "container Telegram delivery")?.options as { timeout: string }).timeout).toBe(timeout);
    expect(mocks.getContainer).toHaveBeenCalledWith(binding, "personal");
    expect(mocks.getContainer.mock.calls).toHaveLength(2);
    for (const [actualBinding] of mocks.getContainer.mock.calls) expect(actualBinding).toBe(binding);
    const prepareBody = JSON.parse(String(containerFetch.mock.calls[0]?.[0] instanceof Request ? await containerFetch.mock.calls[0]?.[0].text() : ""));
    const deliveryBody = JSON.parse(String(containerFetch.mock.calls[1]?.[0] instanceof Request ? await containerFetch.mock.calls[1]?.[0].text() : ""));
    expect(prepareBody).toMatchObject({ operation: "transcript", mode: "audio", preferredFormat: "m4a", deadlineAt: expect.any(Number) });
    expect(deliveryBody).toMatchObject({ operation: "transcript", deliveryMode: "telegram", deadlineAt: prepareBody.deadlineAt });
    if (method === "captions") {
      expect(prepareBody).toMatchObject({ transcriptMethod: "captions", captionLanguage: "it" });
      expect(deliveryBody).toMatchObject({ transcriptMethod: "captions", captionLanguage: "it" });
    }
  });

  it("uses R2-link delivery metadata without changing the waiting-message owner", async () => {
    const db = new FakeD1();
    const containerFetch = vi.fn()
      .mockResolvedValueOnce(response({
        status: "prepared",
        delivery: "r2",
        objectKey: `jobs/${JOB_ID}/video.mp4`,
        filename: "video.mp4",
        mimeType: "video/mp4",
        sizeBytes: 50_000_000,
      }))
      .mockResolvedValueOnce(response({ status: "completed", delivery: "r2", telegramMessageId: "654", objectKey: `jobs/${JOB_ID}/video.mp4` }));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    const workflow = workflowFor(env(db, container));
    const step = new FakeStep();

    await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    const deliveryBody = JSON.parse(String(containerFetch.mock.calls[1]?.[0] instanceof Request ? await containerFetch.mock.calls[1]?.[0].text() : ""));
    expect(deliveryBody).toMatchObject({
      objectKey: `jobs/${JOB_ID}/video.mp4`,
      sizeBytes: 50_000_000,
      deliveryMode: "r2",
    });
    expect(db.row.r2_object_key).toBe(`jobs/${JOB_ID}/video.mp4`);
    expect(db.row.expires_at).toBeTruthy();
  });

  it("records an R2 fallback returned by final delivery", async () => {
    const db = new FakeD1();
    const fallbackKey = `jobs/${JOB_ID}/video.mp4`;
    const containerFetch = vi.fn()
      .mockResolvedValueOnce(response({
        status: "prepared",
        delivery: "telegram",
        objectKey: `staged/${JOB_ID}/video.mp4`,
        filename: "video.mp4",
        mimeType: "video/mp4",
        sizeBytes: 100,
      }))
      .mockResolvedValueOnce(response({ status: "completed", delivery: "r2", telegramMessageId: "987", objectKey: fallbackKey }));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    const workflow = workflowFor(env(db, container));
    const step = new FakeStep();

    await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(db.row.r2_object_key).toBe(fallbackKey);
    expect(db.row.expires_at).toBeTruthy();
  });

  it("omits invalid optional delivery metadata while preserving the Telegram receipt", async () => {
    const db = new FakeD1();
    const containerFetch = vi.fn()
      .mockResolvedValueOnce(response({
        status: "prepared",
        delivery: "telegram",
        objectKey: `staged/${JOB_ID}/video.mp4`,
        filename: "video.mp4",
        mimeType: "video/mp4",
        sizeBytes: 100,
      }))
      .mockResolvedValueOnce(response({
        status: "completed",
        delivery: "telegram",
        telegramMessageId: "765",
        objectKey: `jobs/other-job/private.bin`,
        filename: "video.mp4",
        mimeType: "not a mime",
        sizeBytes: Number.MAX_SAFE_INTEGER + 1,
        expiresAt: "not-a-date",
      }));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    const workflow = workflowFor(env(db, container));
    const step = new FakeStep();

    const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: "completed", messageId: "765" });
    expect(db.row.result_message_id).toBe("765");
    expect(db.row.r2_object_key).toBeNull();
    expect(db.row.output_mime_type).toBe("video/mp4");
    expect(db.row.output_size_bytes).toBe(100);
  });

  it("edits the waiting message on delivery failure and does not delete it", async () => {
    const db = new FakeD1();
    const containerFetch = vi.fn()
      .mockResolvedValueOnce(response({
        status: "prepared",
        delivery: "telegram",
        objectKey: `staged/${JOB_ID}/video.mp4`,
        filename: "video.mp4",
        mimeType: "video/mp4",
        sizeBytes: 100,
      }))
      .mockResolvedValueOnce(response({ status: "failed", outcome: "rejected", errorCode: "TELEGRAM_UPLOAD_FAILED", safeMessage: "Telegram did not accept the processed media.", retryable: false }, 400));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    const workflow = workflowFor(env(db, container));
    const step = new FakeStep();

    const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: "failed", errorCode: "TELEGRAM_UPLOAD_FAILED" });
    expect(db.row.status).toBe("failed");
    const telegramCalls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(telegramCalls.some((url) => url.endsWith("/editMessageText"))).toBe(true);
    expect(telegramCalls.some((url) => url.endsWith("/deleteMessage"))).toBe(false);
    expect(step.calls.some(({ name }) => name === "delete waiting message")).toBe(false);
  });

  it("persists a valid final-delivery 429 delay without scheduling a resend", async () => {
    const db = new FakeD1();
    const containerFetch = vi.fn()
      .mockResolvedValueOnce(response({
        status: "prepared",
        delivery: "telegram",
        objectKey: `staged/${JOB_ID}/video.mp4`,
        filename: "video.mp4",
        mimeType: "video/mp4",
        sizeBytes: 100,
      }))
      .mockResolvedValueOnce(response({
        status: "failed",
        outcome: "rejected",
        errorCode: "TELEGRAM_RATE_LIMITED",
        retryAfterSeconds: 86_401,
        retryable: false,
      }, 429));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    const workflow = workflowFor(env(db, container));
    const step = new FakeStep(true);

    const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: "failed", errorCode: "TELEGRAM_RATE_LIMITED", retryAfterSeconds: 86_401 });
    expect(db.delivery).toMatchObject({ state: "rejected", retry_after_seconds: 86_401 });
    expect(containerFetch).toHaveBeenCalledTimes(2);
  });

  it("drops retry metadata from a non-rate-limit delivery rejection", () => {
    expect(parseDeliveryResult({
      status: "failed",
      outcome: "rejected",
      errorCode: "R2_UPLOAD_FAILED",
      retryAfterSeconds: 86_401,
    }, JOB_ID)).toMatchObject({ status: "failed", errorCode: "R2_UPLOAD_FAILED" });
    const ambiguousRateLimit = parseDeliveryResult({
      status: "failed",
      outcome: "ambiguous",
      errorCode: "TELEGRAM_RATE_LIMITED",
      retryAfterSeconds: 86_401,
    }, JOB_ID);
    expect(ambiguousRateLimit).toMatchObject({ status: "failed", errorCode: "TELEGRAM_RATE_LIMITED" });
    expect(ambiguousRateLimit).not.toHaveProperty("retryAfterSeconds");
    expect(parseDeliveryResult({
      status: "failed",
      outcome: "rejected",
      errorCode: "R2_UPLOAD_FAILED",
      retryAfterSeconds: 86_401,
    }, JOB_ID)).not.toHaveProperty("retryAfterSeconds");
  });

  it("keeps an ambiguous Container delivery response unknown without a replay", async () => {
    const db = new FakeD1();
    const containerFetch = vi.fn()
      .mockResolvedValueOnce(response({
        status: "prepared",
        delivery: "telegram",
        objectKey: `staged/${JOB_ID}/video.mp4`,
        filename: "video.mp4",
        mimeType: "video/mp4",
        sizeBytes: 100,
      }))
      .mockResolvedValueOnce(response({
        status: "failed",
        outcome: "ambiguous",
        errorCode: "TELEGRAM_UPLOAD_FAILED",
        safeMessage: "Telegram delivery outcome is unknown.",
        retryable: false,
      }, 503));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    const workflow = workflowFor(env(db, container));
    const step = new FakeStep();

    const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: "unknown", jobId: JOB_ID });
    expect(db.delivery.state).toBe("unknown");
    expect(db.row.status).toBe("uploading");
    expect(containerFetch).toHaveBeenCalledTimes(2);
    expect(step.calls.some(({ name }) => name === "record failure")).toBe(false);
  });

  it("treats an unclassified Container delivery failure as unknown", async () => {
    const db = new FakeD1();
    const containerFetch = vi.fn()
      .mockResolvedValueOnce(response({
        status: "prepared",
        delivery: "telegram",
        objectKey: `staged/${JOB_ID}/video.mp4`,
        filename: "video.mp4",
        mimeType: "video/mp4",
        sizeBytes: 100,
      }))
      .mockResolvedValueOnce(response({ status: "failed", errorCode: "TELEGRAM_UPLOAD_FAILED" }, 500));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    const workflow = workflowFor(env(db, container));
    const step = new FakeStep();

    const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: "unknown", jobId: JOB_ID });
    expect(db.delivery.state).toBe("unknown");
    expect(db.row.status).toBe("uploading");
  });

  it("keeps a final send unknown when the Workflow wraps the delivery step", async () => {
    const db = new FakeD1();
    const containerFetch = vi.fn().mockResolvedValue(response({
      status: "prepared",
      delivery: "telegram",
      objectKey: `staged/${JOB_ID}/video.mp4`,
      filename: "video.mp4",
      mimeType: "video/mp4",
      sizeBytes: 100,
    }));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    const workflow = workflowFor(env(db, container));
    const step = new FakeStep(true, ["container Telegram delivery"]);

    const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: "unknown", jobId: JOB_ID, reason: "container_delivery_workflow_timeout" });
    expect(db.delivery).toMatchObject({ state: "unknown", unknown_reason: "container_delivery_workflow_timeout" });
    expect(db.row.status).toBe("processing");
    expect(containerFetch).toHaveBeenCalledTimes(1);
  });

  it("does not repeat final delivery when Workflow replays a successful effect callback", async () => {
    const db = new FakeD1();
    const containerFetch = vi.fn()
      .mockResolvedValueOnce(response({
        status: "prepared",
        delivery: "r2",
        objectKey: `jobs/${JOB_ID}/video.mp4`,
        filename: "video.mp4",
        mimeType: "video/mp4",
        sizeBytes: 50_000_000,
      }))
      .mockResolvedValue(response({
        status: "completed",
        delivery: "r2",
        telegramMessageId: "654",
        objectKey: `jobs/${JOB_ID}/video.mp4`,
      }));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    const workflow = workflowFor(env(db, container));
    const step = new FakeStep().replayAfterSuccess("container Telegram delivery");

    const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: "unknown", jobId: JOB_ID });
    expect(db.delivery.state).toBe("unknown");
    expect(containerFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps preparation unknown when a Workflow wraps an ApplicationError before the Container result", async () => {
    const db = new FakeD1();
    const containerFetch = vi.fn().mockResolvedValue(response({
      status: "prepared",
      delivery: "telegram",
      objectKey: `staged/${JOB_ID}/video.mp4`,
      filename: "video.mp4",
      mimeType: "video/mp4",
      sizeBytes: 100,
    }));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    const workflow = workflowFor(env(db, container));
    const step = new FakeStep(false, ["container download and prepare"], new ApplicationError("INTERNAL_ERROR"));

    const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: "unknown", jobId: JOB_ID, reason: "container_prepare_workflow_timeout" });
    expect(db.delivery).toMatchObject({ state: "unknown", unknown_reason: "container_prepare_workflow_timeout" });
    expect(db.row.status).toBe("queued");
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it("does not retry a permanent preparation result", async () => {
    const db = new FakeD1();
    const containerFetch = vi.fn().mockResolvedValue(response({
      status: "failed",
      errorCode: "DURATION_LIMIT",
      safeMessage: "That media is longer than the configured limit.",
      retryable: false,
    }, 400));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    const workflow = workflowFor(env(db, container));
    const step = new FakeStep();

    const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: "failed", errorCode: "DURATION_LIMIT" });
    expect(containerFetch).toHaveBeenCalledTimes(1);
    expect(step.calls.some(({ name }) => name === "container Telegram delivery")).toBe(false);
  });

  it("logs bounded probe diagnostics without retrying or delivering the failed preparation", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const db = new FakeD1();
    const containerFetch = vi.fn().mockResolvedValue(response({
      status: "failed", errorCode: "MEDIA_UNAVAILABLE", safeMessage: "source failure", retryable: true,
      diagnostics: {
        error_stage: "probe", failure_reason: "js_challenge_failed", process_name: "yt-dlp",
        process_exit_code: 1, process_timed_out: false,
        stderr: "https://private.invalid/?token=secret", cookies: "private cookies",
      },
    }, 400));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    const step = new FakeStep();
    const result = await workflowFor(env(db, container)).run({ payload: { jobId: JOB_ID } } as never, step as never);
    expect(result).toMatchObject({ status: "failed", errorCode: "MEDIA_UNAVAILABLE" });
    expect(containerFetch).toHaveBeenCalledTimes(1);
    expect(step.calls.some(({ name }) => name === "container Telegram delivery")).toBe(false);
    const logs = output.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(logs.find((line) => line.event === "media_container_prepare_failed")).toMatchObject({
      job_id: JOB_ID, error_code: "MEDIA_UNAVAILABLE", error_stage: "container_prepare",
      container_error_stage: "probe", container_failure_reason: "js_challenge_failed",
      process_name: "yt-dlp", process_exit_code: 1, process_timed_out: false,
    });
    expect(JSON.stringify(logs)).not.toMatch(/private\.invalid|secret|private cookies/u);
    expect(result).not.toHaveProperty("diagnostics");
    output.mockRestore();
  });

  it.each(["MEDIA_UNAVAILABLE", "LOGIN_REQUIRED", "MEDIA_PRIVATE"] as const)(
    "does not retry a permanent %s result even when the container retry flag is wrong",
    async (errorCode) => {
      const db = new FakeD1();
      const containerFetch = vi.fn().mockResolvedValue(response({
        status: "failed",
        errorCode,
        safeMessage: "source failure",
        retryable: true,
      }, 400));
      const container = { fetch: containerFetch };
      mocks.getContainer.mockReturnValue(container);
      const workflow = workflowFor(env(db, container));
      const step = new FakeStep();

      const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

      expect(result).toMatchObject({ status: "failed", errorCode });
      expect(containerFetch).toHaveBeenCalledTimes(1);
      expect(step.calls.some(({ name }) => name === "container Telegram delivery")).toBe(false);
    },
  );

  it("retries an explicitly transient preparation failure and then delivers", async () => {
    const db = new FakeD1();
    const containerFetch = vi.fn()
      .mockResolvedValueOnce(response({
        status: "failed",
        errorCode: "DOWNLOAD_TIMEOUT",
        safeMessage: "The source took too long to download.",
        retryable: true,
      }, 503))
      .mockResolvedValueOnce(response({
        status: "prepared",
        delivery: "telegram",
        objectKey: `staged/${JOB_ID}/video.mp4`,
        filename: "video.mp4",
        mimeType: "video/mp4",
        sizeBytes: 100,
      }))
      .mockResolvedValueOnce(response({ status: "completed", telegramMessageId: "321" }));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    const workflow = workflowFor(env(db, container));
    const step = new FakeStep();

    const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: "completed", messageId: "321" });
    expect(containerFetch).toHaveBeenCalledTimes(3);
  });

  it("bounds a stalled Container response body by the same preparation deadline", async () => {
    const db = new FakeD1();
    const stalledResponse = response({ status: "prepared" });
    vi.spyOn(stalledResponse, "json").mockImplementation(() => new Promise<never>(() => {}));
    const containerFetch = vi.fn().mockResolvedValue(stalledResponse);
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    const workerEnv = env(db, container);
    (workerEnv as unknown as Record<string, unknown>).JOB_TIMEOUT_SECONDS = "1";
    const workflow = workflowFor(workerEnv);
    const step = new FakeStep();

    const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: "unknown", jobId: JOB_ID, reason: "container_prepare_deadline_expired" });
    expect(containerFetch).toHaveBeenCalledTimes(1);
    expect(db.delivery).toMatchObject({ state: "unknown", unknown_reason: "container_prepare_deadline_expired" });
    expect(db.row.status).toBe("downloading");
    expect(step.calls.some(({ name }) => name === "container Telegram delivery")).toBe(false);

    const replay = await workflow.run({ payload: { jobId: JOB_ID } } as never, new FakeStep() as never);
    expect(replay).toMatchObject({ status: "unknown", jobId: JOB_ID });
    expect(containerFetch).toHaveBeenCalledTimes(1);
  });

  it("preserves the last transient error when Workflow wraps an exhausted step", async () => {
    const db = new FakeD1();
    const containerFetch = vi.fn(async () => response({
      status: "failed",
      errorCode: "DOWNLOAD_TIMEOUT",
      safeMessage: "The source took too long to download.",
      retryable: true,
    }, 503));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    const workflow = workflowFor(env(db, container));
    const step = new FakeStep(true);

    const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: "failed", errorCode: "DOWNLOAD_TIMEOUT" });
    expect(containerFetch).toHaveBeenCalledTimes(4);
  });

  it("copies a same-user completed media result without invoking the container", async () => {
    const db = new FakeD1();
    db.reusableJob = reusableCompletedJob();
    const containerFetch = vi.fn(async () => response({}));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/copyMessage")) return response({ ok: true, result: { message_id: 901 } });
      if (url.endsWith("/deleteMessage")) return response({ ok: true, result: true });
      return response({ ok: true, result: true });
    }));
    const workflow = workflowFor(env(db, container));
    const step = new FakeStep();

    const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: "completed", messageId: "901" });
    expect(containerFetch).not.toHaveBeenCalled();
    expect(step.calls.some(({ name }) => name === "copy reusable Telegram media")).toBe(true);
    expect(db.row.output_filename).toBe("video.mp4");
    expect(db.row.output_size_bytes).toBe(100);
  });

  it("prepares uploaded media without a cache lookup and purges its encrypted descriptor after delivery", async () => {
    const db = new FakeD1();
    db.row.source_kind = "telegram_file";
    db.row.source_host = "telegram";
    db.row.cache_valid = 0;
    db.reusableJob = reusableCompletedJob();
    mocks.decryptSourceUrl.mockResolvedValue(JSON.stringify({ fileId: "private-file", fileSize: 1200, fileName: "recording.mp4" }));
    const containerFetch = vi.fn()
      .mockResolvedValueOnce(response({ status: "prepared", delivery: "telegram", objectKey: `staged/${JOB_ID}/video.mp4`,
        filename: "video.mp4", mimeType: "video/mp4", sizeBytes: 100 }))
      .mockResolvedValueOnce(response({ status: "completed", telegramMessageId: "902" }));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    const step = new FakeStep();
    const result = await workflowFor(env(db, container)).run({ payload: { jobId: JOB_ID } } as never, step as never);
    expect(result).toMatchObject({ status: "completed", messageId: "902" });
    expect(step.calls.some(({ name }) => name === "lookup reusable Telegram media" || name === "copy reusable Telegram media")).toBe(false);
    expect(containerFetch).toHaveBeenCalledTimes(2);
    const body = await (containerFetch.mock.calls[0]![0] as Request).json();
    expect(body).toMatchObject({ telegramFile: { fileId: "private-file", fileSize: 1200, fileName: "recording.mp4" } });
    expect(body).not.toHaveProperty("sourceUrl");
    expect(db.row).toMatchObject({ source_kind: "telegram_file", source_url_encrypted: null, cache_valid: 0 });
  });

  it("evicts a stale copied result after Telegram 400 and uses the cold pipeline", async () => {
    const db = new FakeD1();
    db.reusableJob = reusableCompletedJob();
    const containerFetch = vi.fn()
      .mockResolvedValueOnce(response({
        status: "prepared",
        delivery: "telegram",
        objectKey: `staged/${JOB_ID}/video.mp4`,
        filename: "video.mp4",
        mimeType: "video/mp4",
        sizeBytes: 100,
      }))
      .mockResolvedValueOnce(response({ status: "completed", telegramMessageId: "902" }));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/copyMessage")) return response({ ok: false, error_code: 400, description: "message to copy not found" }, 400);
      if (url.endsWith("/deleteMessage")) return response({ ok: true, result: true });
      return response({ ok: true, result: true });
    }));
    const workflow = workflowFor(env(db, container));
    const step = new FakeStep();

    const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: "completed", messageId: "902" });
    expect(containerFetch).toHaveBeenCalledTimes(2);
    expect(db.reusableJob?.result_message_id).toBe("90");
    expect(db.reusableJob?.cache_valid).toBe(0);
  });

  it("does not evict or resend after an ambiguous copy response", async () => {
    const db = new FakeD1();
    db.reusableJob = reusableCompletedJob();
    const containerFetch = vi.fn(async () => response({}));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/copyMessage")) return response({ ok: false, error_code: 400 }, 503);
      return response({ ok: true, result: true });
    }));
    const workflow = workflowFor(env(db, container));
    const step = new FakeStep();

    const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: "unknown", jobId: JOB_ID });
    expect(db.delivery.state).toBe("unknown");
    expect(db.reusableJob?.cache_valid).toBe(1);
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it("keeps a cache copy unknown when the Workflow wraps the copy step", async () => {
    const db = new FakeD1();
    db.reusableJob = reusableCompletedJob();
    const containerFetch = vi.fn(async () => response({}));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    vi.stubGlobal("fetch", vi.fn(async () => response({ ok: true, result: { message_id: 904 } })));
    const workflow = workflowFor(env(db, container));
    const step = new FakeStep(true, ["copy reusable Telegram media"]);

    const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: "unknown", jobId: JOB_ID, reason: "telegram_copy_workflow_timeout" });
    expect(db.delivery).toMatchObject({ state: "unknown", unknown_reason: "telegram_copy_workflow_timeout" });
    expect(db.reusableJob?.cache_valid).toBe(1);
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it("does not repeat a reusable copy when Workflow replays a successful effect callback", async () => {
    const db = new FakeD1();
    db.reusableJob = reusableCompletedJob();
    const containerFetch = vi.fn(async () => response({}));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/copyMessage")) return response({ ok: true, result: { message_id: 905 } });
      return response({ ok: true, result: true });
    }));
    const workflow = workflowFor(env(db, container));
    const step = new FakeStep().replayAfterSuccess("copy reusable Telegram media");

    const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: "unknown", jobId: JOB_ID });
    expect(db.delivery.state).toBe("unknown");
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/copyMessage"))).toHaveLength(1);
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it("keeps a copied receipt when completion bookkeeping fails and never invokes the container", async () => {
    const db = new FakeD1();
    db.reusableJob = reusableCompletedJob();
    db.failCompletionWrites = true;
    const containerFetch = vi.fn(async () => response({}));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/copyMessage")) return response({ ok: true, result: { message_id: 903 } });
      return response({ ok: true, result: true });
    }));
    const workflow = workflowFor(env(db, container));
    const step = new FakeStep();

    const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: "completed", messageId: "903", bookkeepingPending: true });
    expect(db.delivery).toMatchObject({ state: "confirmed", telegram_message_id: "903" });
    expect(containerFetch).not.toHaveBeenCalled();
    expect(step.calls.some(({ name }) => name === "container Telegram delivery")).toBe(false);
  });

  it("treats a stopped container after preparation as unknown and does not replay delivery", async () => {
    const db = new FakeD1();
    const containerFetch = vi.fn()
      .mockResolvedValueOnce(response({
        status: "prepared",
        delivery: "telegram",
        objectKey: `staged/${JOB_ID}/video.mp4`,
        filename: "video.mp4",
        mimeType: "video/mp4",
        sizeBytes: 100,
      }))
      .mockRejectedValueOnce(new Error("container stopped"));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    const workflow = workflowFor(env(db, container));
    const step = new FakeStep();

    const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: "unknown", jobId: JOB_ID });
    expect(db.delivery).toMatchObject({ state: "unknown" });
    expect(containerFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps confirmed delivery successful when completion bookkeeping is unavailable", async () => {
    const db = new FakeD1();
    db.failCompletionWrites = true;
    const containerFetch = vi.fn()
      .mockResolvedValueOnce(response({
        status: "prepared",
        delivery: "telegram",
        objectKey: `staged/${JOB_ID}/video.mp4`,
        filename: "video.mp4",
        mimeType: "video/mp4",
        sizeBytes: 100,
      }))
      .mockResolvedValueOnce(response({ status: "completed", telegramMessageId: "321" }));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    const workflow = workflowFor(env(db, container));
    const step = new FakeStep();

    const result = await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(result).toMatchObject({ status: "completed", jobId: JOB_ID, messageId: "321", bookkeepingPending: true });
    expect(db.row.status).toBe("uploading");
    expect(containerFetch).toHaveBeenCalledTimes(2);
    const telegramCalls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(telegramCalls.some((url) => url.endsWith("/deleteMessage"))).toBe(false);
    expect(telegramCalls.some((url) => url.endsWith("/editMessageText"))).toBe(false);
    expect(step.calls.some(({ name }) => name === "record failure")).toBe(false);
  });

  it("retains an R2 object key with an expiry when final R2 delivery fails", async () => {
    const db = new FakeD1();
    const containerFetch = vi.fn()
      .mockResolvedValueOnce(response({
        status: "prepared",
        delivery: "r2",
        objectKey: `jobs/${JOB_ID}/video.mp4`,
        filename: "video.mp4",
        mimeType: "video/mp4",
        sizeBytes: 50_000_000,
      }))
      .mockResolvedValueOnce(response({ status: "failed", outcome: "rejected", errorCode: "R2_UPLOAD_FAILED", safeMessage: "The temporary download could not be created.", retryable: false }, 400));
    const container = { fetch: containerFetch };
    mocks.getContainer.mockReturnValue(container);
    const workflow = workflowFor(env(db, container));
    const step = new FakeStep();

    await workflow.run({ payload: { jobId: JOB_ID } } as never, step as never);

    expect(db.row.status).toBe("failed");
    expect(db.row.r2_object_key).toBe(`jobs/${JOB_ID}/video.mp4`);
    expect(db.row.expires_at).toBeTruthy();
  });
});

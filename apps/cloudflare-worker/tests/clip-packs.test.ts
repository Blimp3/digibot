import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseClipRanges } from "../src/trim";
import { parseContainerResult, parseDeliveryResult } from "../src/workflow";
import { parseWorkflowResult, recoverAndReconcileDispatches } from "../src/dispatch";
import { claimDeliverySending, claimDispatchIntentForJob, createJobWithUpdateReservation, getJob, getJobDelivery, markDispatchStarted, recordDeliveryConfirmed, repairMissingDurableState, setJobCompleted } from "../src/db";
import { buildDeliveryRequest } from "../src/container-contract";
import { localD1 } from "./helpers/local-d1";
import type { D1BatchDatabaseLike, Env, JobRecord, ContainerSuccessResult } from "../src/types";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
vi.mock("@cloudflare/containers", () => ({ getContainer: vi.fn() }));

const ranges = [{ startSeconds: 20, endSeconds: 40 }, { startSeconds: 10, endSeconds: 30 }];
const id = "123e4567-e89b-42d3-a456-426614174000";
const now = new Date();
const receipt = { method: "telegram" as const, telegramMessageId: "101", telegramMessageIds: ["101", "102"] };

describe("clip pack boundaries", () => {
  it("preserves supplied order and overlapping ranges", () => {
    expect(parseClipRanges("from 00:20 to 00:40; from 00:10 to 00:30")).toEqual(ranges);
    expect(parseClipRanges("first 120 seconds; from 02:00 for 120 seconds; from 04:00 for 60 seconds")).toHaveLength(3);
  });
  it.each(["first 2 seconds", "first 2 seconds; first 2 seconds", "first 121 seconds; from 03:00 for 2 seconds", "first 120 seconds; from 02:00 for 120 seconds; from 04:00 for 61 seconds", "first 1 second; first 2 seconds; first 3 seconds; first 4 seconds"])("rejects out-of-contract ranges: %s", (input) => { expect(() => parseClipRanges(input)).toThrow(); });
  it.each([undefined, ["101"], ["101", "101"], ["102", "103"], ["101", "102", "103"], ["101", "0"]].map((ids) => [ids] as const))("rejects incomplete album receipts %j at both boundaries", (ids) => {
    const output = { status: "completed", jobId: id, delivery: "telegram", telegramMessageId: "101", telegramMessageIds: ids };
    expect(() => parseDeliveryResult(output, id, 2)).toThrow();
    expect(parseWorkflowResult(output, id, 2)).toEqual({ kind: "unknown" });
  });
  it("accepts a complete ordered album and rejects album fields on ordinary media", () => {
    const output = { status: "completed", jobId: id, delivery: "telegram", ...receipt };
    expect(parseDeliveryResult(output, id, 2)).toMatchObject({ telegramMessageIds: ["101", "102"] });
    expect(parseWorkflowResult(output, id, 2)).toMatchObject({ kind: "confirmed", delivery: { telegramMessageIds: ["101", "102"] } });
    expect(parseWorkflowResult(output, id)).toEqual({ kind: "unknown" });
    expect(() => parseDeliveryResult({ ...output, delivery: "r2" }, id, 2)).toThrow();
  });
  it("never defers a pack after an explicit rate limit", () => {
    const output = { status: "failed", jobId: id, errorCode: "TELEGRAM_RATE_LIMITED", outcome: "rejected", retryAfterSeconds: 20, retryable: false };
    expect(parseDeliveryResult(output, id, 2)).not.toHaveProperty("retryAfterSeconds");
    expect(parseWorkflowResult(output, id, 2)).not.toHaveProperty("retryAfterSeconds");
  });
  it("requires prepared album count and telegram video delivery", () => {
    const output = { status: "prepared", delivery: "telegram", objectKey: `staged/${id}/clip-0.mp4`, filename: "clips.mp4", mimeType: "video/mp4", sizeBytes: 20, duration: 40, clipCount: 2 };
    expect(parseContainerResult(output, 2)).toMatchObject({ clipCount: 2 });
    const job = { id, requested_mode: "video", requested_clip_ranges: JSON.stringify(ranges) } as JobRecord;
    expect(buildDeliveryRequest(job, output as ContainerSuccessResult)).toMatchObject({ clipRanges: ranges });
    for (const patch of [{ clipCount: undefined }, { clipCount: 3 }, { delivery: "r2" }, { mimeType: "audio/mp4" }, { mimeType: "video/webm" }, { sizeBytes: 0 }, { sizeBytes: 49_000_001 }, { duration: 240.501 }, { duration: Infinity }]) {
      expect(() => parseContainerResult({ ...output, ...patch }, 2)).toThrow();
      expect(() => buildDeliveryRequest(job, { ...output, ...patch } as ContainerSuccessResult)).toThrow();
    }
  });
});

describe("clip pack durable receipt recovery on actual D1", () => {
  let db: D1BatchDatabaseLike;
  let dispose: () => Promise<void>;
  beforeAll(async () => { ({ db, dispose } = await localD1()); }, 30_000);
  afterAll(async () => { await dispose(); });
  beforeEach(async () => {
    await db.batch([db.prepare("DELETE FROM jobs"), db.prepare("DELETE FROM processed_updates")]);
    await createJobWithUpdateReservation(db, { id, telegramUpdateId: "1", telegramUserId: "12345", telegramChatId: "12345", requestMessageId: "1", sourceHost: "youtu.be", sourceUrlHash: "hash", sourceUrlEncrypted: "v1.encrypted", requestedMode: "video", requestedQuality: "max-720p", requestedClipRanges: ranges, createdAt: now.toISOString() }, { maxActiveJobs: 5, maxJobsPerHour: 10, hourlyWindowStart: new Date(now.getTime() - 3600000).toISOString() });
  });
  it("persists ranges with cache disabled and requires the entire album for confirmation", async () => {
    expect(await getJob(db, id)).toMatchObject({ cache_valid: 0, requested_clip_ranges: JSON.stringify(ranges) });
    await claimDeliverySending(db, id, 1);
    expect(await recordDeliveryConfirmed(db, id, { ...receipt, telegramMessageIds: undefined })).toBe(false);
    expect(await recordDeliveryConfirmed(db, id, receipt)).toBe(true);
    expect(await getJobDelivery(db, id)).toMatchObject({ telegram_message_ids: '["101","102"]' });
    expect(await recordDeliveryConfirmed(db, id, receipt)).toBe(true);
    expect(await recordDeliveryConfirmed(db, id, { ...receipt, telegramMessageIds: ["101", "103"] })).toBe(false);
    expect(await setJobCompleted(db, id, { result_message_id: "101" })).toBe(true);
  });
  it.each([null, '["101","102","103"]', '["101","101"]', '["101","0"]'])("downgrades legacy incomplete receipt %s without synthesizing scalar confirmation", async (ids) => {
    await db.prepare("UPDATE jobs SET status = 'completed', result_message_id = '101' WHERE id = ?1").bind(id).run();
    await db.prepare("UPDATE job_deliveries SET state = 'confirmed', method = 'telegram', telegram_message_id = '101', telegram_message_ids = ?1 WHERE job_id = ?2").bind(ids, id).run();
    await repairMissingDurableState(db);
    expect(await getJobDelivery(db, id)).toMatchObject({ state: "unknown", unknown_reason: "clip_pack_receipt_incomplete" });
  });
  it("reconciles complete Workflow output with full ordered IDs", async () => {
    const intent = await claimDispatchIntentForJob(db, id, now, 60);
    await markDispatchStarted(db, id, intent!.generation);
    await claimDeliverySending(db, id, 1);
    const env = { DB: db, MEDIA_WORKFLOW: { get: async () => ({ id, status: async () => ({ status: "complete", output: { jobId: id, status: "completed", delivery: "telegram", ...receipt } }) }) } } as unknown as Env;
    await recoverAndReconcileDispatches(env);
    expect(await getJobDelivery(db, id)).toMatchObject({ state: "confirmed", telegram_message_ids: '["101","102"]' });
    expect(await getJob(db, id)).toMatchObject({ status: "completed" });
  });
});

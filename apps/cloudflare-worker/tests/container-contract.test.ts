import { describe, expect, it } from "vitest";
import { buildContainerDeadlineHeaders, buildDeliveryRequest, buildPrepareRequest, CONTAINER_DEADLINE_HEADER, validateTelegramFile } from "../src/container-contract";
import { errorCodeFromContainerResult } from "../src/errors";
import type { JobRecord } from "../src/types";

const job = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  telegram_update_id: "42",
  telegram_user_id: "12345",
  telegram_chat_id: "12345",
  request_message_id: "7",
  waiting_message_id: "8",
  result_message_id: null,
  source_host: "youtu.be",
  source_url_hash: "hash",
  source_url_encrypted: "v1.value",
  requested_mode: "video",
  requested_quality: "max-1080p",
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
} as JobRecord;

describe("Worker/Container two-call contract", () => {
  it("maps Container-only codes to stable Worker error codes", () => {
    expect(errorCodeFromContainerResult("SOURCE_NETWORK_BLOCKED")).toBe("SOURCE_BLOCKED_SERVER");
    expect(errorCodeFromContainerResult("TELEGRAM_AUTH_FAILED")).toBe("TELEGRAM_UPLOAD_FAILED");
    expect(errorCodeFromContainerResult("PROCESS_TIMEOUT")).toBe("PROCESSING_FAILED");
  });

  it("keeps preparation request to the accepted JobRunRequest fields", () => {
    expect(buildPrepareRequest(job, "https://youtu.be/abc", { defaultMaxHeight: 1080 })).toEqual({
      jobId: job.id,
      sourceUrl: "https://youtu.be/abc",
      telegramChatId: "12345",
      waitingMessageId: 8,
      mode: "video",
      maximumHeight: 1080,
      preferredFormat: "mp4",
    });
  });

  it.each([144, 240, 360, 480, 720, 1080])("carries stored %ip quality and clamps it to stricter global policy", (height) => {
    const selected = { ...job, requested_quality: `max-${height}p` };
    expect(buildPrepareRequest(selected, "https://youtu.be/abc", { defaultMaxHeight: 1080 }).maximumHeight).toBe(height);
    expect(buildPrepareRequest(selected, "https://youtu.be/abc", { defaultMaxHeight: 480 }).maximumHeight).toBe(Math.min(height, 480));
  });

  it("retains null/default legacy ceilings and rejects malformed stored video quality", () => {
    expect(buildPrepareRequest({ ...job, requested_quality: null }, "https://youtu.be/abc", { defaultMaxHeight: 1080 }).maximumHeight).toBe(1080);
    expect(buildPrepareRequest({ ...job, requested_quality: "max-500p" }, "https://youtu.be/abc", { defaultMaxHeight: 500 }).maximumHeight).toBe(500);
    for (const quality of ["720", "max-999999p", "max-720p-injected", "best", "constructor", "__proto__"]) {
      expect(() => buildPrepareRequest({ ...job, requested_quality: quality }, "https://youtu.be/abc", { defaultMaxHeight: 1080 })).toThrow();
    }
  });

  it("uses exactly one source field and allows Telegram files only for downloads", () => {
    const file = { fileId: "file_123", fileSize: 20_000_000, fileName: "recording.mp4" };
    const fileJob = { ...job, source_kind: "telegram_file" as const };
    const result = buildPrepareRequest(fileJob, JSON.stringify(file), { defaultMaxHeight: 1080 });
    expect(result).toMatchObject({ telegramFile: file });
    expect(result).not.toHaveProperty("sourceUrl");
    expect(buildPrepareRequest({ ...job, source_kind: "url" }, "https://youtu.be/abc", { defaultMaxHeight: 1080 })).not.toHaveProperty("telegramFile");
    expect(() => buildPrepareRequest({ ...fileJob, requested_operation: "transcript" }, JSON.stringify(file), { defaultMaxHeight: 1080 })).toThrow();
    for (const payload of ["https://youtu.be/abc", "null", "[]", JSON.stringify({ ...file, sourceUrl: "https://youtu.be/abc" }), " ".repeat(4097)]) {
      expect(() => buildPrepareRequest(fileJob, payload, { defaultMaxHeight: 1080 })).toThrow();
    }
    expect(() => buildPrepareRequest({ ...job, source_kind: "unknown" } as unknown as JobRecord, "https://youtu.be/abc", { defaultMaxHeight: 1080 })).toThrow();
  });

  it("normalizes bounded Telegram metadata and rejects strict-size or field violations", () => {
    expect(validateTelegramFile({ fileId: " file_123 ", fileSize: 1, fileName: " recording.mp4 " })).toEqual({ fileId: "file_123", fileSize: 1, fileName: "recording.mp4" });
    for (const payload of [
      { fileId: "file", fileSize: true }, { fileId: "file", fileSize: "1" }, { fileId: "file", fileSize: 1.5 },
      { fileId: "file", fileSize: 0 }, { fileId: "file", fileSize: 20_000_001 }, { fileId: "file" },
      { fileId: "file", fileSize: 1, fileName: "" }, { fileId: "file", fileSize: 1, fileName: "x".repeat(191) },
      { fileId: "x".repeat(257), fileSize: 1 }, { fileId: "a\nb", fileSize: 1 },
      { fileId: "file", fileSize: 1, fileName: "a\u007fb" }, { fileId: "file", fileSize: 1, filePath: "private/path" },
    ]) expect(() => validateTelegramFile(payload)).toThrow();
  });

  it("carries a validated trim range without changing full requests", () => {
    expect(buildPrepareRequest({ ...job, requested_start_seconds: 720, requested_end_seconds: 1020 }, "https://youtu.be/abc", { defaultMaxHeight: 1080 })).toMatchObject({
      trimStartSeconds: 720,
      trimEndSeconds: 1020,
    });
    expect(buildPrepareRequest(job, "https://youtu.be/abc", { defaultMaxHeight: 1080 })).not.toHaveProperty("trimStartSeconds");
  });

  it.each([
    [{ ...job, requested_start_seconds: 720, requested_end_seconds: null }],
    [{ ...job, requested_start_seconds: 1020, requested_end_seconds: 720 }],
    [{ ...job, requested_start_seconds: 0, requested_end_seconds: 86401 }],
  ])("rejects an invalid trim range", (invalidJob) => {
    expect(() => buildPrepareRequest(invalidJob, "https://youtu.be/abc", { defaultMaxHeight: 1080 })).toThrowError("That trim range is invalid");
  });

  it.each([
    ["m4a", "m4a"],
    ["mp3", "mp3"],
    ["best", "m4a"],
    [null, "m4a"],
  ] as const)("maps audio quality %s to %s", (requestedQuality, preferredFormat) => {
    expect(buildPrepareRequest({ ...job, requested_mode: "audio", requested_quality: requestedQuality }, "https://youtu.be/abc", { defaultMaxHeight: 1080 })).toMatchObject({
      mode: "audio",
      preferredFormat,
    });
  });

  it("carries one absolute deadline through prepare and delivery requests", () => {
    const deadlineAt = 1_700_001_196;
    const prepared = {
      status: "prepared" as const,
      delivery: "telegram" as const,
      objectKey: `staged/${job.id}/video.mp4`,
      filename: "video.mp4",
      mimeType: "video/mp4",
      sizeBytes: 100,
    };
    expect(buildPrepareRequest(job, "https://youtu.be/abc", { defaultMaxHeight: 1080 })).not.toHaveProperty("deadlineAt");
    expect(buildDeliveryRequest(job, prepared)).not.toHaveProperty("deadlineAt");
    expect(buildContainerDeadlineHeaders(deadlineAt)).toEqual({ [CONTAINER_DEADLINE_HEADER]: String(deadlineAt) });
  });

  it("sends staged artifact metadata to direct Telegram delivery", () => {
    expect(buildDeliveryRequest(job, {
      status: "completed",
      delivery: "telegram",
      objectKey: "staged/123e4567-e89b-12d3-a456-426614174000/video.mp4",
      filename: "video.mp4",
      mimeType: "video/mp4",
      sizeBytes: 100,
    })).toEqual({
      jobId: job.id,
      telegramChatId: "12345",
      objectKey: "staged/123e4567-e89b-12d3-a456-426614174000/video.mp4",
      filename: "video.mp4",
      mimeType: "video/mp4",
      sizeBytes: 100,
      mode: "video",
      deliveryMode: "telegram",
    });
  });

  it("selects R2-link delivery for an oversize prepared artifact", () => {
    expect(buildDeliveryRequest(job, {
      status: "prepared",
      delivery: "r2",
      objectKey: "jobs/123e4567-e89b-12d3-a456-426614174000/video.mp4",
      filename: "video.mp4",
      mimeType: "video/mp4",
      sizeBytes: 50_000_000,
    })).toEqual({
      jobId: job.id,
      telegramChatId: "12345",
      objectKey: "jobs/123e4567-e89b-12d3-a456-426614174000/video.mp4",
      filename: "video.mp4",
      mimeType: "video/mp4",
      sizeBytes: 50_000_000,
      mode: "video",
      deliveryMode: "r2",
    });
  });

  it("passes an opaque direct-URL handle without persisting or exposing the signed URL", () => {
    expect(buildDeliveryRequest(job, {
      status: "prepared",
      delivery: "telegram_url",
      objectKey: "opaque/direct-media-handle",
      filename: "video.mp4",
      mimeType: "video/mp4",
      sizeBytes: 100,
    })).toMatchObject({
      objectKey: "opaque/direct-media-handle",
      deliveryMode: "telegram_url",
    });
  });

  it("preserves the Container's bracketed yt-dlp basename", () => {
    const filename = "Title [abc] + {clip}.mp4";
    expect(buildDeliveryRequest(job, {
      status: "prepared",
      delivery: "telegram",
      objectKey: `staged/${job.id}/${filename}`,
      filename,
      mimeType: "video/mp4",
      sizeBytes: 100,
    })).toMatchObject({ objectKey: `staged/${job.id}/${filename}`, filename });
  });
});

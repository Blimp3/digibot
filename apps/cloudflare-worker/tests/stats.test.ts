import { describe, expect, it } from "vitest";
import { activityOutcomeForJob, activityWindow, formatUserActivityStats, statsSourceLabelForHost } from "../src/stats";
import type { ActivityJobRecord, JobState } from "../src/types";

describe("activity statistics", () => {
  it.each([
    ["youtu.be", "YouTube"],
    ["music.youtube.com", "YouTube Music"],
    ["www.instagram.com", "Instagram"],
    ["tiktok.com", "TikTok"],
    ["x.com", "X/Twitter"],
    ["vimeo.com", "Vimeo"],
    ["www.reddit.com", "Reddit"],
    ["pinterest.ca", "Pinterest"],
    ["embed.ted.com", "TED"],
    ["not-in-catalog.example", "Other/Unknown"],
    [null, "Other/Unknown"],
  ] as const)("classifies retained host %s without inventing source subtypes", (host, label) => {
    expect(statsSourceLabelForHost(host)).toBe(label);
  });

  it.each([
    ["completed", "needs_review"],
    ["failed", "needs_review"],
    ["uploading", "unfinished"],
  ] as const)("treats a sending receipt on %s as %s", (status: JobState, expected) => {
    const job: ActivityJobRecord = { id: "job", created_at: "2026-08-20T00:00:00.000Z", status,
      source_host: "youtube.com", requested_mode: "video", output_mime_type: "video/mp4", delivery_state: "sending" };
    expect(activityOutcomeForJob(job)).toBe(expected);
  });

  it("requires a recorded delivery method for a confirmed scalar receipt", () => {
    const job: ActivityJobRecord = { id: "job", created_at: "2026-08-20T00:00:00.000Z", status: "uploading",
      source_host: "youtube.com", requested_mode: "video", output_mime_type: "video/mp4",
      delivery_state: "confirmed", telegram_message_id: "101" };
    expect(activityOutcomeForJob(job)).toBe("needs_review");
    expect(activityOutcomeForJob({ ...job, delivery_method: "telegram" })).toBe("confirmed");
  });

  it("accepts only canonical nonfuture UTC cutoffs and derives an exact rolling window", () => {
    const now = new Date("2026-08-20T12:00:00.000Z");
    expect(activityWindow({}, now)).toEqual({ period: "7d", asOf: now.toISOString(), since: "2026-08-13T12:00:00.000Z", task: null });
    expect(formatUserActivityStats({ ...activityWindow({}, now), accepted: 0, confirmed: 0, failed: 0, unfinished: 0, needsReview: 0, byTask: [], bySource: [], deliveredClips: 0 })).toContain("As of: 2026-08-20 12:00:00 UTC");
    for (const asOf of ["invalid", "2026-08-20T12:00:00Z", "2026-08-20T14:00:00.000+02:00", "2026-08-20T12:00:00.001Z"]) {
      expect(() => activityWindow({ asOf }, now)).toThrow(RangeError);
    }
  });
});

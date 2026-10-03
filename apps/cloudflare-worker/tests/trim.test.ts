import { describe, expect, it } from "vitest";
import {
  formatTrimRequest,
  parseTrimTiming,
} from "../src/trim";

describe("bounded Telegram trim timing", () => {
  it.each([
    ["first 5 minutes", { startSeconds: 0, endSeconds: 300 }],
    ["first 1 hour", { startSeconds: 0, endSeconds: 3600 }],
    ["first 01:05", { startSeconds: 0, endSeconds: 65 }],
    ["from 12:00 for 5 minutes", { startSeconds: 720, endSeconds: 1020 }],
    ["from 01:02:03 for 2 seconds", { startSeconds: 3723, endSeconds: 3725 }],
    ["from 12:00 to 17:00", { startSeconds: 720, endSeconds: 1020 }],
    ["from 01:00:00 to 24:00:00", { startSeconds: 3600, endSeconds: 86400 }],
  ] as const)("parses %s", (input, range) => {
    expect(parseTrimTiming(input)).toEqual({ ok: true, range });
  });

  it.each([
    "first 0 minutes",
    "first 5",
    "first 1.5 minutes",
    "first -5 minutes",
    "first NaN minutes",
    "first 1441 minutes",
    "from 12:00 for 0 seconds",
    "from 12:00 for 5",
    "from 12:00 to 12:00",
    "from 12:00 to 11:59",
    "from 12:60 to 13:00",
    "from 1:2 to 2:00",
    "from 00:00:60 to 01:00:00",
    "from 00:01 for 24 hours",
  ])("rejects invalid timing %s without echoing it", (input) => {
    const result = parseTrimTiming(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Timing");
      expect(result.message).not.toContain(input);
    }
  });

  it("formats interpreted bounds, duration, and the shorter-media behavior", () => {
    expect(formatTrimRequest({ startSeconds: 720, endSeconds: 1020 })).toBe(
      "from 12:00 to 17:00 (5 minutes; end stops at media end if shorter)",
    );
  });
});

import { describe, expect, it, vi } from "vitest";
import { createDownloaderMiniAppStorage } from "../src/downloader-storage";
import type { D1DatabaseLike, D1PreparedStatementLike, R2BucketLike } from "../src/types";

describe("downloader Mini App storage boundary", () => {
  it("exposes fixed repository operations instead of raw DB/R2 bindings", () => {
    const statement: D1PreparedStatementLike = {
      bind: () => statement,
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ success: true, meta: { changes: 0 } }),
    };
    const db: D1DatabaseLike = { prepare: () => statement };
    const bucket: R2BucketLike = {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    };

    const storage = createDownloaderMiniAppStorage(db, bucket, "owner-1");
    expect(Object.keys(storage).sort()).toEqual([
      "deleteHistoryItem",
      "deleteHistoryMediaObject",
      "getActivityStats",
      "getHistoryItem",
      "listHistory",
      "listTerminalHistory",
    ]);
    expect(storage).not.toHaveProperty("db");
    expect(storage).not.toHaveProperty("mediaBucket");
    expect(Object.isFrozen(storage)).toBe(true);
  });

  it("binds every D1 operation to one owner and rejects arbitrary R2 keys", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db: D1DatabaseLike = {
      prepare: (sql) => {
        const call = { sql, values: [] as unknown[] };
        calls.push(call);
        const statement: D1PreparedStatementLike = {
          bind: (...values) => {
            call.values = values;
            return statement;
          },
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({ success: true, meta: { changes: 0 } }),
        };
        return statement;
      },
    };
    const deleteObject = vi.fn(async () => undefined);
    const bucket: R2BucketLike = {
      get: async () => null,
      put: async () => undefined,
      delete: deleteObject,
    };
    const storage = createDownloaderMiniAppStorage(db, bucket, "owner-1");

    await storage.listHistory({ limit: 5 });
    await storage.listTerminalHistory({ limit: 5 });
    await storage.getHistoryItem("job-a");
    await storage.deleteHistoryItem("job-a");
    expect(calls[0]?.values[0]).toBe("owner-1");
    expect(calls[1]?.values[0]).toBe("owner-1");
    expect(calls[2]?.values).toEqual(["job-a", "owner-1"]);
    expect(calls[3]?.values).toEqual(["job-a", "owner-1"]);

    await expect(storage.deleteHistoryMediaObject("job-a", "jobs/another-job/video.mp4")).resolves.toBe("invalid");
    expect(deleteObject).not.toHaveBeenCalled();
    await expect(storage.deleteHistoryMediaObject("job-a", "jobs/job-a/video.mp4")).resolves.toBe("deleted");
    expect(deleteObject).toHaveBeenCalledWith("jobs/job-a/video.mp4");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  DOWNLOADER_MINI_APP_CSS_PATH,
  DOWNLOADER_MINI_APP_JS_PATH,
} from "../src/mini-app-router";
import type { Env } from "../src/types";

vi.mock("../src/container", () => ({ DownloaderContainer: class DownloaderContainer {} }));
vi.mock("../src/workflow", () => ({ MediaJobWorkflow: class MediaJobWorkflow {} }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
vi.mock("../src/retired-durable-objects", () => ({ NewsScheduler: class NewsScheduler {} }));
const authMocks = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("../src/mini-app-auth", () => ({ authenticateMiniAppRequest: authMocks.authenticate }));
const r2Mocks = vi.hoisted(() => ({ cleanupExpiredR2Jobs: vi.fn(async () => undefined) }));
vi.mock("../src/r2", () => ({
  cleanupExpiredR2Jobs: r2Mocks.cleanupExpiredR2Jobs,
  handleDownloadRequest: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({ repair: vi.fn(async () => 0) }));
vi.mock("../src/db", async (importOriginal) => ({ ...(await importOriginal() as object), repairMissingDurableState: dbMocks.repair }));

const emptyEnv = {} as Env;
const dispatchMocks = vi.hoisted(() => ({ recover: vi.fn(async () => undefined), notices: vi.fn(async () => undefined) }));
vi.mock("../src/dispatch", () => ({ recoverAndReconcileDispatches: dispatchMocks.recover }));
vi.mock("../src/notices", () => ({ dispatchNotices: dispatchMocks.notices }));

describe("Worker public and Mini App routes", () => {
  beforeEach(() => {
    authMocks.authenticate.mockReset();
    authMocks.authenticate.mockResolvedValue(null);
    r2Mocks.cleanupExpiredR2Jobs.mockClear();
    dispatchMocks.recover.mockClear();
    dbMocks.repair.mockClear();
    dispatchMocks.notices.mockClear();
  });

  it("keeps the health response public and minimal", async () => {
    const response = await worker.fetch(new Request("https://worker.example/health"), emptyEnv);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "private-media-downloader",
      version: "5.0.0",
      versionMetadata: { id: null, tag: null, timestamp: null },
    });
  });

  it("requires existing Telegram owner authentication for exact read-only diagnostics", async () => {
    const url = "https://worker.example/api/apps/downloader/diagnostics";
    expect((await worker.fetch(new Request(url), emptyEnv)).status).toBe(401);
    expect((await worker.fetch(new Request(url, { method: "POST" }), emptyEnv)).status).toBe(405);
    expect((await worker.fetch(new Request(`${url}/extra`), emptyEnv)).status).toBe(404);
    expect((await worker.fetch(new Request("https://worker.example/internal/diagnostics"), emptyEnv)).status).toBe(404);
  });

  it("exposes immutable Cloudflare version metadata without changing the liveness contract", async () => {
    const response = await worker.fetch(new Request("https://worker.example/health"), {
      CF_VERSION_METADATA: {
        id: "version-id",
        tag: "526ec41b96e03f96c34c9e208ef43fe5bb31d716",
        timestamp: "2026-08-25T10:00:00.000Z",
      },
    } as unknown as Env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      version: "5.0.0",
      versionMetadata: {
        id: "version-id",
        tag: "526ec41b96e03f96c34c9e208ef43fe5bb31d716",
        timestamp: "2026-08-25T10:00:00.000Z",
      },
    });
  });

  it("returns ready when the bounded downloader D1 check succeeds", async () => {
    const env = {
      DB: {
        prepare: vi.fn(() => ({
          first: vi.fn(async () => ({ ready: 1 })),
        })),
      },
    } as unknown as Env;
    const response = await worker.fetch(new Request("https://worker.example/ready"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      ready: true,
      checks: { d1: true },
    });
  });

  it("returns non-2xx readiness when a dependency check fails", async () => {
    const env = {
      DB: {
        prepare: vi.fn(() => ({
          first: vi.fn(async () => { throw new Error("D1 unavailable"); }),
        })),
      },
    } as unknown as Env;
    const response = await worker.fetch(new Request("https://worker.example/ready"), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      ready: false,
      checks: { d1: false },
    });
  });

  it("serves the Mini App shell and same-origin assets", async () => {
    const html = await worker.fetch(new Request("https://worker.example/mini-app"), emptyEnv);
    const css = await worker.fetch(new Request("https://worker.example/mini-app.css"), emptyEnv);
    const js = await worker.fetch(new Request("https://worker.example/mini-app.js"), emptyEnv);

    expect(html.status).toBe(200);
    expect(html.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(js.headers.get("content-type")).toContain("javascript");
  });

  it("bounds readiness when D1 never resolves", async () => {
    vi.useFakeTimers();
    try {
      const response = worker.fetch(new Request("https://worker.example/ready"), {
        DB: { prepare: () => ({ first: () => new Promise(() => {}) }) },
      } as unknown as Env);
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await response).status).toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves canonical versioned assets with immutable caching, including HEAD", async () => {
    const html = await worker.fetch(new Request("https://worker.example/apps/downloader"), emptyEnv);
    const css = await worker.fetch(new Request(`https://worker.example${DOWNLOADER_MINI_APP_CSS_PATH}`), emptyEnv);
    const jsHead = await worker.fetch(new Request(`https://worker.example${DOWNLOADER_MINI_APP_JS_PATH}`, { method: "HEAD" }), emptyEnv);
    expect(html.status).toBe(200);
    expect((await html.text())).toContain(DOWNLOADER_MINI_APP_CSS_PATH);
    expect(css.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(jsHead.status).toBe(200);
    expect(jsHead.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await jsHead.text()).toBe("");
  });

  it("does not expose the removed news routes", async () => {
    const shell = await worker.fetch(new Request("https://worker.example/apps/news"), emptyEnv);
    const telegramAlias = await worker.fetch(new Request("https://worker.example/a"), emptyEnv);
    const api = await worker.fetch(new Request("https://worker.example/api/apps/news/articles"), emptyEnv);
    expect(shell.status).toBe(404);
    expect(telegramAlias.status).toBe(404);
    expect(api.status).toBe(404);
    expect(authMocks.authenticate).not.toHaveBeenCalled();
  });

  it("routes history and source APIs through Telegram authentication", async () => {
    const history = await worker.fetch(new Request("https://worker.example/api/history"), emptyEnv);
    const sources = await worker.fetch(new Request("https://worker.example/api/sources"), emptyEnv);

    expect(history.status).toBe(401);
    expect(sources.status).toBe(401);
  });

  it("authenticates a protected canonical request exactly once and preserves legacy parity", async () => {
    authMocks.authenticate.mockResolvedValue({ userId: "12345", authDate: 1_800_000_000 });
    const canonical = await worker.fetch(new Request("https://worker.example/api/apps/downloader/sources"), emptyEnv);
    const legacy = await worker.fetch(new Request("https://worker.example/api/sources"), emptyEnv);
    expect(canonical.status).toBe(200);
    expect(await canonical.clone().json()).toEqual(await legacy.clone().json());
    expect(authMocks.authenticate).toHaveBeenCalledTimes(2);
    expect(authMocks.authenticate.mock.calls[0]).toHaveLength(3);
    expect(authMocks.authenticate.mock.calls[1]).toHaveLength(3);
  });

  it("keeps minute recovery separate from 15-minute retention cleanup", async () => {
    await worker.scheduled({ cron: "*/15 * * * *" } as ScheduledController, emptyEnv);
    expect(r2Mocks.cleanupExpiredR2Jobs).toHaveBeenCalledOnce();
    expect(dispatchMocks.recover).not.toHaveBeenCalled();

    await worker.scheduled({ cron: "* * * * *" } as ScheduledController, emptyEnv);
    expect(r2Mocks.cleanupExpiredR2Jobs).toHaveBeenCalledOnce();
    expect(dispatchMocks.recover).toHaveBeenCalledOnce();
    expect(dispatchMocks.notices).toHaveBeenCalledOnce();
    await worker.scheduled({ cron: "*/5 * * * *" } as ScheduledController, emptyEnv);
    expect(dispatchMocks.recover).toHaveBeenCalledOnce();
  });

  it("runs the legacy durable-state repair only on the 15-minute cron", async () => {
    await worker.scheduled({ cron: "* * * * *" } as ScheduledController, emptyEnv);
    expect(dbMocks.repair).not.toHaveBeenCalled();
    await worker.scheduled({ cron: "*/15 * * * *" } as ScheduledController, emptyEnv);
    expect(dbMocks.repair).toHaveBeenCalledOnce();
    expect(dbMocks.repair).toHaveBeenCalledWith(undefined, expect.any(Date), 100);
  });

  it("still cleans up R2 when the repair throws", async () => {
    dbMocks.repair.mockRejectedValueOnce(new Error("D1 unavailable"));
    await expect(worker.scheduled({ cron: "*/15 * * * *" } as ScheduledController, emptyEnv)).resolves.toBeUndefined();
    expect(r2Mocks.cleanupExpiredR2Jobs).toHaveBeenCalledOnce();
  });

  it("does not expose similarly named API paths", async () => {
    const response = await worker.fetch(new Request("https://worker.example/api/history-export"), emptyEnv);
    expect(response.status).toBe(404);
  });

  it("rejects wrong methods before authentication and rejects unknown app paths", async () => {
    const method = await worker.fetch(new Request("https://worker.example/api/apps/downloader/sources", { method: "POST" }), emptyEnv);
    const unknown = await worker.fetch(new Request("https://worker.example/api/apps/other/history"), emptyEnv);
    const encoded = await worker.fetch(new Request("https://worker.example/api/history/job-a%2Fother"), emptyEnv);
    expect(method.status).toBe(405);
    expect(unknown.status).toBe(404);
    expect(encoded.status).toBe(404);
    expect(authMocks.authenticate).not.toHaveBeenCalled();
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { checkReleaseRoutes, RELEASE_ROUTES } from "../../../scripts/release-routes";
import retired from "../../../scripts/fixtures/retired-news-routes.json";
import worker from "../src/index";
import type { Env } from "../src/types";

vi.mock("../src/container", () => ({ DownloaderContainer: class {} }));
vi.mock("../src/workflow", () => ({ MediaJobWorkflow: class {} }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
vi.mock("../src/retired-durable-objects", () => ({ NewsScheduler: class {} }));
vi.mock("../src/mini-app-auth", () => ({ authenticateMiniAppRequest: vi.fn(async () => null) }));
vi.mock("../src/dispatch", () => ({ recoverAndReconcileDispatches: vi.fn() }));

describe("release route contract", () => {
  it("keeps canonical/legacy downloader routes and retires historical news routes before authentication", async () => {
    await checkReleaseRoutes((path, method) => worker.fetch(new Request(`https://worker.example${path}`, { method }), {} as Env));
  });

  it.each(retired.routes)("fails against a historical news-enabled route: $path", async ({ path, oldStatus }) => {
    await expect(checkReleaseRoutes(async (candidate, method) => new Response(null, {
      status: candidate === path ? oldStatus : RELEASE_ROUTES.find((route) => route.path === candidate && route.method === method)!.status,
    }))).rejects.toThrow(`expected 404, received ${oldStatus}`);
  });

  it("preserves historic Durable Object tags and disables persisted traces", () => {
    const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")) as {
      migrations: unknown; observability: { traces: unknown }; durable_objects: { bindings: unknown };
    };
    expect(config.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["DownloaderContainer"] },
      { tag: "v2", new_sqlite_classes: ["NewsScheduler"] },
      { tag: "v3", new_sqlite_classes: ["TranscriptionContainer"] },
    ]);
    expect(config.observability.traces).toEqual({ enabled: false, head_sampling_rate: 0, persist: false });
    expect(config.durable_objects.bindings).toEqual([
      { name: "DOWNLOADER_CONTAINER", class_name: "DownloaderContainer" },
      { name: "TRANSCRIPTION_CONTAINER", class_name: "TranscriptionContainer" },
    ]);
  });
});

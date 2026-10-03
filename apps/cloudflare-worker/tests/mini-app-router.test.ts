import { describe, expect, it } from "vitest";
import {
  DOWNLOADER_MINI_APP_API_PATH,
  DOWNLOADER_MINI_APP_CSS_PATH,
  DOWNLOADER_MINI_APP_JS_PATH,
  DOWNLOADER_MINI_APP_PATH,
  MINI_APP_REGISTRY,
  MINI_APP_ROUTE_TABLE,
  buildExactMiniAppRouteTable,
  buildMiniAppRegistry,
  miniAppRouteAllowsMethod,
  resolveMiniAppRoute,
} from "../src/mini-app-router";

describe("Mini App route registry", () => {
  it("registers only the downloader with isolated namespaced resources", () => {
    expect(Object.keys(MINI_APP_REGISTRY)).toEqual(["downloader"]);
    expect(resolveMiniAppRoute(DOWNLOADER_MINI_APP_PATH)).toMatchObject({ kind: "html", legacy: false });
    expect(resolveMiniAppRoute(DOWNLOADER_MINI_APP_CSS_PATH)).toMatchObject({ kind: "asset", asset: "css", legacy: false });
    expect(resolveMiniAppRoute(DOWNLOADER_MINI_APP_JS_PATH)).toMatchObject({ kind: "asset", asset: "js", legacy: false });
    expect(resolveMiniAppRoute(`${DOWNLOADER_MINI_APP_API_PATH}/sources`)).toMatchObject({ kind: "api", endpoint: "sources", legacy: false });
    expect(resolveMiniAppRoute(`${DOWNLOADER_MINI_APP_API_PATH}/history`)).toMatchObject({ kind: "api", endpoint: "history", legacy: false });
    expect(MINI_APP_REGISTRY.downloader).toMatchObject({
      authenticationPolicy: "telegram-init-data",
      authorizationPolicy: "downloader-owner",
      d1Namespace: "jobs",
      r2Namespace: "jobs/",
      backgroundWorkPolicy: "download-recovery-and-retention",
    });
    expect(Object.isFrozen(MINI_APP_REGISTRY)).toBe(true);
    expect(Object.isFrozen(MINI_APP_REGISTRY.downloader)).toBe(true);
    expect(Object.isFrozen(MINI_APP_ROUTE_TABLE)).toBe(true);
    expect(Object.isFrozen(resolveMiniAppRoute(DOWNLOADER_MINI_APP_PATH)?.methods)).toBe(true);
  });

  it("records exact methods and authentication before a handler is selected", () => {
    const shell = resolveMiniAppRoute(DOWNLOADER_MINI_APP_PATH);
    const sources = resolveMiniAppRoute(`${DOWNLOADER_MINI_APP_API_PATH}/sources`);
    const history = resolveMiniAppRoute(`${DOWNLOADER_MINI_APP_API_PATH}/history`);
    const item = resolveMiniAppRoute(`${DOWNLOADER_MINI_APP_API_PATH}/history/job-a`);
    expect(shell).toMatchObject({ methods: ["GET", "HEAD"], authenticationPolicy: "none" });
    expect(sources).toMatchObject({ methods: ["GET"], authenticationPolicy: "telegram-init-data" });
    expect(history).toMatchObject({ methods: ["GET", "DELETE"], authenticationPolicy: "telegram-init-data" });
    expect(item).toMatchObject({ methods: ["DELETE"], authenticationPolicy: "telegram-init-data" });
    expect(shell && miniAppRouteAllowsMethod(shell, "HEAD")).toBe(true);
    expect(sources && miniAppRouteAllowsMethod(sources, "POST")).toBe(false);
  });

  it("fails closed on duplicate app resources or exact routes", () => {
    const downloader = MINI_APP_REGISTRY.downloader;
    expect(() => buildMiniAppRegistry([downloader, { ...downloader, id: "other" }])).toThrow(/Duplicate Mini App/u);
    expect(() => buildMiniAppRegistry([
      downloader,
      {
        ...downloader,
        id: "other",
        path: "/apps/other",
        cssPath: "/apps/other/app.css",
        jsPath: downloader.path,
        apiPath: "/api/apps/other",
        d1Namespace: "other_items",
        r2Namespace: "apps/other/",
        observabilityName: "digibot.other",
      },
    ])).toThrow(/Duplicate Mini App route or asset/u);
    const route = resolveMiniAppRoute(DOWNLOADER_MINI_APP_PATH);
    if (!route) throw new Error("Expected downloader route");
    expect(() => buildExactMiniAppRouteTable([["/same", route], ["/same", route]])).toThrow(/Duplicate Mini App route/u);
  });

  it("accepts exact retained download aliases and rejects removed or ambiguous paths", () => {
    expect(resolveMiniAppRoute("/mini-app")).toMatchObject({ kind: "html", legacy: true });
    expect(resolveMiniAppRoute("/api/history/job-a")).toMatchObject({ kind: "api", endpoint: "history-item", legacy: true });
    for (const path of [
      "/apps/downloader/",
      "/apps/news",
      "/a",
      "/apps/other",
      "/apps/downloader/assets/v1/mini-app.css",
      "/api/history-export",
      "/api/apps/downloader/history-export",
      "/api/apps/news/articles",
      "/api/apps/news/sources/custom-a",
      "/api/history/job-a/extra",
      "/api/history//job-a",
      "/api/apps/downloader/history//job-a",
      "/api/history/job-a%2Fother",
      "/api/apps/downloader/history/job-a%5Cother",
    ]) {
      expect(resolveMiniAppRoute(path), path).toBeNull();
    }
  });
});

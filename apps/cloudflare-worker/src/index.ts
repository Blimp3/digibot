import { cleanupExpiredR2Jobs, handleDownloadRequest } from "./r2";
import { apiError, handleDownloaderApi, unauthorizedMiniAppResponse } from "./history";
import { createDownloaderMiniAppStorage } from "./downloader-storage";
import { miniAppCssResponse, miniAppHtmlResponse, miniAppJsResponse } from "./mini-app";
import { authenticateMiniAppRequest } from "./mini-app-auth";
import { authorizeMiniAppUser } from "./mini-app-authorization";
import {
  isDownloaderApiEndpoint,
  miniAppRouteAllowsMethod,
  resolveMiniAppRoute,
} from "./mini-app-router";
import { handleTelegramWebhook } from "./webhook";
import { recoverAndReconcileDispatches } from "./dispatch";
import { repairMissingDurableState } from "./db";
import { dispatchNotices } from "./notices";
import { logStructured } from "./logging";
import { handleDiagnostics } from "./diagnostics";
import { DownloaderContainer, TranscriptionContainer } from "./container";
import { MediaJobWorkflow } from "./workflow";
import { NewsScheduler } from "./retired-durable-objects";
import type { Env } from "./types";
import { handleIntegrationRequest } from "./integration";
import { cleanupIntegrationMedia, IntegrationWorkflow, recoverIntegrationOperations } from "./integration-workflow";

export { DownloaderContainer, TranscriptionContainer, MediaJobWorkflow, NewsScheduler, IntegrationWorkflow };

const READINESS_TIMEOUT_MS = 2_000;

type VersionMetadataResponse = Readonly<{
  id: string | null;
  tag: string | null;
  timestamp: string | null;
}>;

function versionMetadataResponse(env: Pick<Env, "CF_VERSION_METADATA">): VersionMetadataResponse {
  const metadata = env.CF_VERSION_METADATA;
  return {
    id: typeof metadata?.id === "string" ? metadata.id : null,
    tag: typeof metadata?.tag === "string" ? metadata.tag : null,
    timestamp: typeof metadata?.timestamp === "string" ? metadata.timestamp : null,
  };
}

function healthResponse(env: Pick<Env, "CF_VERSION_METADATA">): Response {
  return new Response(JSON.stringify({
    ok: true,
    service: "private-media-downloader",
    version: "5.0.0",
    versionMetadata: versionMetadataResponse(env),
  }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function boundedReadinessCheck<T>(operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("READINESS_TIMEOUT")), READINESS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readinessResponse(env: Env): Promise<Response> {
  const [d1] = await Promise.allSettled([
    boundedReadinessCheck(async () => {
      const result = await env.DB.prepare("SELECT 1 AS ready").first<{ ready: number | string }>();
      if (result?.ready !== 1 && result?.ready !== "1") throw new Error("D1_NOT_READY");
    }),
  ]);
  const checks = {
    d1: d1.status === "fulfilled",
  };
  const ready = checks.d1;
  return new Response(JSON.stringify({
    ok: ready,
    service: "private-media-downloader",
    ready,
    checks,
    versionMetadata: versionMetadataResponse(env),
  }), {
    status: ready ? 200 : 503,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return healthResponse(env);
    if (url.pathname === "/ready" && request.method === "GET") return readinessResponse(env);
    const integration = await handleIntegrationRequest(request, env, ctx ? ctx.waitUntil.bind(ctx) : undefined);
    if (integration) return integration;
    const miniAppRoute = resolveMiniAppRoute(url.pathname);
    if (miniAppRoute && !miniAppRouteAllowsMethod(miniAppRoute, request.method)) {
      return miniAppRoute.kind === "api"
        ? apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.")
        : new Response("Method Not Allowed", { status: 405, headers: { "cache-control": "no-store" } });
    }
    if (miniAppRoute?.kind === "html") {
      return miniAppHtmlResponse(!miniAppRoute.legacy, request.method === "HEAD");
    }
    if (miniAppRoute?.kind === "asset") {
      const isHead = request.method === "HEAD";
      return miniAppRoute.asset === "css"
        ? miniAppCssResponse(!miniAppRoute.legacy, isHead)
        : miniAppJsResponse(!miniAppRoute.legacy, isHead);
    }
    if (miniAppRoute?.kind === "api" && miniAppRoute.authenticationPolicy === "telegram-init-data") {
      const user = await authenticateMiniAppRequest(
        request,
        env.TELEGRAM_BOT_TOKEN,
        env.ALLOWED_TELEGRAM_USER_IDS,
      );
      if (!user) return unauthorizedMiniAppResponse();
      const principal = authorizeMiniAppUser(miniAppRoute.app, user);
      if (!principal) return apiError(403, "FORBIDDEN", "This Mini App is not available to this user.");
      if (principal.appId === "downloader" && miniAppRoute.endpoint === "diagnostics") return handleDiagnostics(request, env);
      if (miniAppRoute.app.id !== "downloader" || !isDownloaderApiEndpoint(miniAppRoute.endpoint)) {
        return apiError(403, "FORBIDDEN", "Downloader route authorization mismatch.");
      }
      return handleDownloaderApi(request, {
        url,
        user: principal,
        storage: createDownloaderMiniAppStorage(env.DB, env.MEDIA_BUCKET, principal.userId),
        endpoint: miniAppRoute.endpoint,
        legacy: miniAppRoute.legacy,
        apiPath: miniAppRoute.app.apiPath,
      });
    }
    if (url.pathname === "/telegram/webhook") {
      const started = Date.now();
      const response = await handleTelegramWebhook(request, env, ctx ? ctx.waitUntil.bind(ctx) : undefined);
      logStructured("webhook_response", { operationMs: Date.now() - started, state: String(response.status) });
      return response;
    }
    if (url.pathname.startsWith("/download/") && url.pathname.split("/").length === 3) return handleDownloadRequest(request, env);
    return new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === "* * * * *") {
      const results = await Promise.allSettled([recoverAndReconcileDispatches(env), dispatchNotices(env), recoverIntegrationOperations(env)]);
      if (results.some((result) => result.status === "rejected")) logStructured("recovery_scan_deferred", { errorCode: "INTERNAL_ERROR" });
    }
    if (controller.cron === "*/15 * * * *") {
      await cleanupExpiredR2Jobs(env);
      if (env.INTEGRATION_ENABLED !== undefined) await cleanupIntegrationMedia(env);
      try {
        // Runs 15x less often than the minute scan, so it keeps a full 100-row batch to preserve drain capacity.
        if (await repairMissingDurableState(env.DB, new Date(), 100) > 0) logStructured("media_dispatch_legacy_repair", { state: "reconciled" });
      } catch {
        logStructured("media_dispatch_legacy_repair", { state: "deferred", errorCode: "INTERNAL_ERROR" });
      }
    }
  },
};

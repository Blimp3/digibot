// Run: pnpm exec tsx apps/cloudflare-worker/tests/webhook-benchmark.ts
// Uses synthetic updates, disposable local D1, and a fixed 250ms fake Telegram response.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { handleTelegramWebhook } from "../src/webhook";
import { getJob } from "../src/db";
import { ensureWaitingNotice } from "../src/notices";
import { localD1 } from "./helpers/local-d1";
import type { Env } from "../src/types";

const BASELINE = "1a6e24beb3d90864b12c6cc5727c32b5ae71c212";
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve("wrangler/package.json"))("esbuild") as {
  buildSync: (options: Record<string, unknown>) => unknown;
};
const quantiles = (values: number[]) => {
  values.sort((a, b) => a - b);
  return { samples: values.length, p50Ms: values[49], p95Ms: values[94], p99Ms: values[98] };
};

async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "digibot-webhook-benchmark-"));
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  try {
    const repository = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const archive = join(directory, "baseline.tar");
    execFileSync("git", ["archive", "--format=tar", `--output=${archive}`, BASELINE, "apps/cloudflare-worker/src"], { cwd: repository });
    execFileSync("tar", ["-xf", archive, "-C", directory]);
    const bundle = join(directory, "baseline.mjs");
    esbuild.buildSync({ entryPoints: [join(directory, "apps/cloudflare-worker/src/webhook.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm" });
    const baseline = await import(pathToFileURL(bundle).href) as { handleTelegramWebhook: typeof handleTelegramWebhook };
    const results: Record<string, unknown> = {};
    console.log = () => undefined;
    for (const [name, handler] of [["before", baseline.handleTelegramWebhook], ["after", handleTelegramWebhook]] as const) {
      const database = await localD1();
      try {
        let noticedAt = 0;
        let sends = 0;
        globalThis.fetch = async () => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          sends += 1;
          noticedAt = performance.now();
          return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
        };
        const env = {
          DB: database.db, TELEGRAM_BOT_TOKEN: "synthetic", TELEGRAM_WEBHOOK_SECRET: "synthetic",
          INTERNAL_CONTAINER_SECRET: "synthetic", ALLOWED_TELEGRAM_USER_IDS: "12345,67890",
          DOWNLOAD_LINK_HMAC_SECRET: "synthetic", ALLOWED_SOURCE_HOSTS: "youtube.com,youtu.be",
          MEDIA_WORKFLOW: { create: async ({ id }: { id: string }) => {
            if (name === "after") {
              const job = await getJob(database.db, id);
              assert.ok(job);
              await ensureWaitingNotice(env, job.telegram_update_id, job.telegram_chat_id, "Preparing.");
            }
            return { status: async () => ({ status: "running" }) };
          } },
        } as unknown as Env;
        const responseTimes: number[] = [];
        const noticeTimes: number[] = [];
        for (let index = 0; index < 100; index++) {
          noticedAt = 0;
          const background: Promise<unknown>[] = [];
          const request = new Request("https://worker.example/telegram/webhook", {
            method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "synthetic" },
            body: JSON.stringify({ update_id: index, message: { message_id: index + 1, chat: { id: 12345, type: "private" }, from: { id: 12345 }, text: "https://youtu.be/synthetic" } }),
          });
          const start = performance.now();
          const response = await handler(request, env, (promise) => { background.push(promise); });
          responseTimes.push(performance.now() - start);
          assert.equal(response.status, 200);
          const payload: unknown = await response.json();
          assert.ok(payload && typeof payload === "object" && "accepted" in payload);
          assert.equal(payload.accepted, true);
          await Promise.all(background);
          assert.ok(noticedAt >= start, "No confirmed notice before the bounded dispatch ended");
          noticeTimes.push(noticedAt - start);
          await database.db.batch([database.db.prepare("DELETE FROM jobs"), database.db.prepare("DELETE FROM processed_updates")]);
        }
        assert.equal(sends, 100);
        results[name] = { webhook: quantiles(responseTimes), acceptedNotice: quantiles(noticeTimes), failureRate: 0, sends };
      } finally { await database.dispose(); }
    }
    originalLog(JSON.stringify({ baselineCommit: BASELINE, sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      sourceDirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
      measuredCodeMatchesCommit: execFileSync("git", ["diff", "HEAD", "--name-only", "--", "apps/cloudflare-worker"], { encoding: "utf8" }).trim().length === 0,
      location: "local Mac, real workerd D1, synthetic 250ms Telegram, immediate simulated Workflow start", ...results }, null, 2));
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    rmSync(directory, { recursive: true, force: true });
  }
}
void main();

// Run: pnpm exec tsx apps/cloudflare-worker/tests/d1-benchmark.ts (disposable local D1 only).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { listJobsForUser, getLatestCompletedJobForMedia, listStartedDispatchIntents } from "../src/db";
import { applyMigrationSql } from "./helpers/local-d1";

const workerRequire = createRequire(new URL("../package.json", import.meta.url));
const { Miniflare, convertV4MiniflareOptions } = createRequire(workerRequire.resolve("wrangler/package.json"))("miniflare") as {
  Miniflare: new (options: unknown) => { getD1Database(name: string): Promise<D1Database>; dispose(): Promise<void> };
  convertV4MiniflareOptions: (options: unknown) => unknown;
};
async function main(): Promise<void> {
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: "export default { fetch() { return new Response('local benchmark'); } }",
    compatibilityDate: "2026-08-18", d1Databases: ["DB"],
  }));
  try {
    const db = await runtime.getD1Database("DB");
    // Actual application schema, without admission triggers for synthetic history.
    for (const file of ["0001_initial.sql", "0008_job_dispatch_delivery_recovery.sql"]) {
      const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      await applyMigrationSql(db, sql);
    }
    const rows = 10_000;
    for (let batch = 0; batch < rows; batch += 100) {
      const statements = [];
      for (let i = batch; i < batch + 100; i++) {
        const id = `synthetic-${String(i).padStart(5, "0")}`;
        const owner = String(i % 4);
        const timestamp = new Date(Date.UTC(2026, 0, 1) + Math.floor(i / 100) * 1000).toISOString();
        statements.push(db.prepare("INSERT INTO processed_updates (telegram_update_id, job_id, created_at) VALUES (?1, ?1, ?2)").bind(id, timestamp));
        statements.push(db.prepare(`INSERT INTO jobs (id, telegram_update_id, telegram_user_id, telegram_chat_id,
          source_host, source_url_hash, requested_mode, requested_quality, status, result_message_id,
          output_filename, output_mime_type, output_size_bytes, created_at, updated_at, completed_at)
          VALUES (?1, ?1, ?2, ?2, 'example.test', 'synthetic-hash', 'video', 'max-1080p', 'completed', '1',
            'synthetic.mp4', 'video/mp4', 100, ?3, ?3, ?4)`).bind(id, owner, timestamp, new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()));
      }
      await db.batch(statements);
    }
    await db.prepare(`INSERT INTO job_dispatch_intents (job_id, state, workflow_instance_id, available_at, created_at, updated_at)
      SELECT id, CASE WHEN CAST(substr(id, 11) AS INTEGER) % 20 = 0 THEN 'started' ELSE 'complete' END,
        id, created_at, created_at, updated_at FROM jobs`).run();
    let lastQuery: { sql: string; values: unknown[] } | undefined;
    let lastMeta: D1Result<unknown>["meta"] | undefined;
    const measuredDb = { prepare(sql: string) {
      let statement = db.prepare(sql);
      const wrapper = {
        bind(...values: unknown[]) { lastQuery = { sql, values }; statement = statement.bind(...values); return wrapper; },
        async all<T = Record<string, unknown>>() { const result = await statement.all<T>(); lastMeta = result.meta; return result; },
        async first<T = Record<string, unknown>>() { return (await wrapper.all<T>()).results[0] ?? null; },
        async run() { return statement.run(); },
      };
      return wrapper;
    } };
    const operations = {
      history: () => listJobsForUser(measuredDb, "0"),
      cache: () => getLatestCompletedJobForMedia(measuredDb, "0", "0", "synthetic-hash", "video", "max-1080p"),
      recovery: () => listStartedDispatchIntents(measuredDb, 20),
    };
    const baselineResults: Record<string, unknown> = {};
    async function measure(): Promise<Record<string, unknown>> {
      const report: Record<string, unknown> = {};
      for (const [name, operation] of Object.entries(operations)) {
        for (let i = 0; i < 10; i++) await operation();
        const times = [];
        for (let i = 0; i < 100; i++) {
          const start = performance.now();
          const result = await operation();
          times.push(performance.now() - start);
          if (baselineResults[name] === undefined) baselineResults[name] = result;
          else assert.deepEqual(result, baselineResults[name]);
        }
        times.sort((a, b) => a - b);
        if (!lastQuery || !lastMeta) throw new Error("No D1 query measurement captured");
        const plan = await db.prepare(`EXPLAIN QUERY PLAN ${lastQuery.sql}`).bind(...lastQuery.values).all();
        report[name] = {
          samples: times.length, p50Ms: times[49], p95Ms: times[94], p99Ms: times[98], failureRate: 0,
          rowsRead: lastMeta.rows_read, rowsWritten: lastMeta.rows_written, queryPlan: plan.results,
        };
      }
      return report;
    }
    async function measureWrite(): Promise<Record<string, unknown>> {
      const times: number[] = [];
      let rowsWritten = 0;
      for (let i = 0; i < 100; i++) {
        const start = performance.now();
        const result = await db.prepare("UPDATE jobs SET updated_at = ?1 WHERE id = 'synthetic-09999'")
          .bind(new Date(Date.UTC(2030, 0, 1) + i * 1000).toISOString()).run();
        times.push(performance.now() - start);
        rowsWritten += result.meta.rows_written;
      }
      times.sort((a, b) => a - b);
      return { samples: 100, p50Ms: times[49], p95Ms: times[94], p99Ms: times[98], meanRowsWritten: rowsWritten / 100 };
    }
    const before = await measure();
    const writesBefore = await measureWrite();
    await db.prepare("CREATE INDEX benchmark_history ON jobs(telegram_user_id, created_at DESC, id DESC)").run();
    await db.prepare(`CREATE INDEX benchmark_cache ON jobs(telegram_user_id, telegram_chat_id, source_url_hash,
      requested_mode, requested_quality, processing_policy_version, completed_at DESC, updated_at DESC)
      WHERE status = 'completed' AND cache_valid = 1 AND result_message_id IS NOT NULL`).run();
    await db.prepare("CREATE INDEX benchmark_recovery ON job_dispatch_intents(state, updated_at, job_id)").run();
    const after = await measure();
    const writesAfter = await measureWrite();
    console.log(JSON.stringify({
      sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      sourceDirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
      measuredCodeMatchesCommit: execFileSync("git", ["diff", "HEAD", "--name-only", "--", "apps/cloudflare-worker"], { encoding: "utf8" }).trim().length === 0,
      location: "local Mac, Miniflare/workerd D1, no network providers", rows, before, after,
      completedMetadataUpdate: { before: writesBefore, after: writesAfter },
      note: "Synthetic warm timings include local D1 binding overhead. Candidate indexes exist only in this disposable database.",
    }, null, 2));
  } finally {
    await runtime.dispose();
  }
}
void main();

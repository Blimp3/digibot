import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import type { D1BatchDatabaseLike } from "../../src/types";

interface Runtime { getD1Database(name: string): Promise<D1BatchDatabaseLike>; dispose(): Promise<void> }
const require = createRequire(import.meta.url);
const miniflare = createRequire(require.resolve("wrangler/package.json"))("miniflare") as {
  Miniflare: new (options: unknown) => Runtime;
  convertV4MiniflareOptions(options: unknown): unknown;
};

export async function applyMigrationSql(db: D1BatchDatabaseLike, sql: string): Promise<void> {
  let statement = "";
  // Known limit: checked-in statements end on line boundaries; use a SQLite
  // parser before accepting arbitrary SQL input here.
  for (const line of sql.split("\n")) {
    if (line.trim().startsWith("--") || !line.trim()) continue;
    statement += `${line}\n`;
    if (!line.trim().endsWith(";")) continue;
    if (/^CREATE TRIGGER/iu.test(statement.trim()) && !/^END;/iu.test(line.trim())) continue;
    await db.prepare(statement).run();
    statement = "";
  }
  if (statement.trim()) throw new Error("Incomplete test migration SQL");
}

export async function localD1(historicalSql: string[] = []): Promise<{ db: D1BatchDatabaseLike; dispose: () => Promise<void> }> {
  const runtime = new miniflare.Miniflare(miniflare.convertV4MiniflareOptions({
    modules: true, script: "export default {fetch(){return new Response('local test')}}",
    compatibilityDate: "2026-08-18", d1Databases: ["DB"],
  }));
  try {
    const db = await runtime.getD1Database("DB");
    const folder = new URL("../../migrations/", import.meta.url);
    for (const file of readdirSync(folder).filter((file) => file.endsWith(".sql")).sort()) {
      if (file.startsWith("0008")) for (const sql of historicalSql) await applyMigrationSql(db, sql);
      await applyMigrationSql(db, readFileSync(new URL(file, folder), "utf8"));
    }
    return { db, dispose: () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

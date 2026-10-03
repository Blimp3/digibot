import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string): string => readFileSync(`${root}/${path}`, "utf8");
const rolloutChoices = (command: string): string[] => [...command.matchAll(/--containers-rollout\s+(\S+)/gu)].map((match) => match[1] ?? "");

describe("Cloudflare release command boundaries", () => {
  it("freezes Container rollout from every Worker deployment entrypoint", () => {
    const rootPackage = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const workerPackage = JSON.parse(read("apps/cloudflare-worker/package.json")) as { scripts: Record<string, string> };
    const rootWorkerDeploy = rootPackage.scripts["worker:deploy"] ?? "";

    expect(rootWorkerDeploy).toMatch(/^pnpm --filter private-media-downloader-worker exec wrangler deploy/u);
    expect(rolloutChoices(rootWorkerDeploy)).toEqual(["none"]);
    expect(rolloutChoices(workerPackage.scripts.deploy ?? "")).toEqual(["none"]);
  });

  it("registers quality callbacks without dropping updates and verifies Telegram retained them", () => {
    const directory = mkdtempSync(join(tmpdir(), "webhook-registration-"));
    const shim = join(directory, "telegram-mock.mjs");
    try {
      writeFileSync(shim, `
        globalThis.fetch = async (url, options) => {
          const method = new URL(url).pathname.split('/').at(-1);
          if (method === 'setWebhook') {
            const body = JSON.parse(options.body);
            if (JSON.stringify(body.allowed_updates) !== JSON.stringify(['message', 'callback_query'])
              || body.drop_pending_updates !== false || body.secret_token !== process.env.TELEGRAM_WEBHOOK_SECRET) {
              throw new Error('Unexpected webhook payload');
            }
            return Response.json({ok: true, result: true});
          }
          if (method !== 'getWebhookInfo') throw new Error('Unexpected Telegram method');
          return Response.json({ok: true, result: {
            url: 'https://worker.example/telegram/webhook', pending_update_count: 2,
            allowed_updates: process.env.TEST_MISSING_CALLBACK ? ['message'] : ['message', 'callback_query']
          }});
        };
      `);
      for (const missingCallback of [false, true]) {
        const result = spawnSync(process.execPath, [
          "--import", shim, "--import", join(root, "node_modules/tsx/dist/loader.mjs"),
          join(root, "scripts/set-telegram-webhook.ts"),
        ], {
          encoding: "utf8", timeout: 20_000,
          env: {
            ...process.env,
            PUBLIC_WORKER_BASE_URL: "https://worker.example",
            TELEGRAM_BOT_TOKEN: ["123456", "synthetic_test_token_that_is_not_a_real_secret"].join(":"),
            TELEGRAM_WEBHOOK_SECRET: "synthetic_webhook_secret",
            TEST_MISSING_CALLBACK: missingCallback ? "1" : "",
          },
        });
        expect(result.status).toBe(missingCallback ? 1 : 0);
        if (missingCallback) expect(result.stderr).toContain("did not retain message and quality-button updates");
        else expect(result.stdout).toContain("pending updates: 2");
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects the removed updater deployment path before any release command can run", () => {
    const directory = mkdtempSync(join(tmpdir(), "dependency-updater-deploy-"));
    const log = join(directory, "commands.log");

    try {
      for (const command of ["curl", "docker", "pnpm", "uv"]) {
        const stub = join(directory, command);
        writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' '${command}' >> '${log}'\n`, { mode: 0o755 });
      }
      const result = spawnSync("/bin/bash", [join(root, "scripts/update-downloader-dependencies.sh"), "--deploy"], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--deploy was removed");
      expect(result.stderr).toContain("release it separately");
      expect(existsSync(log)).toBe(false);
      expect(rolloutChoices(read("scripts/update-downloader-dependencies.sh"))).toEqual([]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_SOURCE_HOSTS } from "../src/config";
import { SOURCE_CATALOG } from "../src/sources";

const workerRoot = fileURLToPath(new URL("../", import.meta.url));
const containerRoot = fileURLToPath(new URL("../../downloader-container/", import.meta.url));

function readEnvHosts(path: string): string[] {
  const match = readFileSync(path, "utf8").match(/^ALLOWED_SOURCE_HOSTS=(.+)$/mu);
  expect(match?.[1]).toBeDefined();
  return (match?.[1] ?? "").split(",");
}

function readWranglerHosts(): string[] {
  const config = readFileSync(`${workerRoot}wrangler.jsonc`, "utf8");
  const match = config.match(/"ALLOWED_SOURCE_HOSTS"\s*:\s*"([^"]+)"/u);
  expect(match?.[1]).toBeDefined();
  return (match?.[1] ?? "").split(",");
}

function readContainerDefaultHosts(): string[] {
  const security = readFileSync(`${containerRoot}src/downloader_container/security.py`, "utf8");
  const match = security.match(/DEFAULT_ALLOWED_SOURCE_HOSTS\s*=\s*frozenset\(\s*\{([\s\S]*?)\}\s*\)/u);
  expect(match?.[1]).toBeDefined();
  return [...(match?.[1] ?? "").matchAll(/"([^"]+)"/gu)].map((item) => item[1] ?? "");
}

describe("Worker source policy", () => {
  it("keeps the default input allowlist equal to the catalog host projection", () => {
    const catalogHosts = SOURCE_CATALOG.flatMap((source) => source.hosts);
    expect(catalogHosts.sort()).toEqual([...DEFAULT_SOURCE_HOSTS].sort());
  });

  it("keeps Worker, Wrangler, Container, and environment defaults synchronized", () => {
    // An allowlist is a set; only its members must match.
    const expected = [...DEFAULT_SOURCE_HOSTS].sort();
    expect(readWranglerHosts().sort()).toEqual(expected);
    expect(readEnvHosts(`${workerRoot}.env.example`).sort()).toEqual(expected);
    expect(readEnvHosts(`${containerRoot}.env.example`).sort()).toEqual(expected);
    expect(readContainerDefaultHosts().sort()).toEqual(expected);
  });
});

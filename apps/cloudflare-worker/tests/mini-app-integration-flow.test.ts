import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { MINI_APP_JS } from "../src/mini-app";

class Element {
  children: Element[] = [];
  textContent = "";
  hidden = false;
  disabled = false;
  value = "";
  className = "";
  listeners: Record<string, () => void> = {};

  constructor(readonly tag = "div") {}

  get firstChild() { return this.children[0]; }
  appendChild(child: Element) { this.children.push(child); }
  removeChild(child: Element) { this.children.splice(this.children.indexOf(child), 1); }
  setAttribute() {}
  addEventListener(event: string, callback: () => void) { this.listeners[event] = callback; }
  querySelectorAll(tag: string): Element[] {
    return this.children.flatMap((child) => [
      ...(child.tag === tag ? [child] : []),
      ...child.querySelectorAll(tag),
    ]);
  }
  fire(event = "click") { this.listeners[event]?.(); }
}

type PendingCall = {
  path: string;
  method: string;
  resolve: (value: unknown) => void;
  settled: boolean;
};

const fixtureText = readFileSync(new URL("./fixtures/integration-envelope-v1.json", import.meta.url), "utf8");
type Fixture = {
  operationId: string;
  accountId: string;
  requestedAt: string;
  media: { mediaSha256: string };
  archive: Record<string, unknown>;
  [key: string]: unknown;
};
const fixture = JSON.parse(fixtureText) as Fixture;

function treeText(node: Element): string {
  return [node.textContent, ...node.children.map(treeText)].join(" ");
}

function button(node: Element, label: string): Element {
  const found = node.querySelectorAll("button").find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

it("loads connected history without legacy requests and renders provenance, archive, and actions", async () => {
  const nodes: Record<string, Element> = {};
  const node = (id: string) => nodes[id] ??= new Element();
  node("integration-period").value = "7d";
  const calls: PendingCall[] = [];
  const operation = {
    version: 1,
    operationId: fixture.operationId,
    accountId: fixture.accountId,
    action: "check",
    state: "completed",
    requestedAt: fixture.requestedAt,
    expiresAt: "2026-09-17T09:59:00.000Z",
    mediaSha256: fixture.media.mediaSha256,
    segment: null,
    envelope: fixture,
    archive: fixture.archive,
    error: null,
  };
  const photoOperation = {
    ...operation,
    operationId: "55555555-5555-4555-8555-555555555555",
    envelope: { ...fixture, operationId: "55555555-5555-4555-8555-555555555555", media: { ...fixture.media, inputKind: "telegram_photo_copy" } },
  };
  const segmentOperation = {
    ...operation,
    operationId: "66666666-6666-4666-8666-666666666666",
    segment: { startSeconds: 12, endSeconds: 42 },
    envelope: {
      ...fixture,
      operationId: "66666666-6666-4666-8666-666666666666",
      media: {
        ...fixture.media,
        mimeType: "audio/mpeg",
        inputKind: "derived_audio_segment",
        audioDurationSeconds: 30,
        segment: { startSeconds: 12, endSeconds: 42 },
        fullSourceSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    },
  };
  const failedOperation = {
    ...operation,
    operationId: "44444444-4444-4444-8444-444444444444",
    state: "failed",
    envelope: null,
    error: { code: "provider_unavailable", message: "Provider unavailable", retryable: true },
    archive: { ...fixture.archive, deliveryState: "not_required", documentReceipt: null, integrityState: "not_checked", roundTripSha256: null },
  };
  const stats = {
    period: "7d",
    since: "2026-09-09T10:00:00.000Z",
    asOf: "2026-09-16T10:00:00.000Z",
    checksRequested: 2,
    checksCompleted: 1,
    checksFailed: 1,
    freshChecks: 1,
    cachedChecks: 0,
    downloadsRequested: 0,
    downloadsConfirmed: 0,
    downloadsFailed: 0,
    uniqueMedia: 1,
    savedOriginals: 1,
    unresolvedArchives: 0,
    legacyDownloads: 0,
  };
  runInNewContext(MINI_APP_JS, {
    document: {
      readyState: "complete",
      getElementById: node,
      createElement: (tag: string) => new Element(tag),
    },
    window: {
      location: { search: "?view=integration" },
      Telegram: { WebApp: { initData: "signed" } },
      confirm: () => true,
    },
    fetch: (path: string, options: { method?: string } = {}) => new Promise((resolve) => {
      calls.push({ path, method: options.method || "GET", resolve, settled: false });
    }),
  });

  expect(calls.map((call) => call.path)).toEqual([
    "/api/integration/history?period=7d",
    "/api/integration/stats?period=7d",
  ]);
  expect(calls.every((call) => !call.path.includes("/api/apps/downloader/"))).toBe(true);

  const respond = async (call: PendingCall, payload: unknown, ok = true) => {
    call.settled = true;
    call.resolve({ ok, json: async () => payload });
    await tick();
    await tick();
  };
  await respond(calls[0]!, { operations: [operation, photoOperation, segmentOperation, failedOperation], nextCursor: "page-2" });
  await respond(calls[1]!, stats);
  expect(nodes["integration-history-empty"]!.hidden).toBe(true);
  expect(nodes["integration-stats"]!.hidden).toBe(false);
  expect(treeText(nodes["integration-history-list"]!)).toContain("C2PA signature");
  expect(treeText(nodes["integration-history-list"]!)).toContain("C2PA file binding");
  expect(treeText(nodes["integration-history-list"]!)).toContain("C2PA signer trust");
  expect(treeText(nodes["integration-history-list"]!)).toContain("AI declaration");
  expect(treeText(nodes["integration-history-list"]!)).toContain("Not verified");
  expect(treeText(nodes["integration-history-list"]!)).toContain("Not established by the pinned list");
  expect(treeText(nodes["integration-history-list"]!)).toContain("No supported AI declaration found");
  expect(treeText(nodes["integration-history-list"]!)).toContain("Telegram receipt");
  expect(treeText(nodes["integration-history-list"]!)).toContain(fixture.media.mediaSha256);
  expect(treeText(nodes["integration-history-list"]!)).toContain("Telegram photo copy");
  expect(treeText(nodes["integration-history-list"]!)).toContain("Derived audio segment");
  expect(treeText(nodes["integration-history-list"]!)).toContain("12–42 seconds");
  expect(treeText(nodes["integration-history-list"]!)).toContain("Retry");

  nodes["integration-load-more"]!.fire();
  expect(calls[2]!.path).toBe("/api/integration/history?period=7d&cursor=page-2");
  expect(calls[3]!.path).toBe("/api/integration/stats?period=7d");
  await respond(calls[2]!, { operations: [], nextCursor: null });
  await respond(calls[3]!, stats);

  nodes["integration-period"]!.value = "24h";
  nodes["integration-period"]!.fire("change");
  expect(calls[4]!.path).toBe("/api/integration/history?period=24h");
  expect(calls[5]!.path).toBe("/api/integration/stats?period=24h");
  await respond(calls[4]!, { operations: [operation], nextCursor: null });
  await respond(calls[5]!, { ...stats, period: "24h" });

  button(nodes["integration-history-list"]!, "Delete history").fire();
  expect(calls[6]!.method).toBe("DELETE");
  expect(calls[6]!.path).toBe(`/api/integration/history/${operation.operationId}`);
  await respond(calls[6]!, { ok: true });
  expect(calls[7]!.path).toBe("/api/integration/history?period=24h");
  expect(calls[8]!.path).toBe("/api/integration/stats?period=24h");
  await respond(calls[7]!, { operations: [operation], nextCursor: null });
  await respond(calls[8]!, { ...stats, period: "24h" });

  button(nodes["integration-history-list"]!, "Delete Telegram copy").fire();
  expect(calls[9]!.path).toBe(`/api/integration/media/${fixture.media.mediaSha256}/archive`);
  await respond(calls[9]!, { ok: true });
  await respond(calls[10]!, { operations: [operation], nextCursor: null });
  await respond(calls[11]!, { ...stats, period: "24h" });

  button(nodes["integration-history-list"]!, "Delete media + history").fire();
  expect(calls[12]!.path).toBe(`/api/integration/media/${fixture.media.mediaSha256}`);
  await respond(calls[12]!, { ok: true });
  await respond(calls[13]!, { operations: [], nextCursor: null });
  await respond(calls[14]!, { ...stats, period: "24h" });

  nodes["integration-clear-cache"]!.fire();
  expect(calls[15]!.method).toBe("DELETE");
  expect(calls[15]!.path).toBe("/api/integration/cache");
  await respond(calls[15]!, { ok: true });
  await respond(calls[16]!, { operations: [], nextCursor: null });
  await respond(calls[17]!, { ...stats, period: "24h" });
});

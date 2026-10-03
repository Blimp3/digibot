import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { MINI_APP_JS } from "../src/mini-app";
class Element {
  children: Element[] = [];
  textContent = ""; hidden = false; disabled = false; value = "";
  listeners: Record<string, () => void> = {};
  constructor(readonly tag = "div") {}
  get firstChild() { return this.children[0]; }
  appendChild(child: Element) { this.children.push(child); }
  removeChild(child: Element) { this.children.splice(this.children.indexOf(child), 1); }
  setAttribute() {}
  addEventListener(event: string, callback: () => void) { this.listeners[event] = callback; }
  querySelectorAll(tag: string): Element[] { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
  fire(event = "click") { this.listeners[event]?.(); }
}
it("filters, freezes pagination, separates empty/error, and refreshes after deletion or partial clear", async () => {
  const nodes: Record<string, Element> = {};
  const node = (id: string) => nodes[id] ??= new Element();
  node("activity-period").value = "7d"; node("activity-task").value = "all";
  const calls: Array<{path: string; method: string; resolve: (value: unknown) => void}> = [];
  runInNewContext(MINI_APP_JS, {
    document: { readyState: "complete", getElementById: node, createElement: (tag: string) => new Element(tag) },
    window: { Telegram: { WebApp: { initData: "signed" } }, confirm: () => true },
    fetch: (path: string, options: {method?: string}) => new Promise(resolve => calls.push({path, method: options.method || "GET", resolve})),
  });
  const respond = async (i: number, payload: unknown, ok = true) => { calls[i]!.resolve({ok, json: async () => payload}); await new Promise(resolve => setImmediate(resolve)); };
  const item = {historyId: "job-a", status: "completed", task: "captions", outcome: "confirmed"};
  const page = (items: unknown[] = [], nextCursor: string | null = null) => ({items, nextCursor, summary: {accepted: 42, confirmed: 40, failed: 1, unfinished: 1, needsReview: 0, deliveredClips: 3, asOf: "2026-09-08T12:00:00.000Z"}});
  expect(node("refresh-history").disabled).toBe(true);
  expect(node("history-empty").hidden).toBe(true);
  await respond(0, page([item], "frozen")); await respond(1, {sources: []});
  expect(node("activity-summary").children[0]!.children[1]!.textContent).toBe("42");
  expect(node("activity-summary").children[3]!.children[0]!.textContent).toBe("Unfinished");
  expect(node("activity-summary").children[6]!.children[1]!.textContent).toContain("12:00:00 UTC");
  node("load-more").fire(); expect(calls[2]!.path).toContain("cursor=frozen"); await respond(2, {...page(), summary: null});
  expect(node("activity-summary").children[0]!.children[1]!.textContent).toBe("42");
  node("activity-period").value = "24h"; node("activity-task").value = "captions"; node("activity-task").fire("change");
  expect(calls[3]!.path).toContain("period=24h&task=captions"); expect(calls[3]!.path).not.toMatch(/cursor|asOf/);
  expect(node("history-empty").hidden).toBe(true); await respond(3, {}, false);
  expect(node("history-empty").hidden).toBe(true); expect(node("status").textContent).toContain("try again");
  node("refresh-history").fire(); await respond(4, page()); expect(node("history-empty").hidden).toBe(false);
  node("refresh-history").fire(); await respond(5, page([item]));
  node("history-list").querySelectorAll("button")[0]!.fire(); expect(calls[6]!.method).toBe("DELETE");
  node("refresh-history").fire(); expect(calls).toHaveLength(7);
  await respond(6, {deleted:true}); expect(calls[7]!.method).toBe("GET"); expect(calls[7]!.path).not.toMatch(/cursor|asOf/); await respond(7, page());
  node("clear-history").fire(); expect(calls[8]!.path).toBe("/api/apps/downloader/history"); await respond(8, {}, false);
  expect(calls[9]!.method).toBe("GET"); await respond(9, page());
  expect(node("status").textContent).toContain("Some finished activity"); expect(node("clear-history").disabled).toBe(false);
});

import { describe, expect, it } from "vitest";
import {
  MINI_APP_CSP,
  MINI_APP_CSS,
  MINI_APP_CANONICAL_HTML,
  MINI_APP_CANONICAL_JS,
  MINI_APP_HTML,
  MINI_APP_JS,
  miniAppCssResponse,
  miniAppHtmlResponse,
  miniAppJsResponse,
} from "../src/mini-app";
import {
  DOWNLOADER_MINI_APP_CSS_PATH,
  DOWNLOADER_MINI_APP_CSS_VERSION,
  DOWNLOADER_MINI_APP_JS_PATH,
  DOWNLOADER_MINI_APP_JS_VERSION,
} from "../src/mini-app-router";

async function sha256Prefix(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 8);
}

describe("Telegram Mini App static shell", () => {
  it("serves a strict same-origin document and separate assets", async () => {
    expect(MINI_APP_HTML).toContain('<script src="https://telegram.org/js/telegram-web-app.js"></script>');
    expect(MINI_APP_HTML).toContain('<script src="/mini-app.js" defer></script>');
    expect(MINI_APP_HTML).toContain('<link rel="stylesheet" href="/mini-app.css">');
    expect(MINI_APP_HTML).not.toMatch(/\son[a-z]+\s*=/iu);
    expect(MINI_APP_CSP).toContain("default-src 'none'");
    expect(MINI_APP_CSP).toContain("connect-src 'self'");
    expect(MINI_APP_CSP).toContain("script-src 'self' https://telegram.org");
    expect(MINI_APP_CSP).toContain("style-src 'self'");
    expect(MINI_APP_CSP).toContain("frame-ancestors https://web.telegram.org");

    const html = miniAppHtmlResponse();
    const css = miniAppCssResponse();
    const js = miniAppJsResponse();
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(html.headers.get("content-security-policy")).toBe(MINI_APP_CSP);
    expect(await html.text()).toBe(MINI_APP_HTML);
  });

  it("keeps canonical assets byte-equivalent but gives them immutable versioned caching", async () => {
    const canonicalHtml = await miniAppHtmlResponse(true).text();
    const canonicalCss = await miniAppCssResponse(true).text();
    const legacyCssResponse = miniAppCssResponse();
    const canonicalJsResponse = miniAppJsResponse(true);
    const legacyJsResponse = miniAppJsResponse();
    expect(canonicalHtml).toBe(MINI_APP_CANONICAL_HTML);
    expect(canonicalHtml).toContain(`href="${DOWNLOADER_MINI_APP_CSS_PATH}"`);
    expect(canonicalHtml).toContain(`src="${DOWNLOADER_MINI_APP_JS_PATH}"`);
    expect(canonicalCss).toBe(MINI_APP_CSS);
    expect(await canonicalJsResponse.text()).toBe(MINI_APP_CANONICAL_JS);
    expect(await legacyCssResponse.text()).toBe(canonicalCss);
    expect(await legacyJsResponse.text()).toBe(MINI_APP_JS);
    expect(miniAppCssResponse(true).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(canonicalJsResponse.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(legacyCssResponse.headers.get("cache-control")).toBe("no-store");
    expect(legacyJsResponse.headers.get("cache-control")).toBe("no-store");
    expect(legacyCssResponse.headers.has("set-cookie")).toBe(false);
    expect(legacyJsResponse.headers.has("set-cookie")).toBe(false);
    await expect(sha256Prefix(MINI_APP_CSS)).resolves.toBe(DOWNLOADER_MINI_APP_CSS_VERSION);
    await expect(sha256Prefix(MINI_APP_JS)).resolves.toBe(DOWNLOADER_MINI_APP_JS_VERSION);
  });

  it("returns headers without a response body for GET-equivalent HEAD requests", async () => {
    const html = miniAppHtmlResponse(true, true);
    const css = miniAppCssResponse(true, true);
    const js = miniAppJsResponse(true, true);
    expect(await html.text()).toBe("");
    expect(await css.text()).toBe("");
    expect(await js.text()).toBe("");
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("uses only Telegram raw initData and same-origin authenticated API calls", () => {
    expect(MINI_APP_JS).toContain("webApp.initData");
    expect(MINI_APP_JS).toContain('"authorization": "tma " + initData');
    expect(MINI_APP_JS).toContain('var path = "/api/apps/downloader/history?limit=" + PAGE_SIZE');
    expect(MINI_APP_JS).toContain('request("/api/apps/downloader/sources")');
    expect(MINI_APP_JS).toContain('mutateHistory("/api/apps/downloader/history/" + encodeURIComponent(id)');
    expect(MINI_APP_JS).toContain('mutateHistory("/api/apps/downloader/history",');
    expect(MINI_APP_JS).toContain("loadHistory(false)");
    expect(MINI_APP_JS).not.toContain("initDataUnsafe");
    expect(MINI_APP_JS).not.toContain("telegram_user_id");
    expect(MINI_APP_JS).not.toMatch(/fetch\s*\(\s*["']https?:/iu);
  });

  it("renders server values through textContent and includes accessible controls", () => {
    expect(MINI_APP_JS).toContain("textContent");
    expect(MINI_APP_JS).toContain("createElement");
    expect(MINI_APP_JS).toContain("item.safeLabel");
    expect(MINI_APP_JS).not.toContain("innerHTML");
    expect(MINI_APP_JS).toContain('item.status === "completed" || item.status === "failed"');
    expect(MINI_APP_HTML).toContain('role="status"');
    expect(MINI_APP_HTML).toContain('aria-live="polite"');
    expect(MINI_APP_HTML).toContain('id="load-more"');
    expect(MINI_APP_HTML).toContain('id="clear-history"');
    expect(MINI_APP_HTML).toContain('id="sources-list"');
    expect(MINI_APP_CSS).toContain("@media (max-width: 560px)");
    expect(MINI_APP_CSS).toContain("button:focus-visible");
  });

  it("keeps API failures generic and exposes temporary-file states", () => {
    expect(MINI_APP_JS).toContain("Something went wrong. Please try again.");
    expect(MINI_APP_JS).toContain('availability === "available"');
    expect(MINI_APP_JS).toContain('availability === "expired"');
    expect(MINI_APP_JS).toContain('availability === "pending"');
    expect(MINI_APP_JS).toContain('availability === "not_available"');
    expect(MINI_APP_JS).toContain('availability === "not_stored"');
    expect(MINI_APP_JS).toContain("Verified end to end in DigiBot");
    expect(MINI_APP_JS).toContain("Recognized/available through the engine but not yet verified");
    expect(MINI_APP_JS).toContain("Intentionally unsupported");
  });
});

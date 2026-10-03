import { afterEach, describe, expect, it, vi } from "vitest";

import { callTelegram, failSafely } from "../../../scripts/telegram-api.js";

const TOKEN = ["123456", "synthetic_test_token_that_is_not_a_real_secret"].join(":");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function configure(): void {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
  vi.stubEnv("TELEGRAM_BOT_API_BASE", "https://api.telegram.org");
}

describe("Telegram maintenance script transport", () => {
  it("uses one bounded, non-redirecting request", async () => {
    configure();
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ ok: true, result: { pending_update_count: 0 } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(callTelegram("getWebhookInfo")).resolves.toEqual({ pending_update_count: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects redirects without following them", async () => {
    configure();
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 307,
      headers: { location: "https://example.invalid/capture" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(callTelegram("setWebhook", { secret_token: "secret" })).rejects.toThrow("Telegram API request failed (307)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts a request after ten seconds", async () => {
    configure();
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));

    const pending = expect(callTelegram("getWebhookInfo")).rejects.toThrow("Telegram API request timed out");
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
  });

  it("keeps the same deadline while reading the response body", async () => {
    configure();
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
      }
    }), { headers: { "content-type": "application/json" } })));

    const pending = expect(callTelegram("getWebhookInfo")).rejects.toThrow("Telegram API request timed out");
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
  });

  it("rejects oversized and malformed responses", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(64 * 1024 + 1), {
      headers: { "content-type": "application/json" }
    })));
    await expect(callTelegram("getWebhookInfo")).rejects.toThrow("Telegram API response exceeded the size limit");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true })));
    await expect(callTelegram("getWebhookInfo")).rejects.toThrow("Telegram API request failed (200)");
  });

  it("redacts the configured token and webhook secret before exiting", () => {
    configure();
    const secret = "synthetic_webhook_secret";
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", secret);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });

    expect(() => failSafely(new Error(`bot${TOKEN} ${encodeURIComponent(TOKEN)} ${secret}`))).toThrow("exit");
    const output = String(error.mock.calls[0]?.[0]);
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(encodeURIComponent(TOKEN));
    expect(output).not.toContain(secret);
    expect(output).toContain("<redacted>");
  });
});

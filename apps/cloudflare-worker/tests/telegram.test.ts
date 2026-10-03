import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testFixedLengthStream } from "./helpers/fixed-length-stream";
import { TelegramApiError, TelegramClient, telegramErrorToApplicationError } from "../src/telegram";

const TOKEN = "12345:abcdefghijklmnopqrstuvwxyz_ABCDE";

function telegramResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}


afterEach(() => vi.unstubAllGlobals());

describe("TelegramClient", () => {
  it("accepts only the official origin without the injected-fetch seam", () => {
    expect(() => new TelegramClient({ token: TOKEN, apiBase: "https://evil.example.test" })).toThrow(/exactly https:\/\/api\.telegram\.org/iu);
    expect(() => new TelegramClient({ token: TOKEN, apiBase: "https://api.telegram.org/alternate" })).toThrow(/exactly https:\/\/api\.telegram\.org/iu);
  });

  it("uses the official origin and disables redirects for token-bearing calls", async () => {
    let request: { url: string; redirect?: RequestRedirect } | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = { url: String(input), redirect: init?.redirect };
      return telegramResponse({ ok: true, result: { message_id: 41 } });
    }) as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, apiBase: "https://api.telegram.org", fetchImpl });
    await expect(client.sendMessage("12345", "hello")).resolves.toMatchObject({ message_id: 41 });
    expect(request).toEqual({
      url: `https://api.telegram.org/bot${TOKEN}/sendMessage`,
      redirect: "manual",
    });
  });

  it("threads a message under the given reply target and allows sending without it", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return telegramResponse({ ok: true, result: { message_id: 45 } });
    }) as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl });
    await expect(client.sendMessage("12345", "verdict", undefined, 700)).resolves.toMatchObject({ message_id: 45 });
    await expect(client.sendMessage("12345", "plain")).resolves.toMatchObject({ message_id: 45 });
    expect(bodies).toEqual([
      { chat_id: "12345", text: "verdict", disable_web_page_preview: true, reply_parameters: { message_id: 700, allow_sending_without_reply: true } },
      { chat_id: "12345", text: "plain", disable_web_page_preview: true },
    ]);
  });

  it.each([300, 301, 302, 303, 307, 308, 399])("fails closed on HTTP %s before reading a redirect response body", async (status) => {
    const redirectResponse = {
      status,
      ok: false,
      headers: new Headers({ location: "https://redirect.example.test" }),
      get body() {
        throw new Error("redirect response body must not be read");
      },
    } as unknown as Response;
    const fetchImpl = vi.fn(async () => redirectResponse) as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl });

    await expect(client.sendMessage("12345", "hello")).rejects.toMatchObject({
      method: "sendMessage",
      httpStatus: status,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("permits an alternate or loopback origin only with an explicit injected fetch", async () => {
    let endpoint = "";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      endpoint = String(input);
      return telegramResponse({ ok: true, result: { message_id: 40 } });
    }) as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, apiBase: "http://127.0.0.1:8787", fetchImpl });
    await expect(client.sendMessage("12345", "hello")).resolves.toMatchObject({ message_id: 40 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(endpoint).toContain("http://127.0.0.1:8787/bot");
  });

  it("invokes fetch without rebinding its receiver", async () => {
    let receivedUndefinedReceiver = false;
    const fetchImpl = (function (this: unknown) {
      receivedUndefinedReceiver = this === undefined;
      return Promise.resolve(telegramResponse({ ok: true, result: { message_id: 42 } }));
    }) as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl });
    await expect(client.sendMessage("12345", "hello")).resolves.toMatchObject({ message_id: 42 });
    expect(receivedUndefinedReceiver).toBe(true);
  });

  it("does not retry sendMessage after an ambiguous network error", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("connection lost after dispatch"); }) as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl });
    await expect(client.sendMessage("12345", "hello")).rejects.toMatchObject({ method: "sendMessage", httpStatus: 599 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("applies one deadline through a slow response body and keeps the send outcome ambiguous", async () => {
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      pull: () => new Promise<void>(() => undefined),
    }), { status: 200 })) as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl, requestTimeoutMs: 10 });

    const error = await client.sendMessage("12345", "hello").catch((value: unknown) => value);
    expect(error).toMatchObject({
      method: "sendMessage",
      httpStatus: 598,
      outcome: "ambiguous",
      durableRetry: undefined,
    });
    expect(telegramErrorToApplicationError(error)).toMatchObject({ retryable: false });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not retry sendMessage after an ambiguous HTTP 5xx response", async () => {
    const fetchImpl = vi.fn(async () => telegramResponse({ ok: false, error_code: 503 }, 503)) as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl });
    await expect(client.sendMessage("12345", "hello")).rejects.toMatchObject({ method: "sendMessage", httpStatus: 503 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("bounds Telegram response bodies even when content-length is absent", async () => {
    const oversized = JSON.stringify({ ok: false, description: "x".repeat(140 * 1024) });
    const fetchImpl = vi.fn(async () => new Response(oversized, {
      status: 502,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl });
    await expect(client.sendMessage("12345", "hello")).rejects.toMatchObject({
      method: "sendMessage",
      httpStatus: 502,
      apiErrorCode: undefined,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries sendMessage only after explicit HTTP/body 429 using identical endpoint and body", async () => {
    const requests: Array<{ url: string; body: BodyInit | null | undefined }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: init?.body });
      if (requests.length === 1) return telegramResponse({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, 429);
      if (requests.length === 2) return telegramResponse({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, 200);
      return telegramResponse({ ok: true, result: { message_id: 44 } });
    }) as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl, delayImpl: async () => undefined });
    await expect(client.sendMessage("12345", "hello")).resolves.toMatchObject({ message_id: 44 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(new Set(requests.map((request) => request.url)).size).toBe(1);
    expect(new Set(requests.map((request) => String(request.body))).size).toBe(1);
  });

  it("bounds explicit rate-limit retries to three attempts", async () => {
    const fetchImpl = vi.fn(async () => telegramResponse({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, 429)) as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl, delayImpl: async () => undefined });
    await expect(client.sendMessage("12345", "hello")).rejects.toMatchObject({ httpStatus: 429, apiErrorCode: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry an explicit HTTP 429 when the response body omits retry_after", async () => {
    const fetchImpl = vi.fn(async () => telegramResponse({ ok: false, error_code: 429 }, 429)) as unknown as typeof fetch;
    const delayImpl = vi.fn(async () => undefined);
    const client = new TelegramClient({ token: TOKEN, fetchImpl, delayImpl });
    await expect(client.sendMessage("12345", "hello")).rejects.toMatchObject({
      httpStatus: 429,
      apiErrorCode: 429,
      retryAfter: undefined,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(delayImpl).not.toHaveBeenCalled();
  });

  it.each([
    { label: "zero", retryAfter: 0 },
    { label: "fractional", retryAfter: 1.5 },
    { label: "string", retryAfter: "1" },
    { label: "unsafe", retryAfter: Number.MAX_SAFE_INTEGER + 1 },
  ])("does not retry an HTTP 429 with a $label retry_after", async ({ retryAfter }) => {
    const fetchImpl = vi.fn(async () => telegramResponse({
      ok: false,
      error_code: 429,
      parameters: { retry_after: retryAfter },
    }, 429)) as unknown as typeof fetch;
    const delayImpl = vi.fn(async () => undefined);
    const client = new TelegramClient({ token: TOKEN, fetchImpl, delayImpl });
    await expect(client.sendMessage("12345", "hello")).rejects.toMatchObject({
      httpStatus: 429,
      retryAfter: undefined,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(delayImpl).not.toHaveBeenCalled();
  });

  it.each([31, 86_400, 86_401, Number.MAX_SAFE_INTEGER])("exposes valid $retryAfter-second rate limits for durable retry without shortening or sleeping", async (retryAfter) => {
    const fetchImpl = vi.fn(async () => telegramResponse({
      ok: false,
      error_code: 429,
      parameters: { retry_after: retryAfter },
    }, 429)) as unknown as typeof fetch;
    const delayImpl = vi.fn(async () => undefined);
    const client = new TelegramClient({ token: TOKEN, fetchImpl, delayImpl });
    await expect(client.sendMessage("12345", "hello")).rejects.toMatchObject({
      httpStatus: 429,
      retryAfter,
      outcome: "rejected",
      durableRetry: { kind: "telegram-rate-limit", retryAfterSeconds: retryAfter },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(delayImpl).not.toHaveBeenCalled();
  });

  it("does not retry a body-only 429 without a valid retry_after", async () => {
    const fetchImpl = vi.fn(async () => telegramResponse({ ok: false, error_code: 429 }, 200)) as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl, delayImpl: async () => undefined });
    await expect(client.sendMessage("12345", "hello")).rejects.toMatchObject({
      httpStatus: 200,
      apiErrorCode: 429,
      retryAfter: undefined,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not treat a body 429 inside HTTP 5xx as retry-safe", async () => {
    const fetchImpl = vi.fn(async () => telegramResponse({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, 503)) as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl, delayImpl: async () => undefined });
    await expect(client.sendMessage("12345", "hello")).rejects.toMatchObject({
      httpStatus: 503,
      apiErrorCode: 429,
      retryAfter: undefined,
      durableRetry: undefined,
      outcome: "ambiguous",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not retry a 5xx body-level 429 through a retry-safe method", async () => {
    const fetchImpl = vi.fn(async () => telegramResponse({
      ok: false,
      error_code: 429,
      parameters: { retry_after: 1 },
    }, 503)) as unknown as typeof fetch;
    const delayImpl = vi.fn(async () => undefined);
    const client = new TelegramClient({ token: TOKEN, fetchImpl, delayImpl });
    await expect(client.sendChatAction("12345", "upload_video")).rejects.toMatchObject({
      httpStatus: 503,
      apiErrorCode: 429,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(delayImpl).not.toHaveBeenCalled();
  });

  it("does not treat a body 429 inside a non-2xx 4xx response as retry-safe", async () => {
    const fetchImpl = vi.fn(async () => telegramResponse({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, 400)) as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl, delayImpl: async () => undefined });
    await expect(client.sendMessage("12345", "hello")).rejects.toMatchObject({ httpStatus: 400, apiErrorCode: 429 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    ["a non-boolean ok field", { ok: "true", result: { message_id: 42 } }],
    ["a wrong-shaped result", { ok: true, result: { message_id: "42" } }],
    ["a null result", { ok: true, result: null }],
  ])("rejects %s as an ambiguous 2xx response", async (_label, response) => {
    const fetchImpl = vi.fn(async () => telegramResponse(response)) as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl });
    await expect(client.sendMessage("12345", "hello")).rejects.toMatchObject({
      method: "sendMessage",
      httpStatus: 200,
      apiErrorCode: undefined,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("classifies a documented body-level 4xx error inside HTTP 2xx as a confirmed rejection", async () => {
    const fetchImpl = vi.fn(async () => telegramResponse({ ok: false, error_code: 400 })) as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl });
    await expect(client.sendMessage("12345", "hello")).rejects.toMatchObject({
      httpStatus: 200,
      apiErrorCode: 400,
      outcome: "rejected",
      durableRetry: undefined,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps retry-safe behavior for sendChatAction", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("temporary network error");
      return telegramResponse({ ok: true, result: true });
    }) as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl });
    await expect(client.sendChatAction("12345", "upload_video")).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps bounded generic 5xx retries for retry-safe methods", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? telegramResponse({ ok: false, error_code: 503 }, 503)
        : telegramResponse({ ok: true, result: true });
    }) as unknown as typeof fetch;
    const delayImpl = vi.fn(async () => undefined);
    const client = new TelegramClient({ token: TOKEN, fetchImpl, delayImpl });
    await expect(client.sendChatAction("12345", "upload_video")).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(delayImpl).toHaveBeenCalledWith(250);
  });

  it("keeps edit, delete, and copy one-shot after ambiguous failures", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      throw new TypeError("connection lost after dispatch");
    }) as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl });
    await expect(client.editMessageText("12345", "41", "updated")).rejects.toMatchObject({ method: "editMessageText" });
    await expect(client.deleteMessage("12345", "41")).rejects.toMatchObject({ method: "deleteMessage" });
    await expect(client.copyMessage("12345", "12345", "41")).rejects.toMatchObject({ method: "copyMessage" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(requests.map((url) => url.split("/").at(-1))).toEqual(["editMessageText", "deleteMessage", "copyMessage"]);
  });

  it("copies a reusable media message once without retrying an ambiguous send", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return telegramResponse({ ok: true, result: { message_id: 43 } });
    }) as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl });
    await expect(client.copyMessage("12345", "12345", "42")).resolves.toMatchObject({ message_id: 43 });
    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ chat_id: "12345", from_chat_id: "12345", message_id: "42" });
  });

  it("does not retry a stale reusable message rejection", async () => {
    const fetchImpl = vi.fn(async () => telegramResponse({ ok: false, error_code: 400 }, 400)) as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl });
    await expect(client.copyMessage("12345", "12345", "42")).rejects.toBeInstanceOf(TelegramApiError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("streams one exact multipart document with a known total length and digest", async () => {
    const expectedLengths = testFixedLengthStream();
    const file = new TextEncoder().encode("exact streamed bytes");
    let uploaded = new Uint8Array();
    let contentType = "";
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      contentType = new Headers(init?.headers).get("content-type") ?? "";
      uploaded = new Uint8Array(await new Response(init?.body).arrayBuffer());
      return telegramResponse({
        ok: true,
        result: { message_id: 42, chat: { id: 12345 }, document: { file_id: "telegram_file_1" } },
      });
    }) as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl });

    await expect(client.sendDocumentStream(
      "12345", stream(file), file.byteLength, "original-audio.mp3", "audio/mpeg",
      createHash("sha256").update(file).digest("hex"),
    )).resolves.toEqual({ messageId: "42", fileId: "telegram_file_1" });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(contentType).toMatch(/^multipart\/form-data; boundary=digibot-[a-f0-9]{32}$/u);
    expect(expectedLengths).toEqual([uploaded.byteLength]);
    const multipart = new TextDecoder().decode(uploaded);
    expect(multipart).toContain('name="chat_id"\r\n\r\n12345');
    expect(multipart).toContain('name="disable_content_type_detection"\r\n\r\ntrue');
    expect(multipart).toContain('name="document"; filename="original-audio.mp3"');
    expect(multipart).toContain("Content-Type: audio/mpeg\r\n\r\nexact streamed bytes");
  });

  it.each([
    { label: "overflow", declared: 4, bytes: "extra" },
    { label: "underflow", declared: 6, bytes: "short" },
    { label: "digest mismatch", declared: 5, bytes: "short", digest: "f".repeat(64) },
  ])("aborts one streamed send on $label without retrying", async ({ declared, bytes, digest }) => {
    testFixedLengthStream();
    const file = new TextEncoder().encode(bytes);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Response(init?.body).arrayBuffer();
      return telegramResponse({ ok: true, result: { message_id: 42 } });
    }) as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl });

    await expect(client.sendDocumentStream(
      "12345", stream(file), declared, "original.png", "image/png",
      digest ?? createHash("sha256").update(file).digest("hex"),
    )).rejects.toMatchObject({ method: "sendDocument", httpStatus: 599, outcome: "ambiguous" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects an oversized streamed document before dispatch", async () => {
    testFixedLengthStream();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl });
    await expect(client.sendDocumentStream(
      "12345", stream(new Uint8Array()), 49_000_001, "original.png", "image/png", "a".repeat(64),
    )).rejects.toMatchObject({ method: "sendDocument", httpStatus: 400, outcome: "rejected" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps a streamed timeout ambiguous and never resends the document", async () => {
    testFixedLengthStream();
    const file = new TextEncoder().encode("timeout");
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl, requestTimeoutMs: 10 });
    await expect(client.sendDocumentStream(
      "12345", stream(file), file.byteLength, "original.png", "image/png",
      createHash("sha256").update(file).digest("hex"),
    )).rejects.toMatchObject({ method: "sendDocument", httpStatus: 598, outcome: "ambiguous" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects a streamed receipt for a different chat without retrying", async () => {
    testFixedLengthStream();
    const file = new TextEncoder().encode("receipt");
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Response(init?.body).arrayBuffer();
      return telegramResponse({
        ok: true,
        result: { message_id: 42, chat: { id: 67890 }, document: { file_id: "telegram_file_1" } },
      });
    }) as unknown as typeof fetch;
    const client = new TelegramClient({ token: TOKEN, fetchImpl });
    await expect(client.sendDocumentStream(
      "12345", stream(file), file.byteLength, "original.png", "image/png",
      createHash("sha256").update(file).digest("hex"),
    )).rejects.toMatchObject({ method: "sendDocument", httpStatus: 200, outcome: "ambiguous" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

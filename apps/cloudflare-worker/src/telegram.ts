import { createHash } from "node:crypto";
import { ApplicationError } from "./errors";
import type { TelegramApiResponse, TelegramInlineKeyboardButton, TelegramMessageResult } from "./types";

const DEFAULT_API_BASE = "https://api.telegram.org";
const MAX_API_RESPONSE_BYTES = 128 * 1024;
const MAX_IN_CALL_RATE_LIMIT_DELAY_SECONDS = 30;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_STREAMED_DOCUMENT_BYTES = 49_000_000;
const STREAMED_DOCUMENT_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;
const STREAMED_DOCUMENT_MIME = /^[a-z][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
type TelegramRetryPolicy = "retry-safe" | "rate-limit-only" | "none";

interface TelegramStreamPayload {
  kind: "stream";
  body: ReadableStream<Uint8Array>;
  contentType: string;
}

interface TelegramDocumentResult {
  message_id?: unknown;
  chat?: { id?: unknown };
  document?: { file_id?: unknown };
}

export type TelegramRequestOutcome = "rejected" | "ambiguous";

export interface TelegramDurableRetry {
  kind: "telegram-rate-limit";
  retryAfterSeconds: number;
}

export interface TelegramClientOptions {
  token: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  /** Test-only scheduling seam; production uses real bounded delays. */
  delayImpl?: (milliseconds: number) => Promise<void>;
  requestTimeoutMs?: number;
}

export class TelegramApiError extends Error {
  readonly method: string;
  readonly httpStatus: number;
  readonly apiErrorCode: number | undefined;
  readonly retryAfter: number | undefined;
  readonly durableRetry: TelegramDurableRetry | undefined;
  readonly outcome: TelegramRequestOutcome;
  readonly description: string | undefined;

  constructor(
    method: string,
    httpStatus: number,
    response?: TelegramApiResponse<unknown>,
    outcome?: TelegramRequestOutcome,
  ) {
    super("Telegram API request failed");
    this.name = "TelegramApiError";
    this.method = method;
    this.httpStatus = httpStatus;
    this.apiErrorCode = response?.error_code;
    const bodyRejection = response?.ok === false
      && httpStatus >= 200
      && httpStatus < 300
      && typeof response.error_code === "number"
      && response.error_code >= 400
      && response.error_code < 500;
    const explicitRateLimit = httpStatus === 429 || (bodyRejection && response?.error_code === 429);
    this.retryAfter = explicitRateLimit && validRetryAfter(response?.parameters?.retry_after)
      ? response.parameters.retry_after
      : undefined;
    this.durableRetry = this.retryAfter === undefined
      ? undefined
      : { kind: "telegram-rate-limit", retryAfterSeconds: this.retryAfter };
    this.outcome = outcome ?? (bodyRejection || (httpStatus >= 400 && httpStatus < 500) ? "rejected" : "ambiguous");
    this.description = response?.description;
  }
}

function validRetryAfter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isStreamPayload(value: Record<string, unknown> | FormData | TelegramStreamPayload): value is TelegramStreamPayload {
  return !(value instanceof FormData) && value.kind === "stream"
    && value.body instanceof ReadableStream && typeof value.contentType === "string";
}

function documentReceipt(result: TelegramDocumentResult, chatId: string): { messageId: string; fileId: string } {
  if (!Number.isSafeInteger(result.message_id) || Number(result.message_id) <= 0
    || String(result.chat?.id) !== chatId || typeof result.document?.file_id !== "string"
    || !/^[A-Za-z0-9_-]{1,512}$/u.test(result.document.file_id)) throw new TelegramApiError("sendDocument", 200);
  return { messageId: String(result.message_id), fileId: result.document.file_id };
}

function normalizeApiBase(input: string, allowInjectedFetchOrigin: boolean): string {
  const parsed = new URL(input);
  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Telegram API base must not contain credentials or query data");
  if (!allowInjectedFetchOrigin) {
    if (parsed.origin !== DEFAULT_API_BASE || parsed.pathname !== "/") {
      throw new Error("Telegram API base must be exactly https://api.telegram.org in production");
    }
    return DEFAULT_API_BASE;
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal)) {
    throw new Error("Telegram API base must use HTTPS, except localhost development behind the injected-fetch seam");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function readJsonResponse(response: Response, signal: AbortSignal): Promise<TelegramApiResponse<unknown> | undefined> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_API_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      if (!next.value) continue;
      total += next.value.byteLength;
      if (total > MAX_API_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as TelegramApiResponse<unknown>;
  } catch (error) {
    if (signal.aborted) {
      void reader.cancel().catch(() => undefined);
      throw error;
    }
    return undefined;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A deadline can win while a test-injected stream still has a pending read.
    }
  }
}

export function telegramErrorToApplicationError(error: unknown): ApplicationError {
  if (!(error instanceof TelegramApiError)) return new ApplicationError("TELEGRAM_UPLOAD_FAILED", { cause: error });
  const explicitRateLimit = error.httpStatus === 429
    || (error.apiErrorCode === 429 && error.httpStatus >= 200 && error.httpStatus < 300);
  if (explicitRateLimit && error.retryAfter !== undefined) {
    return new ApplicationError("TELEGRAM_RATE_LIMITED", { retryable: true, cause: error });
  }
  if (error.httpStatus === 413 || error.apiErrorCode === 413) return new ApplicationError("TELEGRAM_FILE_TOO_LARGE", { cause: error });
  if (error.httpStatus === 401) return new ApplicationError("INTERNAL_ERROR", { cause: error });
  return new ApplicationError("TELEGRAM_UPLOAD_FAILED", {
    retryable: error.outcome === "rejected" && error.httpStatus >= 500,
    cause: error,
  });
}

export class TelegramClient {
  private readonly token: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly delayImpl: (milliseconds: number) => Promise<void>;
  private readonly requestTimeoutMs: number;

  constructor(options: TelegramClientOptions) {
    if (!options.token) throw new Error("missing Telegram token");
    this.token = options.token;
    this.apiBase = normalizeApiBase(options.apiBase ?? DEFAULT_API_BASE, options.fetchImpl !== undefined);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.delayImpl = options.delayImpl ?? delay;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error("Telegram request timeout must be a positive safe integer");
    }
  }

  private endpoint(method: string): string {
    // Never expose or log the returned URL: the token is intentionally in its path.
    return `${this.apiBase}/bot${this.token}/${method}`;
  }

  private async call<T>(method: string, payload: Record<string, unknown> | FormData | TelegramStreamPayload, retryPolicy: TelegramRetryPolicy): Promise<T> {
    const maxAttempts = retryPolicy === "none" ? 1 : 3;
    const stream = isStreamPayload(payload) ? payload : null;
    if (stream && retryPolicy !== "none") throw new Error("Streamed Telegram requests must not be retried in-call");
    const endpoint = this.endpoint(method);
    const deadlineAt = Date.now() + this.requestTimeoutMs;
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(), this.requestTimeoutMs);
    const requestInit: RequestInit = {
      method: "POST",
      ...(stream ? { headers: { "content-type": stream.contentType } }
        : payload instanceof FormData ? {} : { headers: { "content-type": "application/json" } }),
      body: stream?.body ?? (payload instanceof FormData ? payload : JSON.stringify(payload)),
      signal: deadline.signal,
      // Cloudflare Workers supports "manual" but rejects "error" at runtime.
      // Never follow a redirect for token-bearing Telegram calls; the status
      // check below fails closed before reading any redirect response body.
      redirect: "manual",
    };
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let response: Response;
        try {
          // Cloudflare's global fetch is receiver-sensitive. Detach it from this
          // client before invocation so it is called like the global function.
          const fetchImpl = this.fetchImpl;
          response = await abortable(fetchImpl(endpoint, requestInit), deadline.signal);
        } catch {
          if (deadline.signal.aborted) throw new TelegramApiError(method, 598, undefined, "ambiguous");
          if (attempt < maxAttempts && retryPolicy === "retry-safe") {
            const waitMilliseconds = 250 * 2 ** (attempt - 1);
            if (Date.now() + waitMilliseconds >= deadlineAt) throw new TelegramApiError(method, 599, undefined, "ambiguous");
            await abortable(this.delayImpl(waitMilliseconds), deadline.signal);
            continue;
          }
          throw new TelegramApiError(method, 599, undefined, "ambiguous");
        }
        if (response.status >= 300 && response.status < 400) {
          throw new TelegramApiError(method, response.status, undefined, "ambiguous");
        }
        let parsed: TelegramApiResponse<unknown> | undefined;
        try {
          parsed = await readJsonResponse(response, deadline.signal);
        } catch {
          throw new TelegramApiError(method, 598, undefined, "ambiguous");
        }
        if (response.ok && parsed?.ok === true && parsed.result !== undefined && parsed.result !== null) return parsed.result as T;
        const apiError = new TelegramApiError(method, response.status, parsed);
        // A rate limit is retryable in-call only when Telegram supplied a valid
        // bounded delay. Never invent or shorten a delay, and never reinterpret
        // a 5xx body-level 429 as a generic retry-safe server failure.
        const retryAfter = apiError.retryAfter;
        const retryableRateLimit = retryAfter !== undefined
          && retryAfter <= MAX_IN_CALL_RATE_LIMIT_DELAY_SECONDS;
        const retryableServerFailure = retryPolicy === "retry-safe"
          && response.status >= 500
          && parsed?.error_code !== 429;
        if (attempt < maxAttempts && retryPolicy !== "none") {
          const waitMilliseconds = retryableRateLimit
            ? retryAfter * 1_000
            : retryableServerFailure
              ? 250 * 2 ** (attempt - 1)
              : undefined;
          if (waitMilliseconds !== undefined) {
            if (Date.now() + waitMilliseconds >= deadlineAt) throw apiError;
            try {
              await abortable(this.delayImpl(waitMilliseconds), deadline.signal);
            } catch {
              if (retryableRateLimit) throw apiError;
              throw new TelegramApiError(method, deadline.signal.aborted ? 598 : 599, undefined, "ambiguous");
            }
            continue;
          }
        }
        throw apiError;
      }
      throw new TelegramApiError(method, 599, undefined, "ambiguous");
    } catch (error) {
      if (deadline.signal.aborted && !(error instanceof TelegramApiError)) {
        throw new TelegramApiError(method, 598, undefined, "ambiguous");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getFile(fileId: string): Promise<unknown> {
    return this.call<unknown>("getFile", { file_id: fileId }, "none");
  }

  async getMe(): Promise<{ id: number; username: string }> {
    const result = await this.call<{ id?: unknown; username?: unknown }>("getMe", {}, "retry-safe");
    if (!Number.isSafeInteger(result.id) || Number(result.id) <= 0
      || typeof result.username !== "string" || !/^[A-Za-z0-9_]{5,32}$/u.test(result.username)) throw new TelegramApiError("getMe", 200);
    return { id: Number(result.id), username: result.username };
  }

  /** Exact file upload; never ask Telegram to recompress an image as a photo. */
  async sendDocument(chatId: string, file: Blob, filename: string): Promise<{ messageId: string; fileId: string }> {
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set("document", file, filename);
    form.set("disable_content_type_detection", "true");
    return documentReceipt(await this.call<TelegramDocumentResult>("sendDocument", form, "none"), chatId);
  }

  /** Stream an exact, bounded R2 object as multipart without buffering it in Worker memory. */
  async sendDocumentStream(
    chatId: string,
    body: ReadableStream<Uint8Array>,
    byteLength: number,
    filename: string,
    mimeType: string,
    expectedSha256: string,
  ): Promise<{ messageId: string; fileId: string }> {
    const validChat = /^[1-9]\d{0,19}$/u.test(chatId) && Number.isSafeInteger(Number(chatId)) && String(Number(chatId)) === chatId;
    if (!validChat || !Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > MAX_STREAMED_DOCUMENT_BYTES
      || !STREAMED_DOCUMENT_FILENAME.test(filename) || !STREAMED_DOCUMENT_MIME.test(mimeType) || !SHA256.test(expectedSha256)) {
      throw new TelegramApiError("sendDocument", 400, undefined, "rejected");
    }

    const boundary = `digibot-${crypto.randomUUID().replaceAll("-", "")}`;
    const prefix = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`
      + `--${boundary}\r\nContent-Disposition: form-data; name="disable_content_type_detection"\r\n\r\ntrue\r\n`
      + `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\n`
      + `Content-Type: ${mimeType}\r\n\r\n`,
    );
    const suffix = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const fixed = new FixedLengthStream(prefix.byteLength + byteLength + suffix.byteLength);
    const writer = fixed.writable.getWriter();
    const reader = body.getReader();
    const pump = (async () => {
      try {
        await writer.write(prefix);
        const hash = createHash("sha256");
        let streamed = 0;
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          streamed += next.value.byteLength;
          if (streamed > byteLength) throw new TelegramApiError("sendDocument", 599, undefined, "ambiguous");
          hash.update(next.value);
          await writer.write(next.value);
        }
        if (streamed !== byteLength || hash.digest("hex") !== expectedSha256) {
          throw new TelegramApiError("sendDocument", 599, undefined, "ambiguous");
        }
        await writer.write(suffix);
        await writer.close();
      } catch (error) {
        const failure = error instanceof TelegramApiError
          ? error
          : new TelegramApiError("sendDocument", 599, undefined, "ambiguous");
        void writer.abort(failure).catch(() => undefined);
        throw failure;
      }
    })();
    const request = this.call<TelegramDocumentResult>("sendDocument", {
      kind: "stream",
      body: fixed.readable,
      contentType: `multipart/form-data; boundary=${boundary}`,
    }, "none");
    try {
      const [result] = await Promise.all([request, pump]);
      return documentReceipt(result, chatId);
    } catch (error) {
      void reader.cancel(error).catch(() => undefined);
      void writer.abort(error).catch(() => undefined);
      throw error instanceof TelegramApiError
        ? error
        : new TelegramApiError("sendDocument", 599, undefined, "ambiguous");
    } finally {
      try { reader.releaseLock(); } catch { /* A failed stream can retain a pending read. */ }
      try { writer.releaseLock(); } catch { /* A failed fetch can retain a pending write. */ }
    }
  }

  /** Retrieve bounded bytes without exposing the token-bearing download URL. */
  async downloadFile(fileId: string, maxBytes: number): Promise<Uint8Array> {
    const metadata = await this.getFile(fileId) as { file_path?: unknown; file_size?: unknown } | null;
    if (!metadata || typeof metadata.file_path !== "string" || metadata.file_path.length > 512
      || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/u.test(metadata.file_path)
      || (metadata.file_size !== undefined && (!Number.isSafeInteger(metadata.file_size) || Number(metadata.file_size) > maxBytes))) {
      throw new TelegramApiError("getFile", 200);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const fetchImpl = this.fetchImpl;
      const response = await abortable(fetchImpl(`${this.apiBase}/file/bot${this.token}/${metadata.file_path}`, {
        redirect: "manual", signal: controller.signal,
      }), controller.signal);
      if (!response.ok || !response.body || Number(response.headers.get("content-length") ?? 0) > maxBytes) throw new TelegramApiError("getFile", response.status);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const next = await abortable(reader.read(), controller.signal);
          if (next.done) break;
          length += next.value.byteLength;
          if (length > maxBytes) throw new TelegramApiError("getFile", 413);
          chunks.push(next.value);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    } finally { clearTimeout(timer); }
  }

  async sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: { inline_keyboard: TelegramInlineKeyboardButton[][] },
    replyToMessageId?: number,
  ): Promise<TelegramMessageResult> {
    // Message creation is non-idempotent. Retry only Telegram's explicit 429
    // rejection, which confirms that no message was created.
    const result = await this.call<unknown>("sendMessage", {
      chat_id: chatId,
      text: text.slice(0, 4096),
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      // A deleted target still gets the message, just not threaded under it.
      ...(replyToMessageId !== undefined ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}),
    }, "rate-limit-only");
    if (typeof result !== "object" || result === null
      || !Number.isSafeInteger((result as { message_id?: unknown }).message_id)
      || Number((result as { message_id?: unknown }).message_id) <= 0) {
      throw new TelegramApiError("sendMessage", 200);
    }
    return result as TelegramMessageResult;
  }

  async editMessageText(chatId: string, messageId: string, text: string): Promise<boolean | TelegramMessageResult> {
    return this.call<boolean | TelegramMessageResult>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: text.slice(0, 4096),
      disable_web_page_preview: true,
    }, "none");
  }

  async answerCallbackQuery(callbackQueryId: string, text: string): Promise<boolean> {
    return this.call<boolean>("answerCallbackQuery", { callback_query_id: callbackQueryId, text: text.slice(0, 200) }, "none");
  }

  async clearInlineKeyboard(chatId: string, messageId: string): Promise<boolean | TelegramMessageResult> {
    return this.call<boolean | TelegramMessageResult>("editMessageReplyMarkup", {
      chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] },
    }, "none");
  }

  async deleteMessage(chatId: string, messageId: string): Promise<boolean> {
    return this.call<boolean>("deleteMessage", { chat_id: chatId, message_id: messageId }, "none");
  }

  async sendChatAction(chatId: string, action: "upload_video" | "upload_document" | "upload_audio"): Promise<boolean> {
    return this.call<boolean>("sendChatAction", { chat_id: chatId, action }, "retry-safe");
  }

  /**
   * Copy a previously delivered media message within the same private chat.
   * This is intentionally one-shot: retrying after an ambiguous response could
   * create a duplicate Telegram message.
   */
  async copyMessage(chatId: string, fromChatId: string, messageId: string): Promise<TelegramMessageResult> {
    const result = await this.call<TelegramMessageResult>("copyMessage", {
      chat_id: chatId,
      from_chat_id: fromChatId,
      message_id: messageId,
    }, "none");
    if (!Number.isSafeInteger(result.message_id) || result.message_id <= 0) {
      throw new TelegramApiError("copyMessage", 502);
    }
    return result;
  }

}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

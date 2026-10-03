const TOKEN_PATTERN = /^\d{5,12}:[A-Za-z0-9_-]{30,}$/u;
const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function telegramApiUrl(method: string): URL {
  if (!METHOD_PATTERN.test(method)) {
    throw new Error("Telegram API method has an invalid shape");
  }
  const token = requiredEnv("TELEGRAM_BOT_TOKEN");
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error("TELEGRAM_BOT_TOKEN has an invalid shape");
  }
  const configuredBase = process.env.TELEGRAM_BOT_API_BASE?.trim() || "https://api.telegram.org";
  const base = new URL(configuredBase);
  if (base.protocol !== "https:" && !isLoopbackHttp(base)) {
    throw new Error("TELEGRAM_BOT_API_BASE must use HTTPS unless it is a loopback development server");
  }
  return new URL(`/bot${token}/${method}`, base);
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
}

export async function callTelegram<T>(method: string, body?: object): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(telegramApiUrl(method), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        redirect: "manual",
        signal: controller.signal
      });
    } catch {
      throw new Error(controller.signal.aborted ? "Telegram API request timed out" : "Telegram API request failed");
    }

    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`Telegram API request failed (${response.status})`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("Telegram API returned an invalid response");
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("Telegram API response exceeded the size limit");
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("Telegram API returned an invalid response");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new Error("Telegram API response exceeded the size limit");
        }
        chunks.push(value);
      }
    } catch {
      if (controller.signal.aborted) throw new Error("Telegram API request timed out");
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Telegram API response exceeded the size limit");
      throw new Error("Telegram API request failed");
    } finally {
      reader.releaseLock();
    }
    const encoded = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      encoded.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(encoded)) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      payload = parsed as Record<string, unknown>;
    } catch {
      throw new Error("Telegram API returned an invalid response");
    }
    if (!response.ok || payload.ok !== true || payload.result === undefined) {
      const code = Number.isSafeInteger(payload.error_code) ? payload.error_code : response.status;
      throw new Error(`Telegram API request failed (${String(code)})`);
    }
    return payload.result as T;
  } finally {
    clearTimeout(timeout);
  }
}

export function failSafely(error: unknown): never {
  let message = error instanceof Error ? error.message : "Unknown error";
  for (const name of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"] as const) {
    const value = process.env[name]?.trim();
    if (!value) continue;
    for (const candidate of new Set([value, encodeURIComponent(value)])) {
      message = message.split(candidate).join("<redacted>");
    }
  }
  console.error(message.replace(/bot\d{5,12}:[A-Za-z0-9_-]+/gu, "bot<redacted>"));
  process.exit(1);
  throw new Error("Process exit failed");
}

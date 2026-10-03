import { constantTimeEqual } from "./security";
import { parseAllowedTelegramUserIds } from "./telegram-user-ids";

const encoder = new TextEncoder();

export const MINI_APP_INIT_DATA_MAX_BYTES = 8 * 1024;
export const MINI_APP_INIT_DATA_MAX_AGE_SECONDS = 5 * 60;
export const MINI_APP_INIT_DATA_FUTURE_SKEW_SECONDS = 30;
const MAX_INIT_DATA_FIELDS = 32;

export interface AuthenticatedMiniAppUser {
  userId: string;
  authDate: number;
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[A-Fa-f0-9]{64}$/u.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    if (!Number.isInteger(byte)) return null;
    bytes[index] = byte;
  }
  return bytes;
}

async function hmacSha256(keyBytes: Uint8Array, message: string): Promise<Uint8Array> {
  const keyData = new Uint8Array(keyBytes).buffer;
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function parseUniqueFields(initData: string): Map<string, string> | null {
  if (!initData || encoder.encode(initData).byteLength > MINI_APP_INIT_DATA_MAX_BYTES) return null;
  const fields = new Map<string, string>();
  const entries = [...new URLSearchParams(initData).entries()];
  if (entries.length === 0 || entries.length > MAX_INIT_DATA_FIELDS) return null;
  for (const [key, value] of entries) {
    if (!key || fields.has(key)) return null;
    fields.set(key, value);
  }
  return fields;
}

function parseTelegramUserId(fields: ReadonlyMap<string, string>): string | null {
  const rawUser = fields.get("user");
  if (!rawUser) return null;
  try {
    const parsed = JSON.parse(rawUser) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const user = parsed as { id?: unknown; is_bot?: unknown };
    if (!Number.isSafeInteger(user.id) || Number(user.id) <= 0 || user.is_bot === true) return null;
    return String(user.id);
  } catch {
    return null;
  }
}

/**
 * Validate Telegram.WebApp.initData exactly as Telegram documents for a bot
 * backend. The client-provided initDataUnsafe object and user-ID headers are
 * intentionally never consulted.
 */
export async function validateTelegramMiniAppInitDataIdentity(
  initData: string,
  botToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<AuthenticatedMiniAppUser | null> {
  if (!botToken) return null;
  const fields = parseUniqueFields(initData);
  if (!fields) return null;

  const providedHash = hexToBytes(fields.get("hash") ?? "");
  const rawAuthDate = fields.get("auth_date") ?? "";
  if (!providedHash || !/^\d{1,12}$/u.test(rawAuthDate)) return null;
  const authDate = Number(rawAuthDate);
  if (
    !Number.isSafeInteger(authDate) ||
    authDate > nowSeconds + MINI_APP_INIT_DATA_FUTURE_SKEW_SECONDS ||
    nowSeconds - authDate > MINI_APP_INIT_DATA_MAX_AGE_SECONDS
  ) {
    return null;
  }

  const dataCheckString = [...fields.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = await hmacSha256(encoder.encode("WebAppData"), botToken);
  const expectedHash = await hmacSha256(secretKey, dataCheckString);
  if (!constantTimeEqual(expectedHash, providedHash)) return null;

  const userId = parseTelegramUserId(fields);
  return userId ? { userId, authDate } : null;
}

export async function validateTelegramMiniAppInitData(
  initData: string,
  botToken: string,
  allowedUserIds: ReadonlySet<string>,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<AuthenticatedMiniAppUser | null> {
  const user = await validateTelegramMiniAppInitDataIdentity(initData, botToken, nowSeconds);
  return user && allowedUserIds.has(user.userId) ? user : null;
}

export function miniAppInitDataFromRequest(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^tma ([^\r\n]+)$/iu);
  const initData = match?.[1] ?? "";
  return initData && encoder.encode(initData).byteLength <= MINI_APP_INIT_DATA_MAX_BYTES ? initData : null;
}

export async function authenticateMiniAppRequest(
  request: Request,
  botToken: string,
  allowedUserIdsValue: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<AuthenticatedMiniAppUser | null> {
  const initData = miniAppInitDataFromRequest(request);
  if (!initData) return null;
  const allowedUserIds = parseAllowedTelegramUserIds(allowedUserIdsValue);
  if (!allowedUserIds) return null;
  return validateTelegramMiniAppInitData(
    initData,
    botToken,
    allowedUserIds,
    nowSeconds,
  );
}

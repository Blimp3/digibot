import { describe, expect, it } from "vitest";
import {
  authenticateMiniAppRequest,
  MINI_APP_INIT_DATA_MAX_AGE_SECONDS,
  validateTelegramMiniAppInitData,
  validateTelegramMiniAppInitDataIdentity,
} from "../src/mini-app-auth";

const encoder = new TextEncoder();
const BOT_TOKEN = "test-bot-token";
const USER_ID = 12345;
const NOW = 1_800_000_000;

async function hmac(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(keyBytes).buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signedInitData(
  fields: Record<string, string> = {
    auth_date: String(NOW),
    query_id: "opaque-query",
    user: JSON.stringify({ id: USER_ID, first_name: "Test" }),
  },
): Promise<string> {
  const dataCheckString = Object.entries(fields)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = await hmac(encoder.encode("WebAppData"), BOT_TOKEN);
  const signature = hex(await hmac(secretKey, dataCheckString));
  return new URLSearchParams({ ...fields, hash: signature }).toString();
}

describe("Telegram Mini App initData authentication", () => {
  it("accepts fresh signed initData for an allowlisted Telegram user", async () => {
    const result = await validateTelegramMiniAppInitData(
      await signedInitData(),
      BOT_TOKEN,
      new Set([String(USER_ID)]),
      NOW,
    );

    expect(result).toEqual({ userId: String(USER_ID), authDate: NOW });
  });

  it("keeps signature validation separate without weakening legacy allowlisting", async () => {
    const initData = await signedInitData();
    expect(await validateTelegramMiniAppInitDataIdentity(initData, BOT_TOKEN, NOW)).toEqual({
      userId: String(USER_ID),
      authDate: NOW,
    });
    expect(await validateTelegramMiniAppInitData(initData, BOT_TOKEN, new Set(["99999"]), NOW)).toBeNull();
  });

  it("rejects tampering, unallowlisted users, and stale or future data", async () => {
    const valid = await signedInitData();
    const tamperedFields = new URLSearchParams(valid);
    tamperedFields.set("user", JSON.stringify({ id: 99999, first_name: "Test" }));
    const tampered = tamperedFields.toString();
    expect(await validateTelegramMiniAppInitData(tampered, BOT_TOKEN, new Set([String(USER_ID)]), NOW)).toBeNull();
    expect(await validateTelegramMiniAppInitData(valid, BOT_TOKEN, new Set(["99999"]), NOW)).toBeNull();
    expect(await validateTelegramMiniAppInitData(await signedInitData({
      auth_date: String(NOW - MINI_APP_INIT_DATA_MAX_AGE_SECONDS - 1),
      user: JSON.stringify({ id: USER_ID }),
    }), BOT_TOKEN, new Set([String(USER_ID)]), NOW)).toBeNull();
    expect(await validateTelegramMiniAppInitData(await signedInitData({
      auth_date: String(NOW + 31),
      user: JSON.stringify({ id: USER_ID }),
    }), BOT_TOKEN, new Set([String(USER_ID)]), NOW)).toBeNull();
  });

  it("rejects missing, malformed, and duplicate required fields", async () => {
    expect(await validateTelegramMiniAppInitData("", BOT_TOKEN, new Set([String(USER_ID)]), NOW)).toBeNull();
    expect(await validateTelegramMiniAppInitData("auth_date=1&user=%7B%7D&hash=bad", BOT_TOKEN, new Set([String(USER_ID)]), NOW)).toBeNull();
    const valid = await signedInitData();
    expect(await validateTelegramMiniAppInitData(`${valid}&hash=${"0".repeat(64)}`, BOT_TOKEN, new Set([String(USER_ID)]), NOW)).toBeNull();
  });

  it("uses only the signed Authorization initData and ignores client user-ID headers", async () => {
    const initData = await signedInitData();
    const request = new Request("https://worker.example/api/history", {
      headers: {
        authorization: `tma ${initData}`,
        "x-telegram-user-id": "99999",
      },
    });

    expect(await authenticateMiniAppRequest(request, BOT_TOKEN, `${USER_ID},67890`, NOW)).toEqual({
      userId: String(USER_ID),
      authDate: NOW,
    });
    expect(await authenticateMiniAppRequest(request, BOT_TOKEN, "99999")).toBeNull();
    expect(await authenticateMiniAppRequest(request, BOT_TOKEN, `${USER_ID},${USER_ID}`, NOW)).toBeNull();
  });
});

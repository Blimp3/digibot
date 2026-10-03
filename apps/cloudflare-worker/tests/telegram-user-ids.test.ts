import { describe, expect, it } from "vitest";
import { parseAllowedTelegramUserIds } from "../src/telegram-user-ids";

describe("shared Telegram user-ID configuration", () => {
  it.each([
    "12345",
    "12345,67890,24680",
    "12345,12345",
    "12345,not-a-user-id",
    "0,67890",
    "-12345,67890",
    "9007199254740992,67890",
    ",12345",
    "12345,",
  ])("rejects a non-exact or malformed serialization: %s", (value) => {
    expect(parseAllowedTelegramUserIds(value)).toBeNull();
  });

  it("accepts exactly two distinct positive safe-integer IDs in the existing comma format", () => {
    expect(parseAllowedTelegramUserIds("12345, 67890")).toEqual(new Set(["12345", "67890"]));
    expect(parseAllowedTelegramUserIds("12345 67890")).toEqual(new Set(["12345", "67890"]));
  });
});

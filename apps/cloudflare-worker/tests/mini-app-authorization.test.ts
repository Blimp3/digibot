import { describe, expect, it } from "vitest";
import { authorizeMiniAppUser } from "../src/mini-app-authorization";
import { MINI_APP_REGISTRY } from "../src/mini-app-router";

describe("Mini App authorization", () => {
  it("turns shared Telegram authentication into an immutable app-scoped principal", () => {
    const principal = authorizeMiniAppUser(
      MINI_APP_REGISTRY.downloader,
      { userId: "12345", authDate: 1_800_000_000 },
    );
    expect(principal).toEqual({ appId: "downloader", userId: "12345", authDate: 1_800_000_000 });
    expect(Object.isFrozen(principal)).toBe(true);
  });

  it("rejects an app whose id and authorization policy disagree", () => {
    expect(authorizeMiniAppUser(
      { ...MINI_APP_REGISTRY.downloader, id: "other" },
      { userId: "12345", authDate: 1_800_000_000 },
    )).toBeNull();
  });
});

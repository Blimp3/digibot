import { describe, expect, it } from "vitest";
import { hmacSha256Hex } from "../src/crypto";

describe("keyed source URL digest", () => {
  it("is stable for one secret and URL without containing the URL", async () => {
    const url = "https://www.youtube.com/watch?v=public-example";
    const first = await hmacSha256Hex("secret-a", url);
    const second = await hmacSha256Hex("secret-a", url);

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).not.toContain("youtube");
    expect(first).not.toContain("public-example");
  });

  it("does not permit cross-secret correlation and rejects an absent key", async () => {
    const url = "https://www.instagram.com/reel/example/";
    await expect(hmacSha256Hex("", url)).rejects.toThrow("missing digest secret");
    await expect(hmacSha256Hex("secret-a", url)).resolves.not.toBe(await hmacSha256Hex("secret-b", url));
  });

  it("uses a domain-separated digest rather than raw HMAC(URL)", async () => {
    const secret = "secret-a";
    const url = "https://youtu.be/example";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const raw = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(url)));
    const rawHex = [...raw].map((byte) => byte.toString(16).padStart(2, "0")).join("");

    await expect(hmacSha256Hex(secret, url)).resolves.not.toBe(rawHex);
  });
});

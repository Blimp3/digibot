import { describe, expect, it } from "vitest";
import { bytesToBase64Url, createDownloadToken, sanitizeFilename, verifyDownloadToken } from "../src/security";

describe("signed download tokens", () => {
  it("accepts an unmodified token and rejects a modified token", async () => {
    const token = await createDownloadToken("test-secret", {
      objectKey: "jobs/123e4567-e89b-12d3-a456-426614174000/video.mp4",
      filename: "video.mp4",
      mimeType: "video/mp4",
      exp: 2_000_000_000,
    });
    expect(await verifyDownloadToken("test-secret", token, 1_900_000_000)).not.toBeNull();
    expect(await verifyDownloadToken("test-secret", `${token}x`, 1_900_000_000)).toBeNull();
    expect(await verifyDownloadToken("wrong-secret", token, 1_900_000_000)).toBeNull();
  });

  it("rejects an expired token and sanitizes path traversal", async () => {
    const token = await createDownloadToken("test-secret", {
      objectKey: "jobs/123e4567-e89b-12d3-a456-426614174000/video.mp4",
      filename: "../private\nfile.mp4",
      mimeType: "video/mp4",
      exp: 100,
    });
    expect(await verifyDownloadToken("test-secret", token, 100)).toBeNull();
    expect(sanitizeFilename("../private\nfile.mp4")).toBe("privatefile.mp4");
  });

  it("accepts the compact token shape emitted by the Python container", async () => {
    const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
      k: "jobs/123e4567-e89b-12d3-a456-426614174000/video.mp4",
      n: "video.mp4",
      e: 2_000_000_000,
    })));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("test-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))));
    expect(await verifyDownloadToken("test-secret", `${payload}.${signature}`, 1_900_000_000)).toMatchObject({
      objectKey: "jobs/123e4567-e89b-12d3-a456-426614174000/video.mp4",
      filename: "video.mp4",
      exp: 2_000_000_000,
    });
  });

  it("accepts Python compact tokens for bracketed yt-dlp output names", async () => {
    const objectKey = "jobs/123e4567-e89b-12d3-a456-426614174000/Title [abc] + {clip}.mp4";
    const filename = "Title [abc] + {clip}.mp4";
    const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ k: objectKey, n: filename, e: 2_000_000_000 })));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("test-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))));
    expect(await verifyDownloadToken("test-secret", `${payload}.${signature}`, 1_900_000_000)).toMatchObject({ objectKey, filename });
  });
});

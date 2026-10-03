import { describe, expect, it } from "vitest";
import { getWorkerConfig } from "../src/config";
import { ApplicationError } from "../src/errors";
import { extractSingleUrl, isBlockedHost, validateSourceUrl } from "../src/url";

const config = getWorkerConfig({
  ALLOWED_SOURCE_HOSTS: "youtube.com,youtu.be",
  MAX_URL_LENGTH: "2048",
} as never);

describe("source URL validation", () => {
  it("uses a bounded default and accepts a configured job timeout", () => {
    expect(getWorkerConfig({} as never).jobTimeoutSeconds).toBe(1200);
    expect(getWorkerConfig({ JOB_TIMEOUT_SECONDS: "45" } as never).jobTimeoutSeconds).toBe(45);
    expect(getWorkerConfig({ JOB_TIMEOUT_SECONDS: "0" } as never).jobTimeoutSeconds).toBe(1200);
    expect(getWorkerConfig({} as never).maxTranscriptDurationSeconds).toBe(900);
    expect(getWorkerConfig({} as never).transcriptionTimeoutSeconds).toBe(1800);
    expect(getWorkerConfig({ TRANSCRIPTION_TIMEOUT_SECONDS: "3600", MAX_TRANSCRIPT_DURATION_SECONDS: "1800" } as never).transcriptionTimeoutSeconds).toBe(1800);
    expect(getWorkerConfig({ TRANSCRIPTION_TIMEOUT_SECONDS: "3600", MAX_TRANSCRIPT_DURATION_SECONDS: "1800" } as never).maxTranscriptDurationSeconds).toBe(900);
  });

  it("extracts one URL and removes a trailing sentence delimiter", () => {
    expect(extractSingleUrl("https://youtu.be/example.")).toBe("https://youtu.be/example");
    expect(extractSingleUrl("https://youtu.be/a https://youtu.be/b")).toBeNull();
  });

  it("rejects credentials, private addresses, and unconfigured hosts", () => {
    expect(() => validateSourceUrl("https://user:pass@youtube.com/watch?v=x", config)).toThrowError(ApplicationError);
    expect(() => validateSourceUrl("http://127.0.0.1/private", config)).toThrowError(ApplicationError);
    expect(() => validateSourceUrl("https://example.com/video", config)).toThrowError(/source/i);
  });

  it.each([
    ["[::1]", "[::1]"],
    ["[fd00::1]", "[fd00::1]"],
    ["[::ffff:127.0.0.1]", "[::ffff:7f00:1]"],
    ["[::127.0.0.1]", "[::7f00:1]"],
    ["[64:ff9b::127.0.0.1]", "[64:ff9b::7f00:1]"],
    ["[64:ff9b:1::10.0.0.1]", "[64:ff9b:1::a00:1]"],
    ["[2002:7f00:1::]", "[2002:7f00:1::]"],
    ["[fec0::1]", "[fec0::1]"],
    ["0x7f000001", "127.0.0.1"],
    ["127.1", "127.0.0.1"],
  ] as const)("blocks the loopback or private literal %s as the parser canonicalizes it", (literal, canonical) => {
    expect(new URL(`http://${literal}/`).hostname).toBe(canonical);
    expect(isBlockedHost(canonical)).toBe(true);
    expect(() => validateSourceUrl(`http://${literal}/private`, config)).toThrowError(expect.objectContaining({ code: "INVALID_URL" }) as Error);
  });

  it("leaves a public IPv6 literal to the host allowlist", () => {
    expect(isBlockedHost("[2606:4700:4700::1111]")).toBe(false);
    expect(() => validateSourceUrl("http://[2606:4700:4700::1111]/", config)).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_HOST" }) as Error);
  });

  it.each([
    "vimeo.com",
    "www.vimeo.com",
    "player.vimeo.com",
    "reddit.com",
    "www.reddit.com",
    "old.reddit.com",
    "np.reddit.com",
    "nm.reddit.com",
    "redditmedia.com",
    "www.redditmedia.com",
    "pinterest.com",
    "www.pinterest.com",
    "pinterest.ca",
    "www.pinterest.ca",
    "co.pinterest.com",
    "www.ted.com",
    "embed.ted.com",
    "embed-ssl.ted.com",
  ] as const)("accepts the configured initial host %s", (hostname) => {
    const validated = validateSourceUrl(`https://${hostname}/public-item`, getWorkerConfig({} as never));
    expect(validated.hostname).toBe(hostname);
  });

  it.each([
    "evil.vimeo.com",
    "vimeo.com.evil.example",
    "evil.reddit.com",
    "reddit.com.evil.example",
    "evil.pinterest.com",
    "pinterest.com.evil.example",
    "evil.ted.com",
    "ted.com.evil.example",
  ] as const)("rejects lookalike or confused subdomain %s", (hostname) => {
    expect(() => validateSourceUrl(`https://${hostname}/public-item`, getWorkerConfig({} as never))).toThrowError(/source/i);
  });
});

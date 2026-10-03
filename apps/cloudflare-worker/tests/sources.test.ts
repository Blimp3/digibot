import { describe, expect, it } from "vitest";
import {
  formatSourceCatalog,
  initialPreparationMessage,
  SOURCE_CATALOG,
  sourceForValidatedUrl,
} from "../src/sources";

describe("source catalog", () => {
  it("keeps verification claims limited to the proven DigiBot paths", () => {
    expect(SOURCE_CATALOG.find((source) => source.id === "youtube")).toMatchObject({ state: "verified", coverage: "Public videos" });
    expect(SOURCE_CATALOG.find((source) => source.id === "instagram")).toMatchObject({ state: "verified", coverage: "Public Reels" });
    expect(SOURCE_CATALOG.find((source) => source.id === "youtube-music")).toMatchObject({ state: "recognized_unverified", coverage: "Public tracks as M4A audio" });
    expect(SOURCE_CATALOG.find((source) => source.id === "tiktok")?.state).toBe("recognized_unverified");
    expect(SOURCE_CATALOG.find((source) => source.id === "x-twitter")?.state).toBe("recognized_unverified");
    for (const id of ["vimeo", "reddit", "pinterest", "ted"]) {
      expect(SOURCE_CATALOG.find((source) => source.id === id)).toMatchObject({
        state: "recognized_unverified",
        coverage: "Engine-recognized public links",
      });
    }
    expect(SOURCE_CATALOG.find((source) => source.id === "protected-content")?.state).toBe("intentionally_unsupported");
  });

  it.each([
    ["youtube.com", "youtube"],
    ["www.youtube.com", "youtube"],
    ["m.youtube.com", "youtube"],
    ["music.youtube.com", "youtube-music"],
    ["youtu.be", "youtube"],
    ["instagram.com", "instagram"],
    ["www.instagram.com", "instagram"],
    ["vm.tiktok.com", "tiktok"],
    ["x.com", "x-twitter"],
    ["twitter.com", "x-twitter"],
    ["vimeo.com", "vimeo"],
    ["www.vimeo.com", "vimeo"],
    ["player.vimeo.com", "vimeo"],
    ["reddit.com", "reddit"],
    ["www.reddit.com", "reddit"],
    ["old.reddit.com", "reddit"],
    ["np.reddit.com", "reddit"],
    ["nm.reddit.com", "reddit"],
    ["redditmedia.com", "reddit"],
    ["www.redditmedia.com", "reddit"],
    ["pinterest.com", "pinterest"],
    ["www.pinterest.com", "pinterest"],
    ["pinterest.ca", "pinterest"],
    ["www.pinterest.ca", "pinterest"],
    ["co.pinterest.com", "pinterest"],
    ["www.ted.com", "ted"],
    ["embed.ted.com", "ted"],
    ["embed-ssl.ted.com", "ted"],
  ] as const)("maps the exact validated hostname %s", (hostname, id) => {
    expect(sourceForValidatedUrl({ hostname })).toMatchObject({ id });
  });

  it("does not map lookalike or unrelated hosts", () => {
    for (const hostname of [
      "evil-youtube.com",
      "youtube.com.evil.example",
      "evil.vimeo.com",
      "vimeo.com.evil.example",
      "evil.reddit.com",
      "reddit.com.evil.example",
      "evil.pinterest.com",
      "pinterest.com.evil.example",
      "evil.ted.com",
      "ted.com.evil.example",
      "example.com",
    ]) {
      expect(sourceForValidatedUrl({ hostname })).toBeNull();
    }
    expect(sourceForValidatedUrl({ hostname: "WWW.INSTAGRAM.COM." })).toMatchObject({ id: "instagram" });
    for (const hostname of [
      "VIMEO.COM.",
      "WWW.REDDIT.COM.",
      "PINTEREST.CA.",
      "EMBED.TED.COM.",
    ]) {
      expect(sourceForValidatedUrl({ hostname })).not.toBeNull();
    }
  });

  it("renders all three catalog states for Telegram and future clients", () => {
    const text = formatSourceCatalog();
    expect(text).toContain("Verified end to end in DigiBot");
    expect(text).toContain("Recognized/available through the engine but not yet verified");
    expect(text).toContain("Intentionally unsupported");
    expect(text).toContain("Private, login-gated, age-gated, DRM, CAPTCHA, paywalled, or unauthorized media");
    for (const name of ["YouTube Music", "Vimeo", "Reddit", "Pinterest", "TED"]) expect(text).toContain(name);
  });

  it("builds a provider-aware cold-path status without including the URL", () => {
    const youtube = SOURCE_CATALOG.find((source) => source.id === "youtube");
    expect(youtube).toBeDefined();
    const text = initialPreparationMessage(youtube ?? null, "video");
    expect(text).toContain("Accepted");
    expect(text).toContain("preparing video");
    expect(text).toContain("YouTube");
    expect(text).not.toContain("http");
  });

  it("shows the interpreted trim range and shorter-media behavior", () => {
    const youtube = SOURCE_CATALOG.find((source) => source.id === "youtube");
    expect(initialPreparationMessage(youtube ?? null, "video", { startSeconds: 720, endSeconds: 1020 })).toContain(
      "Trim: from 12:00 to 17:00 (5 minutes; end stops at media end if shorter).",
    );
  });
});

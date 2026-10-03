import type { WorkerConfig } from "./config";
import { ApplicationError, errorCodeFromContainerResult } from "./errors";
import type { Env } from "./types";
import { validateSourceUrl } from "./url";

export const MAX_YOUTUBE_ITEMS = 5;
export interface YouTubeCollectionCommand {
  kind: "youtube_collection";
  collection: "playlist" | "channel";
  sourceUrl: string;
  count: number;
  format: "video" | "m4a" | "mp3";
}

/** Canonical inputs only: never turn a feed, mix, search or arbitrary site into a batch. */
export function youtubeCollectionUrl(input: string, kind: "playlist" | "channel", config: Pick<WorkerConfig, "allowedSourceHosts" | "maxUrlLength">): string {
  const validated = validateSourceUrl(input, config);
  const url = new URL(validated.url);
  if (!["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(url.hostname)
    || url.port || /[\\\p{Cc}]/u.test(input)) throw new ApplicationError("INVALID_URL");
  let canonical: string;
  if (kind === "playlist") {
    const list = url.searchParams.get("list") ?? "";
    if (!["/playlist", "/watch"].includes(url.pathname) || url.searchParams.getAll("list").length !== 1
      || !/^(?:PL[A-Za-z0-9_-]{10,100}|UU[A-Za-z0-9_-]{22}|OLAK5uy_[A-Za-z0-9_-]{10,100})$/u.test(list)) {
      throw new ApplicationError("INVALID_URL");
    }
    canonical = `https://www.youtube.com/playlist?list=${list}`;
  } else {
    // Known limit: ASCII handles/legacy names only; use the stable /channel/UC… URL for other names.
    const path = url.pathname.replace(/\/$/u, "").replace(/\/videos$/u, "");
    if (!/^\/(?:@[A-Za-z0-9_.-]{3,30}|channel\/UC[A-Za-z0-9_-]{22}|(?:c|user)\/[A-Za-z0-9_.-]{1,100})$/u.test(path)) {
      throw new ApplicationError("INVALID_URL");
    }
    canonical = `https://www.youtube.com${path}/videos`;
  }
  return validateSourceUrl(canonical, config).url;
}

export function youtubeCollectionItems(value: unknown, count: number): string[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_YOUTUBE_ITEMS
    || !value || typeof value !== "object" || Array.isArray(value)) throw new ApplicationError("MEDIA_UNAVAILABLE");
  const result = value as Record<string, unknown>;
  if (result.status === "failure" || result.status === "failed") throw new ApplicationError(errorCodeFromContainerResult(typeof result.errorCode === "string" ? result.errorCode : "MEDIA_UNAVAILABLE"));
  if (result.status !== "success" || !Array.isArray(result.videoIds) || !result.videoIds.length || result.videoIds.length > count
    || result.videoIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{11}$/u.test(id))
    || new Set(result.videoIds).size !== result.videoIds.length) throw new ApplicationError("MEDIA_UNAVAILABLE");
  return (result.videoIds as string[]).map(id => `https://www.youtube.com/watch?v=${id}`);
}

/** One metadata-only lookup; media is never downloaded on the webhook invocation. */
export async function resolveYouTubeCollection(env: Env, command: YouTubeCollectionCommand): Promise<string[]> {
  const stub = env.DOWNLOADER_CONTAINER.getByName("personal");
  const controller = new AbortController();
  const deadlineAt = Date.now() / 1000 + 20;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new ApplicationError("DOWNLOAD_TIMEOUT")); }, 20_000);
  });
  try {
    const pending = stub.fetch(new Request("https://downloader.internal/v1/youtube/resolve", {
      method: "POST", redirect: "manual", signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${env.INTERNAL_CONTAINER_SECRET}`,
        "x-digibot-deadline-at": String(deadlineAt) },
      body: JSON.stringify({ sourceUrl: command.sourceUrl, kind: command.collection, count: command.count }),
    }));
    void pending.then(late => { if (controller.signal.aborted) void late.body?.cancel().catch(() => undefined); }, () => undefined);
    response = await Promise.race([pending, timeout]);
    if (!response.ok || response.redirected || !response.body) throw new ApplicationError("MEDIA_UNAVAILABLE");
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0, text = "";
    while (true) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4096) throw new ApplicationError("MEDIA_UNAVAILABLE");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return youtubeCollectionItems(JSON.parse(text + decoder.decode()) as unknown, command.count);
  } finally {
    clearTimeout(timer);
    if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    else if (response) void response.body?.cancel().catch(() => undefined);
  }
}

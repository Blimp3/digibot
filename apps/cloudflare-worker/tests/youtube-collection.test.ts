import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSourceUrl } from "../src/crypto";
import { createJobsWithUpdateReservations, getUserQueue, QueueLimitError, type NewJob } from "../src/db";
import { handleTelegramWebhook, parseTelegramCommand } from "../src/webhook";
import { resolveYouTubeCollection, youtubeCollectionItems, youtubeCollectionUrl } from "../src/youtube-collection";
import type { D1BatchDatabaseLike, Env, JobRecord } from "../src/types";
import { localD1 } from "./helpers/local-d1";

const PLAYLIST = "https://www.youtube.com/playlist?list=PL1234567890123456";
const IDS = ["BaW_jenozKc", "jNQXAC9IVRw", "aqz-KE-bpKQ"];
const config = { allowedSourceHosts: new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "example.com"]), maxUrlLength: 2048 };

describe("YouTube-only bounded collection contract", () => {
  it("parses explicit commands and leaves bare links single-item", () => {
    expect(parseTelegramCommand(`/playlist ${PLAYLIST}`)).toEqual({ kind: "youtube_collection", collection: "playlist", sourceUrl: PLAYLIST, count: 3, format: "video" });
    expect(parseTelegramCommand("/channel@DigiBot https://youtube.com/@YouTube 5 MP3")).toMatchObject({ collection: "channel", count: 5, format: "mp3" });
    expect(parseTelegramCommand(PLAYLIST)).toMatchObject({ kind: "media", mode: "video" });
    expect(parseTelegramCommand(`/video ${PLAYLIST}`)).toMatchObject({ kind: "media", pickQuality: true });
    for (const args of ["0", "6", "-1", "3.1", "all", "3 audio", "3 video extra", "3 --exec", "3 m4a first 10 seconds"]) {
      expect(parseTelegramCommand(`/playlist ${PLAYLIST} ${args}`)).toBeNull();
    }
  });

  it("canonicalizes shared playlist links and pins channels to the Videos tab", () => {
    expect(youtubeCollectionUrl(`${PLAYLIST}&si=share&index=10`, "playlist", config)).toBe(PLAYLIST);
    expect(youtubeCollectionUrl("https://music.youtube.com/watch?v=BaW_jenozKc&list=PL1234567890123456", "playlist", config)).toBe(PLAYLIST);
    for (const path of ["/@YouTube", "/@YouTube/videos/", "/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw", "/user/Google", "/c/Google"]) {
      expect(youtubeCollectionUrl(`https://youtube.com${path}?si=share`, "channel", config)).toMatch(/^https:\/\/www.youtube.com\/.+\/videos$/u);
    }
  });

  it.each([
    ["https://example.com/playlist?list=PL1234567890123456", "playlist"],
    ["https://youtube.com.evil.example/playlist?list=PL1234567890123456", "playlist"],
    ["https://youtube.com:8443/playlist?list=PL1234567890123456", "playlist"],
    ["https://user:pass@youtube.com/playlist?list=PL1234567890123456", "playlist"],
    ["http://127.0.0.1/playlist?list=PL1234567890123456", "playlist"],
    ["https://youtube.com/playlist?list=RDBaW_jenozKc", "playlist"],
    ["https://youtube.com/playlist?list=WL", "playlist"],
    ["https://youtube.com/playlist?list=PL1234567890123456&list=PL9999999999999999", "playlist"],
    ["https://youtube.com/results?list=PL1234567890123456", "playlist"],
    ["https://youtube.com/feed/subscriptions", "channel"],
    ["https://youtube.com/@YouTube/shorts", "channel"],
    ["https://youtube.com/@YouTube/streams", "channel"],
    ["https://youtube.com/@YouTube%2Fvideos", "channel"],
    ["https://youtu.be/BaW_jenozKc", "channel"],
  ] as const)("rejects unsafe or unbounded collection %s", (url, kind) => {
    expect(() => youtubeCollectionUrl(url, kind, config)).toThrow();
  });

  it("trusts only distinct bounded video IDs, never returned URLs", () => {
    expect(youtubeCollectionItems({ status: "success", videoIds: IDS }, 3)).toEqual(IDS.map(id => `https://www.youtube.com/watch?v=${id}`));
    for (const videoIds of [[], [...IDS, "XXXXXXXXXXX"], [IDS[0], IDS[0]], ["http://127.0.0.1"], [12], ["bad"]]) {
      expect(() => youtubeCollectionItems({ status: "success", videoIds }, 3)).toThrow();
    }
    expect(() => youtubeCollectionItems({ status: "failed", errorCode: "LOGIN_REQUIRED", safeMessage: "untrusted" }, 3)).toThrow(/requires sign-in/u);
  });
});

describe("atomic collection admission and one-shot lookup", () => {
  let database: Awaited<ReturnType<typeof localD1>>;
  let db: D1BatchDatabaseLike;
  let env: Env;
  let resolve: ReturnType<typeof vi.fn>;
  const sent: string[] = [];
  const pending: Promise<unknown>[] = [];
  const limits = { maxActiveJobs: 1, maxActiveTranscriptions: 1, maxJobsPerHour: 20, hourlyWindowStart: "2026-01-01T00:00:00.000Z" };
  function request(id = 1, text = `/playlist ${PLAYLIST} 3 m4a`, user = 12345): Request {
    return new Request("https://worker.example/telegram/webhook", {
      method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "webhook-secret" },
      body: JSON.stringify({ update_id: id, message: { message_id: id, from: { id: user }, chat: { id: user, type: "private" }, text } }),
    });
  }
  async function submit(id = 1, text?: string, user?: number): Promise<Record<string, unknown>> {
    return (await handleTelegramWebhook(request(id, text, user), env, work => pending.push(work))).json();
  }
  async function drain(): Promise<void> { await Promise.all(pending.splice(0)); }
  async function jobs(): Promise<JobRecord[]> { return (await db.prepare("SELECT * FROM jobs ORDER BY created_at, id").all<JobRecord>()).results; }
  function newJobs(prefix: string, count: number): NewJob[] {
    return Array.from({ length: count }, (_, index) => ({
      id: crypto.randomUUID(), telegramUpdateId: `${prefix}:${index}`, telegramUserId: "12345", telegramChatId: "12345",
      requestMessageId: "1", sourceHost: "www.youtube.com", sourceUrlHash: `${prefix}-${index}`, sourceUrlEncrypted: "encrypted",
      requestedMode: "video", requestedQuality: "max-1080p", createdAt: new Date(Date.now() + index).toISOString(),
    }));
  }
  beforeAll(async () => { database = await localD1(); db = database.db; }, 30_000);
  afterAll(async () => { await database?.dispose(); vi.unstubAllGlobals(); });
  beforeEach(async () => {
    await drain();
    await db.batch([db.prepare("DELETE FROM telegram_notices"), db.prepare("DELETE FROM jobs"), db.prepare("DELETE FROM processed_updates")]);
    resolve = vi.fn(async () => Response.json({ status: "success", videoIds: IDS }));
    env = { DB: db, TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_WEBHOOK_SECRET: "webhook-secret", INTERNAL_CONTAINER_SECRET: "internal-secret",
      ALLOWED_TELEGRAM_USER_IDS: "12345,67890", DOWNLOAD_LINK_HMAC_SECRET: "download-hmac", ALLOWED_SOURCE_HOSTS: [...config.allowedSourceHosts].join(","),
      PUBLIC_WORKER_BASE_URL: "https://worker.example", DOWNLOADER_CONTAINER: { getByName: () => ({ fetch: resolve }) },
      MEDIA_WORKFLOW: { create: vi.fn(async () => ({ status: async () => ({ status: "running" }) })) },
    } as unknown as Env;
    sent.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { text?: string };
      if (body.text) sent.push(body.text);
      return Response.json({ ok: true, result: { message_id: sent.length + 1000 } });
    }));
  });

  it("snapshots once and admits encrypted ordinary jobs in source order, with per-item budgets", async () => {
    expect(await submit()).toMatchObject({ accepted: true, collectionPending: true });
    await drain();
    const admitted = await jobs();
    expect(admitted).toHaveLength(3);
    expect(await Promise.all(admitted.map(job => decryptSourceUrl("internal-secret", job.source_url_encrypted!)))).toEqual(IDS.map(id => `https://www.youtube.com/watch?v=${id}`));
    expect(admitted.map(job => job.requested_quality)).toEqual(["m4a", "m4a", "m4a"]);
    expect(admitted.every(job => job.requested_operation === "download" && job.source_host === "www.youtube.com")).toBe(true);
    expect(admitted.map(job => job.telegram_update_id)).toEqual(["1:youtube:1", "1:youtube:2", "1:youtube:3"]);
    expect((await getUserQueue(db, "12345")).map(job => job.id)).toEqual(admitted.map(job => job.id));
    expect(await getUserQueue(db, "67890")).toEqual([]);
    expect(sent.some(text => text.includes("Queued 3 YouTube M4A"))).toBe(true);
    const input = resolve.mock.calls[0]![0] as Request;
    expect(await input.json()).toEqual({ sourceUrl: PLAYLIST, kind: "playlist", count: 3 });
    expect(input.headers.get("x-digibot-deadline-at")).not.toBeNull();
    expect(await db.prepare("SELECT job_id, collection_user_id FROM processed_updates WHERE telegram_update_id = '1'").first()).toEqual({ job_id: null, collection_user_id: "12345" });
  });

  it("does not expand duplicate updates or allow rapid collection retries", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => submit()));
    await drain();
    expect(results.filter(result => result.collectionPending)).toHaveLength(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(await jobs()).toHaveLength(3);
    expect(await submit(2, `/playlist ${PLAYLIST} 1`)).toMatchObject({ error: "SOURCE_RATE_LIMITED" });
    await drain();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("rejects unauthorized and non-YouTube inputs before metadata or admission", async () => {
    expect(await submit(1, undefined, 999)).toMatchObject({ ignored: true });
    expect(await submit(2, "/playlist https://example.com/playlist?list=PL1234567890123456")).toMatchObject({ error: "INVALID_URL" });
    await drain();
    expect(resolve).not.toHaveBeenCalled();
    expect(await jobs()).toEqual([]);
  });

  it("rolls back the entire batch when the queue fills during lookup", async () => {
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    resolve.mockImplementation(async () => { await gate; return Response.json({ status: "success", videoIds: IDS }); });
    await submit();
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    await createJobsWithUpdateReservations(db, newJobs("other", 3), limits);
    release();
    await drain();
    expect(await jobs()).toHaveLength(3);
    expect((await jobs()).every(job => job.telegram_update_id.startsWith("other:"))).toBe(true);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM processed_updates WHERE telegram_update_id LIKE '1:youtube:%' AND job_id IS NOT NULL").first()).toEqual({ n: 0 });
    expect(sent.some(text => text.startsWith("Nothing from this batch was queued"))).toBe(true);
  });

  it("atomically enforces hourly limits and concurrent batch queue caps", async () => {
    await expect(createJobsWithUpdateReservations(db, newJobs("hourly", 3), { ...limits, maxJobsPerHour: 2 })).rejects.toThrow(/hourly/u);
    expect(await jobs()).toEqual([]);
    const results = await Promise.allSettled([createJobsWithUpdateReservations(db, newJobs("a", 3), limits), createJobsWithUpdateReservations(db, newJobs("b", 3), limits)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: expect.any(QueueLimitError) });
    expect(await jobs()).toHaveLength(3);
  });

  it("keeps a shorter bounded slice and never refills or retries a provider failure", async () => {
    resolve.mockResolvedValueOnce(Response.json({ status: "success", videoIds: [IDS[0]] }));
    await submit(); await drain();
    expect(await jobs()).toHaveLength(1);
    expect(sent.some(text => text.includes("nothing beyond it was added"))).toBe(true);
    await db.prepare("UPDATE processed_updates SET created_at = '2020-01-01T00:00:00.000Z' WHERE collection_user_id IS NOT NULL").run();
    resolve.mockResolvedValueOnce(Response.json({ status: "failed", errorCode: "LOGIN_REQUIRED" }));
    await submit(2); await drain();
    expect(await jobs()).toHaveLength(1);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(sent.some(text => text.includes("requires sign-in"))).toBe(true);
  });

  it("bounds streamed metadata and rejects redirects", async () => {
    const command = { kind: "youtube_collection" as const, collection: "playlist" as const, sourceUrl: PLAYLIST, count: 3, format: "video" as const };
    resolve.mockResolvedValueOnce(new Response("x".repeat(4097)));
    await expect(resolveYouTubeCollection(env, command)).rejects.toThrow();
    resolve.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://127.0.0.1" } }));
    await expect(resolveYouTubeCollection(env, command)).rejects.toThrow();
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});

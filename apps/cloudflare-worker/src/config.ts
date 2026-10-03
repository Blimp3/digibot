import { SOURCE_CATALOG } from "./sources";
import type { Env } from "./types";

// wrangler.jsonc and the container default repeat this list; tests/source-policy-sync.test.ts keeps them equal.
export const DEFAULT_SOURCE_HOSTS: readonly string[] = SOURCE_CATALOG.flatMap<string>((entry) => entry.hosts);

function positiveInt(value: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : fallback;
}

export interface WorkerConfig {
  allowedSourceHosts: Set<string>;
  maxUrlLength: number;
  maxTelegramBytes: number;
  maxJobsPerHour: number;
  maxActiveJobs: number;
  maxActiveTranscriptions: number;
  defaultMaxHeight: number;
  jobTimeoutSeconds: number;
  transcriptionTimeoutSeconds: number;
  maxTranscriptDurationSeconds: number;
  r2RetentionSeconds: number;
  telegramApiBase: string;
}

export function getWorkerConfig(env: Pick<Env, keyof Env>): WorkerConfig {
  const configuredHosts = env.ALLOWED_SOURCE_HOSTS
    ?.split(/[\s,]+/u)
    .map((host) => {
      const candidate = host.trim().toLowerCase();
      try {
        return new URL(`http://${candidate}`).hostname.toLowerCase().replace(/\.$/u, "");
      } catch {
        return candidate.replace(/\.$/u, "");
      }
    })
    .filter(Boolean);
  const allowedSourceHosts = new Set(configuredHosts?.length ? configuredHosts : DEFAULT_SOURCE_HOSTS);
  const telegramApiBase = env.TELEGRAM_BOT_API_BASE?.trim() || "https://api.telegram.org";

  return {
    allowedSourceHosts,
    maxUrlLength: positiveInt(env.MAX_URL_LENGTH, 2048, 8192),
    maxTelegramBytes: positiveInt(env.MAX_TELEGRAM_BYTES, 49_000_000),
    maxJobsPerHour: positiveInt(env.MAX_JOBS_PER_HOUR, 5, 1000),
    maxActiveJobs: positiveInt(env.MAX_ACTIVE_JOBS, 1, 100),
    maxActiveTranscriptions: positiveInt(env.MAX_ACTIVE_TRANSCRIPTIONS, 1, 100),
    defaultMaxHeight: positiveInt(env.DEFAULT_MAX_HEIGHT, 1080, 4320),
    jobTimeoutSeconds: positiveInt(env.JOB_TIMEOUT_SECONDS, 1200, 86400) || 1200,
    transcriptionTimeoutSeconds: positiveInt(env.TRANSCRIPTION_TIMEOUT_SECONDS, 1800, 1800) || 1800,
    maxTranscriptDurationSeconds: positiveInt(env.MAX_TRANSCRIPT_DURATION_SECONDS, 900, 900) || 900,
    r2RetentionSeconds: positiveInt(env.R2_RETENTION_SECONDS, 86400, 30 * 86400),
    telegramApiBase,
  };
}

import { callTelegram, failSafely } from "./telegram-api.js";

interface WebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
  max_connections?: number;
  allowed_updates?: string[];
}

async function main(): Promise<void> {
  const info = await callTelegram<WebhookInfo>("getWebhookInfo");
  const safe = {
    configured: info.url.length > 0,
    hostname: info.url ? new URL(info.url).hostname : null,
    hasCustomCertificate: info.has_custom_certificate,
    pendingUpdateCount: info.pending_update_count,
    lastErrorDate: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null,
    lastErrorMessage: info.last_error_message ?? null,
    maxConnections: info.max_connections ?? null,
    allowedUpdates: info.allowed_updates ?? null
  };
  console.log(JSON.stringify(safe, null, 2));
}

void main().catch(failSafely);

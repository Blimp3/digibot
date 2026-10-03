import { callTelegram, failSafely, requiredEnv } from "./telegram-api.js";

interface WebhookInfo {
  url: string;
  pending_update_count: number;
  allowed_updates?: string[];
  last_error_message?: string;
}

async function main(): Promise<void> {
  const workerBase = new URL(requiredEnv("PUBLIC_WORKER_BASE_URL"));
  if (workerBase.protocol !== "https:") {
    throw new Error("PUBLIC_WORKER_BASE_URL must use HTTPS");
  }
  const secret = requiredEnv("TELEGRAM_WEBHOOK_SECRET");
  if (!/^[A-Za-z0-9_-]{16,256}$/u.test(secret)) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET must be 16-256 URL-safe characters");
  }
  const webhookUrl = new URL("/telegram/webhook", workerBase).toString();
  await callTelegram<boolean>("setWebhook", {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false
  });
  const info = await callTelegram<WebhookInfo>("getWebhookInfo");
  if (info.url !== webhookUrl) {
    throw new Error("Telegram did not retain the expected webhook URL");
  }
  if (!info.allowed_updates?.includes("message") || !info.allowed_updates.includes("callback_query")) {
    throw new Error("Telegram did not retain message and quality-button updates");
  }
  console.log(`Webhook configured for ${workerBase.hostname}; pending updates: ${info.pending_update_count}`);
}

void main().catch(failSafely);

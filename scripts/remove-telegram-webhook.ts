import { callTelegram, failSafely } from "./telegram-api.js";

async function main(): Promise<void> {
  await callTelegram<boolean>("deleteWebhook", { drop_pending_updates: false });
  console.log("Webhook removed; pending updates were preserved.");
}

void main().catch(failSafely);

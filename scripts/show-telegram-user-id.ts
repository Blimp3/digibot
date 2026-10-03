import { callTelegram, failSafely } from "./telegram-api.js";

interface Update {
  message?: {
    from?: { id: number; is_bot: boolean };
    chat: { id: number; type: string };
  };
}

interface WebhookInfo {
  url: string;
}

async function main(): Promise<void> {
  const webhook = await callTelegram<WebhookInfo>("getWebhookInfo");
  if (webhook.url) {
    throw new Error("A webhook is active. Remove it before using getUpdates, then send /start to the bot.");
  }
  const updates = await callTelegram<Update[]>("getUpdates", {
    timeout: 0,
    allowed_updates: ["message"]
  });
  const identities = new Map<string, { userId: string; chatId: string; chatType: string }>();
  for (const update of updates) {
    const user = update.message?.from;
    const chat = update.message?.chat;
    if (!user || !chat || user.is_bot) continue;
    identities.set(String(user.id), {
      userId: String(user.id),
      chatId: String(chat.id),
      chatType: chat.type
    });
  }
  if (identities.size === 0) {
    console.log("No user messages found. Send /start to the bot, then run this command again.");
    return;
  }
  console.log(JSON.stringify([...identities.values()], null, 2));
}

void main().catch(failSafely);

import type { DaybreakConfig } from "../config.ts";

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface TelegramUser {
  id: number;
  username?: string;
  first_name: string;
}

interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
}

interface TelegramUpdate {
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  my_chat_member?: { chat: TelegramChat };
}

export async function listTelegramChats() {
  const updates = await telegramRequest<TelegramUpdate[]>("getUpdates", {
    allowed_updates: ["message", "edited_message", "channel_post", "my_chat_member"],
  });
  const chats = new Map<number, TelegramChat>();
  for (const update of updates) {
    const chat = update.message?.chat ?? update.edited_message?.chat ?? update.channel_post?.chat ??
      update.my_chat_member?.chat;
    if (chat) chats.set(chat.id, chat);
  }
  return [...chats.values()].map((chat) => ({
    id: String(chat.id),
    type: chat.type,
    name: chat.title ?? chat.username ??
      ([chat.first_name, chat.last_name].filter(Boolean).join(" ") || String(chat.id)),
  }));
}

export async function checkTelegramDelivery(config: NonNullable<DaybreakConfig["telegram"]>) {
  const [bot, chat] = await Promise.all([
    telegramRequest<TelegramUser>("getMe"),
    telegramRequest<TelegramChat>("getChat", { chat_id: config.chatId }),
  ]);
  if (String(bot.id) === String(chat.id)) {
    throw new Error(
      "telegram.chat_id is the bot's own ID; configure the recipient chat ID instead",
    );
  }
  return {
    botUsername: bot.username ?? bot.first_name,
    chatName: chat.title ?? chat.username ?? chat.first_name ?? String(chat.id),
  };
}

export async function sendTelegramBrief(
  config: NonNullable<DaybreakConfig["telegram"]>,
  text: string,
) {
  const chunks = splitTelegramMessage(text);
  const messageIds: number[] = [];
  for (const chunk of chunks) {
    const message = await telegramRequest<TelegramMessage>("sendMessage", {
      chat_id: config.chatId,
      text: chunk,
      link_preview_options: { is_disabled: config.disableLinkPreviews },
    });
    messageIds.push(message.message_id);
  }
  return { chatId: config.chatId, messageIds, messageCount: chunks.length };
}

export function splitTelegramMessage(text: string, maxLength = 4000): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n\n", maxLength);
    if (splitAt < maxLength / 2) splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < maxLength / 2) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function telegramRequest<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json() as TelegramResponse<T> & {
      parameters?: { retry_after?: number };
    };
    if (response.ok && result.ok && result.result !== undefined) return result.result;
    const retryAfter = result.parameters?.retry_after;
    if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
      await new Promise((resolve) =>
        setTimeout(resolve, retryAfter ? retryAfter * 1000 : 500 * 2 ** attempt)
      );
      continue;
    }
    throw new Error(
      `Telegram ${method} failed${result.error_code ? ` (${result.error_code})` : ""}: ${
        result.description ?? `HTTP ${response.status}`
      }`,
    );
  }
  throw new Error(`Telegram ${method} failed after retries`);
}

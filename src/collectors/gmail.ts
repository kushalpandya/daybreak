import type { DaybreakConfig, GoogleAccountConfig } from "../config.ts";
import type { RunContext } from "../types.ts";
import { gwsJson, gwsPaginated } from "../integrations/gws.ts";
import { errorMessage, mapConcurrent } from "../utils.ts";

interface MessageListItem {
  id: string;
  threadId: string;
}
interface Header {
  name: string;
  value: string;
}
interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate: string;
  payload?: { headers?: Header[] };
}

export async function collectGmail(config: NonNullable<DaybreakConfig["google"]>, run: RunContext) {
  const results = await Promise.allSettled(
    config.accounts.map((account) => collectAccount(account, run)),
  );
  const accounts = [];
  const warnings: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") accounts.push(result.value.account);
    else warnings.push(`${config.accounts[i].id}: ${errorMessage(result.reason)}`);
  }
  if (accounts.length === 0 && warnings.length > 0) throw new Error(warnings.join("; "));
  return {
    data: { window: run.windows.mail, accounts },
    warnings,
    partial: warnings.length > 0,
  };
}

async function collectAccount(account: GoogleAccountConfig, run: RunContext) {
  const afterSeconds = Math.floor(Date.parse(run.windows.mail.start) / 1000);
  const beforeSeconds = Math.ceil(Date.parse(run.windows.mail.end) / 1000);
  const listed = await gwsPaginated<MessageListItem>(
    account,
    ["gmail", "users", "messages", "list"],
    { userId: "me", q: `after:${afterSeconds} before:${beforeSeconds}`, maxResults: 100 },
    "messages",
    account.maxMessages,
  );
  const fetched = await mapConcurrent(listed.items, 8, (item) =>
    gwsJson<GmailMessage>(account, [
      "gmail",
      "users",
      "messages",
      "get",
      "--params",
      JSON.stringify({
        userId: "me",
        id: item.id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
      }),
    ]));
  const startMs = Date.parse(run.windows.mail.start);
  const endMs = Date.parse(run.windows.mail.end);
  const ownAddress = account.address;
  const messages = fetched
    .filter((message) => {
      const received = Number(message.internalDate);
      const from = header(message, "From").toLowerCase();
      return received >= startMs && received < endMs && !from.includes(`<${ownAddress}>`) &&
        !from.trim().endsWith(ownAddress);
    })
    .map((message) => normalizeMessage(account.id, message))
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const threads = new Map<string, typeof messages>();
  for (const message of messages) {
    const current = threads.get(message.threadId) ?? [];
    current.push(message);
    threads.set(message.threadId, current);
  }
  return {
    account: {
      id: account.id,
      address: account.address,
      truncated: listed.truncated,
      messageCount: messages.length,
      threadCount: threads.size,
      messages,
      threads: [...threads.entries()].map(([id, threadMessages]) => ({
        id,
        messageIds: threadMessages.map((message) => message.id),
      })),
    },
  };
}

function normalizeMessage(accountId: number, message: GmailMessage) {
  const sender = parseAddress(header(message, "From"));
  return {
    id: `${accountId}:${message.id}`,
    providerId: message.id,
    threadId: `${accountId}:${message.threadId}`,
    account: accountId,
    sender,
    recipients: {
      to: parseAddresses(header(message, "To")),
      cc: parseAddresses(header(message, "Cc")),
    },
    subject: header(message, "Subject") || "(no subject)",
    receivedAt: new Date(Number(message.internalDate)).toISOString(),
    unread: message.labelIds?.includes("UNREAD") ?? false,
    important: message.labelIds?.includes("IMPORTANT") ?? false,
    labels: message.labelIds ?? [],
    snippet: message.snippet ?? "",
  };
}

function header(message: GmailMessage, name: string): string {
  return message.payload?.headers?.find((header) =>
    header.name.toLowerCase() === name.toLowerCase()
  )
    ?.value ?? "";
}

function parseAddresses(value: string) {
  return value ? value.split(",").map(parseAddress) : [];
}

function parseAddress(value: string) {
  const match = /^(.*?)(?:\s*<([^>]+)>)?$/.exec(value.trim());
  const address = (match?.[2] ?? match?.[1] ?? "").trim();
  const name = match?.[2] ? (match[1] ?? "").trim().replace(/^"|"$/g, "") : "";
  return { name: name || null, address };
}

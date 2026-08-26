import type { GoogleAccountConfig } from "../config.ts";
import { commandJson } from "./command.ts";
import { ConcurrencyLimiter } from "../utils.ts";

const limiter = new ConcurrencyLimiter(8);

export interface GmailProfile {
  emailAddress: string;
  messagesTotal?: number;
  threadsTotal?: number;
}

export function gwsJson<T>(account: GoogleAccountConfig, args: string[]): Promise<T> {
  return limiter.run(() =>
    commandJson<T>("gws", {
      args,
      env: { GOOGLE_WORKSPACE_CLI_CONFIG_DIR: account.configDir },
      timeoutMs: 120_000,
    })
  );
}

export function getGmailProfile(account: GoogleAccountConfig): Promise<GmailProfile> {
  return gwsJson(account, [
    "gmail",
    "users",
    "getProfile",
    "--params",
    JSON.stringify({ userId: "me" }),
  ]);
}

export async function gwsPaginated<T>(
  account: GoogleAccountConfig,
  baseArgs: string[],
  params: Record<string, unknown>,
  arrayField: string,
  maxItems: number,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let pageToken: string | undefined;
  do {
    const response = await gwsJson<Record<string, unknown>>(account, [
      ...baseArgs,
      "--params",
      JSON.stringify({ ...params, pageToken }),
    ]);
    const page = response[arrayField];
    if (Array.isArray(page)) items.push(...page as T[]);
    pageToken = typeof response.nextPageToken === "string" ? response.nextPageToken : undefined;
  } while (pageToken && items.length < maxItems);

  return {
    items: items.slice(0, maxItems),
    truncated: Boolean(pageToken || items.length > maxItems),
  };
}

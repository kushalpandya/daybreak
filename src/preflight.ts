import type { DaybreakConfig } from "./config.ts";
import type { PreflightCheck, PreflightReport } from "./types.ts";
import { commandJson, runCommand } from "./integrations/command.ts";
import { getGmailProfile } from "./integrations/gws.ts";
import { errorMessage } from "./utils.ts";

export async function runPreflight(
  config: DaybreakConfig,
  sections = new Set(["weather", "mail", "calendar", "github", "gitlab"]),
  checkTelegram = false,
): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [];
  const needsGoogle = config.google && (sections.has("mail") || sections.has("calendar"));

  if (needsGoogle) {
    const available = await checkCommand("gws", ["--version"]);
    checks.push(available);
    if (available.status === "ok") {
      const accountChecks = await Promise.all(config.google!.accounts.map(async (account) => {
        try {
          const profile = await getGmailProfile(account);
          const actualAddress = profile.emailAddress.toLowerCase();
          return actualAddress === account.address
            ? {
              integration: "gws",
              target: String(account.id),
              status: "ok",
              message: `authenticated as ${profile.emailAddress}`,
            } as const
            : {
              integration: "gws",
              target: String(account.id),
              status: "error",
              message:
                `configured for ${account.address}, but authenticated as ${profile.emailAddress}`,
            } as const;
        } catch (error) {
          return {
            integration: "gws",
            target: String(account.id),
            status: "error",
            message: errorMessage(error),
          } as const;
        }
      }));
      checks.push(...accountChecks);
    }
  }

  if (config.github && sections.has("github")) {
    const available = await checkCommand("gh", ["--version"]);
    checks.push(available);
    if (available.status === "ok") {
      try {
        const viewer = await commandJson<{ login: string }>("gh", {
          args: ["api", "user", "--jq", "{login: .login}"],
        });
        checks.push({
          integration: "gh",
          target: "github.com",
          status: "ok",
          message: `authenticated as ${viewer.login}`,
        });
      } catch (error) {
        checks.push({
          integration: "gh",
          target: "github.com",
          status: "error",
          message: errorMessage(error),
        });
      }
    }
  }

  if (config.gitlab && sections.has("gitlab")) {
    const available = await checkCommand("glab", ["--version"]);
    checks.push(available);
    if (available.status === "ok") {
      try {
        const user = await commandJson<{ username: string }>("glab", {
          args: ["api", "user", "--hostname", config.gitlab.host],
        });
        checks.push({
          integration: "glab",
          target: config.gitlab.host,
          status: "ok",
          message: `authenticated as ${user.username}`,
        });
      } catch (error) {
        checks.push({
          integration: "glab",
          target: config.gitlab.host,
          status: "error",
          message: errorMessage(error),
        });
      }
    }
  }

  if (checkTelegram) {
    if (!config.telegram) {
      checks.push({
        integration: "telegram",
        status: "error",
        message: "Telegram delivery is not configured",
      });
    } else {
      try {
        const { checkTelegramDelivery } = await import("./delivery/telegram.ts");
        const result = await checkTelegramDelivery(config.telegram);
        checks.push({
          integration: "telegram",
          target: config.telegram.chatId,
          status: "ok",
          message: `bot @${result.botUsername} can access ${result.chatName}`,
        });
      } catch (error) {
        checks.push({
          integration: "telegram",
          target: config.telegram.chatId,
          status: "error",
          message: errorMessage(error),
        });
      }
    }
  }

  return { status: checks.some((check) => check.status === "error") ? "error" : "ok", checks };
}

async function checkCommand(command: string, args: string[]): Promise<PreflightCheck> {
  try {
    const result = await runCommand(command, { args, timeoutMs: 15_000 });
    if (result.code !== 0) {
      return {
        integration: command,
        status: "error",
        message: `${command} exited with ${result.code}`,
      };
    }
    const version = (result.stdout || result.stderr).split("\n")[0];
    return { integration: command, status: "ok", message: "available", version };
  } catch (error) {
    return { integration: command, status: "error", message: errorMessage(error) };
  }
}

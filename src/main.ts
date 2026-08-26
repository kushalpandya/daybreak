import "@std/dotenv/load";

import { parseCli, printHelp } from "./cli.ts";
import { loadConfig } from "./config.ts";
import { collectCalendar } from "./collectors/calendar.ts";
import { collectGithub } from "./collectors/github.ts";
import { collectGitlab } from "./collectors/gitlab.ts";
import { collectGmail } from "./collectors/gmail.ts";
import { collectWeather } from "./collectors/weather.ts";
import { runPreflight } from "./preflight.ts";
import { renderBrief } from "./output/brief.ts";
import { renderAgentBrief } from "./output/agent.ts";
import { listTelegramChats, sendTelegramBrief } from "./delivery/telegram.ts";
import { createRunContext } from "./time.ts";
import { type BriefOutput, collectSection, skippedSection } from "./types.ts";

export const VERSION = "0.1.0";

if (import.meta.main) {
  try {
    const options = parseCli(Deno.args);
    if (options.command === "help") {
      printHelp();
    } else if (options.command === "version") {
      console.log(`daybreak ${VERSION}`);
    } else if (options.command === "telegram-chats") {
      const chats = await listTelegramChats();
      console.log(JSON.stringify({ chats }, null, 2));
    } else {
      const config = await loadConfig(options.config);
      if (options.command === "config-check") {
        console.log(`Configuration is valid: ${options.config}`);
      } else {
        const checkTelegram = (options.command === "deliver" && !options.dryRun) ||
          (options.command === "doctor" && Boolean(config.telegram));
        const preflight = await runPreflight(config, options.sections, checkTelegram);
        if (options.command === "doctor") {
          console.log(JSON.stringify(preflight, null, 2));
          if (preflight.status === "error") Deno.exitCode = 2;
        } else if (preflight.status === "error") {
          printPreflightFailure(preflight);
          Deno.exitCode = 2;
        } else {
          const output = await fetchBrief(config, options);
          const hasCollectorError = Object.values(output).some((value) =>
            typeof value === "object" && value !== null && "status" in value &&
            value.status === "error"
          );
          if (options.command === "deliver") {
            const brief = renderBrief(output, config.filters);
            if (options.dryRun) console.log(brief);
            else {
              if (hasCollectorError) {
                console.error("daybreak: delivery cancelled because one or more collectors failed");
                Deno.exitCode = 3;
              } else {
                const delivery = await sendTelegramBrief(config.telegram!, brief);
                console.log(JSON.stringify({ status: "ok", delivery }, null, 2));
              }
            }
          } else {
            const payload = options.format === "agent"
              ? renderAgentBrief(output, config.filters)
              : output;
            console.log(JSON.stringify(payload, null, options.pretty ? 2 : undefined));
          }
          if (hasCollectorError) {
            Deno.exitCode = 3;
          }
        }
      }
    }
  } catch (error) {
    console.error(`daybreak: ${error instanceof Error ? error.message : String(error)}`);
    Deno.exitCode = 1;
  }
}

async function fetchBrief(
  config: Awaited<ReturnType<typeof loadConfig>>,
  options: ReturnType<typeof parseCli>,
): Promise<BriefOutput> {
  const run = createRunContext(config, options.reportingDate);
  const selected = options.sections;
  const weatherPromise = selected.has("weather") && config.weather
    ? collectSection("weather_collection_failed", () => collectWeather(config.weather!, run))
    : Promise.resolve(skippedSection());
  const mailPromise = selected.has("mail") && config.google
    ? collectSection("mail_collection_failed", () => collectGmail(config.google!, run))
    : Promise.resolve(skippedSection());
  const calendarPromise = selected.has("calendar") && config.google
    ? collectSection("calendar_collection_failed", () => collectCalendar(config.google!, run))
    : Promise.resolve(skippedSection());
  const githubPromise = selected.has("github") && config.github
    ? collectSection(
      "github_collection_failed",
      () => collectGithub(config.github!, config.state.database, run, options.writeState),
    )
    : Promise.resolve(skippedSection());
  const gitlabPromise = selected.has("gitlab") && config.gitlab
    ? collectSection(
      "gitlab_collection_failed",
      () => collectGitlab(config.gitlab!, config.state.database, run, options.writeState),
    )
    : Promise.resolve(skippedSection());
  const [weather, mail, calendar, github, gitlab] = await Promise.all([
    weatherPromise,
    mailPromise,
    calendarPromise,
    githubPromise,
    gitlabPromise,
  ]);
  return {
    schemaVersion: 1,
    run: { ...run, completedAt: new Date().toISOString() },
    weather,
    mail,
    calendar,
    github,
    gitlab,
  };
}

function printPreflightFailure(preflight: Awaited<ReturnType<typeof runPreflight>>): void {
  console.error("daybreak: preflight failed");
  for (const check of preflight.checks.filter((check) => check.status === "error")) {
    const target = check.target ? ` ${check.target}` : "";
    console.error(`- ${check.integration}${target}: ${check.message}`);
  }
  console.error("No collectors were run. Run `daybreak doctor` for details.");
}

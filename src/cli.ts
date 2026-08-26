import { Temporal } from "./temporal.ts";

export interface CliOptions {
  command:
    | "fetch"
    | "deliver"
    | "doctor"
    | "config-check"
    | "telegram-chats"
    | "help"
    | "version";
  config: string;
  pretty: boolean;
  format: "json" | "agent";
  maxItems: number;
  sections: Set<string>;
  reportingDate?: string;
  writeState: boolean;
  dryRun: boolean;
}

const SECTIONS = new Set(["weather", "mail", "calendar", "github", "gitlab"]);

export function parseCli(args: string[]): CliOptions {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") return defaults("help");
  if (args[0] === "--version" || args[0] === "-V") return defaults("version");

  let command: CliOptions["command"];
  let index = 1;
  if (args[0] === "fetch" || args[0] === "deliver" || args[0] === "doctor") command = args[0];
  else if (args[0] === "telegram" && args[1] === "chats") {
    command = "telegram-chats";
    index = 2;
  } else if (args[0] === "config" && args[1] === "check") {
    command = "config-check";
    index = 2;
  } else {
    throw new Error(`unknown command: ${args.join(" ")}`);
  }

  const options = defaults(command);
  while (index < args.length) {
    const arg = args[index++];
    if (arg === "--pretty") options.pretty = true;
    else if (arg === "--format") {
      const format = requiredValue(args, index++, arg);
      if (format !== "json" && format !== "agent") {
        throw new Error(`unknown format: ${format} (expected json or agent)`);
      }
      options.format = format;
    } else if (arg === "--max-items") {
      const value = Number(requiredValue(args, index++, arg));
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        throw new Error("--max-items must be an integer between 1 and 100");
      }
      options.maxItems = value;
    } else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-write-state") options.writeState = false;
    else if (arg === "--config") options.config = requiredValue(args, index++, arg);
    else if (arg === "--section") {
      const sections = requiredValue(args, index++, arg).split(",").filter(Boolean);
      for (const section of sections) {
        if (!SECTIONS.has(section)) throw new Error(`unknown section: ${section}`);
      }
      options.sections = new Set(sections);
    } else if (arg === "--date") {
      const date = requiredValue(args, index++, arg);
      Temporal.PlainDate.from(date);
      options.reportingDate = date;
    } else if (arg === "--help" || arg === "-h") return defaults("help");
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function defaults(command: CliOptions["command"]): CliOptions {
  return {
    command,
    config: "config.yml",
    pretty: false,
    format: "json",
    maxItems: 15,
    sections: new Set(SECTIONS),
    writeState: true,
    dryRun: false,
  };
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

export function printHelp(): void {
  console.log(`Daybreak fetches and normalizes a personal morning brief.

Usage:
  daybreak fetch [options]
  daybreak deliver [options]
  daybreak doctor [--config PATH]
  daybreak telegram chats
  daybreak config check [--config PATH]

Fetch options:
  --config PATH          Configuration file (defaults to ./config.yml)
  --pretty               Pretty-print JSON output
  --format json|agent    json: full normalized payload (default)
                         agent: compact, flat, pre-ranked payload for an LLM
  --max-items N          Cap entries per list in the agent format (default 15).
                         Lower it for a local model with a short context window.
  --section LIST         Comma-separated sections to fetch
  --date YYYY-MM-DD      Replay using a reporting date at 07:00 local time
  --no-write-state       Do not save GitHub metric snapshots
  --dry-run              Render delivery text without sending it

Other:
  -h, --help             Show help
  -V, --version          Show version`);
}

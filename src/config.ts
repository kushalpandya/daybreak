import { parse } from "@std/yaml";
import { dirname, isAbsolute, join, normalize } from "@std/path";

export interface GoogleAccountConfig {
  id: number;
  address: string;
  configDir: string;
  maxMessages: number;
}

export interface BriefFilters {
  /** Gmail category labels to treat as noise, e.g. "promotions". */
  mailIgnoreCategories: string[];
  /** Case-insensitive substrings matched against sender name and address. */
  mailIgnoreSenders: string[];
  /** Case-insensitive substrings matched against todo target titles. */
  todoIgnoreTitles: string[];
}

export interface DaybreakConfig {
  schemaVersion: 1;
  brief: {
    timezone: string;
    mailLookbackMs: number;
    calendarLookaheadMs: number;
  };
  filters: BriefFilters;
  weather?: {
    name: string;
    latitude: number;
    longitude: number;
    units: "metric" | "imperial";
  };
  google?: {
    accounts: GoogleAccountConfig[];
    includeDeclined: boolean;
  };
  github?: {
    repositories: string[];
    lookbackMs: number;
    maxItems: number;
  };
  gitlab?: {
    host: string;
    projects: string[];
    maxItemsPerCategory: number;
    /** Lookback for merged MRs and closed issues, or null to skip the recap. */
    recapMs: number | null;
  };
  telegram?: {
    chatId: string;
    disableLinkPreviews: boolean;
  };
  state: {
    database: string;
  };
}

type JsonObject = Record<string, unknown>;

export async function loadConfig(path: string): Promise<DaybreakConfig> {
  const absolutePath = resolvePath(path, Deno.cwd());
  const raw = parse(await Deno.readTextFile(absolutePath));
  const config = asObject(raw, "configuration");
  assertKeys(
    config,
    [
      "schema_version",
      "brief",
      "filters",
      "weather",
      "google",
      "github",
      "gitlab",
      "telegram",
      "state",
    ],
    "configuration",
  );

  if (config.schema_version !== 1) {
    throw new Error("schema_version must be 1");
  }

  const brief = asObject(config.brief, "brief");
  assertKeys(brief, ["timezone", "mail_lookback", "calendar_lookahead"], "brief");
  const timezone = requiredString(brief.timezone, "brief.timezone");
  validateTimezone(timezone);

  const baseDir = dirname(absolutePath);
  const stateRaw = asObject(config.state ?? {}, "state");
  assertKeys(stateRaw, ["database"], "state");

  return {
    schemaVersion: 1,
    brief: {
      timezone,
      mailLookbackMs: parseDuration(brief.mail_lookback ?? "24h", "brief.mail_lookback"),
      calendarLookaheadMs: parseDuration(
        brief.calendar_lookahead ?? "48h",
        "brief.calendar_lookahead",
      ),
    },
    filters: parseFilters(config.filters),
    weather: parseWeather(config.weather),
    google: parseGoogle(config.google, baseDir),
    github: parseGithub(config.github),
    gitlab: parseGitlab(config.gitlab),
    telegram: parseTelegram(config.telegram),
    state: {
      database: resolvePath(
        optionalString(stateRaw.database) ?? "~/.local/share/daybreak/daybreak.db",
        baseDir,
      ),
    },
  };
}

const DEFAULT_MAIL_IGNORE_CATEGORIES = ["promotions", "social"];

function parseFilters(value: unknown): BriefFilters {
  if (value === undefined || value === null) {
    return {
      mailIgnoreCategories: [...DEFAULT_MAIL_IGNORE_CATEGORIES],
      mailIgnoreSenders: [],
      todoIgnoreTitles: [],
    };
  }
  const input = asObject(value, "filters");
  assertKeys(
    input,
    ["mail_ignore_categories", "mail_ignore_senders", "todo_ignore_titles"],
    "filters",
  );
  return {
    mailIgnoreCategories: stringList(
      input.mail_ignore_categories,
      DEFAULT_MAIL_IGNORE_CATEGORIES,
      "filters.mail_ignore_categories",
    ).map((entry) => entry.toLowerCase()),
    mailIgnoreSenders: stringList(input.mail_ignore_senders, [], "filters.mail_ignore_senders")
      .map((entry) => entry.toLowerCase()),
    todoIgnoreTitles: stringList(input.todo_ignore_titles, [], "filters.todo_ignore_titles")
      .map((entry) => entry.toLowerCase()),
  };
}

function stringList(value: unknown, fallback: string[], field: string): string[] {
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => requiredString(entry, `${field}[${index}]`));
}

function parseTelegram(value: unknown): DaybreakConfig["telegram"] {
  if (value === undefined || value === null || value === false) return undefined;
  const input = asObject(value, "telegram");
  assertKeys(input, ["enabled", "chat_id", "disable_link_previews"], "telegram");
  if (input.enabled === false) return undefined;
  const chatId = typeof input.chat_id === "number"
    ? String(input.chat_id)
    : requiredString(input.chat_id, "telegram.chat_id");
  if (!/^-?\d+$|^@[A-Za-z][A-Za-z0-9_]{4,}$/.test(chatId)) {
    throw new Error("telegram.chat_id must be a numeric chat ID or channel username");
  }
  return {
    chatId,
    disableLinkPreviews: input.disable_link_previews !== false,
  };
}

function parseWeather(value: unknown): DaybreakConfig["weather"] {
  if (value === undefined || value === null || value === false) return undefined;
  const input = asObject(value, "weather");
  assertKeys(input, ["enabled", "name", "latitude", "longitude", "units"], "weather");
  if (input.enabled === false) return undefined;
  const latitude = requiredNumber(input.latitude, "weather.latitude");
  const longitude = requiredNumber(input.longitude, "weather.longitude");
  if (latitude < -90 || latitude > 90) throw new Error("weather.latitude must be -90..90");
  if (longitude < -180 || longitude > 180) {
    throw new Error("weather.longitude must be -180..180");
  }
  const units = optionalString(input.units) ?? "metric";
  if (units !== "metric" && units !== "imperial") {
    throw new Error("weather.units must be metric or imperial");
  }
  return {
    name: requiredString(input.name, "weather.name"),
    latitude,
    longitude,
    units,
  };
}

function parseGoogle(value: unknown, baseDir: string): DaybreakConfig["google"] {
  if (value === undefined || value === null || value === false) return undefined;
  const input = asObject(value, "google");
  assertKeys(input, ["enabled", "accounts", "include_declined"], "google");
  if (input.enabled === false) return undefined;
  if (!Array.isArray(input.accounts) || input.accounts.length === 0) {
    throw new Error("google.accounts must contain at least one account");
  }
  const ids = new Set<number>();
  const accounts = input.accounts.map((value, index) => {
    const account = asObject(value, `google.accounts[${index}]`);
    assertKeys(
      account,
      ["id", "address", "config_dir", "max_messages"],
      `google.accounts[${index}]`,
    );
    const id = requiredPositiveInteger(account.id, `google.accounts[${index}].id`);
    const address = requiredString(account.address, `google.accounts[${index}].address`)
      .toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      throw new Error(`invalid Google account address: ${address}`);
    }
    if (ids.has(id)) throw new Error(`duplicate Google account id: ${id}`);
    ids.add(id);
    return {
      id,
      address,
      configDir: resolvePath(
        requiredString(account.config_dir, `google.accounts[${index}].config_dir`),
        baseDir,
      ),
      maxMessages: optionalIntegerInRange(
        account.max_messages,
        500,
        1,
        1000,
        `google.accounts[${index}].max_messages`,
      ),
    };
  });
  return { accounts, includeDeclined: input.include_declined === true };
}

function parseGithub(value: unknown): DaybreakConfig["github"] {
  if (value === undefined || value === null || value === false) return undefined;
  const input = asObject(value, "github");
  assertKeys(
    input,
    ["enabled", "repositories", "lookback", "max_items"],
    "github",
  );
  if (input.enabled === false) return undefined;
  const repositories = input.repositories === undefined ? [] : input.repositories;
  if (!Array.isArray(repositories)) throw new Error("github.repositories must be an array");
  const normalized = repositories.map((repo, index) => {
    const name = requiredString(repo, `github.repositories[${index}]`);
    if (!/^[^/\s]+\/[^/\s]+$/.test(name)) throw new Error(`invalid GitHub repository: ${name}`);
    return name;
  });
  return {
    repositories: [...new Set(normalized)],
    lookbackMs: parseDuration(input.lookback ?? "24h", "github.lookback"),
    maxItems: optionalIntegerInRange(input.max_items, 100, 1, 100, "github.max_items"),
  };
}

function parseGitlab(value: unknown): DaybreakConfig["gitlab"] {
  if (value === undefined || value === null || value === false) return undefined;
  const input = asObject(value, "gitlab");
  assertKeys(
    input,
    ["enabled", "host", "projects", "max_items_per_category", "recap"],
    "gitlab",
  );
  if (input.enabled === false) return undefined;
  const projects = input.projects === undefined ? [] : input.projects;
  if (!Array.isArray(projects)) throw new Error("gitlab.projects must be an array");
  const normalized = projects.map((project, index) => {
    const path = requiredString(project, `gitlab.projects[${index}]`);
    if (!/^[^/\s]+(?:\/[^/\s]+)+$/.test(path)) {
      throw new Error(`invalid GitLab project: ${path}`);
    }
    return path;
  });
  return {
    host: optionalString(input.host) ?? "gitlab.com",
    projects: [...new Set(normalized)],
    maxItemsPerCategory: optionalIntegerInRange(
      input.max_items_per_category,
      100,
      1,
      100,
      "gitlab.max_items_per_category",
    ),
    recapMs: input.recap === undefined || input.recap === null || input.recap === false
      ? null
      : parseDuration(input.recap, "gitlab.recap"),
  };
}

export function parseDuration(value: unknown, field: string): number {
  if (typeof value !== "string") throw new Error(`${field} must be a duration such as 24h`);
  const match = /^(\d+)(m|h|d)$/.exec(value.trim());
  if (!match) throw new Error(`${field} must use m, h, or d units`);
  const amount = Number(match[1]);
  if (amount <= 0) throw new Error(`${field} must be positive`);
  return amount * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]] ?? 0);
}

export function resolvePath(path: string, baseDir: string): string {
  const home = Deno.env.get("HOME");
  const expanded = path === "~" || path.startsWith("~/")
    ? home ? join(home, path.slice(2)) : path
    : path;
  return normalize(isAbsolute(expanded) ? expanded : join(baseDir, expanded));
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(`invalid IANA timezone: ${timezone}`);
  }
}

function asObject(value: unknown, field: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as JsonObject;
}

function assertKeys(object: JsonObject, allowed: string[], field: string): void {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${field} has unknown keys: ${unknown.join(", ")}`);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} is required`);
  return value;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return Number(value);
}

function optionalIntegerInRange(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

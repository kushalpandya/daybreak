import type { BriefFilters } from "../config.ts";
import type { BriefOutput, SectionResult } from "../types.ts";
import { NO_FILTERS, partitionTodos, selectMail, type UnknownRecord } from "./select.ts";

const HORIZONTAL_RULE = "━━━━━━━━━━━━━━━━━━━━";
const SECTION_TITLES: Record<string, string> = {
  WEATHER: "🌤️ WEATHER",
  CALENDAR: "📅 CALENDAR",
  EMAIL: "📬 EMAIL",
  GITHUB: "🐙 GITHUB",
  GITLAB: "🦊 GITLAB",
};

export function renderBrief(output: BriefOutput, filters: BriefFilters = NO_FILTERS): string {
  const date = new Intl.DateTimeFormat("en-CA", {
    dateStyle: "full",
    timeZone: output.run.timezone,
  }).format(new Date(normalizeInstant(output.run.windows.mail.end)));
  const parts = [`☀️ ${date}`];
  parts.push(renderWeather(output.weather));
  parts.push(renderCalendar(output.calendar));
  parts.push(renderMail(output.mail, filters));
  parts.push(renderGithub(output.github));
  parts.push(renderGitlab(output.gitlab, filters));
  return parts.filter(Boolean).join(`\n\n${HORIZONTAL_RULE}\n\n`);
}

function renderWeather(section: SectionResult<unknown>): string {
  if (!section.data) return sectionUnavailable("WEATHER", section);
  const data = section.data as UnknownRecord;
  const current = data.current as UnknownRecord;
  const today = data.today as UnknownRecord;
  const tomorrow = data.tomorrow as UnknownRecord | null;
  const units = data.units as UnknownRecord;
  const lines = [
    SECTION_TITLES.WEATHER,
    `${
      data.location && (data.location as UnknownRecord).name
    }: ${current.temperature}${units.temperature}, ${current.condition}. Feels like ${current.apparentTemperature}${units.temperature}.`,
    `High ${today.maximumTemperature}${units.temperature}, low ${today.minimumTemperature}${units.temperature}. Rain chance ${today.precipitationProbabilityPercent}%.`,
  ];
  if (tomorrow) {
    lines.push(
      `Tomorrow: ${tomorrow.condition}, high ${tomorrow.maximumTemperature}${units.temperature}, rain chance ${tomorrow.precipitationProbabilityPercent}%.`,
    );
  }
  return lines.join("\n");
}

function renderCalendar(section: SectionResult<unknown>): string {
  if (!section.data) return sectionUnavailable("CALENDAR", section);
  const data = section.data as UnknownRecord;
  const events = deduplicateEvents((data.events as UnknownRecord[]) ?? []);
  const lines = [SECTION_TITLES.CALENDAR];
  if (events.length === 0) return `${lines[0]}\nNo events today or tomorrow.`;
  for (const event of events.slice(0, 12)) {
    const start = String(event.start ?? "");
    const when = event.allDay ? start : formatDateTime(start);
    const sources = Array.isArray(event.sources) && event.sources.length > 1
      ? ` (${event.sources.length} calendars)`
      : "";
    lines.push(`- ${when}: ${event.title}${sources}`);
  }
  if (events.length > 12) lines.push(`- ${events.length - 12} more events`);
  return appendWarnings(lines, section);
}

function renderMail(section: SectionResult<unknown>, filters: BriefFilters): string {
  if (!section.data) return sectionUnavailable("EMAIL", section);
  const accounts = ((section.data as UnknownRecord).accounts as UnknownRecord[]) ?? [];
  const messages = accounts.flatMap((account) => (account.messages as UnknownRecord[]) ?? []);
  const unread = messages.filter((message) => message.unread === true).length;
  const { signal, dropped } = selectMail(messages, filters);
  const lines = [SECTION_TITLES.EMAIL];
  lines.push(`${messages.length} received in the last day, ${unread} unread.`);
  if (signal.length === 0) lines.push("Nothing needing attention.");
  for (const message of signal.slice(0, 6)) {
    const sender = message.sender as UnknownRecord;
    const flag = message.unread === true ? "" : " (read)";
    lines.push(`- ${sender.name ?? sender.address}: ${message.subject}${flag}`);
  }
  if (signal.length > 6) lines.push(`- ${signal.length - 6} more worth a look`);
  const noise = dropped.category + dropped.sender + dropped.noSignal;
  if (noise > 0) lines.push(`${noise} filtered as newsletters, promotions or already handled.`);
  return appendWarnings(lines, section);
}

function renderGithub(section: SectionResult<unknown>): string {
  if (!section.data) return sectionUnavailable("GITHUB", section);
  const data = section.data as UnknownRecord;
  const repositories = (data.repositories as UnknownRecord[]) ?? [];
  const todos = data.todos as UnknownRecord;
  const lines = [SECTION_TITLES.GITHUB];
  for (const repo of repositories) {
    const stars = repo.stars as UnknownRecord;
    const downloads = repo.releaseDownloads as UnknownRecord;
    const starDelta = deltaSuffix(stars.delta, "stars");
    const downloadDelta = deltaSuffix(downloads.delta, "downloads");
    lines.push(
      `- ${
        shortRepo(String(repo.name))
      }: ${stars.current} stars${starDelta}, ${downloads.current} downloads${downloadDelta}, ${repo.openIssues} open issues`,
    );
  }
  const counts = [
    ["assigned issues", todos.assignedIssues],
    ["assigned PRs", todos.assignedPullRequests],
    ["reviews", todos.reviewRequests],
    ["notifications", todos.notifications],
  ].map(([label, value]) => `${Array.isArray(value) ? value.length : 0} ${label}`);
  lines.push(counts.join(", "));
  return lines.join("\n");
}

function renderGitlab(section: SectionResult<unknown>, filters: BriefFilters): string {
  if (!section.data) return sectionUnavailable("GITLAB", section);
  const data = section.data as UnknownRecord;
  const { kept: todos, ignored } = partitionTodos((data.todos as UnknownRecord[]) ?? [], filters);
  const projects = (data.projects as UnknownRecord[]) ?? [];
  const ignoredSuffix = ignored > 0 ? ` (${ignored} filtered)` : "";
  const lines = [SECTION_TITLES.GITLAB, `${todos.length} pending todos${ignoredSuffix}.`];
  for (const todo of todos.slice(0, 6)) {
    const target = todo.target as UnknownRecord | undefined;
    lines.push(`- ${todo.action_name}: ${target?.title ?? todo.body ?? todo.target_type}`);
  }
  for (const project of projects) {
    const reviews = (project.reviewRequests as UnknownRecord[]) ?? [];
    const assignedIssues = (project.assignedIssues as UnknownRecord[]) ?? [];
    const authoredMrs = (project.authoredMergeRequests as UnknownRecord[]) ?? [];
    lines.push(
      `${project.path}: ${reviews.length} reviews, ${assignedIssues.length} assigned issues, ${authoredMrs.length} authored MRs.`,
    );
    for (const item of actionableGitlab(project).slice(0, 4)) {
      lines.push(`- ${item.reference}: ${item.title}${reasonSuffix(item.actionReasons)}`);
    }
  }
  return lines.join("\n");
}

function deduplicateEvents(events: UnknownRecord[]): UnknownRecord[] {
  const byKey = new Map<string, UnknownRecord & { sources: string[] }>();
  for (const event of events) {
    const key = `${event.title}|${event.start}|${event.end}`;
    const calendar = event.calendar as UnknownRecord;
    const source = `${event.accountAddress ?? event.account}: ${calendar?.name ?? "calendar"}`;
    const existing = byKey.get(key);
    if (existing) existing.sources.push(source);
    else byKey.set(key, { ...event, sources: [source] });
  }
  return [...byKey.values()];
}

function actionableGitlab(project: UnknownRecord): UnknownRecord[] {
  const values = [
    ...((project.reviewRequests as UnknownRecord[]) ?? []),
    ...((project.assignedMergeRequests as UnknownRecord[]) ?? []),
    ...((project.authoredMergeRequests as UnknownRecord[]) ?? []),
    ...((project.assignedIssues as UnknownRecord[]) ?? []),
  ];
  const unique = new Map<string, UnknownRecord>();
  for (
    const item of values.filter((item) => item.actionRequired === true || item.overdue === true)
  ) {
    const key = String(item.reference ?? item.id);
    const existing = unique.get(key);
    if (!existing) unique.set(key, item);
    else {
      unique.set(key, {
        ...existing,
        actionReasons: [
          ...new Set([
            ...((existing.actionReasons as string[]) ?? []),
            ...((item.actionReasons as string[]) ?? []),
          ]),
        ],
      });
    }
  }
  return [...unique.values()];
}

function appendWarnings(lines: string[], section: SectionResult<unknown>): string {
  if (section.status === "partial") {
    for (const warning of section.warnings) lines.push(`⚠️ ${warning}`);
  }
  return lines.join("\n");
}

function sectionUnavailable(title: string, section: SectionResult<unknown>): string {
  if (section.status === "skipped") return "";
  return `${SECTION_TITLES[title] ?? title}\n⚠️ Unavailable: ${
    section.error?.message ?? section.status
  }`;
}

function formatDateTime(value: string): string {
  const parsed = new Date(normalizeInstant(value));
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString("en-CA", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function normalizeInstant(value: string): string {
  return value.replace(/\.\d{3}\d+Z$/, (fraction) => `${fraction.slice(0, 4)}Z`);
}

function deltaSuffix(value: unknown, label: string): string {
  return typeof value === "number" ? ` (${value >= 0 ? "+" : ""}${value} ${label})` : "";
}

function reasonSuffix(value: unknown): string {
  return Array.isArray(value) && value.length > 0 ? ` [${value.join(", ")}]` : "";
}

function shortRepo(name: string): string {
  return name.split("/").at(-1) ?? name;
}

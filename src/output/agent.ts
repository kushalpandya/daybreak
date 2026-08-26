import type { BriefFilters } from "../config.ts";
import type { BriefOutput, SectionResult } from "../types.ts";
import { partitionTodos, selectMail, type UnknownRecord } from "./select.ts";

/**
 * A compact projection of BriefOutput intended for a language model to narrate.
 *
 * The `fetch` JSON is a faithful dump of every upstream API response and runs to hundreds of
 * kilobytes, most of it avatar URLs, project descriptions and long-tail backlog items. This
 * projection keeps the decisions and drops the decoration, and reports what it dropped so the
 * narrator can say "the rest was newsletters" without being handed the newsletters.
 */
export interface AgentBrief {
  date: string;
  weekday: string;
  timezone: string;
  weekend: boolean;
  sections: Record<string, string>;
  problems: string[];
  weather?: unknown;
  calendar?: unknown;
  mail?: unknown;
  github?: unknown;
  gitlab?: unknown;
}

const WEEKDAY = new Intl.DateTimeFormat("en-CA", { weekday: "long", timeZone: "UTC" });

export function renderAgentBrief(output: BriefOutput, filters: BriefFilters): AgentBrief {
  const timezone = output.run.timezone;
  const date = output.run.reportingDate;
  const weekday = WEEKDAY.format(new Date(`${date}T12:00:00Z`));
  const brief: AgentBrief = {
    date,
    weekday,
    timezone,
    weekend: weekday === "Saturday" || weekday === "Sunday",
    sections: {},
    problems: [],
  };

  for (const name of ["weather", "mail", "calendar", "github", "gitlab"] as const) {
    const section = output[name];
    brief.sections[name] = section.status;
    if (section.error) brief.problems.push(`${name}: ${section.error.message}`);
    for (const warning of section.warnings) brief.problems.push(`${name}: ${warning}`);
  }

  brief.weather = project(output.weather, (data) => weather(data));
  brief.calendar = project(output.calendar, (data) => calendar(data, date, timezone));
  brief.mail = project(output.mail, (data) => mail(data, filters));
  brief.github = project(output.github, (data) => github(data));
  brief.gitlab = project(output.gitlab, (data) => gitlab(data, filters));
  return brief;
}

function project(
  section: SectionResult<unknown>,
  build: (data: UnknownRecord) => unknown,
): unknown {
  if (!section.data) return undefined;
  return build(section.data as UnknownRecord);
}

function weather(data: UnknownRecord): unknown {
  const current = (data.current ?? {}) as UnknownRecord;
  const today = (data.today ?? {}) as UnknownRecord;
  const units = (data.units ?? {}) as UnknownRecord;
  const degrees = String(units.temperature ?? "");
  return {
    location: (data.location as UnknownRecord)?.name ?? null,
    now: {
      temperature: `${current.temperature}${degrees}`,
      feelsLike: `${current.apparentTemperature}${degrees}`,
      condition: current.condition,
      observedAt: current.observedAt,
    },
    today: {
      high: `${today.maximumTemperature}${degrees}`,
      low: `${today.minimumTemperature}${degrees}`,
      condition: today.condition,
      rainChancePercent: today.precipitationProbabilityPercent,
      rainPeriods: today.precipitationPeriods ?? [],
      sunrise: clockTime(today.sunrise),
      sunset: clockTime(today.sunset),
    },
  };
}

const HOLIDAY_CALENDAR = /holiday|observance|birthday/i;

function calendar(data: UnknownRecord, date: string, timezone: string): unknown {
  const events = deduplicate((data.events as UnknownRecord[]) ?? []);
  const tomorrow = addDays(date, 1);
  const buckets: Record<string, UnknownRecord[]> = { today: [], tomorrow: [], later: [] };
  const observances: string[] = [];

  for (const event of events) {
    const day = localDay(event, timezone);
    const name = String(((event.calendar ?? {}) as UnknownRecord).name ?? "");
    if (event.allDay === true && HOLIDAY_CALENDAR.test(name)) {
      const when = day === date ? "today" : day === tomorrow ? "tomorrow" : day;
      observances.push(`${event.title} (${when})`);
      continue;
    }
    const entry: UnknownRecord = {
      title: event.title,
      when: event.allDay === true ? "all day" : clockTime(event.start, timezone),
      day,
    };
    if (event.location) entry.location = event.location;
    if (event.responseStatus && event.responseStatus !== "accepted") {
      entry.rsvp = event.responseStatus;
    }
    if (Array.isArray(event.sources) && event.sources.length > 1) {
      entry.duplicatedAcross = event.sources.length;
    }
    const bucket = day === date ? "today" : day === tomorrow ? "tomorrow" : "later";
    buckets[bucket].push(entry);
  }

  return {
    today: buckets.today,
    tomorrow: buckets.tomorrow,
    later: buckets.later,
    observances: [...new Set(observances)],
  };
}

function mail(data: UnknownRecord, filters: BriefFilters): unknown {
  const accounts = (data.accounts as UnknownRecord[]) ?? [];
  const messages = accounts.flatMap((account) => (account.messages as UnknownRecord[]) ?? []);
  const { signal, dropped } = selectMail(messages, filters);
  const addresses = Object.fromEntries(
    accounts.map((account) => [String(account.id), account.address]),
  );
  return {
    accounts: addresses,
    unreadTotal: messages.filter((message) => message.unread === true).length,
    receivedTotal: messages.length,
    signal: signal.map((message) => {
      const sender = (message.sender ?? {}) as UnknownRecord;
      const entry: UnknownRecord = {
        from: sender.name || sender.address,
        subject: message.subject,
        account: message.account,
        reason: message.reason,
        receivedAt: message.receivedAt,
      };
      if (message.duplicates > 1) entry.repeated = message.duplicates;
      return entry;
    }),
    dropped,
  };
}

function github(data: UnknownRecord): unknown {
  const repositories = (data.repositories as UnknownRecord[]) ?? [];
  const todos = (data.todos ?? {}) as UnknownRecord;
  return {
    repositories: repositories.map((repo) => ({
      name: repo.name,
      stars: metricPair(repo.stars),
      downloads: metricPair(repo.releaseDownloads),
      openIssues: repo.openIssues,
    })),
    actionable: [
      ...workItems(todos.reviewRequests),
      ...workItems(todos.assignedPullRequests),
      ...workItems(todos.assignedIssues),
      ...workItems(todos.authoredPullRequests),
    ].filter((item) => item.actionReasons.length > 0),
    openAuthoredIssues: countOf(todos.authoredIssues),
    notifications: (asArray(todos.notifications)).map((item) => ({
      repository: (item.repository as UnknownRecord)?.full_name,
      reason: item.reason,
      type: (item.subject as UnknownRecord)?.type,
      title: (item.subject as UnknownRecord)?.title,
      updatedAt: item.updated_at,
    })),
  };
}

function gitlab(data: UnknownRecord, filters: BriefFilters): unknown {
  const { kept, ignored } = partitionTodos((data.todos as UnknownRecord[]) ?? [], filters);
  const projects = (data.projects as UnknownRecord[]) ?? [];
  return {
    todos: kept.map((todo) => {
      const target = (todo.target ?? {}) as UnknownRecord;
      const author = (todo.author ?? {}) as UnknownRecord;
      return {
        action: todo.action_name,
        title: target.title ?? todo.body,
        url: todo.target_url,
        author: author.username,
        project: (todo.project as UnknownRecord)?.path_with_namespace,
        updatedAt: todo.updated_at,
      };
    }),
    todosIgnored: ignored,
    projects: projects.map((project) => ({
      path: project.path,
      stars: metricPair((project.metrics as UnknownRecord)?.stars),
      reviewRequests: mergeRequests(project.reviewRequests),
      // Authored and assigned overlap almost entirely; one list keeps the brief honest.
      myMergeRequests: mergeRequests([
        ...asArray(project.authoredMergeRequests),
        ...asArray(project.assignedMergeRequests),
      ]),
      // Every assigned issue is flagged actionRequired upstream, which makes the whole
      // backlog look urgent. Only dated work earns a line; the rest is a count.
      assignedIssues: asArray(project.assignedIssues)
        .filter((issue) => issue.overdue === true || issue.dueDate)
        .map((issue) => ({
          reference: issue.reference,
          title: issue.title,
          url: issue.url,
          dueDate: issue.dueDate,
          overdue: issue.overdue,
        })),
      assignedIssuesTotal: countOf(project.assignedIssues),
      authoredIssuesTotal: countOf(project.authoredIssues),
      recap: project.recap,
    })),
  };
}

function mergeRequests(value: unknown) {
  const byReference = new Map<string, UnknownRecord>();
  for (const mr of asArray(value)) {
    const pipeline = (mr.pipeline ?? null) as UnknownRecord | null;
    const approvals = (mr.approvals ?? null) as UnknownRecord | null;
    const reference = String(mr.reference ?? mr.url);
    const entry: UnknownRecord = byReference.get(reference) ?? {
      reference,
      title: mr.title,
      url: mr.url,
      updatedAt: mr.updatedAt,
    };
    if (mr.draft === true) entry.draft = true;
    if (pipeline) entry.pipeline = pipeline.status;
    const mergeability = (mr.mergeability ?? {}) as UnknownRecord;
    if (mergeability.status && mergeability.status !== "unchecked") {
      entry.mergeStatus = mergeability.status;
    }
    if (mergeability.hasConflicts === true) entry.conflicts = true;
    if (mr.discussionsResolved === false) entry.unresolvedDiscussions = true;
    if (approvals) {
      const approvedBy = (approvals.approvedBy as string[]) ?? [];
      if (approvedBy.length > 0) entry.approvedBy = approvedBy;
      if (typeof approvals.remaining === "number") entry.approvalsRemaining = approvals.remaining;
    }
    const reasons = new Set([
      ...((entry.actionReasons as string[]) ?? []),
      ...((mr.actionReasons as string[]) ?? []),
    ]);
    if (reasons.size > 0) entry.actionReasons = [...reasons];
    byReference.set(reference, entry);
  }
  return [...byReference.values()];
}

function workItems(value: unknown) {
  return asArray(value).map((item) => ({
    reference: item.reference,
    title: item.title,
    url: item.url,
    updatedAt: item.updatedAt,
    checks: item.checks,
    reviewDecision: item.reviewDecision,
    actionReasons: (item.actionReasons as string[]) ?? [],
  }));
}

function metricPair(value: unknown) {
  const metric = (value ?? {}) as UnknownRecord;
  return metric.delta === null || metric.delta === undefined
    ? { current: metric.current ?? null }
    : { current: metric.current, delta: metric.delta };
}

function asArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value as UnknownRecord[] : [];
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function deduplicate(events: UnknownRecord[]): UnknownRecord[] {
  const byKey = new Map<string, UnknownRecord & { sources: string[] }>();
  for (const event of events) {
    const key = `${event.title}|${event.start}|${event.end}`;
    const existing = byKey.get(key);
    if (existing) existing.sources.push(String(event.account));
    else byKey.set(key, { ...event, sources: [String(event.account)] });
  }
  return [...byKey.values()];
}

function localDay(event: UnknownRecord, timezone: string): string {
  const start = String(event.start ?? "");
  if (event.allDay === true || /^\d{4}-\d{2}-\d{2}$/.test(start)) return start.slice(0, 10);
  const parsed = new Date(start);
  if (Number.isNaN(parsed.valueOf())) return start.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
}

function clockTime(value: unknown, timezone?: string): string | null {
  const text = String(value ?? "");
  if (!text) return null;
  if (!timezone) return text.slice(11, 16) || text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.valueOf())) return text;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed);
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

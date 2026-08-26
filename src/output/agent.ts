import type { BriefFilters } from "../config.ts";
import type { BriefOutput, SectionResult } from "../types.ts";
import { partitionTodos, selectMail, type UnknownRecord } from "./select.ts";

/**
 * A compact, flat projection of BriefOutput for a language model to narrate.
 *
 * The `json` format is a faithful dump of every upstream response and runs to roughly 180 KB.
 * This projection is built for the opposite constraint: a small, locally hosted model with a
 * short context window that reasons poorly over deep JSON. So the shape is deliberately dull.
 *
 * - One flat `work` array instead of five nested per-project buckets.
 * - Ranking already applied, so the model narrates the given order instead of judging urgency.
 * - Every reason pre-phrased in English, so no reason code has to be interpreted.
 * - Hard item caps with explicit "+N more" counts, so a busy day cannot blow the window.
 */
export interface AgentBrief {
  date: string;
  weekday: string;
  timezone: string;
  weekend: boolean;
  health: { collected: string[]; problems: string[] };
  weather?: unknown;
  calendar?: unknown;
  mail?: unknown;
  work: WorkItem[];
  workOmitted: number;
  metrics: unknown[];
  recap?: unknown;
}

export interface WorkItem {
  priority: 1 | 2 | 3;
  source: "gitlab" | "github";
  kind: string;
  ref: string;
  title: string;
  url: string;
  why: string;
}

/** Reason codes, in the order they should read, mapped to plain English. */
const REASON_TEXT: Record<string, string> = {
  pipeline_failed: "pipeline failed",
  checks_failed: "checks failed",
  merge_conflict: "merge conflict",
  changes_requested: "changes requested",
  merge_blocked: "merge blocked",
  overdue: "overdue",
  unresolved_discussions: "unresolved threads",
  review_requested: "review requested",
  assigned: "assigned to you",
  ready_to_merge: "approved and ready to merge",
};

/** Anything here means the item is blocked or failing rather than merely waiting. */
const BLOCKING = new Set([
  "pipeline_failed",
  "checks_failed",
  "merge_conflict",
  "changes_requested",
  "merge_blocked",
  "overdue",
]);

const WEEKDAY = new Intl.DateTimeFormat("en-CA", { weekday: "long", timeZone: "UTC" });
const HOLIDAY_CALENDAR = /holiday|observance|birthday/i;

export interface AgentOptions {
  /** Maximum entries per list before a "+N more" count replaces the tail. */
  maxItems: number;
}

export function renderAgentBrief(
  output: BriefOutput,
  filters: BriefFilters,
  options: AgentOptions = { maxItems: 15 },
): AgentBrief {
  const timezone = output.run.timezone;
  const date = output.run.reportingDate;
  const weekday = WEEKDAY.format(new Date(`${date}T12:00:00Z`));
  const collected: string[] = [];
  const problems: string[] = [];

  for (const name of ["weather", "mail", "calendar", "github", "gitlab"] as const) {
    const section = output[name];
    if (section.status === "ok" || section.status === "partial") collected.push(name);
    if (section.error) problems.push(`${name}: ${section.error.message}`);
    for (const warning of section.warnings) problems.push(`${name}: ${warning}`);
  }

  const work = [
    ...gitlabWork(output.gitlab, filters),
    ...githubWork(output.github),
  ].sort((a, b) => a.priority - b.priority || KIND_ORDER(a) - KIND_ORDER(b));

  return {
    date,
    weekday,
    timezone,
    weekend: weekday === "Saturday" || weekday === "Sunday",
    health: { collected, problems },
    weather: project(output.weather, weather),
    calendar: project(
      output.calendar,
      (data) => calendar(data, date, timezone, options.maxItems),
    ),
    mail: project(output.mail, (data) => mail(data, filters, options.maxItems)),
    work: work.slice(0, options.maxItems),
    workOmitted: Math.max(0, work.length - options.maxItems),
    metrics: metrics(output.github),
    recap: recap(output.gitlab, options.maxItems),
  };
}

function project(
  section: SectionResult<unknown>,
  build: (data: UnknownRecord) => unknown,
): unknown {
  if (!section.data) return undefined;
  return build(section.data as UnknownRecord);
}

/** Local hours sampled for the intraday arc: early, morning, midday, afternoon, evening, night. */
const ARC_HOURS = [6, 9, 12, 15, 18, 21];

function weather(data: UnknownRecord): unknown {
  const current = (data.current ?? {}) as UnknownRecord;
  const today = (data.today ?? {}) as UnknownRecord;
  const tomorrow = (data.tomorrow ?? null) as UnknownRecord | null;
  const units = (data.units ?? {}) as UnknownRecord;
  const degrees = String(units.temperature ?? "");
  const rain = asArray(today.precipitationPeriods);

  const hours = asArray(today.hours)
    .filter((hour) => ARC_HOURS.includes(Number(String(hour.time ?? "").slice(11, 13))))
    .map((hour) => ({
      at: String(hour.time ?? "").slice(11, 16),
      temp: `${hour.temperature}${degrees}`,
      condition: hour.condition,
    }));

  return {
    location: (data.location as UnknownRecord)?.name ?? null,
    now:
      `${current.temperature}${degrees}, ${current.condition}, feels like ${current.apparentTemperature}${degrees}`,
    today:
      `high ${today.maximumTemperature}${degrees}, low ${today.minimumTemperature}${degrees}, ${today.condition}, ${today.precipitationProbabilityPercent}% chance of rain`,
    hours,
    tomorrow: tomorrow
      ? `high ${tomorrow.maximumTemperature}${degrees}, low ${tomorrow.minimumTemperature}${degrees}, ${tomorrow.condition}, ${tomorrow.precipitationProbabilityPercent}% chance of rain`
      : undefined,
    rainPeriods: rain.length > 0
      ? rain.map((period) => ({
        at: String(period.time ?? "").slice(11, 16),
        chance: `${period.probabilityPercent}%`,
      }))
      : undefined,
    sunrise: clockTime(today.sunrise),
    sunset: clockTime(today.sunset),
  };
}

function calendar(
  data: UnknownRecord,
  date: string,
  timezone: string,
  maxItems: number,
): unknown {
  const events = deduplicate(asArray(data.events));
  const tomorrow = addDays(date, 1);
  const today: UnknownRecord[] = [];
  const next: UnknownRecord[] = [];
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
      at: event.allDay === true ? "all day" : clockTime(event.start, timezone),
      title: event.title,
    };
    if (event.location) entry.location = event.location;
    if (event.responseStatus && event.responseStatus !== "accepted") {
      entry.rsvp = event.responseStatus;
    }
    if (day === date) today.push(entry);
    else next.push({ ...entry, day });
  }

  return {
    today: today.slice(0, maxItems),
    upcoming: next.slice(0, maxItems),
    observances: [...new Set(observances)].slice(0, maxItems),
  };
}

function mail(data: UnknownRecord, filters: BriefFilters, maxItems: number): unknown {
  const accounts = asArray(data.accounts);
  const messages = accounts.flatMap((account) => asArray(account.messages));
  const { signal, dropped } = selectMail(messages, filters);
  const filtered = dropped.category + dropped.sender + dropped.duplicate + dropped.noSignal;
  return {
    received: messages.length,
    unread: messages.filter((message) => message.unread === true).length,
    filtered,
    items: signal.slice(0, maxItems).map((message) => {
      const sender = (message.sender ?? {}) as UnknownRecord;
      const entry: UnknownRecord = {
        from: sender.name || sender.address,
        subject: message.subject,
        why: message.reason === "unread" ? "unread" : "may need a decision",
      };
      if (message.duplicates > 1) entry.why += `, arrived ${message.duplicates} times`;
      return entry;
    }),
    itemsOmitted: Math.max(0, signal.length - maxItems),
  };
}

function gitlabWork(section: SectionResult<unknown>, filters: BriefFilters): WorkItem[] {
  if (!section.data) return [];
  const data = section.data as UnknownRecord;
  const items: WorkItem[] = [];
  const seen = new Set<string>();
  const seenUrls = new Set<string>();

  for (const project of asArray(data.projects)) {
    for (
      const [kind, list] of [
        ["review", project.reviewRequests],
        ["my merge request", project.authoredMergeRequests],
        ["my merge request", project.assignedMergeRequests],
      ] as const
    ) {
      for (const mr of asArray(list)) {
        const ref = String(mr.reference ?? mr.url);
        if (seen.has(ref)) continue;
        seen.add(ref);
        seenUrls.add(String(mr.url ?? ""));
        const reasons = (mr.actionReasons as string[]) ?? [];
        const extra: string[] = [];
        if (mr.draft === true) extra.push("draft");
        const approvals = (mr.approvals ?? null) as UnknownRecord | null;
        const approvedBy = (approvals?.approvedBy as string[]) ?? [];
        if (approvedBy.length > 0) extra.push(`approved by ${approvedBy.join(", ")}`);
        items.push({
          priority: rank(reasons, kind === "review"),
          source: "gitlab",
          kind,
          ref,
          title: String(mr.title ?? ""),
          url: String(mr.url ?? ""),
          why: phrase(reasons, extra),
        });
      }
    }
    for (const issue of asArray(project.assignedIssues)) {
      if (issue.overdue !== true && !issue.dueDate) continue;
      const reasons = (issue.actionReasons as string[]) ?? [];
      items.push({
        priority: issue.overdue === true ? 1 : 2,
        source: "gitlab",
        kind: "issue",
        ref: String(issue.reference ?? ""),
        title: String(issue.title ?? ""),
        url: String(issue.url ?? ""),
        why: phrase(reasons, issue.dueDate ? [`due ${issue.dueDate}`] : []),
      });
    }
  }

  // Recurring bot todos are removed here as well as in the Telegram renderer, otherwise the
  // flat work list fills up with them and starves the merge requests.
  const { kept } = partitionTodos(asArray(data.todos), filters);
  for (const todo of kept) {
    const target = (todo.target ?? {}) as UnknownRecord;
    const url = String(todo.target_url ?? "");
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    const author = (todo.author ?? {}) as UnknownRecord;
    const action = String(todo.action_name ?? "todo").replace(/_/g, " ");
    items.push({
      priority: 2,
      source: "gitlab",
      kind: "todo",
      ref: String(
        target.reference ??
          (todo.project as UnknownRecord)?.path_with_namespace ??
          action,
      ),
      title: String(target.title ?? todo.body ?? ""),
      url,
      why: `${action} by ${author.username ?? "someone"}`,
    });
  }
  return items;
}

/** Within a priority, work you own or must review outranks inbox-style todos. */
function KIND_ORDER(item: WorkItem): number {
  if (item.kind === "review") return 0;
  if (item.kind === "my merge request") return 1;
  if (item.kind === "issue") return 2;
  if (item.kind === "notification") return 4;
  return 3;
}

function githubWork(section: SectionResult<unknown>): WorkItem[] {
  if (!section.data) return [];
  const todos = ((section.data as UnknownRecord).todos ?? {}) as UnknownRecord;
  const items: WorkItem[] = [];

  for (
    const [kind, list] of [
      ["review", todos.reviewRequests],
      ["pull request", todos.assignedPullRequests],
      ["pull request", todos.authoredPullRequests],
      ["issue", todos.assignedIssues],
    ] as const
  ) {
    for (const item of asArray(list)) {
      const reasons = (item.actionReasons as string[]) ?? [];
      if (reasons.length === 0) continue;
      items.push({
        priority: rank(reasons, kind === "review"),
        source: "github",
        kind,
        ref: String(item.reference ?? ""),
        title: String(item.title ?? ""),
        url: String(item.url ?? ""),
        why: phrase(reasons, []),
      });
    }
  }

  for (const note of asArray(todos.notifications)) {
    const subject = (note.subject ?? {}) as UnknownRecord;
    items.push({
      priority: 2,
      source: "github",
      kind: "notification",
      ref: String((note.repository as UnknownRecord)?.full_name ?? ""),
      title: String(subject.title ?? ""),
      url: "",
      why: String(note.reason ?? "notification").replace(/_/g, " "),
    });
  }
  return items;
}

function metrics(section: SectionResult<unknown>): unknown[] {
  if (!section.data) return [];
  return asArray((section.data as UnknownRecord).repositories).map((repo) => {
    const stars = (repo.stars ?? {}) as UnknownRecord;
    const downloads = (repo.releaseDownloads ?? {}) as UnknownRecord;
    const entry: UnknownRecord = { name: repo.name, stars: stars.current };
    if (typeof stars.delta === "number" && stars.delta !== 0) entry.starsChange = stars.delta;
    if (downloads.current) entry.downloads = downloads.current;
    if (typeof downloads.delta === "number" && downloads.delta !== 0) {
      entry.downloadsChange = downloads.delta;
    }
    return entry;
  });
}

function recap(section: SectionResult<unknown>, maxItems: number): unknown {
  if (!section.data) return undefined;
  const projects = asArray((section.data as UnknownRecord).projects);
  const merged: unknown[] = [];
  const closed: unknown[] = [];
  let since: string | null = null;
  for (const project of projects) {
    const projectRecap = project.recap as UnknownRecord | null | undefined;
    if (!projectRecap) continue;
    since = String(projectRecap.since ?? "").slice(0, 10);
    for (const mr of asArray(projectRecap.mergedMergeRequests)) {
      merged.push({ ref: mr.reference, title: mr.title, url: mr.url });
    }
    for (const issue of asArray(projectRecap.closedIssues)) {
      closed.push({ ref: issue.reference, title: issue.title, url: issue.url });
    }
  }
  if (!since) return undefined;
  return {
    since,
    mergedCount: merged.length,
    merged: merged.slice(0, maxItems),
    closedCount: closed.length,
    closed: closed.slice(0, maxItems),
  };
}

/** 1 blocked or failing, 2 waiting on Kushal, 3 in flight. */
function rank(reasons: string[], waiting: boolean): 1 | 2 | 3 {
  if (reasons.some((reason) => BLOCKING.has(reason))) return 1;
  if (waiting || reasons.includes("assigned")) return 2;
  return 3;
}

function phrase(reasons: string[], extra: string[]): string {
  const ordered = Object.keys(REASON_TEXT).filter((key) => reasons.includes(key));
  const unknown = reasons.filter((reason) => !REASON_TEXT[reason]).map((reason) =>
    reason.replace(/_/g, " ")
  );
  const parts = [...ordered.map((key) => REASON_TEXT[key]), ...unknown, ...extra];
  return parts.length > 0 ? parts.join(", ") : "no action flagged";
}

function asArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value as UnknownRecord[] : [];
}

function deduplicate(events: UnknownRecord[]): UnknownRecord[] {
  const byKey = new Map<string, UnknownRecord>();
  for (const event of events) {
    const key = `${event.title}|${event.start}|${event.end}`;
    if (!byKey.has(key)) byKey.set(key, event);
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

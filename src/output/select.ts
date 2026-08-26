import type { BriefFilters } from "../config.ts";

export type UnknownRecord = Record<string, unknown>;

/**
 * Subjects that usually need a decision even when the message has already been opened.
 * Gmail's own IMPORTANT flag is deliberately not used for inclusion: it fires on a large
 * share of newsletters and would drag the whole inbox into the brief.
 */
const ACTION_SUBJECT =
  /security alert|expired|expiring|balance|invoice|payment|renew|overdue|suspend|verify|declined|failed|action required|action advised|supporter|delivered|out for delivery/i;

export interface MailSignal extends UnknownRecord {
  reason: "unread" | "needs-decision";
  duplicates: number;
}

export interface MailSelection {
  signal: MailSignal[];
  dropped: {
    category: number;
    sender: number;
    duplicate: number;
    noSignal: number;
  };
}

function categoryOf(message: UnknownRecord): string | null {
  const labels = Array.isArray(message.labels) ? message.labels as string[] : [];
  const category = labels.find((label) => label.startsWith("CATEGORY_"));
  return category ? category.slice("CATEGORY_".length).toLowerCase() : null;
}

function senderText(message: UnknownRecord): string {
  const sender = (message.sender ?? {}) as UnknownRecord;
  return `${sender.name ?? ""} ${sender.address ?? ""}`.toLowerCase();
}

/**
 * Reduces a day of mail to the messages worth mentioning, plus counts of what was removed
 * and why. The counts let a narrator say "the rest was newsletters" truthfully without
 * being handed the newsletters.
 */
export function selectMail(messages: UnknownRecord[], filters: BriefFilters): MailSelection {
  const dropped = { category: 0, sender: 0, duplicate: 0, noSignal: 0 };
  const byKey = new Map<string, MailSignal>();

  for (const message of messages) {
    const category = categoryOf(message);
    if (category && filters.mailIgnoreCategories.includes(category)) {
      dropped.category++;
      continue;
    }
    const from = senderText(message);
    if (filters.mailIgnoreSenders.some((entry) => from.includes(entry))) {
      dropped.sender++;
      continue;
    }
    const subject = String(message.subject ?? "");
    const needsDecision = ACTION_SUBJECT.test(subject);
    if (message.unread !== true && !needsDecision) {
      dropped.noSignal++;
      continue;
    }
    const key = `${from}|${subject.toLowerCase()}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.duplicates++;
      dropped.duplicate++;
      if (message.unread === true) existing.reason = "unread";
      continue;
    }
    byKey.set(key, {
      ...message,
      reason: message.unread === true ? "unread" : "needs-decision",
      duplicates: 1,
    });
  }

  const signal = [...byKey.values()].sort((a, b) =>
    rank(a) - rank(b) ||
    String(b.receivedAt ?? "").localeCompare(String(a.receivedAt ?? ""))
  );
  return { signal, dropped };
}

/** Messages needing a decision lead, then unread, each newest first. */
function rank(message: MailSignal): number {
  return message.reason === "needs-decision" ? 0 : 1;
}

/** True when a GitLab todo's target title matches one of the configured ignore substrings. */
export function isIgnoredTodo(todo: UnknownRecord, filters: BriefFilters): boolean {
  if (filters.todoIgnoreTitles.length === 0) return false;
  const target = (todo.target ?? {}) as UnknownRecord;
  const title = String(target.title ?? todo.body ?? "").toLowerCase();
  return filters.todoIgnoreTitles.some((entry) => title.includes(entry));
}

export function partitionTodos(todos: UnknownRecord[], filters: BriefFilters) {
  const kept: UnknownRecord[] = [];
  let ignored = 0;
  for (const todo of todos) {
    if (isIgnoredTodo(todo, filters)) ignored++;
    else kept.push(todo);
  }
  return { kept, ignored };
}

/** Default filters, used when a caller has no configuration to hand. */
export const NO_FILTERS: BriefFilters = {
  mailIgnoreCategories: [],
  mailIgnoreSenders: [],
  todoIgnoreTitles: [],
};

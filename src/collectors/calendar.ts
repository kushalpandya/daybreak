import type { DaybreakConfig, GoogleAccountConfig } from "../config.ts";
import type { RunContext } from "../types.ts";
import { gwsPaginated } from "../integrations/gws.ts";
import { errorMessage, mapSettledConcurrent } from "../utils.ts";

interface CalendarItem {
  id: string;
  summary?: string;
  primary?: boolean;
  selected?: boolean;
  deleted?: boolean;
  accessRole?: string;
  timeZone?: string;
}
interface CalendarEvent {
  id: string;
  iCalUID?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  htmlLink?: string;
  start: { date?: string; dateTime?: string; timeZone?: string };
  end: { date?: string; dateTime?: string; timeZone?: string };
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
  recurringEventId?: string;
  organizer?: { email?: string; displayName?: string };
}

export async function collectCalendar(
  config: NonNullable<DaybreakConfig["google"]>,
  run: RunContext,
) {
  const results = await Promise.allSettled(
    config.accounts.map((account) => collectAccount(account, config, run)),
  );
  const accounts = [];
  const warnings: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      accounts.push(result.value);
      warnings.push(...result.value.warnings.map((warning) => `${result.value.id}: ${warning}`));
    } else warnings.push(`${config.accounts[i].id}: ${errorMessage(result.reason)}`);
  }
  if (accounts.length === 0 && warnings.length > 0) throw new Error(warnings.join("; "));
  const events = accounts.flatMap((account) => account.events).sort(compareEvents);
  const accountSummaries = accounts.map(({ events: _events, ...account }) => account);
  return {
    data: { window: run.windows.calendar, accounts: accountSummaries, events },
    warnings,
    partial: warnings.length > 0,
  };
}

async function collectAccount(
  account: GoogleAccountConfig,
  config: NonNullable<DaybreakConfig["google"]>,
  run: RunContext,
) {
  const calendarsResult = await gwsPaginated<CalendarItem>(
    account,
    ["calendar", "calendarList", "list"],
    { maxResults: 100, showDeleted: false, showHidden: false },
    "items",
    500,
  );
  const calendars = calendarsResult.items.filter((calendar) =>
    !calendar.deleted && calendar.accessRole !== "none"
  );
  const eventResults = await mapSettledConcurrent(calendars, 6, async (calendar) => {
    const result = await gwsPaginated<CalendarEvent>(
      account,
      ["calendar", "events", "list"],
      {
        calendarId: calendar.id,
        timeMin: run.windows.calendar.start,
        timeMax: run.windows.calendar.end,
        singleEvents: true,
        orderBy: "startTime",
        showDeleted: false,
        maxResults: 250,
      },
      "items",
      1000,
    );
    return result.items
      .filter((event) => event.status !== "cancelled")
      .filter((event) => config.includeDeclined || selfResponse(event) !== "declined")
      .map((event) => normalizeEvent(account, calendar, event));
  });
  const warnings: string[] = [];
  const events = eventResults.flatMap((result, index) => {
    if (result.status === "fulfilled") return result.value;
    warnings.push(
      `${calendars[index].summary ?? calendars[index].id}: ${errorMessage(result.reason)}`,
    );
    return [];
  });
  return {
    id: account.id,
    address: account.address,
    calendars: calendars.map((calendar) => ({
      id: calendar.id,
      name: calendar.summary ?? calendar.id,
      primary: calendar.primary ?? false,
      timezone: calendar.timeZone ?? null,
    })),
    events,
    warnings,
  };
}

function normalizeEvent(
  account: GoogleAccountConfig,
  calendar: CalendarItem,
  event: CalendarEvent,
) {
  const allDay = Boolean(event.start.date);
  return {
    id: `${account.id}:${calendar.id}:${event.id}`,
    providerId: event.id,
    iCalUid: event.iCalUID ?? null,
    account: account.id,
    accountAddress: account.address,
    calendar: {
      id: calendar.id,
      name: calendar.summary ?? calendar.id,
      primary: calendar.primary ?? false,
    },
    title: event.summary ?? "(untitled event)",
    start: event.start.dateTime ?? event.start.date,
    end: event.end.dateTime ?? event.end.date,
    timezone: event.start.timeZone ?? calendar.timeZone ?? null,
    allDay,
    location: event.location ?? null,
    status: event.status ?? "confirmed",
    responseStatus: selfResponse(event),
    recurring: Boolean(event.recurringEventId),
    organizer: event.organizer ?? null,
    url: event.htmlLink ?? null,
  };
}

function selfResponse(event: CalendarEvent): string | null {
  return event.attendees?.find((attendee) => attendee.self)?.responseStatus ?? null;
}

function compareEvents(a: { start?: string }, b: { start?: string }) {
  return (a.start ?? "").localeCompare(b.start ?? "");
}

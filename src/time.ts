import type { DaybreakConfig } from "./config.ts";
import type { RunContext } from "./types.ts";

export function createRunContext(config: DaybreakConfig, reportingDate?: string): RunContext {
  const now = reportingDate
    ? Temporal.PlainDate.from(reportingDate).toZonedDateTime({
      timeZone: config.brief.timezone,
      plainTime: Temporal.PlainTime.from("07:00"),
    })
    : Temporal.Now.zonedDateTimeISO(config.brief.timezone);
  const instant = now.toInstant();
  const calendarStart = now.startOfDay();
  const wholeDays = config.brief.calendarLookaheadMs / 86_400_000;
  const calendarEnd = Number.isInteger(wholeDays)
    ? calendarStart.add({ days: wholeDays })
    : calendarStart.add({ milliseconds: config.brief.calendarLookaheadMs });
  const githubLookback = config.github?.lookbackMs ?? 86_400_000;

  return {
    id: `daybreak:${now.toPlainDate()}:${config.brief.timezone}`,
    startedAt: new Date().toISOString(),
    reportingTime: now.toString(),
    reportingDate: now.toPlainDate().toString(),
    timezone: config.brief.timezone,
    windows: {
      mail: {
        start: instant.subtract({ milliseconds: config.brief.mailLookbackMs }).toString(),
        end: instant.toString(),
      },
      calendar: {
        start: calendarStart.toInstant().toString(),
        end: calendarEnd.toInstant().toString(),
      },
      github: {
        start: instant.subtract({ milliseconds: githubLookback }).toString(),
        end: instant.toString(),
      },
    },
  };
}

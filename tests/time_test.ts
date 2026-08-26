import { assertEquals } from "@std/assert";
import type { DaybreakConfig } from "../src/config.ts";
import { createRunContext } from "../src/time.ts";

Deno.test("createRunContext uses local day boundaries across DST", () => {
  const config: DaybreakConfig = {
    schemaVersion: 1,
    brief: {
      timezone: "America/New_York",
      mailLookbackMs: 86_400_000,
      calendarLookaheadMs: 172_800_000,
    },
    filters: { mailIgnoreCategories: [], mailIgnoreSenders: [], todoIgnoreTitles: [] },
    state: { database: ":memory:" },
  };
  const run = createRunContext(config, "2026-03-08");
  assertEquals(run.windows.calendar.start, "2026-03-08T05:00:00Z");
  assertEquals(run.windows.calendar.end, "2026-03-10T04:00:00Z");
});

import { assertFalse, assertStringIncludes } from "@std/assert";
import { renderBrief } from "../src/output/brief.ts";
import type { BriefOutput } from "../src/types.ts";

Deno.test("renderBrief uses emoji headings and section separators", () => {
  const skipped = {
    status: "skipped" as const,
    collectedAt: "2026-08-25T12:00:00Z",
    durationMs: 0,
    data: null,
    warnings: [],
  };
  const output: BriefOutput = {
    schemaVersion: 1,
    run: {
      id: "test",
      startedAt: "2026-08-25T12:00:00Z",
      completedAt: "2026-08-25T12:00:01Z",
      reportingTime: "2026-08-25T08:00:00-04:00[America/Toronto]",
      reportingDate: "2026-08-25",
      timezone: "America/Toronto",
      windows: {
        mail: { start: "2026-08-24T12:00:00Z", end: "2026-08-25T12:00:00Z" },
        calendar: { start: "2026-08-25T04:00:00Z", end: "2026-08-27T04:00:00Z" },
        github: { start: "2026-08-24T12:00:00Z", end: "2026-08-25T12:00:00Z" },
      },
    },
    weather: skipped,
    mail: skipped,
    calendar: skipped,
    github: skipped,
    gitlab: skipped,
  };

  const result = renderBrief(output);
  assertStringIncludes(result, "☀️ Tuesday, August 25, 2026");
  assertFalse(result.includes("🌤️ WEATHER"));
});

Deno.test("renderBrief separates included sections", () => {
  const skipped = {
    status: "skipped" as const,
    collectedAt: "2026-08-25T12:00:00Z",
    durationMs: 0,
    data: null,
    warnings: [],
  };
  const failed = {
    status: "error" as const,
    collectedAt: "2026-08-25T12:00:00Z",
    durationMs: 1,
    data: null,
    warnings: [],
    error: { code: "failed", message: "test failure" },
  };
  const output: BriefOutput = {
    schemaVersion: 1,
    run: {
      id: "test",
      startedAt: "2026-08-25T12:00:00Z",
      completedAt: "2026-08-25T12:00:01Z",
      reportingTime: "2026-08-25T08:00:00-04:00[America/Toronto]",
      reportingDate: "2026-08-25",
      timezone: "America/Toronto",
      windows: {
        mail: { start: "2026-08-24T12:00:00Z", end: "2026-08-25T12:00:00Z" },
        calendar: { start: "2026-08-25T04:00:00Z", end: "2026-08-27T04:00:00Z" },
        github: { start: "2026-08-24T12:00:00Z", end: "2026-08-25T12:00:00Z" },
      },
    },
    weather: failed,
    mail: skipped,
    calendar: skipped,
    github: skipped,
    gitlab: failed,
  };

  const result = renderBrief(output);
  assertStringIncludes(result, "🌤️ WEATHER");
  assertStringIncludes(result, "🦊 GITLAB");
  assertStringIncludes(result, "━━━━━━━━━━━━━━━━━━━━");
});

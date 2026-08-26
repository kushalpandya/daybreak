import { assertEquals } from "@std/assert";
import { renderAgentBrief } from "../src/output/agent.ts";
import { NO_FILTERS } from "../src/output/select.ts";
import type { BriefOutput, SectionResult } from "../src/types.ts";

function section(data: unknown): SectionResult<unknown> {
  return {
    status: "ok",
    collectedAt: "2026-08-25T12:00:00Z",
    durationMs: 1,
    data,
    warnings: [],
  };
}

const skipped: SectionResult<unknown> = {
  status: "skipped",
  collectedAt: "2026-08-25T12:00:00Z",
  durationMs: 0,
  data: null,
  warnings: [],
};

function output(overrides: Partial<BriefOutput> = {}): BriefOutput {
  return {
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
    ...overrides,
  };
}

Deno.test("renderAgentBrief reports the weekday and section health", () => {
  const brief = renderAgentBrief(
    output({
      gitlab: {
        ...skipped,
        status: "error",
        error: { code: "gitlab_collection_failed", message: "glab exploded" },
      },
    }),
    NO_FILTERS,
  );

  assertEquals(brief.weekday, "Tuesday");
  assertEquals(brief.weekend, false);
  assertEquals(brief.sections.gitlab, "error");
  assertEquals(brief.problems, ["gitlab: glab exploded"]);
});

Deno.test("renderAgentBrief buckets calendar events by local day", () => {
  const brief = renderAgentBrief(
    output({
      calendar: section({
        events: [
          {
            title: "Standup",
            start: "2026-08-25T14:00:00Z",
            end: "2026-08-25T14:15:00Z",
            allDay: false,
            account: 1,
            calendar: { name: "Work" },
          },
          {
            title: "Retro",
            start: "2026-08-26T14:00:00Z",
            end: "2026-08-26T15:00:00Z",
            allDay: false,
            account: 1,
            calendar: { name: "Work" },
          },
          {
            title: "Onam",
            start: "2026-08-26",
            end: "2026-08-27",
            allDay: true,
            account: 1,
            calendar: { name: "Holidays in India" },
          },
        ],
      }),
    }),
    NO_FILTERS,
  );

  const calendar = brief.calendar as {
    today: Array<{ title: string; when: string }>;
    tomorrow: Array<{ title: string }>;
    observances: string[];
  };
  assertEquals(calendar.today.length, 1);
  assertEquals(calendar.today[0].title, "Standup");
  assertEquals(calendar.today[0].when, "10:00");
  assertEquals(calendar.tomorrow.map((event) => event.title), ["Retro"]);
  assertEquals(calendar.observances, ["Onam (tomorrow)"]);
});

Deno.test("renderAgentBrief merges authored and assigned merge requests", () => {
  const shared = {
    reference: "group/project!1",
    title: "Shared",
    url: "https://example.test/1",
    updatedAt: "2026-08-25T09:00:00Z",
    mergeability: { status: "mergeable", hasConflicts: false },
    pipeline: { status: "success" },
    approvals: { required: 1, remaining: 0, approvedBy: ["reviewer"] },
  };
  const brief = renderAgentBrief(
    output({
      gitlab: section({
        todos: [],
        projects: [{
          path: "group/project",
          metrics: { stars: { current: 1, delta: null } },
          reviewRequests: [],
          authoredMergeRequests: [{ ...shared, actionReasons: ["ready_to_merge"] }],
          assignedMergeRequests: [{ ...shared, actionReasons: ["assigned"] }],
          assignedIssues: [],
          authoredIssues: [],
        }],
      }),
    }),
    NO_FILTERS,
  );

  const gitlab = brief.gitlab as {
    projects: Array<{ myMergeRequests: Array<Record<string, unknown>> }>;
  };
  const merged = gitlab.projects[0].myMergeRequests;
  assertEquals(merged.length, 1);
  assertEquals(merged[0].approvedBy, ["reviewer"]);
  assertEquals(
    new Set(merged[0].actionReasons as string[]),
    new Set(["ready_to_merge", "assigned"]),
  );
});

Deno.test("renderAgentBrief lists only dated assigned issues", () => {
  const brief = renderAgentBrief(
    output({
      gitlab: section({
        todos: [],
        projects: [{
          path: "group/project",
          metrics: { stars: { current: 1, delta: null } },
          reviewRequests: [],
          authoredMergeRequests: [],
          assignedMergeRequests: [],
          assignedIssues: [
            { reference: "a#1", title: "Dated", dueDate: "2026-08-30", overdue: false },
            { reference: "a#2", title: "Backlog", dueDate: null, overdue: false },
          ],
          authoredIssues: [],
        }],
      }),
    }),
    NO_FILTERS,
  );

  const gitlab = brief.gitlab as {
    projects: Array<{ assignedIssues: unknown[]; assignedIssuesTotal: number }>;
  };
  assertEquals(gitlab.projects[0].assignedIssues.length, 1);
  assertEquals(gitlab.projects[0].assignedIssuesTotal, 2);
});

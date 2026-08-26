import { assertEquals } from "@std/assert";
import { type AgentBrief, renderAgentBrief } from "../src/output/agent.ts";
import { NO_FILTERS } from "../src/output/select.ts";
import type { BriefFilters, DaybreakConfig } from "../src/config.ts";
import type { BriefOutput, SectionResult } from "../src/types.ts";

function section(data: unknown): SectionResult<unknown> {
  return { status: "ok", collectedAt: "2026-08-25T12:00:00Z", durationMs: 1, data, warnings: [] };
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

function mergeRequest(overrides: Record<string, unknown> = {}) {
  return {
    reference: "group/project!1",
    title: "A change",
    url: "https://example.test/1",
    updatedAt: "2026-08-25T09:00:00Z",
    actionReasons: [],
    ...overrides,
  };
}

function gitlabSection(project: Record<string, unknown>, todos: unknown[] = []) {
  return section({
    todos,
    projects: [{
      path: "group/project",
      metrics: { stars: { current: 1, delta: null } },
      reviewRequests: [],
      authoredMergeRequests: [],
      assignedMergeRequests: [],
      assignedIssues: [],
      authoredIssues: [],
      ...project,
    }],
  });
}

Deno.test("renderAgentBrief reports the weekday and section health", () => {
  const brief = renderAgentBrief(
    output({
      weather: section({ current: {}, today: {}, units: {} }),
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
  assertEquals(brief.health.collected, ["weather"]);
  assertEquals(brief.health.problems, ["gitlab: glab exploded"]);
});

Deno.test("renderAgentBrief separates holidays from appointments", () => {
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
    today: Array<{ at: string; title: string }>;
    observances: string[];
  };
  assertEquals(calendar.today, [{ at: "10:00", title: "Standup" }]);
  assertEquals(calendar.observances, ["Onam (tomorrow)"]);
});

Deno.test("renderAgentBrief ranks blocked work above waiting work", () => {
  const brief = renderAgentBrief(
    output({
      gitlab: gitlabSection({
        reviewRequests: [
          mergeRequest({
            reference: "group/project!2",
            url: "https://example.test/2",
            actionReasons: ["review_requested"],
          }),
        ],
        authoredMergeRequests: [
          mergeRequest({ actionReasons: ["pipeline_failed"] }),
        ],
      }),
    }),
    NO_FILTERS,
  );

  assertEquals(brief.work.map((item) => item.ref), ["group/project!1", "group/project!2"]);
  assertEquals(brief.work[0].priority, 1);
  assertEquals(brief.work[1].priority, 2);
});

Deno.test("renderAgentBrief phrases reasons in English and names approvers", () => {
  const brief = renderAgentBrief(
    output({
      gitlab: gitlabSection({
        authoredMergeRequests: [
          mergeRequest({
            draft: true,
            actionReasons: ["pipeline_failed", "unresolved_discussions"],
            approvals: { required: 1, remaining: 0, approvedBy: ["jerasmus"] },
          }),
        ],
      }),
    }),
    NO_FILTERS,
  );

  assertEquals(
    brief.work[0].why,
    "pipeline failed, unresolved threads, draft, approved by jerasmus",
  );
});

Deno.test("renderAgentBrief deduplicates authored and assigned merge requests", () => {
  const shared = mergeRequest({ actionReasons: ["assigned"] });
  const brief = renderAgentBrief(
    output({
      gitlab: gitlabSection({
        authoredMergeRequests: [shared],
        assignedMergeRequests: [shared],
      }),
    }),
    NO_FILTERS,
  );

  assertEquals(brief.work.length, 1);
});

Deno.test("renderAgentBrief applies todo filters and drops todos duplicating a merge request", () => {
  const filters: BriefFilters = {
    mailIgnoreCategories: [],
    mailIgnoreSenders: [],
    todoIgnoreTitles: ["community contributions report"],
  };
  const brief = renderAgentBrief(
    output({
      gitlab: gitlabSection(
        {
          reviewRequests: [mergeRequest({ actionReasons: ["review_requested"] })],
        },
        [
          {
            action_name: "assigned",
            target: { title: "Community contributions report" },
            target_url: "https://example.test/bot",
            author: { username: "gitlab-bot" },
          },
          {
            action_name: "review_requested",
            target: { title: "A change" },
            target_url: "https://example.test/1",
            author: { username: "someone" },
          },
          {
            action_name: "mentioned",
            target: { title: "Real todo", reference: "group/project#9" },
            target_url: "https://example.test/9",
            author: { username: "colleague" },
            project: { path_with_namespace: "group/project" },
          },
        ],
      ),
    }),
    filters,
  );

  assertEquals(brief.work.map((item) => item.title), ["A change", "Real todo"]);
  assertEquals(brief.work[1].why, "mentioned by colleague");
});

Deno.test("renderAgentBrief caps lists and counts the remainder", () => {
  const brief: AgentBrief = renderAgentBrief(
    output({
      gitlab: gitlabSection({
        reviewRequests: Array.from({ length: 5 }, (_unused, index) =>
          mergeRequest({
            reference: `group/project!${index}`,
            url: `https://example.test/${index}`,
            actionReasons: ["review_requested"],
          })),
      }),
    }),
    NO_FILTERS,
    { maxItems: 2 },
  );

  assertEquals(brief.work.length, 2);
  assertEquals(brief.workOmitted, 3);
});

Deno.test("renderAgentBrief only reports metric changes that moved", () => {
  const brief = renderAgentBrief(
    output({
      github: section({
        repositories: [
          {
            name: "owner/one",
            stars: { current: 10, delta: 2 },
            releaseDownloads: { current: 100, delta: 0 },
            openIssues: 1,
          },
        ],
        todos: {},
      }),
    }),
    NO_FILTERS,
  );

  assertEquals(brief.metrics, [{ name: "owner/one", stars: 10, starsChange: 2, downloads: 100 }]);
});

// Keeps the DaybreakConfig import meaningful for type-level regressions.
const _filtersAreConfigShaped: DaybreakConfig["filters"] = NO_FILTERS;

Deno.test("renderAgentBrief samples the intraday arc and reports tomorrow", () => {
  const hours = Array.from({ length: 24 }, (_unused, hour) => ({
    time: `2026-08-25T${String(hour).padStart(2, "0")}:00`,
    temperature: 10 + hour,
    weatherCode: 0,
    condition: "clear sky",
    precipitationProbabilityPercent: 0,
  }));
  const brief = renderAgentBrief(
    output({
      weather: section({
        location: { name: "Toronto" },
        units: { temperature: "°C" },
        current: { temperature: 17, apparentTemperature: 18, condition: "clear sky" },
        today: {
          maximumTemperature: 25,
          minimumTemperature: 15,
          condition: "partly cloudy",
          precipitationProbabilityPercent: 10,
          sunrise: "2026-08-25T06:34",
          sunset: "2026-08-25T20:03",
          precipitationPeriods: [],
          hours,
        },
        tomorrow: {
          maximumTemperature: 28,
          minimumTemperature: 18,
          condition: "rain showers",
          precipitationProbabilityPercent: 55,
        },
      }),
    }),
    NO_FILTERS,
  );

  const weather = brief.weather as {
    hours: Array<{ at: string; temp: string }>;
    tomorrow: string;
    sunset: string;
  };
  assertEquals(weather.hours.map((hour) => hour.at), [
    "06:00",
    "09:00",
    "12:00",
    "15:00",
    "18:00",
    "21:00",
  ]);
  assertEquals(weather.hours[3].temp, "25°C");
  assertEquals(weather.tomorrow, "high 28°C, low 18°C, rain showers, 55% chance of rain");
  assertEquals(weather.sunset, "20:03");
});

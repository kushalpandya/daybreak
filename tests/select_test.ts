import { assertEquals } from "@std/assert";
import { partitionTodos, selectMail } from "../src/output/select.ts";
import type { BriefFilters } from "../src/config.ts";

const filters: BriefFilters = {
  mailIgnoreCategories: ["promotions"],
  mailIgnoreSenders: ["noreply@newsletter.test"],
  todoIgnoreTitles: ["community contributions report"],
};

function message(overrides: Record<string, unknown>) {
  return {
    sender: { name: "Someone", address: "someone@example.com" },
    subject: "Hello",
    labels: ["CATEGORY_PERSONAL"],
    unread: false,
    important: false,
    receivedAt: "2026-08-25T10:00:00Z",
    ...overrides,
  };
}

Deno.test("selectMail drops ignored categories and senders", () => {
  const result = selectMail([
    message({ labels: ["CATEGORY_PROMOTIONS"], unread: true }),
    message({ sender: { name: "News", address: "noreply@newsletter.test" }, unread: true }),
    message({ unread: true, subject: "Keep me" }),
  ], filters);

  assertEquals(result.signal.length, 1);
  assertEquals(result.signal[0].subject, "Keep me");
  assertEquals(result.dropped.category, 1);
  assertEquals(result.dropped.sender, 1);
});

Deno.test("selectMail keeps read mail only when the subject needs a decision", () => {
  const result = selectMail([
    message({ subject: "Your invoice is ready" }),
    message({ subject: "Weekly digest", important: true }),
  ], filters);

  assertEquals(result.signal.length, 1);
  assertEquals(result.signal[0].reason, "needs-decision");
  assertEquals(result.dropped.noSignal, 1);
});

Deno.test("selectMail collapses repeats and counts them", () => {
  const result = selectMail([
    message({ subject: "Security alert" }),
    message({ subject: "Security alert" }),
    message({ subject: "Security alert", unread: true }),
  ], filters);

  assertEquals(result.signal.length, 1);
  assertEquals(result.signal[0].duplicates, 3);
  assertEquals(result.signal[0].reason, "unread");
  assertEquals(result.dropped.duplicate, 2);
});

Deno.test("selectMail ranks decisions above unread newsletters", () => {
  const result = selectMail([
    message({ subject: "Just a heads up", unread: true }),
    message({ subject: "Your payment failed" }),
  ], filters);

  assertEquals(result.signal.map((entry) => entry.reason), ["needs-decision", "unread"]);
});

Deno.test("partitionTodos removes configured titles", () => {
  const result = partitionTodos([
    { target: { title: "2026-08-26 - Community contributions report" } },
    { target: { title: "Review requested" } },
  ], filters);

  assertEquals(result.kept.length, 1);
  assertEquals(result.ignored, 1);
});

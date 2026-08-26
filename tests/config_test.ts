import { assertEquals, assertRejects } from "@std/assert";
import { loadConfig, parseDuration } from "../src/config.ts";

Deno.test("parseDuration supports minutes, hours, and days", () => {
  assertEquals(parseDuration("30m", "test"), 1_800_000);
  assertEquals(parseDuration("24h", "test"), 86_400_000);
  assertEquals(parseDuration("2d", "test"), 172_800_000);
});

Deno.test("loadConfig validates and normalizes a minimal config", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/config.yml`;
  await Deno.writeTextFile(
    path,
    `
schema_version: 1
brief:
  timezone: UTC
state:
  database: state.db
`,
  );
  const config = await loadConfig(path);
  assertEquals(config.brief.timezone, "UTC");
  assertEquals(config.brief.mailLookbackMs, 86_400_000);
  assertEquals(config.state.database, `${directory}/state.db`);
});

Deno.test("loadConfig rejects unknown keys", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/config.yml`;
  await Deno.writeTextFile(
    path,
    `
schema_version: 1
brief:
  timezone: UTC
  surprise: true
`,
  );
  await assertRejects(() => loadConfig(path), Error, "unknown keys");
});

Deno.test("loadConfig requires a valid Google account address", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/config.yml`;
  await Deno.writeTextFile(
    path,
    `
schema_version: 1
brief:
  timezone: UTC
google:
  accounts:
    - id: 1
      address: not-an-email
      config_dir: ./google
`,
  );
  await assertRejects(() => loadConfig(path), Error, "invalid Google account address");
});

Deno.test("loadConfig requires positive numeric Google account IDs", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/config.yml`;
  await Deno.writeTextFile(
    path,
    `
schema_version: 1
brief:
  timezone: UTC
google:
  accounts:
    - id: primary
      address: primary@example.com
      config_dir: ./google
`,
  );
  await assertRejects(() => loadConfig(path), Error, "must be a positive integer");
});

Deno.test("loadConfig enforces provider item limits", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/config.yml`;
  await Deno.writeTextFile(
    path,
    `
schema_version: 1
brief:
  timezone: UTC
github:
  max_items: 101
`,
  );
  await assertRejects(() => loadConfig(path), Error, "between 1 and 100");
});

Deno.test("loadConfig defaults mail filters and leaves todo filters empty", async () => {
  const path = await Deno.makeTempFile({ suffix: ".yml" });
  await Deno.writeTextFile(
    path,
    `schema_version: 1\nbrief:\n  timezone: America/Toronto\n  mail_lookback: 24h\n  calendar_lookahead: 48h\n`,
  );
  const config = await loadConfig(path);
  assertEquals(config.filters.mailIgnoreCategories, ["promotions", "social"]);
  assertEquals(config.filters.todoIgnoreTitles, []);
  await Deno.remove(path);
});

Deno.test("loadConfig lowercases filter entries and parses the gitlab recap", async () => {
  const path = await Deno.makeTempFile({ suffix: ".yml" });
  await Deno.writeTextFile(
    path,
    `schema_version: 1\nbrief:\n  timezone: America/Toronto\n  mail_lookback: 24h\n  calendar_lookahead: 48h\nfilters:\n  todo_ignore_titles:\n    - Community Contributions Report\ngitlab:\n  enabled: true\n  projects:\n    - group/project\n  recap: 7d\n`,
  );
  const config = await loadConfig(path);
  assertEquals(config.filters.todoIgnoreTitles, ["community contributions report"]);
  assertEquals(config.gitlab?.recapMs, 604_800_000);
  await Deno.remove(path);
});

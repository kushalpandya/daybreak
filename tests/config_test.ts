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

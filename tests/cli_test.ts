import { assertEquals, assertThrows } from "@std/assert";
import { parseCli } from "../src/cli.ts";

Deno.test("parseCli defaults to config.yml", () => {
  assertEquals(parseCli(["fetch"]).config, "config.yml");
});

Deno.test("parseCli accepts an explicit config path", () => {
  assertEquals(parseCli(["fetch", "--config", "other.yml"]).config, "other.yml");
});

Deno.test("parseCli defaults to the full json format", () => {
  assertEquals(parseCli(["fetch"]).format, "json");
});

Deno.test("parseCli accepts the agent format", () => {
  assertEquals(parseCli(["fetch", "--format", "agent"]).format, "agent");
});

Deno.test("parseCli rejects an unknown format", () => {
  assertThrows(
    () => parseCli(["fetch", "--format", "yaml"]),
    Error,
    "unknown format: yaml",
  );
});

Deno.test("parseCli defaults and validates the agent item cap", () => {
  assertEquals(parseCli(["fetch"]).maxItems, 15);
  assertEquals(parseCli(["fetch", "--max-items", "6"]).maxItems, 6);
  assertThrows(
    () => parseCli(["fetch", "--max-items", "0"]),
    Error,
    "--max-items must be an integer between 1 and 100",
  );
});

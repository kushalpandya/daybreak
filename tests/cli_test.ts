import { assertEquals } from "@std/assert";
import { parseCli } from "../src/cli.ts";

Deno.test("parseCli defaults to config.yml", () => {
  assertEquals(parseCli(["fetch"]).config, "config.yml");
});

Deno.test("parseCli accepts an explicit config path", () => {
  assertEquals(parseCli(["fetch", "--config", "other.yml"]).config, "other.yml");
});

import { assertEquals } from "@std/assert";
import { StateDatabase } from "../src/state/database.ts";

Deno.test("StateDatabase returns the latest snapshot at or before a boundary", async () => {
  const directory = await Deno.makeTempDir();
  const database = new StateDatabase(`${directory}/state.db`);
  database.saveSnapshot({
    repository: "owner/repo",
    stars: 10,
    releaseDownloads: 20,
    recordedAt: "2026-08-23T00:00:00Z",
  });
  database.saveSnapshot({
    repository: "owner/repo",
    stars: 12,
    releaseDownloads: 24,
    recordedAt: "2026-08-24T00:00:00Z",
  });
  database.saveSnapshot({
    repository: "owner/repo",
    stars: 14,
    releaseDownloads: 28,
    recordedAt: "2026-08-25T00:00:00Z",
  });
  const previous = database.previousSnapshot("owner/repo", "2026-08-24T12:00:00Z");
  assertEquals(previous?.stars, 12);
  assertEquals(previous?.releaseDownloads, 24);
  database.close();
});

Deno.test("StateDatabase supports in-memory databases", () => {
  const database = new StateDatabase(":memory:");
  assertEquals(database.previousSnapshot("owner/repo", "2026-08-25T00:00:00Z"), null);
  database.close();
});

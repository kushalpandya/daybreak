import { assertEquals } from "@std/assert";
import { mapSettledConcurrent } from "../src/utils.ts";

Deno.test("mapSettledConcurrent preserves independent failures", async () => {
  const results = await mapSettledConcurrent([1, 2, 3], 2, (value) => {
    if (value === 2) return Promise.reject(new Error("failed"));
    return Promise.resolve(value * 2);
  });

  assertEquals(results[0], { status: "fulfilled", value: 2 });
  assertEquals(results[1].status, "rejected");
  assertEquals(results[2], { status: "fulfilled", value: 6 });
});

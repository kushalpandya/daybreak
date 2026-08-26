import { assertEquals } from "@std/assert";
import { splitTelegramMessage } from "../src/delivery/telegram.ts";

Deno.test("splitTelegramMessage preserves content within Telegram limits", () => {
  const text = `${"a".repeat(2500)}\n\n${"b".repeat(2500)}`;
  const chunks = splitTelegramMessage(text, 3000);
  assertEquals(chunks.length, 2);
  assertEquals(chunks[0], "a".repeat(2500));
  assertEquals(chunks[1], "b".repeat(2500));
});

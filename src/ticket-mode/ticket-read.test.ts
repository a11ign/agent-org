// no-token: gh -- pure functions over text; nothing is read or spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { descriptionHash, sameDescription, ticketReadOf } from "./ticket-read.ts";

test("a description hashes to the same value whatever line ends or trailing whitespace the tracker stores it with, and a changed word hashes differently", () => {
  const plain = descriptionHash("Plan this.\n\nDone-when: it works.");
  assert.match(plain, /^[0-9a-f]{64}$/);
  assert.equal(descriptionHash("Plan this.\r\n\r\nDone-when: it works.\r\n"), plain, "\\r\\n and a trailing newline are not an edit");
  assert.equal(descriptionHash("Plan this.\n\nDone-when: it works.   \n\n"), plain, "trailing whitespace is not an edit");
  assert.notEqual(descriptionHash("Plan this.\n\nDone-when: it fails."), plain);
});

test("a ticket read records the description, its hash, when the tracker last changed the ticket and when the board read it", () => {
  const read = ticketReadOf({ description: "Plan this.", updatedAt: "2026-10-21T09:30:00.000Z" }, 1000);
  assert.deepEqual(read, { updatedAt: "2026-10-21T09:30:00.000Z", hash: descriptionHash("Plan this."), description: "Plan this.", readAt: 1000 });
  assert.equal(ticketReadOf({ description: "x" }, 1).updatedAt, null, "a tracker that does not say when the ticket changed gives none");
});

test("two reads hold the same description when their hashes agree, whatever time the tracker gives the ticket", () => {
  const a = ticketReadOf({ description: "Same.", updatedAt: "2026-10-21T09:00:00.000Z" }, 1);
  const b = ticketReadOf({ description: "Same.", updatedAt: "2026-10-21T10:00:00.000Z" }, 2);
  assert.equal(sameDescription(a, b), true, "a state move that moved updatedAt is not a change");
  assert.equal(sameDescription(a, ticketReadOf({ description: "Other." }, 3)), false);
});

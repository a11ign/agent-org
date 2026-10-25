// no-token: none -- the pure rule of when a wait ends
// A11-272: the card's "until 16:30" and the board's wake read one rule
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_WAIT_MS, deadlineOf } from "./wait-deadline.ts";
import { deadlineOf as woken, BACKGROUND_WAIT_MS as wokenAfter } from "../wait-on/wait-note.ts";

const AT = Date.UTC(2026, 9, 25, 10, 0);

test("A11-272: a wait ends at the `until` its outcome gave, else three hours after the outcome", () => {
  assert.equal(BACKGROUND_WAIT_MS, 3 * 60 * 60_000);
  assert.equal(deadlineOf({ at: AT }), AT + BACKGROUND_WAIT_MS);
  assert.equal(deadlineOf({ at: AT, until: AT + 5 * 60_000 }), AT + 5 * 60_000);
});

test("A11-272: the board's wake reads the very same rule", () => {
  assert.equal(woken, deadlineOf);
  assert.equal(wokenAfter, BACKGROUND_WAIT_MS);
});

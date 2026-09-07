/**
 * TAKING A HOLD MUST NOT SUCCEED SILENTLY OVER SOMEBODY ELSE'S (#266).
 *
 * `gh pr edit --add-label` is idempotent, so taking a PR another session holds succeeds and prints the
 * same nothing as taking a free one. That is this repo's most-recorded shape — an operation whose
 * success says nothing about what it did — so the decision is a pure function with three distinct
 * outcomes, and the two that matter cannot be produced on demand against a live API.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { holdDecision } from "../../../../scripts/pr-hold.mjs";

test("an unheld PR is taken, and says it was unheld", () => {
  const d = holdDecision({ holders: [], session: "worker-capture", steal: false });
  assert.equal(d.act, true);
  assert.equal(d.code, 0);
  assert.match(d.message, /unheld/);
});

test("a PR you already hold is a NO-OP, not a second take", () => {
  // Re-running `pr:hold` on your own PR is what a loop does on every pass. It must be free and silent
  // rather than an error, or the command gets dropped from the loop that most needs it.
  const d = holdDecision({ holders: ["worker-capture"], session: "worker-capture", steal: false });
  assert.equal(d.act, false);
  assert.equal(d.code, 0, "already holding it is success, not refusal");
  assert.match(d.message, /already hold it/);
});

test("a PR somebody else holds is REFUSED, and the holder is named", () => {
  const d = holdDecision({ holders: ["dispatcher"], session: "worker-capture", steal: false });
  assert.equal(d.act, false);
  assert.equal(d.code, 1);
  assert.match(d.message, /dispatcher holds it/,
    "'refused' and 'refused, dispatcher holds it' are different instructions");
  assert.match(d.message, /--steal/, "and it must name the way through, or it reads as a dead end");
});

test("--steal acts, and SAYS WHOSE hold it took — the whole point of not being silent", () => {
  const d = holdDecision({ holders: ["dispatcher"], session: "worker-capture", steal: true });
  assert.equal(d.act, true);
  assert.match(d.message, /STEALING from dispatcher/,
    "a bypass that does not name who it displaced is a bypass nobody can audit");
});

test("a PR held by me AND somebody else is still a collision", () => {
  // The state after a botched hand-over. Reading it as 'I hold it' would be the reassuring answer and
  // the wrong one -- two holders is exactly the condition this row exists to make visible.
  const d = holdDecision({ holders: ["worker-capture", "dispatcher"], session: "worker-capture", steal: false });
  assert.equal(d.act, false);
  assert.equal(d.code, 1);
  assert.match(d.message, /dispatcher/);
});

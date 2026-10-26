// no-token: none -- pure text
// module: whether a worker's reply disputes a decision, which only the planner can change (A11-290)
import { test } from "node:test";
import assert from "node:assert/strict";
import { DISPUTE_PHRASES, disputedDecision } from "./standoff-dispute.ts";

const PLAN = "## Key decisions\n\n- The pages poll a list of what they draw, and a run is read in full on demand.\n- The bundle stays under 200 KB.\n";
const TICKET = "## Decisions (the chairman's session, 2026-10-26)\n\n* This ticket is the missing branch of A11-257's design, not a reversal of it.\n";

test("A11-290: a reply that starts a line with one of the two phrases disputes a decision, in any case and with markdown around it", () => {
  for (const phrase of DISPUTE_PHRASES) {
    assert.equal(disputedDecision([`Measured it.\n\n${phrase} the limit is below the entry point.`], [PLAN]), `${phrase} the limit is below the entry point.`);
    assert.notEqual(disputedDecision([`> **${phrase.toUpperCase()}** the limit.`], []), null);
  }
});

test("A11-290: a reply that quotes a line of the plan's decisions or the ticket's disputes it, however the markdown and the spacing differ", () => {
  assert.notEqual(disputedDecision(["The plan says: the bundle stays under 200 KB. Mine is 340 KB."], [PLAN, TICKET]), null);
  assert.notEqual(disputedDecision(["> This ticket is   the missing branch of A11-257's design, not a reversal of it. I read that as..."], [PLAN, TICKET]), null);
});

test("A11-290: a reply about the code or the evidence, a quote too short to be a decision, and no decisions at all dispute none", () => {
  assert.equal(disputedDecision(["Fixed in the description: the measurement is redone, 340 KB."], [PLAN, TICKET]), null);
  assert.equal(disputedDecision(["The bundle stays under"], [PLAN]), null, "a few words of a decision are in any text");
  assert.equal(disputedDecision(["The bundle stays under 200 KB."], []), null, "no decisions were given to compare with");
  assert.equal(disputedDecision([], [PLAN]), null);
  assert.equal(disputedDecision(["ok"], [null, undefined]), null);
});

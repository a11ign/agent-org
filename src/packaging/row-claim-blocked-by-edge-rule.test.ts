/**
 * RULE: DOES THE ROW BEING CLAIMED CARRY ITS OWN OPEN `blockedBy` EDGE? -- #1886. See
 * `packages/agent-org/src/row-claim/blocked-by-edge-rule.mjs` for the full account: `row-claim.ts` never
 * imported `waiting-condition.ts` at all, so a row the gate correctly shelves (an open `blockedBy` edge)
 * could still be claimed directly by anyone who found it by label instead of through the gate -- #1852
 * carried an open `blockedBy` on #1878/#1883 while mislabelled `ready`, and neither B2 nor B4 has anything
 * to say about it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blockedByEdgeReason, lookupBlockedByEdge,
} from "../row-claim/blocked-by-edge-rule.ts";

// --- blockedByEdgeReason: THE VERDICT, PURE ---

test("#1886's own acceptance shape: an open blockedBy edge refuses, naming the blocking issue(s)", () => {
  const row = { blockedBy: { nodes: [{ number: 1878, state: "OPEN" }, { number: 1883, state: "OPEN" }] } };
  const reason = blockedByEdgeReason(row);
  assert.ok(reason);
  assert.match(reason as string, /#1878/);
  assert.match(reason as string, /#1883/);
});

test("a CLOSED blockedBy edge is a wait that has cleared -- proceeds silently", () => {
  const row = { blockedBy: { nodes: [{ number: 1878, state: "CLOSED" }] } };
  assert.equal(blockedByEdgeReason(row), null);
});

test("no blockedBy edge at all is the common case -- proceeds silently", () => {
  assert.equal(blockedByEdgeReason({}), null);
  assert.equal(blockedByEdgeReason({ blockedBy: { nodes: [] } }), null);
});

test("a `Not-before:` date wait is NOT this rule's concern -- only the row kind refuses here", () => {
  const row = { body: "## Not-before: 2099-01-01", blockedBy: { nodes: [] } };
  assert.equal(blockedByEdgeReason(row), null,
    "a date-only wait is a different mechanism than this row's Region names; not this check's job");
});

test("a failed lookup fails OPEN, never blocking a claim on a network error", () => {
  assert.equal(blockedByEdgeReason(null), null,
    "matches B2/B4: this protects the session's ability to claim ANYTHING, not a verdict about evidence");
});

// --- lookupBlockedByEdge: the network read ---

test("lookupBlockedByEdge asks gh for exactly this row's blockedBy", () => {
  let askedArgs: string[] = [];
  const run = (args: string[]) => {
    askedArgs = args;
    return JSON.stringify({ blockedBy: { nodes: [{ number: 5, state: "OPEN" }] } });
  };
  const result = lookupBlockedByEdge(1852, { run });
  assert.deepEqual(result, { blockedBy: { nodes: [{ number: 5, state: "OPEN" }] } });
  assert.deepEqual(askedArgs.slice(0, 3), ["issue", "view", "1852"]);
  assert.ok(askedArgs.includes("blockedBy"));
});

test("lookupBlockedByEdge returns null, not a throw, on a failed gh call", () => {
  const run = (): string => { throw new Error("gh: rate limited"); };
  assert.equal(lookupBlockedByEdge(1852, { run }), null);
});

// no-token: none -- pure text
import { test } from "node:test";
import assert from "node:assert/strict";
import { decisionsOf, unsupportedClaims } from "./ticket-decisions.ts";

/** A ticket as A11-203 wrote its decision: one line in the Problem, marked as the chairman's. */
const A11_203 = [
  "## Problem",
  "",
  "The token policy must reach the second repository.",
  "",
  "This step widens the policy's permissions by the chairman's decision on 2026-10-24.",
  "",
  "## Done-when",
  "",
  "- the policy is applied",
].join("\n");

test("A11-213: a line that marks itself as the chairman's decision is read, with nothing around it", () => {
  assert.equal(decisionsOf(A11_203), "This step widens the policy's permissions by the chairman's decision on 2026-10-24.");
});

test("A11-213: the other forms of the marker are read, in any case, and a typographic apostrophe is one", () => {
  const description = ["The chairman decided to keep the old name.", "Settled: DECIDED BY THE CHAIRMAN, 2026-10-24.", "The CHAIRMAN’S DECISION is to widen it."].join("\n\n");
  assert.equal(decisionsOf(description), ["The chairman decided to keep the old name.", "Settled: DECIDED BY THE CHAIRMAN, 2026-10-24.", "The CHAIRMAN’S DECISION is to widen it."].join("\n\n"));
});

test("A11-213: a `## Decisions` section is read whole, up to the next heading of its own level, and a heading below it stays in it", () => {
  const description = "## Problem\n\nA problem.\n\n## Decisions\n\n- The policy widens.\n\n### Why\n\nThe chairman wants it.\n\n## Done-when\n\n- a test";
  assert.equal(decisionsOf(description), "## Decisions\n\n- The policy widens.\n\n### Why\n\nThe chairman wants it.");
});

test("A11-213: a `## Behaviour` section is read, and so is a level-three or level-four one, to the next heading of its level or a higher one", () => {
  assert.equal(decisionsOf("## Behaviour\n\nA failed read shows the banner.\n\n## Out of scope\n\n- nothing"), "## Behaviour\n\nA failed read shows the banner.");
  assert.equal(decisionsOf("## Plan\n\n### Decisions\n\n- one\n\n#### Detail\n\n- two\n\n### Next\n\n- three"), "### Decisions\n\n- one\n\n#### Detail\n\n- two");
  assert.equal(decisionsOf("# Title\n\n#### Behaviour\n\n- one\n\n### Next\n\n- two"), "#### Behaviour\n\n- one");
  assert.equal(decisionsOf("## Behavior\n\n- the American spelling is a heading too"), "## Behavior\n\n- the American spelling is a heading too");
});

test("A11-213: a section runs to the end of the description when no heading follows it", () => {
  assert.equal(decisionsOf("## Decisions\n\n- the last thing the ticket says\n"), "## Decisions\n\n- the last thing the ticket says");
});

test("A11-213: a chairman's-decision line inside a Decisions section, or a section and a line, come once each and in the ticket's order", () => {
  const description = "Widened by the chairman's decision.\n\n## Decisions\n\n- Also by the chairman's decision on the name.\n\n## Done-when\n\n- done";
  assert.equal(decisionsOf(description), "Widened by the chairman's decision.\n\n## Decisions\n\n- Also by the chairman's decision on the name.");
  assert.equal(decisionsOf("Same by the chairman's decision.\n\nSame by the chairman's decision."), "Same by the chairman's decision.");
});

test("A11-213: a fenced example is not read, whether it holds a heading or a marked line, and a fence inside a section does not end it", () => {
  const fenced = "## Notes\n\n```md\n## Decisions\n\n- an example\n\nBy the chairman's decision.\n```\n\n~~~\nthe chairman decided\n~~~";
  assert.equal(decisionsOf(fenced), null);
  const inside = "## Decisions\n\n```md\n## Not a heading\n```\n\n- the line after the fence\n\n## Done-when";
  assert.equal(decisionsOf(inside), "## Decisions\n\n```md\n## Not a heading\n```\n\n- the line after the fence");
});

test("A11-213: nothing looser is read: a mention of the chairman, a heading that only contains the word, and a deeper or shallower heading are not decisions", () => {
  assert.equal(decisionsOf("Why (the chairman, 2026-10-24): it is slow.\n\nThe chairman asked for a report."), null);
  assert.equal(decisionsOf("## Key decisions\n\n- one\n\n## Misbehaviour\n\n- two"), null);
  assert.equal(decisionsOf("# Decisions\n\n- level one\n\n##### Behaviour\n\n- level five"), null);
});

test("A11-213: an empty, missing or decision-free description has none", () => {
  for (const description of [undefined, null, "", "## Problem\n\nA problem.\n\n## Done-when\n\n- a test"]) assert.equal(decisionsOf(description), null);
});

const TICKET = "https://linear.app/a11ign/issue/A11-248/round-cap-wording";

test("A11-250: a reply that says a person decided, with no link to the ticket, is an unsupported claim; the same reply linking the ticket is not", () => {
  const bare = "decided by the chairman, no change";
  assert.deepEqual(unsupportedClaims([bare], TICKET), [bare]);
  assert.deepEqual(unsupportedClaims([`decided by the chairman, no change: ${TICKET}`], TICKET), [], "the ticket's address, slug and all");
  assert.deepEqual(unsupportedClaims(["decided by the chairman, no change: https://linear.app/a11ign/issue/A11-248"], TICKET), [], "or the address without its slug");
  assert.deepEqual(unsupportedClaims(["decided by the chairman: https://linear.app/a11ign/issue/A11-249/other"], TICKET), ["decided by the chairman: https://linear.app/a11ign/issue/A11-249/other"], "another ticket's link supports nothing");
});

test("A11-250: each way of wording a person's decision is a claim, and a reply that claims none is left alone", () => {
  const claims = ["The chairman said keep it.", "Per the chairman, no change.", "The chairman decided on 2026-10-25.", "This is the chairman's decision.", "Decided by Dan, keep it.", "The chairman answered in the terminal."];
  const ordinary = ["The finding is answered by the new guard in foo.ts.", "Already decided by ADR-12.", "The decision table is in the ADR."];
  assert.deepEqual(unsupportedClaims(claims, TICKET), claims);
  assert.deepEqual(unsupportedClaims(["Fixed in the description.", ...ordinary], TICKET), [], "a sentence that merely says something was answered or decided by a thing is no claim");
});

test("A11-250: a ticket with no address (an empty one) supports nothing, as a ticket with no decisions does", () => {
  assert.deepEqual(unsupportedClaims(["decided by the chairman"], ""), ["decided by the chairman"]);
});

test("A11-250: a ticket that records no decision (ticketUrl null) leaves every claim unsupported, link or not", () => {
  assert.deepEqual(unsupportedClaims([`decided by the chairman ${TICKET}`], null), [`decided by the chairman ${TICKET}`]);
});

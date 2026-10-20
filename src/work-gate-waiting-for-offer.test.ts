// no-token: gh -- `partitionUnclaimed` and `decide` are pure: the wait facts are handed in, and no read is made
/**
 * #1075: A READY ROW WHOSE BODY `Waiting-for:` IS NOT YET TRUE IS SHELVED, NOT OFFERED. The shelving reason names the line.
 *
 * EVERY "NOT OFFERED" ASSERTION HAS A CONTROL THAT DIFFERS IN THE ONE THING THAT OFFERS IT (the condition now true, or the wait unknown), so a gate that
 * offered everything, or nothing, satisfies half of them and fails the other half. An unknown wait and absent facts are OFFERED: a failed read never shelves a row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./work-gate/tick/tick-decisions-and-flags.ts";
import { partitionUnclaimed } from "./work-gate/causes/rows-claims.ts";
import type { RefFact, WaitFacts } from "./wait-condition.ts";

const REF = "a11ign/agent-org#41";
const fact = (state: RefFact["state"]): RefFact => ({ state, labels: [], resolvedAt: null, changedAt: null });
/** The facts for `REF` alone, in the state the test names: what the gate read off the tracker. */
const factsOf = (state: RefFact["state"]): WaitFacts => ({ items: { [REF]: fact(state) } });

/** A Ready row whose body declares `line` after `Waiting-for:`, the way an author writes it. */
function waiting(number: number, line: string) {
  const body = `## Region\n\n\`\`\`\npackages/guards/src/row-${number}.ts\n\`\`\`\n\n## Acceptance\n\nA command.\n\n## Open-check\n\nA check.\n\nWaiting-for: ${line}\n`;
  return { number, title: `row ${number}`, labels: [{ name: "ready" }], body };
}

/** The numbers `partitionUnclaimed` offers and the reasons it shelves, for one set of ready rows. */
function split(readyRows: ReturnType<typeof waiting>[], waitFacts: WaitFacts | null | undefined) {
  const { offerable, blocked } = partitionUnclaimed(readyRows, [], { waitFacts });
  return { offered: offerable.map((row) => Number(row.number)), blocked };
}

test("a row whose `merged` wait is still open is shelved, and the reason names the line", () => {
  const { offered, blocked } = split([waiting(50, `merged ${REF}`)], factsOf("open"));
  assert.deepEqual(offered, []);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].number, 50);
  assert.match(blocked[0].reason, /Waiting-for: merged a11ign\/agent-org#41 is not true yet/);
});

test("the same row is offered once the `merged` wait is true (control)", () => {
  const { offered, blocked } = split([waiting(50, `merged ${REF}`)], factsOf("merged"));
  assert.deepEqual(offered, [50]);
  assert.deepEqual(blocked, []);
});

test("a `closed` wait is shelved while the reference is open, and offered once it is closed", () => {
  assert.deepEqual(split([waiting(51, `closed ${REF}`)], factsOf("open")).offered, []);
  assert.deepEqual(split([waiting(51, `closed ${REF}`)], factsOf("closed")).offered, [51]);
});

test("a wait that is unknown is offered, and so is a row whose facts were not read at all", () => {
  // `soon` is not in the grammar, so the wait is unreadable: `conditionHolds` says unknown
  assert.deepEqual(split([waiting(52, "soon")], factsOf("open")).offered, [52]);
  // the reference is neither held nor read: left out of the facts, so unknown
  assert.deepEqual(split([waiting(53, `merged ${REF}`)], { items: {} }).offered, [53]);
  // the facts themselves are absent
  assert.deepEqual(split([waiting(54, `merged ${REF}`)], null).offered, [54]);
  assert.deepEqual(split([waiting(55, `merged ${REF}`)], undefined).offered, [55]);
});

test("the gate shelves the row on the same reading: `decide` offers nothing for it, and offers its control", () => {
  const rowOffers = (readyRows: ReturnType<typeof waiting>[], waitFacts: WaitFacts) =>
    decide({ prs: [], readyRows, waitFacts, shareLog: () => {} }).filter((o) => o.cause === "ready-row-unclaimed").map((o) => o.subject);
  assert.deepEqual(rowOffers([waiting(60, `merged ${REF}`)], factsOf("open")), []);
  assert.equal(rowOffers([waiting(61, `merged ${REF}`)], factsOf("merged")).length, 1);
});

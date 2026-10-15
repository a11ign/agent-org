// The leaf's own cases, one per shape the take must read: the 2026-10-13 shape named exactly, the target waiting on the held pull request, the `closed <row>` link the held pull request
// closes, and the non-cycles that must NOT be named (a third row, a self-reference, a bare `#n` in another repository, a release fact). The take-level refusal is in `pr-hold.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { holdCycleOf, holdCycleText, refKey } from "./hold-cycle.ts";
import type { CycleParty } from "./hold-cycle.ts";
import { parseWaits } from "./wait-condition.ts";

const REPO = "a11ign/agent-org";
const HELD = `${REPO}#1365`;
const TARGET = `${REPO}#1325`;
const PR = `${REPO}#1378`;

/** A party whose declared waits are the `Waiting-for:` lines given, read by the same parser the take uses. */
const party = (key: string, waits: string[] = [], closes: string[] = [], home = REPO): CycleParty =>
  ({ key, home, waits: waits.flatMap((text) => parseWaits(`Waiting-for: ${text}`)), closes });
const held = (closes: string[] = []) => party(HELD, [], closes);

test("the 2026-10-13 shape: the held #1365 waits `closed #1325`, and #1325's open pull request #1378 waits `merged #1365`: the cycle is named, held first and last", () => {
  const path = holdCycleOf(held(), party(TARGET), [party(PR, ["merged #1365"])]);
  assert.deepEqual(path, [HELD, TARGET, PR, HELD]);
  assert.equal(holdCycleText(path!), `${HELD}, which waits on ${TARGET}, which waits on ${PR}, which waits on ${HELD}`);
});

test("the target row itself waiting `merged` on the held pull request is a cycle with no pull request in it", () => {
  assert.deepEqual(holdCycleOf(held(), party(TARGET, ["merged #1365"]), []), [HELD, TARGET, HELD]);
});

test("a closing pull request that waits `closed <row>` on a row the held pull request closes is the cycle, through that row", () => {
  const closedRow = `${REPO}#1300`;
  const path = holdCycleOf(held([closedRow]), party(TARGET), [party(PR, ["closed #1300"])]);
  assert.deepEqual(path, [HELD, TARGET, PR, closedRow, HELD]);
});

test("a closed row the held pull request does NOT close is not a link: `closed <row>` alone is no cycle", () => {
  assert.equal(holdCycleOf(held(["a11ign/agent-org#1999"]), party(TARGET), [party(PR, ["closed #1300"])]), null);
});

test("NON-CYCLE, the positive control's negative: the target's pull request waits on a third row, and the held pull request is not named", () => {
  assert.equal(holdCycleOf(held(), party(TARGET), [party(PR, ["merged #1300"])]), null);
});

test("a wait that names no item is not an edge: a release fact, a label, and `manual` do not close a cycle, and nor does an unreadable line", () => {
  for (const wait of ["labelled hold:ceo #1365", "published foo@1.0.0", "manual", "soon"]) {
    assert.equal(holdCycleOf(held(), party(TARGET), [party(PR, [wait])]), null, wait);
  }
});

test("the held pull request is never a second party: a pull request that closes the target and waits on the held one is excluded when it is the held one itself", () => {
  assert.equal(holdCycleOf(held(), party(TARGET), [party(HELD, ["merged #1365"])]), null);
});

test("a bare `#n` names the party's own repository: `merged #1365` on a pull request of agent-org is the held one, and of another repository is not", () => {
  assert.deepEqual(holdCycleOf(held(), party(TARGET), [party(PR, ["merged #1365"], [], REPO)]), [HELD, TARGET, PR, HELD]);
  assert.equal(holdCycleOf(held(), party(TARGET), [party(PR, ["merged #1365"], [], "a11ign/a11ign")]), null, "a different repository's #1365 is another pull request");
});

test("keys compare case-insensitively: a repository named `A11ign/Agent-Org` in a wait or a `Closes` line is the same one", () => {
  assert.equal(refKey("A11ign/Agent-Org", 1365, REPO), HELD);
  assert.equal(refKey(null, 7, "A11ign/Agent-Org"), "a11ign/agent-org#7");
  assert.deepEqual(holdCycleOf(held(["a11ign/agent-org#1300"]), party(TARGET), [party(PR, ["closed A11ign/Agent-Org#1300"])]), [HELD, TARGET, PR, `${REPO}#1300`, HELD]);
});

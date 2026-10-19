// no-token: gh -- pure: `withPrOwners`, `ownerOfPr` and `unresolvedOwnerEvents` over in-memory rows and pull requests; nothing here reaches `gh`, `git` or the network
/**
 * agent-org#1271: A TICK WHOSE OPEN ROWS WERE NOT READ RECORDS NO `owner-unresolved` FAILURE.
 *
 * a11ign#928 tripped `owner-unresolved` on a pull request that had been MERGED before the ledger recorded it. An empty open-rows list (the read refused, or
 * nothing read at all) reached the `ceo` rung, and `unresolvedOwnerEvents` filed it as the owner ladder failing, which it did not: a rows read that was
 * refused and a pull request nobody could be named for are different readings, and the ledger treated them as one.
 *
 * THE FIRST CASE IS THE ONE THAT WAS RED ON `main`: an ended-label pull request whose closing row is closed, read with no open rows at all. The second
 * is the same pull request with one unrelated open row read, which resolves `owner-gone` and records nothing. The third is the control that the recorder
 * was not simply turned off: an unlabelled pull request naming no row, with rows read, still records `owner-unresolved`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withPrOwners } from "./work-gate/pr-owners.ts";
import { ownerOfPr } from "./work-gate/pr-orders/red-only-by-superseded-run.ts";
import { unresolvedOwnerEvents } from "./pr-ownership.ts";

const row = (number: number, ...labels: string[]) => ({ number, labels: labels.map((name) => ({ name })) });
/** Open rows the gate read: #4437 is an unrelated open one; #4624 is NOT among them (closed). */
const OPEN = [row(4437, "in-progress", "session:worker-4437")];
/** worker-4437 is live; worker-4624 has ended, so the label on the pull request below is one that names a dead session. */
const IO = { agents: () => ["worker-4437"], ended: () => new Map([["worker-4624", 1]]), say: () => {} };

/** Its label names worker-4624, which ended, and it closes #4624, which is closed: the owner is gone and the rows say so. */
const ENDED_PR = {
  number: 4626, headRefName: "agent/failure-class-owner-unresolved-4624", labels: [{ name: "session:worker-4624" }], closingIssuesReferences: [{ number: 4624 }],
};
/** No label, branch `fix-typo`, no row named: nobody can be named for it from any rows. */
const UNOWNED_PR = { number: 9, headRefName: "fix-typo", labels: [], closingIssuesReferences: [] };

/** The ladder over `prs` with `rows` read, then the events `unresolvedOwnerEvents` records for it, and what it said about the ones it left out. */
function tickFor(prs: unknown[], rows: unknown[]) {
  const said: string[] = [];
  const owned = withPrOwners(prs as never, rows as never, () => null, IO as never);
  const events = unresolvedOwnerEvents(owned, ownerOfPr, "a11ign/agent-org", (line) => said.push(line));
  return { owned, events, said };
}

test("a tick that read no open rows records no owner-unresolved failure for a pull request whose owner ended, and says why", () => {
  const { owned, events, said } = tickFor([ENDED_PR], []);
  assert.equal(ownerOfPr(owned[0]).source, "ceo", "the ladder reached ceo, so the emptiness of the recorder is the flag's doing and not the ladder's");
  assert.deepEqual(events, [], "an unread tick is not an owner-unresolved failure");
  assert.deepEqual(said, ["owner-unresolved: 1 pull request(s) not recorded, the open rows were not read this tick"]);
});

test("the same pull request with one unrelated open row read resolves owner-gone and records nothing", () => {
  const { owned, events, said } = tickFor([ENDED_PR], OPEN);
  assert.equal(ownerOfPr(owned[0]).source, "owner-gone");
  assert.deepEqual(events, []);
  assert.deepEqual(said, [], "nothing was left out, so nothing is said");
});

test("control: an unlabelled pull request naming no row, with rows read, still records owner-unresolved", () => {
  const { owned, events, said } = tickFor([UNOWNED_PR], OPEN);
  assert.equal(ownerOfPr(owned[0]).source, "ceo");
  assert.deepEqual(events, [{ classKey: "owner-unresolved", ref: "a11ign/agent-org#9" }]);
  assert.deepEqual(said, []);
});

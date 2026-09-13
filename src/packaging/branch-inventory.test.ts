/**
 * #623: the four-fact inventory of every branch on `origin` with no open PR and commits `main` lacks.
 *
 * 93 branches carry 291 commits that exist on no other ref, and the transfer on 2026-09-15 rewrites
 * history — so each owner has to decide about their OWN branch, and nobody can do that until the list
 * says whose each one is. **The owner is the fact that nearly was not deliverable**, which is what most
 * of this file is about.
 *
 * PURE, and the separation is the reason: `branch-inventory-report.mjs` spawns git and `gh` and therefore
 * needs a token; this module spawns nothing, so the row's acceptance command runs in a job that has none
 * (#1009). Every fixture here is shaped like the real data and several ARE the real data, quoted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rowNumberFromBranch, sessionFromLabels, sessionFromTimeline, ownerOfBranch, branchFacts,
  reconcile, groupByOwner, renderInventory } from "../../../../scripts/branch-inventory.mjs";

const tip = { sha: "abc1234", at: "2026-09-09T08:35:00Z" };

test("#623: the row number is the TRAILING number, and a name without one says so", () => {
  // Real names from the sweep. `adr-0015-floor-1237` is the case a non-anchored match gets wrong: the
  // first number in it is part of the subject, not a row.
  assert.equal(rowNumberFromBranch("agent/ci-merge-queue-156"), 156);
  assert.equal(rowNumberFromBranch("agent/adr-0015-floor-1237"), 1237);
  assert.equal(rowNumberFromBranch("agent/backlog-banner-93"), 93);
  assert.equal(rowNumberFromBranch("agent/achievement-world-moved"), null);
  assert.equal(rowNumberFromBranch("lead/ci-gate-job"), null,
    "39 of the 93 carry no row number at all -- that is a fact about the branch, not a parse failure");
});

test("#623: a CLOSED row's owner is recovered from the claim history, because closing strips the label", () => {
  // THE REAL #119, quoted from its timeline. Its live labels are [backlog] -- `stripClaimLabels` removes
  // `session:` on close -- and before this the sweep reported 64 of 93 branches as UNKNOWN. The claim is
  // still on the record as a `labeled` event, which no close removes.
  const timeline = [
    { event: "labeled", label: { name: "backlog" } },
    { event: "labeled", label: { name: "ready" } },
    { event: "labeled", label: { name: "in-progress" } },
    { event: "labeled", label: { name: "session:worker-audit" } },
    { event: "unlabeled", label: { name: "ready" } },
    { event: "unlabeled", label: { name: "in-progress" } },
    { event: "unlabeled", label: { name: "session:worker-audit" } },
  ];
  assert.equal(sessionFromLabels(["backlog"]), null, "the live labels cannot answer, which is the premise");
  assert.equal(sessionFromTimeline(timeline), "worker-audit");
});

test("#623: an `unlabeled` event is NOT a disowning, and the LAST claim wins", () => {
  // Reading `unlabeled session:X` as "no owner" would throw away the entire population this exists for,
  // since that is what closing does to every row. And a row can change hands: the most recent claim is
  // the live one, not the first.
  const handedOver = [
    { event: "labeled", label: { name: "session:worker-judge" } },
    { event: "unlabeled", label: { name: "session:worker-judge" } },
    { event: "labeled", label: { name: "session:worker-capture" } },
    { event: "unlabeled", label: { name: "session:worker-capture" } },
  ];
  assert.equal(sessionFromTimeline(handedOver), "worker-capture");
  assert.equal(sessionFromTimeline([{ event: "labeled", label: { name: "ready" } }]), null,
    "a timeline with no session claim at all is null -- absent, never the empty string");
  assert.equal(sessionFromTimeline([]), null);
});

test("#623: the owner's SOURCE is returned beside it, and the precedence is live > history > prefix", () => {
  // Two kinds of claim must not read as one: a `session:` label is a record somebody wrote, a branch
  // prefix is an inference from a naming habit. A list that flattened them would read as 93 attributions
  // when it holds three grades of evidence.
  const claim = [{ event: "labeled", label: { name: "session:worker-judge" } }];
  assert.deepEqual(ownerOfBranch({ branch: "agent/x-1", row: { number: 1, state: "OPEN",
    labels: ["session:worker-capture"] }, timeline: claim }),
  { owner: "worker-capture", source: "row-label" },
  "a LIVE label outranks the history -- the row may have changed hands since");
  assert.deepEqual(ownerOfBranch({ branch: "agent/x-1", row: { number: 1, state: "CLOSED", labels: ["backlog"] },
    timeline: claim }), { owner: "worker-judge", source: "claim-history" });
  assert.deepEqual(ownerOfBranch({ branch: "lead/ci-gate-job", row: null }),
    { owner: "lead (retired role)", source: "retired-role" },
    "a retired role is reported AS retired: it says which role pushed it and names nobody who can answer");
  assert.deepEqual(ownerOfBranch({ branch: "agent/achievement-world-moved", row: null }),
    { owner: null, source: "unknown" });
});

test("#623: rowState separates the three cases a reader would otherwise conflate", () => {
  const facts = (branch: string, row: { number: number, state: string, labels: string[] } | null) =>
    branchFacts({ branch, ahead: 3, lastCommit: tip, row }).rowState;
  assert.equal(facts("agent/x-42", { number: 42, state: "OPEN", labels: [] }), "#42 OPEN");
  assert.equal(facts("agent/x-42", { number: 42, state: "CLOSED", labels: [] }), "#42 CLOSED");
  assert.equal(facts("agent/x-42", null), "#42 does not exist",
    "a number that names no row is a fact about the branch, not a failure of the sweep");
  assert.equal(facts("agent/no-number", null), "no row number in the name");
});

test("#623: UNKNOWN is never omitted and sorts LAST", () => {
  // The row's own acceptance: "a branch whose owner cannot be determined is listed as unknown, never
  // omitted and never guessed: an unattributed branch is exactly the one nobody will claim."
  const facts = [
    branchFacts({ branch: "agent/a", ahead: 1, lastCommit: tip, row: null }),
    branchFacts({ branch: "agent/b-2", ahead: 9, lastCommit: tip, row: { number: 2, state: "OPEN", labels: ["session:worker-capture"] } }),
    branchFacts({ branch: "lead/c", ahead: 2, lastCommit: tip, row: null }),
  ];
  const groups = groupByOwner(facts);
  assert.equal(groups.length, 3);
  assert.match(groups[groups.length - 1][0], /^UNKNOWN/, "unknown last, so it is not buried mid-table");
  assert.deepEqual(groups.map(([, rows]) => rows.length).reduce((a, b) => a + b, 0), facts.length,
    "every branch reaches exactly one group -- a branch dropped by the grouping is one nobody answers for");

  // POSITIVE CONTROL for the assertion above: with no unowned branch there is NO unknown group, so the
  // match is reading the data rather than a header this always emits.
  const owned = groupByOwner([facts[1]]);
  assert.equal(owned.length, 1);
  assert.doesNotMatch(owned[0][0], /^UNKNOWN/);
});

test("#623: the reconciliation is a returned value, not a sentence somebody checks", () => {
  // "The count at the end reconciles with the count at the start, or the difference is explained."
  const start = { candidates: 204, noOpenPR: 202, merged: 109, unmerged: 93 };
  assert.equal(reconcile(start, start).startBalanced, true);
  assert.deepEqual(reconcile(start, start).drift, { candidates: 0, noOpenPR: 0, merged: 0, unmerged: 0 });

  const later = { candidates: 206, noOpenPR: 203, merged: 111, unmerged: 92 };
  const r = reconcile(start, later);
  assert.equal(r.endBalanced, true);
  assert.deepEqual(r.drift, { candidates: 2, noOpenPR: 1, merged: 2, unmerged: -1 },
    "branches land and are created during a sweep; what must not happen is a total that moved quietly");

  assert.equal(reconcile(start, { candidates: 206, noOpenPR: 203, merged: 111, unmerged: 90 }).endBalanced,
    false, "111 + 90 is not 203, and an unbalanced end must say so rather than print a tidy table");
});

test("#623: the rendered table carries all four facts AND the owner's source", () => {
  const out = renderInventory([branchFacts({ branch: "agent/ci-merge-queue-156", ahead: 11,
    lastCommit: { sha: "deadbee", at: "2026-09-02T10:00:00Z" },
    row: { number: 156, state: "CLOSED", labels: ["backlog"] },
    timeline: [{ event: "labeled", label: { name: "session:worker-audit" } }] })]);
  for (const fact of ["agent/ci-merge-queue-156", "11", "deadbee", "2026-09-02T10:00:00Z", "#156 CLOSED",
    "claim-history", "worker-audit"]) {
    assert.ok(out.includes(fact), `the table must carry ${fact} -- a list missing one of the four facts `
      + "sends its reader back to the API for the branch they were meant to decide about");
  }
});

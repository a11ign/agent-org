// no-token: gh
//
// #1278 added `import { inventory }`, which pulls `branch-inventory-report.mjs` into this file's closure
// -- and that file spawns `gh` (`openPrHeads`) and `git`. Nothing here reaches either: every test passes
// `run` injected, and `ownerOfBranch`/`groupByOwner`/`reconcile` are pure.
//
// DRIVEN, not asserted. A `gh` on PATH that exits 1 loudly, then a failing `git` beside it, run against
// the whole suite: 13/0 both times, exit 0 -- with the shim confirmed reachable first, so a silent PATH
// miss could not read as a clean run. A CONSUMER assertion that really spawns must NOT carry this line.

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
import { inventory } from "../../../../scripts/branch-inventory-report.mjs";

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

test("#623: a trailing number that names a PULL REQUEST is not read as a row", () => {
  // THE REAL ONE, from the first sweep: `archive/gate-ages-rebased-137` reported `#137 MERGED` — a state
  // no issue has. GitHub's REST `/issues/<n>` answers for pull requests too, so `gh issue view 137`
  // returned the PR and the tool called it a row. One in 93, and under the disposition rules it decides
  // whether a branch is KEPT, so a PR read as an open row would hold a branch nobody owns.
  const pr = { number: 137, state: "CLOSED", labels: [], isPullRequest: true };
  const facts = branchFacts({ branch: "archive/gate-ages-rebased-137", ahead: 2, lastCommit: tip, row: pr });
  assert.equal(facts.rowState, "#137 is a PULL REQUEST, not a row");
  assert.equal(facts.source, "retired-role",
    "and a PR's labels are not a row claim -- the owner falls through to the prefix, not to the PR");

  // CONTROL: the same shape with `isPullRequest` false is read as a row, so the assertion above is
  // reading that flag rather than the number or the state.
  assert.equal(branchFacts({ branch: "archive/gate-ages-rebased-137", ahead: 2, lastCommit: tip,
    row: { ...pr, isPullRequest: false } }).rowState, "#137 CLOSED");
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
  assert.equal(groups[0][0], "worker-capture",
    "an owner who can ANSWER comes first, whatever the group sizes are");
  assert.deepEqual(groups.map(([, rows]) => rows.length).reduce((a, b) => a + b, 0), facts.length,
    "every branch reaches exactly one group -- a branch dropped by the grouping is one nobody answers for");

  // POSITIVE CONTROL for the assertion above: with no unowned branch there is NO unknown group, so the
  // match is reading the data rather than a header this always emits.
  const owned = groupByOwner([facts[1]]);
  assert.equal(owned.length, 1);
  assert.doesNotMatch(owned[0][0], /^UNKNOWN/);
});

test("#623: a RETIRED role ranks below every owner who can answer, however many branches it has", () => {
  // worker-judge on #1273: keyed on the owner STRING, `lead (retired role)` sorted among the live
  // sessions by size — so 14 branches nobody can answer for came above 9 that somebody can. The rank is
  // the best evidence in the group, and only then the size. THE SIZES HERE ARE DELIBERATELY INVERTED:
  // the retired group is larger, so a size-first ordering fails this and a rank-first ordering passes.
  const tipAt = { sha: "a", at: "2026-09-01T00:00:00Z" };
  const live = branchFacts({ branch: "agent/x-1", ahead: 1, lastCommit: tipAt,
    row: { number: 1, state: "OPEN", labels: ["session:worker-judge"] } });
  const retired = ["lead/a", "lead/b", "lead/c"].map((branch) =>
    branchFacts({ branch, ahead: 5, lastCommit: tipAt, row: null }));
  const unknown = branchFacts({ branch: "agent/no-row", ahead: 9, lastCommit: tipAt, row: null });

  const order = groupByOwner([...retired, unknown, live]).map(([owner]) => owner);
  assert.deepEqual(order, ["worker-judge", "lead (retired role)",
    "UNKNOWN -- nobody is recorded as owning this"],
  "live owner, then retired role, then unknown -- and the retired group is the BIGGEST of the three, "
  + "so this fails under the ordering that shipped");
});

test("#623: the reconciliation is a returned value, not a sentence somebody checks", () => {
  // "The count at the end reconciles with the count at the start, or the difference is explained."
  // NOT A FIXTURE BUILT FROM THE ANSWER (worker-judge's note on #1273): `noOpenPR` is DERIVED from the
  // two buckets here, so the balanced case cannot be balanced by a typo, and the unbalanced case below
  // perturbs one bucket rather than restating a different total.
  const buckets = { merged: 109, unmerged: 93 };
  const start = { candidates: 204, noOpenPR: buckets.merged + buckets.unmerged, ...buckets };
  assert.equal(reconcile(start, start).startBalanced, true);
  assert.equal(reconcile({ ...start, merged: start.merged + 1 }, start).startBalanced, false,
    "one bucket moved and the total did not -- the arithmetic must refuse it, which is the direction "
    + "that catches a bucket silently dropping a member");
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

// --- #1278: the TWO reads are pinned, so a single-read regression cannot pass quietly ----------------
//
// worker-judge's note on #1273, after the verdict: `reconcile` was called with correctly-bracketed
// arguments and nothing asserted there were two reads. Mutating `reconcile(start, end)` to
// `reconcile(end, end)` passed 10/0 — a later "simplify this double fetch" would print
// `reconcile (two reads...): no drift` from a single moment, and #1246 reads that line to decide 94
// dispositions. A caller with no test is one refactor from a function with no caller.

/** A `run` whose branch list GROWS between the two sweeps -- one branch lands mid-inventory. */
let sweeps = 0;
const forEachRefCalls = () => sweeps;
const runWithDriftAfter = (firstCallsBeforeDrift: number) => {
  sweeps = 0;
  let forEachRefCalls = 0;
  return (cmd: string, args: string[]): string => {
    if (cmd === "gh") return "";                       // no open PRs, so every branch is a candidate
    if (args[0] === "for-each-ref") {
      forEachRefCalls += 1;
      sweeps += 1;
      const rows = ["agent/a\taaaaaaa\t2026-09-13T00:00:00Z"];
      if (forEachRefCalls > firstCallsBeforeDrift) rows.push("agent/b\tbbbbbbb\t2026-09-13T00:01:00Z");
      return rows.join("\n");
    }
    if (args[0] === "rev-list") return "3";            // every branch is unmerged, 3 commits
    return "";
  };
};

test("#1278: a branch that lands BETWEEN the two sweeps is reported as drift", () => {
  const { reconciliation, counts } = inventory({ run: runWithDriftAfter(1) as never });
  assert.notDeepEqual(reconciliation.drift, { candidates: 0, noOpenPR: 0, merged: 0, unmerged: 0 },
    "the second sweep saw one more branch, and a single-read report cannot say so");
  assert.equal(reconciliation.drift.candidates, 1);
  assert.equal(reconciliation.drift.unmerged, 1);
  // AND THE TWO READS ARE COUNTED, not inferred from the drift: `inventory` must call `countsNow` twice,
  // once before the sweep and once after. Asserting only the drift would pass a build that read once and
  // fabricated a difference; asserting only the call count would pass one that read twice and ignored the
  // second. The pair is what pins the two-read path.
  // THREE, and the number is read off the call sites rather than off the answer: `countsNow` at the
  // start, the facts sweep in the middle, `countsNow` at the end. I asserted 2 first, from the two reads
  // this row is about, and the middle one is real. Collapsing the two `countsNow` calls to one makes it
  // 2 and fails; so does deleting the facts sweep. Both are regressions worth failing on.
  assert.equal(forEachRefCalls(), 3,
    "`countsNow` at the start, the facts sweep, `countsNow` at the end -- three branch reads");
  // #1288: AND `counts` IS THE SECOND SWEEP'S. `worker-capture` reviewing #1285: the assertions above
  // pin that two reads happen and NOT which one is reported. `counts: end` -> `counts: start` passes
  // both, because `drift` is computed from BOTH snapshots -- so the printed table would silently become
  // the pre-sweep figures while the drift line correctly said something had landed. A report whose body
  // and whose drift line describe different moments, with every test green.
  assert.equal(counts.candidates, 2,
    "the second sweep saw 2 branches and the first saw 1 -- the table reports the second");
});

test("#1278 POSITIVE CONTROL: identical reads report NO drift -- it must stay sayable when true", () => {
  // Without this, a build reporting drift unconditionally passes the test above perfectly, and every
  // quiet sweep would claim the board moved under it.
  const { reconciliation } = inventory({ run: runWithDriftAfter(99) as never });
  assert.deepEqual(reconciliation.drift, { candidates: 0, noOpenPR: 0, merged: 0, unmerged: 0 });
  assert.equal(reconciliation.endBalanced, true);
});

test("#1278: ownerOfBranch tolerates `row: undefined` rather than throwing", () => {
  // `row === null` misses `undefined`, so a caller omitting the field got a TypeError out of a function
  // whose whole job is to answer "unknown" when it cannot tell. Every call site passes `?? null` today,
  // so this is reachable only from a new one -- which is exactly when it would cost most.
  assert.deepEqual(ownerOfBranch({ branch: "agent/x", row: undefined }),
    { owner: null, source: "unknown" });
});

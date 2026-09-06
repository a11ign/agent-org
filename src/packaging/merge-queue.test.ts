/**
 * THE MERGE ROUTINE MUST BE ABLE TO EXPRESS THE RULE IT ENFORCES.
 *
 * 2026-09-06: the dispatcher merged two commits of a FROZEN branch onto `main` by name, while its PR was
 * open and its author was still fixing the six bugs its own first CI run had surfaced. Both rules it broke
 * had been relayed by that same dispatcher within the hour. The loop took BRANCH NAMES, so it could not
 * see a PR, a review state or a check -- and a routine that cannot express a rule will break it however
 * well the rule is known.
 *
 * `refusalFor` is the whole of the judgement, kept pure so it can be driven here. Every case below is a
 * state that has actually occurred in this repository tonight.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { refusalFor } from "../../../../scripts/merge-queue.mjs";

/** @param {object} over */
const pr = (over: object) => ({
  number: 1, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", isDraft: false,
  statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }], ...over,
});

test("a green, conflict-free PR is the only thing that merges", () => {
  assert.equal(refusalFor(pr({})), null);
});

test("NO CHECKS IS NOT GREEN — the state that let a frozen branch through", () => {
  // Before branch protection exists, a PR with no run is indistinguishable from one whose workflow never
  // triggered. Treating "nothing failed" as "everything passed" is this repo's oldest defect.
  const why = refusalFor(pr({ statusCheckRollup: [] }));
  assert.match(String(why), /no checks have run/);
});

test("a still-running check is HELD, and says so rather than reading as failure", () => {
  const why = refusalFor(pr({ statusCheckRollup: [{ name: "ci", conclusion: null }] }));
  assert.match(String(why), /still running/);
});

test("a failing check names WHICH — a count is where an investigation stops", () => {
  const why = refusalFor(pr({ statusCheckRollup: [{ name: "ci / python", conclusion: "FAILURE" }] }));
  assert.match(String(why), /ci \/ python/);
});

test("a conflicting PR is the OWNER's to rebase, and the refusal says so", () => {
  const why = refusalFor(pr({ mergeable: "CONFLICTING" }));
  assert.match(String(why), /OWNER rebases it/);
});

test("UNKNOWN mergeability is not MERGEABLE — asked-and-answered vs not-yet-computed", () => {
  const why = refusalFor(pr({ mergeable: "UNKNOWN" }));
  assert.match(String(why), /has not computed/);
});

test("SKIPPED and NEUTRAL are not failures — a path-filtered job that did not run is fine", () => {
  // The new `ci` workflow is path-scoped, so most PRs legitimately skip most jobs. Reading a skip as a
  // failure would make the queue permanently empty, which is how a guard gets switched off.
  assert.equal(refusalFor(pr({
    statusCheckRollup: [{ name: "ci / lab", conclusion: "SKIPPED" },
      { name: "ci / lint", conclusion: "SUCCESS" }],
  })), null);
});

test("a draft is held, whatever its checks say", () => {
  assert.match(String(refusalFor(pr({ isDraft: true }))), /draft/);
});

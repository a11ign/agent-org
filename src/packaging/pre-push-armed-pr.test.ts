/**
 * #386: pushing to a branch whose PR is armed with auto-merge AND already green races a merge that can
 * complete in the window between the commit and the push. Measured three times in one evening, all by
 * the person who wrote the rule against it -- each time the commit was correct and the push succeeded,
 * and the bot completed the merge before the push finished, leaving the commit stranded on a branch that
 * `branches:stranded` correctly excludes (it is not unmerged) and the tracker has no record of.
 *
 * #442: that guard's premise moved when strict branch protection was restored (02:15Z) -- a merge cannot
 * FIRE while the head is behind `main`, so armed + green + BEHIND is not a race, it is the frozen state
 * this closes (a PR that goes green and then falls behind, which every merge to `main` produces for every
 * OTHER open PR, could neither merge -- blocked for being behind -- nor be synced -- refused by this
 * guard for being green). `behindBy` is the new axis; the other three states are unchanged.
 *
 * `racesAnArmedMerge` is the pure predicate, driven here against every state the acceptance section
 * names: no PR, an unarmed PR, an armed-but-not-green PR, armed + green + up-to-date (must still refuse,
 * #386's real case), armed + green + BEHIND (must now allow, #442), and armed + green + behindBy
 * unknowable (must allow, the fail-open direction one level in). `lookupArmedPrStatus` (the half that asks the code host)
 * is exercised over the fake code host's world, and for its FAIL-OPEN contract -- see its own comment for why `null` must always mean allow.
 *
 * The hook's own bash side (the `A11Y_ALLOW_ARMED_PUSH` override, the refusal message, the exit code), which
 * used to be driven here by extracting the #386 block from the project's `scripts/git-hooks/pre-push`, is the
 * project's script and left this file with #3233.
 */
// no-token: gh
//
// #1408, A11-160 step 5. `lookupArmedPrStatus` is driven over the fake code host's world (a pull request with its check runs, its head and its review decision), and `racesAnArmedMerge` is pure, so nothing in
// this file calls `gh`. The closure walk reaches it through `merge-guard.ts`'s module graph (`lookups.ts`) rather than through anything this file runs. What the code host SENDS for the branch's pull request and
// how it reads the answer (`--head`, the `reviewDecision` field, a missing key) is the plugin's, in `plugins/github/rows/merge-guard-reads.test.ts`.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { racesAnArmedMerge, lookupArmedPrStatus } from "../merge-guard.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import type { FakeRowPull } from "../plugins/fakes/code-host-rows.ts";

afterEach(() => forgetActivation());

test("no PR yet is ALLOWED -- the first push is how a PR gets opened", () => {
  assert.equal(racesAnArmedMerge({ armed: false, green: false }), false);
});

test("an unarmed PR is ALLOWED, whatever its gate says", () => {
  assert.equal(racesAnArmedMerge({ armed: false, green: true }), false);
});

test("an armed PR whose gate is still PENDING is ALLOWED -- pushing before green is the sanctioned route", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: false }), false);
});

test("an armed PR whose gate FAILED is ALLOWED -- fixing it up is exactly what a push here is for", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: false }), false);
});

test("armed, green AND up to date, APPROVED, is the one case that REFUSES -- the window where a merge can land, #386's real case", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: true, behindBy: 0, reviewDecision: "APPROVED" }), true);
});

test("#5526 POSITIVE CONTROL: armed, green AND up to date but CHANGES_REQUESTED is ALLOWED -- a merge cannot complete while "
  + "main requires an approval, so the push is the fix the reviewer asked for", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: true, behindBy: 0, reviewDecision: "CHANGES_REQUESTED" }), false);
});

test("#5526: armed, green AND up to date but REVIEW_REQUIRED is ALLOWED -- the approval has not been given, so no merge can fire", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: true, behindBy: 0, reviewDecision: "REVIEW_REQUIRED" }), false);
});

test("#5526: an EMPTY decision is ALLOWED -- the row refuses only APPROVED, the decision a merge completes on; the empty case is a question for product-manager", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: true, behindBy: 0, reviewDecision: "" }), false);
});

test("#5526: a decision that was never read is ALLOWED -- the fail-open direction, applied to the review axis", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: true, behindBy: 0 }), false);
  assert.equal(racesAnArmedMerge({ armed: true, green: true, behindBy: 0, reviewDecision: null }), false);
});

test("#442 ACCEPTANCE: armed, green and BEHIND is ALLOWED -- under strict protection the merge this "
  + "guards against cannot fire while behind, so there is no race left and the push IS the remedy", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: true, behindBy: 9 }), false);
});

test("MUTATION TARGET (#442): armed, green, behindBy could not be determined (null) is ALLOWED -- "
  + "the fail-open direction applied to the new axis, one level in from the top-level null case below", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: true, behindBy: null }), false);
});

test("armed, green, `behindBy` OMITTED entirely is ALLOWED -- a status shape from before #442 must "
  + "never silently read as up to date", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: true }), false);
});

test("armed but green-ness ITSELF could not be confirmed is ALLOWED -- the fail-open direction, one level in", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: null }), false);
});

test("`null` (could not ask) is ALLOWED -- a convenience guard against a race must fail open, loudly, "
  + "never refuse a push because the network or `gh` failed", () => {
  assert.equal(racesAnArmedMerge(null), false);
});

const HEAD = "abc1234def";
const GREEN_RUN = { id: 1, name: "gate", status: "completed", conclusion: "success", completedAt: "2026-09-13T20:00:30Z" };

/** The fake code host holding one open pull request on `agent/armed`, armed and green unless `over` says otherwise; the branch protection requires `gate`. */
function world(over: Partial<FakeRowPull> | null = {}) {
  const host = createFakeCodeHost();
  const { rowsWorld } = host;
  rowsWorld.requiredContexts = ["gate"];
  if (over !== null) {
    rowsWorld.pulls.set(7, { number: 7, body: "", headRefName: "agent/armed", labels: [], isDraft: false, armed: true, merged: false, mergedAt: null, createdAt: "2026-09-13T19:00:00Z", comments: [],
      headRefOid: HEAD, reviewDecision: "APPROVED", checkRuns: [GREEN_RUN], behindBy: 3, ...over });
  }
  substituteCodeHost(host);
  return rowsWorld;
}

test("lookupArmedPrStatus returns null rather than throwing when the code host cannot answer -- never the live gh -- #1408", () => {
  // #1408: this asked the LIVE `gh` for a head that cannot exist, on every local run. The contract is unchanged: ANY failure inside the lookup is `null`, "could not ask", which `racesAnArmedMerge` allows.
  const w = world();
  w.failures.set("openPullsOfBranch", new Error("gh: could not answer"));
  assert.equal(lookupArmedPrStatus("agent/armed"), null, "a failed lookup is null, never an answer");
  assert.equal(racesAnArmedMerge(lookupArmedPrStatus("agent/armed")), false, "and so the push is allowed");
});

test("#1408: no open PR for the branch is the unarmed shape", () => {
  world(null);
  assert.deepEqual(lookupArmedPrStatus("agent/no-pr-yet"), { number: null, armed: false, green: false, behindBy: null });
});

test("#5526: a pull request whose review decision the code host does not give reads as unknown, so the armed push ALLOWS", () => {
  world({ reviewDecision: undefined, behindBy: 0 });
  const status = lookupArmedPrStatus("agent/armed");
  assert.equal(status?.reviewDecision, null, "an absent decision is no answer");
  assert.equal(racesAnArmedMerge(status), false, "and so the push is allowed, as every unknown is");
});

test("#1408: an ARMED PR whose required checks are green reads its behind-by from the code host -- the comparison is driven, not assumed", () => {
  world();
  const status = lookupArmedPrStatus("agent/armed");
  assert.deepEqual(status, { number: 7, armed: true, green: true, behindBy: 3, reviewDecision: "APPROVED" },
    "armed, green by the real checkReasons over the head's own check runs, behind by what the code host said, and the review decision read off the pull request");
});

test("#1408: an armed PR whose gate has not concluded is armed and not green, so it is not asked how far behind it is", () => {
  const w = world({ checkRuns: [{ ...GREEN_RUN, status: "in_progress", conclusion: null, completedAt: null }] });
  w.failures.set("behindByOf", new Error("behind-by must not be asked of a PR that is not green"));
  assert.deepEqual(lookupArmedPrStatus("agent/armed"), { number: 7, armed: true, green: false, behindBy: null, reviewDecision: "APPROVED" });
});

test("#442: armed, green and up to date is the race the push guard refuses, read end to end from the code host", () => {
  world({ behindBy: 0 });
  assert.equal(racesAnArmedMerge(lookupArmedPrStatus("agent/armed")), true);
});

test("an open PR that is NOT armed is the unarmed shape, whatever its checks say, and is not asked for its checks or its distance from main", () => {
  const w = world({ armed: false });
  w.failures.set("behindByOf", new Error("an unarmed PR is not asked how far behind it is"));
  w.failures.set("checkRunsOfCommit", new Error("an unarmed PR's checks are not read"));
  assert.deepEqual(lookupArmedPrStatus("agent/armed"), { number: 7, armed: false, green: false, behindBy: null });
  assert.equal(racesAnArmedMerge(lookupArmedPrStatus("agent/armed")), false);
});

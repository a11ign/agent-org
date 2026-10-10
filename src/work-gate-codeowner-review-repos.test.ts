// no-token: gh -- pure: `pipelineCodeownerReviewMissing` over in-memory pull requests and `comparablePrFiles`'s output; nothing reaches `gh`, `git` or the network
/**
 * #3720: `pr-codeowner-review-missing` KEYS A PULL REQUEST'S FILES BY REPOSITORY AND NUMBER.
 *
 * The gate matched a PR to its files by number alone, so `lab#3` (one file, `packages/lab/package.json`) was named on the strength of
 * `toolchain#3`, which touches `.github/workflows/release-per-merge.yml`, and `ceo` was ordered to review a dependency bump twice.
 * The reverse is the same defect: a PR that DOES touch an owned path is missed when another repository's PR with its number does not.
 *
 * POSITIVE CONTROL for every "is not named" assertion: the same fixture with ONE thing changed -- the workflow PR on its own -- is
 * named (the first test), so the lists here are never empty by construction. Each ordering of the pair is run, so neither direction
 * can hide behind the order the map was filled in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODEOWNER_REVIEW_APPROVED_ONLY_ENV, comparablePrFiles, pipelineCodeownerReviewMissing } from "./work-gate.ts";

const WORKFLOW = ".github/workflows/release-per-merge.yml";
const DEPENDENCY_BUMP = "packages/lab/package.json";

type Pr = Record<string, unknown>;

/** A pull request as the gate reads it; a sibling repository's carries `repo` and `repoKey`, the tracker's carries neither. */
const pr = (number: number, files: string[], sibling?: { repo: string; repoKey: string }): Pr => ({
  number, files: files.map((path) => ({ path })), changedFiles: files.length,
  author: { login: "a11ign-ai-workers" }, reviews: [], ...sibling,
});

const TOOLCHAIN = { repo: "a11ign/toolchain", repoKey: "toolchain" };
const LAB = { repo: "a11ign/lab", repoKey: "lab" };

/** The pull requests the cause names, as `repoKey#number` (`#number` for the tracker's own). */
const named = (prs: Pr[]) => pipelineCodeownerReviewMissing(prs, comparablePrFiles(prs))
  .map((m: { number: number; repoKey?: string }) => (m.repoKey ? `${m.repoKey}#${m.number}` : `#${m.number}`));

test("the control: a sibling's workflow PR alone is named", () => {
  assert.deepEqual(named([pr(3, [WORKFLOW], TOOLCHAIN)]), ["toolchain#3"]);
});

test("two repositories sharing a number: the one touching no owned path is NOT named", () => {
  const workflow = pr(3, [WORKFLOW], TOOLCHAIN), bump = pr(3, [DEPENDENCY_BUMP], LAB);
  assert.deepEqual(named([workflow, bump]), ["toolchain#3"], "workflow PR first");
  assert.deepEqual(named([bump, workflow]), ["toolchain#3"], "workflow PR second");
});

test("the reverse: a PR that DOES touch an owned path is named whichever order the pair arrives in", () => {
  const bump = pr(3, [DEPENDENCY_BUMP], LAB), workflow = pr(3, [WORKFLOW], TOOLCHAIN);
  // the missed-review direction: with one entry per number, the later PR's files replace the earlier's and the earlier is judged on them
  assert.deepEqual(named([workflow, bump]), ["toolchain#3"]);
  assert.deepEqual(named([bump, workflow]), ["toolchain#3"]);
});

test("a tracker PR (no repoKey) and a sibling's PR with its number stay two entries, in both directions", () => {
  const tracker = pr(3, [WORKFLOW]), sibling = pr(3, [DEPENDENCY_BUMP], LAB);
  assert.deepEqual(named([tracker, sibling]), ["#3"], "the tracker's workflow PR is named, the sibling's bump is not");
  assert.deepEqual(named([sibling, tracker]), ["#3"]);

  const trackerBump = pr(3, [DEPENDENCY_BUMP]), siblingWorkflow = pr(3, [WORKFLOW], TOOLCHAIN);
  assert.deepEqual(named([trackerBump, siblingWorkflow]), ["toolchain#3"], "and the other way round: the sibling's workflow PR is named, the tracker's bump is not");
  assert.deepEqual(named([siblingWorkflow, trackerBump]), ["toolchain#3"]);
});

test("two repositories that BOTH touch an owned path under one number are both named", () => {
  assert.deepEqual(named([pr(3, [WORKFLOW], TOOLCHAIN), pr(3, [WORKFLOW], LAB)]).sort(), ["lab#3", "toolchain#3"]);
});

// --- a11ign/agent-org#483: THE OWNER'S REVIEW OF THE CURRENT HEAD SETTLES THE CAUSE, WHATEVER IT SAID ------------------------------------------
//
// The cause counted `APPROVED` only, so a refusal on the current head left the pull request in the "missing" set and every tick asked the code
// owner for a review it had given (lab#46 woke `ceo` at 11:08Z with the head unchanged and `ceo`'s CHANGES_REQUESTED on it).
//
// POSITIVE CONTROL for every "is not named": the same pull request with NO review from the owner is named (the first case here), so the list is
// never empty by construction; and `onHead` / `onOldHead` differ in the sha alone, so the head comparison is what the pair tests.

const OWNER = "a11ign-ai-leads", HEAD = "9f3c1a7", OLD_HEAD = "41be0d2";

/** A review as `gh pr list --json reviews` carries it: the author, the state, and the sha it was posted against. */
const review = (state: string, oid: string, login = OWNER) => ({ author: { login }, state, commit: { oid } });

/** A workflow pull request at `HEAD` carrying `reviews`. */
const reviewed = (...reviews: unknown[]): Pr => ({ ...pr(46, [WORKFLOW]), headRefOid: HEAD, reviews });

/** `named` with the revert switch set (`on`) or removed, restored after, so no case leaks the variable into the next. */
const namedWithSwitch = (prs: Pr[], on: boolean) => {
  const before = process.env[CODEOWNER_REVIEW_APPROVED_ONLY_ENV];
  if (on) process.env[CODEOWNER_REVIEW_APPROVED_ONLY_ENV] = "1"; else delete process.env[CODEOWNER_REVIEW_APPROVED_ONLY_ENV];
  try { return named(prs); } finally {
    if (before === undefined) delete process.env[CODEOWNER_REVIEW_APPROVED_ONLY_ENV]; else process.env[CODEOWNER_REVIEW_APPROVED_ONLY_ENV] = before;
  }
};

test("#483 control: a pull request with NO review from the owner is named, and so is one reviewed only by someone else", () => {
  assert.deepEqual(namedWithSwitch([reviewed()], false), ["#46"]);
  assert.deepEqual(namedWithSwitch([reviewed(review("APPROVED", HEAD, "a11ign-ai-workers"), review("CHANGES_REQUESTED", HEAD, "somebody-else"))], false), ["#46"]);
});

test("#483: a pull request with the owner's CHANGES_REQUESTED on headRefOid is NOT named", () => {
  assert.deepEqual(namedWithSwitch([reviewed(review("CHANGES_REQUESTED", HEAD))], false), []);
});

test("#483: a pull request with the owner's APPROVED on headRefOid is NOT named (today's case still holds)", () => {
  assert.deepEqual(namedWithSwitch([reviewed(review("APPROVED", HEAD))], false), []);
});

test("#483: a pull request whose only owner review is on an OLDER commit.oid is named: a push after a refusal asks again", () => {
  assert.deepEqual(namedWithSwitch([reviewed(review("CHANGES_REQUESTED", OLD_HEAD))], false), ["#46"]);
  assert.deepEqual(namedWithSwitch([reviewed(review("APPROVED", OLD_HEAD))], false), ["#46"], "an approval of a head that has since moved is not an approval of this one");
  assert.deepEqual(namedWithSwitch([reviewed(review("CHANGES_REQUESTED", OLD_HEAD), review("CHANGES_REQUESTED", HEAD))], false), [], "and the owner's later review of the new head settles it");
});

test("#483: a pull request whose only owner review is COMMENTED (or DISMISSED) is named: neither is a review CODEOWNERS counts", () => {
  assert.deepEqual(namedWithSwitch([reviewed(review("COMMENTED", HEAD))], false), ["#46"]);
  assert.deepEqual(namedWithSwitch([reviewed(review("DISMISSED", HEAD))], false), ["#46"]);
});

test("#483: a review with no commit, or a pull request with no headRefOid, is not two equal heads: a refusal there is named, an approval settles as before", () => {
  const noCommit = (state: string) => ({ author: { login: OWNER }, state });
  assert.deepEqual(namedWithSwitch([reviewed(noCommit("CHANGES_REQUESTED"))], false), ["#46"]);
  assert.deepEqual(namedWithSwitch([{ ...reviewed({ ...review("CHANGES_REQUESTED", ""), commit: {} }), headRefOid: undefined }], false), ["#46"]);
  assert.deepEqual(namedWithSwitch([{ ...reviewed(review("CHANGES_REQUESTED", HEAD)), headRefOid: undefined }], false), ["#46"]);
  // today's pinned case (`work-gate.test.ts` #1959 (c)): an approval that carries no sha cannot be shown to be stale, so it still settles
  assert.deepEqual(namedWithSwitch([reviewed(noCommit("APPROVED"))], false), []);
});

test("#483 negative control: with the switch ON the CHANGES_REQUESTED case is named again, and an APPROVED on any head is today's answer", () => {
  assert.deepEqual(namedWithSwitch([reviewed(review("CHANGES_REQUESTED", HEAD))], true), ["#46"], "the refusal on the current head is named once more");
  assert.deepEqual(namedWithSwitch([reviewed(review("APPROVED", HEAD))], true), []);
  assert.deepEqual(namedWithSwitch([reviewed(review("APPROVED", OLD_HEAD))], true), [], "today's filter never looked at the head");
});

test("#483: a pull request the owner authored stays excluded, with or without a review", () => {
  const own = { ...reviewed(), author: { login: OWNER } };
  assert.deepEqual(namedWithSwitch([own], false), []);
  assert.deepEqual(namedWithSwitch([own], true), []);
});

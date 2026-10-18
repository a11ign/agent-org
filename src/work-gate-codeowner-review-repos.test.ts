// no-token: gh -- pure: `pipelineCodeownerReviewMissing` over in-memory pull requests and `comparablePrFiles`'s output; nothing reaches `gh`, `git` or the network
/**
 * a11ign#5044 step 2: `pr-codeowner-review-missing` IS RETIRED, so these cases assert that it names NOTHING.
 *
 * The cause asked for a review from the `ceo` login (`a11ign-ai-leads`), which is an App and cannot be a code owner (a11ign#4981).
 * `ROLE_LOGIN` no longer maps `ceo`, so the pipeline lane has no login to key and `pipelineCodeownerReviewMissing` returns [] for every
 * input. The keying (#3720: files by repository and number) and the review-state handling (#483: a refusal on the current head settles
 * the cause) that these cases used to pin have nothing left to decide, so each case keeps its fixture and asserts silence instead.
 *
 * POSITIVE CONTROL for every "is not named" assertion lives in `src/packaging/work-gate.test.ts`, under "#1959 retired": the same
 * pipeline pull request is named when `ceo: "a11ign-ai-leads"` is restored in `ROLE_LOGIN` (mutation checked, recorded on the row).
 * The owned-path check that replaces the cause is `owned-path-signoff.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { comparablePrFiles } from "./work-gate/vocabulary.ts";
import { pipelineCodeownerReviewMissing } from "./work-gate/causes/pr-reviews.ts";

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

/** The pull requests the cause names; always empty now, which is what these cases pin. */
const named = (prs: Pr[]) => pipelineCodeownerReviewMissing(prs, comparablePrFiles(prs));

test("#3720 retired: a sibling's workflow PR is NOT named", () => {
  assert.deepEqual(named([pr(3, [WORKFLOW], TOOLCHAIN)]), []);
});

test("#3720 retired: two repositories sharing a number name nothing, whichever order they arrive in", () => {
  const workflow = pr(3, [WORKFLOW], TOOLCHAIN), bump = pr(3, [DEPENDENCY_BUMP], LAB);
  assert.deepEqual(named([workflow, bump]), []);
  assert.deepEqual(named([bump, workflow]), []);
});

test("#3720 retired: a tracker PR and a sibling's PR with its number name nothing, in both directions", () => {
  const tracker = pr(3, [WORKFLOW]), sibling = pr(3, [DEPENDENCY_BUMP], LAB);
  assert.deepEqual(named([tracker, sibling]), []);
  assert.deepEqual(named([sibling, tracker]), []);
  const trackerBump = pr(3, [DEPENDENCY_BUMP]), siblingWorkflow = pr(3, [WORKFLOW], TOOLCHAIN);
  assert.deepEqual(named([trackerBump, siblingWorkflow]), []);
  assert.deepEqual(named([siblingWorkflow, trackerBump]), []);
});

test("#3720 retired: two repositories that BOTH touch an owned path under one number name nothing", () => {
  assert.deepEqual(named([pr(3, [WORKFLOW], TOOLCHAIN), pr(3, [WORKFLOW], LAB)]), []);
});

// --- a11ign/agent-org#483 retired: the owner's review states no longer decide anything, because there is no owner login to review ----------
const OWNER = "a11ign-ai-leads", HEAD = "9f3c1a7", OLD_HEAD = "41be0d2";

/** A review as `gh pr list --json reviews` carries it: the author, the state, and the sha it was posted against. */
const review = (state: string, oid: string, login = OWNER) => ({ author: { login }, state, commit: { oid } });

/** A workflow pull request at `HEAD` carrying `reviews`. */
const reviewed = (...reviews: unknown[]): Pr => ({ ...pr(46, [WORKFLOW]), headRefOid: HEAD, reviews });

test("#483 retired: a pull request with NO review, or one reviewed only by someone else, is NOT named", () => {
  assert.deepEqual(named([reviewed()]), []);
  assert.deepEqual(named([reviewed(review("APPROVED", HEAD, "a11ign-ai-workers"), review("CHANGES_REQUESTED", HEAD, "somebody-else"))]), []);
});

test("#483 retired: a CHANGES_REQUESTED on headRefOid, an APPROVED on any head, and a COMMENTED or DISMISSED review are NOT named", () => {
  assert.deepEqual(named([reviewed(review("CHANGES_REQUESTED", HEAD))]), []);
  assert.deepEqual(named([reviewed(review("APPROVED", HEAD))]), []);
  assert.deepEqual(named([reviewed(review("APPROVED", OLD_HEAD))]), []);
  assert.deepEqual(named([reviewed(review("CHANGES_REQUESTED", OLD_HEAD), review("CHANGES_REQUESTED", HEAD))]), []);
  assert.deepEqual(named([reviewed(review("COMMENTED", HEAD))]), []);
  assert.deepEqual(named([reviewed(review("DISMISSED", HEAD))]), []);
});

test("#483 retired: a review with no commit, or a pull request with no headRefOid, is NOT named", () => {
  const noCommit = (state: string) => ({ author: { login: OWNER }, state });
  assert.deepEqual(named([reviewed(noCommit("CHANGES_REQUESTED"))]), []);
  assert.deepEqual(named([{ ...reviewed({ ...review("CHANGES_REQUESTED", ""), commit: {} }), headRefOid: undefined }]), []);
  assert.deepEqual(named([{ ...reviewed(review("CHANGES_REQUESTED", HEAD)), headRefOid: undefined }]), []);
  assert.deepEqual(named([reviewed(noCommit("APPROVED"))]), []);
});

test("#483 retired: a pull request the owner authored is NOT named, with or without a review", () => {
  const own = { ...reviewed(), author: { login: OWNER } };
  assert.deepEqual(named([own]), []);
  assert.deepEqual(named([{ ...own, reviews: [review("CHANGES_REQUESTED", HEAD)] }]), []);
});

// no-token: gh -- pure: `pipelineCodeownerReviewMissing` over in-memory pull requests and `comparablePrFiles`'s output; nothing reaches `gh`, `git` or the network
/**
 * #796: WHICH REVIEW COUNTS AS THE CODE OWNER'S, NOW THAT A MANAGER REVIEWS AS THE MANAGERS APP. RETIRED by a11ign#5044 step 2.
 *
 * The cause asked for a review from the `ceo` login (`a11ign-ai-leads`), which is an App and cannot be a code owner (a11ign#4981), so
 * `ROLE_LOGIN` no longer maps `ceo` and `pipelineCodeownerReviewMissing` names nothing. The rule these cases used to pin (a review is the
 * owner's when its author is the managers App AND its last `<!-- decided-by: ceo -->` marker names `ceo`; authorship is not extended) has
 * nothing left to decide, so each case keeps its fixture and asserts silence instead.
 *
 * POSITIVE CONTROL for every "is not named" assertion lives in `src/packaging/work-gate.test.ts`, under "#1959 retired": the same
 * pipeline pull request is named when `ceo: "a11ign-ai-leads"` is restored in `ROLE_LOGIN` (mutation checked, recorded on the row).
 * The owned-path check that replaces the cause is `owned-path-signoff.test.ts`.
 *
 * Kept apart from `packaging/work-gate.test.ts`, whose imports reach `host-units.ts` and so need `history`: this file is one an
 * acceptance job without a token or a checkout's history can run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { comparablePrFiles } from "./work-gate/vocabulary.ts";
import { pipelineCodeownerReviewMissing } from "./work-gate/causes/pr-reviews.ts";

const pipelinePr = (n: number, files: string[], extra: Record<string, unknown> = {}) =>
  ({ number: n, files: files.map((path) => ({ path })), changedFiles: files.length,
    author: { login: "a11ign-ai-workers" }, reviews: [], ...extra });

const PIPELINE_FILE = [".github/workflows/release.yml"];
const appReview = (login: string, role: string | null, extra: Record<string, unknown> = {}) =>
  ({ state: "APPROVED", author: { login },
    body: role === null ? "Approved." : `Approved.\n\n<!-- decided-by: ${role} run: 3e5f0f10-4a0e-4b86-9c1d-7f6d2c5b1a11 -->`, ...extra });
/** The numbers the cause names; always empty now, which is what these cases pin. */
const missing = (pr: any) => pipelineCodeownerReviewMissing([pr], comparablePrFiles([pr])).map((m) => m.number);

test("#796 (a) retired: the managers App's approval marked `decided-by: ceo` is NOT named, in each spelling of its login", () => {
  for (const login of ["a11ign-managers[bot]", "a11ign-managers", "app/a11ign-managers"]) {
    const pr = pipelinePr(30, PIPELINE_FILE, { reviews: [appReview(login, "ceo")] });
    assert.deepEqual(missing(pr), [], login);
  }
});

test("#796 (b) retired: the same App review under any other role, or none, is NOT named either", () => {
  for (const role of ["product-manager", "orchestrator", "cEo", "ceo-2", null]) {
    const pr = pipelinePr(31, PIPELINE_FILE, { reviews: [appReview("a11ign-managers[bot]", role)] });
    assert.deepEqual(missing(pr), [], String(role));
  }
});

test("#796 (c) retired: `decided-by: ceo` on anyone else's review is NOT named", () => {
  for (const login of ["a11ign-ai-workers", "a11ign-workers[bot]", "a11ign-reviewer[bot]"]) {
    const pr = pipelinePr(32, PIPELINE_FILE, { reviews: [appReview(login, "ceo")] });
    assert.deepEqual(missing(pr), [], login);
  }
});

test("#796 (d) retired: a quoted `decided-by: ceo` earlier in a body is NOT named, and neither is a last marker naming another seat", () => {
  const body = "> <!-- decided-by: ceo run: 1 -->\nApproved.\n\n<!-- decided-by: product-manager run: 2 -->";
  const pr = pipelinePr(33, PIPELINE_FILE, { reviews: [{ ...appReview("a11ign-managers[bot]", "ceo"), body }] });
  assert.deepEqual(missing(pr), []);
});

test("#796 (e) retired: the App's review at an older head, a refusal, or a comment is NOT named, whichever head it sits on", () => {
  const stale = pipelinePr(34, PIPELINE_FILE, { headRefOid: "bbbb", reviews: [appReview("a11ign-managers[bot]", "ceo", { commit: { oid: "aaaa" } })] });
  assert.deepEqual(missing(stale), []);
  const current = pipelinePr(34, PIPELINE_FILE, { headRefOid: "bbbb", reviews: [appReview("a11ign-managers[bot]", "ceo", { commit: { oid: "bbbb" } })] });
  assert.deepEqual(missing(current), []);
  const refusal = pipelinePr(34, PIPELINE_FILE, { headRefOid: "bbbb",
    reviews: [appReview("a11ign-managers[bot]", "ceo", { state: "CHANGES_REQUESTED", commit: { oid: "bbbb" } })] });
  assert.deepEqual(missing(refusal), []);
  const comment = pipelinePr(34, PIPELINE_FILE, { reviews: [appReview("a11ign-managers[bot]", "ceo", { state: "COMMENTED" })] });
  assert.deepEqual(missing(comment), []);
});

test("#796 (f) retired: an App-authored PR is NOT named, with or without a review from the owner's account", () => {
  for (const login of ["a11ign-managers[bot]", "a11ign-managers", "app/a11ign-managers"]) {
    assert.deepEqual(missing(pipelinePr(35, PIPELINE_FILE, { author: { login } })), [], login);
  }
  const settled = pipelinePr(35, PIPELINE_FILE, { author: { login: "app/a11ign-managers" },
    reviews: [{ state: "APPROVED", author: { login: "a11ign-ai-leads" } }] });
  assert.deepEqual(missing(settled), []);
});

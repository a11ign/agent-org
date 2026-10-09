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
import { comparablePrFiles, pipelineCodeownerReviewMissing } from "./work-gate.ts";

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

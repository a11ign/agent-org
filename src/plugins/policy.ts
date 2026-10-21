// @ts-check
// module: what core decides about what a code host reports, handed to a code host plugin (A11-160)
//
// A PLUGIN READS GITHUB'S DATA AND DOES NOT OWN THE POLICY. Which check is red (`red-pr.ts`, which row mode shares), which of two runs of a check is the newer, and whether a
// pull request's author is the org's own stay in core, because other parts of core decide the same things; the plugin is handed them through `deps.policy` (it imports core's types
// only, ADR 0001). The reviewer's judging needs the gate's modules, which load only on an instance that starts reviewers, so `review` is the caller's to give: `reviewer-port.ts`
// builds it over the gate, and a caller with no gate (doctor, onboard) gets one that refuses by name when asked.
import { isAtLeastAsNew } from "../newest-check-run.ts";
import { brokenChecks } from "../red-pr.ts";
import type { CodeHostPolicy } from "./manifest.ts";

/** The `review` of a process that has not loaded the reviewer's gate: it refuses, naming what is missing. */
export const NO_REVIEW_GATE: CodeHostPolicy["review"] = () => {
  throw new Error("the reviewer's gate is not loaded in this process, so a pull request is not judged for review here");
};

/** Core's policy for a code host plugin, with the reviewer's judging the caller gives (`NO_REVIEW_GATE` when it has none). */
export const corePolicy = (review: CodeHostPolicy["review"] = NO_REVIEW_GATE): CodeHostPolicy => Object.freeze({
  redChecksOf: (pr) => brokenChecks({ statusCheckRollup: [...pr.rollup], labels: [...pr.labels] }),
  isAtLeastAsNew: (a, b) => isAtLeastAsNew(a, b),
  review,
});

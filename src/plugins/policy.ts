// @ts-check
// module: what core decides about what a code host reports, handed to a code host plugin (A11-160)
//
// A PLUGIN READS GITHUB'S DATA AND DOES NOT OWN THE POLICY. Which check is red (`red-pr.ts`, which row mode shares), which of two runs of a check is the newer, and whether a
// pull request's author is the org's own stay in core, because other parts of core decide the same things; the plugin is handed them through `deps.policy` (it imports core's types
// only, ADR 0001). The reviewer's judging needs the gate's modules, which load only on an instance that starts reviewers, so `review` is the caller's to give: `reviewer-port.ts`
// builds it over the gate, and a caller with no gate (doctor, onboard) gets one that refuses by name when asked.
import { isAtLeastAsNew } from "../newest-check-run.ts";
import { brokenChecks } from "../red-pr.ts";
import { REVIEWER_GH_CONFIG_DIR } from "../reviewer-gh-config-dir.ts";
import { startsReviewers } from "../ticket-mode/concern-states.ts";
import type { TicketSettings } from "../ticket-mode/settings.ts";
import type { CodeHostPolicy } from "./manifest.ts";

/** The `review` of a process that has not loaded the reviewer's gate: it refuses, naming what is missing. */
export const NO_REVIEW_GATE: CodeHostPolicy["review"] = () => {
  throw new Error("the reviewer's gate is not loaded in this process, so a pull request is not judged for review here");
};

/**
 * The identities the review claim uses on a machine with these settings (A11-172): none where no reviewer starts. The `reviewer` role WRITES it (the claim and its release are posted in the reviewer's
 * environment, as the verdict door posts the finished claim), and the role the instance's own `gh` resolves to READS it: `scheduler`, since the instance's unit has no workspace. A claim written by the one
 * and read by the other is why both are checked.
 */
export const reviewClaimIdentities = (settings: Pick<TicketSettings, "reviewer" | "drafts">): CodeHostPolicy["claimIdentities"] => (startsReviewers(settings) ? [
  { role: "reviewer", access: "write", env: { AGENT_ORG_GH_ROLE: "reviewer", GH_CONFIG_DIR: REVIEWER_GH_CONFIG_DIR } },
  { role: "scheduler", access: "read", env: { AGENT_ORG_GH_ROLE: "scheduler" } },
] : []);

/**
 * Core's policy for a code host plugin, with the reviewer's judging the caller gives (`NO_REVIEW_GATE` when it has none), and the identities the review claim uses when this machine starts a
 * reviewer (none by default: a caller that is not asking about reviews, and a machine that starts none, has no claim to check).
 */
export const corePolicy = (review: CodeHostPolicy["review"] = NO_REVIEW_GATE, claimIdentities: CodeHostPolicy["claimIdentities"] = []): CodeHostPolicy => Object.freeze({
  redChecksOf: (pr) => brokenChecks({ statusCheckRollup: [...pr.rollup], labels: [...pr.labels] }),
  isAtLeastAsNew: (a, b) => isAtLeastAsNew(a, b),
  review,
  claimIdentities,
});

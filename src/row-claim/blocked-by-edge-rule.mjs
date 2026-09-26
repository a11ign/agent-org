#!/usr/bin/env node
// @ts-check
// RULE: DOES THE ROW BEING CLAIMED CARRY ITS OWN OPEN `blockedBy` EDGE? -- #1886.
//
// `waitingOn` (`../waiting-condition.mjs`) is already the one reader of "is this row waiting on
// something" -- the gate's own wake computation reads it before a row is ever offered as
// `ready-row-unclaimed`. `row-claim.mjs`'s `sessionEligibilityReason` composed B2 (own-pr-health) and B4
// (file-overlap) and nothing else, so a row the gate correctly shelves could still be claimed directly by
// any session that found it by label instead of through the gate: #1852 carried an open `blockedBy` on
// #1878 and #1883 while mislabelled `ready`, and neither B2 nor B4 has anything to say about a `blockedBy`
// edge -- confirmed, `row-claim.mjs` never imported `waiting-condition.mjs` at all.
//
// ONLY THE `blockedBy` KIND, deliberately. `waitingOn` also reports a `Not-before:` date wait; whether a
// claim should refuse on that too is a different question this row's own Region/Acceptance never asks,
// and answering it here would be exactly the unstated-scope creep this repo's own retros keep finding.
//
// NO OVERRIDE FLAG. `--blocked-by=#N` (`blocked-by-rule.mjs`) already exists and releases B2 ONLY, on
// proof (a measurement comment) that a SPECIFIC PR's own red build is unrelated to a named blocker -- a
// claim about a claimant's own build, not about whether the row itself should be started at all. Reusing
// it here would let one override silently excuse two different questions, which #1886's own Region warns
// against. A `blockedBy` edge is GitHub-native state; it is lifted the way it was added
// (`gh issue edit --remove-blocked-by`), which is also the one place the removal is visible to every other
// reader of the row -- a bypass flag here would just be a second, unrecorded way to the same effect.
import { waitingOn, todayIso } from "../waiting-condition.mjs";
import { lookup, gh } from "../merge-guard/lookups.mjs";
import { REPO } from "../project-identity.mjs";

/**
 * #2617: `repo` is the TRACKER the row lives in -- the one the project's declaration names for it (default: the first).
 *
 * @param {number} issueNumber the row about to be claimed
 * @param {{ run?: typeof gh, repo?: string }} deps
 * @returns {{blockedBy?: {nodes?: {number?: number, state?: string}[]}} | null} `null` on a failed lookup
 */
export function lookupBlockedByEdge(issueNumber, { run = gh, repo = REPO } = {}) {
  return lookup(() => {
    const raw = run(["issue", "view", String(issueNumber), "--repo", repo, "--json", "blockedBy"]);
    return JSON.parse(raw);
  });
}

/**
 * `null` means proceed: no open `blockedBy` edge, or the lookup itself failed. FAILS OPEN on a lookup
 * failure, matching B2/B4 -- this protects a session's ability to claim ANYTHING when the network is
 * down, not a verdict about whether the row is genuinely blocked.
 * @param {{blockedBy?: {nodes?: {number?: number, state?: string}[]}} | null} row
 * @returns {string | null}
 */
export function blockedByEdgeReason(row) {
  if (row === null) return null;
  const waiting = waitingOn(row, todayIso());
  if (waiting?.kind !== "row") return null;
  const names = waiting.numbers.map((n) => `#${n}`).join(", ");
  return `blocked by still-open ${names}: GitHub's own \`blockedBy\` edge names a row this claim must `
    + `wait on. Clear the edge with \`gh issue edit --remove-blocked-by\` once ${names} closes, or close `
    + `it, before claiming.`;
}

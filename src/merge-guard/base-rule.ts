#!/usr/bin/env node
// @ts-check
// RULE: IS THIS PR TARGETING `main` AT ALL? -- the cheapest of the eight checks, and the one that made
// #148 invisible to everything else: `ci.yml` used to trigger on `pull_request: branches: [main]` (A11-370 removed the filter), so a PR based
// on another open PR's branch runs no workflow and the branch protection covering `main` protects nothing.

/** @param {{baseRefName: string}} pr */
export function baseReason(pr: { baseRefName: string; }) {
  if (pr.baseRefName === "main") return [];
  return [`BASE IS NOT main — it is \`${pr.baseRefName}\`.\n`
    + "  `ci.yml` runs on it (its `pull_request` trigger has no base filter, A11-370), but the merge queue and the\n"
    + "  branch protection cover `main` only, so merging it here lands the work on its base, not on `main`. Re-target\n"
    + "  it at `main`, or merge its base first and let this one be retargeted."];
}

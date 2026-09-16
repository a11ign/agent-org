#!/usr/bin/env node
// @ts-check
// RULE: IS THIS PR TARGETING `main` AT ALL? -- the cheapest of the eight checks, and the one that made
// #148 invisible to everything else: `ci.yml` triggers on `pull_request: branches: [main]`, so a PR based
// on another open PR's branch runs no workflow and the branch protection covering `main` protects nothing.

/** @param {{baseRefName: string}} pr */
export function baseReason(pr) {
  if (pr.baseRefName === "main") return [];
  return [`BASE IS NOT main — it is \`${pr.baseRefName}\`.\n`
    + "  `ci.yml` triggers on `pull_request: branches: [main]`, so NO workflow runs for this PR and the\n"
    + "  branch protection that covers `main` protects nothing here. Re-target it at `main`, or merge its\n"
    + "  base first and let this one re-open against `main`."];
}

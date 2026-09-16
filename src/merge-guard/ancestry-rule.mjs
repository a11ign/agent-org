#!/usr/bin/env node
// @ts-check
// RULE: DOES THIS HEAD CONTAIN `main`'s TIP? -- an ANCESTRY fact, and the clock cannot answer it (#182).
//
// `staleness-rule.mjs` compares the newest run's completion time against `main`'s tip commit DATE, and
// that was a proxy standing in for this question. **A run can finish AFTER `main`'s tip was committed
// while the branch still does not contain that commit** -- which is not a corner case, it is what ordinary
// concurrent merging produces. Measured 2026-09-07 on #165: `main` tipped 01:31:03Z with #147, #165's run
// finished later, the branch had never seen #147, and this tool printed *"run against the current main"*
// and exited 0. GitHub refused the merge; `gh pr update-branch` then reported the branch updated.
//
// The original comment stated the right question -- *"whether this head was ever tested alongside the
// code it is about to join"* -- and then asked a different one. Two commits' timestamps say nothing about
// whether one contains the other.
//
// KEPT SEPARATE FROM THE CLOCK CHECK, deliberately. `PREDATES` and `DOES NOT CONTAIN` are different
// faults: the first says the runs are old, the second says the tree is. Collapsing them into one message
// would lose the diagnosis the original was built for -- #135's runs genuinely predate the tip, and that
// sentence, with both timestamps, is still the right thing to print about it.
//
// `behind_by` FROM THE COMPARE API, NOT `mergeStateStatus`. That distinction is `merge-guard.mjs`'s whole
// reason for existing, so it is worth being exact: `mergeStateStatus` folds together checks, conflicts and
// branch protection into one opinion about mergeability, which is why it reads `CLEAN` for a PR nothing
// ever tested. `behind_by` is arithmetic on the commit graph -- how many commits `main` has that this head
// does not -- and it is the same fact `git merge-base --is-ancestor` answers, asked of a server that has
// both commits without this checkout needing to fetch a PR ref it may never have seen. That fetch is
// oriented `compare/main...<head>`, never the reverse (#188) -- `merge-guard.mjs`'s own `facts()` builds
// it, since the value arrives alongside the other per-PR facts a live check gathers in one round trip.
//
// `ceo` ALSO RULED THIS OUT AS A REQUIRED-CI REFUSAL, and the reason is throughput, not principle: with
// `strict=false` and merges landing roughly one a minute, almost every open PR is behind `main` almost all
// the time. `mergeSafetyVerdict` (the narrower check a required CI job runs against its own commit,
// composed in `merge-guard.mjs`) deliberately does NOT include this rule for exactly that measurement --
// see its own comment there. This rule stays advice for a HUMAN deciding whether to update a branch by
// hand; under strict protection (restored 02:15Z, #442) GitHub itself now enforces it at merge time.

/**
 * @param {number | null} behindBy
 * @returns {string[]}
 */
export function ancestryReason(behindBy) {
  if (behindBy === null || behindBy === 0) return [];
  return [`THIS HEAD DOES NOT CONTAIN main's TIP — it is ${behindBy} commit(s) behind.\n`
    + "  Whatever ran, ran against a tree missing that work, so it cannot say the two go together. This is\n"
    + "  NOT the same as the runs being old: they may be minutes fresh and still have tested a base that\n"
    + "  no longer exists. Update the branch and let it re-run."];
}

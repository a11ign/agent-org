#!/usr/bin/env node
// @ts-check
// RULE: IS SOMEBODY ELSE HOLDING THIS PR? -- #266, and it is #197's finding one object along.
//
// The split between the dispatcher and a PR's author lived entirely in messages: *the dispatcher updates
// and arms, the author pushes.* Measured 2026-09-07 on PR #258 -- the dispatcher said "arming on green"
// and ran `update-branch`; the author ran the guard, saw `7 commit(s) behind`, rebased, and pushed into
// it. `--force-with-lease` refused, which is the only reason nothing was lost: a plain `--force` would
// have taken the branch to a base fetched before #229 merged and silently reverted that PR's README and
// changeset inside a branch nobody would think to check for them.
//
// **The boundary was wrong rather than ignored.** The stated rule named *armed* PRs; #258 was UNARMED,
// so by that rule it was the author's -- while the dispatcher was updating it in preparation for arming.
// The real predicate is "a PR somebody is actively working on", and **the other party cannot see that
// state from outside**. So the collision was invisible, not careless, which is a property of the rule.
//
// WHY A LABEL AND NOT AN AGREEMENT. The agreed remedy was a sentence -- *once the dispatcher says they
// will arm it, it is theirs.* Better than what it replaced, and this repo has already MEASURED that shape
// and found it wanting: #197 is the identical experiment on rows, where a claim that existed only as a
// sentence in a dispatch message produced **three double-dispatches (#156, #158, #159), each caught by a
// worker's own caution and never by the tool.** `row-claim.mjs`'s header states the principle this
// inherits: the Project Status field is a VIEW; the label, on the object and timestamped by GitHub's own
// timeline, is the RECORD.
//
// READS `hold:*` OFF THE PR, through `holdersOf` -- NOT `session:*`, and NOT `claimStatus`.
//
// IT READ `session:*` UNTIL 2026-09-09, and that was the collision. `session:<name>` also means
// OWNERSHIP: who is working on a ROW, and, since ceo's 12:2xZ ruling, who opened a PR. orchestrator
// hand-labelled twelve of their own PRs that afternoon to mark them as theirs and every one of them read
// as HELD here; #725 was about to apply the label to every armed PR in the org. This module's own header
// argued that passing PR labels through a ROW's predicate would report every held PR as unheld -- which
// was right about the direction and wrong about the vocabulary, because the two questions had been given
// one word. They now have two.
//
// `holdersOf` from `pr-hold-state.mjs` is the ONE predicate: `pr-hold` writes what it reads, and
// `arm-pr`/`auto-arm-sweep` read the same. Two spellings of one fact is the shape half this repo's
// defects share, and this file has now been on both sides of it.
//
// NO `--allow-held` ESCAPE HATCH, unlike #249's `--allow-claimed-close`, and the asymmetry is the point:
// a row you do not hold cannot be taken from its owner, so confirming and passing a flag is the only
// route. A PR hold CAN be handed over -- `npm run pr:release` then `pr:hold` -- so a flag here would be a
// silent bypass standing in for an action that leaves a record. The escape hatch is taking the hold.
import { holdersOf, HOLD_PREFIX } from "../pr-hold-state.mjs";

/**
 * @param {{number: number}} pr
 * @param {string[]} prLabels
 * @param {string | null} session  who is running this check; omitted means every holder is somebody else
 * @returns {string[]}
 */
export function prHoldReasons(pr, prLabels, session) {
  const holders = holdersOf(prLabels)
    .map((label) => label.slice(HOLD_PREFIX.length))
    .filter((held) => held !== session);
  if (holders.length === 0) return [];
  return [`#${pr.number} IS HELD by ${holders.join(", ")}${session ? `, and you are ${session}` : ""}.\n`
    + "  They are working on it now -- updating, rebasing or about to arm it. Pushing into a PR somebody\n"
    + "  else holds is how #258 nearly reverted a merged PR's content inside an unrelated branch.\n"
    + "  Ask them to hand it back, or take it with `npm run pr:hold` once they have released it."];
}

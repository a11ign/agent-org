#!/usr/bin/env node
// @ts-check
// #188: A GUARD WHOSE WRONG ANSWERS ARE ABSORBED BY ANOTHER MECHANISM HAS NO FAILURE SIGNAL.
//
// #182 was caught only because strict branch protection refused what this tool passed -- the guard's own
// wrongness was invisible until somebody happened to run `gh pr update-branch` right after. Nothing
// compared the guard's verdict to what actually happened, so the disagreement left no record anywhere.
//
// So: every verdict `merge-guard.mjs` computes for an OPEN PR is appended to a log. Once a PR is terminal
// (merged or closed), `--reconcile` compares the LAST recorded verdict against the real outcome and
// records whether they AGREED or DISAGREED -- always, not only on conflict, because a log that only
// records disagreements cannot tell "the two agreed" from "the two were never compared" (`worker-capture`'s
// constraint on this row).
//
// THE COMPARISON TARGET IS `pr.state` (MERGED / CLOSED), NEVER `mergeStateStatus`. The issue is explicit
// that this must be an OUTCOME, not an opinion -- the same distinction the rest of this file exists for.
// There is deliberately no attempt to reconstruct history for PRs that resolved before this shipped:
// "did this merge need an update first" is not reliably decidable from git alone after the fact, so
// reconciliation is forward-only rather than producing a plausible retro-verdict.
//
// THE LOG LIVES AT THE GIT COMMON DIR, NEVER `runs/`. `runs/` exists only in the primary checkout (it is
// gitignored, and absent from every worktree) -- a worker running this from its own worktree would write
// this log nowhere, silently, and an empty log from "nothing ran here" is indistinguishable from an empty
// log from "nothing ever disagreed", which is exactly the failure mode this row exists to close. The git
// common dir resolves to the SAME `.git` for the primary and every worktree.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { sandboxGitEnv } from "../../../guards/src/git-env.mjs";
import { reasonKind } from "./reason-kind.mjs";

const EXIT = { READY: 0, CANNOT_ASK: 2 };

/**
 * Never a silent no-op: a write failure is the exact defect this mechanism exists to avoid.
 *
 * Exported (#226) so a second log -- `row-claim`'s check/conflict log -- reuses this rather than
 * re-deriving "append one JSON line, fail loud" a second time in this repo.
 *
 * @param {string} path
 * @param {object} entry
 */
export function appendJsonl(path, entry) {
  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    throw new Error(`could not write the log at ${path}: ${/** @type {Error} */ (error).message}`,
      { cause: error });
  }
}

/** @returns {string} the `.git` directory shared by the primary checkout and every worktree. */
export function gitCommonDir() {
  return execFileSync("git", ["rev-parse", "--git-common-dir"],
    { encoding: "utf8", env: sandboxGitEnv() }).trim();
}

export function verdictLogPath() {
  return `${gitCommonDir()}/merge-guard-log.jsonl`;
}

export function agreementLogPath() {
  return `${gitCommonDir()}/merge-guard-agreement-log.jsonl`;
}

/**
 * Appends one verdict. Called on every live guard run against an OPEN PR.
 * @param {string} logPath
 * @param {number} prNumber
 * @param {{code: number, reasons: string[]}} verdict
 */
export function recordVerdict(logPath, prNumber, verdict) {
  appendJsonl(logPath, {
    prNumber, at: new Date().toISOString(),
    code: verdict.code,
    reasonKinds: verdict.reasons.map(reasonKind),
  });
}

/**
 * The most recently recorded verdict for a PR, or null if none was ever recorded.
 * @param {string} logPath
 * @param {number} prNumber
 * @returns {{prNumber: number, at: string, code: number, reasonKinds: string[]} | null}
 */
export function latestVerdictFor(logPath, prNumber) {
  let text;
  try {
    text = readFileSync(logPath, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null;
    throw error;
  }
  const entries = text.split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.prNumber === prNumber);
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

/**
 * `pr.state` -> a real outcome, or null when there isn't one yet. Never `mergeStateStatus` -- see the
 * header above this section.
 *
 * @param {string} state
 * @returns {"ACCEPTED" | "REFUSED" | null}
 */
export function realOutcomeFor(state) {
  if (state === "MERGED") return "ACCEPTED";
  if (state === "CLOSED") return "REFUSED";
  return null; // OPEN, or anything not yet terminal
}

/**
 * THE COMPARISON, PURE. Records AGREEMENT as explicitly as DISAGREEMENT -- an absent line here is
 * indistinguishable from "never compared", which is the trap this row exists to close.
 *
 * `resolvedAt` guards a real trap, found by running this live against an already-merged PR: recomputing
 * the guard's verdict AFTER a PR has resolved almost always reads REFUSED, because `main` has kept moving
 * and the merged head is now "behind" a tip it was never tested against and never needed to be -- that is
 * not a disagreement, it is a stale question asked of a settled outcome. So a verdict recorded AFTER the
 * PR's own resolution timestamp is refused here rather than reconciled: it was never a live, pre-decision
 * check, and treating it as one would flood this log with false DISAGREED entries for every merged PR
 * anyone runs the guard against after the fact.
 *
 * @param {{prNumber: number, recordedVerdict: {code: number, reasonKinds: string[], at: string} | null,
 *          realOutcome: "ACCEPTED" | "REFUSED" | null, resolvedAt: string | null}} args
 * @returns {{code: number, reason: string, record: null} | {code: number, reason: null, record:
 *   {prNumber: number, at: string, guardVerdict: "READY" | "REFUSED", guardReasonKinds: string[],
 *    realOutcome: "ACCEPTED" | "REFUSED", agreement: "AGREED" | "DISAGREED"}}}
 */
export function reconcile({ prNumber, recordedVerdict, realOutcome, resolvedAt }) {
  if (recordedVerdict === null) {
    return { code: EXIT.CANNOT_ASK, record: null,
      reason: `no recorded guard verdict for #${prNumber} — nothing to reconcile against.` };
  }
  if (realOutcome === null) {
    return { code: EXIT.CANNOT_ASK, record: null,
      reason: `#${prNumber} has no outcome yet — reconciliation is forward-only and never invents one ` +
        "for a PR that is still OPEN." };
  }
  if (resolvedAt != null && recordedVerdict.at > resolvedAt) {
    return { code: EXIT.CANNOT_ASK, record: null,
      reason: `the recorded verdict for #${prNumber} (${recordedVerdict.at}) was made AFTER it resolved ` +
        `(${resolvedAt}) — that is a stale post-mortem question, not a live pre-decision check, and ` +
        "comparing it would read as a disagreement for a reason that has nothing to do with the merge." };
  }
  const guardVerdict = recordedVerdict.code === EXIT.READY ? "READY" : "REFUSED";
  const platformAccepted = realOutcome === "ACCEPTED";
  const agreement = (guardVerdict === "READY") === platformAccepted ? "AGREED" : "DISAGREED";
  return {
    code: EXIT.READY,
    reason: null,
    record: {
      prNumber, at: new Date().toISOString(), guardVerdict,
      guardReasonKinds: recordedVerdict.reasonKinds, realOutcome, agreement,
    },
  };
}

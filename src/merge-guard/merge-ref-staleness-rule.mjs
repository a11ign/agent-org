#!/usr/bin/env node
// @ts-check
// RULE: IS THE MERGE REF THIS PR'S CI ACTUALLY TESTED STALE AGAINST `main`'S CURRENT TIP? -- #433.
//
// `refs/pull/N/merge` is computed once, when the head branch is pushed, and is never recomputed
// afterwards -- a base move does not refresh it, a `pull_request: edited` event does not refresh it,
// forcing a mergeability recompute does not refresh it. Measured 2026-09-08: nine of nine open PRs were
// stale, by up to 374 commits, and #413's own red run failed on two fixes that were already on `main`
// and simply absent from the tree its CI actually checked out.
//
// THIS RULE ANSWERS THE DIAGNOSIS, NOT THE FIX. `strict: true` branch protection (restored 02:15Z) means
// staleness cannot reach `main` -- a PR merges only with `main`'s tip in its head and `gate` green ON
// that head, so the correctness question #433 opened with is already closed. What is still open is that
// a PR NOT YET CARRIED can be red for a reason that has nothing to do with its own code, and nothing on
// the PR said so: a red run reads as flaky or as a real regression, and "the fix is on main, your next
// run will pick it up" -- said in this repo, more than once -- is false, because the only thing that
// refreshes a merge ref is a push to the head branch.
//
// "COULD NOT ASK" IS KEPT DISTINCT FROM "N BEHIND", DELIBERATELY -- measured live, 2026-09-09:
// `queue-table.mjs`'s own `behindByCount` returns `0` on a failed git command, and a caller not checking
// `fetched` first would read a PR whose sha this checkout has never fetched as CURRENT. A version of this
// rule that folded "could not compute" into "0 behind" would have told everyone their PRs were fine on
// the one morning nothing could be measured. So the fetch is attempted here, its failure is a THIRD
// answer (never zero, never a guess), and the caller decides what to do with "could not ask" rather than
// this rule silently choosing "clean" on its behalf.
import { execFileSync } from "node:child_process";
import { sandboxGitEnv } from "../../../guards/src/git-env.mjs";

/** How many commits behind `main` before a stale merge ref is worth reporting, rather than every PR that
 * fell behind in the last thirty seconds. Chosen to match the granularity `queue-table.mjs` already
 * reports at -- a single-digit count is normal churn at this repo's measured merge rate (58/day, median
 * 4 minutes between merges); double digits is the shape #433 was filed over. */
export const DEFAULT_STALE_THRESHOLD = 10;

/**
 * PURE. Given how far behind `main`'s current tip the merge ref's own base commit is, decide whether
 * that ref is stale enough to report -- or say plainly that the count could not be determined at all.
 *
 * `behindBy === null` is NOT "0 behind" and must never be read as one: a missing object, an unfetched
 * ref, or a deleted branch all surface here as `null`, and collapsing that into a number is exactly the
 * defect this rule exists to avoid reproducing.
 *
 * @param {number | null} behindBy commits `main` has that the merge ref's own base does not
 * @param {number} [threshold]
 * @returns {{ askable: false } | { askable: true, stale: boolean, behindBy: number }}
 */
export function mergeRefIsStale(behindBy, threshold = DEFAULT_STALE_THRESHOLD) {
  if (behindBy === null) return { askable: false };
  return { askable: true, stale: behindBy > threshold, behindBy };
}

/**
 * The sentence a human or a sweep prints -- names the fact and what to do, per #433's own two false
 * beliefs: a stale-base red reads as flaky, and "the fix is on main" is trusted without a push. Neither
 * survives one sentence naming the base actually tested and how far behind it fell.
 *
 * @param {ReturnType<typeof mergeRefIsStale>} verdict
 * @param {{ mainSha?: string | null }} [context]
 * @returns {string[]}
 */
export function mergeRefStalenessReason(verdict, { mainSha = null } = {}) {
  if (!verdict.askable) {
    return [`COULD NOT TELL whether the merge ref is stale -- the base commit could not be fetched or `
      + "resolved. This is INCONCLUSIVE, not clean: do not read a missing count as \"tested against "
      + "current main\"."];
  }
  if (!verdict.stale) return [];
  const tip = mainSha ? ` (${mainSha.slice(0, 10)})` : "";
  return [`TESTED AGAINST A STALE main${tip}: this PR's checked-out merge ref is ${verdict.behindBy} `
    + "commit(s) behind main's current tip, and nothing has recomputed it since the last push to this "
    + "branch. A red run here may be failing on something already fixed upstream, or missing a fix "
    + "that has not reached this tree yet -- either way, it is not evidence about this PR's own code "
    + "until the branch is pushed (or updated) and re-run. Re-running the same commit changes nothing: "
    + "only a push recomputes the merge ref."];
}

/** @type {(cmd: string, args: string[]) => string} */
const defaultRun = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", env: sandboxGitEnv() });

/**
 * Fetches PR `number`'s own merge ref, resolves its base (the first parent -- GitHub's own convention,
 * verified live: `refs/pull/N/merge`'s parent 1 is `main`'s tip at the moment the ref was computed,
 * parent 2 is the PR's head), and counts how far `main`'s CURRENT tip has moved past it.
 *
 * Returns `null` -- never `0` -- on ANY failure: the fetch itself, resolving the ref, or the count. A
 * caller reading `null` as "0 behind" reproduces the exact defect `behindByCount` already has, which
 * this function exists specifically not to repeat.
 *
 * @param {number} prNumber
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {number | null}
 */
export function fetchMergeRefBehindBy(prNumber, { run = defaultRun } = {}) {
  try {
    run("git", ["fetch", "origin", `pull/${prNumber}/merge`]);
  } catch {
    return null;
  }
  /** @type {string} */
  let baseSha;
  try {
    baseSha = run("git", ["rev-parse", "FETCH_HEAD^1"]).trim();
  } catch {
    return null;
  }
  try {
    const out = run("git", ["rev-list", "--count", `${baseSha}..origin/main`]).trim();
    const n = Number.parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// @ts-check
/**
 * THE NEWEST RUN OF EACH CHECK NAME. ONE PLACE, BECAUSE FIXING IT AT ONE CALL SITE IS HOW IT SPREAD.
 *
 * #634. GitHub's `statusCheckRollup` UNIONS superseded check-runs, so a cancelled or replaced run's
 * verdict survives on the head for ever. A predicate that asks *"does any run of this head report
 * failure"* answers truthfully about a window nobody chose — every attempt ever made — while the caller
 * meant *"what does this check say now"*. The two read identically and diverge silently.
 *
 * **The root: the sha is not a run identifier.** `pull_request: edited` re-runs CI without moving the
 * commit, so every predicate keyed on "the sha" quietly assumes one run per sha. A sha identifies a tree;
 * it does not identify an attempt to test one.
 *
 * ## It has been fixed FOUR TIMES at four call sites
 *
 * `update-branch-sweep.mjs` (#500, then again at #517), `trunk-revert.mjs` (#582), `queue-table.mjs`
 * (which is where this function was, with a header naming the other three). **That is this repository's
 * most expensive recurring shape — a remedy applied where the fault was noticed rather than everywhere
 * the behaviour reaches — and a fifth call site had never had it**: `merge-queue.mjs`'s
 * `checksBlocking`, which decides whether a PR is mergeable, filtered the RAW rollup and would report
 * `checks failing` for a PR whose current runs are all green.
 *
 * On 2026-09-09 the same shape produced two OPPOSITE wrong verdicts on #619 within an hour: `gh pr
 * checks` said `fail` where the truth was **pending**, and a waiter keyed on the sha said `fail` where
 * the truth was **pass**. Neither source is safe alone and they fail at different moments, so "use the
 * other one" was never the fix. **Newest-per-NAME survives both**, because it asks about a name's
 * current answer rather than about a run's existence.
 */

/** A run still in flight reports this rather than null, so it must not be read as a completion time. */
export const ZERO_DATE = "0001-01-01T00:00:00Z";

const real = (/** @type {string | null | undefined} */ v) => (v && v !== ZERO_DATE ? v : "");

/**
 * When a run last said anything. `completedAt` if it has finished, else `startedAt`.
 * ISO-8601 sorts lexically, so string comparison is a real ordering here rather than a shortcut.
 * @param {{completedAt?: string | null, startedAt?: string | null}} check
 */
const stampOf = (check) => real(check.completedAt) || real(check.startedAt) || "";

/**
 * The workflow run a check run belongs to, read from its `detailsUrl` (`.../actions/runs/<id>/job/<job>`) -- or
 * `null` when the entry names none: a status context, a hand-built fixture, or a REST read that did not select
 * the URL (`queue-table.mjs`'s `checksOnSha` selects only name, conclusion and completion time).
 *
 * Workflow run ids are issued in creation order and stay below 2^53, so they compare as numbers.
 * @param {{detailsUrl?: string | null}} check
 * @returns {number | null}
 */
export function workflowRunIdOf(check) {
  const match = /\/actions\/runs\/(\d+)(?:[/?#]|$)/.exec(check?.detailsUrl ?? "");
  return match ? Number(match[1]) : null;
}

/**
 * IS `a` AT LEAST AS NEW AS `b`? THE ONE COMPARATOR FOR "THE NEWEST RUN OF A NAME" -- #1623.
 *
 * **By workflow run, when both entries name a different one; otherwise by time.** Completion time is the wrong
 * clock when one attempt at a head supersedes another. Measured on #1617's head `84f684dd`, through the same
 * `statusCheckRollup` `gh pr list` returns: `gate` in run 34858134371 was CANCELLED with `completedAt` 14:49:32Z,
 * before it started, and `gate` in the OLDER run 34858130620 succeeded at 14:51:42Z. By time the success was
 * newest, so every reader said SUCCESS, while GitHub held the PR BLOCKED on the newer run's cancelled gate.
 * #1605's head had the pair the other way round (cancelled in run 34855015256, success in the later
 * 34855153052), and run order and time agreed there.
 *
 * The fallback is today's rule exactly -- `completedAt`, else `startedAt`, the ZERO_DATE read as absence, and an
 * untimed entry losing to a timed one. It applies to a MIXED pair (one run id, one not) and to two entries in the
 * SAME run (a re-run job), because neither pair has an order the ids can state.
 * @param {{completedAt?: string | null, startedAt?: string | null, detailsUrl?: string | null}} a
 * @param {{completedAt?: string | null, startedAt?: string | null, detailsUrl?: string | null}} b
 * @returns {boolean}
 */
export function isAtLeastAsNew(a, b) {
  const [runA, runB] = [workflowRunIdOf(a), workflowRunIdOf(b)];
  if (runA !== null && runB !== null && runA !== runB) return runA > runB;
  return stampOf(a) >= stampOf(b);
}

/**
 * The newest run of each check NAME — never `find`, which returns the OLDEST because the rollup is a
 * union in insertion order.
 *
 * The RETURN type has a required `name`, and that is not a convenience: the loop skips any entry
 * without one, so every value that comes back has been through that filter. Typing it as optional made
 * `queue-table.mjs`'s `.map((c) => c.name)` produce `(string | undefined)[]` where a `string[]` was
 * wanted -- a type describing what the input might be rather than what the output IS.
 *
 * @param {{name?: string, conclusion?: string, completedAt?: string, startedAt?: string}[]} rollup
 * @returns {{name: string, conclusion?: string, completedAt?: string, startedAt?: string}[]}
 */
export function newestPerName(rollup) {
  const best = new Map();
  for (const check of rollup ?? []) {
    if (!check?.name) continue;
    const seen = best.get(check.name);
    if (!seen || isAtLeastAsNew(check, seen)) best.set(check.name, check);
  }
  return [...best.values()];
}

/**
 * The newest run of ONE name's conclusion, or null when that name has no run at all.
 *
 * **NO RUN MEANS PENDING, NEVER FAILURE.** `gh pr checks` reports `fail` for a name the current run has
 * not reached yet, because a superseded run of that name is still on the head. Returning null here — and
 * making the caller decide what an absent answer means — is what keeps "has not answered" and "answered
 * badly" from being the same word.
 *
 * @param {{name?: string, conclusion?: string, completedAt?: string, startedAt?: string}[]} rollup
 * @param {string} name
 * @returns {string | null}
 */
export function newestConclusionOf(rollup, name) {
  const newest = newestPerName(rollup).find((c) => c.name === name);
  return newest ? (newest.conclusion || null) : null;
}

#!/usr/bin/env node
// @ts-check
// RULE: DID EVERY REQUIRED CONTEXT ACTUALLY RUN AND CONCLUDE? -- the #148 case's other half. An empty
// check-run list, a required context that never ran, one still in flight, and one that failed are FOUR
// different states this repo has repeatedly conflated into one bare "not green"; each needs its own
// sentence because each sends the reader to a different fix.
//
// Also the lookup `armed-race-rule.mjs`'s `lookupArmedPrStatus` reuses to decide GREEN, rather than
// inventing a second reading of "is this PR green" off `statusCheckRollup` -- see that module's own
// comment for the incident that made a second reading dangerous.

/** A concluded context that does not block a merge. `skipped` is a path filter declining, not a failure. */
export const SATISFIED = new Set(["success", "skipped", "neutral"]);

/**
 * A CANCELLED RUN REACHED NO VERDICT, so it is a WAIT rather than a failure -- #1007.
 *
 * MEASURED on #1005 at 2026-09-11T23:14Z, and it cost two claims in one hour. `gh pr ready` triggers CI,
 * `cancel-in-progress` kills the run already going, and the cancelled run's `gate` job leaves a check-run
 * whose conclusion is `cancelled`. That was the NEWEST `gate` on the head -- the replacement run's had not
 * reported yet -- so #902's newest-per-name rule was working exactly as designed and could not help:
 *
 *     newest per name: … gate=completed/cancelled, ts / run=in_progress/null …
 *     REASONS:         ["STILL RUNNING: ts / run…", "FAILING: gate (cancelled)."]
 *
 * `row-claim` turned that into "RED (a required check is failing)" and refused the author's next claim,
 * while `gh pr checks` on the same PR showed 6 success, 8 skipped, 1 in progress and NO failure -- it does
 * not list a cancelled check-run at all. Two tools, two answers, and the one an engineer reaches for first
 * is the one that hides it.
 *
 * NOT `SATISFIED`, WHICH IS THE TEMPTING WRONG FIX AND STRICTLY WORSE THAN THE BUG. Putting `cancelled`
 * beside `success` would let a merge proceed on a required context that never decided anything. The
 * distinction this module's own header draws is the one that matters: never-ran, still-running and failing
 * are different states because each sends the reader to a different fix. A cancelled context sends them
 * where a still-running one does -- ask again, the replacement run is already going -- so it is reported
 * under that sentence, with its own reason attached so nobody mistakes it for a job still in flight.
 *
 * `ci.yml`'s `gate` already carries the matching half (`if: always() && !cancelled()`, #902): a superseded
 * run should report nothing rather than a red. This is that same ruling applied to the READER, for the
 * cancelled conclusions already sitting on heads.
 */
// EXPORTED for #1100: `update-branch-sweep.mjs` reads the same conclusion and must mean the same thing by
// it. Two predicates in this repository disagreeing about the literal string `cancelled` is the
// fact-stated-twice shape on a value that decides whether a pull request is pushed.
export const NO_VERDICT = "cancelled";

/**
 * THE NEWEST RUN PER NAME -- #902, and it is a correctness fix rather than tidying.
 *
 * GitHub keeps every check run for a head, so one name appears once per workflow run: a cancelled or
 * superseded attempt sits in the list beside the one that actually decided. This module read EVERY entry
 * (`unfinished` and `failing` swept the whole array, and `new Map` kept whichever came last in it), so a
 * single cancelled run made a green pull request read red. **Measured on 2026-09-11: two different
 * sessions read #996 as red within twenty minutes, from a `gate` job in a run that had been cancelled
 * 22 seconds after it started.**
 *
 * BY ID, NOT BY `completedAt`: an id is monotonic and always present, while a run still in flight has no
 * completion time at all -- ordering on that would drop exactly the in-flight run the STILL RUNNING
 * sentence exists to report. A run carrying no id sorts oldest and ties go to array order, so a caller
 * that does not supply ids keeps precisely its previous behaviour rather than silently losing runs.
 *
 * @param {{id?: number, name: string, status: string, conclusion: string | null}[]} runs
 * @returns {{id?: number, name: string, status: string, conclusion: string | null}[]}
 */
export function newestPerName(runs) {
  /** @type {Map<string, {id?: number, name: string, status: string, conclusion: string | null}>} */
  const byName = new Map();
  for (const run of runs) {
    const seen = byName.get(run.name);
    if (!seen || (run.id ?? 0) >= (seen.id ?? 0)) byName.set(run.name, run);
  }
  return [...byName.values()];
}

/**
 * Is anything still going, so that a context with no run yet may simply not have started?
 *
 * A SUPERSEDED RUN COUNTS, and that is #1007's ruling rather than a convenience: a cancelled context
 * means a replacement run is already going, which is the same world as one in flight and the same
 * remedy. Taking only `inFlight` here would report an absence on a head whose replacement run has not
 * yet produced its check-runs -- the exact moment this is for.
 *
 * @param {string[]} inFlight
 * @param {string[]} superseded
 * @returns {boolean}
 */
function unfinishedElsewhere(inFlight, superseded) {
  return inFlight.length > 0 || superseded.length > 0;
}

/**
 * @param {{headRefOid: string}} pr
 * @param {string[]} required
 * @param {{id?: number, name: string, status: string, conclusion: string | null}[]} runs
 * @returns {string[]}
 */
export function checkReasons(pr, required, runs) {
  if (runs.length === 0) {
    return [`NO CHECK RUNS EXIST for head ${pr.headRefOid.slice(0, 10)} — not one, ever.\n`
      + "  Nothing has tested this code. This is the state that reads as `CLEAN`, because a required\n"
      + "  context that never ran is not a failing check; it is the absence of one."];
  }
  // #902: every sentence below is about the NEWEST run of each name. Reading all of them let a superseded
  // attempt speak for a context that has since concluded differently.
  const latest = newestPerName(runs);
  const byName = new Map(latest.map((run) => [run.name, run]));
  const missing = required.filter((context) => !byName.has(context));
  // #1007: a cancelled run joins the WAIT, annotated, and is kept out of `failing` so it cannot be both.
  const inFlight = latest.filter((run) => run.status !== "completed").map((run) => run.name);
  const superseded = latest.filter((run) => run.status === "completed" && run.conclusion === NO_VERDICT)
    .map((run) => `${run.name} (cancelled: superseded, so it reached no verdict)`);
  // #1009: A REQUIRED CONTEXT WITH NO RUN, WHILE SOMETHING ELSE IS STILL GOING, IS A WAIT.
  //
  // `gate` on this repository `needs: [changed, ts, python, ansible, changeset, rulesFitness]`, so it is
  // the LAST job to report on every single pull request and produces no check-run at all until its needs
  // finish. **That is the normal state of every `needs:`-gated aggregate for most of every run** -- and it
  // was reported with the same sentence as a job that was deleted, renamed, or never triggered.
  //
  // The two never-rans send a reader to different places: *ask again* versus *go and find out why that
  // job never fired*. Measured on #1008 at 23:3xZ: 15 runs, `ts / run` in flight, no `gate` at all,
  // everything else success or skipped -- a perfectly healthy mid-run pull request, reported as an
  // absence.
  //
  // JOINED TO `STILL RUNNING` WITH ITS OWN ANNOTATION RATHER THAN GIVEN A NEW SENTENCE, which is
  // #1007's shape in this same function one line up: a cancelled context reports under the wait it
  // shares a remedy with, annotated so nobody mistakes it for a job in flight. A new prefix would also
  // need a new entry in `reason-kind.mjs`, whose miss is SILENT -- an unmatched reason reads
  // `UNCLASSIFIED` -- so the sentence and its classification would be a second copy with nothing
  // comparing them. That file's own header says so.
  const waiting = unfinishedElsewhere(inFlight, superseded)
    ? missing.map((context) => `${context} (required, and no run has reported it yet)`)
    : [];
  const neverRan = waiting.length > 0 ? [] : missing;
  const unfinished = [...inFlight, ...superseded, ...waiting];
  const failing = latest.filter((run) => run.status === "completed"
    && run.conclusion !== NO_VERDICT && !SATISFIED.has(run.conclusion ?? ""))
    .map((run) => `${run.name} (${run.conclusion})`);

  // `.filter(Boolean)` does not narrow `(string | false)[]` to `string[]` -- a well-known TS gap, not a
  // behaviour bug -- so the predicate says so explicitly.
  return [
    neverRan.length > 0 && `REQUIRED CONTEXT NEVER RAN: ${neverRan.join(", ")}.\n`
      + "  Present-and-failing and never-ran are different states; this is the second.\n"
      + "  Every other run has CONCLUDED, so this is not \"not yet\": that job was removed, renamed, or\n"
      + "  never triggered. Go and find out which.",
    unfinished.length > 0 && `STILL RUNNING: ${unfinished.join(", ")}. Not a refusal forever — ask again.`,
    failing.length > 0 && `FAILING: ${failing.join(", ")}.`,
  ].filter(/** @returns {reason is string} */ (reason) => Boolean(reason));
}

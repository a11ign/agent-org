// module: ARMED MEANS "NOTHING LEFT TO ARM", AND ONE PLACE DECIDES WHETHER A PR IS ARMED -- core's side of it (#2046; moved into the GitHub plugin by A11-160, step 5)
//
// The rule (merged, auto-merging, or sitting in the merge queue), the queries that ask it and the reading of the queue's history all moved into `plugins/github/rows/armed-state.ts`, behind the code host's
// `rows`; they are GitHub's language. This file keeps the delegates under their old names, so `arm-pr.ts`, `auto-arm-sweep.ts` (which re-exports `armedFromApi`, because `work-gate.ts` reads it from there),
// `approved-unqueued.ts` and `queue-table.ts` still ask ONE definition, and it keeps the one thing that is core's: the verdict `arm-pr` and the sweep give about a pull request the queue ejected (#3487).
//
// It used to be leaf-shaped, importing nothing, because both arming doors ran under a bare `actions/checkout`. They still do: the delegates load the code host from the checkout's own `plugins/github` by
// `require` (`src/plugins/code-host-slot.ts`), which needs no install and no build.
import { delegate, delegates } from "./plugins/rows.ts";

export const { armedQueryArgs, armedFromApi, armedReason, ejectionQueryArgs, queueEjectionOf } = delegates("armedQueryArgs", "armedFromApi", "armedReason", "ejectionQueryArgs", "queueEjectionOf");

const readQueueEjection = delegate("readQueueEjection");

/**
 * #3487: THE ONE PLACE THE ARMING PATHS ASK "WAS THIS PR EJECTED, AND IS ITS HEAD UNMOVED?" -- `arm-pr` and the `auto-arm-sweep` both call it, so neither can queue what the other refuses. The code host's
 * `readQueueEjection` decides, this only asks it.
 *
 * Measured 2026-10-04 on `a11ign/a11ign#3460`: approved, CLEAN, head `11aa53a` throughout, armed by `a11ign-ci` FOUR times and ejected for `failed_checks` four times, each pass about seven minutes of CI on a run
 * that could only fail the same way. #3019 fixed the REPORT; the two doors that arm kept re-queueing.
 *
 * `cannot-ask` IS A REFUSAL TO ARM, NOT A CLEAR: a refused read is `null`, and `null` is never "not ejected" -- the direction `armabilityOf` already takes for an unreadable label list. Both callers already have
 * a "could not ask" outcome, and it is that one.
 *
 * `run` is the caller's own executor while the caller has not moved (the sweep's, the gate's), or absent: the code host runs it.
 */
export function ejectionVerdict({ number, repo, run }: { number: string | number; repo: string; run?: (ghArgs: string[]) => string; }): { kind: "clear"; } | { kind: "ejected" | "cannot-ask"; why: string; } {
  let ejection;
  try {
    ejection = readQueueEjection({ number, repo, run });
  } catch (cause) {
    return { kind: "cannot-ask", why: `could not read #${number}'s merge-queue history: ${(cause as Error).message}` };
  }
  if (ejection === null) return { kind: "cannot-ask", why: `the API did not return #${number}'s merge-queue history` };
  if (!ejection.ejected) return { kind: "clear" };
  return { kind: "ejected", why: `the merge queue EJECTED it for failed checks${ejection.removedAt ? ` at ${ejection.removedAt}` : ""} `
    + "and nothing has been pushed to its head since. Arming it again without a push re-enters the queue and fails the "
    + "same way (and makes the entries behind it rebuild); the remedy is a push to the head" };
}

// @ts-check
// A LEAF (`pr-hold-state.mjs` and `newest-check-run.mjs` import nothing): `org-retro.mjs` is a leaf `work-gate.mjs` imports before any
// build, so this file may not reach `work-gate/pr-orders.mjs`, which imports `work-gate.mjs` back.
//
// IS THIS PULL REQUEST BROKEN, OR RED ON PURPOSE? (#2954, ceo's retrospective of 2026-10-02). `deliberateRefusals` fails BY DESIGN on a PR
// carrying `hold:*` (`merge-guard.mjs --ci-gate`: "a hold is a decision somebody made by hand"), and the rolled-up `gate` fails with it, so
// #2883 read as a red PR for the whole of ceo's freeze. `merge-guard.mjs` records why that is not harmless: a deliberate red "trains people
// to skip the section" (#690). A report that counts a hold as a breakage is a number its source cannot say.
//
// ONE DECIDER, `isBrokenRed`, so the report's count and its `held` line cannot disagree about what a hold excuses.
import { newestPerName } from "./newest-check-run.mjs";
import { holdersOf } from "./pr-hold-state.mjs";

/** The conclusions that make a check red. A check still running, skipped or neutral is not red. */
export const RED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"]);

/**
 * The two jobs a `hold:` label turns red and nothing else does: `deliberateRefusals` (the job that runs `merge-guard.mjs --ci-gate`) and
 * `gate`, which is red only because it `needs` it. THE SAME LIST AS `work-gate/pr-orders.mjs`'s `HOLD_RED_JOBS`, copied because that file
 * cannot be imported from a leaf; `org-retro.test.ts` pins the two equal AND pins both to the jobs `ci.yml` defines.
 */
export const HOLD_OWN_JOBS = Object.freeze(["deliberateRefusals", "gate"]);

/** @param {any} check @returns {string} a check run names itself `name`, a status context `context` */
function nameOf(check) {
  return String(check?.name ?? check?.context ?? "");
}

/** `gh --json labels` gives `{ name }` objects; the gate's own fixtures give strings. @param {any} pr @returns {string[]} */
function labelNames(pr) {
  return (pr?.labels ?? []).map((/** @type {any} */ l) => String(l?.name ?? l));
}

/**
 * Every red check on the head, narrowed to the newest run of each name (a superseded run is unioned into `statusCheckRollup`, and a re-run
 * that passed must clear the red).
 * @param {{ statusCheckRollup?: any[] }} pr
 * @returns {{ name: string, failedAt: number }[]} `failedAt` is NaN when GitHub gave no completion time
 */
export function redChecks(pr) {
  return newestPerName(pr?.statusCheckRollup ?? [])
    .filter((/** @type {any} */ c) => RED_CONCLUSIONS.has(c.conclusion ?? ""))
    .map((/** @type {any} */ c) => ({ name: nameOf(c), failedAt: Date.parse(c.completedAt ?? "") }));
}

/**
 * The red checks that are a BREAKAGE. A held PR's own two jobs are the hold speaking, so they are left out; every other red on it is real, and
 * the hold does not hide it. Without a hold nothing is left out: `deliberateRefusals` failing on an unheld PR is #294's head-vs-tip race or
 * #549's `Closes` mismatch, and that is a broken PR.
 * @param {{ labels?: any[], statusCheckRollup?: any[] }} pr
 */
export function brokenChecks(pr) {
  const held = holdersOf(labelNames(pr)).length > 0;
  return redChecks(pr).filter((c) => !(held && HOLD_OWN_JOBS.includes(c.name)));
}

/** @param {{ labels?: any[], statusCheckRollup?: any[] }} pr @returns {boolean} red for a reason a hold does not explain */
export function isBrokenRed(pr) {
  return brokenChecks(pr).length > 0;
}

/**
 * Red ONLY because somebody holds it: at least one red check, every one of them the hold's own. Such a PR is reported on its own line and
 * never silently dropped, because a hold that outlives its reason is a PR nobody is looking at.
 * @param {{ labels?: any[], statusCheckRollup?: any[] }} pr
 */
export function isHeldRed(pr) {
  return redChecks(pr).length > 0 && !isBrokenRed(pr);
}

/** @param {{ labels?: any[] }} pr @returns {string[]} the `hold:<session>` labels, whole */
export function holdsOn(pr) {
  return holdersOf(labelNames(pr));
}

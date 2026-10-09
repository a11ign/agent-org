// @ts-check
// A LEAF (`pr-hold-state.ts` imports only the leaf `wait-condition.ts`, and `newest-check-run.ts` nothing): `org-retro.ts` is a leaf `work-gate.ts` imports before any
// build, so this file may not reach `work-gate/pr-orders.mjs`, which imports `work-gate.ts` back.
//
// IS THIS PULL REQUEST BROKEN, OR RED ON PURPOSE? (#2954, ceo's retrospective of 2026-10-02). `deliberateRefusals` fails BY DESIGN on a PR
// carrying `hold:*` (`merge-guard.ts --ci-gate`: "a hold is a decision somebody made by hand"), and the rolled-up `gate` fails with it, so
// #2883 read as a red PR for the whole of ceo's freeze. `merge-guard.ts` records why that is not harmless: a deliberate red "trains people
// to skip the section" (#690). A report that counts a hold as a breakage is a number its source cannot say.
//
// ONE DECIDER, `isBrokenRed`, so the report's count and its `held` line cannot disagree about what a hold excuses.
import { newestPerName } from "./newest-check-run.ts";
import { holdersOf } from "./pr-hold-state.ts";

/** The conclusions that make a check red. A check still running, skipped or neutral is not red. */
export const RED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"]);

/**
 * The two jobs a `hold:` label turns red and nothing else does: `deliberateRefusals` (the job that runs `merge-guard.ts --ci-gate`) and
 * `gate`, which is red only because it `needs` it. THE SAME LIST AS `work-gate/pr-orders.mjs`'s `HOLD_RED_JOBS`, copied because that file
 * cannot be imported from a leaf; `org-retro.test.ts` pins the two equal AND pins both to the jobs `ci.yml` defines.
 */
export const HOLD_OWN_JOBS = Object.freeze(["deliberateRefusals", "gate"]);

/** @param {any} check @returns {string} a check run names itself `name`, a status context `context` */
function nameOf(check: any): string {
  return String(check?.name ?? check?.context ?? "");
}

/** `gh --json labels` gives `{ name }` objects; the gate's own fixtures give strings. @param {any} pr @returns {string[]} */
function labelNames(pr: any): string[] {
  return (pr?.labels ?? []).map((l: any) => String(l?.name ?? l));
}

/**
 * Every red check on the head, narrowed to the newest run of each name (a superseded run is unioned into `statusCheckRollup`, and a re-run
 * that passed must clear the red).
 * @param {{ statusCheckRollup?: any[] }} pr
 * @returns {{ name: string, failedAt: number }[]} `failedAt` is NaN when GitHub gave no completion time
 */
export function redChecks(pr: { statusCheckRollup?: any[]; }): { name: string; failedAt: number; }[] {
  return newestPerName(pr?.statusCheckRollup ?? [])
    .filter((c: any) => RED_CONCLUSIONS.has(c.conclusion ?? ""))
    .map((c: any) => ({ name: nameOf(c), failedAt: Date.parse(c.completedAt ?? "") }));
}

/**
 * The red checks that are a BREAKAGE. A held PR's own two jobs are the hold speaking, so they are left out; every other red on it is real, and
 * the hold does not hide it. Without a hold nothing is left out: `deliberateRefusals` failing on an unheld PR is #294's head-vs-tip race or
 * #549's `Closes` mismatch, and that is a broken PR.
 *
 * `holdStands` IS WHETHER THE HOLD STILL EXCUSES (#2996). Its default is the label alone, which is what every caller before #2996
 * got and what `org-retro.ts` and `queue-table.ts` still ask; `org-health.mjs`'s reading passes `holdExcused`, so a hold whose
 * reason is gone stops hiding the red it caused.
 * @param {{ labels?: any[], statusCheckRollup?: any[] }} pr
 * @param {{ holdStands?: (pr: any) => boolean }} [options]
 */
export function brokenChecks(pr: { labels?: any[]; statusCheckRollup?: any[]; }, { holdStands = hasHolder }: { holdStands?: (pr: any) => boolean; } = {}) {
  const held = holdStands(pr);
  return redChecks(pr).filter((c) => !(held && HOLD_OWN_JOBS.includes(c.name)));
}

/** @param {{ labels?: any[] }} pr @returns {boolean} the label alone: a `hold:*` is on it */
const hasHolder = (pr: { labels?: any[]; }): boolean => holdersOf(labelNames(pr)).length > 0;

/**
 * @param {{ labels?: any[], statusCheckRollup?: any[] }} pr
 * @param {any} [options] `{ holdStands }` as `brokenChecks` takes it (#2996). TYPED `any` BECAUSE `.filter(isBrokenRed)` (`org-retro.ts`) hands a function its
 *   index second, and a number has no `holdStands`: the default is the label, which is what that caller asked before.
 * @returns {boolean} red for a reason a hold does not explain
 */
export function isBrokenRed(pr: { labels?: any[]; statusCheckRollup?: any[]; }, options?: any): boolean {
  return brokenChecks(pr, options?.holdStands ? options : undefined).length > 0;
}

/**
 * Red ONLY because somebody holds it: at least one red check, every one of them the hold's own. Such a PR is reported on its own line and
 * never silently dropped, because a hold that outlives its reason is a PR nobody is looking at.
 * @param {{ labels?: any[], statusCheckRollup?: any[] }} pr
 */
export function isHeldRed(pr: { labels?: any[]; statusCheckRollup?: any[]; }) {
  return redChecks(pr).length > 0 && !isBrokenRed(pr);
}

/** @param {{ labels?: any[] }} pr @returns {string[]} the `hold:<session>` labels, whole */
export function holdsOn(pr: { labels?: any[]; }): string[] {
  return holdersOf(labelNames(pr));
}

/**
 * THE PR AS IT WOULD STAND WITH ITS HOLD LIFTED: no `hold:*` label and without the hold's own two jobs, which are red only because of the label. For a
 * hold that no longer excuses (#2996), so "could this merge" is asked of the PR a person would find once they removed it.
 * @param {{ labels?: any[], statusCheckRollup?: any[] }} pr
 */
export function withoutHold(pr: { labels?: any[]; statusCheckRollup?: any[]; }) {
  return { ...pr,
    labels: (pr.labels ?? []).filter((l: any) => !holdersOf([String(l?.name ?? l)]).length),
    statusCheckRollup: newestPerName(pr.statusCheckRollup ?? []).filter((c: any) => !HOLD_OWN_JOBS.includes(nameOf(c))) };
}

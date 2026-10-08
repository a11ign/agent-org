// @ts-check
// FOUND BY THE CHAIRMAN: a counted label, with the target zero printed beside the count (a11ign/a11ign#4124, child C of #4122).
//
// The chairman is the org's detector of last resort and nothing counted how often he is the one who finds a thing; #3486's done-when 3 asked
// for this and was never built. A row the chairman or his session originated carries the label `found-by-chairman`, applied by hand by `ceo`
// and `product-manager` (his own message and `needs:chairman` answers are the evidence). This module counts them per UTC week.
//
// THE POPULATION IS ROWS, NOT CHANGES. `hand-fix-ledger.mjs` counts CHANGES a human-side author made; this counts ROWS the chairman
// originated. They are different populations and the two numbers are not merged.
//
// A ROW IS COUNTED IN THE WEEK ITS OPENING FALLS IN, not the week it was labelled or closed: the label is applied after the fact, so a
// count by labelling date would move the week a finding belongs to.
//
// ABSENCE IS NOT ZERO (`.agent-org/roles/engineer.md`). A refused read, or a labelled row whose opening cannot be read, makes the count
// `null` and the line says `unknown`; only a read that succeeded may print `0`. The previous week says `no baseline` when it begins before
// the label was first applied, because a zero from a week nobody was labelling is not a reading.
import { verdictFor } from "./org-retro.mjs";

export const LABEL = "found-by-chairman";
/** The count the org aims for: the chairman finding nothing the org had not found first. */
export const TARGET = 0;
/** The first UTC day rows were labelled (the backfill of #4124 starts here); a week that begins earlier was not being labelled. */
export const LABELLED_FROM = "2026-10-02T00:00:00Z";

const MS_PER_DAY = 86_400_000;
const DAYS_PER_WEEK = 7;
const DAY_LENGTH = "YYYY-MM-DD".length;
const COUNT_ID = "foundByChairman";

/** @typedef {{ since: string, until: string }} Week `since` inclusive, `until` exclusive, both midnight UTC */
/** @typedef {{ number: number, createdAt?: string, labelNames: string[] }} Row an issue as `board-data.mjs`'s `issues()` returns it */

/** @param {Date} date @returns {string} `YYYY-MM-DDT00:00:00Z` */
const midnight = (date) => `${date.toISOString().slice(0, DAY_LENGTH)}T00:00:00Z`;

/**
 * The seven whole UTC days before `now`'s day (`scripts/ci-health.mjs`'s `weeklyWindow`, so a Monday run reads Monday to Sunday), and the seven before those.
 * @param {Date} now @returns {{ current: Week, previous: Week }}
 */
export function weeksBefore(now) {
  const today = Date.parse(midnight(now));
  const at = (/** @type {number} */ weeksBack) => midnight(new Date(today - weeksBack * DAYS_PER_WEEK * MS_PER_DAY));
  return { current: { since: at(1), until: at(0) }, previous: { since: at(2), until: at(1) } };
}

/**
 * The numbers of the labelled rows opened in `week`, or `null` when a labelled row's opening cannot be read (that row might belong to the week).
 * @param {Row[]} rows @param {Week} week @returns {number[] | null}
 */
function opened(rows, week) {
  const labelled = rows.filter((r) => r.labelNames.includes(LABEL));
  const times = labelled.map((r) => Date.parse(r.createdAt ?? ""));
  if (times.some(Number.isNaN)) return null;
  return labelled.filter((_, i) => times[i] >= Date.parse(week.since) && times[i] < Date.parse(week.until)).map((r) => r.number).sort((a, b) => a - b);
}

/**
 * @param {Row[] | null} rows every issue of the tracker, or `null` when the listing was refused
 * @param {Date} now
 * @returns {{ week: Week, previousWeek: Week, count: number | null, numbers: number[], previousCount: number | null, verdict: string }}
 */
export function foundByChairman(rows, now) {
  const { current, previous } = weeksBefore(now);
  const numbers = rows === null ? null : opened(rows, current);
  const previousNumbers = rows === null ? null : opened(rows, previous);
  const count = numbers === null ? null : numbers.length;
  // A week that began before the first labelling is not a baseline, whatever it counts.
  const previousCount = previousNumbers === null || previous.since < LABELLED_FROM ? null : previousNumbers.length;
  const prior = { status: previous.since < LABELLED_FROM ? "none" : "read", numbers: { [COUNT_ID]: previousCount } };
  const unreadable = rows === null || previousNumbers === null;
  const verdict = verdictFor({ better: "lower", previous: unreadable ? { status: "unreadable" } : prior, id: COUNT_ID, current: count });
  return { week: current, previousWeek: previous, count, numbers: numbers ?? [], previousCount, verdict };
}

/** @param {Week} week @returns {string} `2026-10-01 to 2026-10-07`: the last day INCLUDED, not the exclusive bound */
const spanOf = ({ since, until }) => `${since.slice(0, DAY_LENGTH)} to ${new Date(Date.parse(until) - MS_PER_DAY).toISOString().slice(0, DAY_LENGTH)}`;

/** @param {ReturnType<typeof foundByChairman>} report @returns {string} one line: the count, the target beside it, the rows, and the previous week with its direction word */
export function foundByChairmanLine(report) {
  const shown = report.count === null ? "unknown" : String(report.count);
  const rows = report.numbers.length === 0 ? "" : ` (${report.numbers.map((n) => `#${n}`).join(", ")})`;
  const was = report.verdict === "no baseline" ? "no baseline" : `${report.previousCount ?? "unknown"} (${report.verdict})`;
  return `week ${spanOf(report.week)}: ${shown} (target ${TARGET})${rows}; previous week ${spanOf(report.previousWeek)}: ${was}`;
}

// @ts-check
// FOUND BY THE CHAIRMAN: a counted label, with the target zero printed beside the count (a11ign/a11ign#4124, child C of #4122).
//
// The chairman is the org's detector of last resort and nothing counted how often he is the one who finds a thing; #3486's done-when 3 asked
// for this and was never built. A row the chairman or his session originated carries the label `found-by-chairman`, applied by hand by `ceo`
// and `product-manager` (his own message and `needs:chairman` answers are the evidence). This module counts them per UTC week.
//
// THE POPULATION IS ROWS, NOT CHANGES. `hand-fix-ledger.ts` counts CHANGES a human-side author made; this counts ROWS the chairman
// originated. They are different populations and the two numbers are not merged.
//
// A ROW IS COUNTED IN THE WEEK ITS OPENING FALLS IN, not the week it was labelled or closed: the label is applied after the fact, so a
// count by labelling date would move the week a finding belongs to.
//
// ABSENCE IS NOT ZERO (`.agent-org/roles/engineer.md`). A refused tracker listing never reaches this module: `board-data.ts`'s `issues()` throws,
// so the document is not built and no `0` is printed. What can reach it is a labelled row whose opening cannot be read; that makes the count
// `null` and the line says `unknown`, because only a read that succeeded may print `0`. The previous week says `no baseline` when it begins before
// the label was first applied, because a zero from a week nobody was labelling is not a reading.
//
// CORRECTIONS PER UTC DAY (a11ign/a11ign#4453, epic #4437's headline metric) is the other population: the `chairman-correction` entries of the failure
// ledger, and a correction usually has no row. The two are not merged. `unidentified-caller-order` is the PROXY for a chairman-session order (#4452) and is
// NOT a correction: it is counted nowhere here. `chairman-correction` itself has no recorder yet, so a day printed `0` is a day with no such ENTRY, and the
// line says which kind it counts.
import type { FailureEntry } from "./failure-ledger.ts";
import { verdictFor } from "./org-retro.ts";

export const LABEL = "found-by-chairman";
/** The count the org aims for: the chairman finding nothing the org had not found first. */
export const TARGET = 0;
/** The first UTC day rows were labelled (the backfill of #4124 starts here); a week that begins earlier was not being labelled. */
export const LABELLED_FROM = "2026-10-02T00:00:00Z";

const MS_PER_DAY = 86_400_000;
const DAYS_PER_WEEK = 7;
const DAY_LENGTH = "YYYY-MM-DD".length;
const COUNT_ID = "foundByChairman";

/** `since` inclusive, `until` exclusive, both midnight UTC */
export type Week = { since: string, until: string };
/** an issue as `board-data.ts`'s `issues()` returns it */
export type Row = { number: number, createdAt?: string, labelNames: string[] };

/** @param {Date} date @returns {string} `YYYY-MM-DDT00:00:00Z` */
const midnight = (date: Date): string => `${date.toISOString().slice(0, DAY_LENGTH)}T00:00:00Z`;

/**
 * The seven whole UTC days before `now`'s day (`scripts/ci-health.mjs`'s `weeklyWindow`, so a Monday run reads Monday to Sunday), and the seven before those.
 * @param {Date} now @returns {{ current: Week, previous: Week }}
 */
export function weeksBefore(now: Date): { current: Week; previous: Week; } {
  const today = Date.parse(midnight(now));
  const at = (weeksBack: number) => midnight(new Date(today - weeksBack * DAYS_PER_WEEK * MS_PER_DAY));
  return { current: { since: at(1), until: at(0) }, previous: { since: at(2), until: at(1) } };
}

/**
 * The numbers of the labelled rows opened in `week`, or `null` when a labelled row's opening cannot be read (that row might belong to the week).
 * @param {Row[]} rows @param {Week} week @returns {number[] | null}
 */
function opened(rows: Row[], week: Week): number[] | null {
  const labelled = rows.filter((r) => r.labelNames.includes(LABEL));
  const times = labelled.map((r) => Date.parse(r.createdAt ?? ""));
  if (times.some(Number.isNaN)) return null;
  return labelled.filter((_, i) => times[i] >= Date.parse(week.since) && times[i] < Date.parse(week.until)).map((r) => r.number).sort((a, b) => a - b);
}

/**
 * @param {Row[]} rows every issue of the tracker, the listing `issues()` proved complete
 * @param {Date} now
 * @returns {{ week: Week, previousWeek: Week, count: number | null, numbers: number[], previousCount: number | null, verdict: string }}
 */
export function foundByChairman(rows: Row[], now: Date): { week: Week; previousWeek: Week; count: number | null; numbers: number[]; previousCount: number | null; verdict: string; } {
  const { current, previous } = weeksBefore(now);
  const numbers = opened(rows, current);
  const previousNumbers = opened(rows, previous);
  const count = numbers === null ? null : numbers.length;
  // A week that began before the first labelling is not a baseline, whatever it counts.
  const previousCount = previousNumbers === null || previous.since < LABELLED_FROM ? null : previousNumbers.length;
  const prior = { status: previous.since < LABELLED_FROM ? "none" : "read", numbers: { [COUNT_ID]: previousCount } };
  const verdict = verdictFor({ better: "lower", previous: previousNumbers === null ? { status: "unreadable" } : prior, id: COUNT_ID, current: count });
  return { week: current, previousWeek: previous, count, numbers: numbers ?? [], previousCount, verdict };
}

/** @param {Week} week @returns {string} `2026-10-01 to 2026-10-07`: the last day INCLUDED, not the exclusive bound */
const spanOf = ({ since, until }: Week): string => `${since.slice(0, DAY_LENGTH)} to ${new Date(Date.parse(until) - MS_PER_DAY).toISOString().slice(0, DAY_LENGTH)}`;

/** @param {ReturnType<typeof foundByChairman>} report @returns {string} one line: the count, the target beside it, the rows, and the previous week with its direction word */
export function foundByChairmanLine(report: ReturnType<typeof foundByChairman>): string {
  const shown = report.count === null ? "unknown" : String(report.count);
  const rows = report.numbers.length === 0 ? "" : ` (${report.numbers.map((n) => `#${n}`).join(", ")})`;
  const was = report.verdict === "no baseline" ? "no baseline" : `${report.previousCount ?? "unknown"} (${report.verdict})`;
  return `week ${spanOf(report.week)}: ${shown} (target ${TARGET})${rows}; previous week ${spanOf(report.previousWeek)}: ${was}`;
}

/** What a day's count can be besides a number: the ledger could not be read, or the day is before the ledger's first line. */
export type DayCount = number | "unknown" | "no baseline";
export type Day = { day: string, count: DayCount };

/** The ledger key this metric counts, and only this one. */
export const CORRECTION_KIND = "chairman-correction";

/**
 * Corrections per UTC day for the seven whole days before `now`'s day, oldest first, and the day-over-day trend of the last two.
 * ABSENCE IS NOT ZERO: `entries` is `null` when the ledger could not be read (every day `unknown`), and a day before the ledger's first line, of any kind, is
 * `no baseline`. A ledger that was read and holds no line has no first line, so every day is `no baseline`.
 * @param {FailureEntry[] | null} entries the parsed ledger, `null` when unreadable @param {Date} now
 * @returns {{ days: Day[], verdict: string }}
 */
export function correctionsPerDay(entries: FailureEntry[] | null, now: Date): { days: Day[]; verdict: string; } {
  const today = Date.parse(midnight(now));
  const first = entries === null || entries.length === 0 ? Infinity : Math.min(...entries.map((entry) => entry.at));
  const days = Array.from({ length: DAYS_PER_WEEK }, (_, i) => {
    const since = today - (DAYS_PER_WEEK - i) * MS_PER_DAY;
    return { day: new Date(since).toISOString().slice(0, DAY_LENGTH), since };
  }).map(({ day, since }): Day => {
    if (entries === null) return { day, count: "unknown" };
    if (since + MS_PER_DAY <= first) return { day, count: "no baseline" };
    return { day, count: entries.filter((entry) => entry.classKey === CORRECTION_KIND && entry.at >= since && entry.at < since + MS_PER_DAY).length };
  });
  return { days, verdict: dayOverDay(days) };
}

/** @param {Day[]} days @returns {string} the last day against the one before it, by `verdictFor`; a day that is not a number is `unknown` or `no baseline`, never a delta against 0 */
function dayOverDay(days: Day[]): string {
  const [before, last] = days.slice(-2).map((d) => d.count);
  if (last === "unknown" || before === "unknown") return "unknown";
  if (typeof last !== "number" || typeof before !== "number") return "no baseline";
  return verdictFor({ better: "lower", previous: { status: "read", numbers: { [COUNT_ID]: before } }, id: COUNT_ID, current: last });
}

/** @param {ReturnType<typeof correctionsPerDay>} report @returns {string} one line: each day with its date, the target, the trend, and what is counted */
export function correctionsLine({ days, verdict }: ReturnType<typeof correctionsPerDay>): string {
  const perDay = days.map(({ day, count }) => `${day.slice(DAY_LENGTH - "MM-DD".length)} ${count}`).join(", ");
  return `Chairman corrections per UTC day (target ${TARGET}): ${perDay}; last day against the one before: ${verdict} (counts \`${CORRECTION_KIND}\` ledger entries; \`unidentified-caller-order\` is not a correction)`;
}

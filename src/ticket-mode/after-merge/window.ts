// @ts-check
// module: when a verifier run may begin (A11-361) -- an `agent` check about a delay after release ("7 days after release", "over 7 days") is scheduled for release + window and shown as due, never run, and so never failed, before its window ends. PURE
//
// A CHECK ABOUT A WEEK CANNOT BE ANSWERED IN MINUTES. On 2026-10-27 the board gave such checks to a verifier run minutes after their ticket closed. The run could only say "re-run on or after <date>", which closed the check failed and filed
// a chore each time. The delay is read from the plan's `Window:` (the planner names it) or, failing that, from the words of the line. The window begins when the change reads as installed, as a `board` check's does (`installed.ts`), and
// the check is due `window` later: until then it is not given to a run.
import { WINDOW_MAX_MS } from "./observe.ts";
import type { CheckRecord, ChecksFile } from "./checks.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const UNIT_MS: Readonly<Record<string, number>> = { minute: MINUTE_MS, hour: HOUR_MS, day: DAY_MS, week: 7 * DAY_MS };
const NUMBER_WORDS: Readonly<Record<string, number>> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14 };

const COUNT = "(\\d+|a|one|two|three|four|five|six|seven|ten|fourteen)[\\s-]*";
const LONG_UNIT = "(day|week)s?";
const ANY_UNIT = "(minute|hour|day|week)s?";
/** "7 days after release", "a week after the merge": a count of time, then "after" and, within a few words, the event it is counted from. A delay after a restart or a clean cache is no release window. */
const AFTER = new RegExp(`\\b${COUNT}${ANY_UNIT}\\s+after\\b[^.,;]{0,30}?\\b(?:release|merge|install|deploy|ship|rollout|go-live)`, "i");
/** "over 7 days", "for a week", "across the next 3 days": days or weeks the check looks over, which have to pass before it can say. Minutes and hours are never read this way: "stalled for 2 hours" is a threshold, not a window. */
const OVER = new RegExp(`\\b(?:over|for|across)\\s+(?:the\\s+next\\s+|a\\s+full\\s+)?${COUNT}${LONG_UNIT}\\b`, "i");

/** The time a line says has to pass before it can be checked ("7 days after release", "over 7 days", "for a week"), in milliseconds, or null when it says none. A delay longer than a window may be is ignored. PURE. */
export function delayInLine(line: string): number | null {
  const [, count, unit] = AFTER.exec(line) ?? OVER.exec(line) ?? [];
  if (count === undefined) return null;
  const ms = (Number(count) || NUMBER_WORDS[count.toLowerCase()]) * UNIT_MS[unit.toLowerCase()];
  return ms > 0 && ms <= WINDOW_MAX_MS ? ms : null;
}

/**
 * How long after its release a check must wait: the plan's `Window:` when it gave one, else what the line says; null when the check has no delay. A check the board watched (`observe`) or handed to an agent after its own window
 * closed has none: its window is over, and its line must not delay it a second time. PURE.
 */
export const delayOf = (check: Pick<CheckRecord, "line" | "windowMs" | "observe" | "handedOff">): number | null =>
  check.observe !== undefined || check.handedOff !== undefined ? null : check.windowMs ?? delayInLine(check.line);

/** Whether an open check is held back by its delay at `now`: it has one, and its window has not ended (or has not begun, because the change is not installed yet). PURE. */
export const awaitsWindow = (check: CheckRecord, now: number): boolean => delayOf(check) !== null && (check.dueAt === undefined || now < check.dueAt);

/** Whether an open `agent` check is one the board schedules: it has a delay and no due time yet. */
const toSchedule = (check: CheckRecord): boolean => check.state === "open" && check.runner === "agent" && check.dueAt === undefined && delayOf(check) !== null;

/** The file with every open `agent` check that has a delay, no due time yet and a change that reads as installed given `dueAt`: `now` plus its delay. Returns `file` itself when none is scheduled. PURE. */
export function scheduleWindows(file: ChecksFile, installed: (check: CheckRecord) => boolean, now: number): ChecksFile {
  const scheduled = Object.values(file.checks).filter((check) => toSchedule(check) && installed(check));
  if (scheduled.length === 0) return file;
  return { checks: { ...file.checks, ...Object.fromEntries(scheduled.map((check) => [check.id, { ...check, dueAt: now + (delayOf(check) ?? 0) }])) } };
}

/** What a verifier run wrote when it could not answer yet: "re-run on or after <date>", "the 7-day window has not elapsed". A failure that says what was seen is not this. */
const NOT_YET = /re-?run on or after|(?:window|week|days?)[^.]{0,40}\b(?:has|have|had) not (?:yet )?(?:elapsed|ended|passed|closed)|not (?:yet )?(?:elapsed|ended)\b|cannot be observed yet|too early/i;

/**
 * Whether a check was closed failed by the board or a verifier run before its delay could have passed: it is an `agent` check (one the board watched has no delay of its own, `delayOf`), its evidence says its window had not ended, and it closed less than its delay after
 * its run merged, and a release is never earlier than the merge.
 */
const closedTooSoon = (check: CheckRecord): boolean => {
  const delay = delayOf(check);
  return check.state === "failed" && NOT_YET.test(check.result ?? "") && (check.closedBy === "board" || check.closedBy === "agent") && delay !== null && check.closedAt !== undefined && check.closedAt < check.listedAt + delay;
};

/**
 * The file with each check that was closed failed before its window could end opened again and scheduled (A11-361): the one-off move of the checks that filed a "re-run on or after" chore into the mechanism. It is due its delay after the
 * close, which is after its release, so it is never early. What its close recorded (result, closer, post, follow-up and verifier) is dropped; the ticket keeps the comment that was posted. Returns `file` itself when none is. PURE.
 */
export function reopenClosedTooSoon(file: ChecksFile): ChecksFile {
  const early = Object.values(file.checks).filter(closedTooSoon);
  if (early.length === 0) return file;
  const reopened = early.map(({ result: _result, closedBy: _by, posted: _posted, followUp: _followUp, verifier: _verifier, closedAt, ...check }) => ({ ...check, state: "open" as const, dueAt: (closedAt ?? 0) + (delayOf(check) ?? 0) }));
  return { checks: { ...file.checks, ...Object.fromEntries(reopened.map((check) => [check.id, check])) } };
}

/** When a check is due, as the board shows it: "due 2026-11-03", or null for a check with no due time. PURE. */
export const dueWords = (check: Pick<CheckRecord, "dueAt">): string | null => (check.dueAt === undefined ? null : `due ${new Date(check.dueAt).toISOString().slice(0, 10)}`);

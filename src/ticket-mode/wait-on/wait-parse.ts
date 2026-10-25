// A leaf of ticket mode, run by no command: the shape check of what a `working` outcome declares it waits on and by when (A11-245). PURE. The outcome file's check calls it, and a refusal is text that names the field and what the file wrote,
// as every refusal of that check does. Items are checked for SHAPE only: whether the job, run, pull request or ticket exists is the board's reading, later.
import { type Wait, waitKey } from "./wait-types.ts";

/** The most items one wait may declare. */
export const MAX_WAITS = 20;

/** The item keys a declaration may carry, and the keys that go with each subject: a subject is exactly one of them, and `until` goes with `pullRequest` and `ticket` only. */
const SUBJECTS = ["fleetJob", "ciRun", "pullRequest", "ticket", "session"] as const;

/** The longest ask a `session` item may write. */
export const MAX_ASK_CHARS = 1000;
const UNTIL_VALUES: Readonly<Record<string, readonly string[]>> = { pullRequest: ["merged", "reviewed"], ticket: ["done"] };

/** A fleet job ID: it starts with a letter or digit, so it can never be read as an option of the program it is handed to. */
const FLEET_JOB = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Whether a string is a fleet job ID: the one place that decides it, for the parse and again before the ID is handed to the `fleet` program. */
export const isFleetJobId = (id: string): boolean => FLEET_JOB.test(id);
const CI_RUN = /^([\w.-]+\/[\w.-]+)#([1-9][0-9]{0,14})$/;
/** A GitHub pull request's address. */
export const PULL_REQUEST_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9][0-9]*(?:[/?#]\S*)?$/;
const TICKET_KEY = /^[A-Za-z][A-Za-z0-9]*-[1-9][0-9]*$/;

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The longest string a refusal quotes back. */
const QUOTED_CHARS = 80;

/** What a value is, as a refusal names it. */
function wrote(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? "an empty list" : "a list";
  if (typeof value === "string") return value.trim() === "" ? "an empty string" : JSON.stringify(value.length > QUOTED_CHARS ? `${value.slice(0, QUOTED_CHARS)}...` : value);
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/** The subject key an item names (exactly one of {@link SUBJECTS}, and no key it does not take), or why it names none. */
function subjectKeyOf(item: Record<string, unknown>, at: string): string {
  const subjects = SUBJECTS.filter((name) => name in item);
  if (subjects.length !== 1) return `${at} needs exactly one of ${SUBJECTS.join(", ")}, you wrote ${subjects.length === 0 ? `${Object.keys(item).join(", ") || "no keys"}` : subjects.join(" and ")}`;
  const subject = subjects[0];
  const allowed: readonly string[] = subject in UNTIL_VALUES ? [subject, "until"] : [subject];
  const extra = Object.keys(item).filter((name) => !allowed.includes(name));
  return extra.length === 0 ? subject : `${at} (${subject}) has ${extra.join(", ")}, which it does not take${subject in UNTIL_VALUES ? "" : "; until goes only with pullRequest and ticket"}`;
}

/** The event a subject's value names, once its `until` (if it takes one) has been checked, or why the value is not one. */
function waitOf(subject: string, value: string, until: unknown, at: string): Wait | string {
  switch (subject) {
    case "fleetJob":
      return isFleetJobId(value) ? { kind: "fleetJob", id: value } : `${at} fleetJob needs a job ID of letters, digits, dots, dashes and underscores (up to 64), you wrote ${wrote(value)}`;
    case "ciRun": {
      const match = CI_RUN.exec(value);
      return match === null ? `${at} ciRun needs <owner>/<repo>#<run id>, you wrote ${wrote(value)}` : { kind: "ciRun", repository: match[1], runId: Number(match[2]) };
    }
    case "pullRequest":
      return PULL_REQUEST_URL.test(value) ? { kind: "pullRequest", url: value, until: until as "merged" | "reviewed" } : `${at} pullRequest needs a GitHub pull request address, you wrote ${wrote(value)}`;
    case "session": {
      const ask = value.trim();
      if (ask === "") return `${at} session needs the exact ask for the person's session, you wrote ${wrote(value)}`;
      return ask.length > MAX_ASK_CHARS ? `${at} session takes an ask of up to ${MAX_ASK_CHARS} characters, you wrote ${ask.length}` : { kind: "session", ask };
    }
    default:
      return TICKET_KEY.test(value) ? { kind: "ticket", key: value, until: "done" } : `${at} ticket needs a ticket key such as A11-1, you wrote ${wrote(value)}`;
  }
}

/** One declared item as a {@link Wait}, or why it is not one. */
function itemOf(item: unknown, at: string): Wait | string {
  if (!isObject(item)) return `${at} needs an object with one of ${SUBJECTS.join(", ")}, you wrote ${wrote(item)}`;
  const subject = subjectKeyOf(item, at);
  if (!(SUBJECTS as readonly string[]).includes(subject)) return subject;
  const value = item[subject];
  if (typeof value !== "string") return `${at} ${subject} needs a string, you wrote ${wrote(value)}`;
  const until = item.until;
  if (subject in UNTIL_VALUES && (typeof until !== "string" || !UNTIL_VALUES[subject].includes(until))) return `${at} ${subject} needs until: one of ${UNTIL_VALUES[subject].join(" or ")}, you wrote ${wrote(until)}`;
  return waitOf(subject, value, until, at);
}

/**
 * The items a `working` outcome's `waitingOn` declares, in the order written with a repeat dropped, or why the value is not a declared wait: it must be a list of 1 to {@link MAX_WAITS} items, each with exactly one of `fleetJob`,
 * `ciRun`, `pullRequest`, `ticket` and `session`, and `until` on `pullRequest` and `ticket` only. A string `waitingOn` is not a declared wait (it names background work the worker's own shell holds), so the caller never hands one here. PURE.
 */
export function parseWaits(value: unknown): readonly Wait[] | string {
  if (!Array.isArray(value)) return `waitingOn needs a list of events to wait on, you wrote ${wrote(value)}`;
  if (value.length === 0) return "waitingOn needs at least one event, you wrote an empty list";
  if (value.length > MAX_WAITS) return `waitingOn takes up to ${MAX_WAITS} events, you wrote ${value.length}`;
  const waits = new Map<string, Wait>();
  for (const [index, item] of value.entries()) {
    const wait = itemOf(item, `waitingOn[${index}]`);
    if (typeof wait === "string") return wait;
    waits.set(waitKey(wait), wait);
  }
  return [...waits.values()];
}

/** An ISO time written the way a worker writes one: a date, a `T`, a time and a zone or none. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/** The deadline a `working` outcome's `until` names, in epoch milliseconds, or why it is not a time the board can read. A time with no zone is UTC, as the board's own are. PURE. */
export function parseUntil(value: unknown): number | string {
  if (typeof value !== "string" || !ISO_TIME.test(value)) return `until needs an ISO time such as 2026-10-25T12:00:00Z, you wrote ${wrote(value)}`;
  const at = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`);
  return Number.isFinite(at) && namesRealDay(value) ? at : `until needs an ISO time such as 2026-10-25T12:00:00Z, you wrote ${wrote(value)}`;
}

/** Whether the date a time starts with is a day that exists: the date parser rolls 31 February over to 3 March, and a typo would then move the deadline by days. */
function namesRealDay(time: string): boolean {
  const [year, month, day] = time.slice(0, "YYYY-MM-DD".length).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

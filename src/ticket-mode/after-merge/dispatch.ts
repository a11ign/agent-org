// @ts-check
// module: where each After-merge check is sent (A11-277) -- the session's queue or the person's Needs you, when it was sent, and the one overdue reminder. PURE
//
// THE BOARD REACHES TWO RUNNERS. A person check on the escalation list (A11-257) waits under Needs you and is never sent to the session; every other open check the board does not watch is the session's, listed in its
// queue (`session-asks.ts`), which is read, not pushed. So a check is "sent" the first time that queue lists it (a Needs-you check, the first sweep that shows it to the person), and "sent again" by moving `sentAt` to
// when it fell overdue, so a session reading the asks since its last read sees it once more. A check falls overdue ONCE: 7 days after it was sent, or after the board began to watch it for a board check, and never
// again after that. Neither clock starts at the run's finish: a line seeded from a run that merged weeks ago is new to its runner.
import { escalationItem, type EscalationItem } from "../escalation.ts";
import type { CheckRecord, ChecksFile, Runner } from "./checks.ts";

/** How long an open check waits on its runner before it is sent again, once, marked overdue. */
export const OVERDUE_MS = 7 * 24 * 60 * 60 * 1000;

/** The escalation item an open check waits on the person for, under Needs you: the one a person check's plan names. Undefined for any other check, and for an id that is not on the list. PURE. */
export const personItemOf = (check: CheckRecord): EscalationItem | undefined => (check.state === "open" && check.runner === "person" ? escalationItem(check.escalation) : undefined);

/** Whether an open check waits on the person under Needs you. PURE. */
export const waitsOnPerson = (check: CheckRecord): boolean => personItemOf(check) !== undefined;

/** Whether an open check is the session's to run: a session check, or a person check on no escalation item, which the session closes or answers that it needs the person. A board check is the board's until it is overdue. PURE. */
export const sentToSession = (check: CheckRecord): boolean => check.state === "open" && check.runner !== "board" && !waitsOnPerson(check);

/** Who an open check is sent to, as its row says it: a person check on no escalation item is the session's. A closed check keeps its runner. PURE. */
export const runnerSentTo = (check: CheckRecord): Runner => (check.runner === "person" && sentToSession(check) ? "session" : check.runner);

/** The checks in `file` that `change` gives a new record, merged over it; `file` itself when it gives none. */
function withChanged(file: ChecksFile, change: (check: CheckRecord) => CheckRecord | null): ChecksFile {
  const changed = Object.values(file.checks).flatMap((check) => change(check) ?? []);
  return changed.length === 0 ? file : { checks: { ...file.checks, ...Object.fromEntries(changed.map((check) => [check.id, check])) } };
}

/** The file with `sentAt` set to `now` on every check `sent` picks that has not been sent. Returns `file` itself when every one was sent already. PURE. */
const markSentWhere = (file: ChecksFile, now: number, sent: (check: CheckRecord) => boolean): ChecksFile =>
  withChanged(file, (check) => (sent(check) && check.sentAt === undefined ? { ...check, sentAt: now } : null));

/** The file with `sentAt` set to `now` on every check the session's queue lists for the first time. Returns `file` itself when every one was sent already. PURE. */
export const markSent = (file: ChecksFile, now: number): ChecksFile => markSentWhere(file, now, sentToSession);

/** The file with `sentAt` set to `now` on every check the sweep shows under Needs you for the first time. Returns `file` itself when every one was shown already. PURE. */
export const markShownToPerson = (file: ChecksFile, now: number): ChecksFile => markSentWhere(file, now, waitsOnPerson);

/** When an open check's 7 days start: when the board began to watch it, for a board check, and when it was sent otherwise. Undefined for a check not sent yet. PURE. */
const waitingSince = (check: CheckRecord): number | undefined => (check.runner === "board" ? check.observe?.from ?? check.listedAt : check.sentAt);

/** Whether an open check that was never overdue has waited {@link OVERDUE_MS} on its runner by `now`. PURE. */
function fallsOverdue(check: CheckRecord, now: number): boolean {
  const since = waitingSince(check);
  return check.state === "open" && check.overdueAt === undefined && since !== undefined && now - since >= OVERDUE_MS;
}

/**
 * The file with every open check that has waited {@link OVERDUE_MS} on its runner, and was never overdue, marked overdue at `now`. A session check is sent again: its `sentAt` moves to `now`. A board check nobody saw pass
 * becomes the session's, sent at `now`, and keeps what it watches, so the board can still pass it. A Needs-you check stays the person's, marked overdue. Returns `file` itself when none falls overdue. PURE.
 */
export function markOverdue(file: ChecksFile, now: number): ChecksFile {
  return withChanged(file, (check) => {
    if (!fallsOverdue(check, now)) return null;
    if (waitsOnPerson(check)) return { ...check, overdueAt: now };
    return { ...check, runner: check.runner === "board" ? "session" : check.runner, sentAt: now, overdueAt: now };
  });
}

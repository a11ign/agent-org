// @ts-check
// module: where each After-merge check waits (A11-277, A11-302) -- under Needs you for a person's, with the board or a verifier run for the org's, and what happens to a check nobody has settled in a week. PURE
//
// THE ORG VERIFIES ITS OWN WORK. A person check on an item of the escalation list (A11-257) waits under Needs you and nowhere else. Every other check is the org's: the board watches a `board` check (`observe.ts`), and a verifier run
// after release checks an `agent` check (`verify.ts`). The person's session runs none of them (A11-302): it may read them on the ticket's Run detail, as anyone can. A `board` check the board could not settle is handed to an agent,
// so a check that waits on no one cannot exist; a Needs-you check that waited 7 days is marked overdue, once.
import { escalationItem, type EscalationItem } from "../escalation.ts";
import { isWindowed, windowEnd } from "./observe.ts";
import type { CheckRecord, ChecksFile } from "./checks.ts";

/** How long an open check waits on its runner before it is marked overdue or handed on. */
export const OVERDUE_MS = 7 * 24 * 60 * 60 * 1000;

/** The escalation item an open check waits on the person for, under Needs you: the one a person check's plan names. Undefined for any other check, and for an id that is not on the list. PURE. */
export const personItemOf = (check: CheckRecord): EscalationItem | undefined => (check.state === "open" && check.runner === "person" ? escalationItem(check.escalation) : undefined);

/** Whether an open check waits on the person under Needs you. PURE. */
export const waitsOnPerson = (check: CheckRecord): boolean => personItemOf(check) !== undefined;

/** The checks in `file` that `change` gives a new record, merged over it; `file` itself when it gives none. */
function withChanged(file: ChecksFile, change: (check: CheckRecord) => CheckRecord | null): ChecksFile {
  const changed = Object.values(file.checks).flatMap((check) => change(check) ?? []);
  return changed.length === 0 ? file : { checks: { ...file.checks, ...Object.fromEntries(changed.map((check) => [check.id, check])) } };
}

/** The file with `sentAt` set to `now` on every check the sweep shows under Needs you for the first time. Returns `file` itself when every one was shown already. PURE. */
export const markShownToPerson = (file: ChecksFile, now: number): ChecksFile =>
  withChanged(file, (check) => (waitsOnPerson(check) && check.sentAt === undefined ? { ...check, sentAt: now } : null));

/** Whether an open Needs-you check that was never overdue has waited {@link OVERDUE_MS} on the person by `now`. PURE. */
const fallsOverdue = (check: CheckRecord, now: number): boolean => waitsOnPerson(check) && check.overdueAt === undefined && check.sentAt !== undefined && now - check.sentAt >= OVERDUE_MS;

/** The file with every Needs-you check that has waited {@link OVERDUE_MS} on the person, and was never overdue, marked overdue at `now`. Returns `file` itself when none falls overdue. PURE. */
export const markOverdue = (file: ChecksFile, now: number): ChecksFile => withChanged(file, (check) => (fallsOverdue(check, now) ? { ...check, overdueAt: now } : null));

/**
 * The file with every open `board` check that watches an event that has to happen (the first four specs), and has watched {@link OVERDUE_MS} without seeing it, handed to an agent (A11-302): the verifier run does what the line says,
 * since the board cannot say it did not happen. A windowed check decides its own handoff when its window closes (`watchWindows`). Returns `file` itself when none is handed on. PURE.
 */
export function handOverdueToAgent(file: ChecksFile, now: number): ChecksFile {
  return withChanged(file, (check) => {
    const watch = check.observe;
    if (check.state !== "open" || check.runner !== "board" || watch === undefined || isWindowed(watch.spec) || now < windowEnd(watch)) return null;
    return { ...check, runner: "agent", handedOff: `the board watched for ${watch.spec.kind} for 7 days and did not see it` };
  });
}

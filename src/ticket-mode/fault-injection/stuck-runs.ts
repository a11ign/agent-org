// @ts-check
// module: which runs a scenario left stuck with no reason shown, and the report that lists them with their run logs (A11-439) -- PURE
//
// A RUN IS STUCK WITH NO REASON WHEN ITS CARD SAYS NOTHING OF WHY IT IS WHERE IT IS. The card's status is `runStatus`, and the lines that can say why are the ones the Runs page draws in the card's note (`linesOf` in
// `ui/src/runs/runs-model.ts`). The page is a package of its own, so its composition is not imported: {@link cardLines} builds the same lines from the same `board-view` builders, leaving out only those that need the page's own
// context and that no scenario sets (the publisher, the update banner, the pull requests' reviews, the CI line). A status that is its own reason needs no line: a settled run (Completed, Checked, Cancelled) and one that waits
// on a review or a merge, whose status says what it waits on. Every other status (In progress, Waiting, Needs you, Failed, Queued, Blocked and the rest) with no line is a run a person would find stuck and not know why.
//
// AWAITING REVIEW IS NO REASON ONCE EVERY PULL REQUEST IS APPROVED AT ITS HEAD. Then the review it names has happened, and the run waits on something the status does not say: a11ign/announcement-emulator#32 (A11-342) read
// approved and armed while a cancelled run of its required check held it BLOCKED, and nothing on the card said so. Such a run needs a line, as any other status does ({@link explainsItself}).
//
// The scenarios end with every worker done, so a run still In progress with nothing said is not a run at work: the board has lost track of it.
import { checkNote, promptNote, queueNote, reasonOf } from "../board-view/run-reason.ts";
import { isParked, overrideNote, rebaseNote, retargetNote, runStatus, stackedOn, stackNote, verdictNote, waitNote, waitsOn, workingNote } from "../board-view/pull-status-and-notes.ts";
import { crashedHoldsNote, crashedRunOf, isCrashedBlocker } from "../board-view/crashed-blockers.ts";
import { sharedRunNote } from "../board-view/run-terminal.ts";
import { stackedOnItNote, stackWaitNote } from "../board-view/stack-wait.ts";
import { cycleNote } from "../board-view/wait-cycles.ts";
import { readoptNote } from "../board-view/readopt-note.ts";
import { cutListNote } from "../board-view/overlap-hold.ts";
import { learnsLine } from "../board-view/ticket-change.ts";
import { conflictNote } from "../board-view/pull-conflict.ts";
import { openPulls, type RunStatus } from "../board-view/view-types-and-filters.ts";
import type { Entry, Queue } from "../queue/queue-entries-and-outcomes.ts";
import { logOf, type RunEvent } from "../queue/run-log.ts";

/** The statuses that say by themselves where a run is: settled, or waiting on a review or a merge. */
export const SELF_EXPLAINED: ReadonlySet<RunStatus> = new Set<RunStatus>(["completed", "checked", "cancelled", "awaiting-review", "not-merging", "ready-to-merge", "published"]);

/** One run as the scenario left it: its key, its status, whether that status says by itself where the run is, the reason its card shows (null for none), and its run log. */
export type RunVerdict = Readonly<{ key: string; status: RunStatus; explained: boolean; reason: string | null; log: readonly RunEvent[] }>;

/** Whether every open pull request of the run was last read approved at its head. False for a run with none. PURE. */
function approvedAtHeads(entry: Entry): boolean {
  const heads = openPulls(entry).map(({ url }) => entry.pullHeads?.[url]);
  return heads.length > 0 && heads.every((head) => head?.approved === true || head?.review === "approved");
}

/** Whether `status` says by itself where the run is: one of {@link SELF_EXPLAINED}, except Awaiting review over pull requests already approved at their heads. PURE. */
const explainsItself = (entry: Entry, status: RunStatus): boolean => SELF_EXPLAINED.has(status) && !(status === "awaiting-review" && approvedAtHeads(entry));

/** The keys of the queued runs that wait on `entry` while it is a crashed run, as the card counts them for its line on the crash (A11-399). PURE. */
function waitingOnCrash(entry: Entry, entries: readonly Entry[]): string[] {
  const key = entry.ticket.key;
  if (crashedRunOf(key, entries) === null) return [];
  return entries.filter((other) => other.phase === "queued" && waitsOn(other, entries).some((blocker) => blocker.key === key && isCrashedBlocker(other, blocker, entries))).map((other) => other.ticket.key);
}

/** The blockers a run waits on, as the card names them: "Waits on FIX-1 (crashed)". Null when it waits on none. PURE. */
function blockersLine(entry: Entry, entries: readonly Entry[]): string | null {
  const waits = waitsOn(entry, entries);
  return waits.length === 0 ? null : `Waits on ${waits.map((blocker) => `${blocker.key} (${isCrashedBlocker(entry, blocker, entries) ? "crashed" : blocker.status})`).join(", ")}`;
}

/** Every line the card's note shows that says where the run is, in the page's order. PURE. */
export function cardLines(entry: Entry, entries: readonly Entry[], now: number): string[] {
  const stacked = stackedOn(entry, entries);
  const stalled = workingNote(entry, now);
  const lines: (string | null | undefined)[] = [
    promptNote(entry), sharedRunNote(entry, entries), blockersLine(entry, entries), stacked.length > 0 ? stackNote(stacked, entry.overlapStack) : null, stackWaitNote(entry, entries), stackedOnItNote(entry, entries),
    rebaseNote(entry), waitNote(entry, entries), crashedHoldsNote(entry, waitingOnCrash(entry, entries), now), cycleNote(entry, entries), entry.sessionNote, readoptNote(entry), overrideNote(entry), cutListNote(entry, entries),
    reasonOf(entry, now).line, learnsLine(entry), verdictNote(entry), retargetNote(entry), checkNote(entry), queueNote(entry), conflictNote(entry),
    stalled?.stalled === true ? stalled.text : null, isParked(entry) ? "Still open: answer the agent in its terminal" : null,
  ];
  return lines.filter((line): line is string => typeof line === "string" && line !== "");
}

/** The first line the card shows that says why the run is where it is, or null when it shows none. PURE. */
export function shownReason(entry: Entry, entries: readonly Entry[], now: number): string | null {
  return cardLines(entry, entries, now)[0] ?? null;
}

/** Every run of `queue`, as its card reads at `now`, with its run log. PURE. */
export function verdicts(queue: Queue, now: number): RunVerdict[] {
  return queue.entries.map((entry) => {
    const status = runStatus(entry, queue.entries);
    return { key: entry.ticket.key, status, explained: explainsItself(entry, status), reason: shownReason(entry, queue.entries, now), log: logOf(queue, entry.ticket.key) };
  });
}

/** Whether a run is stuck with no reason shown: a status that does not say why by itself, and no line that does. PURE. */
export const isStuck = (verdict: RunVerdict): boolean => !verdict.explained && verdict.reason === null;

/** One scenario's result: its name, what it injected, every run as it left it, and the lines the board wrote to its journal (stderr) while it ran. */
export type ScenarioResult = Readonly<{ name: string; faults: string; runs: readonly RunVerdict[]; journal: readonly string[] }>;

/** The runs a scenario left stuck with no reason shown. PURE. */
export const stuckOf = (result: ScenarioResult): RunVerdict[] => result.runs.filter(isStuck);

/** A log event as one line: its time (UTC) and kind, then its other fields as JSON. PURE. */
export function eventLine({ at, kind, ...rest }: RunEvent): string {
  const fields = Object.keys(rest).length === 0 ? "" : ` ${JSON.stringify(rest)}`;
  return `${new Date(at).toISOString()} ${kind}${fields}`;
}

/** A run's line in the report: its key, its status and the reason its card shows. PURE. */
const runLine = ({ key, status, reason }: RunVerdict): string => `${key}: ${status}${reason === null ? ", no reason shown" : `: ${reason}`}`;

/** What the report says of a stuck run beyond its line: its run log, and the lines of the board's journal that name it. PURE. */
function stuckRunLines(run: RunVerdict, journal: readonly string[]): string[] {
  const named = journal.filter((line) => line.includes(run.key));
  return [
    `  run log of ${run.key}:`, ...(run.log.length === 0 ? ["    (empty)"] : run.log.map((event) => `    ${eventLine(event)}`)),
    ...(named.length === 0 ? [] : [`  the board's journal on ${run.key}:`, ...named.map((line) => `    ${line}`)]),
  ];
}

/** The report of every scenario: each run's status and reason, and the run log of each stuck one. Ends with the count of stuck runs. PURE. */
export function report(results: readonly ScenarioResult[]): string {
  const lines: string[] = [];
  for (const result of results) {
    const stuck = stuckOf(result);
    lines.push(`${result.name} (${result.faults}): ${stuck.length === 0 ? "no stuck runs" : `${stuck.length} stuck with no reason shown`}`);
    for (const run of result.runs) lines.push(`  ${runLine(run)}`);
    for (const run of stuck) lines.push(...stuckRunLines(run, result.journal));
  }
  const total = results.reduce((sum, result) => sum + stuckOf(result).length, 0);
  lines.push(total === 0 ? "No run was left stuck with no reason shown." : `${total} run${total === 1 ? "" : "s"} left stuck with no reason shown.`);
  return `${lines.join("\n")}\n`;
}

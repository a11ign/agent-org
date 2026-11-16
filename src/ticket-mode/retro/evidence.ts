// @ts-check
// module: what the ticket-mode retro reads (A11-432) -- the last days' reviewer findings, cap and stand-off events and Needs-you causes, each tied to its run and repository
//
// A RUN IS THE OUTCOME LOG'S (A11-430): its id is `<key>@<first start>`, and its record names the repositories it worked in. An event of the queue's run log (`run-log.ts`) belongs to the run of
// its ticket that started last before it, and is read once that run's record reaches it: a record is written when a round ends, so an event after a run's latest round (a round still running, or
// a later run that has not ended a round yet) waits for the record that covers it, and is never given to an earlier run. An event no record covers is not read: a lesson must cite its runs.
//
// WHAT IS READ is what the board already keeps, so the retro makes no request of the tracker or the code host:
// - a Needs-you event's reason, and a run's `finished` reason when it ended on anything but a pull request, a check or a hand-back (whose Needs-you event says it);
// - a round started by review feedback, red checks, a conflict or the CI budget, with the first line of what started it;
// - the reviewer's `changes-requested` verdict, and a re-review's reasons when it was still not convinced;
// - the cap's routing to the planner and the planner's Decision, and the stand-off's steps, with their detail.
import type { OutcomeRecord } from "../outcomes/outcome-record.ts";
import type { RunEvent } from "../queue/run-log.ts";

/** How many days back a retro reads. */
export const RETRO_DAYS = 7;

/** The longest one item's text is kept: a re-review's reasons can run to 2000 characters. */
const ITEM_TEXT_MAX = 400;

/** The most items one repository's retro reads: its newest. */
export const ITEMS_MAX = 200;

/** One thing that went wrong in a run: the run, when, what kind of signal it is, and its text. */
export type RetroItem = Readonly<{ run: string; at: number; source: string; text: string }>;

/** The rounds whose cause is something a worker got wrong, rather than a person's own round. */
const FIX_ROUNDS: ReadonlySet<string> = new Set(["feedback", "checks", "conflict", "ci-budget"]);

/** The outcomes a run's `finished` event is not read for: it ended well, or handed back to a person, which its own `needs-you` event already says in the same words. */
const UNREAD_ENDS: ReadonlySet<string> = new Set(["ready-pr", "done", "checked", "needs-human"]);

/** The cap's steps that say something went wrong: the run reached the cap, and what the planner decided. Waiting on a ticket and resuming are not. */
const CAP_STEPS: ReadonlySet<string> = new Set(["planner", "decided"]);

/** The source and text `event` gives the retro, or null when it is not one the retro reads. PURE. */
export function itemOf(event: RunEvent): Readonly<{ source: string; text: string }> | null {
  switch (event.kind) {
    case "needs-you": return { source: "needs-you", text: event.reason };
    case "round": return FIX_ROUNDS.has(event.cause) && event.reason !== null ? { source: `round:${event.cause}`, text: event.reason } : null;
    case "verdict": return event.review === "changes-requested" ? { source: "review", text: `the reviewer requested changes on ${event.url}` } : null;
    case "rereview": return event.verdict === "not-convinced" ? { source: "rereview", text: event.reasons } : null;
    case "cap": return CAP_STEPS.has(event.step) ? { source: "cap", text: event.detail === null ? `the run reached the round cap (${event.step})` : `cap ${event.step}: ${event.detail}` } : null;
    case "standoff": return event.step === "settled" ? null : { source: "standoff", text: event.detail === null ? `stand-off on ${event.url} (${event.step})` : `stand-off ${event.step}: ${event.detail}` };
    case "finished": return UNREAD_ENDS.has(event.outcome) || event.reason === undefined ? null : { source: `finished:${event.outcome}`, text: event.reason };
    default: return null;
  }
}

/** The first start of run `run` (`<key>@<ms>`). PURE. */
const startOf = (run: string): number => Number(run.slice(run.lastIndexOf("@") + 1));

/**
 * The retro's items by repository, from the runs active since `since` (their latest record is at or after it) and the run log's events since then: each event read by {@link itemOf}, given to
 * the run of its ticket that started last before it, and listed under each of that run's repositories, newest {@link ITEMS_MAX} kept, oldest first. PURE.
 */
export function retroEvidence({ records, runLog, since }: { records: readonly OutcomeRecord[]; runLog: Readonly<Record<string, readonly RunEvent[]>>; since: number }): Map<string, RetroItem[]> {
  const runsOf = new Map<string, OutcomeRecord[]>();
  for (const record of records.filter((each) => each.at >= since)) runsOf.set(record.ticket, [...(runsOf.get(record.ticket) ?? []), record]);
  const byRepo = new Map<string, RetroItem[]>();
  for (const [ticket, events] of Object.entries(runLog)) {
    for (const event of events.filter((each) => each.at >= since)) {
      const item = itemOf(event);
      const record = runAt(runsOf.get(ticket) ?? [], event.at);
      if (item === null || record === undefined) continue;
      const read: RetroItem = { run: record.run, at: event.at, source: item.source, text: oneLine(item.text) };
      for (const repo of record.repos) byRepo.set(repo, [...(byRepo.get(repo) ?? []), read]);
    }
  }
  return new Map([...byRepo].map(([repo, items]) => [repo, items.sort((a, b) => a.at - b.at).slice(-ITEMS_MAX)]));
}

/** Of one ticket's `runs`, the one that started last at or before `at`, when its record reaches `at`; undefined when none does. PURE. */
function runAt(runs: readonly OutcomeRecord[], at: number): OutcomeRecord | undefined {
  const run = runs.filter((each) => startOf(each.run) <= at).sort((a, b) => startOf(b.run) - startOf(a.run))[0];
  return run !== undefined && at <= run.at ? run : undefined;
}

/** `text` on one line, cut to {@link ITEM_TEXT_MAX}. PURE. */
function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > ITEM_TEXT_MAX ? `${line.slice(0, ITEM_TEXT_MAX - 1)}…` : line;
}

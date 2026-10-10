// #4627 use 4: WHAT CAME OF A ROUTED ROW, WRITTEN WHEN THE ROW CLOSES, so a floor has results to be tuned from. `recordRouteOutcome` (engineer-route.ts) existed for this and had no
// caller outside its own test: the log held 178 `via jev` route lines and 0 outcome lines of this kind.
//
// THE VOCABULARY IS FIXED AND SMALL, and each string is one reading of a closed row:
//   merged-first-pass    the pull request merged with no `CHANGES_REQUESTED` review on an earlier head
//   not-first-pass       it merged, after at least one
//   escalated            the worker the route started was escalated (`engineer-escalation.ts`); it wins over a merge, because the merge was not the route's profile coping
//   closed-without-merge the row closed and no pull request of it merged (an outcome of its own, not a missing one)
//
// FIRST PASS IS NOT DEFINED HERE. `trace/haiku-tier-report.ts` DEFINES it (in `summarise`: merged, and `rejections === 0`), the one definition the stop rule is read against, so this
// module hands it a one-row summary and reads the answer back. A second copy of the rule would be a second definition the day one of them moved.
//
// THE PROVIDER STAYS OPTIONAL (chairman, #4627). A decision with no `model-routing` line in the log gets no outcome line, quietly; so does a host whose use is switched off, and a
// host with no log at all (the log is not created for an outcome with nothing to attach to).
//
// WHERE THIS IS CALLED FROM IS NOT THIS FILE'S DECISION, and is NOT `close-rows-for-merged-pr.ts` today: that script runs on a GitHub-hosted runner that cannot see the host's log
// (agent-org#687, the row's comment). `recordClosedRow` is written to be called by whatever host-side process sees a row leave the open population.
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import type { DecisionDeps } from "./decision-provider.ts";
import { readSwitches } from "./decision-provider.ts";
import { recordRouteOutcome, windowReadings } from "./engineer-route.ts";
import { printDiagnostic, processState } from "./triage-provider.ts";
import { EFFORT_UNKNOWN, summarise } from "./trace/haiku-tier-report.ts";

export const ROUTE_OUTCOMES = Object.freeze(["merged-first-pass", "not-first-pass", "escalated", "closed-without-merge"] as const);
export type RouteOutcome = (typeof ROUTE_OUTCOMES)[number];

/**
 * What is known of a closed row. `compactions` is carried because the report's own row shape has it and the caller has it to hand; none of the four outcomes reads it (the
 * window's verdict, `window too small`, is `recordWindowTooSmall`'s line, once per row, and is a different question).
 */
export type RouteOutcomeFacts = { mergedPr: boolean; rejectedReviews: number; escalated: boolean; compactions: number };

const USE = "model-routing";
const ID_PREFIX = "row-";
const isCount = (value: number): boolean => Number.isInteger(value) && value >= 0;

/**
 * THE OUTCOME OF ONE ROW, from its facts alone. Pure. A count that is not a whole number of reviews is a fact nobody read, and it THROWS rather than be taken for "no rejections" or
 * for "one": absence is not proof, and a wrong outcome line is worse than none because it is tuned from.
 */
export function routeOutcomeOf({ mergedPr, rejectedReviews, escalated, compactions }: RouteOutcomeFacts): RouteOutcome {
  if (!isCount(rejectedReviews) || !isCount(compactions)) {
    throw new RangeError(`route-outcome: rejectedReviews (${String(rejectedReviews)}) and compactions (${String(compactions)}) must each be a count`);
  }
  if (escalated) return "escalated";
  const { firstPassRate } = summarise([{ number: 0, haiku: false, merged: mergedPr, rejections: rejectedReviews, compactions, oversize: 0, turns: 0, costUsd: 0, unpriced: 0, effort: EFFORT_UNKNOWN }]);
  if (firstPassRate === null) return "closed-without-merge";
  return firstPassRate === 1 ? "merged-first-pass" : "not-first-pass";
}

export type ClosedRowDeps = Pick<DecisionDeps, "logPath" | "now" | "diagnostic" | "read" | "switches" | "switchesPath">;

/** A log line as a value, or `undefined` for one that is not JSON (a half-written tail), so one bad line does not stop the read. */
function parsed(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** Whether the log already holds a vocabulary outcome for the row: what makes a second close-out a no-op. */
function hasOutcome(lines: readonly unknown[], row: number): boolean {
  return lines.some((line) => {
    const entry = line as { use?: unknown; id?: unknown; outcome?: unknown } | null | undefined;
    return entry?.use === USE && entry.id === `${ID_PREFIX}${row}` && (ROUTE_OUTCOMES as readonly unknown[]).includes(entry.outcome);
  });
}

/** The log's lines as values, or `null` when the log could not be read (an absent one is quiet, any other fault goes to the diagnostic). */
function readLog(logPath: string, read: NonNullable<ClosedRowDeps["read"]>, diagnostic: (line: string) => void): unknown[] | null {
  try {
    return String(read(logPath, "utf8")).split("\n").filter((line) => line !== "").map(parsed);
  } catch (err) {
    if ((err as { code?: string })?.code !== "ENOENT") diagnostic("agent-org: route-outcome: the decision log could not be read, so no outcome was written");
    return null;
  }
}

/** Whether the log routed the row and holds no outcome of the vocabulary for it yet: the whole of "this row is owed a line". */
const owed = (lines: readonly unknown[], row: number): boolean => windowReadings(lines).some((reading) => reading.row === row) && !hasOutcome(lines, row);

/** The row's lock file, beside the log (the directory the log is already in, so no directory is made for it). */
export const rowLockPath = (logPath: string, row: number): string => `${logPath}.outcome-${row}.lock`;

/**
 * WRITE THE OUTCOME OF A CLOSED ROW, ONCE, AND ONLY FOR A ROW THE LOG ROUTED. Returns the outcome it wrote, or `null` when it wrote nothing; it never throws. The reasons it
 * wrote nothing that are faults (a log that could not be read, facts that are not counts, a lock it could not take) go to the diagnostic; the four that are by design (no log, the
 * use off, no route line, a second close-out) are quiet.
 *
 * ONCE PER ROW HOLDS UNDER TWO CLOSE-OUTS AT THE SAME INSTANT, because the report keeps the LAST outcome of a row and two appends of different facts would leave it the one that
 * happened to land second. Reading the log and appending are two steps of `recordRouteOutcome` (a plain append, and not this file's to change), so the pair is made one by an
 * exclusive per-row lock file: created with `wx`, held across the re-read and the append, removed in a `finally`. A close-out that finds the lock held writes NOTHING and says so; it
 * does not wait, because the holder is writing the same row's outcome and a second reading of it is exactly what is not wanted. The cost is that a process killed inside that window
 * (a read and an append, microseconds) leaves the lock, and the row gets no outcome until it is removed: LOUD (the diagnostic names the file), and the fail-closed side, where the
 * other choice was a wrong outcome that is tuned from. Nothing steals a lock for its age: a steal is itself a race, and one that ends in two writers.
 *
 * The read before the lock is only so that a row owed nothing (no log, the use off, no route line, an outcome already there) touches nothing on disk: the log is not created and
 * no lock file is made for it. The read INSIDE the lock is the one the append is decided on.
 */
export function recordClosedRow(row: number, facts: RouteOutcomeFacts, deps: ClosedRowDeps): RouteOutcome | null {
  const { logPath, diagnostic = printDiagnostic } = deps;
  if (logPath === undefined) return null;
  const read = deps.read ?? readFileSync;
  // The rule `decide` applies: anything but an explicit `true` is off, a file that could not be used included.
  const switches = deps.switches ?? (deps.switchesPath === undefined ? {} : readSwitches(deps.switchesPath, { diagnostic, state: processState, read }));
  if (switches[USE] !== true) return null;
  const before = readLog(logPath, read, diagnostic);
  if (before === null || !owed(before, row)) return null;
  let outcome: RouteOutcome;
  try {
    outcome = routeOutcomeOf(facts);
  } catch (err) {
    diagnostic(`agent-org: route-outcome: row ${row} has no outcome written: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const lockPath = rowLockPath(logPath, row);
  let lock: number;
  try {
    lock = openSync(lockPath, "wx");
  } catch (err) {
    const held = (err as { code?: string })?.code === "EEXIST";
    diagnostic(`agent-org: route-outcome: row ${row} has no outcome written by this close-out: ${held ? `another close-out holds ${lockPath} (remove it if none is running)` : `${lockPath} could not be taken`}`);
    return null;
  }
  try {
    writeSync(lock, `${process.pid}\n`);
    const inside = readLog(logPath, read, diagnostic);
    if (inside === null || !owed(inside, row)) return null;
    recordRouteOutcome(row, outcome, deps);
    return outcome;
  } finally {
    closeSync(lock);
    try {
      unlinkSync(lockPath);
    } catch {
      diagnostic(`agent-org: route-outcome: ${lockPath} could not be removed; the row's outcome is written, and a later close-out of it will find the lock held`);
    }
  }
}

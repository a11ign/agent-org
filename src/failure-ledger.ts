// @ts-check
// module: the failure ledger -- an append-only log of EVENTS that never become a closed row (a11ign/a11ign#4450, move 1a of #4437)
//
// `class-repeat.ts` (#4126) counts CLOSED ROWS labelled `class:<id>`. "main is red", "a worker excluded from capture", "an owner nobody could be named for" and a hand
// reroute are events, not rows: nothing closes them, so a second occurrence was invisible. This leaf is where they go, one line per event, beside `wake-deferral-log`:
//
//     <classKey>\t<ts, ms>\t<ref>
//
// THE CLASS KEYS ARE EVENT KINDS (`FAILURE_KINDS`), not the ids of `.agent-org/failure-classes.json`'s row-defect classes. A REPEAT is one kind seen with two or more DISTINCT
// refs: the same ref twice is one event still standing (a red `main` stays red for many ticks), so it is not one.
//
// A LEAF: it imports no org-health or work-gate name, so a recorder in any module can call it. A RECORDER NEVER THROWS INTO THE TICK: a refused append is REPORTED through
// `report` (stderr by default) and returned, never swallowed.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The log's file name, beside `wake-deferral-log`. */
export const FAILURE_LEDGER_FILE = "failure-ledger";

/** The event kinds of the epic's move 1. `pr-red`, `worker-excluded` and `chairman-correction` are seeded keys only: their recorders are later rows. */
export const FAILURE_KINDS = Object.freeze(["main-red", "pr-red", "owner-unresolved", "worker-excluded", "hand-reroute", "chairman-correction"]);

export type FailureEntry = { classKey: string, at: number, ref: string };
/** `at` is epoch ms; absent means the tick's own `now` (an event dated by its source, such as a hand fix, carries its own) */
export type FailureEvent = { classKey: string, ref: string, at?: number };
export type RecordResult = { appended: number, skipped: number, refused: string | null };
type Io = { append?: typeof appendFileSync, read?: (path: string) => string, report?: (line: string) => void };

const reportToStderr = (line: string) => process.stderr.write(`${line}\n`);
const firstLine = (cause: unknown): string => String((cause as Error)?.message ?? cause).split("\n")[0].slice(0, 160);
const lineOf = ({ classKey, at, ref }: FailureEntry): string => `${classKey}\t${at}\t${ref}\n`;

/** A key or ref that is empty or carries a tab or newline would write a line `parseFailureLedger` throws on, for every later reader. @returns the reason, or null */
function unwritable({ classKey, ref }: { classKey: string, ref: string }): string | null {
  return [classKey, ref].every((field) => field !== "" && !/[\t\r\n]/.test(field)) ? null : `a failure-ledger field must be non-empty and free of tabs and newlines: ${JSON.stringify({ classKey, ref }).slice(0, 160)}`;
}

/**
 * Append ONE event. Never throws: an unwritable path comes back as `refused` and goes to `report`, so the tick that called it goes on.
 * @param {{ logPath: string, classKey: string, ref: string, now: number, append?: typeof appendFileSync, report?: (line: string) => void }} event
 */
export function recordFailure({ logPath, classKey, ref, now, append = appendFileSync, report = reportToStderr }: { logPath: string, classKey: string, ref: string, now: number } & Pick<Io, "append" | "report">): RecordResult {
  const refused = unwritable({ classKey, ref }) ?? appendRefusal(logPath, lineOf({ classKey, at: now, ref }), append);
  if (refused !== null) report(`failure-ledger: NOT RECORDED ${classKey} ${ref}: ${refused}`);
  return { appended: refused === null ? 1 : 0, skipped: 0, refused };
}

/** @returns the reason the append was refused, or null */
function appendRefusal(logPath: string, text: string, append: typeof appendFileSync): string | null {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    append(logPath, text);
    return null;
  } catch (cause) {
    return firstLine(cause);
  }
}

/**
 * The log's lines. A line that does not parse THROWS, as `parseDeferralLog` does: an event read wrong is a repeat drawn wrong, and a skipped line would be an event that never happened.
 * @param {string} text @param {string} [source] the file, for the message
 */
export function parseFailureLedger(text: string, source: string = FAILURE_LEDGER_FILE): FailureEntry[] {
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => {
    const [classKey, at, ref, ...extra] = line.split("\t");
    if (!classKey || !/^\d+$/.test(at ?? "") || !ref || extra.length > 0) {
      throw new Error(`${source} has a line that is not "<classKey>\\t<ts ms>\\t<ref>": ${line.slice(0, 120)}`);
    }
    return { classKey, at: Number(at), ref };
  });
}

/**
 * Every class key seen with TWO OR MORE DISTINCT refs, newest ref last. `windowMs` looks back from `now` (default: the newest entry's time, so the answer is a function of the log alone).
 * The same ref twice is NOT a repeat.
 * @param {FailureEntry[]} entries @param {{ windowMs: number, now?: number }} window
 */
export function repeatsIn(entries: FailureEntry[], { windowMs, now }: { windowMs: number, now?: number }): { classKey: string, refs: string[] }[] {
  const end = now ?? Math.max(0, ...entries.map((entry) => entry.at));
  const refsByKey = new Map<string, string[]>();
  for (const { classKey, at, ref } of [...entries].sort((a, b) => a.at - b.at)) {
    if (at < end - windowMs || at > end) continue;
    const refs = refsByKey.get(classKey) ?? [];
    if (!refs.includes(ref)) refsByKey.set(classKey, [...refs, ref]);
  }
  return [...refsByKey].filter(([, refs]) => refs.length >= 2).map(([classKey, refs]) => ({ classKey, refs }));
}

/** What is already logged, as `classKey\tref` pairs; a log that cannot be read is REPORTED and read as empty, so the events are still written (a duplicate is harmless to `repeatsIn`, a lost event is not). */
function loggedPairs(logPath: string, { read, report }: Required<Pick<Io, "read" | "report">>): Set<string> {
  try {
    return new Set(parseFailureLedger(read(logPath), logPath).map(({ classKey, ref }) => `${classKey}\t${ref}`));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") report(`failure-ledger: could not read ${logPath} to skip what is logged (${firstLine(cause)}); recording without that check`);
    return new Set();
  }
}

/**
 * Record what one tick saw. AN EVENT ALREADY IN THE LOG (same key, same ref) IS NOT WRITTEN AGAIN: a red `main` is seen by every tick until it is fixed, and one standing event
 * is one line, so running a tick twice appends nothing twice. Never throws.
 * @param {{ logPath: string, events: FailureEvent[], now: number } & Io} tick
 */
export function recordFailures({ logPath, events, now, append = appendFileSync, read = (path) => readFileSync(path, "utf8"), report = reportToStderr }: { logPath: string, events: FailureEvent[], now: number } & Io): RecordResult {
  const result: RecordResult = { appended: 0, skipped: 0, refused: null };
  if (events.length === 0) return result;
  const logged = loggedPairs(logPath, { read, report });
  for (const { classKey, ref, at } of events) {
    const pair = `${classKey}\t${ref}`;
    if (logged.has(pair)) { result.skipped += 1; continue; }
    logged.add(pair);
    const one = recordFailure({ logPath, classKey, ref, now: at ?? now, append, report });
    result.appended += one.appended;
    result.refused ??= one.refused;
  }
  return result;
}

/**
 * `main-red` from the reading the tick already makes (`readTrunkRed`, `null` for a green or an unreadable `main`). THE REF IS THE RED RUN: a later red is a different run, a standing red is the same one.
 * (The row named `org-watch.ts`'s `mainColour`; the tick does not call that, it calls `readTrunkRed`, so this takes the reading the tick has.)
 * @param {{ url?: string, runId?: number, repo?: string } | null | undefined} trunkRed
 */
export function mainRedEvents(trunkRed: { url?: string, runId?: number, repo?: string } | null | undefined): FailureEvent[] {
  const ref = trunkRed?.url ?? (trunkRed?.runId === undefined ? undefined : `${trunkRed.repo ?? "primary"}/runs/${trunkRed.runId}`);
  return ref === undefined ? [] : [{ classKey: "main-red", ref }];
}

/** When a recorder's marker file says it last ran; a missing marker is "never" (0), an unreadable one throws. Here and not beside the recorder: a source that writes a file is read as ITS writer (`org-retro.test.ts`). */
export function lastRun(markerPath: string): number {
  try {
    return Number(readFileSync(markerPath, "utf8")) || 0;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
    throw cause;
  }
}

/** Stamp the marker with the time of this run. */
export function markRun(markerPath: string, now: number): void {
  writeFileSync(markerPath, String(now));
}

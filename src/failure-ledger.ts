// @ts-check
// module: the failure ledger -- an append-only log of EVENTS that never become a closed row (a11ign/a11ign#4450, move 1a of #4437)
//
// `class-repeat.ts` (#4126) counts CLOSED ROWS labelled `class:<id>`. "main is red", "a worker excluded from capture", "an owner nobody could be named for" and a hand
// reroute are events, not rows: nothing closes them, so a second occurrence was invisible. This leaf is where they go, one line per event, beside `wake-deferral-log`:
//
//     <classKey>\t<ts, ms>\t<ref>
//
// THE CLASS KEYS ARE EVENT KINDS (`FAILURE_KINDS`), not the ids of `.agent-org/failure-classes.json`'s row-defect classes. A REPEAT is one kind seen with two or more DISTINCT
// refs: the same ref twice is one event still standing (a red `main` stays red for many ticks), so it is not one. A `main-red` ref is the run that OPENED a red, and a red that no push
// can fix, red on every push, is one ref and not one per run (`mainRedEvents`, agent-org#674).
//
// A LEAF: it imports no org-health or work-gate name, so a recorder in any module can call it. A RECORDER NEVER THROWS INTO THE TICK: a refused append is REPORTED through
// `report` (stderr by default) and returned, never swallowed.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The log's file name, beside `wake-deferral-log`. */
export const FAILURE_LEDGER_FILE = "failure-ledger";

/**
 * The event kinds of the epic's move 1. `pr-red`, `worker-excluded` and `chairman-correction` are seeded keys only: their recorders are later rows.
 * `chairman-correction` is written by NO recorder yet and `prompt-session.ts` refuses it as a `Class:` token: it needs a caller authenticated by something the agent accounts cannot write (#4452).
 */
export const FAILURE_KINDS = Object.freeze(["main-red", "pr-red", "owner-unresolved", "worker-excluded", "hand-reroute", "chairman-correction"]);

/** What `prompt:session` records (#4452): an order from a caller it could not identify (the PROXY for the chairman), and an order that carried no `Class:` token. Not seeded in the index: the daily pass groups them. */
export const UNIDENTIFIED_CALLER_KIND = "unidentified-caller-order";
export const UNCLASSIFIED_KIND = "unclassified";

/**
 * What `messaging/audit.ts` records (#4746): an announcement that asked the chairman something, or an ask with no row or record. Not seeded in `FAILURE_KINDS` or the index,
 * whose test pins the six first-move kinds: `repeatsIn` and the daily pass read any key, and each entry's ref names the message and which half failed.
 */
export const MESSAGING_AUDIENCE_MISUSE_KIND = "messaging-audience-misuse";

export type FailureEntry ={ classKey: string, at: number, ref: string };
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

/** What `trunk-red.ts`'s `readTrunkRed` says of a red, as far as the ledger reads it. */
export type TrunkRedFacts = { url?: string, runId?: number, repo?: string, failedJobs?: string[], leg?: string };
/**
 * `readTrunkRed`'s three answers, which the ledger must keep apart: the red itself; `null`, `main` READ and not red (a green, which ends a standing red); and `undefined`, NOT READ
 * (a refused call, no completed verdict run yet, a green run whose jobs could not be read, or a scope with no code repository), which says nothing and so changes nothing.
 */
export type TrunkReading = TrunkRedFacts | null | undefined;
/** One repository's STANDING red: the run that opened it (the ref its ledger line points at) and the failed jobs it is made of, sorted. */
export type MainRedEpisode = { ref: string, jobs: string[] };

/** The ledger's name for the run a red reading names; `undefined` for a red that names none. */
const refOfRed = (red: TrunkRedFacts): string | undefined => red.url ?? (red.runId === undefined ? undefined : `${red.repo ?? "primary"}/runs/${red.runId}`);
/** The jobs a red is made of: the run's failed jobs, and the cross-repo leg's name where a green run is red only by it. Sorted and distinct, so a set compares as an array. */
const jobsOfRed = (red: TrunkRedFacts): string[] => [...new Set([...(red.failedJobs ?? []), ...(red.leg === undefined ? [] : [red.leg])])].sort();

/**
 * `main-red` from the reading the tick already makes (`readTrunkRed`), given the red already standing for that repository (`open`, `null` for none).
 * THE REF IS THE RUN THAT OPENED THE RED, and A STANDING RED IS COUNTED ONCE, NOT ONCE PER RUN (agent-org#674): a red `checks (cross-repo)` leg on lab is red on every push and
 * each push is a new run, so a ref per run made one red that no push can fix trip `class-repeat` on every push. What continues a red and what does not:
 *   - a red read while one is `open` for the repository CONTINUES it, and records nothing, when it names no failed job the standing red did not: the same set, or fewer (something got
 *     fixed, and the red now says only what is still red, so the open one SHRINKS to that and a job that fails again later is new). A reading with no job names, or an open one with none
 *     (the jobs read was refused), cannot show a different job and continues too: a blip must not be a second red.
 *   - a red naming a job the standing red did not -- a DIFFERENT failed job while the first is still red -- is a new red and a new ref, so a standing red cannot hide a second one.
 *   - a GREEN (`null`) ends it: a later red is a new ref, even for the same job.
 *   - NOT READ (`undefined`) changes nothing: it is not a green, and counting it as one would reopen the same noise after every API blip. `readTrunkRed` tells the two apart; read
 *     its header for what is "not read".
 * A red that names no run (no `url`, no `runId`) is no event and leaves the open one as it was.
 * (The row named `org-watch.ts`'s `mainColour`; the tick does not call that, it calls `readTrunkRed`, so this takes the reading the tick has.)
 * @returns the events to record, and the red standing after this reading (`null` for none)
 */
export function mainRedEvents(reading: TrunkReading, open: MainRedEpisode | null = null): { events: FailureEvent[], open: MainRedEpisode | null } {
  if (reading === undefined) return { events: [], open };
  if (reading === null) return { events: [], open: null };
  const ref = refOfRed(reading);
  if (ref === undefined) return { events: [], open };
  const jobs = jobsOfRed(reading);
  if (open === null) return { events: [{ classKey: "main-red", ref }], open: { ref, jobs } };
  const unknown = jobs.length === 0 || open.jobs.length === 0;
  if (unknown || jobs.every((job) => open.jobs.includes(job))) return { events: [], open: { ref: open.ref, jobs: jobs.length === 0 ? open.jobs : jobs } };
  return { events: [{ classKey: "main-red", ref }], open: { ref, jobs } };
}

/** Where the standing reds are kept between ticks (each is a fresh process), beside the ledger. Its own file: the ledger's format is `<classKey>\t<ts>\t<ref>` and has no room for a state. */
export const mainRedEpisodesPath = (logPath: string): string => `${logPath}-main-red`;

/** The standing reds by repository; a file that is missing is none, one that cannot be read is REPORTED and read as none (the red is recorded again, which `recordFailures` skips when the ref is the same). */
function readMainRedEpisodes(path: string, { read, report }: Required<Pick<Io, "read" | "report">>): Record<string, MainRedEpisode> {
  try {
    const parsed = JSON.parse(read(path));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object of repositories");
    return Object.fromEntries(Object.entries(parsed).filter(([, episode]) => {
      const { ref, jobs } = (episode ?? {}) as Partial<MainRedEpisode>;
      return typeof ref === "string" && ref !== "" && Array.isArray(jobs) && jobs.every((job) => typeof job === "string");
    })) as Record<string, MainRedEpisode>;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") report(`failure-ledger: could not read ${path} (${firstLine(cause)}); reading no red as standing`);
    return {};
  }
}

/**
 * Read what each repository's `main` said this tick against the reds already standing. `repo` names the repository a reading is of: a green carries no repository of its own, so the
 * caller says which one it ended. A reading with no `repo` (a scope with no code repository) is skipped.
 * @returns `events` for `recordFailures`; `commit` to call once they are written, so a ledger line that was refused is retried and not forgotten (never throws)
 */
export function readMainRedReadings({ episodesPath, readings, read = (path) => readFileSync(path, "utf8"), write = writeFileSync, report = reportToStderr }: { episodesPath: string, readings: { repo: string | undefined, red: TrunkReading }[] }
  & Pick<Io, "read" | "report"> & { write?: typeof writeFileSync }): { events: FailureEvent[], commit: () => void } {
  const before = readMainRedEpisodes(episodesPath, { read, report });
  const after = { ...before };
  const events: FailureEvent[] = [];
  for (const { repo, red } of readings) {
    if (repo === undefined) continue;
    const seen = mainRedEvents(red, after[repo] ?? null);
    events.push(...seen.events);
    if (seen.open === null) delete after[repo];
    else after[repo] = seen.open;
  }
  const commit = () => {
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    try {
      mkdirSync(dirname(episodesPath), { recursive: true });
      write(episodesPath, `${JSON.stringify(after)}\n`);
    } catch (cause) {
      report(`failure-ledger: NOT RECORDED the standing red of ${episodesPath}: ${firstLine(cause)}`);
    }
  };
  return { events, commit };
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

// @ts-check
// module: the flake log (A11-300) -- the checks that failed at a head and passed when the board reran them, kept in the board's state, and the tests that flake often enough to need a fix
//
// A PASS ON RERUN IS A FLAKE. `pool-checks.ts` reruns a red job once before it asks a worker; when the rerun passes, the test or step that failed, the run and the head are recorded here, in `flakes.json`.
// A test that flakes {@link FLAKE_LIMIT} times in {@link FLAKE_WINDOW_DAYS} days is listed on the board and by `doctor` as needing a fix. Workers never file the tickets: the chairman's session files them from this list.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One pass on rerun: the test or step that failed (`test`), the check it failed in, the run's address, the head it failed at and the pull request, and when the rerun passed (epoch milliseconds). */
export type Flake = Readonly<{ test: string; check: string; run: string; head: string; pull: string; at: number }>;

/** How many times a test flakes in the window before it needs a fix. */
export const FLAKE_LIMIT = 3;

/** The window, in days, in which {@link FLAKE_LIMIT} flakes make a test need a fix. */
export const FLAKE_WINDOW_DAYS = 7;

const DAY_MS = 86_400_000;

/** How long the log keeps a flake: a flake older than this is dropped as the log is written, so the file stays small. */
const KEPT_DAYS = 30;

/** A test that needs a fix: how many times it flaked in the window, when it last did, and the runs that did. */
export type FlakyTest = Readonly<{ test: string; check: string; count: number; last: number; runs: readonly string[] }>;

/**
 * What `/api/flakes` and `doctor` read: the tests that need a fix, the worst first. `unreadable` says why the log could not be read (and `tests` is then empty): that is not "nothing flaked", and the board and `doctor` say so
 * rather than show an empty list.
 */
export type FlakesView = Readonly<{ limit: number; days: number; tests: readonly FlakyTest[]; unreadable?: string }>;

/** Where the log is: `flakes.json`, in the board's state beside the reviewers' memory. */
export const flakesPath = (stateDir: string): string => join(stateDir, "tickets", "flakes.json");

const isFlake = (value: unknown): value is Flake => {
  const flake = value as Partial<Record<keyof Flake, unknown>> | null;
  return typeof flake === "object" && flake !== null && typeof flake.test === "string" && typeof flake.check === "string" && typeof flake.run === "string"
    && typeof flake.head === "string" && typeof flake.pull === "string" && typeof flake.at === "number" && Number.isFinite(flake.at);
};

/** What the log at a path holds: its flakes (none when there is no file yet), or why it cannot be read. A file that is there and cannot be read is not an empty log: nothing is written over it. */
export type FlakeRead = Readonly<{ flakes: readonly Flake[] }> | Readonly<{ unreadable: string }>;

/** The log at `path`: no file is no flakes; a file that cannot be read, is not JSON, or holds anything but a list of flakes is `unreadable`, with the reason. */
export function readFlakes(path: string): FlakeRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT" ? { flakes: [] } : { unreadable: `${path} cannot be read (${firstLine(err)})` };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) && parsed.every(isFlake) ? { flakes: parsed } : { unreadable: `${path} does not hold a list of flakes` };
  } catch (err) {
    return { unreadable: `${path} is not JSON (${firstLine(err)})` };
  }
}

const firstLine = (err: unknown): string => String((err as Error)?.message ?? err).split("\n")[0];

/** The same flake: a rerun of one run at one head passed once for each test. */
const sameFlake = (a: Flake, b: Flake): boolean => a.run === b.run && a.head === b.head && a.test === b.test;

/**
 * Add `found` to the log at `path`, written whole through a temporary file renamed over the last one, so a write that stops midway leaves that last one. A flake already in the log (the same run, head and test) is
 * not added twice, and those older than {@link KEPT_DAYS} days are dropped. THROWS, and writes nothing, when the log is there and cannot be read (the file is kept for a person to mend), and when the file cannot be written.
 */
export function recordFlakes(path: string, found: readonly Flake[], now: number): void {
  const oldest = now - KEPT_DAYS * DAY_MS;
  const read = readFlakes(path);
  if ("unreadable" in read) throw new Error(read.unreadable);
  const held = read.flakes;
  const added = found.filter((flake, index) => !held.some((each) => sameFlake(each, flake)) && found.findIndex((each) => sameFlake(each, flake)) === index);
  if (added.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify([...held, ...added].filter(({ at }) => at >= oldest), null, 1));
  renameSync(`${path}.tmp`, path);
}

/** The tests that flaked {@link FLAKE_LIMIT} times or more in the {@link FLAKE_WINDOW_DAYS} days up to `now`, the one that flaked most first. PURE. */
export function flakesView(flakes: readonly Flake[], now: number): FlakesView {
  const since = now - FLAKE_WINDOW_DAYS * DAY_MS;
  const byTest = new Map<string, Flake[]>();
  for (const flake of flakes.filter(({ at }) => at > since && at <= now)) byTest.set(flake.test, [...(byTest.get(flake.test) ?? []), flake]);
  const tests = [...byTest].filter(([, each]) => each.length >= FLAKE_LIMIT).map(([test, each]): FlakyTest =>
    ({ test, check: each.at(-1)!.check, count: each.length, last: Math.max(...each.map(({ at }) => at)), runs: [...new Set(each.map(({ run }) => run))] }));
  return { limit: FLAKE_LIMIT, days: FLAKE_WINDOW_DAYS, tests: tests.sort((a, b) => b.count - a.count || b.last - a.last) };
}

/** The log at `path` as the board and `doctor` list it at `now`: the tests that need a fix, or why the log cannot be read. */
export function flakesViewOf(path: string, now: number): FlakesView {
  const read = readFlakes(path);
  return "unreadable" in read ? { limit: FLAKE_LIMIT, days: FLAKE_WINDOW_DAYS, tests: [], unreadable: read.unreadable } : flakesView(read.flakes, now);
}

/** The flakes the pool records and the board and `doctor` list. */
export type FlakeLog = Readonly<{ record: (found: readonly Flake[]) => void; view: () => FlakesView }>;

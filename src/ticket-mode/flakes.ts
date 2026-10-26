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

/** What `/api/flakes` and `doctor` read: the tests that need a fix, the worst first. */
export type FlakesView = Readonly<{ limit: number; days: number; tests: readonly FlakyTest[] }>;

/** Where the log is: `flakes.json`, in the board's state beside the reviewers' memory. */
export const flakesPath = (stateDir: string): string => join(stateDir, "tickets", "flakes.json");

const isFlake = (value: unknown): value is Flake => {
  const flake = value as Partial<Record<keyof Flake, unknown>> | null;
  return typeof flake === "object" && flake !== null && typeof flake.test === "string" && typeof flake.check === "string" && typeof flake.run === "string"
    && typeof flake.head === "string" && typeof flake.pull === "string" && typeof flake.at === "number" && Number.isFinite(flake.at);
};

/** The flakes in the file at `path`: none when it is missing, and none when it cannot be read as a list (the next write replaces it). */
export function readFlakes(path: string): readonly Flake[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed.filter(isFlake) : [];
  } catch {
    return [];
  }
}

/** The same flake: a rerun of one run at one head passed once for each test. */
const sameFlake = (a: Flake, b: Flake): boolean => a.run === b.run && a.head === b.head && a.test === b.test;

/**
 * Add `found` to the log at `path`, written whole through a temporary file renamed over the last one, so a write that stops midway leaves that last one. A flake already in the log (the same run, head and test) is
 * not added twice, and those older than {@link KEPT_DAYS} days are dropped. THROWS when the file cannot be written.
 */
export function recordFlakes(path: string, found: readonly Flake[], now: number): void {
  const oldest = now - KEPT_DAYS * DAY_MS;
  const held = readFlakes(path);
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

/** The flakes the pool records and the board and `doctor` list. */
export type FlakeLog = Readonly<{ record: (found: readonly Flake[]) => void; view: () => FlakesView }>;

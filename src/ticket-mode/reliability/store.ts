// @ts-check
// module: the reliability watches on disk (A11-366) -- `reliability-watches.json` in the board's tickets directory, replaced whole by rename as `after-merge-checks.json` is
//
// The pool's sweep and `doctor` both read it, and only the sweep writes it. Each change reads the file, changes it and writes it back with nothing awaited in between.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Watch } from "./watch.ts";

/** The file the watches are kept in: beside the queue and the After-merge checks. */
export const RELIABILITY_WATCHES_FILE = "reliability-watches.json";

/** What the file holds: each watch by its ticket's key. */
export type WatchesFile = Readonly<{ watches: Readonly<Record<string, Watch>> }>;

export const emptyWatches = (): WatchesFile => ({ watches: {} });

/** Where `stateDir`'s board keeps its reliability watches. */
export const reliabilityWatchesPath = (stateDir: string): string => join(stateDir, "tickets", RELIABILITY_WATCHES_FILE);

const STATES: readonly unknown[] = ["open", "watching", "breached", "reopened", "held"];

/** Whether `value` is what {@link saveWatches} writes: `watches` maps keys to records with a known state. */
function isWatchesFile(value: unknown): value is WatchesFile {
  if (typeof value !== "object" || value === null) return false;
  const { watches } = value as { watches?: unknown };
  if (typeof watches !== "object" || watches === null || Array.isArray(watches)) return false;
  return Object.values(watches).every((watch) => typeof watch === "object" && watch !== null && STATES.includes((watch as { state?: unknown }).state));
}

/** The watches on disk, or none when there is no file. A file that cannot be read THROWS: read as empty, it would be written over, and every reopen it records lost. */
export function loadWatches(path: string): WatchesFile {
  if (!existsSync(path)) return emptyWatches();
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isWatchesFile(parsed)) throw new Error(`${path} is not a reliability watch record`);
  return parsed;
}

/** Replace the file whole: write beside it, then rename over it. */
export function saveWatches(path: string, file: WatchesFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const next = `${path}.next`;
  writeFileSync(next, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(next, path);
}

/** Read the file, change it, and write it back when the change gave a new file. Returns the file as it now is. */
export function changeWatches(path: string, change: (file: WatchesFile) => WatchesFile): WatchesFile {
  const before = loadWatches(path);
  const after = change(before);
  if (after !== before) saveWatches(path, after);
  return after;
}

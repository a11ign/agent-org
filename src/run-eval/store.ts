// @ts-check
// module: the worker eval's stored runs (A11-431, step 2 of 2) -- one JSON file per set, sha and config-key setting, so two runs can be compared after both finish
//
// A RUN IS STORED BY ITS SET, ITS SHA AND ITS KEY: `<resultsDir>/<set>/<sha>.json`, or `<sha>@<key>=<on|off>.json` for a run with a config key set (`key.ts`). The sha is the
// commit of the checkout the eval ran from, which holds the brief it measured. A run from a checkout with uncommitted changes is `<sha>-dirty`: the sha alone does not name its
// code, so it is never stored in place of the clean run at that sha, nor read as it.
//
// A REF NAMES A STORED RUN as a person types it: a sha or its start, then `-dirty` for a run with uncommitted changes, then `@<key>=<on|off>` when the run set a key. A ref
// that matches no run, or more than one, is refused naming what it found, so a compare never reads the wrong run.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type KeySetting } from "./key.ts";
import { type TicketResult } from "../run-eval.ts";

/** Why a run stopped before its set's end: the token cap was reached with tickets still to start. */
export type Stopped = Readonly<{ ran: number; of: number; tokens: number; cap: number; notStarted: readonly string[] }>;

/** A stored run of a set. */
export type StoredRun = Readonly<{
  v: 1;
  set: string;
  sha: string;
  dirty: boolean;
  key: KeySetting | null;
  model: string;
  effort: string;
  /** When the run finished, in milliseconds since the epoch. */
  at: number;
  stopped: Stopped | null;
  results: readonly TicketResult[];
}>;

/** A set's name as its results folder is named: a set given by path is named by its file, without `.json`. PURE. */
export const setNameOf = (set: string): string => basename(set).replace(/\.json$/, "");

/** The commit an eval runs from, which names its stored results, and whether its checkout had uncommitted changes, tracked or not. */
export type Revision = Readonly<{ sha: string; dirty: boolean }>;

/** The file name a run is stored under. PURE. */
export const runFileName = ({ sha, dirty }: Revision, key: KeySetting | null): string => `${sha}${dirty ? "-dirty" : ""}${key === null ? "" : `@${key.name}=${key.on ? "on" : "off"}`}.json`;

/** Where a run of `set` from `revision` with `key` is stored. PURE. */
export const runPath = (resultsDir: string, set: string, revision: Revision, key: KeySetting | null): string => join(resultsDir, setNameOf(set), runFileName(revision, key));

/** Store `run`, replacing a run stored under the same name. Returns the path written. The file is written whole, then moved into place, so a reader never sees half of it. */
export function storeRun(resultsDir: string, run: StoredRun): string {
  const path = runPath(resultsDir, run.set, run, run.key);
  mkdirSync(join(resultsDir, setNameOf(run.set)), { recursive: true });
  writeFileSync(`${path}.partial`, `${JSON.stringify(run, null, 2)}\n`);
  renameSync(`${path}.partial`, path);
  return path;
}

/** A ref or a stored file's name, read: a sha or its start, whether it is a dirty run, and the key setting after `@`, or null. Null when it is not that shape. PURE. */
export function parseRef(ref: string): { sha: string; dirty: boolean; key: string | null } | null {
  const found = /^([0-9a-f]{4,40})(-dirty)?(?:@([A-Za-z0-9_.]+=(?:on|off)))?$/.exec(ref.replace(/^[0-9A-F]+/i, (sha) => sha.toLowerCase()));
  return found === null ? null : { sha: found[1], dirty: found[2] !== undefined, key: found[3] ?? null };
}

/** The stored run `ref` names in `set`'s results. THROWS naming the ref when it is malformed, or matches no stored run or more than one. */
export function loadRun(resultsDir: string, set: string, ref: string): StoredRun {
  const parsed = parseRef(ref);
  if (parsed === null) throw new Error(`${ref} is not a run: give a sha or its start, then -dirty for a run with uncommitted changes, then @<key>=on or @<key>=off for a run that set a key`);
  const folder = join(resultsDir, setNameOf(set));
  const stored = existsSync(folder) ? readdirSync(folder).filter((file) => file.endsWith(".json")) : [];
  const matches = stored.filter((file) => {
    const name = parseRef(file.slice(0, -".json".length));
    return name !== null && name.sha.startsWith(parsed.sha) && name.dirty === parsed.dirty && name.key === parsed.key;
  });
  if (matches.length === 0) throw new Error(`no stored run of ${setNameOf(set)} is ${ref} (stored: ${stored.length === 0 ? "none" : stored.map((file) => file.slice(0, -".json".length)).join(", ")})`);
  if (matches.length > 1) throw new Error(`${ref} names ${matches.length} stored runs of ${setNameOf(set)}: ${matches.join(", ")}; give more of the sha`);
  return JSON.parse(readFileSync(join(folder, matches[0]), "utf8")) as StoredRun;
}

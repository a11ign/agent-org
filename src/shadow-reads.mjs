// @ts-check
// Row #2849 (the split, child 5d-0 of #69): the live gate TAPS its own `decide` call, for the shadow-window runner (#2846).
//
// WHY A TAP AND NOT A SECOND SET OF READS. ADR 0040 decision 5 (1) says the shadow adds no GitHub calls, and a runner that
// read for itself would read at a different instant than the live gate -- every PR or label that changed between the two
// reads would show up as a "difference" that is the clock and not the code. So the live gate records the exact object it
// called `decide` with, plus what `decide` returned, and the runner replays only the CANDIDATE over `args`.
//
// DORMANT UNTIL THE MARKER EXISTS. `<stateDir>/shadow-window-open` is created by the host arrangement that opens the window
// (asked of `ceo` on #2623); nothing in this file creates it. With the marker absent a tap costs one `existsSync`, writes
// nothing and makes no directory, so merging this starts nothing.
//
// FOUR WAYS THE TAP COULD HURT THE LIVE GATE, AND THE ANSWER TO EACH:
//   1. It never changes the tick's outcome: every failure comes back as a diagnostic and on stderr, and none throws.
//   2. It is bounded: the newest `KEEP_TICKS` records stay (one hour at two minutes); 1,440 unpruned ticks is the failure.
//   3. It is atomic: a temp name in the SAME directory, then `rename`, so the runner never reads half a file.
//   4. `args` must survive a round trip, and a bare `JSON.stringify` did not (#2858): `decide`'s `closings` is a `Map`, which it writes
//      as `{}`. So `args` is written through `encodeShadowValue` -- a Map, a Set and a Date as TAGGED objects -- and read back through
//      `parseShadowRecord`, which lives HERE so the writer and the reader cannot drift and the runner imports instead of copying.
//      Any OTHER non-plain value is named in a diagnostic by its key path, because a fourth type added to `decide`'s arguments should
//      fail on the first tick and not in hour thirty of a window.
import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateEntryPath } from "./host-config.mjs";

/** The marker whose EXISTENCE opens the window. Not read for content. */
export const SHADOW_WINDOW_MARKER = "shadow-window-open";
/** Where the records go, under the state directory. */
export const SHADOW_READS_DIR = "shadow-reads";
/** One hour of ticks at two minutes. The runner records a GAP for a tick id it never saw, so pruning loses no information it needs. */
export const KEEP_TICKS = 30;

const RECORD_NAME = /^(\d+)\.json$/;
/** A temp name never matches `RECORD_NAME`, so the runner listing the directory cannot mistake one for a tick. */
/** @param {number} tick */
const tempName = (tick) => `.${tick}.json.tmp`;
const TEMP_NAME = /^\.\d+\.json\.tmp$/;

/** The key that marks a tagged object, and the tags this module writes and reads. Nothing else carries one. */
const TYPE_TAG = "$type";
const KNOWN_TAGS = ["Map", "Set", "Date"];
/** A tick that holds a thousand class instances must not write a thousand log lines every two minutes. */
const MAX_DIAGNOSTICS = 10;

/**
 * @typedef {{ diagnostics: string[], ancestors: object[] }} Walk
 * `ancestors` is the chain from the root to the value being encoded: a value met again inside itself is a cycle.
 */

/** @param {unknown} value */
const isPlainObject = (value) => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** @param {string} path @param {string} what @param {Walk} walk */
function note(path, what, walk) {
  if (walk.diagnostics.length < MAX_DIAGNOSTICS) walk.diagnostics.push(`${path} ${what}`);
  else if (walk.diagnostics.length === MAX_DIAGNOSTICS) walk.diagnostics.push("and more values the tap cannot encode, not listed");
}

/**
 * A `bigint`, a function or a symbol cannot be written as JSON at all (`JSON.stringify` throws on the first and silently drops the others).
 * It is named and left out, so the file is still written and the gap is on the log.
 * @param {string} path @param {unknown} value @param {Walk} walk
 */
function leaveOut(path, value, walk) {
  note(path, `is a ${typeof value}, which cannot be written as JSON; it was left out of the record`, walk);
  return undefined;
}

/**
 * Encode the children of one object. `path` names where each sits IN THE FILE AS WRITTEN (`.entries[0][1]`), so a diagnostic can be followed there.
 * @param {object} value @param {string} path @param {Walk} walk
 * @returns {unknown}
 */
function encodeObject(value, path, walk) {
  /** @param {unknown} item @param {string} at */
  const child = (item, at) => encodeShadowAt(item, `${path}${at}`, walk);
  if (value instanceof Date) return { [TYPE_TAG]: "Date", iso: Number.isNaN(value.getTime()) ? null : value.toISOString() };
  if (value instanceof Map) return { [TYPE_TAG]: "Map", entries: [...value].map(([k, v], i) => [child(k, `.entries[${i}][0]`), child(v, `.entries[${i}][1]`)]) };
  if (value instanceof Set) return { [TYPE_TAG]: "Set", values: [...value].map((item, i) => child(item, `.values[${i}]`)) };
  if (Array.isArray(value)) return value.map((item, i) => child(item, `[${i}]`));
  if (!isPlainObject(value)) note(path, `is a ${value.constructor?.name ?? "non-plain object"}, which is not a Map, a Set or a Date; it was written as a plain object and will not revive as one`, walk);
  else if (KNOWN_TAGS.includes(/** @type {any} */ (value)[TYPE_TAG])) note(path, `holds ${TYPE_TAG} "${/** @type {any} */ (value)[TYPE_TAG]}", which reading would turn into a ${/** @type {any} */ (value)[TYPE_TAG]}`, walk);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, child(item, `.${key}`)]));
}

/** @param {unknown} value @param {string} path @param {Walk} walk */
function encodeShadowAt(value, path, walk) {
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") return leaveOut(path, value, walk);
  if (value === null || typeof value !== "object") return value;
  if (walk.ancestors.includes(value)) throw new TypeError(`circular structure at ${path}`);
  walk.ancestors.push(value);
  try {
    return encodeObject(value, path, walk);
  } finally {
    walk.ancestors.pop();
  }
}

/**
 * Turn `value` into something `JSON.stringify` writes faithfully: a Map, a Set and a Date as tagged objects (recursively, so a Map inside a Map or an array
 * survives), everything plain as it was. Anything else non-plain comes back in `diagnostics`, naming its key path and its constructor, and does not throw;
 * only a CYCLE throws, which `tapShadowReads` turns into its own diagnostic.
 * @param {unknown} value @param {string} [root]
 * @returns {{ encoded: unknown, diagnostics: string[] }}
 */
export function encodeShadowValue(value, root = "args") {
  /** @type {Walk} */ const walk = { diagnostics: [], ancestors: [] };
  return { encoded: encodeShadowAt(value, root, walk), diagnostics: walk.diagnostics };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isTagged = (value) => typeof value === "object" && value !== null && !Array.isArray(value) && isPlainObject(value);

/**
 * The `JSON.parse` reviver that undoes `encodeShadowValue`. `JSON.parse` calls it children first, so a tagged object arrives with its contents already revived.
 * An object it does not recognise -- no tag, another tag, or a known tag with the wrong shape -- is returned AS IT WAS, so a record written before #2858 still reads.
 * @param {string} _key @param {unknown} value
 */
export function reviveShadowValue(_key, value) {
  if (!isTagged(value)) return value;
  if (value[TYPE_TAG] === "Map" && Array.isArray(value.entries) && value.entries.every((entry) => Array.isArray(entry) && entry.length === 2)) return new Map(value.entries);
  if (value[TYPE_TAG] === "Set" && Array.isArray(value.values)) return new Set(value.values);
  if (value[TYPE_TAG] === "Date" && (typeof value.iso === "string" || value.iso === null)) return new Date(value.iso ?? Number.NaN);
  return value;
}

/**
 * Read one record's text back, with its Map, Set and Date restored. This is what the shadow runner calls, instead of keeping a copy of the reviver.
 * The result is `any`: a record is `{ tick, args, orders }`, but the text is whatever JSON was handed in.
 * @param {string} text
 * @returns {any}
 */
export const parseShadowRecord = (text) => JSON.parse(text, reviveShadowValue);

/** @param {unknown} cause */
const causeText = (cause) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Write one tick's record atomically, and return its path with whatever `args` held that the tap could not encode.
 * @param {{ dir: string, tick: number, args: unknown, orders: unknown }} record
 * @returns {{ path: string, diagnostics: string[] }}
 */
function writeRecord({ dir, tick, args, orders }) {
  mkdirSync(dir, { recursive: true });
  const { encoded, diagnostics } = encodeShadowValue(args);
  const temp = join(dir, tempName(tick));
  const final = join(dir, `${tick}.json`);
  writeFileSync(temp, JSON.stringify({ tick, args: encoded, orders }));
  renameSync(temp, final);
  return { path: final, diagnostics };
}

/**
 * Keep the newest `keep` records and delete the rest, OLDEST first by tick id; also sweep temp debris an interrupted write left.
 * Never throws: a file that will not go is named in `diagnostics` and the others are still tried.
 * @param {string} dir @param {{ keep?: number }} [options]
 * @returns {{ removed: string[], diagnostics: string[] }}
 */
export function pruneShadowReads(dir, { keep = KEEP_TICKS } = {}) {
  /** @type {string[]} */ const removed = [];
  /** @type {string[]} */ const diagnostics = [];
  let names;
  try {
    names = readdirSync(dir);
  } catch (cause) {
    return { removed, diagnostics: [`could not list ${dir}: ${causeText(cause)}`] };
  }
  const ticks = names.filter((name) => RECORD_NAME.test(name)).sort((a, b) => Number(a.match(RECORD_NAME)?.[1]) - Number(b.match(RECORD_NAME)?.[1]));
  const stale = [...ticks.slice(0, Math.max(0, ticks.length - keep)), ...names.filter((name) => TEMP_NAME.test(name))];
  for (const name of stale) {
    try {
      unlinkSync(join(dir, name));
      removed.push(name);
    } catch (cause) {
      diagnostics.push(`could not remove ${join(dir, name)}: ${causeText(cause)}`);
    }
  }
  return { removed, diagnostics };
}

/**
 * Record one tick's `decide` call, if the shadow window is open. `args` is the exact object `decide` was called with and `orders`
 * its RAW return (before `withStalePrimaryNotice`), so the runner compares like with like.
 *
 * NEVER THROWS, and never changes what the tick does: a failure is written to `log` with its cause and returned in `diagnostic`.
 * That includes a failed PRUNE after a good write: `recorded` is then true, and `diagnostic` carries the pruning failures.
 * @param {{ args: unknown, orders: unknown, tick?: number, stateDir?: string, keep?: number, log?: (line: string) => void }} tap
 * @returns {{ recorded: boolean, path?: string, diagnostic?: string }}
 */
export function tapShadowReads({ args, orders, tick = Date.now(), stateDir = stateEntryPath(""), keep = KEEP_TICKS, log = (line) => process.stderr.write(line) }) {
  try {
    if (!existsSync(join(stateDir, SHADOW_WINDOW_MARKER))) return { recorded: false };
    const dir = join(stateDir, SHADOW_READS_DIR);
    const written = writeRecord({ dir, tick, args, orders });
    const { path } = written;
    // The record is on disk, so an unencodable value or a pruning failure is reported and is not a failed tap: `recorded` stays true, and the caller is told too.
    const diagnostics = [...written.diagnostics, ...pruneShadowReads(dir, { keep }).diagnostics];
    for (const line of diagnostics) log(`shadow-reads: ${line}\n`);
    return diagnostics.length === 0 ? { recorded: true, path } : { recorded: true, path, diagnostic: diagnostics.join("; ") };
  } catch (cause) {
    const diagnostic = `could not record tick ${tick} under ${join(stateDir, SHADOW_READS_DIR)}: ${causeText(cause)}`;
    log(`shadow-reads: ${diagnostic}\n`);
    return { recorded: false, diagnostic };
  }
}

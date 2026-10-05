// @ts-check
// THE CENSUS OF EVERY PROCESS A TICK STARTS, BY COMMAND (a11ign/a11ign#3566). A tick is a `node` that starts a gate, which starts `gh`, `git` and
// `herdr`; the tick's own CPU and wall say nothing about which of those it waited on, and a profile of the node process alone under-reads the tick
// by exactly the children (the row's first paragraph). So every `node` the tick runs is preloaded with this file, and each synchronous spawn
// leaves one line: what ran and how long it took.
//
// WHY A PATCH AND NOT A WRAPPER AT EACH CALL SITE. The tick path has about forty spawn sites across `work-gate.mjs`, `wake.mjs` and their helpers,
// and a census that needs each of them edited is one a new site silently escapes. `syncBuiltinESMExports()` is what makes patching the builtin
// reach modules that already imported `execFileSync` by name.
//
// NOTHING HERE MAY CHANGE WHAT A SPAWN DOES: the original runs, its result or its throw comes back untouched, and a line that cannot be written is
// said once on stderr and never thrown into the caller.
import childProcess from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

/** Where each process of the tick appends its lines. Set by the tick, inherited by every child it starts. */
export const CENSUS_ENV = "AGENT_ORG_TICK_CENSUS";

/** How many of the slowest command lines one reading keeps: the row asks for the top 5 by wall. */
export const SLOWEST_KEPT = 5;

/** One argument and one command line are cut here: an order's prompt is an argument and has no business in a cost record. */
const ARG_CHARS = 40;
const LINE_CHARS = 120;

const INSTALLED = Symbol.for("agent-org.spawn-census.installed");

/**
 * An argument is cut to its TAIL: a path's last segment (`work-gate.mjs`) says what ran, and an order's prompt, which is also an argument, has
 * its end cut off with the rest of it.
 * @param {unknown} arg @returns {string}
 */
const tail = (arg) => String(arg).length > ARG_CHARS ? `…${String(arg).slice(-ARG_CHARS)}` : String(arg);

/**
 * The repository a `gh` call was aimed at. The gate aims by `GH_REPO` in the spawn's `env` and not by an argument, so without it nine
 * `gh pr list --state open` lines look identical and the census cannot say whether they read nine repositories or one nine times
 * (the 2026-10-05 reading, a11ign/a11ign#3566). The options object is the last non-array object among the arguments.
 * @param {unknown[]} args
 * @returns {string | undefined}
 */
function aimedRepo(args) {
  const options = /** @type {any} */ (args.filter((arg) => arg !== null && typeof arg === "object" && !Array.isArray(arg)).at(-1));
  const repo = options?.env?.GH_REPO;
  return typeof repo === "string" && repo !== "" ? repo : undefined;
}

/**
 * What ran, as `{ cmd, line }`: `cmd` is the program's basename (`gh`, `git`, `herdr`, `node`) and `line` the program plus its arguments, cut.
 * `execSync` hands over one string, whose first word is the program and the rest its arguments. A `gh` aimed by `GH_REPO` also carries `repo`.
 * @param {string} file @param {unknown} argv @param {unknown} [options] the spawn's options, where `env.GH_REPO` aims a `gh` call
 * @returns {{ cmd: string, line: string, repo?: string }}
 */
export function describeSpawn(file, argv, options) {
  const [program = "", ...inline] = String(file).trim().split(/\s+/);
  const cmd = basename(program);
  const words = Array.isArray(argv) ? argv : inline;
  const repo = cmd === "gh" ? aimedRepo([argv, options]) : undefined;
  return { cmd, line: [cmd, ...words.map(tail)].join(" ").slice(0, LINE_CHARS), ...(repo === undefined ? {} : { repo }) };
}

/** @param {string} path @param {object} entry */
function appendRecord(path, entry) {
  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    process.stderr.write(`SPAWN CENSUS NOT RECORDED at ${path}: ${String(/** @type {any} */ (error)?.message ?? error)}\n`);
  }
}

/**
 * `original` wrapped so each call leaves one untimed line first. Untimed: the call returns before the child does.
 * @param {string} path @param {Function} original
 */
function countedBefore(path, original) {
  return function (/** @type {any[]} */ ...args) {
    appendRecord(path, { ...describeSpawn(args[0], args[1], args[2]), ms: null, pid: process.pid });
    // @ts-ignore -- `this` is whatever the caller bound, passed through untouched
    return original.apply(this, args);
  };
}

/**
 * `execFile` carries its own `util.promisify.custom`, which is what makes `promisify(execFile)` resolve `{ stdout, stderr }`. A wrapper
 * without it falls back to the generic promisify and resolves a bare string, so callers destructuring the result silently get `undefined`
 * (ceo's review of agent-org#208). Node's custom function starts the child through its own internal `execFile`, not the patched one, so it is
 * counted here rather than relied on to reach the wrapper. (`exec` needs none of this: it is not wrapped, and reaches the patched `execFile`.)
 * @param {any} original @param {any} wrapper @param {string} path
 */
function carryPromisified(original, wrapper, path) {
  const custom = original[promisify.custom];
  if (typeof custom !== "function") return;
  wrapper[promisify.custom] = countedBefore(path, custom);
}

/**
 * Patch the synchronous spawns (timed: the caller is blocked for exactly that long) and the asynchronous ones (counted, with no wall: the call
 * returns before the child does). Idempotent, so the tick can install in-process and its preload can install again.
 * @param {string} path
 */
export function installSpawnCensus(path) {
  // THE DEFAULT EXPORT, NOT THE NAMESPACE: the namespace object is frozen, and `module.exports` is what `syncBuiltinESMExports` copies from.
  // The mark is on `globalThis`, since this file can be loaded twice under two URLs (the tick's own import and the preload's).
  const target = /** @type {any} */ (childProcess);
  const marked = /** @type {any} */ (globalThis);
  if (marked[INSTALLED]) return;
  marked[INSTALLED] = true;
  for (const name of ["spawnSync", "execFileSync", "execSync"]) {
    const original = target[name];
    target[name] = function (/** @type {any[]} */ ...args) {
      const started = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        appendRecord(path, { ...describeSpawn(args[0], args[1], args[2]), ms: Math.round(performance.now() - started), pid: process.pid });
      }
    };
  }
  // NOT `exec`: Node's `exec` starts its child through `module.exports.execFile`, which is patched here, so wrapping it too records every `exec` twice.
  for (const name of ["spawn", "execFile"]) {
    const original = target[name];
    const counted = countedBefore(path, original);
    target[name] = counted;
    carryPromisified(original, counted, path);
  }
  syncBuiltinESMExports();
}

/**
 * The lines of a census file. A line that does not parse is skipped and counted, never fatal: a census must not stop the tick that wrote it.
 * @param {string} path
 * @returns {{ cmd: string, line: string, ms: number | null }[]}
 */
export function readCensus(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (/** @type {any} */ (error)?.code === "ENOENT") return [];
    throw error;
  }
  return text.split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      process.stderr.write(`SPAWN CENSUS: skipped an unreadable line in ${path}: ${line.slice(0, 60)}\n`);
      return [];
    }
  });
}

/**
 * The reading the cost line carries: per command, how many were started and how long the timed ones took (an asynchronous spawn adds to the count
 * and not to the wall), and the slowest command lines by wall.
 * `ghRepos` is the same count for the `gh` calls aimed by `GH_REPO`, per repository: how many reads each repository took in one tick.
 * @param {{ cmd: string, line: string, ms: number | null, repo?: string }[]} records
 * @returns {{ commands: Record<string, { n: number, wallMs: number }>, ghRepos: Record<string, { n: number, wallMs: number }>, slowest: { line: string, ms: number }[] }}
 */
export function summariseCensus(records) {
  /** @type {Record<string, { n: number, wallMs: number }>} */
  const commands = {};
  /** @type {Record<string, { n: number, wallMs: number }>} */
  const ghRepos = {};
  for (const { cmd, ms, repo } of records) {
    const entries = repo === undefined ? [commands[cmd] ??= { n: 0, wallMs: 0 }] : [commands[cmd] ??= { n: 0, wallMs: 0 }, ghRepos[repo] ??= { n: 0, wallMs: 0 }];
    for (const entry of entries) {
      entry.n += 1;
      entry.wallMs += ms ?? 0;
    }
  }
  const slowest = records.filter((r) => r.ms !== null).map((r) => ({ line: r.line, ms: /** @type {number} */ (r.ms) }))
    .sort((a, b) => b.ms - a.ms).slice(0, SLOWEST_KEPT);
  return { commands, ghRepos, slowest };
}

if (process.env[CENSUS_ENV]) installSpawnCensus(process.env[CENSUS_ENV]);

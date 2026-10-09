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

/** Linux's `USER_HZ`: `/proc/<pid>/stat` counts CPU in these, and it is 100 on every kernel configuration this host runs. */
const CLOCK_TICKS_PER_SECOND = 100;
const MS_PER_SECOND = 1000;

/**
 * CPU this process's CHILDREN used, in ms, from the `cutime` and `cstime` fields of `/proc/self/stat` -- which count every child this process has waited
 * for, and each of those counts the ones it waited for. `process.cpuUsage()` cannot say it: it is this process alone, and systemd's `CPU:` figure,
 * which the row's table quotes, is the whole tree. Reading the two against each other is how "starved" is told from "waiting".
 *
 * The command name is field 2 and may hold spaces and brackets, so the fields are counted from the LAST `)`. `NaN` (`null` in the line) when the
 * file is unreadable: an unknown CPU is not zero CPU.
 * @param {() => string} [readStat] @returns {number}
 */
export function childrenCpuMs(readStat: () => string = () => readFileSync("/proc/self/stat", "utf8")): number {
  try {
    const stat = readStat();
    const afterName = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const [cutimeAt, cstimeAt] = [13, 14]; // fields 16 and 17 of proc(5); `afterName` starts at field 3
    return (Number(afterName[cutimeAt]) + Number(afterName[cstimeAt])) * (MS_PER_SECOND / CLOCK_TICKS_PER_SECOND);
  } catch {
    return Number.NaN;
  }
}

/** Where each process of the tick appends its lines. Set by the tick, inherited by every child it starts. */
export const CENSUS_ENV = "AGENT_ORG_TICK_CENSUS";

/** How many of the slowest (and the hottest) command lines one reading keeps: the row asks for the top 5 by wall, and by CPU. */
export const SLOWEST_KEPT = 5;

/** How many subcommands one reading names (the slowest by wall); the rest are summed into `other`, so a line stays short and the total still adds up. */
export const SUBCOMMANDS_KEPT = 10;

/**
 * The programs whose first words say what they did, and how many: `gh pr list` and `herdr agent list` take two (and `gh api <path>` needs its path), while
 * `git rev-parse HEAD` is `rev-parse` and its argument is not part of the name. A `node` is named by its script, in `slowest`.
 */
const SUBCOMMAND_WORDS = { gh: 2, git: 1, herdr: 2 };
/** Options of those programs that take their value as the NEXT word, which is therefore not a subcommand: git's `-C` and `-c`, gh's `-R`. */
const VALUE_OPTIONS = new Set(["-C", "-c", "-R", "--repo"]);

/** One argument and one command line are cut here: an order's prompt is an argument and has no business in a cost record. */
const ARG_CHARS = 40;
const LINE_CHARS = 120;

const INSTALLED = Symbol.for("agent-org.spawn-census.installed");

/**
 * An argument is cut to its TAIL: a path's last segment (`work-gate.mjs`) says what ran, and an order's prompt, which is also an argument, has
 * its end cut off with the rest of it.
 * @param {unknown} arg @returns {string}
 */
const tail = (arg: unknown): string => String(arg).length > ARG_CHARS ? `…${String(arg).slice(-ARG_CHARS)}` : String(arg);

/**
 * The repository a `gh` call was aimed at. The gate aims by `GH_REPO` in the spawn's `env` and not by an argument, so without it nine
 * `gh pr list --state open` lines look identical and the census cannot say whether they read nine repositories or one nine times
 * (the 2026-10-05 reading, a11ign/a11ign#3566). The options object is the last non-array object among the arguments.
 * @param {unknown[]} args
 * @returns {string | undefined}
 */
function aimedRepo(args: unknown[]): string | undefined {
  const options = /** @type {any} */ (args.filter((arg) => arg !== null && typeof arg === "object" && !Array.isArray(arg)).at(-1));
  const repo = options?.env?.GH_REPO;
  return typeof repo === "string" && repo !== "" ? repo : undefined;
}

/**
 * What a `gh`, `git` or `herdr` call DID, by its first words that are not options (two for `gh` and `herdr`, one for `git`): `pr list`, `issue view`, `api repos/<owner>/<repo>/issues/#/timeline`.
 * A path segment that is only digits is `#` and a query string is dropped, so an issue number does not make every call its own name -- that is
 * what a count by subcommand is for, and the line's per-command total cannot say which of 66 `gh` calls took the 50 s (a11ign/a11ign#3566).
 * `undefined` for any other program, and for a call with only options.
 * @param {string} cmd @param {unknown[]} words
 * @returns {string | undefined}
 */
function subcommandOf(cmd: string, words: unknown[]): string | undefined {
  const wanted = /** @type {Record<string, number>} */ (SUBCOMMAND_WORDS)[cmd];
  if (wanted === undefined) return undefined;
  /** @type {string[]} */
  const named: string[] = [];
  for (let at = 0; at < words.length && named.length < wanted; at += 1) {
    const word = String(words[at]);
    if (VALUE_OPTIONS.has(word)) at += 1;
    else if (!word.startsWith("-")) named.push(word.split("?")[0].replace(/(?<=^|\/)\d+(?=\/|$)/g, "#"));
  }
  return named.length === 0 ? undefined : named.join(" ");
}

/**
 * What ran, as `{ cmd, line }`: `cmd` is the program's basename (`gh`, `git`, `herdr`, `node`) and `line` the program plus its arguments, cut.
 * `execSync` hands over one string, whose first word is the program and the rest its arguments. A `gh` aimed by `GH_REPO` also carries `repo`;
 * a `gh`, `git` or `herdr` also carries `sub`, the subcommand.
 * @param {string} file @param {unknown} argv @param {unknown} [options] the spawn's options, where `env.GH_REPO` aims a `gh` call
 * @returns {{ cmd: string, line: string, repo?: string, sub?: string }}
 */
export function describeSpawn(file: string, argv: unknown, options?: unknown): { cmd: string; line: string; repo?: string; sub?: string; } {
  const [program = "", ...inline] = String(file).trim().split(/\s+/);
  const cmd = basename(program);
  const words = Array.isArray(argv) ? argv : inline;
  const repo = cmd === "gh" ? aimedRepo([argv, options]) : undefined;
  const sub = subcommandOf(cmd, words);
  return { cmd, line: [cmd, ...words.map(tail)].join(" ").slice(0, LINE_CHARS), ...(repo === undefined ? {} : { repo }), ...(sub === undefined ? {} : { sub }) };
}

/**
 * The phase the tick is in, kept on `globalThis` for the reason the install mark is: this file can be loaded twice under two URLs, and the setter
 * the tick calls must be the one the patched spawns read. Only this process's own spawns see it; a child's census (the gate's, the wake's) is another
 * process and records no phase.
 */
const PHASE = Symbol.for("agent-org.spawn-census.phase");

/** @param {string | undefined} name the phase now running, or `undefined` when none is */
export function setCensusPhase(name: string | undefined) {
  /** @type {any} */ (globalThis)[PHASE] = name;
}

/** @returns {string | undefined} */
export function currentCensusPhase(): string | undefined {
  return /** @type {any} */ (globalThis)[PHASE];
}

/** The phase field of a record: absent outside every phase, so an unattributed call is never filed under an empty name. @returns {{ phase?: string }} */
function phaseField(): { phase?: string; } {
  const phase = currentCensusPhase();
  return phase === undefined ? {} : { phase };
}

/** @param {string} path @param {object} entry */
function appendRecord(path: string, entry: object) {
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
function countedBefore(path: string, original: Function) {
  return function (/** @type {any[]} */ ...args: any[]) {
    appendRecord(path, { ...describeSpawn(args[0], args[1], args[2]), ...phaseField(), ms: null, pid: process.pid });
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
function carryPromisified(original: any, wrapper: any, path: string) {
  const custom = original[promisify.custom];
  if (typeof custom !== "function") return;
  wrapper[promisify.custom] = countedBefore(path, custom);
}

/**
 * Patch the synchronous spawns (timed: the caller is blocked for exactly that long) and the asynchronous ones (counted, with no wall: the call
 * returns before the child does). Idempotent, so the tick can install in-process and its preload can install again.
 * @param {string} path
 */
export function installSpawnCensus(path: string) {
  // THE DEFAULT EXPORT, NOT THE NAMESPACE: the namespace object is frozen, and `module.exports` is what `syncBuiltinESMExports` copies from.
  // The mark is on `globalThis`, since this file can be loaded twice under two URLs (the tick's own import and the preload's).
  const target = /** @type {any} */ (childProcess);
  const marked = /** @type {any} */ (globalThis);
  if (marked[INSTALLED]) return;
  marked[INSTALLED] = true;
  for (const name of ["spawnSync", "execFileSync", "execSync"]) {
    const original = target[name];
    target[name] = function (/** @type {any[]} */ ...args: any[]) {
      const started = performance.now();
      const cpuBefore = childrenCpuMs();
      try {
        return original.apply(this, args);
      } finally {
        // The caller is blocked until the child is reaped, so the move in `cutime + cstime` is that child's CPU and its descendants' -- a record's
        // `cpuMs` is INCLUSIVE, as its `ms` is. `null` when `/proc` was unreadable: an unknown CPU is not zero.
        const cpuMs = Math.round(childrenCpuMs() - cpuBefore);
        appendRecord(path, { ...describeSpawn(args[0], args[1], args[2]), ...phaseField(), ms: Math.round(performance.now() - started), cpuMs: Number.isNaN(cpuMs) ? null : cpuMs, pid: process.pid });
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
export function readCensus(path: string): { cmd: string; line: string; ms: number | null; }[] {
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
 * Per name: how many were started and their wall, the `SUBCOMMANDS_KEPT` slowest by wall, the rest summed into `other`.
 * @param {{ cmd: string, sub?: string, ms: number | null }[]} records
 * @param {(record: { cmd: string, sub?: string }) => string | undefined} nameOf `undefined` leaves a record out rather than counting it under an empty name
 * @returns {Record<string, { n: number, wallMs: number }>}
 */
function summariseNamed(records: { cmd: string; sub?: string; ms: number | null; }[], nameOf: (record: { cmd: string; sub?: string; }) => string | undefined): Record<string, { n: number; wallMs: number; }> {
  /** @type {Map<string, { n: number, wallMs: number }>} */
  const totals: Map<string, { n: number; wallMs: number; }> = new Map();
  for (const record of records) {
    const name = nameOf(record);
    if (name === undefined) continue;
    const entry = totals.get(name) ?? { n: 0, wallMs: 0 };
    entry.n += 1;
    entry.wallMs += record.ms ?? 0;
    totals.set(name, entry);
  }
  const ranked = [...totals].sort(([, a], [, b]) => b.wallMs - a.wallMs || b.n - a.n);
  const named = Object.fromEntries(ranked.slice(0, SUBCOMMANDS_KEPT));
  const rest = ranked.slice(SUBCOMMANDS_KEPT);
  if (rest.length === 0) return named;
  return { ...named, other: { n: rest.reduce((sum, [, e]) => sum + e.n, 0), wallMs: rest.reduce((sum, [, e]) => sum + e.wallMs, 0) } };
}

/** `<program> <subcommand>`; a record with no `sub` (a `node`, or a record from before the field) is left out. @param {{ cmd: string, sub?: string }} record */
const bySubcommand = ({ cmd, sub }: { cmd: string; sub?: string; }) => (sub === undefined ? undefined : `${cmd} ${sub}`);

/** `<program> <subcommand>`, or the program alone when it has none (`systemctl`, `ps`): inside one phase every call is wanted. @param {{ cmd: string, sub?: string }} record */
const bySubcommandOrProgram = ({ cmd, sub }: { cmd: string; sub?: string; }) => (sub === undefined ? cmd : `${cmd} ${sub}`);

/**
 * The same split, per phase, for the calls this process started while a phase was running: which of a phase's calls its wall went to.
 * @param {{ cmd: string, sub?: string, ms: number | null, phase?: string }[]} records
 * @returns {Record<string, Record<string, { n: number, wallMs: number }>>}
 */
function summarisePhases(records: { cmd: string; sub?: string; ms: number | null; phase?: string; }[]): Record<string, Record<string, { n: number; wallMs: number; }>> {
  const phases = [...new Set(records.flatMap(({ phase }) => (phase === undefined ? [] : [phase])))];
  return Object.fromEntries(phases.map((phase) => [phase, summariseNamed(records.filter((record) => record.phase === phase), bySubcommandOrProgram)]));
}

/**
 * The reading the cost line carries: per command, how many were started and how long the timed ones took (an asynchronous spawn adds to the count
 * and not to the wall), and the slowest command lines by wall.
 * `ghRepos` is the same count for the `gh` calls aimed by `GH_REPO`, per repository: how many reads each repository took in one tick.
 * `subcommands` is the same count per `gh pr list`, `git rev-parse`, `herdr agent list`: which of a command's calls the wall went to.
 * `phaseCalls` is that split per tick phase (`tearDownSpares`, ...), for the calls the tick's OWN process started inside one: a child's calls are in no phase.
 * `hottest` is the same cut by CPU, the other half of the row's question (wall far above CPU is waiting, CPU near wall is work): a timed spawn's
 * `cpuMs` is inclusive of its descendants, so a `node` that starts `gh` is listed with the `gh`'s CPU in it.
 * @param {{ cmd: string, line: string, ms: number | null, cpuMs?: number | null, repo?: string, sub?: string }[]} records
 * @returns {{ commands: Record<string, { n: number, wallMs: number }>, ghRepos: Record<string, { n: number, wallMs: number }>,
 *   subcommands: Record<string, { n: number, wallMs: number }>, phaseCalls: Record<string, Record<string, { n: number, wallMs: number }>>,
 *   slowest: { line: string, ms: number }[], hottest: { line: string, cpuMs: number, ms: number }[] }}
 */
export function summariseCensus(records: { cmd: string; line: string; ms: number | null; cpuMs?: number | null; repo?: string; sub?: string; }[]): {
    commands: Record<string, { n: number; wallMs: number; }>; ghRepos: Record<string, { n: number; wallMs: number; }>;
    subcommands: Record<string, { n: number; wallMs: number; }>; phaseCalls: Record<string, Record<string, { n: number; wallMs: number; }>>;
    slowest: { line: string; ms: number; }[]; hottest: { line: string; cpuMs: number; ms: number; }[];
} {
  /** @type {Record<string, { n: number, wallMs: number }>} */
  const commands: Record<string, { n: number; wallMs: number; }> = {};
  /** @type {Record<string, { n: number, wallMs: number }>} */
  const ghRepos: Record<string, { n: number; wallMs: number; }> = {};
  for (const { cmd, ms, repo } of records) {
    const entries = repo === undefined ? [commands[cmd] ??= { n: 0, wallMs: 0 }] : [commands[cmd] ??= { n: 0, wallMs: 0 }, ghRepos[repo] ??= { n: 0, wallMs: 0 }];
    for (const entry of entries) {
      entry.n += 1;
      entry.wallMs += ms ?? 0;
    }
  }
  const slowest = records.filter((r) => r.ms !== null).map((r) => ({ line: r.line, ms: /** @type {number} */ (r.ms) }))
    .sort((a, b) => b.ms - a.ms).slice(0, SLOWEST_KEPT);
  const hottest = records.filter((r) => typeof r.cpuMs === "number" && r.ms !== null)
    .map((r) => ({ line: r.line, cpuMs: /** @type {number} */ (r.cpuMs), ms: /** @type {number} */ (r.ms) }))
    .sort((a, b) => b.cpuMs - a.cpuMs).slice(0, SLOWEST_KEPT);
  return { commands, ghRepos, subcommands: summariseNamed(records, bySubcommand), phaseCalls: summarisePhases(records), slowest, hottest };
}

if (process.env[CENSUS_ENV]) installSpawnCensus(process.env[CENSUS_ENV]);

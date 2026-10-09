// @ts-check
// A HOST-WIDE LIMIT ON CONCURRENT FULL TEST SUITES (a11ign/a11ign#3536, chairman via `ceo`, 2026-10-04).
//
// **NOTHING LIMITED HOW MANY FULL SUITES RAN AT ONCE, SO EVERY ENGINEER'S RUN SLOWED EVERY OTHER ONE.** `sar -q` over 36 samples had the 1-minute load at a median of 26.60 on 16
// cores and over 16 in 26 of them; at 21:35Z it read 98 with 94 `tsx` test processes alive, and one gate tick took 6 min 44 s. A suite is a whole `node --test` run (Node starts one
// process per test file, up to the available parallelism less one) and `pnpm run verify` runs two long steps side by side, so the number of suites at a moment was the number of
// engineers that happened to be verifying. This is the one place that says how many may.
//
// **A SLOT IS A LOCK FILE THE KERNEL HOLDS, BECAUSE THE KERNEL ALREADY HAS A COUNTING LOCK.** `flock(1)` takes an advisory lock on `slot-<n>.lock` and it is kept for as long as the command that
// inherited it lives. A holder that is killed, however it is killed, releases it with no clean-up: that is why this is a lock and not a counter file, which a SIGKILL would leave
// at "held" forever. Nothing here writes a number that has to be put back.
//
// **THE LOCK TRAVELS WITH THE COMMAND AND NOT WITH THIS PROCESS.** The command is `exec`ed by a shell that took the lock on its own fd (`HOLDER_SCRIPT`), so the process holding the lock IS
// the suite, a signal this module forwards reaches the suite, and killing this wrapper's parent does not free a slot a suite is still using.
//
// **A WAITING SUITE WAITS, AND SAYS SO (#51: a queued run that prints nothing reads as a hang).** The third contender polls every `WAIT_POLL_MS`, prints once at the start which slots are
// held, by what and for how long, and then every `WAIT_REPORT_MS`. It is not FIFO: whoever polls first after a release takes the slot, which is fair enough at two slots and a
// minute-scale suite, and a queue would need a second piece of state a killed waiter could leave behind.
//
// **A WAIT IS RECORDED, BECAUSE THE MESSAGE ABOVE DIES WITH THE WAITER (a11ign/a11ign#3664, found reading #3608).** It goes to the waiting suite's own stderr, so afterwards nobody could read whether a
// third contender ever queued, which is the only way to tell whether the slot count was the limit. A run that had to wait appends ONE line to `waits.log` in the slot directory when it gets
// its slot: when, the waiter's pid and cwd, how long it waited, the slot, the label. A file and not the journal: `systemd-cat` exists, but the record has to be isolated per slot
// directory (a test, `SLOT_DIR_ENV`), readable by whoever reads the locks beside it, and not rotated away. A run that never waited writes nothing, and a waiter that is killed while waiting writes
// nothing either (the line is written on acquire), which is a gap and not a claim that nobody waited.
//
// **EVERY SUITE RUNS AT `nice -n 15 ionice -c 3` (chairman, 2026-10-04T21:40Z)**, so the gate, the listener and the seats always win the CPU and the disk. Both values are named below and
// nothing else in either repository spells them.
//
// **A MISSING TOOL IS A REFUSAL, NEVER A SILENT RUN WITHOUT THE LIMIT.** If `flock`, `nice` or `ionice` is not on PATH, nothing runs and the message names it: a limit that quietly does not apply
// is worse than no limit, because everyone believes it does.
//
// **A RUNNER IS NOT THIS HOST.** With `CI` set the command runs as it is: no slot and no renice.
//
// THE TWO ENTRY POINTS: `pnpm run verify` (a11y-witness's `scripts/verify.mjs` calls {@link runUnderSlot} on ITSELF, so the whole run takes one slot however many steps it runs beside each
// other), and the full agent-org suite, `node src/suite-slots.ts suite`, which did not exist as one command. `node src/suite-slots.ts run -- <command>` is the same for any other full run.

import { spawn } from "node:child_process";
import { accessSync, appendFileSync, constants, mkdirSync, readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** How many full suites may run at once on this host. DERIVED, and changed only by a reading: 16 cores, load over 16 in 26 of 36 `sar` samples with 4 to 14 test processes alive, and one full suite measured at 5 children at one moment. */
export const SLOT_COUNT = 2;
/** `nice -n`: added to the caller's own niceness, so a suite is always at least this far behind the gate. */
export const NICE_LEVEL = 15;
/** `ionice -c`: 3 is the idle class, which gets the disk only when nobody else wants it. */
export const IONICE_CLASS = 3;
/** How often a waiting suite tries the slots again. */
export const WAIT_POLL_MS = 1000;
/** How often a waiting suite says it is still waiting. */
export const WAIT_REPORT_MS = 60_000;
/** The record of runs that had to wait, inside the slot directory: one tab-separated line per wait, appended when the waiter gets its slot. */
export const WAITS_LOG = "waits.log";
/** Set in the environment of a command that is running in a slot, to the slot's number: how a script that re-runs itself under a slot knows it already is. */
export const SLOT_ENV = "AGENT_ORG_SUITE_SLOT";
/** Names the directory holding the slots, for a test or an operator; by default a directory under `/tmp` (see {@link slotDirectory}). */
export const SLOT_DIR_ENV = "AGENT_ORG_SUITE_SLOT_DIR";
/**
 * The one place every caller on the host can write, which is why the slots live there: a reviewer's `codex sandbox` with `writable_roots = ["/tmp"]` has a read-only home, so slots under
 * `~/.cache` refused it (`Read-only file system`, a11ign/a11ign#3935, found on #3932). A LITERAL `/tmp`, never `os.tmpdir()`: that honours `TMPDIR`, and a caller that points `TMPDIR` at a private
 * directory (a sandbox must) would get a private slot directory and so a limit of its own, which is the one thing the slots exist to prevent.
 */
const SHARED_TMP = "/tmp";
/** `flock`'s own exit code for "the lock is held" (`--conflict-exit-code`): a command that exits it is still told apart, because `held` is read from the command having started, not from this code. */
const CONFLICT_EXIT = 200;
/** What the holder script exits when the lock file cannot be opened: a refusal, and not a held slot. */
const REFUSED_EXIT = 201;
/** Owner only: the directory sits in a world-writable `/tmp`, and nobody else has a reason to take or read a slot. */
const SLOT_DIR_MODE = 0o700;
const LABEL_LIMIT = 120;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SIGNAL_EXIT_BASE = 128;
const SIGNALS = (["SIGINT", "SIGTERM", "SIGHUP"] as const);

/**
 * What runs in place of the command, as `sh`: open the slot's lock file on fd 9 and take `flock` on it (`flock -n 9`, so a held slot is exit 200 and nothing else happens), record who
 * holds the slot (read by a waiter), say "held" on fd 3 (the one thing that tells the parent the command started, which no exit code can), close fd 3 so the command does not inherit it,
 * and `exec` the command under `nice` and `ionice`. **THE LOCK IS ON THE OPEN FILE DESCRIPTION, WHICH THE `exec`ED COMMAND KEEPS**, so the process holding the slot IS the command: a signal
 * sent to it reaches the suite, and the slot is freed by the command's death and by nothing else. (`flock <file> <command>` forks, and the parent that a SIGTERM reaches is not the suite.)
 * Positional: lock file, since, label, flock, nice, level, ionice, class.
 */
const HOLDER_SCRIPT = `lock="$1"; since="$2"; label="$3"; flock="$4"; nice="$5"; level="$6"; ionice="$7"; class="$8"; shift 8
exec 9>>"$lock" || exit ${REFUSED_EXIT}
"$flock" --nonblock --conflict-exit-code ${CONFLICT_EXIT} 9 || exit $?
printf '%s\\t%s\\t%s\\n' "$$" "$since" "$label" > "$lock"
echo held >&3
exec 3>&-
exec "$nice" -n "$level" "$ionice" -c "$class" "$@"`;

/** Refused before anything runs, and the message names what is missing: this is the error a caller prints and exits on. */
export class SuiteSlotRefusal extends Error {}

/** @param {Record<string, string | undefined>} env @returns {boolean} true on a GitHub runner (or anything else that sets `CI`): not this host, so no slot */
const onRunner = (env: Record<string, string | undefined>): boolean => Boolean(env.CI);

/**
 * The directory holding the slots: the SAME path for every caller on the host, whatever its `HOME`, `XDG_CACHE_HOME` or `TMPDIR`, because a path that varies with them is a limit per caller and
 * not per host (#3536). Per user (the uid in the name) so one user's directory, made 0700, cannot refuse another's; the agent host runs everything as one.
 * @param {Record<string, string | undefined>} env @returns {string}
 */
export function slotDirectory(env: Record<string, string | undefined> = process.env): string {
  if (env[SLOT_DIR_ENV]) return env[SLOT_DIR_ENV];
  return join(SHARED_TMP, `agent-org-suite-slots-${process.getuid?.() ?? "shared"}`);
}

/** @param {string} name @param {string | undefined} pathVar @returns {string | null} the first executable called `name` on `pathVar`, or null */
export function findOnPath(name: string, pathVar: string | undefined): string | null {
  for (const dir of (pathVar ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this directory: the next one is the answer, and none is reported by the refusal below.
    }
  }
  return null;
}

/** @param {Record<string, string | undefined>} env @returns {{ flock: string, nice: string, ionice: string }} @throws {SuiteSlotRefusal} naming every tool that is missing */
export function requiredTools(env: Record<string, string | undefined>): { flock: string; nice: string; ionice: string; } {
  const found = { flock: findOnPath("flock", env.PATH), nice: findOnPath("nice", env.PATH), ionice: findOnPath("ionice", env.PATH) };
  const missing = Object.entries(found).filter(([, path]) => path === null).map(([name]) => `\`${name}\``);
  if (missing.length > 0) {
    throw new SuiteSlotRefusal(`suite-slots: ${missing.join(" and ")} not found on PATH, so this suite is NOT being run: the host-wide limit on concurrent suites cannot be taken without `
      + "it, and running without the limit is the one outcome this refuses. Install util-linux (flock, ionice) and coreutils (nice), or run on a runner (`CI` set).");
  }
  return (found as { flock: string, nice: string, ionice: string });
}

/** @param {number | null} code @param {NodeJS.Signals | null} signal @returns {number} the shell's convention: the exit code, or 128 + the signal's number for a command a signal ended */
const exitStatus = (code: number | null, signal: NodeJS.Signals | null): number => (signal ? SIGNAL_EXIT_BASE + (osConstants.signals[signal] ?? 0) : (code ?? 1));

/** @param {number} ms @returns {string} `4m12s` */
function span(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / MS_PER_SECOND));
  return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m${String(seconds % SECONDS_PER_MINUTE).padStart(2, "0")}s`;
}

/** @param {string} text @returns {string} one line, cut short: what a slot's record and a waiter's message say a command is */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, LABEL_LIMIT);

/** @param {number} pid @returns {boolean} whether a process with this id exists */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Who holds slot `index`, as the holder recorded it. The record is informational: the LOCK is the truth, and a record left by a holder that died is shown as unreadable
 * rather than as a holder, because its pid is gone.
 * @param {string} dir @param {number} index @param {number} now @returns {string}
 */
export function describeSlot(dir: string, index: number, now: number): string {
  let record = "";
  try {
    record = readFileSync(join(dir, `slot-${index}.lock`), "utf8");
  } catch {
    // No record is a held slot whose holder has not written one yet (or one held by a plain `flock`): said as such.
  }
  const [pid, since, label] = record.trim().split("\t");
  if (!pid || !alive(Number(pid))) return `slot ${index}: held (no live record of by whom)`;
  return `slot ${index}: pid ${pid}, \`${label}\`, running ${span(now - Number(since))}`;
}

/**
 * One try at slot `index`: start the command under `flock` and, if the slot was free, run it to its end.
 * @param {{ index: number, tools: { flock: string, nice: string, ionice: string }, dir: string, command: string, args: string[], label: string, since: number,
 *   env: Record<string, string | undefined>, cwd?: string, output: "inherit" | "ignore", onStart: () => void }} attempt `onStart` is called once, when the command has started in the slot
 * @returns {Promise<{ held: false } | { held: true, status: number }>}
 */
function tryOnce({ index, tools, dir, command, args, label, since, env, cwd, output, onStart }: {
        index: number; tools: { flock: string; nice: string; ionice: string; }; dir: string; command: string; args: string[]; label: string; since: number;
        env: Record<string, string | undefined>; cwd?: string; output: "inherit" | "ignore"; onStart: () => void;
    }): Promise<{ held: false; } | { held: true; status: number; }> {
  const lockFile = join(dir, `slot-${index}.lock`);
  return new Promise((settle, fail) => {
    let started = false;
    const child = spawn("/bin/sh", ["-c", HOLDER_SCRIPT, "suite-slot",
      lockFile, String(since), label, tools.flock, tools.nice, String(NICE_LEVEL), tools.ionice, String(IONICE_CLASS), command, ...args],
    { cwd, env: { ...env, [SLOT_ENV]: String(index) }, stdio: [output, output, output, "pipe"] });
    child.stdio[3]?.on("data", () => {
      if (!started) onStart();
      started = true;
    });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    for (const signal of SIGNALS) process.on(signal, forward);
    const stopForwarding = () => { for (const signal of SIGNALS) process.off(signal, forward); };
    child.on("error", (cause) => { stopForwarding(); fail(new SuiteSlotRefusal(`suite-slots: could not start /bin/sh: ${cause.message}`)); });
    child.on("close", (code, signal) => {
      stopForwarding();
      if (started) return settle({ held: true, status: exitStatus(code, signal) });
      if (code === CONFLICT_EXIT) return settle({ held: false });
      return fail(new SuiteSlotRefusal(`suite-slots: taking the slot ended with ${signal ?? code} before the command started (lock ${lockFile}), so nothing ran and no slot was taken`));
    });
  });
}

/**
 * Run `command` in one of the host's slots, at `nice -n 15 ionice -c 3`, and resolve with its exit status (128 + n for a signal). The caller's environment reaches the command with
 * `SLOT_ENV` added. On a runner (`CI` set) it just runs the command. When every slot is held it WAITS, and says so at the start and then every `reportMs`.
 *
 * `now` and `sleep` are for a test, which must not wait a minute to see the minute's message.
 *
 * @param {{ command: string, args?: string[], env?: Record<string, string | undefined>, cwd?: string, label?: string, slots?: number, dir?: string,
 *   write?: (text: string) => void, output?: "inherit" | "ignore", now?: () => number, sleep?: (ms: number) => Promise<void>,
 *   pollMs?: number, reportMs?: number }} run
 * @returns {Promise<number>}
 * @throws {SuiteSlotRefusal} when `flock`, `nice` or `ionice` is missing, before anything runs
 */
export async function runUnderSlot({ command, args = [], env = process.env, cwd, label, slots = SLOT_COUNT, dir, write = (text) => process.stderr.write(text),
  output = "inherit", now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), pollMs = WAIT_POLL_MS, reportMs = WAIT_REPORT_MS }: {
        command: string; args?: string[]; env?: Record<string, string | undefined>; cwd?: string; label?: string; slots?: number; dir?: string;
        write?: (text: string) => void; output?: "inherit" | "ignore"; now?: () => number; sleep?: (ms: number) => Promise<void>;
        pollMs?: number; reportMs?: number;
    }): Promise<number> {
  if (onRunner(env)) return await runAsIs({ command, args, env, cwd, output });
  const tools = requiredTools(env);
  const slotDir = dir ?? slotDirectory(env);
  mkdirSync(slotDir, { recursive: true, mode: SLOT_DIR_MODE });
  const named = oneLine(label ?? [command, ...args].join(" "));
  const began = now();
  let reportedAt: number | null = null;
  for (;;) {
    for (let index = 0; index < slots; index += 1) {
      const onStart = () => { if (reportedAt !== null) recordWait({ slotDir, index, waited: now() - began, label: named, cwd, at: now(), write }); };
      const outcome = await tryOnce({ index, tools, dir: slotDir, command, args, label: named, since: now(), env, cwd, output, onStart });
      if (outcome.held) return outcome.status;
    }
    if (reportedAt === null || now() - reportedAt >= reportMs) {
      write(waitingMessage({ slotDir, slots, waited: now() - began, now: now() }));
      reportedAt = now();
    }
    await sleep(pollMs);
  }
}

/**
 * Append the line that says a run waited: ISO time, pid, cwd, milliseconds waited, slot, label. A record that cannot be written is said on `write` and the suite still runs: the limit
 * is the point, and the record is how it is read afterwards.
 * @param {{ slotDir: string, index: number, waited: number, label: string, cwd?: string, at: number, write: (text: string) => void }} wait
 */
function recordWait({ slotDir, index, waited, label, cwd, at, write }: { slotDir: string; index: number; waited: number; label: string; cwd?: string; at: number; write: (text: string) => void; }) {
  const where = (cwd ?? process.cwd()).replace(/\s/g, " ");
  const line = `${[new Date(at).toISOString(), process.pid, where, waited, index, label].join("\t")}\n`;
  try {
    appendFileSync(join(slotDir, WAITS_LOG), line);
  } catch (cause) {
    write(`suite-slots: could not record this wait in ${join(slotDir, WAITS_LOG)}: ${(cause as Error).message}\n`);
  }
}

/** @param {{ slotDir: string, slots: number, waited: number, now: number }} wait @returns {string} what a queued run prints: which slots are held, by what, and how long it has waited */
function waitingMessage({ slotDir, slots, waited, now }: { slotDir: string; slots: number; waited: number; now: number; }): string {
  const held = Array.from({ length: slots }, (_, index) => `  ${describeSlot(slotDir, index, now)}`).join("\n");
  return `suite-slots: all ${slots} slots for a full test suite on this host are held; waiting for one (waited ${span(waited)}). It is not hung.\n${held}\n`;
}

/** @param {{ command: string, args: string[], env: Record<string, string | undefined>, cwd?: string, output: "inherit" | "ignore" }} run @returns {Promise<number>} */
function runAsIs({ command, args, env, cwd, output }: { command: string; args: string[]; env: Record<string, string | undefined>; cwd?: string; output: "inherit" | "ignore"; }): Promise<number> {
  return new Promise((settle, fail) => {
    const child = spawn(command, args, { cwd, env, stdio: output });
    child.on("error", fail);
    child.on("close", (code, signal) => settle(exitStatus(code, signal)));
  });
}

/** @param {Record<string, string | undefined>} env @returns {boolean} whether this process is already running in a slot, so a script that re-runs itself under one does not do it twice */
export const insideSlot = (env: Record<string, string | undefined> = process.env): boolean => env[SLOT_ENV] !== undefined;

/** The root of this repository's checkout: where the full suite's globs are relative to. */
const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The full agent-org suite, as CI's `gate` runs it: every test file, one `node --test`. */
export const SUITE_COMMAND = Object.freeze({ command: process.execPath, args: ["--import", "tsx", "--test", "src/**/*.test.ts", "src/**/*.test.mjs"], cwd: TOOL_ROOT });

const USAGE = "usage: node src/suite-slots.ts suite                     (the full agent-org suite, in a slot)\n"
  + "       node src/suite-slots.ts run [--label=<text>] -- <command> [args...]   (any full run, in a slot)\n";

/** @param {string[]} argv @returns {Promise<number>} the exit code */
export async function main(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  try {
    if (sub === "suite" && rest.length === 0) return await runUnderSlot({ ...SUITE_COMMAND, label: "agent-org suite" });
    const split = rest.indexOf("--");
    if (sub === "run" && split >= 0 && rest[split + 1] !== undefined) {
      const label = rest.slice(0, split).find((flag) => flag.startsWith("--label="))?.slice("--label=".length);
      const unknown = rest.slice(0, split).filter((flag) => !flag.startsWith("--label="));
      if (unknown.length === 0) return await runUnderSlot({ command: rest[split + 1], args: rest.slice(split + 2), label });
    }
  } catch (error) {
    if (!(error instanceof SuiteSlotRefusal)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  process.stderr.write(USAGE);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(await main(process.argv.slice(2)));

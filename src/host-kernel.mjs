// @ts-check
// A NEWER KERNEL THAN THE ONE RUNNING, SAID BY `host:check`, AND THE DRAINED REBOOT THAT LOADS IT (a11ign/a11ign#4046, from #3846).
//
// MEASURED 2026-10-08. The agents host ran `7.0.0-34-generic` for two days with `7.0.0-38-generic` installed in `/boot`, and the
// reboot that loaded it was drained by hand (stop the tick timer, look at every seat, look for a job), done by hand and read back by hand.
// apt will install the next kernel the same way, so the procedure is code here and the note is a line in `host:check`.
//
// EVERY READ AND EVERY ACT IS A DEPENDENCY, so no test reboots anything: `run` is the one way a process is started, and the privileged
// command is a CONSTANT ({@link REBOOT_ARGV}) that {@link runPrivileged} compares by value before it spawns. The sudoers grant
// (`/etc/sudoers.d/a11ign-reboot`) is `/usr/bin/systemctl reboot` and nothing else, and this file must not ask for more.
//
// A READ THAT WAS REFUSED IS `NOT READ`, NEVER "UP TO DATE": a missing `/boot` listing and an equal pair of kernels would otherwise print
// the same nothing. The same holds for the loop guard: a record of the last reboot that cannot be read refuses the reboot.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { readAgents, absentSeats } from "./herdr-agents.mjs";
import { refuseUnknownFlags } from "./lib/cli-flags.mjs";
import { HOME_CHECKOUT } from "./project-config.mjs";
import { persistentRoles } from "./project-roles.mjs";
import { stateEntryPath } from "./host-config.mjs";

/**
 * @typedef {{ unit: string, problem: string, detail: string }} Finding
 * @typedef {{ at: number, from: string, to: string, row?: number, readBackAt?: number }} RebootRecord
 * @typedef {{ read: () => RebootRecord | null, write: (record: RebootRecord | null) => void }} RecordStore
 * @typedef {{ state: "newer" | "current" | "not-read", running?: string, installed?: string, why?: string }} KernelReading
 */

/** The timer that starts a tick. STOPPED, never disabled: a boot starts it again, which is the whole point of stopping it. */
export const TICK_TIMER = "a11ign-work-tick.timer";
const TICK_SERVICE = "a11ign-work-tick.service";
/**
 * THE UNIT THAT RUNS `--reboot` ON A CLOCK (`host/kernel-reboot.service.in`, a11ign/a11ign#4053). A oneshot shows as `activating` while it runs, which is exactly
 * what {@link whatHolds} counts as a host job, so unexcused it would hold ITS OWN reboot for the whole drain bound and defer every scheduled run.
 */
export const REBOOT_SERVICE = "a11ign-kernel-reboot.service";
/** THE ONE PRIVILEGED COMMAND the host grants. A new element here is a new sudoers line, which is `ceo`'s and the chairman's to give. */
export const REBOOT_ARGV = Object.freeze(["sudo", "systemctl", "reboot"]);
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** How long a busy seat or a running job may hold the reboot before it is DEFERRED (the timer is started again and the deferral said). */
export const DRAIN_BOUND_MS = 30 * MINUTE_MS;
export const DRAIN_POLL_MS = 30_000;
/** The values #3846's hand read-back posted. Read, never judged: `hung_task_panic=0` is the chairman's ruling there, not a gap. */
const SYSCTLS = Object.freeze(["softlockup_panic", "panic_on_rcu_stall", "panic_on_oops", "hung_task_panic", "panic"]);

/** @param {string} release `7.0.0-38-generic` @returns {{ nums: number[], flavour: string } | null} null for a name that is not a kernel release */
export function parseRelease(release) {
  const m = /^(\d+)\.(\d+)\.(\d+)-(\d+)-([a-z][\w.+]*)$/.exec(release);
  return m === null ? null : { nums: m.slice(1, 5).map(Number), flavour: m[5] };
}

/** VERSION ORDER, never string order: `7.0.0-100` is newer than `7.0.0-38`. @param {number[]} a @param {number[]} b @returns {number} */
function compareNums(a, b) {
  const at = a.findIndex((n, i) => n !== b[i]);
  return at === -1 ? 0 : a[at] - b[at];
}

/**
 * The newest installed kernel OF THE RUNNING FLAVOUR, from the names in `/boot`. `vmlinuz`, `vmlinuz.old` and anything that is not
 * `vmlinuz-<release>` are not kernels here.
 * @param {string[]} bootEntries @param {string} flavour @returns {string | null}
 */
function newestInstalled(bootEntries, flavour) {
  const releases = bootEntries.filter((n) => n.startsWith("vmlinuz-")).map((n) => n.slice("vmlinuz-".length))
    .map((release) => ({ release, parsed: parseRelease(release) }))
    .filter(({ parsed }) => parsed !== null && parsed.flavour === flavour);
  if (releases.length === 0) return null;
  return releases.reduce((best, next) => (compareNums(next.parsed?.nums ?? [], best.parsed?.nums ?? []) > 0 ? next : best)).release;
}

/** @param {() => string} uname @param {() => string[]} bootEntries @returns {KernelReading} */
export function kernelReading(uname, bootEntries) {
  let running;
  let entries;
  try { running = uname().trim(); } catch (cause) { return { state: "not-read", why: `the running kernel (uname -r) could not be read: ${describe(cause)}` }; }
  try { entries = bootEntries(); } catch (cause) { return { state: "not-read", running, why: `/boot could not be listed: ${describe(cause)}` }; }
  const parsed = parseRelease(running);
  if (parsed === null) return { state: "not-read", running, why: `\`${running}\` is not a kernel release this reader knows how to order` };
  const installed = newestInstalled(entries, parsed.flavour);
  if (installed === null) return { state: "not-read", running, why: `/boot lists no \`vmlinuz-*-${parsed.flavour}\`, so what is installed is unknown rather than equal` };
  const order = compareNums(parseRelease(installed)?.nums ?? [], parsed.nums);
  return { state: order > 0 ? "newer" : "current", running, installed };
}

/** @param {unknown} cause */
function describe(cause) { return cause instanceof Error ? cause.message : String(cause); }

/**
 * THE NOTE `host:check` prints (none when equal or when the running kernel is newer). A refused read is reported, not omitted.
 * @param {{ uname?: () => string, bootEntries?: () => string[] }} [deps] @returns {Finding[]}
 */
export function kernelNotes({ uname = realUname, bootEntries = realBootEntries } = {}) {
  const reading = kernelReading(uname, bootEntries);
  if (reading.state === "current") return [];
  if (reading.state === "not-read") return [{ unit: "kernel", problem: "NOT READ", detail: `${reading.why}. Whether a newer kernel is installed is unknown, not "no".` }];
  return [{ unit: "kernel", problem: `newer kernel installed, not running: ${reading.installed} over ${reading.running}`,
    detail: "apt installed it and the host has not booted it. The drained reboot is `node src/host-kernel.mjs --reboot`: it stops the tick timer, waits for "
      + "no seat mid-turn and no host job, runs `sudo systemctl reboot` (the one granted command) and reads the host back after boot." }];
}

const realUname = () => execFileSync("uname", ["-r"], { encoding: "utf8", timeout: 10_000 });
const realBootEntries = () => readdirSync("/boot");

/**
 * The record of the last reboot this module made, in the host's state directory. A record that exists and cannot be parsed THROWS: the loop
 * guard reading it as absent would reboot a host whose boot loader keeps choosing the old kernel, every time it is asked.
 * @param {string} [path] @returns {RecordStore}
 */
export function recordStore(path = stateEntryPath("kernel-reboot.json")) {
  return {
    read() {
      let text;
      try { text = readFileSync(path, "utf8"); } catch (cause) {
        if (/** @type {NodeJS.ErrnoException} */ (cause).code === "ENOENT") return null;
        throw new Error(`${path} could not be read`, { cause });
      }
      try { return JSON.parse(text); } catch (cause) { throw new Error(`${path} is not JSON`, { cause }); }
    },
    write(record) {
      if (record === null) { rmSync(path, { force: true }); return; }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(record)}\n`);
    },
  };
}

/**
 * THE LOOP GUARD, as a finding: the host was rebooted by this module inside 24 h and a newer kernel is still not running, because either the
 * boot loader chose the old one or a still newer one arrived. A second reboot would repeat the first, so it is raised instead.
 * @param {RebootRecord | null} record @param {KernelReading} reading @param {number} now @returns {Finding | null}
 */
export function stillOlderFinding(record, reading, now) {
  if (record === null || reading.state !== "newer" || now - record.at >= DAY_MS) return null;
  const cause = reading.installed === record.to ? "the boot loader chose the old kernel again" : `a newer kernel (${reading.installed}) arrived since`;
  return { unit: "kernel", problem: "REBOOTED INSIDE 24 H, NEWER KERNEL STILL NOT RUNNING",
    detail: `rebooted at ${new Date(record.at).toISOString()} from ${record.from} to reach ${record.to}; the host runs ${reading.running} and ${reading.installed} `
      + `is installed, so ${cause}. NO second reboot is made inside 24 h: read the boot loader's default (\`grub-editenv list\`, \`/etc/default/grub\`) and decide.` };
}

/**
 * WHAT `host:check` RAISES, as FINDINGS (which wake a session; a note does not): the loop guard, and a reboot nobody has read back. The read-back
 * is owed to the row that asked, and a finding is how the org learns that it is, since nothing else runs after a boot.
 * @param {{ uname?: () => string, bootEntries?: () => string[], store?: () => RecordStore, now?: () => number, bootedAt?: () => number }} [deps]
 * @returns {Finding[]}
 */
export function kernelFindings({ uname = realUname, bootEntries = realBootEntries, store = recordStore, now = Date.now, bootedAt = realBootedAt } = {}) {
  let record;
  try { record = store().read(); } catch (cause) {
    return [{ unit: "kernel", problem: "NOT READ", detail: `the record of the last reboot could not be read (${describe(cause)}), so the 24 h loop guard is blind.` }];
  }
  const older = stillOlderFinding(record, kernelReading(uname, bootEntries), now());
  return [...readBackFindings(record, bootedAt), ...older === null ? [] : [older]];
}

/**
 * THE READ-BACK FINDING. A refused /proc/uptime read is `NOT READ` rather than an exception, since `host:check` must not crash on it, and it is
 * raised only while a record with no read-back exists: with none, there is nothing the boot time could make owed.
 * @param {RebootRecord | null} record @param {() => number} bootedAt @returns {Finding[]}
 */
function readBackFindings(record, bootedAt) {
  if (record === null || record.readBackAt !== undefined) return [];
  let booted;
  try { booted = bootedAt(); } catch (cause) {
    return [{ unit: "kernel", problem: "NOT READ", detail: `the boot time could not be read (${describe(cause)}), so whether the reboot recorded at ${new Date(record.at).toISOString()} has been read back is not known.` }];
  }
  if (!readBackOwed(record, booted)) return [];
  return [{ unit: "kernel", problem: "REBOOT NOT READ BACK",
    detail: `the host rebooted at ${new Date(record.at).toISOString()} (${record.from} to ${record.to}) and nothing has posted the reading yet: \`node src/host-kernel.mjs --read-back\`.` }];
}

/** @returns {number} when this boot happened, in ms */
function realBootedAt() { return Date.now() - Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) * 1000; }

/** @param {string[]} argv @param {(argv: string[]) => string} run THE ONLY WAY A PRIVILEGED PROCESS STARTS. */
export function runPrivileged(argv, run) {
  if (argv.length !== REBOOT_ARGV.length || argv.some((word, i) => word !== REBOOT_ARGV[i])) {
    throw new Error(`refusing to run \`${argv.join(" ")}\` with privilege: the only granted command is \`${REBOOT_ARGV.join(" ")}\``);
  }
  return run(argv);
}

/**
 * WHAT HOLDS A REBOOT: a seat mid-turn (`working`) and a host job (a `a11ign-*.service` still `activating`, which is how a oneshot job shows while it runs).
 * `blocked` and `idle` and `done` are not a turn in progress, and `unknown` is a workspace with no agent in it (wake.mjs). A listing that could not be
 * read HOLDS the reboot: unknown is not idle.
 * @param {{ agents: () => ReturnType<typeof readAgents>, run: (argv: string[]) => string, ignoreSeats?: string[], ignoreUnits?: string[] }} deps
 * @returns {string[]}
 */
export function whatHolds({ agents, run, ignoreSeats = [], ignoreUnits = [] }) {
  const unexcused = (/** @type {string} */ unit) => unit && unit !== REBOOT_SERVICE && !ignoreUnits.includes(unit);
  const seats = agents();
  const held = seats === null ? ["NOT READ: herdr's workspace listing"]
    : seats.filter((a) => a.status === "working" && !ignoreSeats.includes(a.label)).map((a) => `seat ${a.label} is mid-turn`);
  try {
    const listing = run(["systemctl", "--user", "list-units", "a11ign-*.service", "--state=activating", "--no-legend", "--plain"]);
    const jobs = listing.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(unexcused);
    return [...held, ...jobs.map((u) => `host job ${u} is running`)];
  } catch (cause) { return [...held, `NOT READ: the host jobs (${describe(cause)})`]; }
}

/**
 * @typedef {{ run: (argv: string[]) => string, uname: () => string, bootEntries: () => string[], agents: () => ReturnType<typeof readAgents>,
 *   store: RecordStore, now: () => number, sleep: (ms: number) => Promise<void>, ignoreSeats?: string[], ignoreUnits?: string[], row?: number }} RebootDeps
 * @typedef {{ outcome: "not-needed" | "not-read" | "refused-loop" | "timer-not-stopped" | "deferred" | "reboot-failed" | "rebooted", reading?: KernelReading,
 *   finding?: Finding, held?: string[], error?: string, timerRestartError?: string }} RebootResult
 */

/** Poll until nothing holds, or the bound passes. @param {RebootDeps} deps @returns {Promise<string[]>} what still held at the end (empty: drained) */
async function waitUntilDrained(deps) {
  const deadline = deps.now() + DRAIN_BOUND_MS;
  let held = whatHolds(deps);
  while (held.length > 0 && deps.now() < deadline) {
    await deps.sleep(DRAIN_POLL_MS);
    held = whatHolds(deps);
  }
  return held;
}

/** @param {RebootDeps} deps @returns {string | undefined} why the timer is not running again, or nothing */
function restartTimer({ run }) {
  try { run(["systemctl", "--user", "start", TICK_TIMER]); return undefined; } catch (cause) { return describe(cause); }
}

/** @param {RebootDeps} deps @returns {{ record: RebootRecord | null } | { unread: string }} */
function lastReboot({ store }) {
  try { return { record: store.read() }; } catch (cause) { return { unread: describe(cause) }; }
}

/**
 * THE DRAINED REBOOT, in the order #3846 ran by hand: stop the tick timer, wait for idle seats and no host job, `sudo systemctl reboot`.
 * The timer is started again on every road that does not end in a reboot. It is never forced: a seat still busy at {@link DRAIN_BOUND_MS} defers.
 * The record is written BEFORE the reboot (the process does not outlive it) and put back if the command fails.
 * @param {RebootDeps} deps @returns {Promise<RebootResult>}
 */
export async function drainedReboot(deps) {
  const reading = kernelReading(deps.uname, deps.bootEntries);
  if (reading.state === "not-read") return { outcome: "not-read", reading };
  if (reading.state === "current") return { outcome: "not-needed", reading };
  const last = lastReboot(deps);
  if ("unread" in last) return { outcome: "not-read", reading, error: `the record of the last reboot: ${last.unread}` };
  const finding = stillOlderFinding(last.record, reading, deps.now());
  if (finding !== null) return { outcome: "refused-loop", reading, finding };
  try { deps.run(["systemctl", "--user", "stop", TICK_TIMER]); } catch (cause) { return { outcome: "timer-not-stopped", reading, error: describe(cause) }; }
  const held = await waitUntilDrained(deps);
  if (held.length > 0) return { outcome: "deferred", reading, held, timerRestartError: restartTimer(deps) };
  deps.store.write({ at: deps.now(), from: String(reading.running), to: String(reading.installed), ...deps.row === undefined ? {} : { row: deps.row } });
  try { runPrivileged([...REBOOT_ARGV], deps.run); } catch (cause) {
    deps.store.write(last.record);
    return { outcome: "reboot-failed", reading, error: describe(cause), timerRestartError: restartTimer(deps) };
  }
  return { outcome: "rebooted", reading };
}

/** @param {RebootResult} result @returns {string} what the caller says aloud, including a deferral */
export function rebootReport(result) {
  const r = result.reading;
  const restart = result.timerRestartError === undefined ? "" : ` !! THE TICK TIMER IS NOT RUNNING: \`systemctl --user start ${TICK_TIMER}\` (${result.timerRestartError}).`;
  switch (result.outcome) {
    case "not-needed": return `kernel: ${r?.running} is the newest installed; no reboot.`;
    case "not-read": return `kernel: NOT READ -- ${r?.why ?? result.error}; no reboot.`;
    case "refused-loop": return `kernel: reboot REFUSED. ${result.finding?.detail}`;
    case "timer-not-stopped": return `kernel: no reboot; the tick timer could not be stopped (${result.error}), so nothing was drained.`;
    case "deferred": return `kernel: reboot DEFERRED, the timer is started again. Held by: ${result.held?.join("; ")}.${restart}`;
    case "reboot-failed": return `kernel: \`${REBOOT_ARGV.join(" ")}\` failed (${result.error}); the record is put back.${restart}`;
    default: return `kernel: rebooting from ${r?.running} to ${r?.installed}; the tick timer stays stopped until boot starts it.`;
  }
}

/**
 * IS THE READ-BACK OWED: a record exists, none has been posted, and the host booted after it was written (`bootedAt` from /proc/uptime).
 * @param {RebootRecord | null} record @param {number} bootedAt @returns {boolean}
 */
export function readBackOwed(record, bootedAt) {
  return record !== null && record.readBackAt === undefined && bootedAt >= record.at;
}

/**
 * @typedef {{ run: (argv: string[]) => string, uname: () => string, agents: () => ReturnType<typeof readAgents>, seats: () => string[], proc: (name: string) => string,
 *   tracePages: () => Promise<string> }} ReadBackDeps
 */

/** One line per thing #3846 read by hand, each `NOT READ` rather than missing when its read was refused. @param {ReadBackDeps} deps @returns {Promise<string[]>} */
export async function readBack(deps) {
  const attempt = (/** @type {string} */ label, /** @type {() => string} */ read) => {
    try { return `- ${label}: ${read()}`; } catch (cause) { return `- ${label}: NOT READ (${describe(cause)})`; }
  };
  const tick = () => {
    const fired = Number(deps.run(["systemctl", "--user", "show", TICK_SERVICE, "-p", "ExecMainStartTimestampMonotonic", "--value"]).trim()) > 0;
    return `${fired ? "fired since boot" : "has NOT fired since boot"}; timer ${deps.run(["systemctl", "--user", "is-active", TICK_TIMER]).trim()}`;
  };
  const seats = () => {
    const listing = deps.agents();
    if (listing === null) throw new Error("herdr's workspace listing could not be read");
    const absent = absentSeats(deps.seats(), listing);
    return absent.length === 0 ? "every persistent seat is listed" : `ABSENT: ${absent.join(", ")}`;
  };
  const trace = await deps.tracePages().then((s) => `- trace pages: ${s}`, (cause) => `- trace pages: NOT READ (${describe(cause)})`);
  return [attempt("uname -r", () => deps.uname().trim()),
    ...SYSCTLS.map((name) => attempt(`kernel.${name}`, () => deps.proc(name).trim())),
    attempt("work tick", tick), attempt("standing seats", seats), trace];
}

/** The trace pages as the tailnet sees them: the first `Web` handler `tailscale serve` publishes, fetched. @returns {Promise<string>} */
async function realTracePages() {
  const served = JSON.parse(execFileSync("tailscale", ["serve", "status", "--json"], { encoding: "utf8", timeout: 15_000 }));
  const host = Object.keys(served.Web ?? {})[0];
  if (host === undefined) throw new Error("tailscale serve publishes no web handler");
  const response = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(15_000) });
  return `https://${host}/ answered ${response.status}, ${(await response.text()).length} characters`;
}

/** @param {string[]} argv @returns {string} */
function realRun(argv) {
  const [command, ...args] = argv;
  return execFileSync(command, args, { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
}

/** @param {number} row @param {string} body */
function postToRow(row, body) {
  execFileSync("gh", ["issue", "comment", String(row), "--body-file", "-"], { input: body, cwd: HOME_CHECKOUT, encoding: "utf8", timeout: 60_000 });
}

/** @param {string[]} flags @param {string} name @returns {string | undefined} */
function valueOf(flags, name) {
  const at = flags.indexOf(name);
  return at === -1 ? undefined : flags[at + 1];
}

async function main() {
  refuseUnknownFlags(["--reboot", "--read-back", "--row", "--self"], { entry: import.meta.url, command: "node src/host-kernel.mjs" });
  const flags = process.argv.slice(2);
  const row = valueOf(flags, "--row");
  const self = valueOf(flags, "--self");
  if (flags.includes("--read-back")) return readBackMain();
  if (!flags.includes("--reboot")) {
    const notes = kernelNotes();
    process.stdout.write(notes.length === 0 ? "kernel: the running kernel is the newest installed.\n" : notes.map((n) => `kernel: ${n.problem}\n`).join(""));
    return undefined;
  }
  const result = await drainedReboot({ run: realRun, uname: realUname, bootEntries: realBootEntries, agents: () => readAgents(), store: recordStore(),
    now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), ignoreSeats: self === undefined ? [] : [self],
    ...row === undefined ? {} : { row: Number(row) } });
  process.stdout.write(`${rebootReport(result)}\n`);
  if (!["not-needed", "deferred", "rebooted"].includes(result.outcome)) process.exitCode = 1;
  return undefined;
}

/** After boot: read the host back, and post it on the row that asked (the record carries it). */
async function readBackMain() {
  const store = recordStore();
  const record = store.read();
  if (record === null || !readBackOwed(record, realBootedAt())) { process.stdout.write("kernel: no read-back is owed.\n"); return; }
  const lines = await readBack({ run: realRun, uname: realUname, agents: () => readAgents(), seats: () => persistentRoles(),
    proc: (name) => readFileSync(`/proc/sys/kernel/${name}`, "utf8"), tracePages: realTracePages });
  const body = `Kernel reboot read back (${record.from} -> ${record.to}), a reading at a moment:\n${lines.join("\n")}\n`;
  process.stdout.write(body);
  if (record.row !== undefined) postToRow(record.row, body);
  store.write({ ...record, readBackAt: Date.now() });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();

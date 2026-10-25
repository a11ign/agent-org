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
//
// THIS MODULE OWNS THE TEXT OF `/etc/sysctl.d/90-a11ign-hang.conf` ({@link HANG_CONF}, A11-279). WHY THE FILE EXISTS (a11ign/a11ign#3846): on 2026-10-06 the host hung for
// 2 h 15 min in a soft lockup with nothing noticing, while `/tmp` held about 121,000 test folders. The chairman wrote the file by hand on 2026-10-08 so that a stall
// reboots the host rather than hangs it (`panic = 10`); `hung_task_panic = 0` is his ruling there. WHY `softlockup_panic` IS NOW 0 (A11-279): on 2026-10-25 a 26 s soft
// lockup (`ioq-2`, a thread of Claude Code, in `ext4_dx_readdir` on a `/tmp` of 19,600 entries) would have cleared by itself; the panic turned it into a reboot 10 s later that
// killed every run. A soft lockup is now logged and the board's alert raises it. Oops and RCU stalls still panic: the kernel cannot be trusted after either.
// The module only HOLDS and COMPARES the text. The run has no root and the one granted command is the reboot, so the chairman applies it ({@link HANG_APPLY}) and
// {@link hangConfFindings} says, on every `host:check`, when the file or a live value differs. Nothing here writes under `/etc`, so no check can put `1` back.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readAgents, absentSeats } from "./herdr-agents.ts";
import { refuseUnknownFlags } from "./lib/cli-flags.ts";
import { HOME_CHECKOUT } from "./project-config.ts";
import { persistentRoles } from "./project-roles.ts";
import { stateEntryPath } from "./host-config.ts";
import { hostExposure } from "./plugins/host-exposure.ts";
import { rows } from "./plugins/rows.ts";

/** `manualFix`: `host:install` writes no line of it (the chairman runs a root command), so the host-drift gate must not wake a session every tick to run `host:install` (#3703). */
export type Finding = { unit: string, problem: string, detail: string, manualFix?: boolean };
export type RebootRecord = { at: number, from: string, to: string, row?: number, readBackAt?: number };
export type RecordStore = { read: () => RebootRecord | null, write: (record: RebootRecord | null) => void };
export type KernelReading = { state: "newer" | "current" | "not-read", running?: string, installed?: string, why?: string };

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

export const HANG_CONF_PATH = "/etc/sysctl.d/90-a11ign-hang.conf";
/** The four settings the file holds, each with the reason it has that value. `hung_task_panic` is absent on purpose: it stays the kernel's own 0 (#3846, the chairman's ruling). */
export const HANG_SETTINGS = Object.freeze([
  { key: "softlockup_panic", value: "0", reason: "A11-279: a soft lockup is logged, and the board's alert raises it. A 26 s stall that would have cleared became a reboot that killed every run." },
  { key: "panic_on_rcu_stall", value: "1", reason: "an RCU stall means the kernel cannot reclaim memory, and nothing recovers from it: reboot (#3846)." },
  { key: "panic_on_oops", value: "1", reason: "after an oops the kernel's state is not to be trusted: reboot (#3846)." },
  { key: "panic", value: "10", reason: "reboot 10 s after a panic, so a host never hangs on one (#3846: 2 h 15 min unnoticed on 2026-10-06)." },
]);
/** THE FILE'S EXACT TEXT, printed by `--hang-conf`. */
export const HANG_CONF = [
  "# Written by `node src/host-kernel.ts --hang-conf`: agent-org's src/host-kernel.ts owns this text. Change it there, never here.",
  "# Why this file exists: a11ign/a11ign#3846. On 2026-10-06 the host hung for 2 h 15 min in a soft lockup and nothing noticed. A panic and a reboot beats a hang.",
  "# Why softlockup_panic is 0: A11-279. On 2026-10-25 a 26 s soft lockup in ext4_dx_readdir would have cleared by itself; the panic rebooted the host and killed every run.",
  ...HANG_SETTINGS.flatMap(({ key, value, reason }) => [`# ${reason}`, `kernel.${key} = ${value}`]),
  "",
].join("\n");
/** What the chairman runs, as root, to apply {@link HANG_CONF}. This module never does. */
export const HANG_APPLY = `node src/host-kernel.ts --hang-conf | sudo tee ${HANG_CONF_PATH} && sudo sysctl --system`;
const KDUMP_LOADED_PATH = "/sys/kernel/kexec_crash_loaded";
const KDUMP_APPLY = "sudo sed -i 's/^USE_KDUMP=0/USE_KDUMP=1/' /etc/default/kdump-tools && sudo systemctl restart kdump-tools";
export const PSTORE_ROOT = "/var/lib/systemd/pstore";
const PSTORE_APPLY = `sudo setfacl -R -m g:adm:rX -m d:g:adm:rX ${PSTORE_ROOT} /var/crash`;

/** @param {string} release `7.0.0-38-generic` @returns {{ nums: number[], flavour: string } | null} null for a name that is not a kernel release */
export function parseRelease(release: string): { nums: number[]; flavour: string; } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)-(\d+)-([a-z][\w.+]*)$/.exec(release);
  return m === null ? null : { nums: m.slice(1, 5).map(Number), flavour: m[5] };
}

/** VERSION ORDER, never string order: `7.0.0-100` is newer than `7.0.0-38`. @param {number[]} a @param {number[]} b @returns {number} */
function compareNums(a: number[], b: number[]): number {
  const at = a.findIndex((n, i) => n !== b[i]);
  return at === -1 ? 0 : a[at] - b[at];
}

/**
 * The newest installed kernel OF THE RUNNING FLAVOUR, from the names in `/boot`. `vmlinuz`, `vmlinuz.old` and anything that is not
 * `vmlinuz-<release>` are not kernels here.
 * @param {string[]} bootEntries @param {string} flavour @returns {string | null}
 */
function newestInstalled(bootEntries: string[], flavour: string): string | null {
  const releases = bootEntries.filter((n) => n.startsWith("vmlinuz-")).map((n) => n.slice("vmlinuz-".length))
    .map((release) => ({ release, parsed: parseRelease(release) }))
    .filter(({ parsed }) => parsed !== null && parsed.flavour === flavour);
  if (releases.length === 0) return null;
  return releases.reduce((best, next) => (compareNums(next.parsed?.nums ?? [], best.parsed?.nums ?? []) > 0 ? next : best)).release;
}

/** @param {() => string} uname @param {() => string[]} bootEntries @returns {KernelReading} */
export function kernelReading(uname: () => string, bootEntries: () => string[]): KernelReading {
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
function describe(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }

/**
 * THE NOTE `host:check` prints (none when equal or when the running kernel is newer). A refused read is reported, not omitted.
 * @param {{ uname?: () => string, bootEntries?: () => string[] }} [deps] @returns {Finding[]}
 */
export function kernelNotes({ uname = realUname, bootEntries = realBootEntries }: { uname?: () => string; bootEntries?: () => string[]; } = {}): Finding[] {
  const reading = kernelReading(uname, bootEntries);
  if (reading.state === "current") return [];
  if (reading.state === "not-read") return [{ unit: "kernel", problem: "NOT READ", detail: `${reading.why}. Whether a newer kernel is installed is unknown, not "no".` }];
  return [{ unit: "kernel", problem: `newer kernel installed, not running: ${reading.installed} over ${reading.running}`,
    detail: "apt installed it and the host has not booted it. The drained reboot is `node src/host-kernel.ts --reboot`: it stops the tick timer, waits for "
      + "no seat mid-turn and no host job, runs `sudo systemctl reboot` (the one granted command) and reads the host back after boot." }];
}

const realUname = () => execFileSync("uname", ["-r"], { encoding: "utf8", timeout: 10_000 });
const realBootEntries = () => readdirSync("/boot");

/**
 * The record of the last reboot this module made, in the host's state directory. A record that exists and cannot be parsed THROWS: the loop
 * guard reading it as absent would reboot a host whose boot loader keeps choosing the old kernel, every time it is asked.
 * @param {string} [path] @returns {RecordStore}
 */
export function recordStore(path: string = stateEntryPath("kernel-reboot.json")): RecordStore {
  return {
    read() {
      let text;
      try { text = readFileSync(path, "utf8"); } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
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
export function stillOlderFinding(record: RebootRecord | null, reading: KernelReading, now: number): Finding | null {
  if (record === null || reading.state !== "newer" || now - record.at >= DAY_MS) return null;
  const cause = reading.installed === record.to ? "the boot loader chose the old kernel again" : `a newer kernel (${reading.installed}) arrived since`;
  return { unit: "kernel", problem: "REBOOTED INSIDE 24 H, NEWER KERNEL STILL NOT RUNNING",
    detail: `rebooted at ${new Date(record.at).toISOString()} from ${record.from} to reach ${record.to}; the host runs ${reading.running} and ${reading.installed} `
      + `is installed, so ${cause}. NO second reboot is made inside 24 h: read the boot loader's default (\`grub-editenv list\`, \`/etc/default/grub\`) and decide.` };
}

/** Every read the crash-preparedness findings make, injected. `listDir` names a directory's entries and `readFile` returns a file's text; both throw what the file system throws. */
export type HostReads = { readFile: (path: string) => string, listDir: (path: string) => string[] };
const realHostReads: HostReads = { readFile: (path) => readFileSync(path, "utf8"), listDir: (path) => readdirSync(path) };

/** @param {unknown} cause @returns {string | undefined} */
const codeOf = (cause: unknown) => (cause as NodeJS.ErrnoException | null)?.code;
/** @param {unknown} cause @returns {string | undefined} the path the file system refused, when it says */
const pathOf = (cause: unknown) => (cause as NodeJS.ErrnoException | null)?.path;

/**
 * A FINDING THAT STAYS until the chairman runs a root command. Its unit names its source, so a `NOT READ` of one is not the key of another's, and `manualFix` keeps the host-drift
 * gate from waking a session every tick to run `host:install`, which cannot clear it. `host:check` still prints it.
 */
const standing = (source: string, problem: string, detail: string): Finding => ({ unit: `kernel ${source}`, problem, detail, manualFix: true });

/** The `kernel.<key> = <value>` lines of a sysctl file, comments and blanks dropped. @param {string} text @returns {Map<string, string>} */
function sysctlLines(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^\s*kernel\.(\S+)\s*=\s*(\S+)\s*$/.exec(line);
    if (m !== null) found.set(m[1], m[2]);
  }
  return found;
}

/** @param {HostReads} reads @returns {string[]} what differs from {@link HANG_SETTINGS}, one phrase each; a refused read is phrased `NOT READ: ...`, an absent file is a difference */
function hangDifferences({ readFile }: HostReads): string[] {
  const differs: string[] = [];
  let file: Map<string, string> | undefined;
  try { file = sysctlLines(readFile(HANG_CONF_PATH)); } catch (cause) {
    differs.push(codeOf(cause) === "ENOENT" ? `${HANG_CONF_PATH} does not exist` : `NOT READ: ${HANG_CONF_PATH} (${describe(cause)})`);
  }
  if (file !== undefined) {
    for (const { key, value } of HANG_SETTINGS) if (file.get(key) !== value) differs.push(`the file has kernel.${key} = ${file.get(key) ?? "(absent)"}, wanted ${value}`);
    for (const key of file.keys()) if (!HANG_SETTINGS.some((s) => s.key === key)) differs.push(`the file sets kernel.${key}, which it should not hold`);
  }
  for (const { key, value } of HANG_SETTINGS) {
    try {
      const live = readFile(`/proc/sys/kernel/${key}`).trim();
      if (live !== value) differs.push(`kernel.${key} is ${live} now, wanted ${value}`);
    } catch (cause) { differs.push(`NOT READ: /proc/sys/kernel/${key} (${describe(cause)})`); }
  }
  return differs;
}

/**
 * THE HANG SETTINGS AGAINST {@link HANG_CONF}: the file's values and the live ones. Both are compared because the file is read only at boot, and a value set by hand
 * (`sysctl -w`) is gone at the next one. Comments and spacing are not compared. A refused read is `NOT READ`; a difference carries the command either way.
 * @param {HostReads} reads @returns {Finding[]}
 */
export function hangConfFindings(reads: HostReads): Finding[] {
  const differs = hangDifferences(reads);
  if (differs.length === 0) return [];
  const apply = `As root, from the agent-org checkout: \`${HANG_APPLY}\`.`;
  if (differs.every((d) => d.startsWith("NOT READ"))) return [standing("hang settings", "NOT READ", `${differs.join("; ")}, so whether the hang settings are as wanted is unknown, not "yes". ${apply}`)];
  return [standing("hang settings", "HANG SETTINGS DIFFER", `${differs.join("; ")}. A soft lockup is meant to be logged, not rebooted (A11-279). ${apply}`)];
}

/** KDUMP LOADED: `/sys/kernel/kexec_crash_loaded` reads 1 once `kdump-tools` has loaded the capture kernel. Without it the next crash leaves the pstore excerpt and no dump. @param {HostReads} reads @returns {Finding[]} */
export function kdumpFindings({ readFile }: HostReads): Finding[] {
  let loaded;
  try { loaded = readFile(KDUMP_LOADED_PATH).trim(); } catch (cause) {
    return [standing("kdump", "NOT READ", `${KDUMP_LOADED_PATH} could not be read (${describe(cause)}), so whether kdump is loaded is unknown, not "yes".`)];
  }
  if (loaded === "1") return [];
  return [standing("kdump", "KDUMP NOT LOADED",
    `${KDUMP_LOADED_PATH} reads ${loaded}: the next crash leaves the pstore excerpt and no full dump. As root: \`${KDUMP_APPLY}\`; then \`cat ${KDUMP_LOADED_PATH}\` reads 1.`)];
}

/**
 * The files of the newest numbered folder that holds any, under the pstore archive (`<boot stamp>/<nnn>/<file>`), newest first by number and not by spelling. systemd-pstore writes the
 * directories world-readable and the FILES 0600 root, so listing the archive proves nothing: the files are what get opened. An entry that is not a folder is passed over.
 * @param {HostReads} reads @param {string} [root] @returns {string[]}
 */
export function newestPstoreRecords({ listDir }: HostReads, root: string = PSTORE_ROOT): string[] {
  const newestFirst = (names: string[]) => [...names].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const walk = (dir: string, depth: number): string[] => {
    const names = newestFirst(listDir(dir));
    if (depth === 0) return names.map((name) => join(dir, name));
    for (const name of names) {
      let found: string[];
      try { found = walk(join(dir, name), depth - 1); } catch (cause) { if (codeOf(cause) === "ENOTDIR") continue; throw cause; }
      if (found.length > 0) return found;
    }
    return [];
  };
  return walk(root, 2);
}

/**
 * CRASH RECORDS THIS USER CAN READ. A refusal on the archive or on any file of its newest record is the finding (the diagnosis of 2026-10-25 needed root for it); an archive that is
 * not there holds no record, so it is not one. Any other failure is `NOT READ`. The finding names the path the file system refused.
 * @param {HostReads} reads @returns {Finding[]}
 */
export function crashRecordsFindings(reads: HostReads): Finding[] {
  let at = PSTORE_ROOT;
  try {
    for (const record of newestPstoreRecords(reads)) { at = record; reads.readFile(record); }
  } catch (cause) {
    at = pathOf(cause) ?? at;
    if (codeOf(cause) === "ENOENT" && at === PSTORE_ROOT) return [];
    if (codeOf(cause) !== "EACCES" && codeOf(cause) !== "EPERM") return [standing("crash records", "NOT READ", `the crash records under ${PSTORE_ROOT} could not be checked (${describe(cause)}).`)];
    return [standing("crash records", "CRASH RECORDS NOT READABLE", `${at} is refused to this user, so the next crash needs root to diagnose. As root: \`${PSTORE_APPLY}\`.`)];
  }
  return [];
}

/**
 * WHAT `host:check` RAISES, as FINDINGS (which wake a session; a note does not): the loop guard, a reboot nobody has read back, and the crash preparedness
 * (the hang settings, kdump, the crash records). The read-back is owed to the row that asked, and a finding is how the org learns that it is, since nothing else runs after a boot.
 * `crashSettings: false` leaves the preparedness out, for a host that is not an agent host (no user systemd): a laptop has no such file and is not drifted.
 * @param {{ uname?: () => string, bootEntries?: () => string[], store?: () => RecordStore, now?: () => number, bootedAt?: () => number, reads?: HostReads, crashSettings?: boolean }} [deps]
 * @returns {Finding[]}
 */
export function kernelFindings({ uname = realUname, bootEntries = realBootEntries, store = recordStore, now = Date.now, bootedAt = realBootedAt, reads = realHostReads, crashSettings = true }: { uname?: () => string; bootEntries?: () => string[]; store?: () => RecordStore; now?: () => number; bootedAt?: () => number; reads?: HostReads; crashSettings?: boolean; } = {}): Finding[] {
  const preparedness = crashSettings ? [...hangConfFindings(reads), ...kdumpFindings(reads), ...crashRecordsFindings(reads)] : [];
  let record;
  try { record = store().read(); } catch (cause) {
    return [{ unit: "kernel", problem: "NOT READ", detail: `the record of the last reboot could not be read (${describe(cause)}), so the 24 h loop guard is blind.` }, ...preparedness];
  }
  const older = stillOlderFinding(record, kernelReading(uname, bootEntries), now());
  return [...readBackFindings(record, bootedAt), ...older === null ? [] : [older], ...preparedness];
}

/**
 * THE READ-BACK FINDING. A refused /proc/uptime read is `NOT READ` rather than an exception, since `host:check` must not crash on it, and it is
 * raised only while a record with no read-back exists: with none, there is nothing the boot time could make owed.
 * @param {RebootRecord | null} record @param {() => number} bootedAt @returns {Finding[]}
 */
function readBackFindings(record: RebootRecord | null, bootedAt: () => number): Finding[] {
  if (record === null || record.readBackAt !== undefined) return [];
  let booted;
  try { booted = bootedAt(); } catch (cause) {
    return [{ unit: "kernel", problem: "NOT READ", detail: `the boot time could not be read (${describe(cause)}), so whether the reboot recorded at ${new Date(record.at).toISOString()} has been read back is not known.` }];
  }
  if (!readBackOwed(record, booted)) return [];
  return [{ unit: "kernel", problem: "REBOOT NOT READ BACK",
    detail: `the host rebooted at ${new Date(record.at).toISOString()} (${record.from} to ${record.to}) and nothing has posted the reading yet: \`node src/host-kernel.ts --read-back\`.` }];
}

/** @returns {number} when this boot happened, in ms */
function realBootedAt(): number { return Date.now() - Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) * 1000; }

/** @param {string[]} argv @param {(argv: string[]) => string} run THE ONLY WAY A PRIVILEGED PROCESS STARTS. */
export function runPrivileged(argv: string[], run: (argv: string[]) => string) {
  if (argv.length !== REBOOT_ARGV.length || argv.some((word, i) => word !== REBOOT_ARGV[i])) {
    throw new Error(`refusing to run \`${argv.join(" ")}\` with privilege: the only granted command is \`${REBOOT_ARGV.join(" ")}\``);
  }
  return run(argv);
}

/**
 * WHAT HOLDS A REBOOT: a seat mid-turn (`working`) and a host job (a `a11ign-*.service` still `activating`, which is how a oneshot job shows while it runs).
 * `blocked` and `idle` and `done` are not a turn in progress, and `unknown` is a workspace with no agent in it (wake.ts). A listing that could not be
 * read HOLDS the reboot: unknown is not idle.
 * @param {{ agents: () => ReturnType<typeof readAgents>, run: (argv: string[]) => string, ignoreSeats?: string[], ignoreUnits?: string[] }} deps
 * @returns {string[]}
 */
export function whatHolds({ agents, run, ignoreSeats = [], ignoreUnits = [] }: { agents: () => ReturnType<typeof readAgents>; run: (argv: string[]) => string; ignoreSeats?: string[]; ignoreUnits?: string[]; }): string[] {
  const unexcused = (unit: string) => unit && unit !== REBOOT_SERVICE && !ignoreUnits.includes(unit);
  const seats = agents();
  const held = seats === null ? ["NOT READ: herdr's workspace listing"]
    : seats.filter((a) => a.status === "working" && !ignoreSeats.includes(a.label)).map((a) => `seat ${a.label} is mid-turn`);
  try {
    const listing = run(["systemctl", "--user", "list-units", "a11ign-*.service", "--state=activating", "--no-legend", "--plain"]);
    const jobs = listing.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(unexcused);
    return [...held, ...jobs.map((u) => `host job ${u} is running`)];
  } catch (cause) { return [...held, `NOT READ: the host jobs (${describe(cause)})`]; }
}

export type RebootDeps = { run: (argv: string[]) => string, uname: () => string, bootEntries: () => string[], agents: () => ReturnType<typeof readAgents>, store: RecordStore, now: () => number, sleep: (ms: number) => Promise<void>, ignoreSeats?: string[], ignoreUnits?: string[], row?: number };
export type RebootResult = { outcome: "not-needed" | "not-read" | "refused-loop" | "timer-not-stopped" | "deferred" | "reboot-failed" | "rebooted", reading?: KernelReading, finding?: Finding, held?: string[], error?: string, timerRestartError?: string };

/** Poll until nothing holds, or the bound passes. @param {RebootDeps} deps @returns {Promise<string[]>} what still held at the end (empty: drained) */
async function waitUntilDrained(deps: RebootDeps): Promise<string[]> {
  const deadline = deps.now() + DRAIN_BOUND_MS;
  let held = whatHolds(deps);
  while (held.length > 0 && deps.now() < deadline) {
    await deps.sleep(DRAIN_POLL_MS);
    held = whatHolds(deps);
  }
  return held;
}

/** @param {RebootDeps} deps @returns {string | undefined} why the timer is not running again, or nothing */
function restartTimer({ run }: RebootDeps): string | undefined {
  try { run(["systemctl", "--user", "start", TICK_TIMER]); return undefined; } catch (cause) { return describe(cause); }
}

/** @param {RebootDeps} deps @returns {{ record: RebootRecord | null } | { unread: string }} */
function lastReboot({ store }: RebootDeps): { record: RebootRecord | null; } | { unread: string; } {
  try { return { record: store.read() }; } catch (cause) { return { unread: describe(cause) }; }
}

/**
 * THE DRAINED REBOOT, in the order #3846 ran by hand: stop the tick timer, wait for idle seats and no host job, `sudo systemctl reboot`.
 * The timer is started again on every road that does not end in a reboot. It is never forced: a seat still busy at {@link DRAIN_BOUND_MS} defers.
 * The record is written BEFORE the reboot (the process does not outlive it) and put back if the command fails.
 * @param {RebootDeps} deps @returns {Promise<RebootResult>}
 */
export async function drainedReboot(deps: RebootDeps): Promise<RebootResult> {
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
export function rebootReport(result: RebootResult): string {
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
export function readBackOwed(record: RebootRecord | null, bootedAt: number): boolean {
  return record !== null && record.readBackAt === undefined && bootedAt >= record.at;
}

export type ReadBackDeps = { run: (argv: string[]) => string, uname: () => string, agents: () => ReturnType<typeof readAgents>, seats: () => string[], proc: (name: string) => string, tracePages: () => Promise<string> };

/** One line per thing #3846 read by hand, each `NOT READ` rather than missing when its read was refused. @param {ReadBackDeps} deps @returns {Promise<string[]>} */
export async function readBack(deps: ReadBackDeps): Promise<string[]> {
  const attempt = (label: string, read: () => string) => {
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

/** The trace pages as the exposure serves them: the first web address it publishes, fetched (A11-162: asked of the exposure plugin, which runs the program). @returns {Promise<string>} */
async function realTracePages(): Promise<string> {
  const [host] = (await hostExposure()).served();
  if (host === undefined) throw new Error("the exposure publishes no web address");
  const response = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(15_000) });
  return `https://${host}/ answered ${response.status}, ${(await response.text()).length} characters`;
}

/** @param {string[]} argv @returns {string} */
function realRun(argv: string[]): string {
  const [command, ...args] = argv;
  return execFileSync(command, args, { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
}

/** The read-back goes on the row that asked, the body on standard input and the program run in the project's checkout, which is what aims it at the project's repository (A11-160, step 9: the code host starts it). @param {number} row @param {string} body */
function postToRow(row: number, body: string) {
  rows().commentOnCheckoutRowByInput({ number: row, body, cwd: HOME_CHECKOUT, timeoutMs: 60_000 });
}

/** @param {string[]} flags @param {string} name @returns {string | undefined} */
function valueOf(flags: string[], name: string): string | undefined {
  const at = flags.indexOf(name);
  return at === -1 ? undefined : flags[at + 1];
}

async function main() {
  refuseUnknownFlags(["--reboot", "--read-back", "--hang-conf", "--row", "--self"], { entry: import.meta.url, command: "node src/host-kernel.ts" });
  const flags = process.argv.slice(2);
  const row = valueOf(flags, "--row");
  const self = valueOf(flags, "--self");
  if (flags.includes("--hang-conf")) {
    if (flags.some((f) => f !== "--hang-conf")) { process.stderr.write("node src/host-kernel.ts: --hang-conf only prints the file text; run it alone.\n"); process.exitCode = 1; return undefined; }
    process.stdout.write(HANG_CONF);
    return undefined;
  }
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

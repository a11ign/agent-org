// @ts-check
// module: the hang settings -- the text of `/etc/sysctl.d/90-a11ign-hang.conf`, and the findings when the file or the live values differ from it (A11-279)
//
// MOVED OUT OF `host-kernel.ts` SO THE INSTANCE CAN READ IT. The board's alert for drifting hang settings (`ticket-mode/host-alerts.ts`) asks {@link hangConfFindings}; `host-kernel.ts` imports `project-config.ts`, which refuses at
// import time when no project is declared, and an instance must not load it to say a sysctl differs. `host-kernel.ts` re-exports everything here, and its header says why the file exists and why `softlockup_panic` is 0.
import { readFileSync, readdirSync } from "node:fs";

/** `manualFix`: `host:install` writes no line of it (the chairman runs a root command), so the host-drift gate must not wake a session every tick to run `host:install` (#3703). */
export type Finding = { unit: string, problem: string, detail: string, manualFix?: boolean };

/** @param {unknown} cause */
export function describe(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }

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
  "# Written by `node src/host-kernel.ts --hang-conf`: agent-org's src/hang-settings.ts owns this text. Change it there, never here.",
  "# Why this file exists: the product repository's issue #3846. On 2026-10-06 the host hung for 2 h 15 min in a soft lockup and nothing noticed. A panic and a reboot beats a hang.",
  "# Why softlockup_panic is 0: A11-279. On 2026-10-25 a 26 s soft lockup in ext4_dx_readdir would have cleared by itself; the panic rebooted the host and killed every run.",
  ...HANG_SETTINGS.flatMap(({ key, value, reason }) => [`# ${reason}`, `kernel.${key} = ${value}`]),
  "",
].join("\n");
/** What the chairman runs, as root, to apply {@link HANG_CONF}. This module never does. */
export const HANG_APPLY = `node src/host-kernel.ts --hang-conf | sudo tee ${HANG_CONF_PATH} && sudo sysctl --system`;

/** Every read the crash-preparedness findings make, injected. `listDir` names a directory's entries and `readFile` returns a file's text; both throw what the file system throws. */
export type HostReads = { readFile: (path: string) => string, listDir: (path: string) => string[] };
export const realHostReads: HostReads = { readFile: (path) => readFileSync(path, "utf8"), listDir: (path) => readdirSync(path) };

/** @param {unknown} cause @returns {string | undefined} */
export const codeOf = (cause: unknown) => (cause as NodeJS.ErrnoException | null)?.code;
/** @param {unknown} cause @returns {string | undefined} the path the file system refused, when it says */
export const pathOf = (cause: unknown) => (cause as NodeJS.ErrnoException | null)?.path;

/**
 * A FINDING THAT STAYS until the chairman runs a root command. Its unit names its source, so a `NOT READ` of one is not the key of another's, and `manualFix` keeps the host-drift
 * gate from waking a session every tick to run `host:install`, which cannot clear it. `host:check` still prints it.
 */
export const standing = (source: string, problem: string, detail: string): Finding => ({ unit: `kernel ${source}`, problem, detail, manualFix: true });

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

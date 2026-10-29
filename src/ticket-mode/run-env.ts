// @ts-check
// module: a run's pane environment -- what the board sets when it starts a run, read back from the run's Claude process, and the keys a restored pane lost (A11-279)
//
// HERDR RESTORES A PANE'S DIRECTORY AND CLAUDE SESSION, NOT ITS ENVIRONMENT. After the 15:20Z crash herdr brought every session back without `AGENT_ORG_TICKET` and the rest, and the gh wrapper refused A11-246's
// `gh pr create` as if it came from a session that is not a ticket's (`plugins/github/wrapper/gh`). A running process cannot be given variables, so a run that lacks them is started again where it is, with the
// environment {@link runEnvOf} builds: the same function `start()` passes to `workspace create --env`, so "as the board set it at start" is true by construction.
import { readFileSync } from "node:fs";
import { type HerdrAsync } from "./pool-herdr.ts";
import { type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { runTmpDir, TMPDIR_ENV } from "../session-tmp.ts";
import { TICKET_ENV } from "./worktree-command.ts";

export { TMPDIR_ENV };

/**
 * The variables a run's shell carries: its ticket and branch (a batch's run has no one ticket, and none), the host file `ticket:worktree` reads, and its private `TMPDIR` under `runTmpBase` (`run-isolation.ts`), when the pool
 * gives runs one. The directory is named by the run's id alone, so the environment of a re-seated run names the directory it was started with. PURE.
 */
export function runEnvOf({ hostFile, runTmpBase }: Readonly<{ hostFile: string | undefined; runTmpBase?: string | undefined }>, entry: Pick<Entry, "batch" | "ticket">): Record<string, string> {
  const runId = entry.batch ?? entry.ticket.key;
  return {
    ...(entry.batch === undefined ? { [TICKET_ENV.key]: runId, [TICKET_ENV.branch]: entry.ticket.branch } : {}),
    ...(hostFile ? { [TICKET_ENV.host]: hostFile } : {}),
    ...(runTmpBase === undefined ? {} : { [TMPDIR_ENV]: runTmpDir(runTmpBase, runId) }),
  };
}

/** The environment of the Claude process in a pane, or null when it cannot be read: herdr names no Claude process there, or `/proc` refuses it. A read that fails says nothing about the run. The machine's own read asks herdr without holding the loop (A11-282). */
export type PaneEnv = (pane: string) => Readonly<Record<string, string>> | null | Promise<Readonly<Record<string, string>> | null>;

/** The pid of the foreground `claude` process herdr reports for a pane, or null. PURE. */
export function claudePidOf(processInfo: string): number | null {
  try {
    const processes = JSON.parse(processInfo)?.result?.process_info?.foreground_processes;
    if (!Array.isArray(processes)) return null;
    const claude = processes.find((p) => p?.name === "claude" && Number.isInteger(p?.pid));
    return claude === undefined ? null : Number(claude.pid);
  } catch {
    return null;
  }
}

/** The `KEY=value` pairs of a `/proc/<pid>/environ` text, which separates them by NUL. PURE. */
export function parseEnviron(text: string): Record<string, string> {
  const pairs = text.split("\0").filter((pair) => pair.includes("="));
  return Object.fromEntries(pairs.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
}

/** How long herdr may take to name a pane's process, in ms: the cut the synchronous call had. The wait holds no loop. */
const PROCESS_INFO_MS = 30_000;

/**
 * The machine's own read of a pane's environment: herdr names the pane's foreground `claude` process (`pane process-info`), and `/proc/<pid>/environ` (the same user's) holds the variables it started with.
 * Only reads. `readEnviron` is the seam for `/proc`.
 */
export function livePaneEnv(herdr: HerdrAsync, herdrSession: string, readEnviron: (pid: number) => string = (pid) => readFileSync(`/proc/${pid}/environ`, "utf8")): PaneEnv {
  return async (pane) => {
    try {
      const pid = claudePidOf(await herdr(["--session", herdrSession, "pane", "process-info", "--pane", pane], PROCESS_INFO_MS));
      return pid === null ? null : parseEnviron(readEnviron(pid));
    } catch {
      return null;
    }
  };
}

/**
 * The keys of `wanted` that `held` lacks or holds with another value, which is how "as the board set it at start" is checked: a pane herdr restored holds none of them. The host file's path is the one key checked
 * for presence alone: it is the board's current `hostFile`, which may have moved since the run started (a re-onboard), and the worker's `ticket:worktree` is healthy with the path it has. The ticket and its branch come
 * from the run's own entry, so a different value there is a wrong run's environment. `TMPDIR` is never a lost key: a run started before the pool gave runs a private directory has none, and is healthy (its gh wrapper
 * needs the ticket's keys, not a temp directory), so it must not be started again for that alone. A pane herdr restored has lost the ticket's keys too, and its new start carries the `TMPDIR`. PURE.
 */
export const lostKeys = (wanted: Readonly<Record<string, string>>, held: Readonly<Record<string, string>>): string[] =>
  Object.entries(wanted).filter(([key, value]) => key !== TMPDIR_ENV && (held[key] === undefined || (key !== TICKET_ENV.host && held[key] !== value))).map(([key]) => key);

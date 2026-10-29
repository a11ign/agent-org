// @ts-check
// module: every session the board starts gets a private TMPDIR, and the board removes it once the session holds no workspace (A11-279, A11-303)
//
// A11-303: A SESSION IS NOT ONLY A TICKET'S RUN. The reviewers the board starts had no `TMPDIR` and refilled `/tmp` at ~440 entries an hour, so `openPane` (`herdr-agents.ts`) gives every pane the board opens one, named by the pane's
// label (`session-tmp.ts`). A session that is not a queue entry is held while herdr lists its workspace in the board's session, and removed once it does not; herdr that cannot be listed removes nothing of the kind. The sweep also clears
// the legacy entries earlier runs left in `/tmp` itself (`legacy-tmp.ts`), within the same budget.
//
// WHY. On 2026-10-25 a 26 s soft lockup in `ext4_readdir` took the agents host down while the shared `/tmp` held ~19,600 entries, nearly all of them left by tests a worker ran. A worker's session now starts with
// `TMPDIR=<base>/run-t-<run>`, so whatever its tests and tools write with `os.tmpdir()` lands in a directory only that run uses, and goes with it. `<base>` is `privateBase()` (`A11Y_PRIVATE_TMP_BASE`, else
// `~/.cache/a11ign/tmp`), the one agent-org's own test runs use (`private-tmp.ts`).
//
// THE NAME IS AN INTERFACE. `run-t-<run>` starts with `run-`, which is what `private-tmp.ts`'s `requirePrivate` accepts (so no removal here can leave the base) and what #3849's user tmpfiles rule ages out after a day (the
// backstop for a directory this module never got to remove). The name holds the run's id and nothing random, so the directory a re-seated run is started with is the one it was started with (the environment is rebuilt,
// not remembered), and a short path keeps Unix socket paths under their limit.
//
// A RUN HOLDS ITS DIRECTORY WHILE IT HOLDS A WORKSPACE. A parked run (it ended `needs-human`) still has its agent open for a person to answer, and that agent still has this directory as its `TMPDIR`, so the sweep
// keeps it, as `queue-pins.ts` keeps a tool version: a run is held when it is live or has a workspace. The sweep removes one entry per call and at most {@link MAX_REMOVALS_PER_PASS} per pass, never one recursive `rm`:
// the incident was a large directory operation, and a leaver with thousands of entries is taken down over a few passes. A directory modified within {@link SWEEP_GRACE_MS} is left, since a run being started has made it
// before its workspace is recorded. The sweep also touches (and, if gone, makes again) the directory of each run it holds, on every pass: the user tmpfiles rule ages `run-*` out after a day and another instance on the same
// base skips only what was modified in the last minutes, and neither knows the queue.
import { lstatSync, readdirSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { readAgentsAsync } from "../herdr-agents.ts";
import { requirePrivate } from "../private-tmp.ts";
import { makeRunTmp, RUN_TMP_PREFIX, runTmpName } from "../session-tmp.ts";
import { type Budget, removeWithin } from "./bounded-removal.ts";
import { sweepLegacyTmp } from "./legacy-tmp.ts";
import { type PoolContext } from "./pool-context.ts";
import { isLive } from "./queue/queue-entries-and-outcomes.ts";
import { log } from "./pool-state.ts";
import { HERDR_CALL_MS } from "./pool-herdr.ts";

export { makeRunTmp, RUN_TMP_PREFIX, runTmpDir, runTmpName } from "../session-tmp.ts";

/** The most entries one pass of the sweep removes. */
export const MAX_REMOVALS_PER_PASS = 500;

/** How long a directory must have gone unmodified before the sweep takes it: a run being started has made its directory and not yet recorded its workspace. */
export const SWEEP_GRACE_MS = 10 * 60_000;

/**
 * `env` with its private `TMPDIR` made before the run's shell exists. A directory that cannot be made leaves the run on the shared `/tmp`, said in the log, and `env` without a `TMPDIR`: the run is not refused for it.
 * An `env` that names no `TMPDIR` (the pool gives runs none) is returned as it is.
 */
export function withRunTmpMade(ctx: PoolContext, env: Record<string, string>, runId: string): Record<string, string> {
  const { TMPDIR: dir, ...rest } = env;
  if (dir === undefined) return env;
  const refusal = makeRunTmp(ctx.runTmpBase!, dir);
  if (refusal === null) return env;
  log(`${runId} was started without a private TMPDIR: ${refusal}`);
  return rest;
}

/** The names of the run directories the runs the board holds own. PURE. */
function heldNames(ctx: PoolContext): Set<string> {
  return new Set(ctx.store.get().entries.filter((entry) => isLive(entry) || entry.workspace !== undefined).map((entry) => runTmpName(entry.batch ?? entry.ticket.key)));
}

/** The names of the run directories of every run in the queue, held or not: a directory with one of these names is a run's, and is known to be over when the run holds nothing. PURE. */
const queuedNames = (ctx: PoolContext): Set<string> => new Set(ctx.store.get().entries.map((entry) => runTmpName(entry.batch ?? entry.ticket.key)));

/**
 * The names of the directories of the sessions herdr lists in the board's session (A11-303): a reviewer, a new-ticket run or a publish run is no queue entry, and its workspace is what says it is still there. Null when herdr
 * could not be listed, which says nothing of what is there, so no directory is taken for it.
 */
async function liveSessionNames(ctx: PoolContext): Promise<Set<string> | null> {
  // Asked without holding the loop (A11-282): the sweep runs every pass, and a synchronous listing held the board thread for as long as herdr took.
  const agents = await readAgentsAsync((args) => ctx.herdrCall(args, HERDR_CALL_MS), { session: ctx.settings.herdrSession, say: () => {} });
  return agents === null ? null : new Set(agents.map((agent) => runTmpName(agent.label)));
}

/**
 * Make sure a held run's directory exists and is fresh. Two other janitors read the directory's age and know nothing of the queue: the user tmpfiles rule (`a11ign-tmp.tmpfiles.conf.in`, `mM:1d`) removes a directory
 * nothing has written in for a day, and another instance's sweep on the same base skips only a directory modified within {@link SWEEP_GRACE_MS}. A parked run answered the next morning, or a worker on a long CI wait, would
 * otherwise lose the `TMPDIR` its agent holds. A directory that is gone is made again (a run started before this change has none, and gets an unused one that the sweep removes with the run's end).
 */
function keepHeld(ctx: PoolContext, base: string, name: string): void {
  const dir = join(base, name);
  const refusal = makeRunTmp(base, dir);
  if (refusal !== null) return void log(`the private temp directory ${dir} of a run could not be kept: ${refusal}`);
  const at = new Date(ctx.now());
  try {
    utimesSync(dir, at, at);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`the private temp directory ${dir} of a run could not be touched: ${(err as Error).message.split("\n")[0]}`);
  }
}

/** Remove `name` under `base` if it is not a real directory (a symlink is removed as itself, never followed), or take its contents within the budget. A directory modified inside the grace is left. */
function removeEnded(ctx: PoolContext, base: string, name: string, budget: Budget): void {
  const dir = join(base, name);
  const info = lstatSync(dir);
  if (!info.isDirectory()) {
    unlinkSync(requirePrivate(dir, base));
    budget.left -= 1;
  } else if (ctx.now() - info.mtimeMs >= SWEEP_GRACE_MS) {
    removeWithin(dir, (path) => requirePrivate(path, base), budget);
  }
}

/** What is known of a directory no held run owns: its queue run is over or its session is gone (`ended`), its session is listed (`listed`), or herdr could not be asked and so nothing is known (`unknown`). */
type Fate = "ended" | "listed" | "unknown";

/** The fate of the directory `name`: a queue entry that holds nothing is over without asking herdr; any other name is a session, and herdr's listing says whether it is still there. */
function fateOf(name: string, queued: ReadonlySet<string>, listed: ReadonlySet<string> | null): Fate {
  if (queued.has(name)) return "ended";
  if (listed === null) return "unknown";
  return listed.has(name) ? "listed" : "ended";
}

/** The run directories under the base nobody holds any more, removed within `budget`. */
async function sweepRunDirs(ctx: PoolContext, base: string, budget: Budget): Promise<void> {
  let names: string[];
  try {
    names = readdirSync(base).filter((name) => name.startsWith(RUN_TMP_PREFIX));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`the private temp directories under ${base} could not be listed: ${(err as Error).message.split("\n")[0]}`);
    return;
  }
  // herdr is asked once a pass, and only when a directory is there that no queue entry owns. The queue is read again after the answer: it moved while herdr listed.
  const sessions = names.some((name) => !queuedNames(ctx).has(name)) ? await liveSessionNames(ctx) : null;
  const held = heldNames(ctx);
  for (const name of held) keepHeld(ctx, base, name);
  const queued = queuedNames(ctx);
  for (const name of names.filter((each) => !held.has(each))) {
    const fate = fateOf(name, queued, sessions);
    if (fate === "listed") keepHeld(ctx, base, name);
    if (fate !== "ended") continue;
    if (budget.left === 0) return;
    try {
      removeEnded(ctx, base, name, budget);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`the private temp directory ${join(base, name)} of a run that has ended could not be removed: ${(err as Error).message.split("\n")[0]}`);
    }
  }
}

/**
 * Remove the run directories no held run or listed session owns, within {@link MAX_REMOVALS_PER_PASS} entries, and then the legacy entries in `/tmp` with what is left of them (`legacy-tmp.ts`). Does nothing for a run
 * directory when the pool gives runs no private directory (`ctx.runTmpBase` unset: every test, and an instance started without one), and nothing in `/tmp` when it names none. A directory that cannot be read or removed
 * is said, and tried at the next pass. Never throws.
 */
export async function sweepRunTmp(ctx: PoolContext): Promise<void> {
  const budget: Budget = { left: MAX_REMOVALS_PER_PASS };
  if (ctx.runTmpBase !== undefined) await sweepRunDirs(ctx, ctx.runTmpBase, budget);
  sweepLegacyTmp(ctx, budget);
}

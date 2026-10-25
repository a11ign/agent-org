// @ts-check
// module: every run gets a private TMPDIR, and the board removes it once the run holds no workspace (A11-279)
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
// before its workspace is recorded.
import { mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { requirePrivate } from "../private-tmp.ts";
import { type PoolContext } from "./pool-context.ts";
import { isLive } from "./queue/queue-entries-and-outcomes.ts";
import { log } from "./pool-state.ts";

/** The prefix of a run's directory under the base: `run-` for `requirePrivate` and the tmpfiles backstop, `t-` to tell it from a test run's `run-<stamp>-<pid>`. */
export const RUN_TMP_PREFIX = "run-t-";

/** The most entries one pass of the sweep removes. */
export const MAX_REMOVALS_PER_PASS = 500;

/** How long a directory must have gone unmodified before the sweep takes it: a run being started has made its directory and not yet recorded its workspace. */
export const SWEEP_GRACE_MS = 10 * 60_000;

/** The directory name of a run: its id, with anything outside `[A-Za-z0-9_.-]` replaced, so no id can name a path outside the base. PURE. */
export const runTmpName = (runId: string): string => `${RUN_TMP_PREFIX}${runId.replace(/[^A-Za-z0-9_.-]/g, "_")}`;

/** A run's private `TMPDIR` under `base`. PURE. */
export const runTmpDir = (base: string, runId: string): string => join(base, runTmpName(runId));

/** Make a run's directory, or say why it could not be made. A run whose directory cannot be made is started without a `TMPDIR` and not refused: the shared `/tmp` is the old behaviour, and a stopped run is worse. */
export function makeRunTmp(base: string, dir: string): string | null {
  try {
    mkdirSync(requirePrivate(dir, base), { recursive: true });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message.split("\n")[0]! : String(err);
  }
}

/** Entries left to remove in this pass: spent one per `unlink` or `rmdir`. */
type Budget = { left: number };

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

/** Remove `dir` one entry per call until `budget` is spent. True when `dir` itself is gone. Every path passes `requirePrivate`. */
function removeWithin(dir: string, base: string, budget: Budget): boolean {
  for (const entry of readdirSync(requirePrivate(dir, base), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!removeWithin(path, base, budget)) return false;
    } else {
      if (budget.left === 0) return false;
      unlinkSync(requirePrivate(path, base));
      budget.left -= 1;
    }
  }
  if (budget.left === 0) return false;
  rmdirSync(requirePrivate(dir, base));
  budget.left -= 1;
  return true;
}

/** The names of the run directories the runs the board holds own. PURE. */
function heldNames(ctx: PoolContext): Set<string> {
  return new Set(ctx.store.get().entries.filter((entry) => isLive(entry) || entry.workspace !== undefined).map((entry) => runTmpName(entry.batch ?? entry.ticket.key)));
}

/**
 * Remove the run directories no held run owns, within {@link MAX_REMOVALS_PER_PASS} entries. Does nothing when the pool gives runs no private directory (`ctx.runTmpBase` unset: every test, and an instance started
 * without one). A directory that cannot be read or removed is said, and tried at the next pass. Never throws.
 */
export function sweepRunTmp(ctx: PoolContext): void {
  const base = ctx.runTmpBase;
  if (base === undefined) return;
  let names: string[];
  try {
    names = readdirSync(base).filter((name) => name.startsWith(RUN_TMP_PREFIX));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`the private temp directories under ${base} could not be listed: ${(err as Error).message.split("\n")[0]}`);
    return;
  }
  const held = heldNames(ctx);
  const budget: Budget = { left: MAX_REMOVALS_PER_PASS };
  for (const name of names.filter((each) => !held.has(each))) {
    if (budget.left === 0) return;
    const dir = join(base, name);
    try {
      if (ctx.now() - statSync(dir).mtimeMs < SWEEP_GRACE_MS) continue;
      removeWithin(dir, base, budget);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`the private temp directory ${dir} of a run that has ended could not be removed: ${(err as Error).message.split("\n")[0]}`);
    }
  }
}

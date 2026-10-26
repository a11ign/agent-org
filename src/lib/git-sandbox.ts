// no-token: none -- a test helper over `@a11ign/toolchain/lib/git-sandbox`; it spawns `git` only through the sandbox that helper makes
/**
 * (A11-301) `withGitSandbox` THAT WAITS OUT A LATE WRITER AND NEVER STARTS THE USUAL ONE.
 *
 * CI named `SandboxNotRemovedError` twice in an hour (2026-10-26, runs 40382975143 and 40385719656) on `region-paths-checkout.test.ts`, a file that
 * touches nothing the failing pull requests changed: the sandbox's removal returned and the directory was there. `rmSync` does not do that by itself
 * (a writer racing its scan makes it THROW, measured on Node 24.21.0), so something wrote into the tree after the scan and put the directory back.
 * The same file left one `a11y-git-sandbox-*` behind on 2026-10-11 and 2026-10-13 (#1400), and `row-claim-one-row.test.ts` (#2606) names the probable
 * writer: `git commit` forks a DETACHED `git maintenance run --auto --detach`, which nothing the test awaits.
 *
 * What was NOT established: that child was not seen writing into a removed sandbox, and the failure did not reproduce here (80 runs of the file,
 * 50 of them with 10 CPU hogs on 4 cores). So this is two defences, not a proven fix; the cause of the next occurrence is named by `describeSurvivor`.
 *
 *   1. THE WRITER IS NOT STARTED: every sandbox repository is made with `maintenance.auto=false` and `gc.auto=0`, before the test's first commit.
 *   2. A WRITER THAT IS RUNNING IS WAITED FOR: the removal is run again, whole, until the directory is gone and has stayed gone for `SETTLE_MS`
 *      (`rmSync`'s own `maxRetries` re-runs only the final `rmdir`, so a file made after the scan keeps it failing; see `row-claim-one-row.test.ts`).
 *      The settle is a heuristic and not a proof: a writer that is descheduled for longer than `SETTLE_MS` (CI's first version of the test for this saw one, on a
 *      runner loaded with four test runs) is not seen. A directory that is still there after `ATTEMPTS` tries is left for the toolchain helper to refuse with its own `SandboxNotRemovedError`,
 *      after this module has printed what was in it. Nothing is swallowed.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { withGitSandbox as toolchainWithGitSandbox, type GitSandbox } from "@a11ign/toolchain/lib/git-sandbox";

export { sandboxGitEnv } from "@a11ign/toolchain/lib/git-sandbox";
export type { GitSandbox };

/** How many times the whole removal is run, and the pause between runs. Two seconds in all, against a writer that is a `git` process of milliseconds. */
const ATTEMPTS = 20;
const PAUSE_MS = 100;
/** How long a removed directory must stay removed before the removal counts as done. */
const SETTLE_MS = 25;
/** How many of a survivor's entries the report names, and the size of the int32 `Atomics.wait` sleeps on. */
const ENTRIES_NAMED = 12;
const SLEEP_CELL_BYTES = 4;
/** What `rmSync` throws while something is still writing into the tree, or holds a file in it: worth running again. Any other code is a real refusal. */
const TRANSIENT = new Set(["ENOTEMPTY", "EBUSY", "EPERM"]);

export interface RemovalPlan {
  remove?: (dir: string) => void;
  attempts?: number;
  pauseMs?: number;
  settleMs?: number;
  /** Where the account of a survivor goes. */
  report?: (line: string) => void;
}

const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(SLEEP_CELL_BYTES)), 0, 0, ms); };

const removeTree = (dir: string): void => rmSync(dir, { recursive: true, force: true });

/** What is in a directory that would not go, so the red names its writer's work and not only the directory. */
export function describeSurvivor(dir: string): string {
  try {
    const names = readdirSync(dir, { recursive: true }).map(String).toSorted();
    return `${dir} holds ${names.length} entr${names.length === 1 ? "y" : "ies"} after its removal: ${names.slice(0, ENTRIES_NAMED).join(", ")}${names.length > ENTRIES_NAMED ? ", ..." : ""}`;
  } catch (error) {
    return `${dir} could not be listed after its removal (${(error as NodeJS.ErrnoException).code ?? String(error)})`;
  }
}

/**
 * Removes `dir`, running the whole removal again while it is not gone, and returns when it has been gone for `settleMs`. Throws the removal's own error when
 * that error is not transient; when the directory outlives every attempt it returns, so that the caller's own existence check is the one that refuses.
 */
export function removeUntilSettled(dir: string, {
  remove = removeTree,
  attempts = ATTEMPTS,
  pauseMs = PAUSE_MS,
  settleMs = SETTLE_MS,
  report = (line: string) => console.error(line),
}: RemovalPlan = {}): void {
  let lastRefusal = "none";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let failure: unknown;
    try { remove(dir); } catch (error) { failure = error; }
    if (failure !== undefined && !TRANSIENT.has((failure as NodeJS.ErrnoException).code ?? "")) throw failure;
    if (failure !== undefined) lastRefusal = (failure as NodeJS.ErrnoException).code ?? "";
    if (!existsSync(dir)) {
      pause(settleMs);
      if (!existsSync(dir)) return;
    }
    if (attempt < attempts) pause(pauseMs);
  }
  if (existsSync(dir)) report(`git-sandbox: ${describeSurvivor(dir)} (pid ${process.pid}, ${attempts} removals ${pauseMs}ms apart, last refusal: ${lastRefusal})`);
}

/**
 * `withGitSandbox` from the toolchain, over a repository that never maintains itself and whose removal waits for a late writer.
 * `root` is the toolchain helper's own, and is left at its default unless a test points it at a decoy.
 */
export function withGitSandbox<T>(fn: (sandbox: GitSandbox) => T, root?: string, plan: RemovalPlan = {}): T {
  return toolchainWithGitSandbox(
    (sandbox) => {
      sandbox.run(["config", "maintenance.auto", "false"]);
      sandbox.run(["config", "gc.auto", "0"]);
      return fn(sandbox);
    },
    root,
    { remove: (dir) => removeUntilSettled(dir, plan) },
  );
}

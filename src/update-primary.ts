#!/usr/bin/env node
// @ts-check
// command: the one sanctioned way to move the primary checkout: fetch, detach at origin/main, install if the lockfile moved, rebuild
// THE ONE WAY TO UPDATE THE PRIMARY CHECKOUT — issue #126. Fetch, then detach at `origin/main`. Nothing
// else: no merge, no rebase, no branch, because the primary is read-only except fast-forward and the
// `post-checkout` hook will otherwise immediately undo anything this script leaves it on.
//
//   pnpm run primary:update
//
// Refuses outside the primary — running this in a worktree would detach it from whatever branch it holds,
// which is never what a worktree is for. `isPrimaryWorktree` is the same `.git`-is-a-directory check
// `pre-commit`/`post-checkout` already use, imported rather than restated.
import { execFileSync } from "node:child_process";
import { isPrimaryWorktree } from "./prune-worktrees.ts";
import { sandboxGitEnv } from "./lib/git-env.mjs";
import { pathToFileURL } from "node:url";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refuseUnknownFlags } from "./lib/cli-flags.mjs";
import { pnpmCliInvocation } from "./lib/npm-cli-executable.mjs";
import { changedFiles } from "./lib/changed-files.mjs";
import { HOME_CHECKOUT } from "./project-config.ts";

/** The checkout `primary:update` moves: the PROJECT's (`HOME_CHECKOUT`), which is the tool's own `src` up three only when `$AGENT_ORG_HOST` is unset (#2879). */
export const PRIMARY_CHECKOUT = HOME_CHECKOUT;

/**
 * FAST-FORWARD THE LOCAL `main` BRANCH TOO, because every worktree shares it and this is the only
 * command that moves anything.
 *
 * The primary is DETACHED at `origin/main`, deliberately -- that is what makes it read-only except
 * fast-forward. But `main` is a branch in the same `.git`, checked out nowhere, and nothing has ever
 * moved it. Measured 2026-09-09: it sat at `11d77ade` from 07 Sep while `origin/main` was `cb9dfbce` --
 * 1405 commits behind -- and all 76 worktrees resolve that one ref.
 *
 * SO A RANGE AGAINST BARE `main` ANSWERS A TWO-DAY-OLD QUESTION, and the answer looks exactly like an
 * answer. `git rev-list --count main..<branch>` reported 502 where `origin/main..<branch>` reported 1,
 * and a session used that to call a one-commit `wip` branch an old divergent rewrite -- the opposite
 * decision from the true one. A ref is a value read at a time, and `main` does not say when.
 *
 * FAST-FORWARD ONLY, VIA `update-ref` WITH THE EXPECTED OLD VALUE. `main` must be an ancestor of
 * `origin/main` or this leaves it alone and says so: a local `main` carrying commits `origin` lacks is
 * somebody's unpushed work, and this script's contract is that it destroys nothing. Passing the old
 * value makes the write refuse rather than race if another session moves the ref first.
 *
 * NOT `git branch -f`, which would move a diverged branch without complaint -- the one thing this must
 * not do.
 *
 * @param {(args: string[]) => string} run @param {string} sha
 */
function moveLocalMain(run: (args: string[]) => string, sha: string) {
  let before: string;
  try {
    before = run(["rev-parse", "refs/heads/main"]).trim();
  } catch {
    return; // no local `main` at all -- nothing to move, and creating one is not this command's job
  }
  if (before === sha) return;
  try {
    run(["merge-base", "--is-ancestor", "refs/heads/main", sha]);
  } catch {
    process.stderr.write("local `main` is NOT an ancestor of origin/main -- it carries commits origin "
      + "does not have, so it is somebody's unpushed work and this command will not move it. Ranges "
      + "against bare `main` in any worktree answer a different question until that is resolved; use "
      + "`origin/main`.\n");
    return;
  }
  run(["update-ref", "refs/heads/main", sha, before]);
}

/**
 * The one lockfile of this workspace. Every package resolves through the root `node_modules` it describes.
 * `pnpm-lock.yaml` since #2301, which deleted `package-lock.json`: asking about the old name would have
 * answered "no" for every move from then on, and the install below would never have run again.
 */
export const LOCKFILE = "pnpm-lock.yaml";

/**
 * DID THE MOVE CHANGE THE LOCKFILE? Asked of the two commits the checkout actually moved between, never of
 * the working tree, because the primary's tree is clean by construction and a clean tree answers "no".
 *
 * A HEAD that did not move asks nothing: there is no range, and a `git diff` of a commit against itself
 * would be a question whose answer is empty by construction.
 *
 * ASKED THROUGH `packages/guards/src/changed-files.mjs`, the one place this repository asks git which paths a range
 * touched (#939), so a lockfile moved away is listed under the path it left. `changed` is that helper,
 * injected so a test can answer for git.
 *
 * It reads the answer as a LIST OF PATHS and looks for the lockfile by name, rather than treating any
 * output as "changed", so that a `run` answering something unexpected cannot install by accident.
 *
 * @param {(range: string[], pathspec: string[]) => string[]} changed @param {string} before @param {string} after
 */
export function lockfileMoved(changed: (range: string[], pathspec: string[]) => string[], before: string, after: string) {
  if (before === after) return false;
  return changed([before, after], [LOCKFILE]).includes(LOCKFILE);
}

/**
 * @param {string} [root]
 * @param {(args: string[]) => string} [run]
 * @param {(root: string, argv: string[]) => void} [runAt] runs `argv` (its first element names the tool, always `pnpm`) in `root`; throws on a non-zero exit
 * @param {(range: string[], pathspec: string[]) => string[]} [changed] the paths a range touched
 */
export function updatePrimary(root: string = PRIMARY_CHECKOUT, run: (args: string[]) => string = (args) =>
  execFileSync("git", args, { cwd: root, env: sandboxGitEnv(), encoding: "utf8" }), runAt: (root: string, argv: string[]) => void = runTool,
changed: (range: string[], pathspec: string[]) => string[] = (range, pathspec) => changedFiles(range, { repoRoot: root, pathspec })) {
  if (!isPrimaryWorktree(root)) {
    throw new Error(`${root} is not the primary checkout (its .git is a linked worktree's, not a real `
      + "directory) — this script only ever updates the primary. Use plain `git pull`/`git fetch` here.");
  }
  run(["fetch", "origin"]);
  // Read BEFORE the checkout: afterwards HEAD is the new commit, and the old one is the only way to ask
  // what the move changed.
  const before = run(["rev-parse", "HEAD"]).trim();
  run(["checkout", "--detach", "origin/main", "--quiet"]);
  const sha = run(["rev-parse", "HEAD"]).trim();
  moveLocalMain(run, sha);
  // INSTALL BEFORE BUILD: the build compiles against `node_modules`, so building first would compile the
  // new source against the old dependencies and fail on exactly the module the install was about to add.
  if (lockfileMoved(changed, before, sha)) installAt(root, runAt);
  buildUnlessCurrent(root, runAt, { before, sha });
  return sha;
}

/**
 * `dirty` is the TRACKED paths with uncommitted changes, `behind`/`ahead` the commits `origin/main` has that HEAD lacks and the reverse.
 */
export type PrimaryDrift = {sha: string, originSha: string, behind: number, ahead: number, dirty: string[]};

/**
 * WHERE THE PRIMARY STANDS AGAINST `origin/main`, READ BY THE GATE EVERY TICK (#2781).
 *
 * `primary:update` runs as `ExecStartPre=-`, so a failure is invisible to systemd and the tick goes on. From 2026-09-28T12:01Z an
 * interactive session's uncommitted edits made every `git checkout --detach origin/main` refuse ("would be overwritten"), and the
 * gate gave orders from 22-hour-old code: 2,652 journal lines and not one signal. The update cannot report its own failure to
 * anyone, so this is a SECOND reader, asked of the checkout rather than of the command, and it covers the case the failure
 * does not: tracked edits that do not conflict yet leave the primary dirty (done-when 4).
 *
 * TRACKED PATHS ONLY (`--untracked-files=no`): the build writes untracked output here and the checkout never refuses over it.
 * NO FETCH: `updatePrimary` fetched a moment ago, and a read that fetches is a second network call per tick. If that fetch
 * failed, HEAD equals the old `origin/main` and this says "current", which is a network blip and not a dirty primary.
 *
 * `null` FOR EVERY UNASKABLE CASE, NEVER A CLEAN READING -- a linked worktree (CI, a reviewer's clone), a repository with no
 * `origin/main`, a git that failed. "Could not look" and "looked and it is current" must not share a value.
 *
 * @param {string} [root]
 * @param {(args: string[]) => string} [run]
 * @returns {PrimaryDrift | null}
 */
export function readPrimaryDrift(root: string = PRIMARY_CHECKOUT, run: (args: string[]) => string = (args) =>
  execFileSync("git", args, { cwd: root, env: sandboxGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })): PrimaryDrift | null {
  if (!isPrimaryWorktree(root)) return null;
  try {
    const sha = run(["rev-parse", "HEAD"]).trim();
    const originSha = run(["rev-parse", "refs/remotes/origin/main"]).trim();
    const count = (range: string) => Number(run(["rev-list", "--count", range]).trim());
    const behind = count(`${sha}..${originSha}`);
    const ahead = count(`${originSha}..${sha}`);
    const dirty = run(["status", "--porcelain", "--untracked-files=no"]).split("\n").filter(Boolean)
      .map((line) => line.slice(3));
    return Number.isInteger(behind) && Number.isInteger(ahead) ? { sha, originSha, behind, ahead, dirty } : null;
  } catch {
    return null; // not asked: the caller must treat this as unreadable, never as current
  }
}

/** @param {unknown} error @returns {string} the child's exit status, or `?` when it has none */
function exitOf(error: unknown): string {
  const status = (error as { status?: number }).status;
  return String(status ?? "?");
}

/**
 * INSTALL WHEN THE LOCKFILE MOVED, BECAUSE EVERY WORKTREE RESOLVES THIS CHECKOUT'S `node_modules` -- #1384.
 *
 * Measured 2026-09-13: #1380 (`8fe2db08`) added `@rstest/core` as a root devDependency. This script moved
 * the primary to the new lockfile and rebuilt, and nothing installed, so from 18:46Z every push from every
 * worktree on the host failed its pre-push typecheck with TS2307 on a module the shared `node_modules`
 * did not have, until `ceo` noticed and installed by hand.
 *
 * `install`, NEVER a clean install (`ceo`'s ruling on the row). `npm ci` deletes `node_modules` before it
 * installs, which removes it from under every worktree that is running a test or a push at that moment.
 * `pnpm install --frozen-lockfile` (since #2301) is not that: it links what the lockfile names into the
 * existing tree and refuses, rather than rewrites, a lockfile that disagrees with a manifest.
 *
 * A FAILED INSTALL IS REPORTED, NEVER SWALLOWED, the same way a failed build is, and for the same reason:
 * the checkout has already moved and is correct. The message also says a re-run will not retry, because
 * the next run finds HEAD already at the target and so asks no lockfile question at all.
 *
 * @param {string} root @param {(root: string, argv: string[]) => void} runAt
 */
function installAt(root: string, runAt: (root: string, argv: string[]) => void) {
  try {
    runAt(root, ["pnpm", "install", "--frozen-lockfile"]);
  } catch (error) {
    throw new Error(`the primary moved to a new ${LOCKFILE}, but \`pnpm install\` failed (exit `
      + `${exitOf(error)}). Every worktree resolves THIS checkout's node_modules, so they are now resolving `
      + "a stale node_modules against the new lockfile, and a push from any of them can fail its typecheck "
      + "on a missing module. The build did not run. Re-running primary:update will NOT retry the install "
      + "(HEAD is already at the target), so run `pnpm install --frozen-lockfile` here by hand -- never "
      + "`npm ci`, which deletes node_modules from under every running worktree.", { cause: error });
  }
}

/**
 * REBUILD, BECAUSE MOVING THE PRIMARY MOVES EVERY WORKTREE'S `dist` AND NOTHING ELSE DOES.
 *
 * Every linked worktree shares this checkout's `node_modules`, so a cross-package import from any of them
 * resolves to THE PRIMARY'S `dist` -- CLAUDE.md states it, and `docs/operational-lessons.md` records the
 * afternoon spent discovering that "resolves to dist" does not say whose. Fast-forwarding the primary
 * therefore advances the SOURCE that nine worktrees compile against while leaving the COMPILED OUTPUT at
 * whatever commit it was last built at.
 *
 * Measured 2026-09-09: the orchestrator's docs-only push was refused by the pre-push hook on a module
 * that `main` has and the primary's `dist` did not. A docs change, refused by a resolution failure, in a
 * worktree that had never been anything but current -- and nothing in the message could point at the
 * primary, because the primary was not what they had touched.
 *
 * THE BUILD IS PART OF THE UPDATE, not a thing to remember afterwards. That is this repository's own
 * rule: anything a human has to remember is something that does not happen. `primary:update` is already
 * the ONE sanctioned way to move this checkout (#126), which makes it the only place this can live and
 * be reached every time.
 *
 * A FAILED BUILD IS REPORTED, NEVER SWALLOWED, and never rolls the checkout back: the fast-forward has
 * already happened and is correct, and leaving a stale `dist` beside a moved source with a loud error is
 * strictly better than silently reverting a checkout somebody else may already be reading.
 *
 * THE WRAPPING LIVES HERE, NOT IN `runAt`, because what a failed build MEANS is a fact about this
 * checkout's relationship to every worktree -- true whichever package manager ran, and the reason a caller
 * needs the message at all.
 *
 * @param {string} root @param {(root: string, argv: string[]) => void} runAt
 */
function buildAt(root: string, runAt: (root: string, argv: string[]) => void) {
  try {
    runAt(root, ["pnpm", "run", "build"]);
  } catch (error) {
    throw new Error(`the primary moved, but \`pnpm run build\` failed (exit ${exitOf(error)}). Every `
      + "worktree resolves THIS checkout's dist, so they are now compiling against a source this dist "
      + "does not match. Fix the build here before trusting a cross-package import anywhere.", { cause: error });
  }
}

/**
 * Where the last SUCCESSFUL build of the primary is recorded, inside `.git`: not a tracked file, nowhere the
 * primary's `git status` looks, and a path no worktree can mistake for its own (a worktree's `.git` is a file).
 */
const BUILD_STAMP = join(".git", "primary-build-stamp.json");

/**
 * THE `dist` DIRECTORIES THE BUILD LEFT, which is what a skip must be able to SEE: a stamp says a build
 * once succeeded, and cannot see a `dist` somebody deleted. A package whose `dist` is missing or empty is
 * left out, so a stamp written when no output existed names nothing and never licenses a skip.
 *
 * @param {string} root @returns {string[]}
 */
function builtOutputs(root: string): string[] {
  const packages = join(root, "packages");
  if (!existsSync(packages)) return [];
  return readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join("packages", entry.name, "dist"))
    .filter((dist) => existsSync(join(root, dist)) && readdirSync(join(root, dist)).length > 0);
}

/**
 * @param {string} root @returns {{ sha?: unknown, outputs?: unknown } | null} null when there is no stamp, or one that does not parse:
 * either way the answer is to build, which is the safe direction, so an unreadable stamp is a rebuild and not an error.
 */
function readBuildStamp(root: string): { sha?: unknown; outputs?: unknown; } | null {
  if (!existsSync(join(root, BUILD_STAMP))) return null;
  try {
    return JSON.parse(readFileSync(join(root, BUILD_STAMP), "utf8"));
  } catch {
    return null;
  }
}

/**
 * A BUILD IS CURRENT only when the last SUCCESSFUL build was of THIS sha AND every `dist` it left is still
 * there. Neither alone will do: the sha alone would trust a `dist` somebody deleted, and the outputs alone
 * would trust a `dist` built from other source.
 *
 * @param {string} root @param {string} sha
 */
function buildIsCurrent(root: string, sha: string) {
  const stamp = readBuildStamp(root);
  if (stamp === null || stamp.sha !== sha || !Array.isArray(stamp.outputs) || stamp.outputs.length === 0) return false;
  return stamp.outputs.every((dist) => typeof dist === "string" && existsSync(join(root, dist)) && readdirSync(join(root, dist)).length > 0);
}

/**
 * SKIP THE REBUILD WHEN NOTHING MOVED -- #3566. `work:tick` runs this before every tick, 30 a hour, and the
 * build was unconditional: measured 11.6 to 12.4 s of wall and 27.6 to 29.9 s of CPU for a build that changed
 * nothing, which is most of the tick's `prestartMs` and CPU the `tick-cost` line cannot see (`ExecStartPre` is
 * outside the tick process).
 *
 * THE SKIP NEEDS ALL THREE: HEAD did not move, the last successful build was of this sha, and its output is
 * still on disk. The stamp is written only AFTER a build returns, so a FAILED build leaves none for this sha
 * and is retried on every tick exactly as before -- HEAD staying put after a failure must never turn a loud
 * failure into a silent stale `dist`, which is what `buildAt` forbids.
 *
 * @param {string} root @param {(root: string, argv: string[]) => void} runAt @param {{ before: string, sha: string }} moved
 */
function buildUnlessCurrent(root: string, runAt: (root: string, argv: string[]) => void, { before, sha }: { before: string; sha: string; }) {
  if (before === sha && buildIsCurrent(root, sha)) return;
  buildAt(root, runAt);
  writeFileSync(join(root, BUILD_STAMP), JSON.stringify({ sha, outputs: builtOutputs(root) }));
}

/**
 * Runs `argv` in `root`, its first element naming the tool, which is always `pnpm`: it installs and it runs the scripts.
 * @param {string} root @param {string[]} argv
 */
function runTool(root: string, argv: string[]) {
  // `pnpmCliInvocation`, never a bare `pnpm` -- a bare spawn is unsafe on Windows, and this repository's own guard
  // (`no-npm-spawn.test.ts`) refuses one anywhere in the tree. Same call shape as every other site.
  const [tool, ...args] = argv;
  if (tool !== "pnpm") throw new Error(`update-primary runs pnpm and nothing else, not \`${tool}\``);
  const invocation = pnpmCliInvocation(args);
  execFileSync(invocation.command, invocation.args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  // Guarded per #164: `--drift` only READS (the gate spawns it, #2781); --detach/--quiet go to git.
  refuseUnknownFlags(["--drift"], { entry: import.meta.url, command: "node --import tsx packages/agent-org/src/update-primary.ts" });
  if (process.argv.slice(2).includes("--drift")) {
    const drift = readPrimaryDrift();
    process.stdout.write(`${JSON.stringify({ asked: drift !== null, drift })}\n`);
    process.exit(0);
  }
  const sha = updatePrimary();
  console.log(`primary checkout detached at origin/main (${sha})`);
}

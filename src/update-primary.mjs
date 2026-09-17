#!/usr/bin/env node
// @ts-check
// command: the one sanctioned way to move the primary checkout: fetch, detach at origin/main, install if the lockfile moved, rebuild
// THE ONE WAY TO UPDATE THE PRIMARY CHECKOUT — issue #126. Fetch, then detach at `origin/main`. Nothing
// else: no merge, no rebase, no branch, because the primary is read-only except fast-forward and the
// `post-checkout` hook will otherwise immediately undo anything this script leaves it on.
//
//   npm run primary:update
//
// Refuses outside the primary — running this in a worktree would detach it from whatever branch it holds,
// which is never what a worktree is for. `isPrimaryWorktree` is the same `.git`-is-a-directory check
// `pre-commit`/`post-checkout` already use, imported rather than restated.
import { execFileSync } from "node:child_process";
import { isPrimaryWorktree } from "./prune-worktrees.mjs";
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { refuseUnknownFlags } from "@a11ign/worker-fleet/cli-flags";
import { npmCliInvocation } from "../../../scripts/npm-cli-executable.mjs";
import { changedFiles } from "../../guards/src/changed-files.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

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
function moveLocalMain(run, sha) {
  /** @type {string} */
  let before;
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

/** The one lockfile of this workspace. Every package resolves through the root `node_modules` it describes. */
export const LOCKFILE = "package-lock.json";

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
export function lockfileMoved(changed, before, after) {
  if (before === after) return false;
  return changed([before, after], [LOCKFILE]).includes(LOCKFILE);
}

/**
 * @param {string} [root]
 * @param {(args: string[]) => string} [run]
 * @param {(root: string, args: string[]) => void} [npmAt] runs npm in `root`; throws on a non-zero exit
 * @param {(range: string[], pathspec: string[]) => string[]} [changed] the paths a range touched
 */
export function updatePrimary(root = REPO, run = (args) =>
  execFileSync("git", args, { cwd: root, env: sandboxGitEnv(), encoding: "utf8" }), npmAt = runNpm,
changed = (range, pathspec) => changedFiles(range, { repoRoot: root, pathspec })) {
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
  if (lockfileMoved(changed, before, sha)) installAt(root, npmAt);
  buildAt(root, npmAt);
  return sha;
}

/** @param {unknown} error @returns {string} the child's exit status, or `?` when it has none */
function exitOf(error) {
  const status = /** @type {{ status?: number }} */ (error).status;
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
 * `npm install`, NEVER `npm ci` (`ceo`'s ruling on the row). `npm ci` deletes `node_modules` before it
 * installs, which removes it from under every worktree that is running a test or a push at that moment.
 * `npm install` is additive and respects the lockfile.
 *
 * A FAILED INSTALL IS REPORTED, NEVER SWALLOWED, the same way a failed build is, and for the same reason:
 * the checkout has already moved and is correct. The message also says a re-run will not retry, because
 * the next run finds HEAD already at the target and so asks no lockfile question at all.
 *
 * @param {string} root @param {(root: string, args: string[]) => void} npmAt
 */
function installAt(root, npmAt) {
  try {
    npmAt(root, ["install"]);
  } catch (error) {
    throw new Error(`the primary moved to a new ${LOCKFILE}, but \`npm install\` failed (exit `
      + `${exitOf(error)}). Every worktree resolves THIS checkout's node_modules, so they are now resolving `
      + "a stale node_modules against the new lockfile, and a push from any of them can fail its typecheck "
      + "on a missing module. The build did not run. Re-running primary:update will NOT retry the install "
      + "(HEAD is already at the target), so run `npm install` here by hand -- never `npm ci`, which "
      + "deletes node_modules from under every running worktree.", { cause: error });
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
 * THE WRAPPING LIVES HERE, NOT IN `npmAt`, because what a failed build MEANS is a fact about this
 * checkout's relationship to every worktree -- true whichever npm runner ran, and the reason a caller
 * needs the message at all.
 *
 * @param {string} root @param {(root: string, args: string[]) => void} npmAt
 */
function buildAt(root, npmAt) {
  try {
    npmAt(root, ["run", "build"]);
  } catch (error) {
    throw new Error(`the primary moved, but \`npm run build\` failed (exit ${exitOf(error)}). Every `
      + "worktree resolves THIS checkout's dist, so they are now compiling against a source this dist "
      + "does not match. Fix the build here before trusting a cross-package import anywhere.", { cause: error });
  }
}

/** @param {string} root @param {string[]} args */
function runNpm(root, args) {
  // `npmCliInvocation`, never a bare `npm` -- #? : a bare npm/npx spawn is unsafe on Windows and this
  // repository's own guard refuses one anywhere in the tree. Same call shape as every other site.
  const npm = npmCliInvocation("npm", args);
  execFileSync(npm.command, npm.args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  // Guarded per #164: takes no flags; --detach/--quiet go to git.
  refuseUnknownFlags([], { entry: import.meta.url, command: "node packages/agent-org/src/update-primary.mjs" });
  const sha = updatePrimary();
  console.log(`primary checkout detached at origin/main (${sha})`);
}

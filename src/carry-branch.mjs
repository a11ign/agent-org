#!/usr/bin/env node
// @ts-check
// command: carry a stalled agent/* branch from a DETACHED checkout -- merge origin/main in and push,
// without ever checking the branch out locally, so it cannot collide with wherever its owner already
// has it (#656)
//
// THE GAP THIS CLOSES: the dispatcher offered to carry #614 -- 97 commits behind, past its escalation
// window -- and could not:
//
//     $ git worktree add /private/tmp/wt-614 agent/pre-push-delete-583
//     fatal: 'agent/pre-push-delete-583' is already used by worktree at
//            '.../a11y-wt-pushdel-583'
//
// The `session:` label records who holds a ROW; `git worktree list` records who holds a BRANCH. Neither
// record knows about the other, so a row could be escalated and reassigned while its branch stayed
// checked out somewhere the new owner could not reach -- an offer made in good faith and found
// impossible. `row-claim.mjs`'s claim now RECORDS the branch (`branch:<name>`), so a session can tell a
// portable row from a held one before offering; this file is the mechanism that makes the offer real
// once made.
//
// ceo's own mechanism, quoted on #656:
//
//     git worktree add --detach <dir> origin/agent/<branch>
//     git merge origin/main
//     git push origin HEAD:refs/heads/agent/<branch>
//
// The branch is never checked out BY NAME in the carrying worktree -- `--detach` lands on the commit,
// not the ref -- so `git worktree add` cannot collide with the owner's own checkout of the same branch.
//
// THREE LIMITS THAT ARE THE POINT, NOT CAVEATS (ceo's own framing, #656):
//   - Not a licence to write into somebody's branch generally. The ESCALATION WINDOW authorises a carry;
//     the ref-lock below is what keeps it safe regardless of who invokes this.
//   - The ref-lock is READ, never forced past. `git push` with no `--force`/`--force-with-lease` refuses
//     non-fast-forward outright, so a simultaneous push from the owner's own worktree still wins the
//     race -- this reports that refusal rather than reaching past it. A routine reflex to retry with
//     `--force-with-lease` here would discard the owner's live work silently; this file never does that
//     and never exposes a flag that would let a caller do it either.
//   - The ordinary case is untouched. An owner who is mid-flight keeps their branch -- nothing here
//     checks a branch out or touches a worktree other than the throwaway one this carry creates and
//     removes.
//
// EXIT CODES (#1477). Each one says whether the push reached the remote, because a caller reads the code first:
//   0  CARRIED and NOTED -- the branch was pushed, and a note was left on its open PR
//   1  NOT CARRIED -- nothing was pushed: the checkout, the fetch, the merge or the push itself failed
//   2  usage -- nothing was attempted
//   3  CARRIED, NOT NOTED -- the branch WAS pushed; finding its PR, or leaving the note, failed afterwards
// A failure after the push must never read as 1. Measured on #1477 at `0830dd0e`: a failing `gh pr comment`
// escaped as an uncaught throw, so Node exited 1 -- NOT CARRIED -- under stdout's own "CARRIED -- ... pushed."
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";
import { REPO } from "../../../scripts/repo-identity.mjs";
import { parseWorktreeList } from "./prune-worktrees.mjs";
import { stampWorktree } from "./worktree-owner.mjs";
// RELATIVE, not the `@a11ign/worker-fleet/cli-flags` package specifier -- see `row-claim.mjs`'s own
// header for why: this needs `node_modules` and a completed build, and this file has neither guarantee.
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
import { assertNoLeakInArgv } from "../../lab/src/packaging/leak-patterns.mjs";

/** @type {(cmd: string, args: string[], opts?: { cwd?: string }) => string} */
const defaultRun = (cmd, args, opts = {}) => {
  assertNoLeakInArgv(cmd, args); // #1053: guarded in the SPAWN HELPER, not per call site
  return execFileSync(cmd, args, { ...opts, env: sandboxGitEnv(), encoding: "utf8" });
};

/** #1477: the exit codes this file's header documents, by name. */
export const EXIT = Object.freeze({ CARRIED: 0, NOT_CARRIED: 1, USAGE: 2, CARRIED_NOT_NOTED: 3 });

/** @param {unknown} error @returns {string} */
function errMsg(error) {
  return /** @type {Error} */ (error).message;
}

/**
 * Is `branch` checked out in ANY worktree of this repository, right now? Reuses `prune-worktrees.mjs`'s
 * own `parseWorktreeList` rather than a second reading of `git worktree list --porcelain` -- two
 * independent parsers of the identical output is the drift this repo pays for most, and #621 already
 * refused to repeat it one layer over for local-import closures.
 *
 * INFORMATIONAL, not a gate on `carryBranch` below -- the detached technique works whether the branch is
 * held or not, so this exists for a caller (a human, or `row-claim.mjs check`'s own branch-naming) to
 * decide WHETHER a carry is even the right move, not to be consulted by the carry itself.
 *
 * @param {string} branch
 * @param {string} repoRoot
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {boolean}
 */
export function branchCheckedOutLocally(branch, repoRoot, { run = defaultRun } = {}) {
  const porcelain = run("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
  return parseWorktreeList(porcelain).some((entry) => entry.branch === branch);
}

/**
 * THE #656 CARRY. Opens a DETACHED worktree at `origin/<branch>`'s current tip (never the branch name
 * itself, so it cannot collide with a worktree that already has that branch checked out), merges
 * `origin/main` into it, and pushes the result straight back to `refs/heads/<branch>`.
 *
 * READS THE DIFFSTAT, NOT JUST THE EXIT CODE -- #656's own stated demonstration requirement, and this
 * repo's own recorded reason why: a merge resolution that keeps its own side and silently drops the
 * other's is a CLEAN exit with every file it dropped invisible to anyone trusting the exit code alone
 * (#232 -- four merged units removed by a resolution with every check green). The diffstat is computed
 * between the branch's OWN pre-merge tip and the merged result, so it names exactly what `origin/main`
 * contributed, not the whole branch's history.
 *
 * NEVER `--force`/`--force-with-lease`, anywhere in this function, on purpose. A plain `git push` is
 * git's own compare-and-swap on the remote ref: it refuses non-fast-forward, so a push landing from the
 * owner's own worktree while this carry is running still wins outright, and `carried: false` reports
 * that refusal rather than this function reaching past it.
 *
 * @param {string} repoRoot a real checkout of this repository to run `git worktree add` FROM
 * @param {string} branch bare branch name, e.g. "agent/pre-push-delete-583" -- no `origin/` prefix
 * @param {{ run?: typeof defaultRun, workDir?: string, stamp?: typeof stampWorktree }} [deps]
 *   `workDir`: an existing directory to use
 *   instead of a fresh temp one, and skip the automatic cleanup of it -- for tests that want to inspect
 *   the carrying worktree afterward.
 * @returns {{ carried: true, diffstat: string } | { carried: false, reason: string, diffstat?: string }}
 */
export function carryBranch(repoRoot, branch, { run = defaultRun, workDir, stamp = stampWorktree } = {}) {
  const dir = workDir ?? realpathSync(mkdtempSync(join(tmpdir(), "carry-branch-")));
  try {
    try {
      run("git", ["worktree", "add", "--detach", dir, `origin/${branch}`], { cwd: repoRoot });
    } catch (error) {
      return { carried: false,
        reason: `could not open a detached checkout of origin/${branch} -- ${errMsg(error)}` };
    }
    // #1128: STAMP IT, because the cleanup below is best-effort and a carry tree that survives a failed
    // removal is precisely an unowned tree somebody else finds later. `/private/tmp/carry-742` is one
    // today. Never fatal: a carry that failed because a stamp failed would be answering a question
    // nobody asked, and the stamp is advisory by design.
    try {
      stamp(dir, process.env.A11Y_SESSION ?? "row-carry");
    } catch (error) {
      process.stderr.write(`carry-branch: could not stamp ${dir} -- ${errMsg(error)}\n`);
    }
    try {
      run("git", ["fetch", "origin", "main"], { cwd: dir });
    } catch (error) {
      return { carried: false, reason: `could not fetch origin/main -- ${errMsg(error)}` };
    }
    const beforeTip = run("git", ["rev-parse", "HEAD"], { cwd: dir }).trim();
    try {
      // Identity PER COMMAND, never `git config` -- the same discipline `test-support/git-sandbox.ts`
      // documents at length for the identical reason: a config WRITE lands wherever GIT_DIR currently
      // resolves to, and a per-command `-c` cannot write config anywhere by construction.
      run("git", ["-c", "user.name=row-carry", "-c", "user.email=row-carry@a11y-witness.invalid",
        "merge", "origin/main", "--no-edit"], { cwd: dir });
    } catch (error) {
      return { carried: false, reason: `merge failed -- ${errMsg(error)}` };
    }
    const diffstat = run("git", ["diff", "--stat", `${beforeTip}..HEAD`], { cwd: dir });
    try {
      run("git", ["push", "origin", `HEAD:refs/heads/${branch}`], { cwd: dir });
    } catch (error) {
      return { carried: false, diffstat,
        reason: `push refused -- this is the ref-lock working as intended: the branch moved under this `
          + `carry, so the owner's own push (or another carry) won the race. Read it, never force past `
          + `it. ${errMsg(error)}` };
    }
    return { carried: true, diffstat };
  } finally {
    if (!workDir) {
      try {
        run("git", ["worktree", "remove", "--force", dir], { cwd: repoRoot });
      } catch {
        // Best-effort cleanup of a throwaway detached worktree -- nothing of value survives only in it,
        // since a successful carry has already pushed everything that mattered.
      }
    }
  }
}

/**
 * Finds the open PR for `branch` and leaves a comment naming who carried it and why -- #656's own stated
 * point: the owner learns from the OBJECT (the PR), not only from a message that may go unread or arrive
 * to a session that has since ended.
 *
 * @param {string} branch
 * @param {string} carrier this session's own name
 * @param {string} reason why the carry happened -- the escalation window, named
 * @param {{ run?: typeof defaultRun }} [deps]
 * @returns {{ commented: true, prNumber: number } | { commented: false, reason: string }}
 */
export function noteCarryOnPr(branch, carrier, reason, { run = defaultRun } = {}) {
  /** @type {unknown} */
  let found;
  try {
    found = JSON.parse(run("gh", ["pr", "list", "--repo", REPO, "--head", branch, "--state", "open",
      "--json", "number"]));
  } catch (error) {
    return { commented: false, reason: `could not look up the open PR for ${branch} -- ${errMsg(error)}` };
  }
  if (!Array.isArray(found) || found.length === 0) {
    return { commented: false, reason: `no open PR found for ${branch} -- nothing to comment on` };
  }
  const prNumber = /** @type {{ number: number }} */ (found[0]).number;
  try {
    run("gh", ["pr", "comment", String(prNumber), "--repo", REPO, "--body",
      `Carried by \`${carrier}\` from a detached checkout: ${reason}`]);
  } catch (error) {
    // #1477: GUARDED, BECAUSE THIS RUNS AFTER THE PUSH LANDED. Unguarded, its throw escaped `main` and Node
    // exited 1, which this script's header defines as NOT CARRIED. Reported, never thrown, like the lookup above.
    return { commented: false,
      reason: `found PR #${prNumber} for ${branch}, but could not post the note on it -- ${errMsg(error)}` };
  }
  return { commented: true, prNumber };
}

function usage() {
  return "Usage:\n"
    + "  node packages/agent-org/src/carry-branch.mjs <branch> --carrier=<session> --reason=<text> [--repo-root=<dir>]\n";
}

/** @param {string} text */
const writeOut = (text) => { process.stdout.write(text); };
/** @param {string} text */
const writeErr = (text) => { process.stderr.write(text); };

/**
 * The carry's arguments, or `null` when the usage is not met.
 * @param {string[]} argv
 * @returns {{ branch: string, carrier: string, reason: string, repoRoot: string | undefined } | null}
 */
function carryArgs(argv) {
  const flag = (/** @type {string} */ name) => {
    const prefix = `--${name}=`;
    return argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
  };
  const [branch] = argv;
  const carrier = flag("carrier");
  const reason = flag("reason");
  if (!branch || branch.startsWith("--") || !carrier || !reason) return null;
  return { branch, carrier, reason, repoRoot: flag("repo-root") };
}

/**
 * #1477: THE CLI'S WHOLE DECISION, returning its exit code instead of setting `process.exitCode`, so a test
 * drives the real entry path with an injected `run`. `main` below only guards the flags, reads argv and
 * applies the code. See this file's header, and `EXIT`, for what each code means.
 * @param {string[]} argv the arguments after the script's own path
 * @param {{ run?: typeof defaultRun, stamp?: typeof stampWorktree, workDir?: string, cwd?: string,
 *   out?: (text: string) => void, err?: (text: string) => void }} [deps]
 * @returns {number}
 */
export function carryMain(argv, { run = defaultRun, stamp = stampWorktree, workDir, cwd = process.cwd(),
  out = writeOut, err = writeErr } = {}) {
  const args = carryArgs(argv);
  if (args === null) {
    err(usage());
    return EXIT.USAGE;
  }
  const { branch, carrier, reason, repoRoot } = args;
  const result = carryBranch(repoRoot ?? cwd, branch, { run, stamp, workDir });
  if (!result.carried) {
    err(`NOT CARRIED: ${result.reason}\n`);
    if (result.diffstat) err(`(the merge itself had already produced:\n${result.diffstat})\n`);
    return EXIT.NOT_CARRIED;
  }
  out(`CARRIED -- ${branch} merged with origin/main and pushed.\n${result.diffstat}\n`);
  const note = noteCarryOnPr(branch, carrier, reason, { run });
  if (note.commented) {
    out(`Noted on PR #${note.prNumber}.\n`);
    return EXIT.CARRIED;
  }
  err(`CARRIED, NOT NOTED (exit ${EXIT.CARRIED_NOT_NOTED}) -- ${branch} WAS pushed; no note was left on its PR: `
    + `${note.reason}\n`);
  return EXIT.CARRIED_NOT_NOTED;
}

function main() {
  refuseUnknownFlags(["--carrier=", "--reason=", "--repo-root="],
    { entry: import.meta.url, command: "node packages/agent-org/src/carry-branch.mjs" });
  process.exitCode = carryMain(process.argv.slice(2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}

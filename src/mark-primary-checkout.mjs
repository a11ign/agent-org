// command: mark or query whether this checkout is the fleet-driving primary, which the hooks read
// MARK THIS CHECKOUT AS THE FLEET-DRIVING ONE — the opt-in the hooks read.
//
//   node packages/agent-org/src/mark-primary-checkout.mjs           # is it marked?
//   node packages/agent-org/src/mark-primary-checkout.mjs --set     # mark it
//   node packages/agent-org/src/mark-primary-checkout.mjs --unset   # stop treating this checkout as the primary
//
// `pre-commit` and `post-checkout` guard the checkout the fleet is driven from: nothing may be committed
// there and it may only sit detached at `origin/main`, because `assertFleetRunsThisCheckout` hashes the
// working tree and every worktree's `node_modules` resolves through the primary's `dist`.
//
// Until #198 they identified it by `.git` being a directory, which is true of EVERY clone — so the hook
// travelled to the lab with a `git pull` and broke every `lab:job -e ref=<branch>`. The mark lives in
// `git config --local`, i.e. `.git/config`, which is **not cloned and not pulled**: that is the whole
// property, and it is why this is a command rather than a file in the tree.
//
// Setting it is a decision about ONE machine, so it is a deliberate act rather than something provisioning
// infers. `npm run doctor` reports an unmarked checkout, because "unmarked" and "safe" must not read the
// same — a guard nobody has switched on is the check-that-examined-nothing shape one layer down.
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "@a11ign/worker-fleet/cli-flags";
// GIT_* SCRUBBED, and it is load-bearing rather than ceremony HERE of all places. An inherited `GIT_DIR`
// -- exported by any hook that invoked us -- would point these `git config --local` calls at whatever
// repository that variable names, so a command whose entire job is "mark THIS checkout" would read, or
// SET, the mark on another one. That is the 2026-09-06 GIT_DIR leak aimed at the guard for it.
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";

const KEY = "a11y.primaryCheckout";

/** Whether this checkout carries the mark. Absent config is `false`, never an error. */
export function isMarked() {
  try {
    return execFileSync("git", ["config", "--local", "--get", KEY], { encoding: "utf8", env: sandboxGitEnv() }).trim() === "true";
  } catch {
    // `git config --get` exits 1 when the key is absent, which is the common case and not a failure.
    return false;
  }
}

/**
 * Whether this is a LINKED WORKTREE — where `.git` is a file (`gitdir: ...`) rather than a directory.
 *
 * A linked worktree SHARES `.git/config` with the repository it was created from, so `isMarked()` is true
 * in every worktree off a marked primary. Reporting "this checkout IS the primary" there would be wrong,
 * and it would disagree with the hooks, which require both conditions.
 *
 * Found by reading this command's own output in a worktree, after the full suite was green — the tests
 * pin the HOOK's decision and nothing compared this script's answer to it. Two spellings of one decision,
 * which is the fact-stated-twice shape in the command written to explain the decision.
 */
function isLinkedWorktree() {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"],
      { encoding: "utf8", env: sandboxGitEnv() }).trim();
    return !statSync(`${top}/.git`).isDirectory();
  } catch {
    return false;
  }
}

function main() {
  refuseUnknownFlags(["--set", "--unset"], { entry: import.meta.url, command: "mark-primary-checkout" });
  const set = process.argv.includes("--set");
  const unset = process.argv.includes("--unset");
  if (set && unset) {
    process.stderr.write("mark-primary-checkout: --set and --unset together say nothing. Pick one.\n");
    process.exit(2);
  }
  if (set) execFileSync("git", ["config", "--local", KEY, "true"], { env: sandboxGitEnv() });
  // `--unset` on an absent key exits 5; that is "already not marked", which is the state being asked for.
  if (unset) try { execFileSync("git", ["config", "--local", "--unset", KEY], { env: sandboxGitEnv() }); } catch { /* already unset */ }

  // BOTH conditions, exactly as `lib/is-primary-checkout.sh` requires them. A worktree inherits the mark
  // through the shared `.git/config` and is still not the primary.
  const linked = isLinkedWorktree();
  const marked = isMarked() && !linked;
  if (linked) {
    process.stdout.write("This is a LINKED WORKTREE, so it is never the primary — even though it shares\n"
      + "  `.git/config` with the checkout it was created from and inherits the mark from there.\n"
      + "  The hooks require BOTH the mark and a real `.git` directory, and so does this.\n");
    return;
  }
  process.stdout.write(marked
    ? `This checkout IS marked as the primary (${KEY}=true).\n`
      + "  `pre-commit` refuses commits here and `post-checkout` keeps it detached at origin/main.\n"
    : `This checkout is NOT marked as the primary (${KEY} unset).\n`
      + "  The primary-checkout guards are INERT here. That is correct for a worktree, the lab, a worker\n"
      + "  or a colleague's clone — and wrong for the machine that drives the fleet.\n"
      + "  Mark it with:  npm run primary:mark -- --set\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();

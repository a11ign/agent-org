// no-token: gh -- real git, in repositories this file builds in its own temporary directories; nothing reaches a network remote
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { defaultGit, type Git } from "./worktree.ts";
import { afterRebase, parseRemoteHead, protectStack, rebaseDue, rebaseOnto, readStackBase, releaseStack, remoteHead, roundHeldBy, stackBaseIn, stackRef, writeStackBase } from "./stack-rebase.ts";

/** Real git with every `GIT_*` scrubbed, synchronous for the test's own setup. */
const gitSync = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: sandboxGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"];
const commit = (cwd: string, file: string, text: string, message: string) => {
  writeFileSync(join(cwd, file), text);
  gitSync(cwd, ["add", file]);
  gitSync(cwd, [...IDENTITY, "commit", "-q", "-m", message]);
  return gitSync(cwd, ["rev-parse", "HEAD"]);
};

/**
 * A bare origin with `main` and a blocker's branch, and a clone of it with a worker's worktree on the ticket's own branch, made from the blocker's branch the
 * way `ticket:worktree --from` makes it. Returns each path, and the commit the worktree was branched at.
 */
function stackedWorktree() {
  const root = tmpDir("stack-rebase-");
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  gitSync(root, ["init", "-q", "--bare", "-b", "main", origin]);
  gitSync(root, ["init", "-q", "-b", "main", seed]);
  commit(seed, "base.txt", "base\n", "base");
  gitSync(seed, ["remote", "add", "origin", origin]);
  gitSync(seed, ["push", "-q", "origin", "main"]);
  gitSync(seed, ["checkout", "-q", "-b", "blocker"]);
  commit(seed, "blocker.txt", "one\n", "blocker: first");
  gitSync(seed, ["push", "-q", "origin", "blocker"]);
  const clone = join(root, "clone");
  gitSync(root, ["clone", "-q", origin, clone]);
  const worktree = join(root, "worktree");
  gitSync(clone, ["worktree", "add", "-q", "-b", "ticket", worktree, "origin/blocker"]);
  const sha = gitSync(clone, ["rev-parse", "origin/blocker"]);
  commit(worktree, "ticket.txt", "ticket\n", "ticket: its work");
  gitSync(worktree, ["push", "-q", "origin", "HEAD:ticket"]);
  return { root, origin, seed, clone, worktree, base: { branch: "blocker", sha } };
}

test("A11-116: a remote head is the sha of its exact branch, and no pushed branch names none", () => {
  const sha = "a".repeat(40);
  assert.equal(parseRemoteHead(`${sha}\trefs/heads/nbf-1-fit\n`, "nbf-1-fit"), sha);
  assert.equal(parseRemoteHead("", "nbf-1-fit"), null, "not pushed: nothing is listed");
  assert.equal(parseRemoteHead(`${sha}\trefs/heads/other\n`, "nbf-1-fit"), null, "another branch is not this one");
  assert.equal(parseRemoteHead("not a sha\trefs/heads/nbf-1-fit\n", "nbf-1-fit"), null, "a line that is no commit is no head");
});

test("A11-116: a stacked run is rebased when its blocker's branch is at another head, and not when it is at the one it was branched from", () => {
  const sha = "1".repeat(40);
  const moved = "2".repeat(40);
  assert.equal(rebaseDue({ sha }, sha), false, "the branch has not moved");
  assert.equal(rebaseDue({ sha }, null), false, "a branch not pushed has nothing to rebase onto");
  assert.equal(rebaseDue({ sha }, moved), true, "a grown or rewritten branch is due");
  assert.equal(rebaseDue({ sha, failed: { head: moved, reason: "conflicted in a.ts" } }, moved), false, "a failure against this head is not retried");
  assert.equal(rebaseDue({ sha, failed: { head: moved, reason: "conflicted in a.ts" } }, "3".repeat(40)), true, "a new head is tried again");
});

test("A11-116: the record of a stacked branch is written by ticket:worktree and read back, and anything else reads as none", () => {
  const dir = tmpDir("stack-base-file-");
  const path = join(dir, "tickets", "NBF-1", "stack-base.json");
  assert.equal(readStackBase(path), null, "no file, no base");
  writeStackBase(path, { repo: "agent-org", branch: "nbf-1-fit", sha: "b".repeat(40) });
  assert.deepEqual(readStackBase(path), { repo: "agent-org", branch: "nbf-1-fit", sha: "b".repeat(40) });
  writeFileSync(path, "{\"repo\": 3}");
  assert.equal(readStackBase(path), null, "a record of the wrong shape is none");
  writeFileSync(path, "not json");
  assert.equal(readStackBase(path), null, "a file that is not JSON is none");
});

test("A11-116: a review round is held, with its conflict named, while its rebase onto the head it is at has failed, and not once the branch moved on", () => {
  const record = { key: "NBF-1", repo: "agent-org", branch: "nbf-1-fit", sha: "1".repeat(40), failed: { head: "2".repeat(40), reason: "conflicted in a.ts" } };
  assert.equal(roundHeldBy(record, "2".repeat(40)), "Rebase onto NBF-1 conflicted in a.ts: a person resolves it", "the round would start on a base that conflicts");
  assert.equal(roundHeldBy(record, "3".repeat(40)), null, "a new head is tried again before any round");
  assert.equal(roundHeldBy({ ...record, failed: undefined }, "2".repeat(40)), null, "a run with no failure is not held");
});

test("A11-116: a rebase reads the stacked branch the queue holds now, falling back to the one it started from", () => {
  const started = { key: "NBF-1", repo: "agent-org", branch: "nbf-1-fit", sha: "1".repeat(40) };
  const queue = { entries: [{ ticket: { key: "NBF-2" }, phase: "finished", stackBase: { ...started, seen: "2".repeat(40) } }] } as never;
  assert.equal(stackBaseIn(queue, "NBF-2", started).seen, "2".repeat(40), "what the queue holds, not a copy from before");
  assert.equal(stackBaseIn(queue, "NBF-9", started), started, "a run the queue does not hold keeps the one it had");
});

test("A11-116: the base a stacked run keeps reachable is named by its run and its blocker", () => {
  assert.equal(stackRef("NBF-9", "NBF-1"), "refs/agent-org/stack/NBF-9/NBF-1");
});

test("A11-116: a rebase onto a grown blocker's branch moves the run onto its new head, and pushes only the run's own branch", async () => {
  const { origin, seed, clone, worktree, base } = stackedWorktree();
  commit(seed, "blocker.txt", "one\ntwo\n", "blocker: review fix");
  gitSync(seed, ["push", "-q", "origin", "blocker"]);
  const head = gitSync(seed, ["rev-parse", "HEAD"]);
  const result = await rebaseOnto({ git: defaultGit, clone, worktree, own: "ticket", base });
  assert.deepEqual(result, { ok: true, from: base.sha, to: head });
  assert.equal(gitSync(worktree, ["rev-parse", "HEAD~1"]), head, "the run's commit now sits on the blocker's new head");
  assert.equal(gitSync(origin, ["rev-parse", "refs/heads/ticket"]), gitSync(worktree, ["rev-parse", "HEAD"]), "the lease pushed the rebased branch");
  assert.equal(gitSync(origin, ["rev-parse", "refs/heads/blocker"]), head, "the blocker's branch is untouched by the run");
});

test("A11-116: a rebase onto a force-pushed blocker branch replays from the commit the run was branched at, so no blocker commit is repeated", async () => {
  const { origin, seed, clone, worktree, base } = stackedWorktree();
  // The blocker is rewritten: a commit it had is amended away, and the branch force-pushed.
  gitSync(seed, ["reset", "-q", "--hard", "HEAD~1"]);
  commit(seed, "blocker.txt", "rewritten\n", "blocker: rewritten first");
  gitSync(seed, ["push", "-q", "--force", "origin", "blocker"]);
  const head = gitSync(seed, ["rev-parse", "HEAD"]);
  const result = await rebaseOnto({ git: defaultGit, clone, worktree, own: "ticket", base });
  assert.equal(result.ok, true);
  const log = gitSync(worktree, ["log", "--format=%s", `${head}..HEAD`]).split("\n");
  assert.deepEqual(log, ["ticket: its work"], "only the run's own commit sits on the rewritten head");
  assert.equal(gitSync(worktree, ["log", "--format=%s", "origin/main..HEAD"]).includes("blocker: first"), false, "the blocker's old commit is not replayed");
  assert.equal(gitSync(origin, ["rev-parse", "refs/heads/ticket"]), gitSync(worktree, ["rev-parse", "HEAD"]));
});

test("A11-116: a rebase that conflicts is aborted, names the files, and leaves the run's branch as it was", async () => {
  const { seed, clone, worktree, base } = stackedWorktree();
  commit(worktree, "blocker.txt", "ours\n", "ticket: edits the blocker's file");
  gitSync(worktree, ["push", "-q", "origin", "HEAD:ticket"]);
  const before = gitSync(worktree, ["rev-parse", "HEAD"]);
  commit(seed, "blocker.txt", "theirs\n", "blocker: edits the same line");
  gitSync(seed, ["push", "-q", "origin", "blocker"]);
  const result = await rebaseOnto({ git: defaultGit, clone, worktree, own: "ticket", base });
  assert.deepEqual(result, { ok: false, reason: "conflicted in blocker.txt", conflict: true });
  assert.equal(gitSync(worktree, ["rev-parse", "HEAD"]), before, "the branch is untouched");
  assert.equal(gitSync(worktree, ["status", "--porcelain"]), "", "no rebase is left in progress");
});

test("A11-116: a push the remote refuses puts the run's branch back where it was before the rebase", async () => {
  const { origin, seed, clone, worktree, base } = stackedWorktree();
  commit(seed, "blocker.txt", "one\ntwo\n", "blocker: review fix");
  gitSync(seed, ["push", "-q", "origin", "blocker"]);
  mkdirSync(join(origin, "hooks"), { recursive: true });
  writeFileSync(join(origin, "hooks", "pre-receive"), "#!/bin/sh\necho refused by the test >&2\nexit 1\n", { mode: 0o755 });
  const before = gitSync(worktree, ["rev-parse", "HEAD"]);
  const result = await rebaseOnto({ git: defaultGit, clone, worktree, own: "ticket", base });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /^was refused by the remote: /);
  assert.equal(gitSync(worktree, ["rev-parse", "HEAD"]), before, "the branch is put back where it was");
});

test("A11-116: the record after a rebase keeps the rebase for the board, and after a failure keeps the branch and the head it failed against", () => {
  const record = { key: "NBF-1", repo: "agent-org", branch: "nbf-1-fit", sha: "1".repeat(40), seen: "2".repeat(40) };
  const done = afterRebase(record, "2".repeat(40), { ok: true, from: "1".repeat(40), to: "2".repeat(40) }, 7);
  assert.deepEqual(done, { key: "NBF-1", repo: "agent-org", branch: "nbf-1-fit", sha: "2".repeat(40), rebased: { from: "1".repeat(40), to: "2".repeat(40), at: 7 } },
    "branched from the new head now, and nothing is left seen or failed");
  const failed = afterRebase(record, "2".repeat(40), { ok: false, reason: "conflicted in a.ts", conflict: true }, 7);
  assert.deepEqual(failed, { ...record, failed: { head: "2".repeat(40), reason: "conflicted in a.ts" } }, "still branched from the old commit, failed against the new head");
  const refused = afterRebase(record, "2".repeat(40), { ok: false, reason: "was refused by the remote: x" }, 7);
  assert.deepEqual(refused, { ...record, seen: "2".repeat(40) }, "a failure that is not a conflict is not sticky: the next sweep tries again");
});

test("A11-116: a stacked branch is read from its remote, and its base is kept reachable and released with its run", async () => {
  const { origin, clone, base } = stackedWorktree();
  assert.equal(await remoteHead(defaultGit, clone, base.branch), gitSync(origin, ["rev-parse", "refs/heads/blocker"]));
  assert.equal(await remoteHead(defaultGit, clone, "not-pushed"), null);
  const ref = stackRef("NBF-9", "NBF-1");
  await protectStack(defaultGit, clone, ref, base.sha);
  assert.equal(gitSync(clone, ["rev-parse", ref]), base.sha, "the base commit is kept reachable in the clone");
  await releaseStack(defaultGit, clone, ref);
  assert.equal(gitSync(clone, ["for-each-ref", ref]), "", "and released once its run is settled");
});

test("A11-116: a git that cannot run is an error the sweep reports, not a head", async () => {
  const failing: Git = async () => { throw new Error("fatal: not a repository"); };
  await assert.rejects(remoteHead(failing, "/nowhere", "blocker"), /not a repository/);
});

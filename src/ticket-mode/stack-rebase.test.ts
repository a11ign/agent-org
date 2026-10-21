// no-token: gh -- real git, in repositories this file builds in its own temporary directories; nothing reaches a network remote
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { defaultGit, type Git } from "./worktree.ts";
import { afterConflictCleared, afterMerge, conflictFeedback, mergedIn, mergeBaseIn, mergeDue, parseRemoteHead, protectStack, readStackBase, releaseStack, remoteHead, stackBaseIn, stackRef, writeStackBase } from "./stack-rebase.ts";
import { conflictsIn } from "./worker-files.ts";

/** Real git with every `GIT_*` scrubbed, synchronous for the test's own setup. */
const gitSync = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: sandboxGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"];
const commit = (cwd: string, file: string, text: string, message: string) => {
  writeFileSync(join(cwd, file), text);
  gitSync(cwd, ["add", file]);
  gitSync(cwd, [...IDENTITY, "commit", "-q", "-m", message]);
  return gitSync(cwd, ["rev-parse", "HEAD"]);
};

/** The blocker's branch moves: `text` is committed to its `blocker.txt` on `seed`, and pushed. Returns the new head. */
const moveBlocker = (seed: string, text: string) => {
  const head = commit(seed, "blocker.txt", text, "blocker: review fix");
  gitSync(seed, ["push", "-q", "origin", "blocker"]);
  return head;
};

/**
 * The run's own edit to `blocker.txt`, pushed, and the blocker's edit to the same line after it: a merge of the blocker's branch into the run conflicts.
 * Returns the blocker's head.
 */
const conflictingEdits = (worktree: string, seed: string) => {
  commit(worktree, "blocker.txt", "ours\n", "ticket: edits the blocker's file");
  gitSync(worktree, ["push", "-q", "origin", "HEAD:ticket"]);
  return moveBlocker(seed, "theirs\n");
};

/**
 * A bare origin with `main` and a blocker's branch, and a clone of it with a worker's worktree on the ticket's own branch, made from the blocker's branch the
 * way `ticket:worktree --from` makes it. Returns each path, and the commit the worktree was branched at.
 */
function stackedWorktree() {
  const root = tmpDir("stack-merge-");
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

test("A11-150: a stacked run is merged when its blocker's branch is at another head, and not when it is at the one it has merged in, or the one a merge conflicted against", () => {
  const sha = "1".repeat(40);
  const moved = "2".repeat(40);
  assert.equal(mergeDue({ sha }, sha), false, "the branch has not moved");
  assert.equal(mergeDue({ sha }, null), false, "a branch not pushed has nothing to merge");
  assert.equal(mergeDue({ sha }, moved), true, "a grown or rewritten branch is due");
  assert.equal(mergeDue({ sha, conflict: { head: moved, files: ["a.ts"] } }, moved), false, "a conflict against this head is not merged again");
  assert.equal(mergeDue({ sha, conflict: { head: moved, files: ["a.ts"] } }, "3".repeat(40)), true, "a new head is merged");
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

test("A11-116: a rebase reads the stacked branch the queue holds now, falling back to the one it started from", () => {
  const started = { key: "NBF-1", repo: "agent-org", branch: "nbf-1-fit", sha: "1".repeat(40) };
  const queue = { entries: [{ ticket: { key: "NBF-2" }, phase: "finished", stackBase: { ...started, seen: "2".repeat(40) } }] } as never;
  assert.equal(stackBaseIn(queue, "NBF-2", started).seen, "2".repeat(40), "what the queue holds, not a copy from before");
  assert.equal(stackBaseIn(queue, "NBF-9", started), started, "a run the queue does not hold keeps the one it had");
});

test("A11-116: the base a stacked run keeps reachable is named by its run and its blocker", () => {
  assert.equal(stackRef("NBF-9", "NBF-1"), "refs/agent-org/stack/NBF-9/NBF-1");
});

test("A11-150: a blocker's branch that moved is merged into the run's branch and pushed plainly: the run's own commit stays, and the blocker's new head is its second parent", async () => {
  const { origin, seed, worktree, base } = stackedWorktree();
  const ticketBefore = gitSync(worktree, ["rev-parse", "HEAD"]);
  const head = moveBlocker(seed, "one\ntwo\n");
  const result = await mergeBaseIn({ git: defaultGit, worktree, own: "ticket", base });
  assert.deepEqual(result, { ok: true, from: base.sha, to: head, moved: true, pushed: { from: ticketBefore, to: gitSync(origin, ["rev-parse", "refs/heads/ticket"]) } },
    "A11-153: the merge says which commit the run's branch moved from and to, as the remote now holds it");
  assert.equal(gitSync(worktree, ["rev-parse", "HEAD^1"]), ticketBefore, "the run's own commit is the first parent");
  assert.equal(gitSync(worktree, ["rev-parse", "HEAD^2"]), head, "the blocker's new head is merged in");
  assert.equal(gitSync(origin, ["rev-parse", "refs/heads/ticket"]), gitSync(worktree, ["rev-parse", "HEAD"]), "the run's own branch is pushed");
  assert.equal(gitSync(origin, ["rev-parse", "refs/heads/blocker"]), head, "the blocker's branch is untouched by the run");
});

test("A11-150: a blocker's branch the run already has merges to nothing, and nothing is pushed", async () => {
  const { origin, worktree, base } = stackedWorktree();
  const before = gitSync(worktree, ["rev-parse", "HEAD"]);
  const result = await mergeBaseIn({ git: defaultGit, worktree, own: "ticket", base });
  assert.deepEqual(result, { ok: true, from: base.sha, to: base.sha, moved: false });
  assert.equal(gitSync(worktree, ["rev-parse", "HEAD"]), before, "no merge commit is made");
  assert.equal(gitSync(origin, ["rev-parse", "refs/heads/ticket"]), before, "and nothing is pushed");
});

test("A11-150: a merge that conflicts is aborted, names its files, and leaves the run's branch as it was", async () => {
  const { seed, worktree, base } = stackedWorktree();
  conflictingEdits(worktree, seed);
  const before = gitSync(worktree, ["rev-parse", "HEAD"]);
  const result = await mergeBaseIn({ git: defaultGit, worktree, own: "ticket", base });
  assert.deepEqual(result, { ok: false, reason: "conflicted in blocker.txt", conflict: ["blocker.txt"] });
  assert.equal(gitSync(worktree, ["rev-parse", "HEAD"]), before, "the branch is untouched");
  assert.equal(gitSync(worktree, ["status", "--porcelain"]), "", "no merge is left in progress");
});

test("A11-150: a push the remote refuses puts the run's branch back where it was before the merge", async () => {
  const { origin, seed, worktree, base } = stackedWorktree();
  moveBlocker(seed, "one\ntwo\n");
  mkdirSync(join(origin, "hooks"), { recursive: true });
  writeFileSync(join(origin, "hooks", "pre-receive"), "#!/bin/sh\necho refused by the test >&2\nexit 1\n", { mode: 0o755 });
  const before = gitSync(worktree, ["rev-parse", "HEAD"]);
  const result = await mergeBaseIn({ git: defaultGit, worktree, own: "ticket", base });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /^was refused by the remote: /);
  assert.equal(gitSync(worktree, ["rev-parse", "HEAD"]), before, "the branch is put back where it was");
});

test("A11-150: a run's branch that the remote moved on is never overwritten: the push is refused and the other commit stays", async () => {
  const { root, origin, seed, worktree, base } = stackedWorktree();
  // Someone else pushes to the run's branch from another clone, after the worktree was made.
  const other = join(root, "other");
  gitSync(root, ["clone", "-q", origin, other]);
  gitSync(other, ["checkout", "-q", "-b", "ticket", "origin/ticket"]);
  const otherHead = commit(other, "other.txt", "elsewhere\n", "ticket: pushed from elsewhere");
  gitSync(other, ["push", "-q", "origin", "HEAD:ticket"]);
  moveBlocker(seed, "one\ntwo\n");
  const before = gitSync(worktree, ["rev-parse", "HEAD"]);
  const result = await mergeBaseIn({ git: defaultGit, worktree, own: "ticket", base });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /^was refused by the remote: /, "a plain push is not a forced one");
  assert.equal(gitSync(origin, ["rev-parse", "refs/heads/ticket"]), otherHead, "the other commit is still the branch's head");
  assert.equal(gitSync(worktree, ["rev-parse", "HEAD"]), before, "and the run's merge is put back");
});

test("A11-150: the record after a merge keeps the merge for the board; a conflict is recorded against its head, and a failure keeps the branch to be tried again", () => {
  const record = { key: "NBF-1", repo: "agent-org", branch: "nbf-1-fit", sha: "1".repeat(40), seen: "2".repeat(40) };
  const done = afterMerge(record, "2".repeat(40), { ok: true, from: "1".repeat(40), to: "2".repeat(40), moved: true }, 7);
  assert.deepEqual(done, { key: "NBF-1", repo: "agent-org", branch: "nbf-1-fit", sha: "2".repeat(40), merged: { from: "1".repeat(40), to: "2".repeat(40), at: 7 } },
    "branched from the new head now, and nothing is left seen");
  const conflicted = afterMerge(record, "2".repeat(40), { ok: false, reason: "conflicted in src/a.ts", conflict: ["src/a.ts"] }, 7);
  assert.deepEqual(conflicted, { ...record, conflict: { head: "2".repeat(40), files: ["src/a.ts"] } }, "still at the old commit, conflicted against the new head");
  const capped = afterMerge(record, "2".repeat(40), { ok: false, reason: "conflicted in src/a.ts", conflict: ["src/a.ts"] }, 7, 3);
  assert.deepEqual(capped.conflict, { head: "2".repeat(40), files: ["src/a.ts"], capped: 3 }, "the cap the board reached is kept with it");
  const refused = afterMerge(record, "2".repeat(40), { ok: false, reason: "was refused by the remote: x" }, 7);
  assert.deepEqual(refused, { ...record, seen: "2".repeat(40) }, "a failure that is not a conflict is not sticky: the next sweep tries again");
});

test("A11-150: a record a rebase wrote is read as a merge: its failed head is merged once more, and the record is written as a merge after", () => {
  const legacy = { key: "NBF-1", repo: "agent-org", branch: "nbf-1-fit", sha: "1".repeat(40), seen: "2".repeat(40), rebased: { from: "0".repeat(40), to: "1".repeat(40), at: 3 },
    failed: { head: "2".repeat(40), reason: "conflicted in a.ts" } };
  assert.equal(mergeDue(legacy, "2".repeat(40)), true, "a failure is not a conflict, so the head it failed against is merged again");
  const done = afterMerge(legacy, "2".repeat(40), { ok: true, from: "1".repeat(40), to: "2".repeat(40), moved: true }, 7);
  assert.deepEqual(done, { key: "NBF-1", repo: "agent-org", branch: "nbf-1-fit", sha: "2".repeat(40), merged: { from: "1".repeat(40), to: "2".repeat(40), at: 7 } },
    "the rebase and its failure are dropped");
});

test("A11-150: a conflicting merge's round is started with a conflict line for each pull request, which the round reads as a conflict, and the blocker and its files", () => {
  const feedback = conflictFeedback(["https://github.com/x/r/pull/1"], { key: "NBF-1", branch: "nbf-1-fit" }, ["src/install/doctor.ts"]);
  assert.equal(feedback, "https://github.com/x/r/pull/1 conflicts with its base branch nbf-1-fit.\nMerging NBF-1's branch `nbf-1-fit` conflicted in src/install/doctor.ts.");
  assert.equal(conflictsIn(feedback), "https://github.com/x/r/pull/1 conflicts with its base branch nbf-1-fit.", "the round names its conflict as one");
});

test("A11-150: a conflict a worker's round resolved by hand is cleared once its head is in the run's branch, and not before", async () => {
  const { seed, worktree, base } = stackedWorktree();
  const head = conflictingEdits(worktree, seed);
  const record = { key: "NBF-1", repo: "agent-org", branch: "blocker", sha: base.sha, conflict: { head, files: ["blocker.txt"] } };
  assert.equal((await mergeBaseIn({ git: defaultGit, worktree, own: "ticket", base })).ok, false);
  assert.equal(await mergedIn({ git: defaultGit, worktree, base, head }), false, "the head is not in the branch yet");
  // The worker's round merges the base in itself, keeps both changes, and pushes.
  assert.throws(() => gitSync(worktree, [...IDENTITY, "merge", "--no-edit", "origin/blocker"]), "its own merge conflicts too");
  writeFileSync(join(worktree, "blocker.txt"), "both\n");
  gitSync(worktree, ["add", "blocker.txt"]);
  gitSync(worktree, [...IDENTITY, "commit", "-q", "--no-edit"]);
  gitSync(worktree, ["push", "-q", "origin", "HEAD:ticket"]);
  assert.equal(await mergedIn({ git: defaultGit, worktree, base, head }), true, "the head is in the branch now");
  assert.deepEqual(afterConflictCleared(record), { key: "NBF-1", repo: "agent-org", branch: "blocker", sha: head }, "branched from that head, and no conflict is named");
});

test("A11-150: a merge with no git identity of its own is committed as the run's own last commit was", async () => {
  const { seed, worktree, base } = stackedWorktree();
  moveBlocker(seed, "one\ntwo\n");
  // No global identity and no system config: the machine a CI runner or the instance's service may be.
  const home = tmpDir("stack-merge-no-identity-");
  const bare: Git = async (cwd, args) => execFileSync("git", args, {
    cwd, env: sandboxGitEnv({ HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const result = await mergeBaseIn({ git: bare, worktree, own: "ticket", base });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(gitSync(worktree, ["log", "-1", "--format=%cn", "HEAD"]), "t", "the merge commit keeps the committer of the run's own commit");
  assert.equal(gitSync(worktree, ["log", "-1", "--format=%ce", "HEAD"]), "t@example.invalid", "and its email");
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

test("A11-150: no source says a person resolves a stacked branch's conflict", () => {
  // The phrase is built from parts, so this file does not match its own search.
  const phrase = ["a person", "resolves it"].join(" ");
  const src = fileURLToPath(new URL("../", import.meta.url));
  assert.equal(spawnSync("grep", ["-rl", phrase, src], { encoding: "utf8" }).stdout, "", "no file under src/ says it");
});

test("A11-116: a git that cannot run is an error the sweep reports, not a head", async () => {
  const failing: Git = async () => { throw new Error("fatal: not a repository"); };
  await assert.rejects(remoteHead(failing, "/nowhere", "blocker"), /not a repository/);
});

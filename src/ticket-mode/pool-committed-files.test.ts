// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holderClaimOf } from "./board-view/overlap-hold.ts";
import type { PoolContext } from "./pool-context.ts";
import { readCommittedFiles, takeWorktreesToRead } from "./pool-overlap.ts";
import { enqueue } from "./queue/queue-entries-and-outcomes.ts";
import { recordCommittedFiles } from "./queue/queue-overlap-stack.ts";
import { markRunning, markStarting, resumeQueue } from "./queue/queue-transitions.ts";
import { emptyQueue } from "./queue.ts";
import type { Ticket } from "./source.ts";
import { defaultGit } from "./worktree.ts";

const REPO = "agent-org";
const ticket = (key: string) => ({ key, title: key, description: "", url: "", branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });

/** A queue with A11-444 running (its repository known) beside A11-450 queued, and a context that reads worktrees under `root`. */
function setup(root: string) {
  const choice = { model: "opus", effort: "high" };
  let queue = resumeQueue(enqueue(emptyQueue(2), [ticket("A11-444"), ticket("A11-450")], choice, 1));
  queue = markRunning(markStarting(queue, "A11-444", 2), "A11-444", "w1", "w1:p1");
  queue = { ...queue, entries: queue.entries.map((entry) => ({ ...entry, projectRepo: REPO })) };
  let held = queue;
  const ctx = {
    store: { get: () => held, set: (next: typeof held) => { held = next; } },
    settings: { worktreeRoot: root, stateDir: join(root, "state"), clones: { [REPO]: join(root, "clone") }, planner: null },
    git: defaultGit, readMs: 10_000, now: () => 1_000_000, recordSaid: new Set<string>(),
  } as unknown as PoolContext;
  return { ctx, entry: (key: string) => held.entries.find((each) => each.ticket.key === key)! };
}

/** A worktree of A11-444 on `branch`, branched from `origin/main` of a bare remote, with `commit` run in it. */
function worktreeWith(root: string, commit: (worktree: string) => void): void {
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  git(root, "init", "--bare", "-b", "main", remote);
  mkdirSync(seed);
  git(seed, "init", "-b", "main");
  writeFileSync(join(seed, "README.md"), "x\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "init");
  git(seed, "push", remote, "main");
  const worktree = join(root, "A11-444", REPO);
  mkdirSync(join(root, "A11-444"));
  git(root, "clone", remote, worktree);
  git(worktree, "checkout", "-b", "a11-444");
  commit(worktree);
}

const inTemp = (body: (root: string) => Promise<void>) => async () => {
  const root = mkdtempSync(join(tmpdir(), "a11-452-"));
  try { await body(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

test("A11-452: the files a run's worktree committed beyond the default branch are recorded, and held in place of its repository", inTemp(async (root) => {
  worktreeWith(root, (worktree) => {
    mkdirSync(join(worktree, "src"));
    writeFileSync(join(worktree, "src", "a.ts"), "a\n");
    writeFileSync(join(worktree, "README.md"), "changed\n");
    git(worktree, "add", ".");
    git(worktree, "commit", "-m", "work");
  });
  const { ctx, entry } = setup(root);
  assert.deepEqual(takeWorktreesToRead(ctx).map((run) => run.ticket.key), ["A11-444"], "a run at work, with a run queued in its repository, is read");
  await readCommittedFiles(ctx, [entry("A11-444")]);
  assert.deepEqual([...entry("A11-444").committedFiles!].sort(), [`${REPO}:README.md`, `${REPO}:src/a.ts`]);
  assert.deepEqual(holderClaimOf(entry("A11-444") as never).repoWide, null);
}));

test("A11-452: a worktree with no commit records no file, so the run holds its whole repository", inTemp(async (root) => {
  worktreeWith(root, () => {});
  const { ctx, entry } = setup(root);
  await readCommittedFiles(ctx, [entry("A11-444")]);
  assert.equal(entry("A11-444").committedFiles, undefined);
  assert.equal(holderClaimOf(entry("A11-444") as never).repoWide, REPO);
}));

test("A11-452: a worktree that cannot be read clears what it held, says so once, and the run holds its whole repository", inTemp(async (root) => {
  const { ctx, entry } = setup(root);
  await readCommittedFiles(ctx, [entry("A11-444")]);
  assert.equal(entry("A11-444").committedFiles, undefined, "no worktree folder");
  mkdirSync(join(root, "A11-444", REPO, ".git"), { recursive: true });
  await readCommittedFiles(ctx, [entry("A11-444")]);
  assert.equal(entry("A11-444").committedFiles, undefined, "a .git that is no repository");
  assert.equal(holderClaimOf(entry("A11-444") as never).repoWide, REPO);
}));

test("A11-452: no worktree is read when no run is queued in its repository, and a run with a pull request is not read", inTemp(async (root) => {
  const { ctx } = setup(root);
  const alone = { ...ctx, store: { get: () => ({ ...ctx.store.get(), entries: ctx.store.get().entries.filter((each) => each.ticket.key === "A11-444") }), set: () => {} } } as unknown as PoolContext;
  assert.deepEqual(takeWorktreesToRead(alone), []);
}));

test("A11-452: a later read that finds no commit clears the files, and a list that has not changed is no write", () => {
  const { ctx, entry } = setup("/nowhere");
  const queue = ctx.store.get();
  const withFiles = recordCommittedFiles(queue, new Map([["A11-444", [`${REPO}:src/a.ts`]]]));
  assert.deepEqual(withFiles.entries.find((each) => each.ticket.key === "A11-444")?.committedFiles, [`${REPO}:src/a.ts`]);
  assert.equal(recordCommittedFiles(withFiles, new Map([["A11-444", [`${REPO}:src/a.ts`]]])).entries[0], withFiles.entries[0], "same list: the entry is untouched");
  assert.equal(recordCommittedFiles(withFiles, new Map([["A11-444", []]])).entries.find((each) => each.ticket.key === "A11-444")?.committedFiles, undefined);
  assert.equal(entry("A11-444").committedFiles, undefined);
});

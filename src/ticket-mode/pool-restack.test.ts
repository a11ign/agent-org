// no-token: gh -- the sweep over the fake code host: a stack world is seeded in memory, and the branch is brought up to date only through the fake's `updateBranch`
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost, fakePullUrl } from "../plugins/fakes/code-host.ts";
import type { CodeHost } from "../plugins/contracts/code-host.ts";
import type { Entry, Queue } from "./queue/queue-entries-and-outcomes.ts";
import type { PoolContext } from "./pool-context.ts";
import { rebaseStacked, retargetStacked } from "./pool-tracker.ts";
import { defaultGit } from "./worktree.ts";
import { retargetNote } from "./board-view/pull-status-and-notes.ts";

const REPOSITORY = "a11ign/agent-org";
const BOTTOM = fakePullUrl(REPOSITORY, 1);
const NEXT = fakePullUrl(REPOSITORY, 2);
const TOP = fakePullUrl(REPOSITORY, 3);
const BOTTOM_BRANCH = "a11-1-the-bottom-member";
const NEXT_BRANCH = "a11-2-the-next-member";
const NEXT_HEAD = "b".repeat(40);
const MOVED_HEAD = "c".repeat(40);

/** A finished run with `url` open, stacked on `blocker`'s branch. */
const stackedRun = (key: string, url: string, blocker: { key: string; branch: string }, over: Record<string, unknown> = {}): Entry => ({
  ticket: { key, branch: `${key.toLowerCase()}-work` }, phase: "finished", outcome: { kind: "reviewed", prs: [{ repo: "agent-org", url }] }, pullStates: { [url]: "open" },
  blockers: [{ key: blocker.key, state: "started", status: "In Review", branch: blocker.branch, pulls: {} }],
  stackBase: { key: blocker.key, repo: "agent-org", branch: blocker.branch, sha: "d".repeat(40) }, ...over,
}) as unknown as Entry;

/** The run of the bottom member, whose pull request merged. */
const bottomRun = (): Entry => ({ ticket: { key: "A11-1" }, phase: "finished", outcome: { kind: "reviewed", prs: [{ repo: "agent-org", url: BOTTOM }] }, pullStates: { [BOTTOM]: "merged" } }) as unknown as Entry;

/** The code host answers that each pull request conflicts with its base. */
const conflicting = (host: ReturnType<typeof createFakeCodeHost>, ...urls: string[]): void => {
  for (const url of urls) host.branchUpdates.answers.set(url, { kind: "conflict" });
};

/**
 * The fake stack of #1 (merged into `main`), #2 above it on #1's branch, and #3 above #2 on #2's branch, a queue with the runs of #1 and #2, and a clock a test moves. `ctx` is the part of the pool's context the sweep reads.
 */
function world(over: { entries?: (entries: Record<"bottom" | "next", Entry>) => Entry[]; codeHost?: (host: ReturnType<typeof createFakeCodeHost>) => CodeHost; next?: Record<string, unknown> } = {}) {
  const host = createFakeCodeHost();
  host.seedPull(REPOSITORY, 1, { head: BOTTOM_BRANCH, state: "merged" });
  host.seedPull(REPOSITORY, 2, { head: NEXT_BRANCH, base: BOTTOM_BRANCH, files: ["src/the-next-member.ts"] });
  host.seedPull(REPOSITORY, 3, { head: "a11-3-the-top-member", base: NEXT_BRANCH });
  host.pullAt(NEXT)!.head = NEXT_HEAD;
  const entries = { bottom: bottomRun(), next: stackedRun("A11-2", NEXT, { key: "A11-1", branch: BOTTOM_BRANCH }, over.next) };
  let queue: Queue = { entries: over.entries?.(entries) ?? [entries.bottom, entries.next] } as unknown as Queue;
  const ctx = {
    settings: { planner: null }, codeHost: over.codeHost?.(host) ?? host, store: { get: () => queue, set: (next: Queue) => { queue = next; } }, now: () => 1_000_000, stackMergeAsked: new Map(), restacked: new Map(), restackSaid: new Set<string>(), rebasing: new Set<string>(),
  } as unknown as PoolContext;
  const run = (key = "A11-2"): Entry => queue.entries.find((e) => e.ticket.key === key)!;
  const updates = () => host.branchUpdates.asked.map(({ url, expectedHead }) => `${url} ${expectedHead}`);
  return { host, ctx, run, queue: () => queue, updates, sweep: () => retargetStacked(ctx) };
}

test("A11-248: a merged bottom member makes the next one up be restacked once, and the card says so", async () => {
  const { host, sweep, run, updates } = world();
  await sweep();
  assert.equal(host.pullAt(NEXT)!.base, "main", "A11-106 moved its base to the default branch first");
  assert.deepEqual(updates(), [`${NEXT} ${NEXT_HEAD}`], "exactly one update, at the head that was read");
  assert.deepEqual(run().retargets, { [NEXT]: "#2 restacked on main after #1 merged" });
  assert.equal(retargetNote(run() as never), "#2 restacked on main after #1 merged", "and the card shows it");
  await sweep();
  host.pullAt(NEXT)!.head = MOVED_HEAD;
  await sweep();
  assert.equal(updates().length, 1, "a later sweep, and one after main and the branch moved, restack nothing more");
  assert.equal(run().retargets![NEXT], "#2 restacked on main after #1 merged", "and the note stays");
});

test("A11-248: a pull request is not restacked again after a restart that lost the board's memory, once its note says it was", async () => {
  const { sweep, updates, ctx } = world({ next: { retargets: { [NEXT]: "#2 restacked on main after #1 merged" } } });
  await sweep();
  assert.deepEqual(updates(), []);
  assert.deepEqual([...ctx.restacked], [[NEXT, { merged: BOTTOM, ownChangesAt: NEXT_HEAD }]], "no restack was made; the read of its files (it holds one of its own) is all the board remembers");
});

test("A11-248: a branch that already has the default branch is noted restacked, and is then handed to the arm bot as before", async () => {
  const { host, sweep, run, updates } = world();
  host.branchUpdates.answers.set(NEXT, { kind: "up-to-date" });
  host.stackMerges.facts.set(NEXT, { stacked: true });
  (host as unknown as { calls: string[] }).calls.length = 0;
  await sweep();
  assert.equal(updates().length, 1);
  assert.equal(run().retargets![NEXT], "#2 restacked on main after #1 merged");
});

test("A11-248: a branch the restack moved is not handed to the arm bot in the same pass, and the head the run ended at moves with it", async () => {
  const { host, sweep, run } = world({
    next: { pullHeads: { [NEXT]: { head: NEXT_HEAD, approved: true, review: "approved", red: [], pending: [] } }, outcomeHeads: { [NEXT]: NEXT_HEAD } },
    codeHost: (fake) => ({ ...fake, updateBranch: (url, head) => { fake.pullAt(url)!.head = MOVED_HEAD; return fake.updateBranch!(url, head); } }),
  });
  host.stackMerges.facts.set(NEXT, { stacked: true });
  await sweep();
  assert.deepEqual(host.stackMerges.requests, [], "its approval is of the old head");
  assert.deepEqual(run().outcomeHeads, { [NEXT]: MOVED_HEAD }, "agent-org's own push is not read as a person's answer");
});

test("A11-248: a conflict starts the run's conflict round, whose feedback names the stack and the merged member, and the card says so", async () => {
  const { host, sweep, run, queue } = world();
  conflicting(host, NEXT);
  await sweep();
  assert.deepEqual(host.branchUpdates.asked.length, 1);
  assert.equal(run().phase, "queued", "the run left finished for a round");
  assert.equal(run().rounds, 1);
  assert.equal(run().feedback, [
    `${NEXT} conflicts with its base branch main.`,
    `A11-2 is stacked on A11-1; its pull request #1 (${BOTTOM}) merged into \`main\`, and merging \`main\` into ${NEXT} conflicted.`,
  ].join("\n"));
  assert.equal(run().retargets, undefined, "a run in a round shows the round, and the round's own words carry the conflict");
  assert.equal(queue().entries.filter((e) => e.ticket.key === "A11-2").length, 1);
});

test("A11-248: a conflict at the round cap starts no round, and the note says Respond to review starts another", async () => {
  const { host, sweep, run } = world({ next: { rounds: 3 } });
  conflicting(host, NEXT);
  await sweep();
  assert.equal(run().phase, "finished");
  assert.equal(run().retargets![NEXT], "#2 conflicts with main after #1 merged, and the conflict rounds are used up: Respond to review starts another");
  await sweep();
  assert.equal(host.branchUpdates.asked.length, 1, "and the conflict is not asked about again");
});

test("A11-248: a conflict note is dropped once a round has moved the head", async () => {
  const { host, sweep, run } = world({ next: { rounds: 3 } });
  conflicting(host, NEXT);
  await sweep();
  host.pullAt(NEXT)!.head = MOVED_HEAD;
  await sweep();
  assert.equal(run().retargets, undefined);
});

test("A11-248: a pull request queued to merge, or already merged, is not updated", async () => {
  const { host, sweep } = world();
  host.stackMerges.facts.set(NEXT, { settled: "queued" });
  await sweep();
  assert.deepEqual(host.branchUpdates.asked, []);
});

test("A11-248: two conflicting members of one run share one round that names both, and neither is told the rounds are used up", async () => {
  const second = fakePullUrl(REPOSITORY, 4);
  const { host, sweep, run } = world({ next: { outcome: { kind: "reviewed", prs: [{ repo: "agent-org", url: NEXT }, { repo: "agent-org", url: second }] }, pullStates: { [NEXT]: "open", [second]: "open" } } });
  host.seedPull(REPOSITORY, 4, { head: "e".repeat(40), base: BOTTOM_BRANCH });
  conflicting(host, NEXT, second);
  await sweep();
  assert.equal(host.branchUpdates.asked.length, 2);
  assert.equal(run().rounds, 1, "one round, not one for each");
  assert.match(run().feedback!, new RegExp(`${NEXT} conflicts with its base branch main[\\s\\S]*${second} conflicts with its base branch main`));
});

test("A11-248: after a restart a conflict note does not stand in for the restack: the branch is updated again, and a conflict a person resolved reads as restacked", async () => {
  const note = "#2 conflicts with main after #1 merged, and the conflict rounds are used up: Respond to review starts another";
  const { host, sweep, run } = world({ next: { rounds: 3, retargets: { [NEXT]: note } } });
  host.branchUpdates.answers.set(NEXT, { kind: "up-to-date" });
  await sweep();
  assert.equal(host.branchUpdates.asked.length, 1);
  assert.equal(run().retargets![NEXT], "#2 restacked on main after #1 merged");
});

test("A11-248: a conflict note is dropped when the blocker leaves the queue, and a restacked note stays", async () => {
  const conflict = "#2 conflicts with main after #1 merged: a conflict round resolves it";
  const gone = world({ entries: ({ next }) => [next], next: { retargets: { [NEXT]: conflict } } });
  await gone.sweep();
  assert.equal(gone.run().retargets, undefined);
  const restacked = "#2 restacked on main after #1 merged";
  const stays = world({ entries: ({ next }) => [next], next: { retargets: { [NEXT]: restacked } } });
  await stays.sweep();
  assert.deepEqual(stays.run().retargets, { [NEXT]: restacked });
});

test("A11-248: a refusal is the card's note with GitHub's reason, and the next sweep tries again", async () => {
  const { host, sweep, run, updates } = world();
  host.branchUpdates.answers.set(NEXT, { kind: "refused", reason: "expected head sha didn't match current head ref" });
  await sweep();
  assert.equal(run().retargets![NEXT], "#2 could not be restacked on main after #1 merged: expected head sha didn't match current head ref; agent-org tries again");
  host.branchUpdates.answers.delete(NEXT);
  await sweep();
  assert.equal(updates().length, 2, "a refusal does not count as done");
  assert.equal(run().retargets![NEXT], "#2 restacked on main after #1 merged");
});

test("A11-248: with two members above, only the one directly above the merged member is restacked; the one above it follows its branch", async () => {
  const top = stackedRun("A11-3", TOP, { key: "A11-2", branch: NEXT_BRANCH });
  const { host, sweep, run } = world({ entries: ({ bottom, next }) => [bottom, next, top] });
  await sweep();
  assert.deepEqual(host.branchUpdates.asked.map(({ url }) => url), [NEXT], "#3 has an open member below it, so it is not asked about");
  assert.equal(run("A11-3").retargets, undefined);
  assert.ok(!host.calls.includes(`stackMergeFactsOf ${TOP}`), "and its stack is not even read");
});

test("A11-248: a run whose blocker is not on the queue, or whose blocker's pull request is open, is left alone", async () => {
  const absent = world({ entries: ({ next }) => [next] });
  await absent.sweep();
  assert.deepEqual(absent.updates(), []);
  const open = world();
  open.host.pullAt(BOTTOM)!.state = "open";
  await open.sweep();
  assert.deepEqual(open.updates(), []);
  assert.equal(open.run().retargets, undefined);
});

/** What the board logs about its blocker while `act` runs, one entry per write to stderr. */
async function logged(act: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    await act();
  } finally {
    process.stderr.write = write;
  }
  return lines.filter((line) => line.includes(" its blocker "));
}

test("A11-248: a blocker that is not on the queue, or has no pull request in the stack's repository, is said once in the log and the run is left alone", async () => {
  const absent = world({ entries: ({ next }) => [next] });
  const absentLog = await logged(async () => { await absent.sweep(); await absent.sweep(); });
  assert.deepEqual(absentLog, ["ticket:serve: A11-2: its blocker A11-1 is not on the queue, so its pull request is left as it is when the member below merges\n"], "said once, over two sweeps");
  const bare = world({ entries: ({ next }) => [{ ...bottomRun(), outcome: { kind: "reviewed", prs: [] } } as unknown as Entry, next] });
  const bareLog = await logged(async () => { await bare.sweep(); await bare.sweep(); });
  assert.deepEqual(bareLog, ["ticket:serve: A11-2: its blocker A11-1 has no pull request in agent-org, so its pull request is left as it is when the member below merges\n"]);
  assert.deepEqual([...absent.updates(), ...bare.updates()], []);
});

test("A11-248: a run that is not finished, one with a workspace open, and one a merge of its blocker's branch is under way in are left alone", async () => {
  const running = world({ next: { phase: "running" } });
  await running.sweep();
  assert.deepEqual(running.updates(), []);
  const open = world({ next: { workspace: "w1" } });
  await open.sweep();
  assert.deepEqual(open.updates(), [], "the worker's next push would be refused");
  const merging = world();
  merging.ctx.rebasing.add("A11-2");
  await merging.sweep();
  assert.deepEqual(merging.updates(), []);
  merging.ctx.rebasing.delete("A11-2");
  await merging.sweep();
  assert.equal(merging.updates().length, 1, "and the restack is made once they are over");
});

test("A11-248: a code host that cannot update a branch restacks nothing, and the sweep still records the notes of the bases", async () => {
  const { host, sweep, run } = world({ codeHost: (fake) => ({ ...fake, updateBranch: undefined }) });
  await sweep();
  assert.deepEqual(host.branchUpdates.asked, []);
  assert.equal(host.pullAt(NEXT)!.base, "main", "the base was still moved");
  assert.equal(run().retargets, undefined);
});

test("A11-248: a pull request the code host cannot read keeps the restack note it had", async () => {
  const note = "#2 conflicts with main after #1 merged: a conflict round resolves it";
  const { host, sweep, run } = world({ next: { retargets: { [NEXT]: note } }, codeHost: (fake) => ({ ...fake, stackMergeFactsOf: (url) => (url === NEXT ? null : fake.stackMergeFactsOf!(url)) }) });
  await sweep();
  assert.deepEqual(host.branchUpdates.asked, []);
  assert.deepEqual(run().retargets, { [NEXT]: note });
});

test("A11-248: a note about a pull request's base comes first, and the pull request is not restacked", async () => {
  const stale = `Needs retarget: ${NEXT} still targets ${BOTTOM_BRANCH}, whose branch is gone: retarget it by hand`;
  const { host, sweep, run } = world({ codeHost: (fake) => ({ ...fake, sweepRetargets: () => ({ [NEXT]: stale }) }) });
  await sweep();
  assert.deepEqual(host.branchUpdates.asked, []);
  assert.deepEqual(run().retargets, { [NEXT]: stale });
});

/** Real git with every `GIT_*` scrubbed, for the test's own setup. */
const gitSync = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: sandboxGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string, file: string, text: string, message: string) => {
  writeFileSync(join(cwd, file), text);
  gitSync(cwd, ["add", file]);
  gitSync(cwd, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
};

test("A11-248: the member above the restacked one follows its branch: agent-org's merge of a moved blocker branch brings the default branch up the stack", async () => {
  const root = tmpDir("restack-climb-");
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  gitSync(root, ["init", "-q", "--bare", "-b", "main", origin]);
  gitSync(root, ["init", "-q", "-b", "main", seed]);
  commit(seed, "base.txt", "base\n", "base");
  gitSync(seed, ["remote", "add", "origin", origin]);
  gitSync(seed, ["push", "-q", "origin", "main"]);
  gitSync(seed, ["checkout", "-q", "-b", NEXT_BRANCH]);
  commit(seed, "next.txt", "next\n", "the next member's work");
  gitSync(seed, ["push", "-q", "origin", NEXT_BRANCH]);
  const clone = join(root, "clone");
  gitSync(root, ["clone", "-q", origin, clone]);
  const worktree = join(root, "worktrees", "A11-3", "agent-org");
  gitSync(clone, ["worktree", "add", "-q", "-b", "a11-3-work", worktree, `origin/${NEXT_BRANCH}`]);
  const sha = gitSync(clone, ["rev-parse", `origin/${NEXT_BRANCH}`]);
  commit(worktree, "top.txt", "top\n", "the top member's work");
  gitSync(worktree, ["push", "-q", "origin", "HEAD:a11-3-work"]);
  const top = stackedRun("A11-3", TOP, { key: "A11-2", branch: NEXT_BRANCH });
  const { host, ctx, run, sweep } = world({ entries: ({ bottom, next }) => [bottom, next, { ...top, stackBase: { ...top.stackBase!, sha } }] });
  Object.assign(ctx, { git: defaultGit, settings: { clones: { "agent-org": clone }, worktreeRoot: join(root, "worktrees"), stateDir: join(root, "state") } });

  await sweep();
  assert.deepEqual(host.branchUpdates.asked.map(({ url }) => url), [NEXT], "agent-org restacked the member above the merged one");
  // What GitHub's update-branch did to that member's branch: main was merged into it.
  commit(seed, "main.txt", "main moved\n", "main merged into the next member");
  gitSync(seed, ["push", "-q", "origin", NEXT_BRANCH]);
  const moved = gitSync(seed, ["rev-parse", "HEAD"]);

  await rebaseStacked(ctx);
  assert.equal(gitSync(origin, ["rev-parse", "refs/heads/a11-3-work^2"]), moved, "the restacked member's new head is merged into the member above it");
  assert.equal(host.branchUpdates.asked.length, 1, "and the code host was not asked to update it");
  assert.equal(run("A11-3").stackBase!.sha, moved, "and the run is branched from that head now");
});

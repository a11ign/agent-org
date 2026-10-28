// no-token: gh -- the pool over the fake code host: a stack world is seeded in memory, and nothing is spawned
// module: the pool's feedback watch restacks the stacked members first, so a conflict names the stack and the merged member (A11-248)
//
// The server runs the conflict watch and the restack on separate timers. When the member below merges, GitHub reads the member above as conflicting at once, and a watch that read it before the restack
// would start a plain conflict round that names neither. The pool's `watchFeedback` runs the restack first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost, fakePullUrl } from "../plugins/fakes/code-host.ts";
import type { CodeHost } from "../plugins/contracts/code-host.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
import { poolFixture } from "./pool-fixture.ts";

const REPOSITORY = "a11ign/agent-org";
const BOTTOM = fakePullUrl(REPOSITORY, 1);
const NEXT = fakePullUrl(REPOSITORY, 2);
const BOTTOM_BRANCH = "a11-1-the-bottom-member";
const NEXT_BRANCH = "a11-2-the-next-member";
const NEXT_HEAD = "b".repeat(40);
const NOW = 1_000_000;

/** A finished run holding `url`, an open pull request that is ready to merge, with `over` laid on it. */
const finishedRun = (key: string, url: string, over: Record<string, unknown> = {}): Entry => ({
  ticket: { key, branch: `${key.toLowerCase()}-work` }, phase: "finished", finishedAt: NOW / 2, outcome: { kind: "reviewed", prs: [{ repo: "agent-org", url }] }, pullStates: { [url]: "open" }, ...over,
}) as unknown as Entry;

/** What makes a run stacked on A11-1's branch. */
const STACKED_ON_BOTTOM = {
  blockers: [{ key: "A11-1", state: "started", status: "In Review", branch: BOTTOM_BRANCH, pulls: {} }],
  stackBase: { key: "A11-1", repo: "agent-org", branch: BOTTOM_BRANCH, sha: "d".repeat(40) },
};

/** The run of the bottom member, whose pull request merged. */
const bottomRun = (): Entry => ({ ticket: { key: "A11-1" }, phase: "finished", outcome: { kind: "reviewed", prs: [{ repo: "agent-org", url: BOTTOM }] }, pullStates: { [BOTTOM]: "merged" } }) as unknown as Entry;

/** A pool over a queue of the bottom run and the next member's run, where GitHub says the next member conflicts, and the merge of `main` into it is refused as a conflict. */
function conflictingStack(over: { codeHost?: (host: ReturnType<typeof createFakeCodeHost>) => CodeHost } = {}) {
  const host = createFakeCodeHost("worker-bot");
  host.seedPull(REPOSITORY, 1, { head: BOTTOM_BRANCH, state: "merged" });
  host.seedPull(REPOSITORY, 2, { head: NEXT_BRANCH, base: BOTTOM_BRANCH, feedback: { conflicting: true }, merge: { armed: false, mergeable: false } });
  host.pullAt(NEXT)!.head = NEXT_HEAD;
  host.branchUpdates.answers.set(NEXT, { kind: "conflict" });
  const fixture = poolFixture({ keys: ["A11-2"], now: () => NOW });
  fixture.store.set({ ...fixture.store.get(), entries: [bottomRun(), finishedRun("A11-2", NEXT, STACKED_ON_BOTTOM)] });
  const pool = fixture.restart({ codeHost: over.codeHost?.(host) ?? host });
  const next = () => fixture.store.get().entries.find((entry) => entry.ticket.key === "A11-2")!;
  return { host, pool, next, entries: () => fixture.store.get().entries };
}

/** Run `act` with the board's log captured, and return the lines it wrote. */
async function captureStderr(act: () => Promise<void>): Promise<string[]> {
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    await act();
  } finally {
    process.stderr.write = write;
  }
  return written;
}

test("A11-248: the watch restacks first, so the conflict round it starts is the restack's, naming the stack and the merged member", async () => {
  const { host, pool, next } = conflictingStack();
  await pool.watchFeedback();
  assert.equal(host.branchUpdates.asked.length, 1, "the member was restacked by the watch's own pass");
  assert.equal(next().phase, "queued", "the run left finished for a round");
  assert.equal(next().rounds, 1, "exactly one round");
  const feedback = next().feedback!;
  assert.match(feedback, new RegExp(`${NEXT} conflicts with its base branch main`));
  assert.match(feedback, /A11-2 is stacked on A11-1; its pull request #1 \(.*\) merged into `main`/, "the stack and the merged member are named");
  assert.equal(feedback.split("\n").filter((line) => line.includes("conflicts with its base branch")).length, 1, "and the conflict is named once, by no second plain round");
});

test("A11-248: nothing is restacked or started twice by a second watch, or by the restack's own sweep after it", async () => {
  const { host, pool, next } = conflictingStack();
  await pool.watchFeedback();
  const feedback = next().feedback;
  await pool.watchFeedback();
  await pool.retargetStacked();
  assert.equal(host.branchUpdates.asked.length, 1, "one update call in all");
  assert.equal(next().rounds, 1, "one round in all");
  assert.equal(next().feedback, feedback);
});

test("A11-248: a restack that throws is said in the log, and the watch still reads the run's feedback", async () => {
  const { pool, next } = conflictingStack({ codeHost: (host) => ({ ...host, sweepRetargets: () => { throw new Error("gh exploded\nwith a second line"); } }) });
  const logged = await captureStderr(async () => { await pool.watchFeedback(); });
  assert.ok(logged.includes("ticket:serve: the stacked pull requests could not be restacked before the feedback watch: gh exploded\n"), "said in one line");
  assert.equal(next().rounds, 1, "the watch still started the plain conflict round");
  assert.equal(next().feedback, `${NEXT} conflicts with its base branch ${BOTTOM_BRANCH}.`, "the plain round, which names neither the stack nor the merged member");
});

test("A11-82: a run that is not in a stack and conflicts still gets the conflict round from the watch, after the board's merge of the base found the conflict real (A11-286)", async () => {
  const host = createFakeCodeHost("worker-bot");
  host.seedPull(REPOSITORY, 2, { head: NEXT_BRANCH, feedback: { conflicting: true }, merge: { armed: false, mergeable: false } });
  host.branchUpdates.answers.set(NEXT, { kind: "conflict" });
  const fixture = poolFixture({ keys: ["A11-2"], now: () => NOW });
  fixture.store.set({ ...fixture.store.get(), entries: [finishedRun("A11-2", NEXT)] });
  const pool = fixture.restart({ codeHost: host });
  await pool.watchFeedback();
  const run = fixture.store.get().entries[0];
  assert.deepEqual([run.rounds, run.feedback?.split("\n")[0]], [1, `${NEXT} conflicts with its base branch main.`]);
  assert.deepEqual(host.branchUpdates.asked, [{ url: NEXT, expectedHead: NEXT_BRANCH }], "the board's one merge of the base into it, and no restack");
});

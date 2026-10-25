// no-token: gh -- herdr, git, the tracker and the clock are all injected; nothing is spawned
//
// A11-258: a run that ended `needs-human` is parked, and its pull request then merged (A11-248: the chairman dismissed the reviewer's block, agent-org#1885 merged as `Partial: step 1 of 2`, and the card stayed
// at Needs you under its old question). The tracker refresh lets go of the parked workspace, and the same sweep then queues the next plan step on a `Partial:` merge, or completes the ticket on a `Closes` merge.
// A needs-human about something unrelated to a pull request is left as it is. Every test runs the real pool over the contract's in-memory tracker and code host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { poolFixture } from "./pool-fixture.ts";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import type { PullState, TicketSource } from "./source.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
import { runStatus } from "./board-view/pull-status-and-notes.ts";
import { reasonOf } from "./board-view/run-reason.ts";

const PR = "https://github.com/a11ign/agent-org/pull/1885";
const QUESTION = "the reviewer's CHANGES_REQUESTED at e0adb383 stands: a person must dismiss that review so the merge can proceed";

/** NBF-1 over the in-memory tracker, in progress, with the operations the sweep uses. */
function world() {
  const tracker = createFakeTracker([fakeTicket("NBF-1", { status: "In Progress", statusType: "started" })]);
  const { assigned, read, download, keywords, stateTypes, pullStates, claim, claims, complete, comment, moveToWorkingState } = tracker;
  const source: TicketSource = { assigned, read, download, keywords, stateTypes, pullStates, claim, claims, complete, comment, moveToWorkingState };
  const made = poolFixture({ keys: ["NBF-1"] });
  const codeHost = createFakeCodeHost();
  return { ...made, tracker, codeHost, pool: made.restart({ source, codeHost }) };
}

type World = ReturnType<typeof world>;

/** The pull request at `url`, as the code host holds it once it merged, with `body`. */
function seedMerged(codeHost: World["codeHost"], url: string, body: string): void {
  const [, repository, number] = /github\.com\/(.+)\/pull\/(\d+)$/.exec(url)!;
  codeHost.seedPull(repository, Number(number), { state: "merged", findings: { title: `Pull request ${number}`, number: Number(number), body, sections: [] } });
}

type Parked = Readonly<{ reason?: string; held?: boolean; state?: PullState; body?: string | null }>;

/**
 * NBF-1's run, finished `needs-human` and parked in workspace w1, as `end` leaves it. It holds the pull request at {@link PR} as a round's `review` (A11-248's shape), unless `held` is false; the tracker links it in `state`,
 * and the code host holds its merged `body` (none for `null`).
 */
function parkedNeedsHuman({ store, tracker, codeHost }: World, { reason = QUESTION, held = true, state = "merged", body = "Refs NBF-1\n\nPartial: step 1 of 2: the board releases it; step 2 remains" }: Parked = {}): void {
  const [entry] = store.get().entries;
  if (body !== null) seedMerged(codeHost, PR, body);
  store.set({ ...store.get(), entries: [{ ...entry, phase: "finished", workspace: "w1", pane: "w1:p1", finishedAt: 100, outcome: { kind: "needs-human", reason },
    ...(held ? { review: [{ repo: "agent-org", url: PR }] } : {}) }] });
  tracker.linkPull("NBF-1", PR, state);
}

const run = ({ store }: World): Entry => store.get().entries[0];
/** The run as the sweep leaves it, less what every sweep records (the tracker's state and the pull requests' states): so a run left alone compares equal to itself. */
const kept = ({ store }: World): string => JSON.stringify((({ trackerState: _state, pullStates: _pulls, ...rest }) => rest)(store.get().entries[0]));
const closed = ({ herdr }: World): string[][] => herdr.calls.filter((args) => args.includes("workspace") && args.includes("close"));

/** What the board writes to its log while `act` runs. */
async function logged(act: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    await act();
  } finally {
    process.stderr.write = write;
  }
  return lines;
}

test("A11-258: a needs-human run whose pull request merged with Partial is released, its next step is queued in the same sweep, and its card says the blocker cleared", async () => {
  const made = world();
  parkedNeedsHuman(made);
  assert.equal(runStatus(run(made)), "needs-you", "the incident: a merged pull request, and the card still asks");
  const lines = await logged(() => made.pool.refreshTracker());
  assert.deepEqual(closed(made).map((args) => args.at(-1)), ["w1"], "its workspace was closed, once");
  assert.ok(lines.some((line) => line.includes("NBF-1: the blocker cleared: a11ign/agent-org #1885 merged; its workspace was closed")), lines.join(""));
  const queued = run(made);
  assert.deepEqual([queued.phase, queued.workspace, queued.steps], ["queued", undefined, [{ step: 1, of: 2, prs: [PR], cleared: true }]], "step 2 stands in the old run's place");
  assert.equal(runStatus(queued), "queued");
  assert.equal(reasonOf(queued).line, "the blocker cleared: a11ign/agent-org #1885 merged; step 2 of 2 queued");
});

test("A11-258: a needs-human run whose pull request merged with Closes is released and its ticket is completed, and the card says the blocker cleared", async () => {
  const made = world();
  parkedNeedsHuman(made, { body: "Closes NBF-1" });
  await made.pool.refreshTracker();
  assert.deepEqual(closed(made).map((args) => args.at(-1)), ["w1"], "its workspace was closed");
  assert.equal(made.tracker.ticketOf("NBF-1")?.statusType, "completed", "the ticket was completed through the tracker");
  const done = run(made);
  assert.deepEqual([done.phase, done.workspace, done.closedByBoard, runStatus(done)], ["finished", undefined, true, "completed"]);
  assert.equal(reasonOf(done).line, "the blocker cleared: a11ign/agent-org #1885 merged");
  assert.equal(reasonOf(done).question, QUESTION, "what it asked stays one click away");
});

test("A11-258: a needs-human run that holds no pull request but names one in its reason waits on it, and takes the same path when it merges", async () => {
  const made = world();
  parkedNeedsHuman(made, { held: false, state: "open", body: null, reason: `${QUESTION} (${PR})` });
  await made.pool.refreshTracker();
  assert.deepEqual(run(made).review, [{ repo: "agent-org", url: PR }], "adopted while it is open");
  assert.deepEqual([run(made).phase, run(made).workspace, closed(made)], ["finished", "w1", []], "still parked: nothing merged yet");
  seedMerged(made.codeHost, PR, "Refs NBF-1\n\nPartial: step 1 of 2: the board releases it; step 2 remains");
  made.tracker.linkPull("NBF-1", PR, "merged");
  await made.pool.refreshTracker();
  assert.deepEqual([run(made).phase, run(made).steps?.map(({ step }) => step), closed(made).length], ["queued", [1], 1]);
});

test("A11-258: a pull request the reason names that already stood merged when first read is context, not a blocker, and the run is left alone", async () => {
  const made = world();
  parkedNeedsHuman(made, { held: false, state: "merged", reason: `a product decision on the empty state; see ${PR}, which merged earlier` });
  const before = kept(made);
  await made.pool.refreshTracker();
  assert.equal(kept(made), before, "nothing adopted, closed or queued");
  assert.deepEqual(closed(made), []);
});

test("A11-258: a needs-human about something unrelated to its pull requests is left alone: no pull request held or named, even with a merged one linked to the ticket", async () => {
  const made = world();
  parkedNeedsHuman(made, { held: false, state: "merged", body: "Closes NBF-1", reason: "which of the two colours should the empty state use?" });
  const before = kept(made);
  await made.pool.refreshTracker();
  assert.equal(kept(made), before, "still parked, with its question, and nothing queued or completed");
  assert.deepEqual([closed(made), runStatus(run(made)), made.tracker.ticketOf("NBF-1")?.statusType], [[], "needs-you", "started"]);
  assert.equal(reasonOf(run(made)).line, "which of the two colours should the empty state use?");
});

test("A11-258: a needs-human whose pull request is still open stays parked and asking", async () => {
  const made = world();
  parkedNeedsHuman(made, { state: "open", body: null });
  await made.pool.refreshTracker();
  assert.deepEqual([run(made).phase, run(made).workspace, closed(made), runStatus(run(made))], ["finished", "w1", [], "needs-you"]);
});

test("A11-258: a run that ended with another hand-back (a crash) whose pull request merged is not released by this", async () => {
  const made = world();
  parkedNeedsHuman(made);
  const [entry] = made.store.get().entries;
  made.store.set({ ...made.store.get(), entries: [{ ...entry, outcome: { kind: "crashed", reason: "the agent exited" } }] });
  await made.pool.refreshTracker();
  assert.deepEqual([run(made).phase, run(made).workspace, closed(made)], ["finished", "w1", []]);
});

test("A11-258: when herdr will not close the workspace the run stays parked and the refusal is logged, and the next sweep releases it and queues the step", async () => {
  const made = world();
  parkedNeedsHuman(made);
  made.herdr.closing.refusal = "pane_busy";
  const lines = await logged(() => made.pool.refreshTracker());
  assert.deepEqual([run(made).phase, run(made).workspace], ["finished", "w1"], "parked, so its next step is not queued beside its agent");
  assert.ok(lines.some((line) => line.includes("NBF-1: the blocker cleared: a11ign/agent-org #1885 merged, but its workspace could not be closed") && line.includes("pane_busy")), lines.join(""));
  made.herdr.closing.refusal = null;
  await made.pool.refreshTracker();
  assert.deepEqual([run(made).phase, run(made).steps?.length], ["queued", 1]);
});

test("A11-258: a needs-human release whose Partial names the plan's last step queues nothing, and the card says the blocker cleared and why", async () => {
  const made = world();
  parkedNeedsHuman(made, { body: "Refs NBF-1\n\nPartial: step 2 of 2: the rest" });
  await made.pool.refreshTracker();
  const stuck = run(made);
  assert.deepEqual([stuck.phase, stuck.workspace, runStatus(stuck)], ["finished", undefined, "needs-you"], "released, and a person is asked what to do with a Partial on the last step");
  assert.match(reasonOf(stuck).line ?? "", /^the blocker cleared: a11ign\/agent-org #1885 merged; Partial merged: step 2 of 2: the rest\. It names step 2 of 2, the last, with Partial/);
  assert.equal(reasonOf(stuck).question, QUESTION);
});

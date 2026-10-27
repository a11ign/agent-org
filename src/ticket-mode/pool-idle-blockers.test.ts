// no-token: gh -- herdr, git, the tracker, the code host and the clock are all injected; nothing is spawned
//
// A11-347: A11-253 sat In Progress for 15 hours with all ten of its pull requests merged and no run, and held A11-254 and A11-256 the whole time. A ticket that holds queued runs back, is In Progress and has no run is
// completed by the board when its pull requests all merged and one of them closes it, and queued on the saved choice when work remains. Every test runs the real pool and the real sweep over the contract's in-memory
// tracker and code host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { poolFixture } from "./pool-fixture.ts";
import { idleBlockerSweep } from "./idle-blockers.ts";
import { holderMove } from "./board-view/long-waits.ts";
import { enqueue } from "./queue/queue-entries-and-outcomes.ts";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import type { PullState, TicketSource } from "./source.ts";

const IDLE = "NBF-1";
const DEPENDENT = "NBF-2";
const pull = (n: number): string => `https://github.com/a11ign/agent-org/pull/${n}`;

/** NBF-1 In Progress in the tracker with no run, NBF-2 queued behind it, and the sweep the board runs over them, with the saved choice a test can change. */
function world(pulls: Readonly<Record<number, { state: PullState; body: string }>>) {
  const tracker = createFakeTracker([fakeTicket(IDLE, { status: "In Progress", statusType: "started" }), fakeTicket(DEPENDENT)]);
  void tracker.addBlockers?.(DEPENDENT, [IDLE]);
  tracker.setClaimant(IDLE, "me");
  const codeHost = createFakeCodeHost();
  for (const [number, { state, body }] of Object.entries(pulls)) {
    tracker.linkPull(IDLE, pull(Number(number)), state);
    codeHost.seedPull("a11ign/agent-org", Number(number), { state, findings: { title: `Pull request ${number}`, number: Number(number), body, sections: [] } });
  }
  const made = poolFixture({ keys: [DEPENDENT], source: tracker, now: () => 1_000 });
  const pool = made.restart({ source: tracker, codeHost });
  const choice = { model: "opus", effort: "max" };
  const lines: string[] = [];
  const { read, claims, complete, stateTypes } = tracker;
  const sweep = idleBlockerSweep({
    source: { read, claims, complete, stateTypes }, store: made.store, takenStates: [], claimant: () => "me", log: (line) => lines.push(line), runChoice: () => choice,
    queueTickets: (tickets, picked, options) => { made.store.set(enqueue(made.store.get(), tickets, picked, 1_000, null)); assert.deepEqual(options, { plan: false }); },
  });
  return { ...made, tracker, pool, sweep, lines, choice };
}

/** The blockers and the merged pull requests' bodies are read, as the board's refresh does before its sweep. */
const refreshed = async (made: ReturnType<typeof world>): Promise<void> => { await made.pool.refreshTracker(); };

test("A11-347: a ticket In Progress with no run and every pull request merged, one of them closing it, is completed, and the queued run it held back starts", async () => {
  const made = world({ 1: { state: "merged", body: `Refs ${IDLE}\n\nPartial: step 1 of 2: the first half` }, 2: { state: "merged", body: `Closes ${IDLE}` } });
  made.store.set({ ...made.store.get(), entries: made.store.get().entries.map((e) => ({ ...e, stoppedForBlocker: { at: 1, keys: [IDLE], others: [] } })) });
  await refreshed(made);
  await made.pool.tick();
  assert.equal(made.entry(DEPENDENT).phase, "queued", "the incident: a run stopped for the ticket waits until the tracker completes it, whatever its pull requests did");
  assert.equal(holderMove(IDLE, made.store.get().entries).words, `${IDLE} has no run on the board and all 2 of its pull requests have merged, one of them closing it, so the board completes it on its next sweep`);
  await made.sweep();
  assert.equal(made.tracker.ticketOf(IDLE)?.statusType, "completed", "the board moved it to Done");
  assert.match(made.tracker.comments.find(({ key }) => key === IDLE)?.text ?? "", /^a11ign\/agent-org #1, a11ign\/agent-org #2 merged, one of them closing NBF-1, but the tracker had not completed it and the board had no run for it/);
  assert.deepEqual(made.lines, [`${IDLE}: all 2 of its pull requests merged and it had no run, so the board completed it; it was holding back ${DEPENDENT}`]);
  await refreshed(made);
  await made.pool.tick();
  assert.equal(made.entry(DEPENDENT).phase, "running", "its dependent starts");
});

test("A11-347: a ticket In Progress with no run and work left is queued on the saved choice, with no plan run first, and the sweep does not queue it twice", async () => {
  const made = world({ 1: { state: "merged", body: `Refs ${IDLE}\n\nPartial: step 1 of 2: the first half` } });
  await refreshed(made);
  assert.equal(holderMove(IDLE, made.store.get().entries).words, `${IDLE} has no run on the board and still has open work, so the board queues it on the saved model on its next sweep, unless a person or another instance holds it`);
  await made.sweep();
  const queued = made.entry(IDLE);
  assert.deepEqual([queued.phase, queued.model, queued.effort, queued.plan], ["queued", "opus", "max", undefined]);
  assert.deepEqual(made.lines, [`${IDLE}: it has open work and no run and blocks ${DEPENDENT}, so the board queued it on opus at max`]);
  await made.sweep();
  assert.equal(made.store.get().entries.filter((e) => e.ticket.key === IDLE).length, 1);
  assert.equal(made.tracker.ticketOf(IDLE)?.statusType, "started", "and it is not completed: work remains");
});

test("A11-347: a ticket another instance holds is left to it, and said once", async () => {
  const made = world({ 1: { state: "merged", body: `Refs ${IDLE}\n\nPartial: step 1 of 2: the first half` } });
  made.tracker.setClaimant(IDLE, "other.1234");
  const takenStates = ["In Progress"];
  const sweep = idleBlockerSweep({ source: made.tracker, store: made.store, takenStates, claimant: () => "me", log: (line) => made.lines.push(line), runChoice: () => made.choice, queueTickets: () => assert.fail("it is another instance's") });
  await refreshed(made);
  await sweep();
  await sweep();
  assert.equal(made.store.get().entries.some((e) => e.ticket.key === IDLE), false);
  assert.deepEqual(made.lines, [`${IDLE}: it has no run here and blocks ${DEPENDENT}, but other.1234 claimed it and it is In Progress, so another instance holds it and the board leaves it`]);
});

test("A11-347: a tracker that refuses the completion is said once, and the next sweep tries again", async () => {
  const made = world({ 1: { state: "merged", body: `Closes ${IDLE}` } });
  const complete: NonNullable<TicketSource["complete"]> = async () => { throw new Error("Linear answered 500"); };
  const sweep = idleBlockerSweep({ source: { read: made.tracker.read, claims: made.tracker.claims, complete, stateTypes: made.tracker.stateTypes }, store: made.store, takenStates: [], claimant: () => "me", log: (line) => made.lines.push(line), runChoice: () => made.choice, queueTickets: () => {} });
  made.store.set({ ...made.store.get(), entries: made.store.get().entries.map((e) => ({ ...e, stoppedForBlocker: { at: 1, keys: [IDLE], others: [] } })) });
  await refreshed(made);
  await sweep();
  await sweep();
  assert.deepEqual(made.lines, [`${IDLE}: it has no run and blocks ${DEPENDENT}, but the board could not complete it (Linear answered 500); it tries again at the next sweep`]);
  await made.sweep();
  assert.equal(made.tracker.ticketOf(IDLE)?.statusType, "completed");
});

test("A11-347: a ticket no instance claimed (moved to In Progress by hand, or its run dismissed) is not queued, and said once", async () => {
  const made = world({ 1: { state: "merged", body: `Refs ${IDLE}\n\nPartial: step 1 of 2: the first half` } });
  made.tracker.setClaimant(IDLE, undefined);
  await refreshed(made);
  await made.sweep();
  await made.sweep();
  assert.equal(made.store.get().entries.some((e) => e.ticket.key === IDLE), false);
  assert.deepEqual(made.lines, [`${IDLE}: it has no run here and blocks ${DEPENDENT}, but no instance claimed it (it was moved to In Progress by hand, or its run was dismissed), so the board leaves it to a person`]);
});

test("A11-347: a ticket a person has moved out of In Progress since the blockers were read is neither completed nor queued", async () => {
  const closing = world({ 1: { state: "merged", body: `Closes ${IDLE}` } });
  await refreshed(closing);
  closing.tracker.seed(fakeTicket(IDLE, { status: "Todo", statusType: "unstarted" }));
  await closing.sweep();
  assert.equal(closing.tracker.ticketOf(IDLE)?.statusType, "unstarted", "not completed");
  const open = world({ 1: { state: "merged", body: `Refs ${IDLE}\n\nPartial: step 1 of 2: the first half` } });
  await refreshed(open);
  open.tracker.seed(fakeTicket(IDLE, { status: "Todo", statusType: "unstarted" }));
  open.tracker.setClaimant(IDLE, "me");
  await open.sweep();
  assert.equal(open.store.get().entries.some((e) => e.ticket.key === IDLE), false, "not queued");
});

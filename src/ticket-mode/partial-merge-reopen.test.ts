// no-token: gh -- herdr, git, the tracker and the clock are all injected; nothing is spawned
//
// A11-178: a pull request that declared `Partial:` merges, and the tracker's own integration completes its ticket anyway, because the body carried a closing word beside the ticket's key (a11ign/agent-org#1827
// quoted one as example text). The board puts the ticket back and queues the next plan step instead of leaving the run finished; a `Closes` merge completes as it always did; and a person who completes the
// ticket wins. Every test here runs the real pool over the contract's in-memory tracker, which can say who completed a ticket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { poolFixture } from "./pool-fixture.ts";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
import type { PullState, TicketSource } from "./source.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
import { runStatus } from "./board-view/pull-status-and-notes.ts";
import { reasonOf } from "./board-view/run-reason.ts";

const STEP_1_PR = "https://github.com/a11ign/agent-org/pull/1827";
const STEP_2_PR = "https://github.com/a11ign/lab/pull/150";
const PARTIAL = "step 1 of 3: the board puts a ticket back; steps 2 (lab) and 3 (a11ign) remain";

/** NBF-1 over the in-memory tracker, in progress, with the operations a sweep and a start use. `undone` counts the asks to put a ticket back. */
function world(over: Partial<TicketSource> = {}) {
  const tracker = createFakeTracker([fakeTicket("NBF-1", { status: "In Progress", statusType: "started" })]);
  const undone: string[] = [];
  /** Set to a message to have the tracker refuse the next asks to put a ticket back. */
  const refusal: { message: string | null } = { message: null };
  const { assigned, read, download, keywords, stateTypes, pullStates, claim, claims, complete, comment, moveToWorkingState } = tracker;
  const source: TicketSource = { assigned, read, download, keywords, stateTypes, pullStates, claim, claims, complete, comment, moveToWorkingState,
    undoAutomaticCompletion: async (key, text) => {
      undone.push(key);
      if (refusal.message !== null) throw new Error(refusal.message);
      return tracker.undoAutomaticCompletion!(key, text);
    }, ...over };
  const made = poolFixture({ keys: ["NBF-1"] });
  return { ...made, tracker, undone, refusal, pool: made.restart({ source }) };
}

type World = ReturnType<typeof world>;

type Finished = Readonly<{ url?: string; partial?: string | null; state?: PullState; by?: "integration" | "person"; fields?: Partial<Entry> }>;

/**
 * NBF-1's run, finished on a ready pull request at `url` (step 1's) that says `partial` (a pull request that completes the ticket for `partial: null`), whose state is `state`, over a ticket completed by `by`
 * (not at all when none): the pool as it is when the sweep reads the merge.
 */
function finishedOn({ store, tracker }: World, { url = STEP_1_PR, partial = PARTIAL, state = "merged", by, fields = {} }: Finished = {}): void {
  const [entry] = store.get().entries;
  const outcome = { kind: "ready-pr" as const, prs: [{ repo: "agent-org", url }], ...(partial === null ? {} : { partial }) };
  store.set({ ...store.get(), entries: [{ ...entry, phase: "finished", outcome, finishedAt: 100, ...(partial === null ? {} : { partial }), ...fields }] });
  tracker.linkPull("NBF-1", url, state);
  if (by !== undefined) tracker.completeAs("NBF-1", by);
}

/** NBF-1's run is queued for step 2, as the board queued it, and the ticket is completed by `by` (not at all when none). */
function queuedForStepTwo({ store, tracker }: World, by?: "integration" | "person"): void {
  const [entry] = store.get().entries;
  store.set({ ...store.get(), entries: [{ ...entry, steps: [{ step: 1, of: 3, prs: [STEP_1_PR] }] }] });
  if (by !== undefined) tracker.completeAs("NBF-1", by);
}

const run = ({ store }: World): Entry => store.get().entries[0];

test("A11-178: a partial pull request merges and the integration moves the ticket to Done: the ticket is put back with a comment, and the next step is queued in the same sweep", async () => {
  const made = world();
  finishedOn(made, { by: "integration" });
  assert.equal(made.tracker.ticketOf("NBF-1")?.status, "Done", "the integration's move, as the incident was");
  await made.pool.refreshTracker();
  assert.deepEqual([made.tracker.ticketOf("NBF-1")?.status, made.tracker.ticketOf("NBF-1")?.statusType], ["In Progress", "started"], "back where the integration found it");
  assert.equal(made.tracker.comments.length, 1);
  const [{ text }] = made.tracker.comments;
  for (const named of ["a11ign/agent-org #1827", "step 1 of 3", "NBF-1", "steps 2 and 3 of 3"]) assert.ok(text.includes(named), `the comment names ${named}: ${text}`);
  const queued = run(made);
  assert.deepEqual([queued.phase, queued.trackerState, queued.reopenFailure, queued.steps], ["queued", undefined, undefined, [{ step: 1, of: 3, prs: [STEP_1_PR] }]], "the run is replaced by one ready for step 2, not left finished");
  assert.equal(reasonOf(queued).line, "step 1 of 3 merged; step 2 queued");
  assert.equal(runStatus(queued), "queued");
  assert.deepEqual(made.undone, ["NBF-1"], "asked once");
});

test("A11-178: a pull request that completes the ticket (no Partial line) merges and the integration moves it to Done: the run completes as it always did, and the board asks for nothing to be put back", async () => {
  const made = world();
  finishedOn(made, { partial: null, by: "integration" });
  await made.pool.refreshTracker();
  assert.deepEqual(made.undone, [], "the tracker is not asked to put anything back");
  assert.deepEqual([run(made).phase, run(made).trackerState, runStatus(run(made)), made.tracker.ticketOf("NBF-1")?.status, made.tracker.comments], ["finished", "completed", "completed", "Done", []]);
});

test("A11-178: a person moves the ticket to Done after a partial pull request merged: the person's move wins, nothing is moved, said or queued, and the run reads Completed", async () => {
  const made = world();
  finishedOn(made, { by: "person" });
  await made.pool.refreshTracker();
  assert.deepEqual([made.tracker.ticketOf("NBF-1")?.status, made.tracker.comments], ["Done", []], "left alone: no move back, no comment");
  assert.deepEqual([run(made).phase, run(made).completedBy, run(made).trackerState, run(made).reopenFailure, runStatus(run(made))], ["finished", "person", "completed", undefined, "completed"], "no next step, and Completed");
  await made.pool.refreshTracker();
  assert.deepEqual(made.undone, ["NBF-1"], "and the tracker is not asked again once it has said a person did it");
});

test("A11-178: when the tracker cannot put the ticket back, the run reads Needs you, with the partial declaration and why, and the next sweep tries again and queues the step", async () => {
  const made = world();
  made.refusal.message = "Linear answered 502: bad gateway";
  finishedOn(made, { by: "integration" });
  await made.pool.refreshTracker();
  assert.deepEqual([run(made).phase, runStatus(run(made)), run(made).reopenFailure], ["finished", "needs-you", "Linear answered 502: bad gateway"]);
  assert.equal(reasonOf(run(made)).line, `Done in the tracker, but its last merged pull request declared Partial: ${PARTIAL}; the board could not put it back (Linear answered 502: bad gateway)`);
  made.refusal.message = null;
  await made.pool.refreshTracker();
  assert.deepEqual([run(made).phase, run(made).reopenFailure, made.tracker.ticketOf("NBF-1")?.status, run(made).steps?.length], ["queued", undefined, "In Progress", 1], "tried again, put back, and the step queued");
});

test("A11-178: a tracker that cannot undo a completion (no such operation) leaves the run flagged, with that as the reason, and a ticket a person completed is still not flagged", async () => {
  const made = world({ undoAutomaticCompletion: undefined });
  finishedOn(made, { by: "integration" });
  await made.pool.refreshTracker();
  assert.deepEqual([run(made).phase, runStatus(run(made)), run(made).reopenFailure], ["finished", "needs-you", "the tracker cannot put a ticket back"]);
  assert.match(reasonOf(run(made)).line ?? "", /^Done in the tracker, but its last merged pull request declared Partial: step 1 of 3.*; the board could not put it back \(the tracker cannot put a ticket back\)$/);
});

test("A11-178: a tracker that cannot say who completed the ticket flags the run, with the tracker's own words, and moves nothing", async () => {
  const made = world({ undoAutomaticCompletion: async () => ({ reopened: null, by: "unknown", note: "Linear's history does not say who moved NBF-1 to Done" }) });
  finishedOn(made, { by: "integration" });
  await made.pool.refreshTracker();
  assert.deepEqual([run(made).phase, runStatus(run(made)), run(made).reopenFailure, made.tracker.ticketOf("NBF-1")?.status], ["finished", "needs-you", "Linear's history does not say who moved NBF-1 to Done", "Done"]);
});

test("A11-178: the integration can complete the ticket before the board reads the pull request merged: the pull request is read again until it says, and then the ticket is put back and the step queued", async () => {
  const made = world();
  finishedOn(made, { state: "open", by: "integration" });
  await made.pool.refreshTracker();
  assert.deepEqual([run(made).phase, run(made).trackerState, made.undone], ["finished", "completed", []], "a pull request still open: the ticket is read Completed and nothing can be said of it yet");
  made.tracker.linkPull("NBF-1", STEP_1_PR, "merged");
  await made.pool.refreshTracker();
  assert.deepEqual([run(made).phase, made.tracker.ticketOf("NBF-1")?.status, run(made).steps?.map(({ step }) => step)], ["queued", "In Progress", [1]], "read again, found early, put back, queued");
});

test("A11-178: step 2 is queued before the integration completes the ticket: as it starts, the ticket is put back first, with the comment, and the run goes on", async () => {
  const made = world();
  queuedForStepTwo(made, "integration");
  await made.pool.tick();
  assert.equal(run(made).phase, "running", "the run started");
  assert.deepEqual([made.tracker.ticketOf("NBF-1")?.status, made.undone], ["In Progress", ["NBF-1"]], "put back before the start moved the ticket on");
  assert.match(made.tracker.comments[0]?.text ?? "", /a11ign\/agent-org #1827 merged as step 1 of 3 of NBF-1\..*Remaining: steps 2 and 3 of 3\./);
});

test("A11-178: step 2 starts on a ticket a person completed: it is left alone and the run goes on; a ticket not completed at all costs only the question", async () => {
  const completed = world();
  queuedForStepTwo(completed, "person");
  await completed.pool.tick();
  assert.deepEqual([run(completed).phase, run(completed).completedBy, completed.tracker.ticketOf("NBF-1")?.status, completed.tracker.comments], ["running", "person", "Done", []]);
  const open = world();
  queuedForStepTwo(open);
  await open.pool.tick();
  assert.deepEqual([run(open).phase, open.tracker.ticketOf("NBF-1")?.status, open.tracker.comments, run(open).reopenFailure], ["running", "In Progress", [], undefined]);
});

test("A11-178: a run that is not a later step asks nothing as it starts", async () => {
  const made = world();
  await made.pool.tick();
  assert.deepEqual([run(made).phase, made.undone], ["running", []]);
});

test("A11-178: step 2's pull request is open when the integration completes the ticket: the run is put back, and stays on its open pull request, not Completed", async () => {
  const made = world();
  finishedOn(made, { url: STEP_2_PR, partial: "step 2 of 3: the lab half", state: "open", by: "integration", fields: { steps: [{ step: 1, of: 3, prs: [STEP_1_PR] }] } });
  await made.pool.refreshTracker();
  assert.deepEqual([made.tracker.ticketOf("NBF-1")?.status, run(made).phase, run(made).trackerState, runStatus(run(made))], ["In Progress", "finished", undefined, "awaiting-review"]);
  assert.match(made.tracker.comments[0]?.text ?? "", /merged as step 1 of 3 of NBF-1.*Remaining: steps 2 and 3 of 3\./, "it names the step that merged and what remains");
});

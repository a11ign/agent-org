// no-token: gh -- the tracker, the code host and the clock are all injected; nothing is spawned
//
// A11-239: the board completes a ticket whose last step's merged body says `Partial: none; this is the last step.` (agent-org#1877, A11-219). These cases run the real pool over the in-memory tracker and
// code host, which needs the project's history; the grammar's own cases are in `partial-says-nothing-remains.test.ts`, which does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { poolFixture } from "./pool-fixture.ts";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { runStatus } from "./board-view/pull-status-and-notes.ts";
import { reasonOf } from "./board-view/run-reason.ts";

const PR_NUMBER = 1877;
const PR = `https://github.com/a11ign/agent-org/pull/${PR_NUMBER}`;
const LAST_STEP_BODY = "Refs NBF-1\n\nPartial: none; this is the last step.\n";

/** NBF-1 over the in-memory tracker, in progress, finished on a ready pull request at `PR` whose merged body is `body`, under an outcome whose `partial` is `partial` (none when undefined). */
function finishedWith(body: string, partial?: string) {
  const tracker = createFakeTracker([fakeTicket("NBF-1", { status: "In Progress", statusType: "started" })]);
  const undone: string[] = [];
  const { assigned, read, download, keywords, stateTypes, pullStates, claim, claims, complete, comment, moveToWorkingState } = tracker;
  const source = { assigned, read, download, keywords, stateTypes, pullStates, claim, claims, complete, comment, moveToWorkingState,
    undoAutomaticCompletion: async (key: string, text: string) => {
      undone.push(key);
      return tracker.undoAutomaticCompletion!(key, text);
    } };
  const made = poolFixture({ keys: ["NBF-1"] });
  const codeHost = createFakeCodeHost();
  codeHost.seedPull("a11ign/agent-org", PR_NUMBER, { state: "merged", findings: { title: `Pull request ${PR_NUMBER}`, number: PR_NUMBER, body, sections: [] } });
  const [entry] = made.store.get().entries;
  const outcome = { kind: "ready-pr" as const, prs: [{ repo: "agent-org", url: PR }], ...(partial === undefined ? {} : { partial }) };
  made.store.set({ ...made.store.get(), entries: [{ ...entry, phase: "finished", outcome, finishedAt: 100, ...(partial === undefined ? {} : { partial }) }] });
  tracker.linkPull("NBF-1", PR, "merged");
  return { tracker, undone, store: made.store, pool: made.restart({ source, codeHost }) };
}

test("A11-239: A11-219's body (`Refs` and `Partial: none; this is the last step.`) with an outcome of the same words: the board completes the ticket and shows no partial merge", async () => {
  const made = finishedWith(LAST_STEP_BODY, "none; this is the last step.");
  await made.pool.refreshTracker();
  const left = made.store.get().entries[0];
  assert.equal(made.tracker.ticketOf("NBF-1")?.status, "Done", "the board's backstop completes the ticket");
  assert.deepEqual([left.closedByBoard, left.phase, left.partial, left.steps, left.partialOverruled, runStatus(left), made.undone], [true, "finished", undefined, undefined, undefined, "completed", []]);
  assert.deepEqual(left.declared, { kind: "closes", urls: [PR] });
  assert.doesNotMatch(reasonOf(left).line ?? "", /Partial merged|Partial:/);
});

test("A11-239: the same body under an outcome with no `partial` completes the ticket too", async () => {
  const made = finishedWith(LAST_STEP_BODY);
  await made.pool.refreshTracker();
  const left = made.store.get().entries[0];
  assert.deepEqual([made.tracker.ticketOf("NBF-1")?.status, left.closedByBoard, left.partial, left.partialOverruled, runStatus(left)], ["Done", true, undefined, undefined, "completed"]);
});

test("A11-239: an outcome `partial` that names real work against that body is still a disagreement the card shows", async () => {
  const made = finishedWith(LAST_STEP_BODY, "step 2 of 3: the board view");
  await made.pool.refreshTracker();
  const left = made.store.get().entries[0];
  assert.deepEqual([made.tracker.ticketOf("NBF-1")?.status, left.partial, runStatus(left)], ["Done", undefined, "completed"]);
  assert.deepEqual(left.partialOverruled, { outcome: "step 2 of 3: the board view", pull: "Closes NBF-1", urls: [PR] });
});

test("A11-239: a body that says `Closes` against an outcome `partial` that says nothing remains records no disagreement, and against one that names work it does", async () => {
  const agreeing = finishedWith("Closes NBF-1\n", "None; this is the last step");
  await agreeing.pool.refreshTracker();
  assert.deepEqual([agreeing.store.get().entries[0].partialOverruled, runStatus(agreeing.store.get().entries[0])], [undefined, "completed"]);
  const disagreeing = finishedWith("Closes NBF-1\n", "the board view");
  await disagreeing.pool.refreshTracker();
  assert.deepEqual(disagreeing.store.get().entries[0].partialOverruled, { outcome: "the board view", pull: "Closes NBF-1", urls: [PR] });
});

test("A11-239: a last-step outcome that names work against a `Closes` body is still a disagreement the card shows", async () => {
  const named = finishedWith("Closes NBF-1\n", "Nothing, the board view remains");
  await named.pool.refreshTracker();
  assert.deepEqual(named.store.get().entries[0].partialOverruled, { outcome: "Nothing, the board view remains", pull: "Closes NBF-1", urls: [PR] });
});

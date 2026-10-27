// no-token: none -- a pool over fakes with an injected clock; nothing is spawned
//
// A11-291: the pool's watch reads an approved pull request, stamps it from its own clock, records the reason, sets the run's `mergeNote` after an hour or at once for a merge flow's first install, and takes it off again. The pure functions are
// `not-merging.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MergeFlow } from "../../plugins/contracts/code-host.ts";
import { createFakeCodeHost } from "../../plugins/fakes/code-host.ts";
import { poolFixture } from "../pool-fixture.ts";
import type { Entry, Queue } from "../queue/queue-entries-and-outcomes.ts";
import { finish } from "../queue/queue-transitions.ts";
import { ARM, FIRST_FLOW_NOTE, HEAD, HOUR_NOTE, LINE, MINUTE, NOW, NO_FLOW, PR, PRS, REPO, flowOf, read } from "./not-merging.test.support.ts";
import { mergeNote } from "./not-merging.ts";
import { runStatus } from "./pull-status-and-notes.ts";
import { reasonOf } from "./run-reason.ts";
import type { ViewEntry } from "./view-types-and-filters.ts";

// The pool: its watch reads the pull request, stamps it from its own clock, records the reason, and sets the run's mergeNote.
function approvedPool({ files = ["README.md"], flow = NO_FLOW as MergeFlow | null, kind = "ready-pr" as "ready-pr" | "draft-pr" } = {}) {
  const clock = { now: NOW };
  const host = createFakeCodeHost("worker-bot");
  host.seedPull(REPO, 10, { head: HEAD, files, queue: { queued: false, removals: [] }, feedback: { reviewDecision: "approved", verdictAtHead: "approved", armed: false } });
  if (flow !== null) host.seedMergeFlow(REPO, flow);
  const fixture = poolFixture({ keys: ["A11-257"], now: () => clock.now });
  fixture.store.set(finish(fixture.store.get(), "A11-257", { kind, prs: PRS }, NOW - 5 * MINUTE));
  const pool = fixture.restart({ codeHost: host });
  const entry = () => fixture.entry("A11-257") as Entry & ViewEntry;
  return { clock, host, pool, entry, store: fixture.store };
}

/** The pool's watch, read `minutes` after the first read. */
const watchAt = async ({ clock, pool }: Readonly<{ clock: { now: number }; pool: { watchFeedback(): Promise<void> } }>, minutes: number): Promise<void> => {
  clock.now = NOW + minutes * MINUTE;
  await pool.watchFeedback();
};

test("A11-291: the watch says Approved, not merging after 15 minutes with the reason, Needs you after an hour under access, and goes back once the pull request is in the merge queue", async () => {
  const { clock, host, pool, entry } = approvedPool();
  await pool.watchFeedback();
  assert.equal(entry().pullHeads?.[PR]?.unmergedSince, NOW, "the first read that finds it approved and unmerged stamps it");
  assert.equal(runStatus(entry()), "awaiting-review", "a pull request just approved is awaiting review as before");
  await watchAt({ clock, pool }, 14);
  assert.equal(runStatus(entry()), "awaiting-review");
  assert.deepEqual(host.calls.filter((call) => call.startsWith("readMergeFlow")), [], "and the host was not asked about the flow");
  await watchAt({ clock, pool }, 16);
  assert.equal(runStatus(entry()), "not-merging");
  assert.equal(reasonOf(entry()).line, LINE);
  assert.equal(entry().mergeNote, undefined, "no person is asked yet");
  await watchAt({ clock, pool }, 61);
  assert.equal(entry().mergeNote, HOUR_NOTE);
  assert.equal(entry().handedBack, undefined, "a note on the run, not a hand-back: its work is unchanged");
  assert.equal(runStatus(entry()), "needs-you");
  assert.equal(reasonOf(entry()).line, HOUR_NOTE, "the card says why, under the access item");
  const written = JSON.stringify(entry());
  await watchAt({ clock, pool }, 75);
  assert.equal(JSON.stringify(entry()), written, "a later watch finds the same state and rewrites nothing");
  // The merge queue takes it: nothing is stuck any more.
  host.pullAt(PR)!.queue = { queued: true, removals: [] };
  await pool.watchFeedback();
  assert.equal(entry().mergeNote, undefined, "the note goes");
  assert.equal(runStatus(entry()), "awaiting-review");
  assert.equal(entry().pullHeads?.[PR]?.unmergedSince, undefined);
  assert.equal(entry().pullHeads?.[PR]?.notMerging, undefined);
});

test("A11-291: a new head starts the count again, and the reason follows the repository: a flow that is there names that auto-merge is not on", async () => {
  const { clock, host, pool, entry } = approvedPool({ flow: flowOf({ autoMerge: true, armWorkflow: true }) });
  await pool.watchFeedback();
  await watchAt({ clock, pool }, 20);
  assert.equal(entry().pullHeads?.[PR]?.notMerging, "auto-merge is not on for it, and it is not in the merge queue");
  const pull = host.pullAt(PR)!;
  pull.head = "feedc0de0000";
  pull.reviews = [];
  pull.feedback = { reviewDecision: "approved", verdictAtHead: "approved", armed: true };
  await watchAt({ clock, pool }, 21);
  assert.equal(entry().pullHeads?.[PR]?.unmergedSince, NOW + 21 * MINUTE, "a push counts from the push");
  assert.equal(entry().pullHeads?.[PR]?.notMerging, undefined);
  assert.equal(runStatus(entry()), "awaiting-review");
});

test("A11-291: a repository the host cannot read the flow of is still named as not merging, with the reason it can read, and is asked again later, not on every watch", async () => {
  const { clock, host, pool, entry } = approvedPool({ flow: null });
  await pool.watchFeedback();
  await watchAt({ clock, pool }, 16);
  assert.equal(entry().pullHeads?.[PR]?.notMerging, "auto-merge is not on for it, and it is not in the merge queue");
  await watchAt({ clock, pool }, 17);
  await watchAt({ clock, pool }, 18);
  assert.equal(host.calls.filter((call) => call === `readMergeFlow ${REPO}`).length, 1, "one ask serves the next watches");
  await watchAt({ clock, pool }, 30);
  assert.equal(host.calls.filter((call) => call === `readMergeFlow ${REPO}`).length, 2, "and it is asked again once what it said has aged");
});

test("A11-291: a pull request that adds the repository's first merge flow reads Needs you the day it is approved, with no waiting", async () => {
  const { host, pool, entry } = approvedPool({ files: ["README.md", ARM] });
  await pool.watchFeedback();
  assert.equal(entry().mergeNote, FIRST_FLOW_NOTE);
  assert.equal(runStatus(entry()), "needs-you");
  assert.equal(reasonOf(entry()).line, FIRST_FLOW_NOTE);
  assert.deepEqual(host.calls.filter((call) => call.startsWith("readMergeFlow")), [`readMergeFlow ${REPO}`]);
});

test("A11-291: a pull request that edits an arm workflow the repository already has is not a first install, and one not yet approved is not flagged", async () => {
  const edits = approvedPool({ files: [ARM], flow: flowOf({ autoMerge: true, armWorkflow: true }) });
  await edits.pool.watchFeedback();
  assert.equal(edits.entry().mergeNote, undefined);
  assert.equal(runStatus(edits.entry()), "awaiting-review");
  const unapproved = approvedPool({ files: [ARM] });
  unapproved.host.pullAt(PR)!.feedback = { reviewDecision: "review-required", verdictAtHead: null };
  await unapproved.pool.watchFeedback();
  assert.equal(unapproved.entry().mergeNote, undefined, "it waits for its review as any pull request does");
});

test("A11-291: a draft pull request that the reviewer approved is not called stuck, and a run that already reads Needs you keeps its own words", async () => {
  const draft = approvedPool({ kind: "draft-pr" });
  await draft.pool.watchFeedback();
  await watchAt(draft, 90);
  assert.equal(draft.entry().mergeNote, undefined);
  assert.equal(runStatus(draft.entry()), "awaiting-review");
  const asking = approvedPool();
  asking.store.set({ ...asking.store.get(), entries: asking.store.get().entries.map((e) => ({ ...e, handedBack: "The pull requests keep getting feedback: the board answered 3 rounds on its own and stopped." })) } as Queue);
  await asking.pool.watchFeedback();
  await watchAt(asking, 90);
  assert.match(asking.entry().handedBack ?? "", /^The pull requests keep getting feedback/, "another hand-back keeps the card's words");
  assert.equal(asking.entry().mergeNote, undefined, "and a run that reads Needs you for its own reason takes no note");
});

test("A11-291: a note set on a run whose pull request then merges or whose ticket the tracker settles is cleared", async () => {
  for (const settled of [{ pullStates: { [PR]: "merged" } }, { pullStates: { [PR]: "closed" } }, { trackerState: "completed" }, { trackerState: "canceled" }]) {
    const { clock, pool, entry, store } = approvedPool({ files: ["README.md", ARM] });
    await pool.watchFeedback();
    clock.now = NOW + MINUTE;
    assert.equal(entry().mergeNote, FIRST_FLOW_NOTE);
    store.set({ ...store.get(), entries: store.get().entries.map((e) => ({ ...e, ...settled })) } as Queue);
    await pool.watchFeedback();
    assert.equal(entry().mergeNote, undefined, JSON.stringify(settled));
  }
});

test("A11-291: what the host last said of a repository's flow is kept when a later read fails or throws, so the reason does not flip and rewrite the queue", async () => {
  const { clock, host, pool, entry } = approvedPool();
  await pool.watchFeedback();
  await watchAt({ clock, pool }, 16);
  const reason = "a11ign/plugin has no merge flow: auto-merge is not allowed, no .github/workflows/auto-arm.yml";
  assert.equal(entry().pullHeads?.[PR]?.notMerging, reason);
  host.readMergeFlow = () => null;
  await watchAt({ clock, pool }, 30);
  assert.equal(entry().pullHeads?.[PR]?.notMerging, reason, "a read that fails keeps what was known");
  host.readMergeFlow = () => { throw new Error("gh hung"); };
  await watchAt({ clock, pool }, 45);
  assert.equal(entry().pullHeads?.[PR]?.notMerging, reason, "and one that throws is no reading, and does not stop the watch");
  assert.equal(entry().mergeNote, undefined);
});

test("A11-305: the watch writes no first-install note over a run whose ticket's Decisions no round has answered, and writes it once they are answered", async () => {
  const { pool, entry, store } = approvedPool({ files: ["README.md", ARM] });
  store.set({ ...store.get(), entries: store.get().entries.map((e) => ({ ...e, decisionsPending: { at: NOW, added: ["- a new decision"] } })) } as Queue);
  await pool.watchFeedback();
  assert.equal(entry().mergeNote, undefined);
  assert.equal(runStatus(entry()), "awaiting-review", "the card does not read Needs you");
  store.set({ ...store.get(), entries: store.get().entries.map(({ decisionsPending: _answered, ...rest }) => rest) } as Queue);
  await pool.watchFeedback();
  assert.equal(entry().mergeNote, FIRST_FLOW_NOTE);
});

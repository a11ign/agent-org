// no-token: none -- a pool over fakes with an injected clock; nothing is spawned
//
// A11-291: a pull request approved at its head, with green required checks, mergeable and not in the merge queue, is "Approved, not merging" on the card after 15 minutes (it was "Awaiting review"), reaches Needs you under the escalation list's access
// item after an hour, and a pull request that adds a repository's first merge flow reaches Needs you the day it is approved. a11ign/plugin#10 sat approved at 91cfe96d for a day in a repository with no merge flow.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PullFeedback } from "../../plugins/contracts/code-host.ts";
import { createFakeCodeHost } from "../../plugins/fakes/code-host.ts";
import { poolFixture } from "../pool-fixture.ts";
import { finish } from "../queue/queue-transitions.ts";
import type { Entry, Queue } from "../queue/queue-entries-and-outcomes.ts";
import { FIRST_FLOW_LINE, firstFlowNote, isMergeNote, markedHeads, NOT_MERGING_LINE, NOT_MERGING_MINUTES, NOT_MERGING_NEEDS_YOU_MINUTES, notMergingLine, stuckForAnHourNote, whyNotMerging } from "./not-merging.ts";
import { runActions, runStatus, shownStatus, WAITS_ON_REVIEW } from "./pull-status-and-notes.ts";
import { reasonOf } from "./run-reason.ts";
import { RUN_STATUSES, type PullHead, type ViewEntry } from "./view-types-and-filters.ts";

const MINUTE = 60_000;
const NOW = 10_000_000_000;
const REPO = "a11ign/plugin";
const PR = `https://github.com/${REPO}/pull/10`;
const PRS = [{ repo: "plugin", url: PR }];
const HEAD = "91cfe96d0a1b2c3d4e5f";
const ARM = ".github/workflows/auto-arm.yml";
const NO_FLOW = { autoMerge: false, armWorkflow: false };

/** The head the watch records for an approved pull request whose required checks are all green. */
const APPROVED: PullHead = { head: HEAD, approved: true, review: "approved", red: [], pending: [] };

/** What the host says of an approved, green, mergeable pull request that is not in the merge queue. */
const read = (over: Partial<PullFeedback> = {}): PullFeedback => ({ state: "open", feedbackAt: null, authors: [], failing: [], failures: [], failedAt: null, conflicting: false, mergeable: true, head: HEAD, approvedAtHead: true,
  base: "main", files: ["README.md"], filesComplete: true, queue: { queued: false, removals: [] }, ...over });

const never = (): never => { throw new Error("the merge flow was asked for, and nothing needed it"); };

test("A11-291: the thresholds are 15 minutes for the card and 60 for Needs you, and the status has the words the ticket gives it", () => {
  assert.deepEqual([NOT_MERGING_MINUTES, NOT_MERGING_NEEDS_YOU_MINUTES], [15, 60]);
  assert.equal(RUN_STATUSES.find(({ status }) => status === "not-merging")?.label, "Approved, not merging");
  assert.equal(WAITS_ON_REVIEW.has("not-merging"), true, "a board note may turn such a run into Needs you");
});

test("A11-291: a head is stamped when it is first read approved, green, mergeable and out of the queue, kept at the same head, and dropped by anything else", () => {
  const first = markedHeads({ [PR]: APPROVED }, { [PR]: read() }, undefined, 1000, never);
  assert.equal(first[PR].unmergedSince, 1000);
  assert.equal(markedHeads({ [PR]: APPROVED }, { [PR]: read() }, first, 5000, never)[PR].unmergedSince, 1000, "a later read at the same head keeps the stamp, so the record does not change");
  assert.equal(markedHeads({ [PR]: { ...APPROVED, head: "new" } }, { [PR]: read({ head: "new" }) }, first, 6000, never)[PR].unmergedSince, 6000, "a new head counts again");
  const dropped: [string, PullHead, Partial<PullFeedback>][] = [
    ["a review that is not an approval", { ...APPROVED, review: "none" }, {}],
    ["a red required check", { ...APPROVED, red: ["test"] }, {}],
    ["a required check still running", { ...APPROVED, pending: ["gate"] }, {}],
    ["a required check whose state was not read", { head: HEAD, approved: true, review: "approved" }, {}],
    ["a pull request that is not mergeable", APPROVED, { mergeable: false }],
    ["a conflict", APPROVED, { conflicting: true }],
    ["a pull request in the merge queue", APPROVED, { queue: { queued: true, removals: [] } }],
    ["a host that does not say whether it is queued", APPROVED, { queue: undefined }],
    ["a merged pull request", APPROVED, { state: "merged" }],
  ];
  for (const [name, head, over] of dropped) {
    assert.equal("unmergedSince" in markedHeads({ [PR]: head }, { [PR]: read(over) }, first, 7000, never)[PR], false, name);
  }
  assert.equal("unmergedSince" in markedHeads({ [PR]: APPROVED }, {}, first, 8000, never)[PR], false, "a head the watch did not read carries no mark");
});

test("A11-291: the reason is asked for, and recorded, only once the pull request has been out of the queue for more than 15 minutes", () => {
  const stamped = { [PR]: { ...APPROVED, unmergedSince: NOW } };
  const asked: string[] = [];
  const flowOf = (repository: string) => { asked.push(repository); return NO_FLOW; };
  assert.equal("notMerging" in markedHeads({ [PR]: APPROVED }, { [PR]: read() }, stamped, NOW + 15 * MINUTE, flowOf)[PR], false, "exactly 15 minutes is not more");
  assert.deepEqual(asked, [], "and nothing is asked of the host before then");
  const late = markedHeads({ [PR]: APPROVED }, { [PR]: read() }, stamped, NOW + 16 * MINUTE, flowOf)[PR];
  assert.equal(late.unmergedSince, NOW);
  assert.equal(late.notMerging, "a11ign/plugin has no merge flow: auto-merge is not allowed, no .github/workflows/auto-arm.yml");
  assert.deepEqual(asked, [REPO]);
});

test("A11-291: the reason is the repository's missing flow when it can be read, else what the pull request itself says, else only that it is not in the queue", () => {
  assert.equal(whyNotMerging(REPO, read(), NO_FLOW), "a11ign/plugin has no merge flow: auto-merge is not allowed, no .github/workflows/auto-arm.yml");
  assert.equal(whyNotMerging(REPO, read(), { autoMerge: false, armWorkflow: true }), "a11ign/plugin has no merge flow: auto-merge is not allowed");
  assert.equal(whyNotMerging(REPO, read(), { autoMerge: true, armWorkflow: false }), "a11ign/plugin has no merge flow: no .github/workflows/auto-arm.yml");
  const flow = { autoMerge: true, armWorkflow: true };
  assert.equal(whyNotMerging(REPO, read({ armed: false }), flow), "auto-merge is not on for it, and it is not in the merge queue");
  assert.equal(whyNotMerging(REPO, read({ armed: true }), flow), "auto-merge is on, but it is not in the merge queue");
  assert.equal(whyNotMerging(REPO, read(), flow), "it is not in the merge queue");
  assert.equal(whyNotMerging(REPO, read(), null), "it is not in the merge queue", "a repository the host could not read is not called flowless");
  assert.equal(whyNotMerging(REPO, read(), undefined), "it is not in the merge queue", "nor is a host that cannot be asked");
});

test("A11-291: a head that adds the arm workflow to a repository without one is marked as a first install the day it is approved, and no other head is", () => {
  const adds = read({ files: ["README.md", ARM] });
  assert.equal(markedHeads({ [PR]: APPROVED }, { [PR]: adds }, undefined, NOW, () => NO_FLOW)[PR].firstFlow, true, "approved just now, no waiting");
  assert.equal("firstFlow" in markedHeads({ [PR]: APPROVED }, { [PR]: adds }, undefined, NOW, () => ({ autoMerge: true, armWorkflow: true }))[PR], false, "a repository that has the workflow: an edit of it is any change");
  assert.equal("firstFlow" in markedHeads({ [PR]: APPROVED }, { [PR]: adds }, undefined, NOW, () => null)[PR], false, "a repository the host could not read is not called flowless");
  assert.equal("firstFlow" in markedHeads({ [PR]: { ...APPROVED, review: "none" } }, { [PR]: adds }, undefined, NOW, () => NO_FLOW)[PR], false, "an unapproved head waits");
  assert.equal("firstFlow" in markedHeads({ [PR]: APPROVED }, { [PR]: read({ files: ["README.md"] }) }, undefined, NOW, never)[PR], false, "and nothing is asked of a pull request that touches no arm workflow");
  assert.equal("firstFlow" in markedHeads({ [PR]: APPROVED }, { [PR]: { ...adds, state: "merged" } }, undefined, NOW, () => NO_FLOW)[PR], false, "a merged one is done");
});

/** A finished run whose one pull request carries `head`, with the run's outcome `kind`. */
const runWith = (head: PullHead, over: Partial<ViewEntry> = {}): ViewEntry =>
  ({ ticket: { key: "A11-257" }, phase: "finished", outcome: { kind: "ready-pr", prs: PRS }, pullHeads: { [PR]: head }, ...over });
const STUCK: PullHead = { ...APPROVED, unmergedSince: NOW - 20 * MINUTE, notMerging: "a11ign/plugin has no merge flow: auto-merge is not allowed, no .github/workflows/auto-arm.yml" };
const LINE = "Approved, not merging: a11ign/plugin #10 at 91cfe96d, a11ign/plugin has no merge flow: auto-merge is not allowed, no .github/workflows/auto-arm.yml";

test("A11-291: a run with a stuck pull request reads Approved, not merging, with the reason on its card; one that is not stuck still reads Awaiting review", () => {
  assert.equal(runStatus(runWith(APPROVED)), "awaiting-review", "approved and merging or young: waiting is waiting");
  assert.equal(runStatus(runWith(STUCK)), "not-merging");
  assert.equal(shownStatus(runWith(STUCK), undefined), "not-merging");
  assert.equal(notMergingLine(runWith(STUCK)), LINE);
  assert.equal(reasonOf(runWith(STUCK)).line, LINE, "the card's line");
  assert.equal(RUN_STATUSES.find(({ status }) => status === runStatus(runWith(STUCK)))?.label, "Approved, not merging", "and the words the card shows for the status");
  assert.equal(notMergingLine(runWith(APPROVED)), null);
});

test("A11-291: a needs-human run whose pull request was approved, and a reviewed run that is not ready, read it too; a draft and a Ready to merge run keep what they read", () => {
  const approvedAnswer = { outcome: { kind: "needs-human", reason: "q" }, review: PRS, outcomeHeads: { [PR]: HEAD } } as Partial<ViewEntry>;
  assert.equal(runStatus(runWith(APPROVED, approvedAnswer)), "awaiting-review", "POSITIVE CONTROL: the answer is read as approved, and the run awaits review");
  assert.equal(runStatus(runWith(STUCK, approvedAnswer)), "not-merging");
  assert.equal(runStatus(runWith(STUCK, { outcome: { kind: "draft-pr", prs: PRS } })), "awaiting-review", "a draft waits for its Approve, and is not meant to merge");
  assert.deepEqual(runActions(runWith(STUCK, { outcome: { kind: "draft-pr", prs: PRS } })).slice(0, 1), ["approve"], "which is still offered");
  const ready = runWith({ ...STUCK }, { outcome: { kind: "reviewed", prs: PRS } });
  assert.equal(runStatus(ready), "ready-to-merge", "Approve and Publish are offered from Ready to merge, so its status is left as it is");
  assert.equal(reasonOf(ready).line, LINE, "but its card says why nothing merges it");
});

test("A11-291: a run with a pull request not merging is still watched and still offers Respond, so it is read again until it merges", () => {
  const stuck = runWith(STUCK);
  assert.deepEqual(runActions(stuck), ["respond", "talk", "dismiss"]);
  assert.deepEqual(runActions(runWith(APPROVED)), runActions(stuck), "the same actions as when it is Awaiting review");
});

const HOUR_NOTE = "money, access or security — a11ign/plugin #10 has been approved at `91cfe96d` with green checks for more than 60 minutes and is not merging (a11ign/plugin has no merge flow: auto-merge is not allowed, no .github/workflows/auto-arm.yml): a person decides";

test("A11-291: after more than an hour the note is the escalation list's access item, naming the pull request, its head and the reason; before that, and for a parked or draft run, it is null", () => {
  const hours = (minutes: number, over: Partial<ViewEntry> = {}) => runWith({ ...STUCK, unmergedSince: NOW - minutes * MINUTE }, over);
  assert.equal(stuckForAnHourNote(hours(61), NOW), HOUR_NOTE);
  assert.equal(stuckForAnHourNote(hours(60), NOW), null, "more than 60, not 60");
  assert.equal(stuckForAnHourNote(hours(24 * 60), NOW), HOUR_NOTE, "the note does not count minutes, so it is the same on every watch");
  assert.equal(stuckForAnHourNote(hours(90, { workspace: "w1" }), NOW), null, "a parked run is already a person's");
  assert.equal(stuckForAnHourNote(hours(90, { phase: "running" }), NOW), null);
  assert.equal(stuckForAnHourNote(hours(90, { outcome: { kind: "draft-pr", prs: PRS } }), NOW), null);
  assert.equal(stuckForAnHourNote(hours(90, { pullStates: { [PR]: "merged" } }), NOW), null, "a merged pull request is not stuck");
  assert.equal(NOT_MERGING_LINE.test(HOUR_NOTE) && isMergeNote(HOUR_NOTE), true);
  assert.equal(isMergeNote("a11ign/control #132 has sat changes requested at `abcd1234` for more than 30 minutes, with no new push and no run: a person decides"), false);
});

const FIRST_FLOW_NOTE = "money, access or security — a11ign/plugin #10 adds a11ign/plugin's first merge flow (.github/workflows/auto-arm.yml), so nothing can arm it: a person merges it";

test("A11-291: a first install of a merge flow is a note the day it is approved, first among the notes, and its sentence is recognised", () => {
  const installing = runWith({ ...APPROVED, firstFlow: true });
  assert.equal(firstFlowNote(installing), FIRST_FLOW_NOTE);
  assert.equal(firstFlowNote(runWith(APPROVED)), null);
  assert.equal(firstFlowNote(runWith({ ...APPROVED, firstFlow: true }, { workspace: "w1" })), null, "a parked run is a person's already");
  assert.equal(FIRST_FLOW_LINE.test(FIRST_FLOW_NOTE) && isMergeNote(FIRST_FLOW_NOTE), true);
});

// The pool: its watch reads the pull request, stamps it from its own clock, records the reason, and sets the run's handedBack.
function approvedPool({ files = ["README.md"], flow = NO_FLOW as { autoMerge: boolean; armWorkflow: boolean } | null, kind = "ready-pr" as "ready-pr" | "draft-pr" } = {}) {
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
const watchAt = ({ clock, pool }: Readonly<{ clock: { now: number }; pool: { watchFeedback(): void } }>, minutes: number): void => {
  clock.now = NOW + minutes * MINUTE;
  pool.watchFeedback();
};

test("A11-291: the watch says Approved, not merging after 15 minutes with the reason, Needs you after an hour under access, and goes back once the pull request is in the merge queue", () => {
  const { clock, host, pool, entry } = approvedPool();
  pool.watchFeedback();
  assert.equal(entry().pullHeads?.[PR]?.unmergedSince, NOW, "the first read that finds it approved and unmerged stamps it");
  assert.equal(runStatus(entry()), "awaiting-review", "a pull request just approved is awaiting review as before");
  watchAt({ clock, pool }, 14);
  assert.equal(runStatus(entry()), "awaiting-review");
  assert.deepEqual(host.calls.filter((call) => call.startsWith("readMergeFlow")), [], "and the host was not asked about the flow");
  watchAt({ clock, pool }, 16);
  assert.equal(runStatus(entry()), "not-merging");
  assert.equal(reasonOf(entry()).line, LINE);
  assert.equal(entry().handedBack, undefined, "no person is asked yet");
  watchAt({ clock, pool }, 61);
  assert.equal(entry().handedBack, HOUR_NOTE);
  assert.equal(runStatus(entry()), "needs-you");
  assert.equal(reasonOf(entry()).line, HOUR_NOTE, "the card says why, under the access item");
  const written = JSON.stringify(entry());
  watchAt({ clock, pool }, 75);
  assert.equal(JSON.stringify(entry()), written, "a later watch finds the same state and rewrites nothing");
  // The merge queue takes it: nothing is stuck any more.
  host.pullAt(PR)!.queue = { queued: true, removals: [] };
  pool.watchFeedback();
  assert.equal(entry().handedBack, undefined, "the note goes");
  assert.equal(runStatus(entry()), "awaiting-review");
  assert.equal(entry().pullHeads?.[PR]?.unmergedSince, undefined);
  assert.equal(entry().pullHeads?.[PR]?.notMerging, undefined);
});

test("A11-291: a new head starts the count again, and the reason follows the repository: a flow that is there names that auto-merge is not on", () => {
  const { clock, host, pool, entry } = approvedPool({ flow: { autoMerge: true, armWorkflow: true } });
  pool.watchFeedback();
  watchAt({ clock, pool }, 20);
  assert.equal(entry().pullHeads?.[PR]?.notMerging, "auto-merge is not on for it, and it is not in the merge queue");
  const pull = host.pullAt(PR)!;
  pull.head = "feedc0de0000";
  pull.reviews = [];
  pull.feedback = { reviewDecision: "approved", verdictAtHead: "approved", armed: true };
  watchAt({ clock, pool }, 21);
  assert.equal(entry().pullHeads?.[PR]?.unmergedSince, NOW + 21 * MINUTE, "a push counts from the push");
  assert.equal(entry().pullHeads?.[PR]?.notMerging, undefined);
  assert.equal(runStatus(entry()), "awaiting-review");
});

test("A11-291: a repository the host cannot read the flow of is still named as not merging, with the reason it can read, and is asked again later, not on every watch", () => {
  const { clock, host, pool, entry } = approvedPool({ flow: null });
  pool.watchFeedback();
  watchAt({ clock, pool }, 16);
  assert.equal(entry().pullHeads?.[PR]?.notMerging, "auto-merge is not on for it, and it is not in the merge queue");
  watchAt({ clock, pool }, 17);
  watchAt({ clock, pool }, 18);
  assert.equal(host.calls.filter((call) => call === `readMergeFlow ${REPO}`).length, 1, "one ask serves the next watches");
  watchAt({ clock, pool }, 30);
  assert.equal(host.calls.filter((call) => call === `readMergeFlow ${REPO}`).length, 2, "and it is asked again once what it said has aged");
});

test("A11-291: a pull request that adds the repository's first merge flow reads Needs you the day it is approved, with no waiting", () => {
  const { host, pool, entry } = approvedPool({ files: ["README.md", ARM] });
  pool.watchFeedback();
  assert.equal(entry().handedBack, FIRST_FLOW_NOTE);
  assert.equal(runStatus(entry()), "needs-you");
  assert.equal(reasonOf(entry()).line, FIRST_FLOW_NOTE);
  assert.deepEqual(host.calls.filter((call) => call.startsWith("readMergeFlow")), [`readMergeFlow ${REPO}`]);
});

test("A11-291: a pull request that edits an arm workflow the repository already has is not a first install, and one not yet approved is not flagged", () => {
  const edits = approvedPool({ files: [ARM], flow: { autoMerge: true, armWorkflow: true } });
  edits.pool.watchFeedback();
  assert.equal(edits.entry().handedBack, undefined);
  assert.equal(runStatus(edits.entry()), "awaiting-review");
  const unapproved = approvedPool({ files: [ARM] });
  unapproved.host.pullAt(PR)!.feedback = { reviewDecision: "review-required", verdictAtHead: null };
  unapproved.pool.watchFeedback();
  assert.equal(unapproved.entry().handedBack, undefined, "it waits for its review as any pull request does");
});

test("A11-291: a draft pull request that the reviewer approved is not called stuck, and a run the note cannot be written over keeps its own words", () => {
  const draft = approvedPool({ kind: "draft-pr" });
  draft.pool.watchFeedback();
  watchAt(draft, 90);
  assert.equal(draft.entry().handedBack, undefined);
  assert.equal(runStatus(draft.entry()), "awaiting-review");
  const asking = approvedPool();
  asking.store.set({ ...asking.store.get(), entries: asking.store.get().entries.map((e) => ({ ...e, handedBack: "The pull requests keep getting feedback: the board answered 3 rounds on its own and stopped." })) } as Queue);
  asking.pool.watchFeedback();
  watchAt(asking, 90);
  assert.match(asking.entry().handedBack ?? "", /^The pull requests keep getting feedback/, "another hand-back is not written over");
});

test("A11-291: a note set on a run whose pull request then merges or whose ticket the tracker settles is cleared", () => {
  for (const settled of [{ pullStates: { [PR]: "merged" } }, { pullStates: { [PR]: "closed" } }, { trackerState: "completed" }, { trackerState: "canceled" }]) {
    const { clock, pool, entry, store } = approvedPool({ files: ["README.md", ARM] });
    pool.watchFeedback();
    clock.now = NOW + MINUTE;
    assert.equal(entry().handedBack, FIRST_FLOW_NOTE);
    store.set({ ...store.get(), entries: store.get().entries.map((e) => ({ ...e, ...settled })) } as Queue);
    pool.watchFeedback();
    assert.equal(entry().handedBack, undefined, JSON.stringify(settled));
  }
});

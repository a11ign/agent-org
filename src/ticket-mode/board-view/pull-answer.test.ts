// no-token: gh -- pure functions over a run's record
//
// A11-258: a needs-human run that stopped on a requested change reads cleared once that review is lifted at the head it ended at and its open pull requests are mergeable, and not otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { liftedBlocks, pullAnswer } from "./pull-answer.ts";
import { runStatus } from "./pull-status-and-notes.ts";
import { reasonOf } from "./run-reason.ts";
import type { PullHead, ViewEntry } from "./view-types-and-filters.ts";

const PR = "https://github.com/a11ign/agent-org/pull/1885";
const OTHER = "https://github.com/a11ign/lab/pull/150";
const QUESTION = "the reviewer's CHANGES_REQUESTED at h1 stands: a person must dismiss that review so the merge can proceed";

/** A needs-human run parked on the requested changes of {@link PR}, at head h1. */
const blocked = (over: Partial<ViewEntry> = {}): ViewEntry => ({ ticket: { key: "A11-1" }, phase: "finished", workspace: "w1", outcome: { kind: "needs-human", reason: QUESTION },
  review: [{ repo: "agent-org", url: PR }], pullStates: { [PR]: "open" }, outcomeHeads: { [PR]: "h1" }, outcomeBlocks: { [PR]: "h1" }, ...over }) as ViewEntry;

/** The run with its pull request read now as `head`, with `review`, `mergeable`. */
const read = (head: Partial<PullHead> = {}, over: Partial<ViewEntry> = {}): ViewEntry =>
  blocked({ pullHeads: { [PR]: { head: "h1", approved: false, review: "none", mergeable: true, ...head } }, ...over });

test("A11-258: a needs-human run whose requested changes were dismissed at its head, and whose pull request is mergeable, reads cleared, awaiting review, with the question one click away", () => {
  const dismissed = read();
  assert.equal(pullAnswer(dismissed), "cleared");
  assert.equal(runStatus(dismissed), "awaiting-review");
  assert.deepEqual(reasonOf(dismissed), { line: "the blocker cleared: the requested changes on a11ign/agent-org #1885 were lifted", question: QUESTION });
  assert.equal(runStatus(blocked()), "needs-you", "before anything is read it still asks");
});

test("A11-258: a requested change that is still there, not read yet, or unmergeable clears nothing", () => {
  assert.equal(pullAnswer(read({ review: "changes-requested" })), null, "still blocked");
  assert.equal(pullAnswer(read({ review: undefined })), null, "its review was not read");
  assert.equal(pullAnswer(read({ mergeable: false })), null, "it conflicts, or GitHub still computes it (UNKNOWN is not mergeable)");
  assert.equal(pullAnswer(read({ mergeable: undefined })), null, "its mergeability was not read");
  assert.equal(pullAnswer(blocked({ pullHeads: undefined })), null, "no head read yet");
  assert.equal(runStatus(read({ mergeable: false })), "needs-you");
});

test("A11-258: an approval lifts the block too, and the older answers keep their precedence", () => {
  assert.equal(pullAnswer(read({ review: "approved" })), "cleared");
  assert.equal(pullAnswer(read({ review: "approved", approved: true })), "approved", "approved at its head wins");
  assert.equal(pullAnswer(read({ head: "h2" })), "answered", "a push wins: the review is not read at the head the run ended at");
  assert.equal(pullAnswer(read({ head: "h2", mergeable: false })), "answered");
});

test("A11-258: a needs-human that did not stop on a requested change is left alone, whatever its pull request reads now", () => {
  assert.equal(pullAnswer(read({}, { outcomeBlocks: undefined })), null, "nothing was blocked at its end: no review, mergeable");
  assert.equal(pullAnswer(read({}, { outcomeBlocks: { [OTHER]: "k1" } })), null, "it was blocked on a pull request it does not hold");
  assert.equal(runStatus(read({}, { outcomeBlocks: undefined })), "needs-you");
  assert.equal(reasonOf(read({}, { outcomeBlocks: undefined })).line, QUESTION);
  assert.equal(pullAnswer(read({}, { outcome: { kind: "crashed", reason: "x" } })), null, "another hand-back");
  assert.equal(pullAnswer(read({}, { outcome: { kind: "needs-human", reason: "the outcome file", unreadable: true } })), null);
  assert.equal(pullAnswer(read({}, { phase: "running" })), null);
});

test("A11-258: a head agent-org moved is no lift, and another open pull request that reads changes requested keeps the run asking", () => {
  const moved = read({ head: "h2" }, { outcomeHeads: { [PR]: "h2" } });
  assert.equal(pullAnswer(moved), null, "agent-org's merge of main moved the outcome head, and a review reads absent on the new head: nobody lifted it");
  const second = blocked({ review: [{ repo: "agent-org", url: PR }, { repo: "lab", url: OTHER }], pullStates: { [PR]: "open", [OTHER]: "open" }, outcomeHeads: { [PR]: "h1", [OTHER]: "k1" },
    pullHeads: { [PR]: { head: "h1", approved: false, review: "none", mergeable: true }, [OTHER]: { head: "k1", approved: false, review: "changes-requested", mergeable: true } } });
  assert.equal(pullAnswer(second), null, "a reviewer asked for changes on a pull request the run was not blocked on");
});

test("A11-258: every blocked pull request must be lifted and every open one mergeable", () => {
  const two = (over: Partial<ViewEntry>): ViewEntry => blocked({ review: [{ repo: "agent-org", url: PR }, { repo: "lab", url: OTHER }], pullStates: { [PR]: "open", [OTHER]: "open" },
    outcomeHeads: { [PR]: "h1", [OTHER]: "k1" }, outcomeBlocks: { [PR]: "h1", [OTHER]: "k1" }, ...over });
  const heads = (second: Partial<PullHead>) => ({ [PR]: { head: "h1", approved: false, review: "none", mergeable: true }, [OTHER]: { head: "k1", approved: false, review: "none", mergeable: true, ...second } } as const);
  assert.deepEqual(liftedBlocks(two({ pullHeads: heads({}) })), [PR, OTHER]);
  assert.deepEqual(liftedBlocks(two({ pullHeads: heads({ review: "changes-requested" }) })), [], "one is still blocked");
  assert.deepEqual(liftedBlocks(two({ pullHeads: heads({ mergeable: false }) })), [], "one is not mergeable");
  assert.deepEqual(liftedBlocks(two({ pullHeads: heads({}), outcomeBlocks: { [PR]: "h1" } })), [PR], "an open pull request the run was not blocked on only has to be mergeable");
  assert.deepEqual(liftedBlocks(two({ pullHeads: heads({ mergeable: false }), outcomeBlocks: { [PR]: "h1" } })), [], "and clears nothing while it is not");
  assert.deepEqual(liftedBlocks(two({ pullHeads: heads({ review: "changes-requested" }), pullStates: { [PR]: "open", [OTHER]: "merged" } })), [PR], "a blocked pull request that merged is no longer open to wait on");
  assert.deepEqual(liftedBlocks(two({ pullHeads: heads({}), pullStates: { [PR]: "merged", [OTHER]: "merged" } })), [], "none open: nothing to clear, the merge path releases it");
});

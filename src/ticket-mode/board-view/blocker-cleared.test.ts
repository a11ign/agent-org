// no-token: gh -- pure functions over a run's record
//
// A11-258: which pull requests a needs-human run is about, when the board lets its parked workspace go, and what its card says once its blocker merged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockerClearedLine, isReleasable, namedBlockers, namedPulls } from "./blocker-cleared.ts";
import { stepQueuedLine, stepRunningLine } from "./plan-steps.ts";
import type { ViewEntry } from "./view-types-and-filters.ts";

const PR = "https://github.com/a11ign/agent-org/pull/1885";
const OTHER = "https://github.com/a11ign/lab/pull/150";

const run = (over: Partial<ViewEntry> = {}): ViewEntry => ({ ticket: { key: "A11-1" }, phase: "finished", workspace: "w1", outcome: { kind: "needs-human", reason: `a person must dismiss the review on ${PR}` },
  pullStates: { [PR]: "open" }, ...over }) as ViewEntry;

test("A11-258: a reason names a linked pull request by its address, as owner/repo#N, or as repo#N, and a bare #N names none", () => {
  const linked = [PR, OTHER];
  assert.deepEqual(namedPulls(`blocked on ${PR}.`, linked), [PR]);
  assert.deepEqual(namedPulls("blocked on a11ign/agent-org#1885", linked), [PR]);
  assert.deepEqual(namedPulls("blocked on agent-org#1885 and lab#150", linked), [PR, OTHER]);
  assert.deepEqual(namedPulls("blocked on #1885", linked), [], "which repository?");
  assert.deepEqual(namedPulls("blocked on other-org/agent-org#1885", linked), [], "another owner's pull request is not this one");
  assert.deepEqual(namedPulls("blocked on agent-org#18850", linked), [], "a longer number is another pull request");
  assert.deepEqual(namedPulls("blocked on https://github.com/a11ign/agent-org/pull/9", linked), [], "a pull request the tracker does not link to the ticket is nothing the board can read");
});

test("A11-258: a needs-human that holds no pull request is about the open linked ones its reason names, and no other run is about any", () => {
  assert.deepEqual(namedBlockers(run()), [PR]);
  assert.deepEqual(namedBlockers(run({ pullStates: { [PR]: "merged" } })), [], "already merged when first read: context");
  assert.deepEqual(namedBlockers(run({ pullStates: { [PR]: "closed" } })), [], "already closed when first read: context");
  assert.deepEqual(namedBlockers(run({ review: [{ repo: "agent-org", url: OTHER }] })), [], "it holds a pull request already");
  assert.deepEqual(namedBlockers(run({ outcome: { kind: "crashed", reason: PR } })), [], "another hand-back");
  assert.deepEqual(namedBlockers(run({ phase: "running" })), []);
  assert.deepEqual(namedBlockers(run({ outcome: { kind: "needs-human", reason: "which colour?" } })), [], "it names none");
});

test("A11-258: a parked needs-human run is released once every pull request it holds merged and the merged bodies are read, and not before, nor as a talk session", () => {
  const merged = run({ review: [{ repo: "agent-org", url: PR }], pullStates: { [PR]: "merged" }, declared: { kind: "partial", remains: "step 1 of 2", urls: [PR] } });
  assert.equal(isReleasable(merged), true);
  assert.equal(isReleasable({ ...merged, declared: undefined }), false, "the bodies are read first: what the merge means decides what follows");
  assert.equal(isReleasable({ ...merged, workspace: undefined }), false, "nothing parked");
  assert.equal(isReleasable({ ...merged, talk: true }), false, "a person is talking to it");
  assert.equal(isReleasable({ ...merged, pullStates: { [PR]: "open" } }), false);
  assert.equal(isReleasable({ ...merged, review: [{ repo: "agent-org", url: PR }, { repo: "lab", url: OTHER }], pullStates: { [PR]: "merged", [OTHER]: "open" } }), false, "every pull request it holds");
  assert.equal(isReleasable({ ...merged, pullStates: { [PR]: "closed" } }), false, "closed unmerged is cancelled, not cleared");
  assert.equal(isReleasable({ ...merged, outcome: { kind: "crashed", reason: "x" } }), false);
});

test("A11-258: the card line of a merged needs-human run names the merged pull requests, and a run that is not one has none", () => {
  const merged = run({ review: [{ repo: "agent-org", url: PR }, { repo: "lab", url: OTHER }], pullStates: { [PR]: "merged", [OTHER]: "merged" } });
  assert.equal(blockerClearedLine(merged), "the blocker cleared: a11ign/agent-org #1885, a11ign/lab #150 merged");
  assert.equal(blockerClearedLine({ ...merged, pullStates: { [PR]: "merged", [OTHER]: "open" } }) ?? "none", "none");
  assert.equal(blockerClearedLine({ ...merged, outcome: { kind: "ready-pr", prs: [{ repo: "agent-org", url: PR }] } }) ?? "none", "none");
});

test("A11-258: the line of the step queued after a cleared blocker names the merged pull requests, and a step that cleared none reads as it did", () => {
  assert.equal(stepQueuedLine([{ step: 1, of: 2, prs: [PR], cleared: true }]), "the blocker cleared: a11ign/agent-org #1885 merged; step 2 of 2 queued");
  assert.equal(stepRunningLine([{ step: 1, of: 3, prs: [PR], cleared: true }]), "the blocker cleared: a11ign/agent-org #1885 merged; step 2 of 3 running");
  assert.equal(stepQueuedLine([{ step: 1, of: 3, prs: [PR] }]), "step 1 of 3 merged; step 2 queued");
  assert.equal(stepQueuedLine([{ step: 1, of: 3, prs: [], cleared: true }]), "step 1 of 3 merged; step 2 queued", "no pull request to name");
});

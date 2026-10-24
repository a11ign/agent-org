// no-token: none -- the decider is a pure function over the facts it is handed
import { test } from "node:test";
import assert from "node:assert/strict";
import { STACK_MERGE_ASK_AGAIN_MS, stackMergeRequestOf, stackMergeStep, type StackMergeStepInput } from "./stack-merge.ts";

const URL = "https://github.com/a11ign/agent-org/pull/1872";
const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const NOW = 1_000_000;

/** A stacked, open pull request on the default branch that is ready and has never been asked about: the one case that asks. */
const input = (over: { facts?: Partial<StackMergeStepInput["facts"]> } & Partial<Omit<StackMergeStepInput, "facts">> = {}): StackMergeStepInput => {
  const { facts, ...rest } = over;
  return { url: URL, facts: { stacked: true, base: "main", defaultBranch: "main", head: HEAD, settled: null, refusal: null, ...facts }, ready: true, asked: undefined, now: NOW, ...rest };
};

test("A11-238: an approved, green pull request in a stack, based on the default branch, is asked about once", () => {
  assert.deepEqual(stackMergeStep(input()), { ask: true, note: null });
});

test("A11-238: a pull request that is not in a stack is left to the arm bot's auto-merge: no ask and no note", () => {
  assert.deepEqual(stackMergeStep(input({ facts: { stacked: false } })), { ask: false, note: null });
  assert.deepEqual(stackMergeStep(input({ facts: { stacked: false, refusal: { head: HEAD, reason: "a stale marker" } } })), { ask: false, note: null }, "and a marker on it says nothing");
});

test("A11-238: a pull request that is merged or queued already is settled: nothing", () => {
  assert.deepEqual(stackMergeStep(input({ facts: { settled: "merged" } })), { ask: false, note: null });
  assert.deepEqual(stackMergeStep(input({ facts: { settled: "queued" } })), { ask: false, note: null });
  assert.deepEqual(stackMergeStep(input({ facts: { settled: "queued", refusal: { head: HEAD, reason: "stale" } } })), { ask: false, note: null }, "a queued pull request shows no refusal");
});

test("A11-238: a pull request whose base is not the default branch waits for the members below it: nothing", () => {
  assert.deepEqual(stackMergeStep(input({ facts: { base: "a11-198-the-bottom-member" } })), { ask: false, note: null });
  assert.deepEqual(stackMergeStep(input({ facts: { base: "a11-198-the-bottom-member", refusal: { head: HEAD, reason: "stale" } } })), { ask: false, note: null });
});

test("A11-238: a pull request that is not ready is not asked about, and shows no refusal", () => {
  assert.deepEqual(stackMergeStep(input({ ready: false })), { ask: false, note: null });
  assert.deepEqual(stackMergeStep(input({ ready: false, facts: { refusal: { head: HEAD, reason: "a member below has changes requested" } } })), { ask: false, note: null });
});

test("A11-238: the board asks again about the same head only after the window, and at once about a head that moved", () => {
  const asked = { head: HEAD, at: NOW };
  assert.deepEqual(stackMergeStep(input({ asked, now: NOW + 1 })), { ask: false, note: null }, "just asked: the arm bot is still running");
  assert.deepEqual(stackMergeStep(input({ asked, now: NOW + STACK_MERGE_ASK_AGAIN_MS - 1 })), { ask: false, note: null }, "one millisecond inside the window");
  assert.deepEqual(stackMergeStep(input({ asked, now: NOW + STACK_MERGE_ASK_AGAIN_MS })), { ask: true, note: null }, "the window is over");
  assert.deepEqual(stackMergeStep(input({ asked, now: NOW + 1, facts: { head: MOVED } })), { ask: true, note: null }, "a head the board has not asked about is asked about at once");
});

test("A11-238: a refusal at the current head is shown with GitHub's reason and is not asked again, whenever the board last asked", () => {
  const refusal = { head: HEAD, reason: "a member below has changes requested" };
  const expected = { ask: false, note: `GitHub refused the stack merge of ${URL}: a member below has changes requested` };
  assert.deepEqual(stackMergeStep(input({ facts: { refusal } })), expected);
  assert.deepEqual(stackMergeStep(input({ facts: { refusal }, asked: { head: HEAD, at: NOW - 10 * STACK_MERGE_ASK_AGAIN_MS } })), expected, "the window does not reopen a refusal");
});

test("A11-238: a refusal at an older head is stale: the board asks again, and the card says nothing of it", () => {
  assert.deepEqual(stackMergeStep(input({ facts: { head: MOVED, refusal: { head: HEAD, reason: "a member below has changes requested" } } })), { ask: true, note: null });
});

test("A11-238: the request names the repository and number a pull request address holds, and nothing for another address", () => {
  assert.deepEqual(stackMergeRequestOf(URL), { repo: "a11ign/agent-org", number: 1872 });
  assert.deepEqual(stackMergeRequestOf(`${URL}/`), { repo: "a11ign/agent-org", number: 1872 });
  assert.equal(stackMergeRequestOf("https://github.com/a11ign/agent-org/issues/1872"), null);
  assert.equal(stackMergeRequestOf("https://example.com/a11ign/agent-org/pull/1872"), null);
});

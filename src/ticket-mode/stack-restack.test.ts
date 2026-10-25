// no-token: gh -- the decider and the wording of the restack of a stacked pull request, over plain values
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRestackedNote, isRestackNote, isRestackProblemNote, restackedAfter, restackFeedback, restackNote, restackStep, type RestackBelow } from "./stack-restack.ts";
import { CONFLICT_LINE } from "./worker-files.ts";

const PULL = "https://github.com/a11ign/announcement-emulator/pull/14";
const MERGED_BELOW = "https://github.com/a11ign/announcement-emulator/pull/13";
const below = (state: string | null = "MERGED"): RestackBelow => ({ key: "A11-228", url: MERGED_BELOW, state });
const facts = (over: Partial<{ base: string; defaultBranch: string; head: string }> = {}) => ({ base: "main", defaultBranch: "main", head: "a".repeat(40), ...over });
const step = (over: Partial<Parameters<typeof restackStep>[0]> = {}) => restackStep({ facts: facts(), below: below(), done: undefined, previousNote: undefined, ...over });

test("A11-248: a pull request whose base is the default branch and whose member below merged is restacked", () => {
  assert.deepEqual(step(), { restack: true, note: null });
});

test("A11-248: nothing is asked while the member below is open or closed, or the code host could not say", () => {
  for (const state of ["OPEN", "CLOSED", null]) assert.deepEqual(step({ below: below(state) }), { restack: false, note: null }, String(state));
});

test("A11-248: a pull request whose base is still the merged member's branch is not restacked: its base has not reached the default branch", () => {
  assert.deepEqual(step({ facts: facts({ base: "a11-228-the-bottom" }) }), { restack: false, note: null });
});

test("A11-248: a pull request already restacked after that member is not restacked again, and keeps its note", () => {
  const note = restackNote({ url: PULL, defaultBranch: "main", below: below(), outcome: { kind: "updated" } });
  assert.deepEqual(step({ done: { merged: MERGED_BELOW }, previousNote: note }), { restack: false, note });
});

test("A11-248: a pull request restacked after an earlier member is restacked once more for the next one that merged", () => {
  assert.equal(step({ done: { merged: "https://github.com/a11ign/announcement-emulator/pull/9" } }).restack, true);
});

test("A11-248: a note about a conflict is kept at the head it was said at and dropped once the head moves; a restacked note stays true", () => {
  const conflict = restackNote({ url: PULL, defaultBranch: "main", below: below(), outcome: { kind: "conflict", round: "started" } });
  const restacked = restackNote({ url: PULL, defaultBranch: "main", below: below(), outcome: { kind: "updated" } });
  const done = { merged: MERGED_BELOW, head: "a".repeat(40) };
  assert.equal(step({ done, previousNote: conflict }).note, conflict, "the head is the one the conflict was found at");
  assert.equal(step({ done: { ...done, head: "b".repeat(40) }, previousNote: conflict }).note, null, "a round pushed, so the conflict is no longer said");
  assert.equal(step({ done: { ...done, head: "b".repeat(40) }, previousNote: restacked }).note, restacked, "a head that moved does not make a restack untrue");
  assert.equal(step({ previousNote: "GitHub refused the stack merge of x: y" }).note, null, "a note another sweep wrote is not kept here");
});

test("A11-248: each note names the pull request, the default branch and the member that merged", () => {
  const note = (outcome: Parameters<typeof restackNote>[0]["outcome"]) => restackNote({ url: PULL, defaultBranch: "main", below: below(), outcome });
  assert.equal(note({ kind: "updated" }), "#14 restacked on main after #13 merged");
  assert.equal(note({ kind: "up-to-date" }), "#14 restacked on main after #13 merged");
  assert.equal(note({ kind: "conflict", round: "started" }), "#14 conflicts with main after #13 merged: a conflict round resolves it");
  assert.equal(note({ kind: "conflict", round: "capped" }), "#14 conflicts with main after #13 merged, and the conflict rounds are used up: Respond to review starts another");
  assert.equal(note({ kind: "conflict", round: "none" }), "#14 conflicts with main after #13 merged, and no conflict round starts on this run");
  assert.equal(note({ kind: "refused", reason: "head branch was modified" }), "#14 could not be restacked on main after #13 merged: head branch was modified; agent-org tries again");
});

test("A11-248: the restack notes are recognised, and only a restacked one is not a problem", () => {
  const notes = [{ kind: "updated" }, { kind: "conflict", round: "started" }, { kind: "conflict", round: "capped" }, { kind: "refused", reason: "r" }] as const;
  for (const outcome of notes) assert.equal(isRestackNote(restackNote({ url: PULL, defaultBranch: "main", below: below(), outcome })), true, outcome.kind);
  assert.equal(isRestackNote(`GitHub refused the stack merge of ${PULL}: no`), false);
  assert.equal(isRestackNote(`Needs retarget: ${PULL} still targets x`), false);
  assert.equal(isRestackedNote("#14 restacked on main after #13 merged"), true);
  assert.equal(isRestackProblemNote("#14 restacked on main after #13 merged"), false);
  assert.equal(isRestackProblemNote("#14 conflicts with main after #13 merged: a conflict round resolves it"), true);
  assert.equal(isRestackProblemNote("#14 could not be restacked on main after #13 merged: r; agent-org tries again"), true);
});

test("A11-248: the merged member is read back from a restacked or conflict note of that pull request, and from no other", () => {
  assert.equal(restackedAfter("#14 restacked on main after #13 merged", PULL), MERGED_BELOW);
  assert.equal(restackedAfter("#14 conflicts with main after #13 merged: a conflict round resolves it", PULL), MERGED_BELOW);
  assert.equal(restackedAfter("#14 could not be restacked on main after #13 merged: r; agent-org tries again", PULL), null, "a refusal is tried again, so it is not done");
  assert.equal(restackedAfter("#15 restacked on main after #13 merged", PULL), null, "a note about another pull request");
  assert.equal(restackedAfter("Needs retarget: x", PULL), null);
});

test("A11-248: the conflict round's feedback starts with the conflict line and names the stack, the merged member and the default branch", () => {
  const feedback = restackFeedback({ url: PULL, defaultBranch: "main", below: below(), key: "A11-229" });
  const [first, second] = feedback.split("\n");
  assert.match(first, CONFLICT_LINE);
  assert.equal(first, `${PULL} conflicts with its base branch main.`);
  assert.equal(second, `A11-229 is stacked on A11-228; its pull request #13 (${MERGED_BELOW}) merged into \`main\`, and merging \`main\` into ${PULL} conflicted.`);
});

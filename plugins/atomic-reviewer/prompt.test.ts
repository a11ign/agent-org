// no-token: none -- pure text
import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_TICKET_LINE, POST_MERGE_RULE, rereviewWords, reviewWords } from "./prompt.ts";

const GATE = "Ready (not a draft) #7 at `h1` has settled green checks and no verdict at that head. Review it per .agent-org/roles/reviewer.md and post the verdict as it says.";
const DONE_WHEN = "## Done-when\n\n### Before merge\n\n- a test\n\n### After merge (who runs it)\n\n- the chairman, after 0.9.0";

test("A11-156: a first review and a reprompt are sent the gate's prompt, then the ticket's Done-when, then the post-merge rule", () => {
  const words = reviewWords(GATE, { doneWhen: DONE_WHEN });
  assert.ok(words.startsWith(GATE), "the gate's own prompt, unchanged");
  assert.ok(words.indexOf(DONE_WHEN) > GATE.length && words.indexOf(POST_MERGE_RULE) > words.indexOf(DONE_WHEN), "then the Done-when, then the rule");
  assert.ok(words.endsWith(POST_MERGE_RULE));
  assert.match(POST_MERGE_RULE, /"After merge" part is not a merge condition/);
  assert.match(POST_MERGE_RULE, /names how that line will be run and by whom/);
});

test("A11-156: with no Done-when to give, or no brief at all, the prompt says the pull request is the only copy of the contract, and still carries the rule", () => {
  for (const brief of [{ doneWhen: null }, undefined]) {
    const words = reviewWords(GATE, brief);
    assert.ok(words.includes(NO_TICKET_LINE) && words.endsWith(POST_MERGE_RULE));
  }
  assert.match(NO_TICKET_LINE, /only copy of the contract/);
});

test("A11-156: a re-review prompt says what it is, lists each reply with its author and address, quotes the Done-when, states the rule, and tells how the verdict posts, in that order", () => {
  const words = rereviewWords({ number: 7, head: "a1b2c3d4e5f6", pr: "https://github.com/o/r/pull/7", roleFile: ".agent-org/roles/reviewer.md",
    replies: [{ author: "worker-bot", url: "https://github.com/o/r/pull/7#c1", text: "Not a defect.\nSecond line." }, { author: "DanBeckDev", url: "https://github.com/o/r/pull/7#c2", text: "Agreed." }], doneWhen: DONE_WHEN });
  const order = ["re-review of #7", "`a1b2c3d4`", "no new commit", "- worker-bot (https://github.com/o/r/pull/7#c1):\n  Not a defect.\n  Second line.", "- DanBeckDev (https://github.com/o/r/pull/7#c2):", DONE_WHEN, POST_MERGE_RULE,
    "Review it per .agent-org/roles/reviewer.md", "Corrects review: Review of #7 at `a1b2c3d4`", "refused by the door at this patch (exit 3)"].map((part) => words.indexOf(part));
  assert.ok(order.every((at) => at >= 0), `every part is there: ${order}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "and in the order the plan gives");
  assert.ok(!words.includes("has settled green checks and no verdict at that head"), "the gate's first-review sentence is not true of a re-review, and is not sent");
});

test("A11-156: the line the approval is told to carry is the one the verdict door's names_review looks for: the commit in backticks, after the opener", () => {
  const words = rereviewWords({ number: 7, head: "a1b2c3d4e5f6", pr: "u", roleFile: "r.md", replies: [{ author: "w", url: "u", text: "t" }], doneWhen: null });
  assert.ok(words.includes("Corrects review: Review of #7 at `a1b2c3d4`"));
  assert.ok(words.includes("Review of #7 at `a1b2c3d4"), "the door's own grep: Review of #<n> at, a backtick, then the first eight characters");
});

test("A11-156: a re-review without a ticket says so, and a long reply is cut with the length said", () => {
  const words = rereviewWords({ number: 7, head: "a1b2c3d4e5f6", pr: "https://github.com/o/r/pull/7", roleFile: "r.md", replies: [{ author: "worker-bot", url: "u", text: "x".repeat(5000) }], doneWhen: null });
  assert.ok(words.includes(NO_TICKET_LINE));
  assert.match(words, /\[cut: 1000 more characters on the pull request\]/);
  assert.ok(!words.includes("x".repeat(4001)), "no more than the limit is quoted");
});

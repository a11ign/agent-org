// no-token: none -- pure text
import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_SECTION_LINE, NO_TICKET_LINE, POST_MERGE_RULE, RATCHET_RULE, rereviewWords, reviewWords, unrequiredRedWords } from "./prompt.ts";

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

// A11-175: the checks left red because they are not required are named, and a pull request that finishes one step of a plan is reviewed against that step.
const SECTION = "### Step 3 of 9: Reviews, checks and the verdict door\n\nMove the reviewer's GitHub calls into `plugins/github`.\n\n- `agent-org:plugins/github/reviews.ts`";

test("A11-175: the prompt names the unrequired red checks and says they did not hold the review, in a first review, a reprompt and a re-review", () => {
  const first = reviewWords(GATE, { doneWhen: DONE_WHEN }, ["checks (cross-repo)", "lint"]);
  const naming = unrequiredRedWords(["checks (cross-repo)", "lint"]);
  assert.match(naming, /`checks \(cross-repo\)`, `lint`/);
  assert.match(naming, /not required, so they did not hold this review/);
  assert.match(naming, /A failure this diff caused is still a defect to name/);
  assert.ok(first.indexOf(naming) > GATE.length && first.indexOf(naming) < first.indexOf(DONE_WHEN), "after the gate's words and before the contract");
  const again = rereviewWords({ number: 7, head: "a1b2c3d4e5f6", pr: "u", roleFile: "r.md", replies: [{ author: "w", url: "u", text: "t" }], doneWhen: DONE_WHEN, unrequiredRed: ["checks (cross-repo)"] });
  assert.ok(again.includes(unrequiredRedWords(["checks (cross-repo)"])), "a re-review names them too");
  for (const none of [undefined, []]) {
    assert.equal(unrequiredRedWords(none), "", "nothing red and not required: nothing is said");
    assert.equal(reviewWords(GATE, { doneWhen: DONE_WHEN }, none), reviewWords(GATE, { doneWhen: DONE_WHEN }), "and the prompt is the one it always was");
  }
});

test("A11-175: a step brief quotes the section, states the ratchets' direction and heads the Done-when 'for the last step (step 9 of 9)'", () => {
  const words = reviewWords(GATE, { doneWhen: DONE_WHEN, step: { step: 3, of: 9, section: SECTION } });
  const order = ["This pull request is step 3 of 9 of its ticket's plan", `The plan's section for step 3:\n\n${SECTION}`, RATCHET_RULE,
    `The ticket's Done-when, for the last step (step 9 of 9), as the ticket states it:\n\n${DONE_WHEN}`, "Do not block this step on a whole-ticket line that only the last step can meet, unless this step makes that line harder to meet", POST_MERGE_RULE].map((part) => words.indexOf(part));
  assert.ok(order.every((at) => at > GATE.length), `every part is there, after the gate's words: ${order}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "in the order: the step, its section, the ratchets, the last step's Done-when, then the post-merge rule");
  assert.ok(!words.includes("The ticket's Done-when, as the ticket states it"), "the whole-ticket heading is not used for a step");
  assert.match(RATCHET_RULE, /a baseline or allow-list it changes only shrinks, a rule or check it changes only tightens, and a change the other way is a defect/);
});

test("A11-175: a step brief with no section says so, and the reviewer goes by the body's Partial: line; a re-review carries the step too", () => {
  const words = reviewWords(GATE, { doneWhen: DONE_WHEN, step: { step: 3, of: 9, section: null } });
  assert.ok(words.includes(NO_SECTION_LINE) && !words.includes("The plan's section for step 3"));
  assert.match(NO_SECTION_LINE, /go by the `Partial:` line of the pull request body/);
  const noTicket = reviewWords(GATE, { doneWhen: null, step: { step: 3, of: 9, section: SECTION } });
  assert.ok(noTicket.includes(SECTION) && noTicket.includes(NO_TICKET_LINE) && !noTicket.includes("for the last step"), "with no Done-when there is none to head");
  const again = rereviewWords({ number: 7, head: "a1b2c3d4e5f6", pr: "u", roleFile: "r.md", replies: [{ author: "w", url: "u", text: "t" }], doneWhen: DONE_WHEN, step: { step: 3, of: 9, section: SECTION } });
  assert.ok(again.indexOf("step 3 of 9") < again.indexOf("for the last step (step 9 of 9)") && again.indexOf("for the last step") < again.indexOf(POST_MERGE_RULE));
  const long = reviewWords(GATE, { doneWhen: null, step: { step: 3, of: 9, section: "y".repeat(9000) } });
  assert.match(long, /\[cut: 1000 more characters on the pull request\]/);
});

test("A11-175: with no step in the brief the prompt is the one it was: the whole ticket's Done-when under its own heading", () => {
  const words = reviewWords(GATE, { doneWhen: DONE_WHEN });
  assert.equal(words, `${GATE}\n\nThe ticket's Done-when, as the ticket states it:\n\n${DONE_WHEN}\n\n${POST_MERGE_RULE}`);
});

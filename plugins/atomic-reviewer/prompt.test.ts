// no-token: none -- pure text
import { test } from "node:test";
import assert from "node:assert/strict";
import { DECISION_RULE, decisionWords, NO_SECTION_LINE, NO_TICKET_LINE, POST_MERGE_RULE, RATCHET_RULE, rereviewWords, reviewWords, unrequiredRedWords } from "./prompt.ts";

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

test("A11-235: a body-only re-review says the description changed, lists its removed and added lines, tells the reviewer to review the whole diff, and lists no replies", () => {
  const words = rereviewWords({ number: 7, head: "a1b2c3d4e5f6", pr: "https://github.com/o/r/pull/7", roleFile: ".agent-org/roles/reviewer.md", replies: [], doneWhen: DONE_WHEN,
    body: [{ kind: "removed", text: "none" }, { kind: "added", text: "Outside-Region: src/a.ts — the reason" }] });
  const order = ["re-review of #7", "no new commit", "the pull request's description has been edited", "Review the whole diff again, not only the answer", "- none\n+ Outside-Region: src/a.ts — the reason", DONE_WHEN, POST_MERGE_RULE, "Corrects review: Review of #7 at `a1b2c3d4`"].map((part) => words.indexOf(part));
  assert.ok(order.every((at) => at >= 0), `every part is there: ${order}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "in that order");
  assert.ok(!words.includes("a reply has been posted") && !words.includes("The replies posted since that review"), "no reply is claimed");
});

test("A11-235: a re-review for a description edit and a reply says both and lists the lines before the replies; a reply alone still says only the reply", () => {
  const replies = [{ author: "worker-bot", url: "https://github.com/o/r/pull/7#c1", text: "Done: the reason is stated." }];
  const both = rereviewWords({ number: 7, head: "a1b2c3d4e5f6", pr: "u", roleFile: "r.md", replies, doneWhen: null, body: [{ kind: "added", text: "Outside-Region: src/a.ts — the reason" }] });
  assert.ok(both.includes("the pull request's description has been edited and a reply has been posted to it"));
  assert.ok(both.indexOf("+ Outside-Region: src/a.ts") < both.indexOf("- worker-bot (https://github.com/o/r/pull/7#c1):"), "the description's lines come first");
  const reply = rereviewWords({ number: 7, head: "a1b2c3d4e5f6", pr: "u", roleFile: "r.md", replies, doneWhen: null });
  assert.ok(reply.includes("a reply has been posted to it") && !reply.includes("description"), "a reply alone does not mention the description");
  assert.ok(reply.includes("Review the whole diff again, not only the answer"), "and still reviews the whole diff");
});

test("A11-235: a long run of changed lines is cut with the length said, as a long reply is", () => {
  const words = rereviewWords({ number: 7, head: "a1b2c3d4e5f6", pr: "u", roleFile: "r.md", replies: [], doneWhen: null, body: [{ kind: "added", text: "y".repeat(5000) }] });
  assert.match(words, /\[cut: \d+ more characters on the pull request\]/);
  assert.ok(!words.includes("y".repeat(4001)));
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

// A11-213: an explicit decision in the ticket overrides a general direction the reviewer holds, and the reviewer is told so wherever it reads the ticket.
const DECISION = "This step widens the policy's permissions by the chairman's decision on 2026-10-24.";
const STEP = { step: 4, of: 8, section: SECTION };
const REPLY = [{ author: "worker-bot", url: "https://github.com/o/r/pull/7#c1", text: "The ticket settles this." }];

test("A11-213: a ticket decision and a contrary general rule: the prompt quotes the decision, says it overrides the ratchets' direction, and says to quote it and not request changes", () => {
  const words = reviewWords(GATE, { doneWhen: DONE_WHEN, decisions: DECISION, step: STEP });
  assert.ok(words.includes(`The ticket's explicit decisions, as the ticket states them:\n\n${DECISION}`), "the decision, as the ticket words it");
  assert.ok(words.includes(DECISION_RULE), "and the rule that it comes first");
  assert.match(DECISION_RULE, /explicit decision in the ticket \(a line marked as the chairman's decision, or a `## Decisions` or `## Behaviour` section\) overrides a general direction/);
  assert.match(DECISION_RULE, /your role file, the gate's rules or the ratchets' direction/);
  assert.match(DECISION_RULE, /say so in your review, quote the decision, and do not request changes for it/);
  assert.match(DECISION_RULE, /beyond what the decision allows is still a defect/);
  assert.match(RATCHET_RULE, /a change the other way is a defect, unless the ticket's explicit decision says otherwise\.$/, "and the ratchet rule itself yields to it");
  const order = [GATE, "The ticket's explicit decisions", DECISION, DECISION_RULE, "This pull request is step 4 of 8", RATCHET_RULE, "for the last step", POST_MERGE_RULE].map((part) => words.indexOf(part));
  assert.ok(order.every((at) => at >= 0), `every part is there: ${order}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "the decisions come after the gate's words and before the step and the Done-when");
});

test("A11-213: the decision and its rule are in a re-review too, so the reply to a block that held a rule against the decision can be corrected", () => {
  const again = rereviewWords({ number: 7, head: "a1b2c3d4e5f6", pr: "https://github.com/o/r/pull/7", roleFile: "r.md", replies: REPLY, doneWhen: DONE_WHEN, decisions: DECISION, step: STEP });
  const order = ["re-review of #7", "The ticket settles this.", DECISION, DECISION_RULE, "step 4 of 8", POST_MERGE_RULE, "Corrects review: Review of #7 at `a1b2c3d4`"].map((part) => again.indexOf(part));
  assert.ok(order.every((at) => at >= 0), `every part is there: ${order}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "after the replies, before the post-merge rule and the verdict instructions");
});

test("A11-213: a ticket with no decision gets the prompt it always got, and a long decision is cut with the length said", () => {
  assert.equal(decisionWords(undefined), "");
  assert.equal(reviewWords(GATE, { doneWhen: DONE_WHEN }), `${GATE}\n\nThe ticket's Done-when, as the ticket states it:\n\n${DONE_WHEN}\n\n${POST_MERGE_RULE}`, "a brief with no decisions reads as one from before them");
  assert.ok(!reviewWords(GATE, { doneWhen: DONE_WHEN }).includes(DECISION_RULE), "and there is no rule about a decision that is not there");
  assert.match(decisionWords("z".repeat(9000)), /\[cut: 1000 more characters on the pull request\]/);
});

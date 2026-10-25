// no-token: gh -- pure builders and a board status over hand-made entries
//
// A11-213: a worker that judges a review's requested change wrong, or already settled by the ticket, replies on the pull request and hands the run to a person. It never ends `reviewed` with the pull request blocked.
// A11-257 changed that: a worker never stops to ask about anything off the escalation list. A review that requests changes against the plan or the ticket's Decisions is answered with a reply quoting the decision and the round ends
// `reviewed`: the reply starts the reviewer's re-review of the same head (A11-156), which the decision now binds. A11-213's flag for a pull request left blocked and idle backs it up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reasonOf } from "./board-view/run-reason.ts";
import { runStatus } from "./board-view/pull-status-and-notes.ts";
import type { ViewEntry } from "./board-view/view-types-and-filters.ts";
import { reviewBriefText } from "./worker-files.ts";
import type { Ticket } from "./source.ts";

const PR = "https://github.com/a11ign/control/pull/132";
const ticket = { key: "A11-203", title: "Widen the token policy", description: "This step widens the policy by the chairman's decision on 2026-10-24.", url: "https://linear.app/x/issue/A11-203",
  branch: "a11-203-widen", status: "Backlog", statusOrder: 0, team: "A11", project: null, priority: 3 } as Ticket;
const prs = [{ repo: "control", url: PR }];
const brief = (over: Partial<Parameters<typeof reviewBriefText>[0]> = {}) => reviewBriefText({ ticket, folder: "/work/.tickets/A11-203", ticketDir: "/state/tickets/A11-203", prs, resumed: true, ...over });

/** The three review rounds a worker is briefed for: the one a person's approval starts, the one the board starts on new feedback, and the one a person asks for with Respond. */
const ROUNDS: [string, string][] = [
  ["a round started by a person's approval", brief()],
  ["a round the board started on new feedback", brief({ feedback: `a11ign-reviewer requested changes on ${PR} at abcd1234: fix what its review found, then push.` })],
  ["a round a person asked for", brief({ asked: true })],
];

/** The reply step every round carries, as one sentence (A11-257). */
const DISPUTE = "When a review requests changes that go against the plan or the ticket's Decisions: make no change for it, reply on that pull request quoting the decision (the plan's line, or the ticket's Decisions entry with its heading), "
  + "and end the round `reviewed`. Your reply starts the reviewer's re-review of the same head, which that decision binds. A request you judge wrong on other grounds is answered with the evidence. End `needs-human` only for an item on the escalation list.";
const ANSWERED = "A review you disputed on a decision counts as answered once your reply quoting the decision is on the pull request.";

for (const [round, text] of ROUNDS) {
  test(`A11-257: ${round} tells the worker to reply quoting the decision and end reviewed, and to stop only for an item on the escalation list, in its steps`, () => {
    const steps = text.slice(text.indexOf("## What to do"), text.indexOf("## The outcome file"));
    assert.ok(steps.includes(DISPUTE), "the dispute step is among the round's steps");
    assert.ok(steps.indexOf("A finding you judge wrong is not fixed") < steps.indexOf(DISPUTE), "and follows the line that says a wrong finding is not fixed");
    assert.equal(steps.includes("needs-human` outcome whose reason names the pull request"), false, "the old hand-back to a person is gone");
  });

  test(`A11-257: ${round} lets the worker end reviewed once the disputed review is answered by its reply, and never asks it to hold the round for a person`, () => {
    const outcome = text.slice(text.indexOf("## The outcome file"));
    assert.ok(outcome.includes(ANSWERED), "the condition for `reviewed` carries the line");
    assert.equal(outcome.includes("Never write `reviewed` while a review you disputed"), false, "A11-213's condition is gone");
    assert.ok(outcome.indexOf("Write `reviewed` only when") < outcome.indexOf(ANSWERED));
  });
}

/** A finished review run as the board holds it: its worker's outcome, the pull request it answered, and what the watch read of it. */
const finished = (over: Partial<ViewEntry>): ViewEntry => ({ ticket: { key: "A11-203" }, phase: "finished", review: prs, outcomeHeads: { [PR]: "abcd1234" }, pullHeads: { [PR]: { head: "abcd1234", approved: false, review: "changes-requested" } }, ...over });

test("A11-213: a run that ended needs-human on a disputed review reads Needs you, with its reason naming the pull request and the finding on the card", () => {
  const reason = `${PR} is blocked by "this step permits only a shrink"; the ticket says "by the chairman's decision on 2026-10-24", so I replied and made no change.`;
  const entry = finished({ outcome: { kind: "needs-human", reason } });
  assert.equal(runStatus(entry), "needs-you");
  assert.equal(reasonOf(entry).line, reason);
  assert.ok(reasonOf(entry).line?.includes(PR) && reasonOf(entry).line?.includes("this step permits only a shrink"));
});

test("A11-213: the same blocked pull request under a run that ended reviewed reads Awaiting review, which is what the stale-block flag exists for", () => {
  assert.equal(runStatus(finished({ outcome: { kind: "reviewed", prs } })), "awaiting-review");
});

// no-token: gh -- pure builders and a board status over hand-made entries
//
// A11-213: a worker that judges a review's requested change wrong, or already settled by the ticket, replies on the pull request and hands the run to a person. It never ends `reviewed` with the pull request blocked.
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

/** The reply-and-hand-back step every round carries, as one sentence. */
const DISPUTE = "When a review requests changes and you judge the request wrong, or already settled by the ticket: make no change for it, reply on that pull request saying why and quoting the ticket's line, "
  + "and end the round with a `needs-human` outcome whose reason names the pull request's URL and the disputed finding.";
const NEVER_REVIEWED = "Never write `reviewed` while a review you disputed still requests changes on the head.";

for (const [round, text] of ROUNDS) {
  test(`A11-213: ${round} tells the worker to reply quoting the ticket and end needs-human naming the pull request and the finding, in its steps`, () => {
    const steps = text.slice(text.indexOf("## What to do"), text.indexOf("## The outcome file"));
    assert.ok(steps.includes(DISPUTE), "the dispute step is among the round's steps");
    assert.ok(steps.indexOf("A finding you judge wrong is not fixed") < steps.indexOf(DISPUTE), "and follows the line that says a wrong finding is not fixed");
  });

  test(`A11-213: ${round} never lets the worker end reviewed while a disputed review still blocks the head`, () => {
    const outcome = text.slice(text.indexOf("## The outcome file"));
    assert.ok(outcome.includes(NEVER_REVIEWED), "the condition for `reviewed` carries the line");
    assert.ok(outcome.includes('"kind": "needs-human"') && outcome.includes('"kind": "reviewed"'), "and both outcomes are on offer");
    assert.ok(outcome.indexOf("Write `reviewed` only when") < outcome.indexOf(NEVER_REVIEWED));
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

// no-token: gh -- pure builders over text; nothing is read or spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIVE_CHECK_RULE, PLANNER_SCOPE_RULE, SCOPE_RULE } from "./brief-scope.ts";
import { batchPlanBriefText, briefText, planBriefText, reviewBriefText } from "./worker-files.ts";
import type { Ticket } from "./source.ts";

const ticket = { key: "A11-1", title: "The view is slow", description: "Make it fast.", url: "https://linear.app/x/issue/A11-1", branch: "a11-1", status: "Backlog", statusOrder: 0, team: "A11", project: null, priority: 1 } as Ticket;
const clones = { "agent-org": "/work/agent-org" };

test("the worker and the review round quote the scope rule and the live-check rule", () => {
  const work = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "pr:open" });
  const round = reviewBriefText({ ticket, folder: "/f", ticketDir: "/d", prs: [{ repo: "a/b", url: "https://github.com/a/b/pull/1" }], resumed: true });
  for (const [who, text] of [["the worker", work], ["the review round", round]] as const) {
    assert.ok(text.includes(SCOPE_RULE), `${who} quotes the scope rule`);
    assert.ok(text.includes(LIVE_CHECK_RULE), `${who} quotes the live-check rule`);
  }
});

test("both planners quote the planner's scope rule", () => {
  const single = planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones, run: "plan {key} into {dir}" });
  const batch = batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null }], runDir: "/d", planDir: "/d/plan", clones, run: "plan {keys} into {dir}" });
  for (const [who, text] of [["the single planner", single], ["the batch planner", batch]] as const) assert.ok(text.includes(PLANNER_SCOPE_RULE), `${who} quotes it`);
});

test("the outcome beats the out-of-scope list, and a moved cost is not a fix", () => {
  assert.match(SCOPE_RULE, /If something the ticket calls out of scope stops the outcome being met, the outcome wins: treat it as in scope/);
  assert.match(SCOPE_RULE, /A note under "Decisions made without a person" alone is not enough\./);
  assert.match(SCOPE_RULE, /this never reaches past the escalation list: a change that falls on it still stops for a person/);
  assert.match(SCOPE_RULE, /A cost that moves to another step of the journey, such as from opening a page to its first click, has not been removed, and the outcome is not met\./);
  assert.match(PLANNER_SCOPE_RULE, /It never names code the ticket's outcome depends on/);
  assert.match(LIVE_CHECK_RULE, /A live check counts only if it could have failed\./);
});

test("the rules name no organisation of their own: agent-org is public", () => {
  for (const text of [SCOPE_RULE, LIVE_CHECK_RULE, PLANNER_SCOPE_RULE]) assert.ok(!/a11ign|chairman|netbox|linear\.app|slack/i.test(text), text);
});

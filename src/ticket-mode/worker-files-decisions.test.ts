// no-token: gh -- pure builders
import { test } from "node:test";
import assert from "node:assert/strict";
import { batchPlanBriefText, briefText, planBriefText, reviewBriefText, talkPrompt } from "./worker-files.ts";
import { RELAY_DECISION, TICKET_DECISIONS } from "./brief-decisions.ts";
import type { Ticket } from "./source.ts";

const ticket = { key: "NBF-1270", title: "Refresh Data gives no feedback", description: "Clicking does nothing visible.\n\n## Decisions (the chairman, 2026-10-25)\n\n* **Answer:** Keep it.", url: "https://linear.app/x/issue/NBF-1270",
  branch: "nbf-1270-refresh", status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 3 } as Ticket;
const clones = { "nbl-ui-netbox": "/work/nbl-ui-netbox" };

const work = () => briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "/node /tool/src/bin.ts pr:open" });
const round = () => reviewBriefText({ ticket, folder: "/f", ticketDir: "/d", prs: [], resumed: true });
const single = (extra: Partial<Parameters<typeof planBriefText>[0]> = {}) => planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones, run: "plan {key} into {dir}", ...extra });
const batch = () => batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null }], runDir: "/d", planDir: "/d/plan", clones, run: "plan {keys} into {dir}" });

test("A11-250: the work brief, a review round's brief and a talk session's prompt tell the worker to read the ticket's Decisions first, and to relay a decision only with a link to it", () => {
  assert.match(TICKET_DECISIONS, /^Read the ticket's `## Decisions` sections before the plan\./);
  assert.match(TICKET_DECISIONS, /overrides the plan, its files and your own preference where they differ/);
  assert.match(TICKET_DECISIONS, /What a person tells you in this run, in your terminal, you may act on in this run, but it binds no reviewer and no later run until the board has written it into the ticket/);
  assert.match(RELAY_DECISION, /link the ticket's Decisions entry that records it \(the ticket URL and the entry's heading\)/);
  assert.match(RELAY_DECISION, /Never write that a person decided something without that link: the reviewer refuses such a claim as unsupported\./);
  for (const [name, text] of [["work brief", work()], ["review round", round()], ["talk session", talkPrompt("/d")]] as const) {
    assert.ok(text.includes(TICKET_DECISIONS), `${name} carries the rule to read Decisions first`);
    assert.ok(text.includes(RELAY_DECISION), `${name} carries the rule to relay with a link`);
  }
  const brief = work();
  assert.ok(brief.indexOf(TICKET_DECISIONS) < brief.indexOf("## The ticket"), "the rule comes before the ticket is quoted, where the plan and files follow");
});

test("A11-250: a planner's brief (single, batch and re-plan) reads the Decisions ahead of the plan and writes a Ticket decisions section with Follows or Conflicts for each", () => {
  const replan = single({ replan: { files: ["/d/previous/plan.md"], change: { from: "A", to: "B" }, findings: false } });
  for (const [name, text] of [["single", single()], ["batch", batch()], ["re-plan", replan]] as const) {
    assert.ok(text.includes(TICKET_DECISIONS), `${name} planner reads the Decisions first`);
    assert.match(text, /gets a plan with a `## Ticket decisions` section, with one bullet per decision in the ticket\. Each bullet starts `Follows:`/);
    assert.match(text, /writes a `Conflicts:` bullet naming the decision and the plan line, and the board refuses that plan/);
    assert.match(text, /In a re-plan, change every point where the earlier plan differed from a decision to follow the decision\./);
  }
  assert.match(replan, /## This is a re-plan/);
});

// no-token: gh -- pure builders over text; nothing is read or spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { ESCALATION_IDS, ESCALATION_ITEMS, ESCALATION_RULE, OFF_LIST_PREFIX, escalationItem, escalationList, escalationReason, offListRefusal, questionEscalation, questionText } from "./escalation.ts";
import { batchPlanBriefText, briefText, planBriefText, reviewBriefText } from "./worker-files.ts";
import { OUTCOME_EXAMPLES, checkOutcome } from "./outcome.ts";
import { planDecisionWords } from "../../plugins/atomic-reviewer/prompt.ts";
import { WORKER_NOTES } from "../install/house-notes.ts";
import type { Ticket } from "./source.ts";

const ticket = { key: "A11-257", title: "Fully autonomous runs", description: "Do it.", url: "https://linear.app/x/issue/A11-257", branch: "a11-257", status: "Backlog", statusOrder: 0, team: "A11", project: null, priority: 1 } as Ticket;
const clones = { "agent-org": "/work/agent-org" };

test("A11-257: the escalation list has the seven items the ticket names, each with its own id", () => {
  assert.deepEqual(ESCALATION_IDS, ["outward", "access", "discard", "frozen", "legal", "reserved", "contradicts"]);
  assert.equal(new Set(ESCALATION_IDS).size, ESCALATION_ITEMS.length, "no id twice");
  const words = ESCALATION_ITEMS.map((item) => item.words).join("\n");
  for (const part of ["outward-facing", "contacting anyone outside the organisation", "money, accounts, permissions, secrets, credentials or security settings", "discarding or deleting work", "unmerged", "frozen", "legal and licensing", "naming, or pricing", "recorded decision"]) {
    assert.ok(words.includes(part) || words.includes(part.replace("frozen", "freezes")), `the list says ${part}`);
  }
});

test("A11-257: the list names no organisation of its own: agent-org is public", () => {
  assert.ok(!/a11ign|ADR|chairman|fleet|ansible|slack|nvda/i.test(escalationList()), escalationList());
});

test("A11-257: an id finds its item, and an id that is not on the list finds none", () => {
  assert.equal(escalationItem("outward")?.label, "outward-facing");
  for (const off of ["", "silly", "OUTWARD", undefined, null, 3]) assert.equal(escalationItem(off), undefined, String(off));
});

test("A11-257: a card's reason starts with its item's words, or with 'Off the escalation list:' for a stop that names none", () => {
  assert.equal(escalationReason("outward", "post the release note to the forum?"), "outward-facing — post the release note to the forum?");
  assert.equal(escalationReason(undefined, "which colour?"), `${OFF_LIST_PREFIX} which colour?`);
  assert.equal(escalationReason("silly", "which colour?"), `${OFF_LIST_PREFIX} which colour?`);
});

test("A11-257: a QUESTION.md names its item on its first line, and the card shows the question without that line", () => {
  assert.equal(questionEscalation("**Escalation:** outward\n\nPost it?"), "outward");
  assert.equal(questionEscalation("\n\n**Escalation:** `access`\nWhich token?"), "access");
  assert.equal(questionEscalation("Post it?\n**Escalation:** outward"), null, "not on the first line");
  assert.equal(questionEscalation("**Escalation:**\nPost it?"), null);
  assert.equal(questionText("**Escalation:** outward\n\nPost it?"), "Post it?");
  assert.equal(questionText("Post it?"), "Post it?");
});

test("A11-257: the rule tells a run that failed, with no question open, to say what failed, and that the board marks the stop", () => {
  assert.match(ESCALATION_RULE, /A run that cannot go on because something failed, such as a skill that is missing or a check that never starts, has no question to decide: it says what failed in its `needs-human` reason, and the board shows that stop as "Off the escalation list:"/);
});

test("A11-277: the rule tells a run that an After-merge check the person's session runs is no stop, and names the session's queue and the route that closes it", () => {
  assert.match(ESCALATION_RULE, /An After-merge check that the person's session runs is not a stop either: the board sends it to the session's queue \(`GET \/api\/session-asks`/);
  assert.ok(ESCALATION_RULE.includes("`POST /api/after-merge/<KEY>/<n>`"));
  assert.ok(!/chairman/i.test(ESCALATION_RULE), "the rule names no organisation's own people: agent-org is public");
});

test("A11-275: the rule tells a run that an ask only the person's session can do is a `session` wait, not a stop, and names the two routes and what to do when it is not answered", () => {
  assert.match(ESCALATION_RULE, /An ask that only the person's session can do \(running something on the person's machine, reading the board, a live check against a release\) is not a stop either\./);
  assert.ok(ESCALATION_RULE.includes("`{ \"kind\": \"working\", \"reason\": \"...\", \"waitingOn\": [ { \"session\": \"<the exact command, where it runs, and what a pass looks like>\" } ], \"until\": \"<ISO time>\" }`"));
  assert.ok(ESCALATION_RULE.includes("`GET /api/session-asks`, as `kind: \"waiting-run\"`"));
  assert.ok(ESCALATION_RULE.includes("`POST /api/session-asks/<KEY>/answer`"));
  assert.ok(ESCALATION_RULE.includes("declare it again with a new `until`; never stop on it"));
  assert.ok(ESCALATION_RULE.includes("An After-merge check that the person's session runs is not a stop either"), "the first sentence stays beside it");
  assert.ok(offListRefusal("a needs-human outcome that names no item").includes(ESCALATION_RULE), "a stop that names no item is refused with those words");
});

test("A11-257: the needs-human example names an item of the list, and the file checks as it is written", () => {
  const example = OUTCOME_EXAMPLES["needs-human"];
  assert.ok(escalationItem(example.escalation) !== undefined);
  assert.equal(checkOutcome(JSON.stringify(example)).ok, true);
  assert.deepEqual(checkOutcome(JSON.stringify({ kind: "needs-human", reason: "r", escalation: "access" })), { ok: true, exact: true, outcome: { kind: "needs-human", reason: "r", escalation: "access" } });
  assert.match((checkOutcome(JSON.stringify({ kind: "needs-human", reason: "r", escalation: 3 })) as { problem: string }).problem, /needs-human escalation needs the id of an item of the escalation list, a string, you wrote a number/);
  assert.equal(checkOutcome(JSON.stringify({ kind: "needs-human", reason: "r" })).ok, true, "the file's shape leaves the id optional: the board writes needs-human for its own failures, and the hook judges an agent's");
});

test("A11-257: the planner, the worker, the review round and the reviewer all quote the one list", () => {
  const rendered = escalationList();
  const single = planBriefText({ ticket, ticketDir: "/d", planDir: "/d/plan", attachments: [], clones, run: "plan {key} into {dir}" });
  const batch = batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null }], runDir: "/d", planDir: "/d/plan", clones, run: "plan {keys} into {dir}" });
  const work = briefText({ ticket, folder: "/f", ticketDir: "/d", attachments: [], clones, worktreeCommand: "w", prOpenCommand: "pr:open" });
  const round = reviewBriefText({ ticket, folder: "/f", ticketDir: "/d", prs: [{ repo: "a/b", url: "https://github.com/a/b/pull/1" }], resumed: true });
  for (const [who, text] of [["the single planner", single], ["the batch planner", batch], ["the worker", work], ["the review round", round]] as const) {
    assert.ok(text.includes(rendered), `${who} quotes the list`);
    assert.ok(text.includes(ESCALATION_RULE), `${who} quotes the rule for everything else`);
  }
  assert.ok(planDecisionWords("- a decision", rendered).includes(rendered), "the reviewer's prompt carries the list it is handed");
  assert.ok(WORKER_NOTES.includes(rendered), "and so do the shipped house notes");
});

// no-token: gh -- herdr, the tracker and the clock are all injected for the pool tests; the rest is pure text
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import { herdrName } from "./pool.ts";
import { poolFixture } from "./pool-fixture.ts";
import { ticketDecisionsDefect } from "./plan-ticket-decisions.ts";
import type { Outcome } from "./queue/queue-entries-and-outcomes.ts";
import type { TicketSource } from "./source.ts";
import { ticketDir } from "./ticket-paths.ts";

const DECIDED = "## Problem\n\nIt is red.\n\n## Decisions (the chairman, 2026-10-25)\n\n* **Round cap:** keep the current wording.\n";
const plan = (decisions: string | null) => `# Plan\n\n## Approach\n\nChange the cap.\n\n${decisions === null ? "" : `## Ticket decisions\n\n${decisions}\n\n`}## Paths\n\n- \`agent-org:src/a.ts\`\n`;

test("A11-250: a plan for a ticket with Decisions must have a Ticket decisions section, and a Conflicts bullet in it is the defect", () => {
  assert.match(ticketDecisionsDefect([plan(null)], DECIDED) ?? "", /^the plan has no `## Ticket decisions` section, which the ticket's Decisions require/);
  assert.equal(ticketDecisionsDefect([plan("- Follows: round cap, in step 2.")], DECIDED), null, "POSITIVE CONTROL: a plan that follows");
  assert.equal(ticketDecisionsDefect([plan("* **Follows:** round cap.")], DECIDED), null, "bold and star bullets read the same");
  assert.equal(ticketDecisionsDefect([plan("- Follows: the cap.\n- Conflicts: \"keep the current wording\" against the plan's step 2, which rewords it.")], DECIDED),
    "the plan conflicts with a decision of the ticket: - Conflicts: \"keep the current wording\" against the plan's step 2, which rewords it.");
  assert.match(ticketDecisionsDefect([plan("* **Conflicts:** the cap.")], DECIDED) ?? "", /conflicts with a decision of the ticket: \* \*\*Conflicts:\*\* the cap\./);
});

test("A11-250: Conflicts: none is no conflict, a heading with more words is no Decisions section, and a Ticket decisions heading may carry more words", () => {
  for (const none of ["- Conflicts: none", "- Conflicts: None.", "* **Conflicts:** no conflicts", "- Conflicts: n/a"]) assert.equal(ticketDecisionsDefect([plan(`- Follows: x\n${none}`)], DECIDED), null, none);
  assert.match(ticketDecisionsDefect([plan("- Conflicts: a step rewords it")], DECIDED) ?? "", /conflicts with a decision/);
  assert.equal(ticketDecisionsDefect([plan(null)], "## Problem\n\n## Decisions needed\n\nWhich?\n"), null, "a question heading is not a Decisions section");
  assert.match(ticketDecisionsDefect([plan(null)], "## Problem\n\n## Decisions\n\n* one\n") ?? "", /^the plan has no/, "a bare Decisions heading is");
  assert.equal(ticketDecisionsDefect(["## Ticket decisions (all followed)\n\n- Follows: x\n"], DECIDED), null);
});

test("A11-250: a ticket with no Decisions section has nothing to follow: any plan passes, and a Decisions line inside a code fence is not a section", () => {
  assert.equal(ticketDecisionsDefect([plan(null)], "## Problem\n\nIt is red.\n"), null);
  assert.equal(ticketDecisionsDefect([plan(null)], "```md\n## Decisions (x, y)\n```\n"), null);
  assert.equal(ticketDecisionsDefect([plan(null)], ""), null);
  assert.equal(ticketDecisionsDefect([plan("- Conflicts: x")], "## Problem\n"), null, "not even a Conflicts bullet, for a ticket with nothing decided");
});

test("A11-250: the section is found in any of the plan's files, a Conflicts bullet inside a fence or under another heading is not one, and Behaviour alone does not require it", () => {
  assert.equal(ticketDecisionsDefect([plan(null), plan("- Follows: x")], DECIDED), null, "the second file has it");
  assert.equal(ticketDecisionsDefect([plan("- Follows: x\n\n```md\n- Conflicts: example\n```")], DECIDED), null, "an example in a fence");
  assert.equal(ticketDecisionsDefect(["## Ticket decisions\n\n- Follows: x\n\n## Notes\n\n- Conflicts: with nothing, this is about the notes\n"], DECIDED), null, "a bullet after the section ends");
  assert.equal(ticketDecisionsDefect([plan(null)], "## Behaviour\n\nIt blinks.\n"), null);
});

const fake = createFakeTracker();
const reasonOf = (outcome: Outcome | undefined): string => (outcome?.kind === "needs-human" ? outcome.reason : "");
const settled = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

/** A pool with A11-250 started as a planning run whose ticket's description is `description`, and a tracker that records what it is asked to attach. */
async function planning(description: string) {
  const attached: string[] = [];
  const source: TicketSource = { assigned: fake.assigned, read: fake.read, keywords: fake.keywords, download: fake.download, attachPlan: async (key) => { attached.push(key); return null; } };
  const made = poolFixture({ keys: ["A11-250"], max: 1, source, planFirst: ["A11-250"], descriptions: { "A11-250": description },
    tickets: { plan: "-plan-[^/]*\\.md$", planner: { run: "Run the planner with: unattended: plan {key} into {dir}", state: "Planned" } } });
  await made.pool.tick();
  const dir = ticketDir(made.settings, "A11-250");
  /** The planner writes `text` as its plan and ends on planned; the board settles it. */
  const end = async (text: string) => {
    writeFileSync(join(dir, "plan", "A11-250-0001-plan-answer.md"), text);
    writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "planned" }));
    made.status.set(herdrName("A11-250"), "idle");
    await made.pool.tick();
    await settled();
  };
  return { entry: () => made.entry("A11-250"), attached, end, brief: () => made.entry("A11-250").briefedAgainst?.description };
}

/** A planner for a ticket whose description is `description` ends on the plan `text`: what the board did with it. */
async function settledPlan(description: string, text: string) {
  const run = await planning(description);
  await run.end(text);
  return { outcome: run.entry().outcome, reason: reasonOf(run.entry().outcome), attached: run.attached, briefed: run.brief() };
}

test("A11-250: a plan with no Ticket decisions section for a ticket that has Decisions is refused, naming the defect, and nothing is attached", async () => {
  const refused = await settledPlan(DECIDED, plan(null));
  assert.equal(refused.briefed, DECIDED, "the planner was briefed with the Decisions");
  assert.equal(refused.outcome?.kind, "needs-human");
  assert.match(refused.reason, /^the plan does not follow the ticket's Decisions: the plan has no `## Ticket decisions` section/);
  assert.deepEqual(refused.attached, []);
});

test("A11-250: a plan that states a conflict with a decision is refused with the conflict as the question, and nothing is attached", async () => {
  const refused = await settledPlan(DECIDED, plan("- Conflicts: the round cap: the chairman said keep the wording, and step 2 rewords it."));
  assert.equal(refused.outcome?.kind, "needs-human");
  assert.match(refused.reason, /^the plan does not follow the ticket's Decisions: the plan conflicts with a decision of the ticket: - Conflicts: the round cap: the chairman said keep the wording, and step 2 rewords it\./);
  assert.deepEqual(refused.attached, []);
});

test("A11-250: a plan that follows the Decisions is attached, and so is any plan of a ticket with none", async () => {
  const follows = await settledPlan(DECIDED, plan("- Follows: the round cap keeps its wording."));
  assert.equal(follows.outcome, undefined);
  assert.deepEqual(follows.attached, ["A11-250"]);
  const none = await settledPlan("## Problem\n\nIt is red.\n", plan(null));
  assert.equal(none.outcome, undefined);
  assert.deepEqual(none.attached, ["A11-250"]);
});

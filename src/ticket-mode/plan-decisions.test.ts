// no-token: gh -- pure functions over the text of plans, handed in as strings; nothing here reads a tracker or spawns anything
import { test } from "node:test";
import assert from "node:assert/strict";
import { planDecisionsOf } from "./plan-decisions.ts";
import { stampedPlan } from "./plan-stamp.ts";
import { descriptionHash } from "./ticket-read.ts";

const PLAN = `# Plan

## Approach

Do it.

## Key decisions

- **The list is a module.** One place that every role reads.

## Out of scope

- Nothing else.

## Decisions made without a person

- Technical: the list lives in \`escalation.ts\`. Evidence: the ticket.
- Product: the pill says Held. Reason: the board's word for it.

## Behaviour

**Behaviour:** settled by the planner

- The pill is shown after the busy text. Reason: it is the status line.

## Paths

- \`agent-org:src/a.ts\`
`;

test("A11-257: a plan's decisions are its Key decisions, its Decisions made without a person, and the behaviour the planner settled", () => {
  const found = planDecisionsOf(PLAN) ?? "";
  assert.ok(found.includes("## Key decisions\n\n- **The list is a module.** One place that every role reads."));
  assert.ok(found.includes("## Decisions made without a person\n\n- Technical: the list lives in `escalation.ts`. Evidence: the ticket.\n- Product: the pill says Held."));
  assert.ok(found.includes("**Behaviour:** settled by the planner\n\n- The pill is shown after the busy text. Reason: it is the status line."));
  for (const notDecision of ["## Approach", "Do it.", "## Out of scope", "Nothing else.", "## Paths", "src/a.ts", "## Behaviour"]) {
    assert.equal(found.includes(notDecision), false, `${notDecision} is the plan, not a decision`);
  }
});

test("A11-257: the sections come in the order the plan has them, and a plan that records none has none", () => {
  const found = planDecisionsOf(PLAN) ?? "";
  assert.deepEqual([found.indexOf("## Key decisions"), found.indexOf("## Decisions made without a person"), found.indexOf("**Behaviour:** settled by the planner")].every((at, i, all) => at !== -1 && (i === 0 || at > all[i - 1])), true);
  assert.equal(planDecisionsOf("# Plan\n\n## Approach\n\nDo it.\n\n## Paths\n\n- `agent-org:src/a.ts`\n"), null);
});

test("A11-257: a sub-heading stays in its section, a fenced heading is an example, and the same section is quoted once", () => {
  const nested = "## Key decisions\n\n### The list\n\n- One module.\n\n## Paths\n";
  assert.equal(planDecisionsOf(nested), "## Key decisions\n\n### The list\n\n- One module.");
  assert.equal(planDecisionsOf("```md\n## Key decisions\n\n- an example\n```\n"), null);
  assert.equal(planDecisionsOf("## Key decisions\n\n- a\n\n## Key decisions\n\n- a\n"), "## Key decisions\n\n- a");
});

test("A11-257: the ticket quoted in a plan's stamp holds no decision of the plan's: its own headings are inside a quote", () => {
  const description = "## Key decisions\n\n- not the plan's\n\n**Behaviour:** settled by the planner\n";
  const stamped = stampedPlan("# Plan\n\n## Key decisions\n\n- the plan's own\n\n## Paths\n\n- `agent-org:src/a.ts`\n", { updatedAt: null, hash: descriptionHash(description), files: ["plan.md"], description });
  assert.equal(planDecisionsOf(stamped), "## Key decisions\n\n- the plan's own");
});

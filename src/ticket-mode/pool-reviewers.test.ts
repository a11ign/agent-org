// no-token: none -- a sweep over a hand-made context, with a code host that lists nothing and a gate that was never loaded in this file
//
// A11-161: with reviews required and the reviewer off, the sweep lists the open pull requests so each reads "waiting on the reviewer (off)". Where the gate does not load it cannot name the repositories to
// list, and it says so once and not on every sweep. This file loads no gate, so the gate does not load here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import type { PoolContext } from "./pool-context.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
import type { ReviewState } from "./reviewer-port.ts";
import { briefOf, reviewNewHeads } from "./pool-reviewers.ts";
import { escalationList } from "./escalation.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { ticketDir } from "./ticket-paths.ts";

test("A11-161: where the gate does not load, a sweep with reviews required and the reviewer off says once that the pull requests cannot be listed, lists none, and keeps showing the runs' own", async () => {
  const ctx = { reviewer: undefined, reviewerState: "off-required", codeHost: createFakeCodeHost(), offPulls: new Set<string>(), refusedHeads: new Set<string>(), settings: { clones: {} } } as unknown as PoolContext;
  const said: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((line: string) => { said.push(line); return true; }) as typeof process.stderr.write;
  try {
    for (let sweep = 0; sweep < 3; sweep += 1) await reviewNewHeads(ctx);
  } finally {
    process.stderr.write = write;
  }
  assert.equal(said.filter((line) => /cannot be listed for the board/.test(line)).length, 1, "said once, across three sweeps");
  assert.deepEqual([...ctx.offPulls], [], "nothing was listed");
});

// A11-213: the reviewer cannot read the tracker, so the ticket's explicit decisions reach it in the brief, from the run that holds the pull request.
const HELD_PR = "https://github.com/o/r/pull/7";
const DESCRIPTION = "## Problem\n\nThe policy must reach the second repository.\n\nThis step widens the policy by the chairman's decision on 2026-10-24.\n\n## Done-when\n\n### Before merge\n\n- applied";
const holding = (description: string, url = HELD_PR): PoolContext => ({ settings: { plan: null, stateDir: tmpDir("brief-held-") }, store: { get: () => ({ entries: [{ ticket: { key: "A11-203", description }, review: [{ repo: "r", url }] } as unknown as Entry] }) } }) as unknown as PoolContext;
const state = { view: { body: "" } } as unknown as ReviewState;

test("A11-213: a brief carries the decisions of the ticket whose run holds the pull request, with its Done-when", async () => {
  const brief = await briefOf(holding(DESCRIPTION), HELD_PR, state);
  assert.equal(brief.decisions, "This step widens the policy by the chairman's decision on 2026-10-24.");
  assert.match(brief.doneWhen ?? "", /^## Done-when/);
});

test("A11-213: a ticket with no decision, and a pull request no run holds, give a brief with none", async () => {
  assert.deepEqual(await briefOf(holding("## Problem\n\nA problem."), HELD_PR, state), { doneWhen: null });
  assert.deepEqual(await briefOf(holding(DESCRIPTION), "https://github.com/o/r/pull/8", state), { doneWhen: null }, "one a person opened has no ticket to quote");
});

// A11-249: the work the ticket's earlier pull requests held when they were closed unmerged reaches the reviewer too, from the records the board kept in the ticket's folder.
const CLOSED_COMMIT = "a".repeat(40);

/** A context whose run holds the pull request, with a record of closed pull request #14 that held one commit and one file in the ticket's folder, and a record of #15 that held nothing. */
function holdingWithClosedWork(): PoolContext {
  const ctx = holding(DESCRIPTION);
  const dir = join(ticketDir(ctx.settings, "A11-203"), "closed-pulls");
  mkdirSync(dir, { recursive: true });
  const base = { url: "https://github.com/o/r/pull/14", base: "main", branch: "admin/a11-229-x", head: CLOSED_COMMIT };
  writeFileSync(join(dir, "o-r-14.json"), JSON.stringify({ kind: "unique", number: 14, ...base, commits: [{ sha: CLOSED_COMMIT, subject: "feat: refuse unknown options" }], files: ["src/check-report.ts"], filesComplete: true }));
  writeFileSync(join(dir, "o-r-15.json"), JSON.stringify({ kind: "none", number: 15, ...base, url: "https://github.com/o/r/pull/15" }));
  return ctx;
}

test("A11-249: a brief carries the closed work of the ticket's earlier pull requests, one line per commit and file, and leaves out a pull request that held nothing", async () => {
  const closedWork = (await briefOf(holdingWithClosedWork(), HELD_PR, state)).closedWork ?? "";
  assert.ok(closedWork.includes(`- commit ${CLOSED_COMMIT} feat: refuse unknown options`) && closedWork.includes("- file src/check-report.ts") && closedWork.includes("work not on main"), closedWork);
  assert.ok(!closedWork.includes("#15"), "a record of kind none asks for no account");
});

test("A11-249: a ticket with no closed work gives a brief with no closedWork key", async () => {
  assert.equal("closedWork" in await briefOf(holding(DESCRIPTION), HELD_PR, state), false);
});

// A11-257: the plan's decisions reach the reviewer too, from the plan files the run holds, beside the ticket's own and with the escalation list.
const PLAN = "# Plan\n\n## Approach\n\nDo it.\n\n## Decisions made without a person\n\n- Product: the pill says Held. Reason: the board's word for it.\n\n## Paths\n\n- `agent-org:src/a.ts`\n";

/** A context whose run holds the pull request, on a machine that names its plan files, with the plan files `plans` (name to text) in the run's `paths` folder. */
function holdingWithPlan(description: string, plans: Record<string, string>): PoolContext {
  const settings = { plan: "plan", stateDir: tmpDir("brief-plan-") };
  const dir = join(ticketDir(settings as never, "A11-203"), "paths");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(plans)) writeFileSync(join(dir, name), text);
  return { ...holding(description), settings } as unknown as PoolContext;
}

test("A11-257: a brief carries the decisions of the plan the run holds, with the escalation list, beside the ticket's own", async () => {
  const brief = await briefOf(holdingWithPlan(DESCRIPTION, { "A11-203-0001-plan-x.md": PLAN }), HELD_PR, state);
  assert.equal(brief.planDecisions, "## Decisions made without a person\n\n- Product: the pill says Held. Reason: the board's word for it.");
  assert.equal(brief.escalation, escalationList());
  assert.equal(brief.decisions, "This step widens the policy by the chairman's decision on 2026-10-24.", "the ticket's decisions stay their own field, so the reviewer can rank them first");
});

test("A11-257: a plan that records no decision, no plan file, and a pull request no run holds, add nothing to the brief", async () => {
  const bare = "# Plan\n\n## Approach\n\nDo it.\n";
  assert.deepEqual(await briefOf(holdingWithPlan("## Problem\n\nA problem.", { "A11-203-0001-plan-x.md": bare }), HELD_PR, state), { doneWhen: null });
  assert.deepEqual(await briefOf(holdingWithPlan("## Problem\n\nA problem.", {}), HELD_PR, state), { doneWhen: null });
  assert.deepEqual(await briefOf(holdingWithPlan("## Problem\n\nA problem.", { "A11-203-0001-plan-x.md": PLAN }), "https://github.com/o/r/pull/8", state), { doneWhen: null }, "one a person opened has no plan to quote");
});

test("A11-257: a plan the board cannot read is not a plan with no decisions: the brief says so, and the reviewer is not left to re-raise what the plan may have decided", async () => {
  const ctx = holdingWithPlan(DESCRIPTION, {});
  mkdirSync(join(ticketDir((ctx as unknown as { settings: never }).settings, "A11-203"), "paths", "A11-203-0001-plan-x.md"));
  const written: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((line: string) => { written.push(line); return true; }) as typeof process.stderr.write;
  let brief: Awaited<ReturnType<typeof briefOf>>;
  try {
    brief = await briefOf(ctx, HELD_PR, state);
  } finally {
    process.stderr.write = write;
  }
  assert.match(brief.planDecisions ?? "", /^The board could not read this ticket's plan \(its plan file A11-203-0001-plan-x\.md could not be read/);
  assert.match(brief.planDecisions ?? "", /write a "Note \(not a finding\)" about it and approve on that point/);
  assert.equal(brief.escalation, escalationList(), "the list still goes with it");
  assert.ok(written.some((line) => /A11-203: .*so its reviewer is told the plan's decisions are unknown/.test(line)), written.join(""));
});

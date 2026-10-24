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

test("A11-161: where the gate does not load, a sweep with reviews required and the reviewer off says once that the pull requests cannot be listed, lists none, and keeps showing the runs' own", () => {
  const ctx = { reviewer: undefined, reviewerState: "off-required", codeHost: createFakeCodeHost(), offPulls: new Set<string>(), refusedHeads: new Set<string>(), settings: { clones: {} } } as unknown as PoolContext;
  const said: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((line: string) => { said.push(line); return true; }) as typeof process.stderr.write;
  try {
    for (let sweep = 0; sweep < 3; sweep += 1) reviewNewHeads(ctx);
  } finally {
    process.stderr.write = write;
  }
  assert.equal(said.filter((line) => /cannot be listed for the board/.test(line)).length, 1, "said once, across three sweeps");
  assert.deepEqual([...ctx.offPulls], [], "nothing was listed");
});

// A11-213: the reviewer cannot read the tracker, so the ticket's explicit decisions reach it in the brief, from the run that holds the pull request.
const HELD_PR = "https://github.com/o/r/pull/7";
const DESCRIPTION = "## Problem\n\nThe policy must reach the second repository.\n\nThis step widens the policy by the chairman's decision on 2026-10-24.\n\n## Done-when\n\n### Before merge\n\n- applied";
const holding = (description: string, url = HELD_PR): PoolContext => ({ store: { get: () => ({ entries: [{ ticket: { key: "A11-203", description }, review: [{ repo: "r", url }] } as unknown as Entry] }) } }) as unknown as PoolContext;
const state = { view: { body: "" } } as unknown as ReviewState;

test("A11-213: a brief carries the decisions of the ticket whose run holds the pull request, with its Done-when", () => {
  const brief = briefOf(holding(DESCRIPTION), HELD_PR, state);
  assert.equal(brief.decisions, "This step widens the policy by the chairman's decision on 2026-10-24.");
  assert.match(brief.doneWhen ?? "", /^## Done-when/);
});

test("A11-213: a ticket with no decision, and a pull request no run holds, give a brief with none", () => {
  assert.deepEqual(briefOf(holding("## Problem\n\nA problem."), HELD_PR, state), { doneWhen: null });
  assert.deepEqual(briefOf(holding(DESCRIPTION), "https://github.com/o/r/pull/8", state), { doneWhen: null }, "one a person opened has no ticket to quote");
});

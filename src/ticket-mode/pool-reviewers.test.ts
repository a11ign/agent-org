// no-token: none -- a sweep over a hand-made context, with a code host that lists nothing and a gate that was never loaded in this file
//
// A11-161: with reviews required and the reviewer off, the sweep lists the open pull requests so each reads "waiting on the reviewer (off)". Where the gate does not load it cannot name the repositories to
// list, and it says so once and not on every sweep. This file loads no gate, so the gate does not load here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import type { PoolContext } from "./pool-context.ts";
import { reviewNewHeads } from "./pool-reviewers.ts";

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

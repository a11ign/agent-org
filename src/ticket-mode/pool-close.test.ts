// no-token: gh -- herdr, the tracker, the clock and the restart reads are injected; the pool is driven over fakes and nothing is spawned
// A11-282: the close of an ended run's workspace holds no loop. It is asked through `herdrAsync` and left to end, a start waits for the closes that are out, and a close herdr refuses is never thrown into the pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { closedNoteAsync } from "../herdr-agents.ts";
import { poolFixture } from "./pool-fixture.ts";
import { herdrName } from "./pool.ts";
import { ticketDir } from "./ticket-paths.ts";
import { newPoolContext } from "./pool-context.ts";
import { closesSettled, closesSettledWithin, closeWorkspaceLater } from "./pool-close.ts";
import type { PoolDeps } from "./pool-context.ts";

const NEVER_USED = { assigned: async () => [], read: async () => { throw new Error("unused"); }, download: async () => [] };

/** A herdrAsync that holds each `workspace close` until `release` is called, and records every call it was asked. */
function holdingCloses() {
  const asked: string[][] = [];
  const held: Array<() => void> = [];
  const herdrAsync: NonNullable<PoolDeps["herdrAsync"]> = (args) => {
    asked.push(args);
    return args.includes("close") ? new Promise<string>((resolve) => { held.push(() => resolve("{}")); }) : Promise.resolve("{}");
  };
  return { asked, herdrAsync, release: () => held.splice(0).forEach((resolve) => resolve()) };
}

function contextOver(herdrAsync: NonNullable<PoolDeps["herdrAsync"]>) {
  const made = poolFixture();
  return newPoolContext(made.store, { settings: made.settings, source: NEVER_USED, codeHost: {} as never, hook: { node: "n", bin: "b" }, herdr: made.herdr.run, herdrAsync });
}

test("A11-282: closeWorkspaceLater asks herdr to close the workspace in the board's session and returns before herdr answers", async () => {
  const held = holdingCloses();
  const ctx = contextOver(held.herdrAsync);
  closeWorkspaceLater(ctx, "w7");
  assert.deepEqual(held.asked, [["--session", "tickets", "workspace", "close", "w7"]]);
  assert.equal(ctx.workspaceCloses.size, 1, "the close is out until herdr answers");
  held.release();
  await closesSettled(ctx);
  assert.equal(ctx.workspaceCloses.size, 0, "an answered close leaves nothing out");
});

test("A11-282: closesSettled waits for a close that is out, so a start opens its workspace after the one it replaces is closed", async () => {
  const held = holdingCloses();
  const ctx = contextOver(held.herdrAsync);
  closeWorkspaceLater(ctx, "w7");
  const states: string[] = [];
  const settled = closesSettled(ctx).then(() => states.push("settled"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(states, [], "still waiting while herdr has not answered");
  held.release();
  await settled;
  assert.deepEqual(states, ["settled"]);
});

test("A11-282: a close herdr refuses is not thrown into the pass and is no longer out", async () => {
  const ctx = contextOver(async () => { throw Object.assign(new Error("herdr exited 1"), { stdout: JSON.stringify({ error: { message: "workspace_not_found" } }) }); });
  closeWorkspaceLater(ctx, "w7");
  await closesSettled(ctx);
  assert.equal(ctx.workspaceCloses.size, 0);
});

test("A11-282: a run that ends is closed through herdrCall, and the pass's fill waits for that close without the pass holding the loop", async () => {
  const held = holdingCloses();
  const made = poolFixture({ keys: ["NBF-1"] });
  const pool = made.restart({ herdrAsync: (args, timeoutMs) => (args.includes("close") ? held.herdrAsync(args, timeoutMs) : Promise.resolve(made.herdr.run(args))) });
  await pool.tick();
  made.status.set(herdrName("NBF-1"), "working");
  await pool.tick();
  writeFileSync(join(ticketDir(made.settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "checked", reason: "nothing to change" }));
  made.status.set(herdrName("NBF-1"), "idle");
  let passed = false;
  const pass = pool.tick().then(() => { passed = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(held.asked.filter((args) => args.includes("close")).length, 1, "the ended run's workspace is closed through the async seam");
  assert.equal(made.herdr.calls.filter((args) => args.includes("close")).length, 0, "and not through the synchronous call that holds the board thread");
  assert.equal(passed, false, "the pass's fill waits for the close, so settleSessions never lists a workspace that is closing");
  held.release();
  await pass;
  assert.equal(passed, true);
});

test("A11-282: the pool's own herdr call says herdr's reason for a refused close, not the command line", async () => {
  const stubs = tmpDir("herdr-stub-");
  const stub = join(stubs, "herdr");
  writeFileSync(stub, "#!/bin/sh\necho 'error: workspace_is_busy' >&2\nexit 1\n");
  chmodSync(stub, 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${stubs}:${before}`;
  try {
    const made = poolFixture();
    const ctx = newPoolContext(made.store, { settings: made.settings, source: NEVER_USED, codeHost: {} as never, hook: { node: "n", bin: "b" } });
    const note = await closedNoteAsync((args) => ctx.herdrCall(args, 5_000), "w7", ctx.session);
    assert.match(note, /could NOT be closed \(error: workspace_is_busy\)/);
    assert.doesNotMatch(note, /Command failed/);
  } finally {
    process.env.PATH = before;
  }
});

test("A11-282: an ending instance waits for the closes it asked, and no longer than its limit", async () => {
  const held = holdingCloses();
  const ctx = contextOver(held.herdrAsync);
  closeWorkspaceLater(ctx, "w7");
  const started = Date.now();
  await closesSettledWithin(ctx, 40);
  assert.ok(Date.now() - started >= 30, "it waited for the close that herdr had not answered");
  assert.equal(ctx.workspaceCloses.size, 1, "and gave up on it at the limit, the close still out");
  held.release();
  await closesSettledWithin(ctx, 5_000);
  assert.equal(ctx.workspaceCloses.size, 0);
});

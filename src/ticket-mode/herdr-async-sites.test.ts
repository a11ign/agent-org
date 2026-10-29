// no-token: gh -- herdr, the tracker, the code host and the clock are injected; nothing is spawned
//
// THE BOARD THREAD'S herdr CALLS HOLD NO LOOP (A11-282). The board's figure is the number of synchronous calls of 100 ms or more the board thread made in the last hour, so each pass, sweep and event that still asked herdr
// with `ctx.herdr` counted. Every site here is run over a context whose synchronous `herdr` THROWS and whose asynchronous seam answers (the fixture's fake herdr): a site that still calls `ctx.herdr` fails with
// "synchronous herdr called", so each test fails on the base it was written against and passes once its site goes through `ctx.herdrCall`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
import { poolFixture } from "./pool-fixture.ts";
import { herdrName } from "./pool.ts";
import { newPoolContext, type PoolContext } from "./pool-context.ts";
import { closedOrGone } from "./pool-drain.ts";
import { answerStartDialog } from "./pool-start.ts";
import { readPrompt } from "./pool-decline.ts";
import { readScreen } from "./pool-resume.ts";
import { runTmpName } from "../session-tmp.ts";
import { ticketDir } from "./ticket-paths.ts";
import { SWEEP_GRACE_MS } from "./run-isolation.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";

const SYNCHRONOUS = "synchronous herdr called";
const synchronous = (): never => { throw new Error(SYNCHRONOUS); };
const KEY = "NBF-1";

/** A pool over `made` whose synchronous herdr throws and whose asynchronous seam answers as the fixture's fake does. */
function asyncOnly(made: ReturnType<typeof poolFixture>, over: Parameters<ReturnType<typeof poolFixture>["restart"]>[0] = {}) {
  return made.restart({ herdr: synchronous, herdrAsync: async (args) => made.herdr.run(args), ...over });
}

/** The context of a pool built over `made`, with the same deps `asyncOnly` gives. */
function contextOver(made: ReturnType<typeof poolFixture>): PoolContext {
  return newPoolContext(made.store, { settings: made.settings, source: createFakeTracker([fakeTicket(KEY)]), codeHost: {} as never, hook: { node: "/node", bin: "/tool/versions/v0.273.0/src/bin.ts" }, herdr: synchronous,
    herdrAsync: async (args) => made.herdr.run(args), restartReads: { bootId: () => "boot-1", herdrStart: () => "1" }, now: () => 100, wait: async () => {} });
}

test("A11-282: a pass over a running, then idle run, and the sweep of the run directories ask herdr only through the asynchronous seam", async () => {
  const base = tmpDir("herdr-async-base-");
  const made = poolFixture({ keys: [KEY], max: 1, privateTmpBase: base, now: () => Date.now() });
  // A directory no queue entry owns and nothing has touched for longer than the grace: whether it goes depends on herdr's listing being read.
  const stray = join(base, runTmpName("reviewer-gone"));
  mkdirSync(stray);
  utimesSync(stray, new Date(Date.now() - SWEEP_GRACE_MS - 1000), new Date(Date.now() - SWEEP_GRACE_MS - 1000));
  const pool = asyncOnly(made);
  await pool.tick();
  made.status.set(herdrName(KEY), "working");
  await pool.tick();
  assert.equal(made.entry(KEY).phase, "running");
  // The worker declares a wait and goes idle at its prompt: each pass reads the pane for background work (`paneBackground`).
  writeFileSync(join(ticketDir(made.settings, KEY), "outcome.json"), JSON.stringify({ kind: "working", reason: "waits for CI", waitingOn: "a build" }));
  made.status.set(herdrName(KEY), "idle");
  made.herdr.calls.length = 0;
  await pool.tick();
  assert.ok(made.herdr.calls.some((args) => args.includes("pane") && args.includes("read")), "the pane of the idle run was read, asynchronously");
  assert.equal(existsSync(stray), false, "the sweep listed herdr's sessions asynchronously and found the stray directory's session gone");
  assert.equal(made.entry(KEY).phase, "running");
});

test("A11-282: the start of an instance, reconcile with herdr and the check that its session answers, asks herdr only through the asynchronous seam", async () => {
  const made = poolFixture({ keys: [KEY], max: 1 });
  const pool = asyncOnly(made);
  await pool.ensureSession();
  await pool.reconcile();
  assert.ok(made.herdr.calls.length >= 2, "herdr was asked twice, and neither call threw");
});

test("A11-282: closing a workspace to stop a run (closedOrGone) waits for herdr without holding the loop, and a workspace that is gone is closed enough", async () => {
  const made = poolFixture({ keys: [KEY], max: 1 });
  const ctx = contextOver(made);
  const entry = { ticket: { key: KEY }, workspace: "w9" } as unknown as Entry;
  assert.equal(await closedOrGone(ctx, entry, "for the update"), true);
  assert.deepEqual(made.herdr.calls.at(-1)?.slice(-3), ["workspace", "close", "w9"]);
  made.herdr.closing.refusal = "workspace_not_found";
  assert.equal(await closedOrGone(ctx, entry, "for the update"), true, "a workspace herdr no longer has is gone");
  made.herdr.closing.refusal = "the pane is busy";
  assert.equal(await closedOrGone(ctx, entry, "for the update"), false, "any other refusal leaves the run running");
});

/** A run just started whose pane shows the trust dialog of its folder. */
function dialogOnScreen() {
  const made = poolFixture({ keys: [KEY], max: 1 });
  const ctx = contextOver(made);
  const place = { name: herdrName(KEY), pane: "w1:p1", folder: "/work/x", dir: "/work/x", repos: [] } as never;
  made.herdr.screens.set("w1:p1", "Is this a project you created or one you trust?\n/work/x\n❯ 1. Yes, I trust this folder\n");
  ctx.startedHere.add(herdrName(KEY));
  return { made, ctx, place };
}

test("A11-282: a pane is read for a start dialog, a safety prompt and its screen without holding the loop", async () => {
  const { made, ctx, place } = dialogOnScreen();
  assert.equal(await readScreen(ctx, place), made.herdr.screens.get("w1:p1"), "the screen read comes through herdrCall");
  assert.equal(await readPrompt(ctx, place), null, "a screen with no safety prompt reads as none");
  assert.equal(await answerStartDialog(ctx, place), true, "the start dialog is answered");
  assert.deepEqual(made.herdr.calls.at(-1)?.slice(-3), ["w1:p1", "down", "enter"], "with its keys, through the same seam");
});

test("A11-282: a start dialog both the settling after a start and the watch have read is answered once", async () => {
  const { made, ctx, place } = dialogOnScreen();
  const answered = await Promise.all([answerStartDialog(ctx, place), answerStartDialog(ctx, place)]);
  assert.deepEqual(answered.toSorted(), [false, true]);
  assert.equal(made.herdr.calls.filter((args) => args.includes("send-keys")).length, 1, "the keys went once");
});

test("A11-282: two closes of one parked run asked together close it once, and the second, refused because the workspace is gone, is no error", async () => {
  const made = poolFixture({ keys: [KEY], max: 1 });
  made.store.set({ ...made.store.get(), entries: made.store.get().entries.map((entry) => ({ ...entry, phase: "finished" as const, workspace: "w9", outcome: { kind: "needs-human" as const, reason: "r" } })) });
  // herdr takes the first close and finds no workspace for the second, as it does when the first has closed it.
  let closes = 0;
  const pool = made.restart({ herdr: synchronous, herdrAsync: async (args) => {
    if (!args.includes("close")) return made.herdr.run(args);
    closes += 1;
    if (closes > 1) throw Object.assign(new Error("herdr exited 1"), { stdout: JSON.stringify({ error: { message: "workspace_not_found" } }) });
    return made.herdr.run(args);
  } });
  await Promise.all([pool.close(KEY), pool.close(KEY)]);
  assert.equal(closes, 2, "both were asked");
  assert.equal(made.entry(KEY).workspace, undefined, "and the run is unparked");
  await pool.close(KEY);
  assert.equal(closes, 2, "a close of a run that is no longer parked asks herdr nothing and says nothing");
});

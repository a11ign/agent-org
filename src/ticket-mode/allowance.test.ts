// no-token: gh -- herdr, the tracker, the clock and the transcripts are fakes in a temporary folder; the pool is driven over them and nothing is spawned
// A11-434 (step 1 of 2): a worker out of Claude allowance is held as Waiting: allowance with its reset time, never ended as crashed, failed or for having no outcome
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { poolFixture } from "./pool-fixture.ts";
import { herdrName } from "./pool.ts";
import { ticketDir } from "./ticket-paths.ts";
import { reasonOf } from "./board-view/run-reason.ts";
import { runStatus } from "./board-view/pull-status-and-notes.ts";
import { clockOf } from "./board-view/update-banner.ts";
import { IDLE_RESUME_MS } from "./pool-resume.ts";
import { holdAllowance, holdChanges, showsLimitMenu, spentOnLimitMenu } from "./allowance.ts";
import { requeueForUpdate } from "./queue/queue-pins.ts";

const MIN = 60_000;
/** 13:00 UTC: the board's clock when the worker is refused. */
const T0 = Date.UTC(2026, 10, 13, 13, 0, 0);
/** 14:00 UTC, the reset the message names. */
const RESET = Date.UTC(2026, 10, 13, 14, 0, 0);
const SAID = "You've hit your session limit · resets 2pm (UTC)";
/** The limit menu as Claude Code 2.1.299 drew it on the host (captured 2026-10-13), with this test's reset. */
const MENU = [
  `  ⎿  ${SAID}`, "", "   What do you want to do?", "", "   ❯ 1. Stop and wait for limit to reset", "     2. Wait here, then continue automatically shortly",
  "     3. Switch to usage credits", "", "   Enter to confirm · Esc to cancel",
].join("\n");

/** One transcript line as Claude Code writes it: a reply of `role` saying `text` at `at`. */
const line = (role: "user" | "assistant", text: string, at: number): string =>
  JSON.stringify({ type: role, isSidechain: false, timestamp: new Date(at).toISOString(), message: { role, content: [{ type: "text", text }] } });

/** NBF-1 started and seen working, on a clock the test moves, with a transcript the test writes to. */
async function liveRun() {
  let clock = T0 - 30 * MIN;
  const made = poolFixture({ keys: ["NBF-1"], max: 1, now: () => clock });
  await made.pool.tick();
  const name = herdrName("NBF-1");
  made.status.set(name, "working");
  await made.pool.tick();
  const dir = join(made.root, "transcripts", "-ticket-folder");
  mkdirSync(dir, { recursive: true });
  const transcript = join(dir, `session-${name}.jsonl`);
  const lines: string[] = [line("user", "Read the brief and follow it.", clock)];
  const say = (role: "user" | "assistant", text: string, at = clock) => {
    lines.push(line(role, text, at));
    writeFileSync(transcript, `${lines.join("\n")}\n`);
    utimesSync(transcript, new Date(at), new Date(at));
  };
  say("assistant", "Reading the brief.");
  const advance = async (ms: number) => { clock += ms; await made.pool.tick(); await new Promise<void>((resolve) => { setImmediate(resolve); }); };
  const prompts = () => made.herdr.calls.filter((args) => args[3] === "prompt" || args[3] === "send-keys");
  const status = (value: string) => made.status.set(name, value);
  return { ...made, name, say, status, advance, prompts, now: () => clock, set: (at: number) => { clock = at; } };
}

/** NBF-1 refused at 13:00 with the reset at 14:00 as its last reply, its agent idle, and the board's next pass made. */
async function refusedIdle() {
  const run = await liveRun();
  run.set(T0);
  run.say("assistant", SAID);
  run.status("idle");
  await run.advance(MIN);
  return run;
}

test("A11-434 AC1: a worker idle on the usage-limit message with a reset at 14:00 reads Waiting: allowance until 14:00, and is neither crashed nor failed", async () => {
  const run = await refusedIdle();
  const entry = run.entry("NBF-1");
  assert.equal(entry.phase, "running", "not ended: before this it was ended `no-outcome` (Failed)");
  assert.equal(entry.outcome, undefined, "no crashed, failed or no-outcome outcome is recorded");
  assert.deepEqual(entry.allowance, { until: RESET, text: SAID, since: T0 + MIN });
  assert.equal(runStatus(entry), "waiting");
  assert.equal(reasonOf(entry, run.now()).line, `Waiting: allowance until ${clockOf(RESET)}`);
  // Long past the idle resume and the stall clocks, before the reset: still held, and nothing is typed into its pane.
  await run.advance(3 * IDLE_RESUME_MS);
  assert.equal(run.entry("NBF-1").phase, "running");
  assert.equal(run.entry("NBF-1").working?.stalled, undefined, "not marked stalled");
  assert.deepEqual(run.prompts(), [], "not resumed: a prompt would be refused again");
  assert.equal(reasonOf(run.entry("NBF-1"), run.now()).line, `Waiting: allowance until ${clockOf(RESET)}`);
});

test("A11-434 AC1: a worker blocked on the limit menu reads Waiting: allowance, not Needs you, and no key is sent to the menu", async () => {
  const run = await liveRun();
  run.set(T0);
  run.say("assistant", SAID);
  run.herdr.screens.set(String(run.entry("NBF-1").pane), MENU);
  run.status("blocked");
  await run.advance(MIN);
  const entry = run.entry("NBF-1");
  assert.equal(entry.waiting, false, "before this it was marked waiting on a person, with the menu's first line");
  assert.equal(runStatus(entry), "waiting", "not needs-you");
  assert.equal(entry.allowance?.until, RESET);
  assert.deepEqual(run.prompts(), []);
});

test("A11-434: a blocked worker whose transcript has not said it is held from its limit menu, with the reset the menu's line names", async () => {
  const run = await liveRun();
  run.set(T0);
  run.herdr.screens.set(String(run.entry("NBF-1").pane), MENU);
  run.status("blocked");
  await run.advance(MIN);
  assert.deepEqual(run.entry("NBF-1").allowance, { until: RESET, text: SAID, since: T0 + MIN });
  assert.equal(runStatus(run.entry("NBF-1")), "waiting");
});

test("A11-434: the hold is dropped when the worker works again, and the run then ends on its own outcome as any run does", async () => {
  const run = await refusedIdle();
  assert.notEqual(run.entry("NBF-1").allowance, undefined);
  run.say("user", "carry on", RESET + MIN);
  run.status("working");
  await run.advance(62 * MIN);
  assert.equal(run.entry("NBF-1").allowance, undefined);
  assert.equal(runStatus(run.entry("NBF-1")), "working");
  writeFileSync(join(ticketDir(run.settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "checked", reason: "nothing to change" }));
  run.status("idle");
  await run.advance(MIN);
  assert.deepEqual([run.entry("NBF-1").phase, run.entry("NBF-1").outcome?.kind, run.entry("NBF-1").allowance], ["finished", "checked", undefined]);
});

test("A11-434: once the reset has passed the card says the allowance was due back then, and the run is still not ended (step 2 resumes it)", async () => {
  const run = await refusedIdle();
  await run.advance(RESET - run.now() + MIN);
  assert.equal(run.entry("NBF-1").phase, "running");
  assert.equal(reasonOf(run.entry("NBF-1"), run.now()).line, `Waiting: allowance, due back at ${clockOf(RESET)}`);
});

test("A11-434: a limit message said before the run started is not this run's: the idle worker with no outcome ends as it always did", async () => {
  const run = await liveRun();
  run.say("assistant", SAID, T0 - 60 * MIN);
  run.status("idle");
  await run.advance(MIN);
  assert.equal(run.entry("NBF-1").allowance, undefined);
  assert.equal(run.entry("NBF-1").outcome?.kind, "no-outcome", "kept: an idle worker with no outcome, and no allowance message of its own, is ended");
});

test("A11-434: a worker that wrote a final outcome is settled on it, even when its last reply is the limit message", async () => {
  const run = await liveRun();
  run.set(T0);
  writeFileSync(join(ticketDir(run.settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "checked", reason: "nothing to change" }));
  run.say("assistant", SAID);
  run.status("idle");
  await run.advance(MIN);
  assert.deepEqual([run.entry("NBF-1").phase, run.entry("NBF-1").outcome?.kind, run.entry("NBF-1").allowance], ["finished", "checked", undefined]);
});

test("A11-434: the limit menu is told from other dialogs by both of its option lines; a menu whose message scrolled away holds an hour, or as long as its hold says", () => {
  assert.equal(showsLimitMenu(MENU), true);
  assert.equal(showsLimitMenu("Do you want to proceed?\n ❯ 1. Yes\n   2. No"), false);
  const scrolled = MENU.split("\n").slice(1).join("\n");
  assert.deepEqual(spentOnLimitMenu(scrolled, T0), { text: "Claude Code's limit menu", until: T0 + 60 * MIN });
  assert.equal(spentOnLimitMenu(scrolled, T0 + 30 * MIN, { until: RESET, text: SAID, since: T0 })?.until, RESET);
  assert.equal(spentOnLimitMenu("idle at a prompt", T0), null);
});

test("A11-434: a held worker that answered again between two passes, seen idle both times, has its hold dropped, and is then ended for having no outcome as any idle run is", async () => {
  const run = await refusedIdle();
  assert.notEqual(run.entry("NBF-1").allowance, undefined);
  // Someone typed into its terminal after the reset; it answered in a short turn the board never saw as working.
  run.say("user", "carry on", RESET + MIN);
  run.say("assistant", "Done for now.", RESET + 2 * MIN);
  await run.advance(62 * MIN);
  assert.equal(run.entry("NBF-1").allowance, undefined, "the transcript read clear: the hold is not kept until herdr happens to read it working");
  assert.equal(run.entry("NBF-1").outcome?.kind, "no-outcome");
});

test("A11-434: a worker held on the limit menu that then sits on another dialog has its hold dropped, and reads Needs you on it", async () => {
  const run = await liveRun();
  run.set(T0);
  const pane = String(run.entry("NBF-1").pane);
  run.herdr.screens.set(pane, MENU);
  run.status("blocked");
  await run.advance(MIN);
  assert.notEqual(run.entry("NBF-1").allowance, undefined);
  run.herdr.screens.set(pane, "Update available! 0.162.1 -> 0.163.0\n\n  1. Update now\n  2. Skip\n\n  Press enter to continue");
  await run.advance(MIN);
  assert.equal(run.entry("NBF-1").allowance, undefined);
  assert.equal(runStatus(run.entry("NBF-1")), "needs-you", "its other dialog is answered or shown as it always was");
});

test("A11-434: a run held on the allowance and stopped for an update is queued again without its hold", () => {
  const queue = { max: 1, entries: [{ ticket: { key: "NBF-1" }, phase: "running", queuedAt: 0, workspace: "w1", allowance: { until: RESET, text: SAID, since: T0 } }] } as never;
  const requeued = requeueForUpdate(queue, "NBF-1", "v0.343.0", T0 + MIN) as { entries: readonly { phase: string; allowance?: unknown }[] };
  assert.deepEqual([requeued.entries[0].phase, requeued.entries[0].allowance], ["queued", undefined]);
});

test("A11-434: a hold already on the same message and reset changes nothing, so a pass writes nothing for it", () => {
  const spent = { until: RESET, text: SAID };
  const held = holdAllowance({ max: 1, entries: [{ ticket: { key: "NBF-1" }, phase: "running", queuedAt: 0, waiting: true, prompt: "What do you want to do?" }] } as never, "NBF-1", spent, T0);
  const entry = held.entries[0];
  assert.equal(holdChanges(entry, spent), false);
  assert.equal(holdChanges(entry, { ...spent, until: RESET + 60 * MIN }), true, "a later reset is recorded");
  assert.equal(holdChanges({ ...entry, waiting: true }, spent), true, "a dialog marked since is cleared");
});

test("A11-434: a short-form reset read from the pane after it has passed keeps the reset the run was held with, not the next day's", () => {
  const held = { until: RESET, text: SAID, since: T0 };
  assert.equal(spentOnLimitMenu(MENU, RESET + 5 * MIN, held)?.until, RESET);
  assert.equal(spentOnLimitMenu(MENU, RESET + 5 * MIN)?.until, RESET + 24 * 60 * MIN, "read cold, the same words name tomorrow's 2pm");
});

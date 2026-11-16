// no-token: gh -- herdr, the tracker, the clock and the transcripts are fakes in a temporary folder; the pool is driven over them and nothing is spawned
// A11-434 (step 2 of 2): a spent Claude allowance holds every new start until its reset, and the runs parked on it are resumed after it without a person
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ticketDir } from "./ticket-paths.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { ALLOWANCE_BACK_PROMPT, ALLOWANCE_RETRY_MS } from "./allowance.ts";
import { ALLOWANCE_GRACE_MS, allowanceHolds, holdStarts, loadQueue, nextStarts, saveQueue, writerToStart } from "./queue.ts";
import { RESUME_PROMPT } from "./pool-resume.ts";
import { whyNothingStarts } from "./pool-start.ts";
import { liveRuns, MENU, MIN, RESET, SAID, T0 } from "./allowance-fixture.ts";
import type { Entry, Queue } from "./queue/queue-entries-and-outcomes.ts";

/** When the board treats the 14:00 allowance as back: a margin after the reset the message names. */
const DUE = RESET + ALLOWANCE_GRACE_MS;

type Runs = Awaited<ReturnType<typeof liveRuns>>;

/** Each of `keys` refused at 13:00 with the reset at 14:00 as its last reply, its agent idle, and the board's next pass made. */
async function refuse(runs: Runs, keys: readonly string[]): Promise<Runs> {
  runs.set(T0);
  for (const key of keys) {
    runs.say(key, "assistant", SAID);
    runs.status(key, "idle");
  }
  await runs.advance(MIN);
  return runs;
}

/** NBF-1 and NBF-2 running, both refused at 13:00. */
const twoRefused = async (): Promise<Runs> => refuse(await liveRuns(["NBF-1", "NBF-2"], 2), ["NBF-1", "NBF-2"]);

/** NBF-1 refused at 13:00 and blocked on the limit menu, held, with the board's next pass made. */
async function onLimitMenu(): Promise<Runs> {
  const runs = await liveRuns(["NBF-1"], 1);
  runs.set(T0);
  runs.say("NBF-1", "assistant", SAID);
  runs.herdr.screens.set(String(runs.entry("NBF-1").pane), MENU);
  runs.status("NBF-1", "blocked");
  await runs.advance(MIN);
  return runs;
}

/** `key` writes a final outcome and goes idle at `at`, and the board's next pass, a minute later, settles it: its slot is free. */
async function finishAt(runs: Runs, key: string, at: number): Promise<void> {
  runs.set(at);
  writeFileSync(join(ticketDir(runs.settings, key), "outcome.json"), JSON.stringify({ kind: "checked", reason: "nothing to change" }));
  runs.status(key, "idle");
  await runs.advance(MIN);
}

const sentTo = (runs: Runs, key: string): readonly string[][] =>
  runs.prompts().filter((args) => args[4] === runs.entry(key).pane);

test("A11-434 AC2: with the allowance spent until 14:00 and two tickets queued, a slot that frees at 13:10 starts no run before 14:00, and one starts after it", async () => {
  const runs = await refuse(await liveRuns(["NBF-1", "NBF-2", "NBF-3", "NBF-4"], 2), ["NBF-1"]);
  assert.equal(runs.store.get().allowance?.until, RESET, "the hold is the account's, recorded on the queue");
  // NBF-2 finishes at 13:10: its slot is free.
  await finishAt(runs, "NBF-2", T0 + 9 * MIN);
  assert.equal(runs.entry("NBF-2").phase, "finished");
  for (let at = 0; at < 49; at += 1) await runs.advance(MIN);
  assert.ok(runs.now() < RESET);
  assert.deepEqual(["NBF-3", "NBF-4"].map((key) => runs.entry(key).phase), ["queued", "queued"], "before this NBF-3 started at 13:10, into a refusal");
  assert.match(String(whyNothingStarts(runs.store.get(), 1, 14, runs.now())), /the Claude allowance is spent until 2026-11-13T14:00:00\.000Z/);
  await runs.advance(2 * MIN);
  assert.equal(runs.entry("NBF-3").phase, "queued", "14:01: inside the margin after the reset, still held");
  await runs.advance(DUE - runs.now());
  assert.notEqual(runs.entry("NBF-3").phase, "queued", "the reset has passed: the free slot is used");
});

test("A11-434 AC3: two runs parked on the allowance are both resumed after 14:00 without a person, and not before", async () => {
  const runs = await twoRefused();
  await runs.advance(RESET - runs.now() - MIN);
  assert.deepEqual(runs.prompts(), [], "nothing is typed into a pane before the reset");
  await runs.advance(DUE - runs.now());
  for (const key of ["NBF-1", "NBF-2"]) {
    assert.deepEqual(sentTo(runs, key).map((args) => args[5]), [ALLOWANCE_BACK_PROMPT], `${key} is told to carry on, once`);
    assert.equal(runs.entry(key).phase, "running");
  }
  // Each takes the prompt and works: its hold is dropped, and it runs on as any run does.
  for (const key of ["NBF-1", "NBF-2"]) {
    runs.say(key, "user", ALLOWANCE_BACK_PROMPT);
    runs.status(key, "working");
  }
  await runs.advance(MIN);
  assert.deepEqual(["NBF-1", "NBF-2"].map((key) => [runs.entry(key).phase, runs.entry(key).allowance]), [["running", undefined], ["running", undefined]]);
});

test("A11-434: a run on the limit menu at the reset has the menu cancelled with Esc, then is told to carry on", async () => {
  const runs = await onLimitMenu();
  const pane = String(runs.entry("NBF-1").pane);
  assert.deepEqual(runs.prompts(), []);
  await runs.advance(DUE - runs.now());
  assert.deepEqual(runs.prompts().map((args) => args.slice(3)), [["send-keys", pane, "esc"], ["prompt", pane, ALLOWANCE_BACK_PROMPT]]);
});

test("A11-434: a run told to carry on whose agent has not taken it is not told again on every pass, only after the retry wait", async () => {
  const runs = await refuse(await liveRuns(["NBF-1"], 1), ["NBF-1"]);
  await runs.advance(DUE - runs.now());
  assert.equal(runs.prompts().length, 1);
  for (let at = MIN; at < ALLOWANCE_RETRY_MS; at += MIN) await runs.advance(MIN);
  assert.equal(runs.prompts().length, 1, "still held, and not prompted again within the retry wait");
  assert.equal(runs.entry("NBF-1").phase, "running", "nor ended for having no outcome");
  await runs.advance(MIN);
  assert.equal(runs.prompts().length, 2);
});

test("A11-434: the queue's hold on starts lapses at its reset, is never shortened by an earlier one, survives a restart, and holds check runs as a pause does", () => {
  const base = { entries: [], max: 2, paused: false } as Queue;
  const held = holdStarts(base, { text: SAID, until: RESET });
  assert.deepEqual([allowanceHolds(held, DUE - 1), allowanceHolds(held, DUE), allowanceHolds(held)], [true, false, false]);
  assert.equal(holdStarts(held, { text: "earlier", until: RESET - 30 * MIN }), held, "an earlier reset leaves the later one");
  assert.equal(holdStarts(held, { text: "later", until: RESET + 30 * MIN }).allowance?.until, RESET + 30 * MIN);
  const path = join(tmpDir("allowance-queue-"), "queue.json");
  saveQueue(path, held);
  assert.deepEqual(loadQueue(path, 2).allowance, { text: SAID, until: RESET });
  const writers = [{ id: "v1", phase: "queued", mode: "verify" }, { id: "q1", phase: "queued", mode: "quick" }];
  const withWriters = { ...held, writers } as never as Queue;
  assert.equal(writerToStart(withWriters, DUE - 1)?.id, "q1", "a check run waits; a person's request starts");
  assert.equal(writerToStart(withWriters, DUE)?.id, "v1");
});

test("A11-434: a held run stopped while the board reads its pane at the reset is not told to carry on", async () => {
  const runs = await onLimitMenu();
  // The person stops the run while herdr answers the read of its limit menu.
  const shown = runs.herdr.screens;
  const read = shown.get.bind(shown);
  shown.get = (target: string) => {
    if (runs.now() >= RESET) runs.store.set({ ...runs.store.get(), entries: runs.store.get().entries.map((e) => ({ ...e, phase: "finished" as const })) });
    return read(target);
  };
  await runs.advance(DUE - runs.now());
  assert.deepEqual(runs.prompts().filter((args) => args[3] === "prompt"), [], "before this the stopped run was prompted");
});

test("A11-434: a held run that answers again before the reset drops the hold on starts with its own, so a queued run starts then and not at the reset", async () => {
  const runs = await refuse(await liveRuns(["NBF-1", "NBF-2", "NBF-3"], 2), ["NBF-1"]);
  await finishAt(runs, "NBF-2", T0 + 9 * MIN);
  assert.equal(runs.entry("NBF-3").phase, "queued");
  // A person switches NBF-1 to usage credits at 13:20, and it works again.
  runs.say("NBF-1", "user", "3", T0 + 20 * MIN);
  runs.status("NBF-1", "working");
  await runs.advance(10 * MIN);
  assert.equal(runs.store.get().allowance, undefined, "before this the hold on starts stayed until 14:00");
  await runs.advance(MIN);
  assert.notEqual(runs.entry("NBF-3").phase, "queued");
});

test("A11-434: a board restart neither prompts a held run before its reset nor prompts it twice after it", async () => {
  const runs = await refuse(await liveRuns(["NBF-1"], 1), ["NBF-1"]);
  let boot = "boot-1";
  const restarted = runs.restart({ restartReads: { bootId: () => boot, herdrStart: () => "1" } });
  const restartAt = async (at: number, id: string) => {
    runs.set(at);
    boot = id;
    await restarted.tick();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  };
  await restartAt(T0 + 30 * MIN, "boot-2");
  assert.deepEqual(runs.prompts(), [], "before this the restart's resume prompt went to a run whose allowance was still spent");
  await restartAt(DUE + MIN, "boot-3");
  assert.deepEqual(runs.prompts().map((args) => args[5]), [ALLOWANCE_BACK_PROMPT], `before this ${RESUME_PROMPT.slice(0, 20)}… went first, in the same pass`);
});

test("A11-434: a talk session starts while the allowance is spent, since a person is at its terminal; a ticket run beside it does not", () => {
  const ready = { phase: "queued", queuedAt: 0, blockers: [], blockersReadAt: RESET, paths: [] };
  const entries = [{ ...ready, ticket: { key: "NBF-1" }, talk: true }, { ...ready, ticket: { key: "NBF-2" } }] as never as readonly Entry[];
  const queue = holdStarts({ entries, max: 2, paused: false } as Queue, { text: SAID, until: RESET });
  assert.deepEqual(nextStarts(queue, 1, 14, T0).map((entry) => entry.ticket.key), ["NBF-1"]);
  assert.deepEqual(nextStarts(queue, 1, 14, DUE).map((entry) => entry.ticket.key), ["NBF-1", "NBF-2"]);
});

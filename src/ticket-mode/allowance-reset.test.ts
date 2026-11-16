// no-token: gh -- herdr, the tracker, the clock and the transcripts are fakes in a temporary folder; the pool is driven over them and nothing is spawned
// A11-434 (step 2 of 2): a spent Claude allowance holds every new start until its reset, and the runs parked on it are resumed after it without a person
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ticketDir } from "./ticket-paths.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { ALLOWANCE_BACK_PROMPT, ALLOWANCE_RETRY_MS } from "./allowance.ts";
import { allowanceHolds, holdStarts, loadQueue, saveQueue, writerToStart } from "./queue.ts";
import { whyNothingStarts } from "./pool-start.ts";
import { liveRuns, MENU, MIN, RESET, SAID, T0 } from "./allowance-fixture.ts";
import type { Queue } from "./queue/queue-entries-and-outcomes.ts";

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

const sentTo = (runs: Runs, key: string): readonly string[][] =>
  runs.prompts().filter((args) => args[4] === runs.entry(key).pane);

test("A11-434 AC2: with the allowance spent until 14:00 and two tickets queued, a slot that frees at 13:10 starts no run before 14:00, and one starts after it", async () => {
  const runs = await refuse(await liveRuns(["NBF-1", "NBF-2", "NBF-3", "NBF-4"], 2), ["NBF-1"]);
  assert.equal(runs.store.get().allowance?.until, RESET, "the hold is the account's, recorded on the queue");
  // NBF-2 finishes at 13:10: its slot is free.
  runs.set(T0 + 9 * MIN);
  writeFileSync(join(ticketDir(runs.settings, "NBF-2"), "outcome.json"), JSON.stringify({ kind: "checked", reason: "nothing to change" }));
  runs.status("NBF-2", "idle");
  await runs.advance(MIN);
  assert.equal(runs.entry("NBF-2").phase, "finished");
  for (let at = 0; at < 49; at += 1) await runs.advance(MIN);
  assert.ok(runs.now() < RESET);
  assert.deepEqual(["NBF-3", "NBF-4"].map((key) => runs.entry(key).phase), ["queued", "queued"], "before this NBF-3 started at 13:10, into a refusal");
  assert.match(String(whyNothingStarts(runs.store.get(), 1, 14, runs.now())), /the Claude allowance is spent until 2026-11-13T14:00:00\.000Z/);
  await runs.advance(2 * MIN);
  assert.notEqual(runs.entry("NBF-3").phase, "queued", "the reset has passed: the free slot is used");
});

test("A11-434 AC3: two runs parked on the allowance are both resumed after 14:00 without a person, and not before", async () => {
  const runs = await twoRefused();
  await runs.advance(RESET - runs.now() - MIN);
  assert.deepEqual(runs.prompts(), [], "nothing is typed into a pane before the reset");
  await runs.advance(2 * MIN);
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
  await runs.advance(RESET - runs.now() + MIN);
  assert.deepEqual(runs.prompts().map((args) => args.slice(3)), [["send-keys", pane, "esc"], ["prompt", pane, ALLOWANCE_BACK_PROMPT]]);
});

test("A11-434: a run told to carry on whose agent has not taken it is not told again on every pass, only after the retry wait", async () => {
  const runs = await refuse(await liveRuns(["NBF-1"], 1), ["NBF-1"]);
  await runs.advance(RESET - runs.now() + MIN);
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
  assert.deepEqual([allowanceHolds(held, RESET - 1), allowanceHolds(held, RESET), allowanceHolds(held)], [true, false, false]);
  assert.equal(holdStarts(held, { text: "earlier", until: RESET - 30 * MIN }), held, "an earlier reset leaves the later one");
  assert.equal(holdStarts(held, { text: "later", until: RESET + 30 * MIN }).allowance?.until, RESET + 30 * MIN);
  const path = join(tmpDir("allowance-queue-"), "queue.json");
  saveQueue(path, held);
  assert.deepEqual(loadQueue(path, 2).allowance, { text: SAID, until: RESET });
  const writers = [{ id: "v1", phase: "queued", mode: "verify" }, { id: "q1", phase: "queued", mode: "quick" }];
  const withWriters = { ...held, writers } as never as Queue;
  assert.equal(writerToStart(withWriters, RESET - MIN)?.id, "q1", "a check run waits; a person's request starts");
  assert.equal(writerToStart(withWriters, RESET)?.id, "v1");
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
  await runs.advance(RESET - runs.now() + MIN);
  assert.deepEqual(runs.prompts().filter((args) => args[3] === "prompt"), [], "before this the stopped run was prompted");
});

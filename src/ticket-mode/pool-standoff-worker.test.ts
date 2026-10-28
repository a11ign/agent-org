// no-token: gh -- the code host, the reviewer, herdr, the tracker and the clock are all injected fakes; nothing is spawned
// module: the worker's round for a stand-off, and the A11-213 flag behind both routes (A11-290)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { herdrName } from "./pool-herdr.ts";
import { clock, MINUTE, settled, standoffRun } from "./pool-standoff-fixture.ts";
import { isStaleBlockNote, STALE_BLOCK_MINUTES } from "./board-view/stale-block.ts";
import { ticketDir } from "./ticket-paths.ts";
import { STANDOFF_ROUND_FILE } from "./standoff-files.ts";

/** The reviewer's block as the watch reads it, so the pull request's head is recorded blocked. */
const BLOCKED = { verdictAtHead: "changes-requested", reviewDecision: "changes-requested" } as const;

/** A stand-off sent to the worker, whose round has started (or, with `start: false`, is queued). */
async function workerRound({ start = true }: { start?: boolean } = {}) {
  const run = await standoffRun();
  run.pull.feedback = { ...BLOCKED };
  run.startRereview("Fixed in the description: the measurement is redone, 340 KB.");
  run.refuseRereview();
  run.pool.watchFeedback();
  if (start) {
    clock.ms += MINUTE;
    await run.pool.tick();
    await settled();
  }
  const dir = ticketDir(run.fixture.settings, "NBF-1");
  return { ...run, dir };
}

test("A11-290: the worker's round carries the re-reviewer's reasons, says a reply with no change is refused, and leaves the Stop hook the head and the description as they were", async () => {
  const { dir, entry, url } = await workerRound();
  assert.equal(entry().phase, "running");
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.match(brief, /stand-off round/);
  assert.ok(brief.includes("is still not convinced") && brief.includes("340 KB"), "the reasons are in the brief");
  assert.match(brief, /A second reply with no change at this head is refused by the Stop hook/);
  assert.match(brief, /Write `reviewed` only when each reason is met by a change/);
  const began = JSON.parse(readFileSync(join(dir, STANDOFF_ROUND_FILE), "utf8")) as Record<string, { head: string; body: string }>;
  assert.equal(began[url].head, "h1");
  assert.match(began[url].body, /^[0-9a-f]{64}$/);
});

test("A11-290: a stand-off round that ends reviewed is the end of both routes; the flag then fires at 30 minutes and says what the reviewer, the worker and the planner said", async () => {
  const { dir, entry, pool, fixture } = await workerRound();
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "reviewed" }));
  fixture.status.set(herdrName("NBF-1"), "idle");
  await pool.tick();
  await settled();
  assert.equal(entry().phase, "finished");
  assert.equal(entry().standoff?.stage, "done", "the worker's route has ended too");
  pool.watchFeedback();
  assert.equal(entry().handedBack, undefined, "the block was first read just now: the flag counts from it");
  clock.ms += (STALE_BLOCK_MINUTES + 1) * MINUTE;
  pool.watchFeedback();
  const note = entry().handedBack ?? "";
  assert.ok(isStaleBlockNote(note), note);
  assert.match(note, /The reviewer last said: The 200 KB limit is still exceeded/);
  assert.match(note, /the worker last said: Fixed in the description: the measurement is redone, 340 KB\./);
  assert.match(note, /the planner was not asked$/);
  await settled();
});

test("A11-290: the flag does not fire while the stand-off has a route to go, however long the block has stood", async () => {
  const run = await workerRound({ start: false });
  assert.ok(["queued", "starting"].includes(run.entry().phase), "the worker's round is queued (and, nothing holding it, starting): no flag for a run with a round");
  assert.ok(!existsSync(join(run.dir, STANDOFF_ROUND_FILE)), "and it has not started");
  clock.ms += 3 * 60 * MINUTE;
  run.pool.watchFeedback();
  assert.equal(run.entry().handedBack, undefined);
  await settled();
});

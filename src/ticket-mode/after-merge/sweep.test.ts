// no-token: none -- the tracker is a stub, the queue is in memory and the state directory is temporary
// A11-277: the sweep copies the runs' After-merge lines into checks that outlive their runs, and posts each close once
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpDir } from "../../lib/tmp-fixture.ts";
import type { Queue } from "../queue/queue-entries-and-outcomes.ts";
import { BOARD_LINES_2026_10_25 } from "./board-lines-fixture.ts";
import { closeCheck } from "./checks.ts";
import { afterMergeChecksPath, loadChecks, saveChecks } from "./store.ts";
import { syncAfterMergeChecks } from "./sweep.ts";

type Entries = Queue["entries"];

/** A sweep over a temporary state directory, a queue holding `entries`, and a tracker whose comments are recorded (and refused while `refuse` is on); no `comment` at all when `comments` is false. */
function world(entries: Entries, { comments = true } = {}) {
  const stateDir = tmpDir("after-merge-sweep-");
  const queue = { entries };
  const posted: { key: string; body: string }[] = [];
  const refuse = { on: false };
  const comment = async (key: string, body: string) => {
    if (refuse.on) throw new Error("Linear is down");
    posted.push({ key, body });
  };
  const ctx = { settings: { stateDir }, store: { get: () => queue }, source: comments ? { comment } : {}, now: () => 50_000 } as never;
  const path = afterMergeChecksPath(stateDir);
  return { queue, posted, refuse, path, sweep: () => syncAfterMergeChecks(ctx), checks: () => loadChecks(path).checks };
}

const merged = (key: string, lines: readonly string[]) => ({ ticket: { key, url: `https://linear.app/a11ign/issue/${key}` }, phase: "finished", finishedAt: 1_000, afterMerge: lines.map((line) => ({ line, owner: null })) });

/** Close `id` as a person would through the route: on the file, at once. */
function closeOnFile(path: string, id: string, result: "passed" | "failed" = "passed") {
  const answer = closeCheck(loadChecks(path), id, { result, evidence: "A11-275 woke on its fleet job", by: "person" }, 60_000);
  assert.ok(answer.ok);
  saveChecks(path, answer.file);
}

test("A11-277: the 33 lines on the board on 2026-10-25 are seeded on the first sweep, each with an owner", async () => {
  const byKey = new Map<string, string[]>();
  for (const [key, line] of BOARD_LINES_2026_10_25) byKey.set(key, [...(byKey.get(key) ?? []), line]);
  const board = world([...byKey].map(([key, lines]) => merged(key, lines)) as unknown as Entries);
  await board.sweep();
  const checks = Object.values(board.checks());
  assert.equal(checks.length, 33);
  assert.deepEqual(checks.filter((check) => check.owner === null).map(({ id }) => id), [], "no check is owner not named");
  assert.ok(checks.every((check) => check.state === "open" && check.listedAt === 1_000));
});

test("A11-277: a dismissed run keeps its checks", async () => {
  const board = world([merged("A11-245", ["Chairman session: the next run that waits on a fleet job is woken by the board."])] as unknown as Entries);
  await board.sweep();
  board.queue.entries = [];
  await board.sweep();
  assert.deepEqual(Object.keys(board.checks()), ["A11-245#1"], "the run left; its check did not");
  assert.equal(board.checks()["A11-245#1"].state, "open");
});

test("A11-277: a close is posted on its ticket once, and a failed post is tried again at the next sweep", async () => {
  const board = world([merged("A11-245", ["Chairman session: the next run that waits on a fleet job is woken by the board."])] as unknown as Entries);
  await board.sweep();
  assert.deepEqual(board.posted, [], "an open check posts nothing");
  closeOnFile(board.path, "A11-245#1");
  board.refuse.on = true;
  await board.sweep();
  assert.equal(board.checks()["A11-245#1"].posted, undefined, "a refused post is unmarked");
  board.refuse.on = false;
  await board.sweep();
  await board.sweep();
  assert.deepEqual(board.posted, [{
    key: "A11-245",
    body: "After-merge check passed: Chairman session: the next run that waits on a fleet job is woken by the board.\nEvidence: A11-275 woke on its fleet job\nClosed by a person on the ticket board.",
  }], "posted once, on the retry");
  assert.equal(board.checks()["A11-245#1"].posted, true);
});

test("A11-277: a tracker that cannot comment keeps the close on the board, marked not postable, and posts nothing", async () => {
  const board = world([merged("A11-1", ["Chairman session: a check."])] as unknown as Entries, { comments: false });
  await board.sweep();
  closeOnFile(board.path, "A11-1#1", "failed");
  await board.sweep();
  assert.equal(board.checks()["A11-1#1"].posted, false);
  assert.equal(board.checks()["A11-1#1"].state, "failed");
});

test("A11-277: a checks file that cannot be read is left as it is, and the sweep goes on", async () => {
  const board = world([merged("A11-1", ["Chairman session: a check."])] as unknown as Entries);
  await board.sweep();
  writeFileSync(board.path, "{ not json");
  await board.sweep();
  assert.throws(() => loadChecks(board.path), "the file is not written over");
});

test("A11-277: two sweeps at once post each close once", async () => {
  const board = world([merged("A11-238", ["Chairman session: the next stacked step that is approved merges with no person.", "Chairman session: the next approved step merges too."])] as unknown as Entries);
  await board.sweep();
  closeOnFile(board.path, "A11-238#1");
  closeOnFile(board.path, "A11-238#2");
  // The first sweep reads both closes, posts one and waits on the tracker; the second reads the other and posts it while the first still holds both in hand.
  await Promise.all([board.sweep(), board.sweep()]);
  assert.equal(board.posted.length, 2, "each close is posted once, not once by each sweep");
});

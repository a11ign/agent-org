// no-token: gh -- `gh` is never reached: every read is handed a fake `run` and a fake `batch`.
/**
 * a11ign/a11ign#3566, slice 5: THE GATE'S LANE READS WAIT TOGETHER, NOT ONE AFTER THE OTHER.
 *
 * `main` read the tracker's backlog, `needs:chairman` and open lists, then the claimed rows' comments, the closed rows that owe an answer and the
 * recently closed ones, each through the synchronous `gh`: 10 reads, 9.7 s summed in one gate run (all 10 distinct argv, none repeated, so nothing to
 * read once). The fix moves WHEN they wait (`readWithFirstWaveTogether`, slices 2 and 3's seam) and nothing else, so what is pinned is:
 *   - the control: a `run` handed in (a test's stand-in for `gh`) is NOT batched, and reads one call at a time in today's order;
 *   - wave 2 (`readTrackerLanes`): backlog, `needs:chairman` and open arrive in ONE batch and the lanes are what the one-at-a-time read returned;
 *   - wave 3 (`readOpenRowFollowUps`): the claimed rows' comments, the closed-answer `label list` and the closings arrive in one batch, and a quiet
 *     tracker asks for NO MORE than it did (the conditional reads stay conditional: the rehearsal asks only what the rows in hand ask for);
 *   - a refusal in one lane is that lane's `null` and nobody else's (#1286: "could not ask" is never "nothing there");
 *   - what a batch cannot foresee (a chairman row's events, the closed-answer search that follows its label list) still runs one at a time, through `run`;
 *   - the wiring: `main` calls both waves, because a helper nothing calls is the most recorded shape here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readOpenRowFollowUps, readTrackerLanes } from "./work-gate.mjs";

type Call = { args: string[], repo: string | undefined };
type Answer = { stdout: string } | { failed: true, stdout: string, stderr: string, status: number | null, code?: string };

const OPEN_ROWS = [{ number: 41, title: "open row", labels: [{ name: "ready" }], body: "", blockedBy: { nodes: [] }, milestone: null, updatedAt: "2026-10-06T05:00:00Z" }];
const CLAIMED = { number: 42, title: "claimed", labels: [{ name: "in-progress" }, { name: "session:worker-42" }], body: "", blockedBy: { nodes: [{ number: 9, state: "CLOSED" }] }, updatedAt: "2026-10-06T05:00:00Z" };
const QUIET = OPEN_ROWS;
const CLAIMED_ROWS = [...OPEN_ROWS, CLAIMED];

const has = (args: string[], ...words: string[]) => words.every((word) => args.includes(word));
const refused = (): never => { throw Object.assign(new Error("Command failed: gh"), { status: 1, stderr: "HTTP 502", stdout: "" }); };

/** What `gh` answers, by argv. An `api` call (a chairman row's events) is refused, so the row says so by `chairmanReadRefused`. */
function ghAnswer(args: string[], { chairmanRows = [] as unknown[], refuse = [] as string[] } = {}): string {
  if (refuse.some((word) => has(args, word))) return refused();
  if (args[0] === "api") return refused();
  if (has(args, "--label", "needs:chairman")) return JSON.stringify(chairmanRows);
  if (has(args, "--label", "backlog")) return "[]";
  if (has(args, "--label", "in-progress")) return JSON.stringify([{ number: 42, comments: [] }]);
  if (args[0] === "label") return JSON.stringify([{ name: "answer:product-manager" }]);
  if (has(args, "--state", "closed") && has(args, "--search", "sort:updated-desc")) return JSON.stringify([{ number: 9, closedAt: "2026-10-06T04:00:00Z", updatedAt: "2026-10-06T04:00:00Z" }]);
  if (has(args, "--state", "closed")) return "[]";
  if (args[0] === "pr") return "[]";
  return JSON.stringify(OPEN_ROWS);
}

/** The `run` a test hands the gate: one call at a time, noted, answering by argv. */
function sequentialRun(seen: Call[], options = {}) {
  return (args: string[], repo?: string) => { seen.push({ args, repo }); return ghAnswer(args, options); };
}

/** A batch that answers as `ghAnswer` does and notes every call it was handed, one entry per BATCH. */
function fakeBatch(batches: Call[][], options: { chairmanRows?: unknown[], refuse?: string[] } = {}) {
  return (calls: Call[]): Answer[] => {
    batches.push(calls);
    return calls.map((call) => {
      try { return { stdout: ghAnswer(call.args, options) }; } catch { return { failed: true as const, stdout: "", stderr: "HTTP 502", status: 1 }; }
    });
  };
}

const shape = (call: Call) => call.args.slice(0, 2).join(" ") + (call.args.includes("--label") ? ` ${call.args[call.args.indexOf("--label") + 1]}` : "");

test("POSITIVE CONTROL: the one-at-a-time wave 2 reads backlog, chairman and open in today's order, so the assertions below compare something", () => {
  const seen: Call[] = [];
  const lanes = readTrackerLanes(sequentialRun(seen) as never);
  assert.deepEqual(seen.map(shape), ["issue list backlog", "issue list needs:chairman", "issue list"]);
  assert.deepEqual(lanes.openRowsRead, OPEN_ROWS, "the open rows came from the open list, not from another lane's answer");
  assert.deepEqual(lanes.chairmanBlocked, []);
});

test("CONTROL: a run handed in is not batched -- its calls arrive one at a time, with no rehearsal pass", () => {
  const seen: Call[] = [];
  readTrackerLanes(sequentialRun(seen) as never);
  assert.equal(seen.length, 3, "each lane once");
});

test("wave 2: backlog, needs:chairman and open arrive in ONE batch, and the lanes are what the one-at-a-time read returned", () => {
  const batches: Call[][] = [];
  const seen: Call[] = [];
  const together = readTrackerLanes(sequentialRun(seen) as never, fakeBatch(batches));
  assert.equal(batches.length, 1, "one batch, not one per lane");
  assert.deepEqual(batches[0].map(shape), ["issue list backlog", "issue list needs:chairman", "issue list"]);
  assert.deepEqual(seen, [], "nothing left over to read one at a time");
  assert.deepEqual(together, readTrackerLanes(sequentialRun([]) as never), "the same lanes");
});

test("a refusal in ANY one lane is that lane's null, beside the other lanes' answers", () => {
  const lanes = [["promotableRows", "backlog"], ["chairmanBlocked", "needs:chairman"], ["openRowsRead", "500"]] as const;
  for (const [lane, word] of lanes) {
    const together = readTrackerLanes(sequentialRun([]) as never, fakeBatch([], { refuse: [word] })) as Record<string, unknown>;
    assert.equal(together[lane], null, `${lane}: refused is null, never []`);
    for (const [other] of lanes.filter(([name]) => name !== lane)) assert.notEqual(together[other], null, `${other} keeps its answer beside ${lane}'s refusal`);
    assert.deepEqual(together, readTrackerLanes(sequentialRun([], { refuse: [word] }) as never), `${lane}: the one-at-a-time read says the same`);
  }
});

test("a chairman row's events are NOT foreseen by the batch: they run one at a time through run, as before", () => {
  const batches: Call[][] = [];
  const seen: Call[] = [];
  const chairmanRows = [{ number: 7, title: "asks", updatedAt: "2026-10-06T05:00:00Z" }];
  const together = readTrackerLanes(sequentialRun(seen, { chairmanRows }) as never, fakeBatch(batches, { chairmanRows }));
  assert.equal(batches[0].length, 3, "the three lists went together");
  assert.ok(seen.length > 0 && seen.every(({ args }) => args[0] === "api"), "the events calls were left to the one-at-a-time run");
  assert.deepEqual(together.chairmanBlocked?.map((row: { number: number, chairmanReadRefused?: boolean }) => [row.number, row.chairmanReadRefused]), [[7, true]]);
});

test("wave 3: a claimed row with a cleared blocker asks comments, the closed-answer label list and the closings, all in ONE batch", () => {
  const batches: Call[][] = [];
  const seen: Call[] = [];
  const together = readOpenRowFollowUps(CLAIMED_ROWS, sequentialRun(seen) as never, fakeBatch(batches));
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map(shape).sort(), ["issue list in-progress", "issue list", "label list"].sort());
  assert.deepEqual(together.claimedComments, [{ number: 42, comments: [] }]);
  assert.ok(together.closings instanceof Map && together.closings.get(9) !== undefined, "the closings are the closings read, keyed by row");
  assert.deepEqual(seen.map(shape), ["issue list", "pr list"], "the closed-answer searches follow the label list, so they run one at a time, as they did");
  assert.deepEqual(together, readOpenRowFollowUps(CLAIMED_ROWS, sequentialRun([]) as never), "the same follow-ups");
});

test("THE CONDITIONAL READS STAY CONDITIONAL: a tracker with nothing claimed asks for no more than it did", () => {
  const batches: Call[][] = [];
  const seen: Call[] = [];
  const together = readOpenRowFollowUps(QUIET, sequentialRun(seen) as never, fakeBatch(batches));
  const before: Call[] = [];
  const oneByOne = readOpenRowFollowUps(QUIET, sequentialRun(before) as never);
  assert.equal(together.claimedComments, null, "not asked, as before");
  assert.equal(together.closings, null);
  assert.deepEqual(batches, [], "one call is not a batch: it costs a spawn and saves nothing");
  assert.deepEqual(seen.map(shape), before.map(shape), "the same calls, none added, none dropped");
  assert.deepEqual(together, oneByOne);
});

test("a refusal in wave 3 is that read's null, beside the others' answers", () => {
  const batches: Call[][] = [];
  const together = readOpenRowFollowUps(CLAIMED_ROWS, sequentialRun([]) as never, fakeBatch(batches, { refuse: ["in-progress"] }));
  assert.equal(together.claimedComments, null, "refused is null");
  assert.ok(together.closings instanceof Map, "the closings were still read");
  assert.deepEqual(together, readOpenRowFollowUps(CLAIMED_ROWS, sequentialRun([], { refuse: ["in-progress"] }) as never));
});

test("THE WIRING: main reads the tracker lanes and the follow-ups through the two waves, and no longer one by one", () => {
  const source = readFileSync(new URL("./work-gate.mjs", import.meta.url), "utf8");
  const main = source.slice(source.indexOf("\nfunction main()"));
  assert.match(main, /readLanesAfterOutageCheck\(\)/); // slice 6: the tracker lanes ride the one wave with the other repositories' lists
  assert.match(main, /readOpenRowFollowUps\(allOpen\)/);
  assert.doesNotMatch(main, /\breadPromotableRows\(\)|\breadChairmanBlocked\(\)|\breadOpenRows\(\)|\bclaimedRowCommentsWhenHeld\(|\bclosingsWhenRowsCleared\(|\bclosedAnswerRows\(\)/);
});

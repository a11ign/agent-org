// no-token: gh -- `gh` is never reached: every read is handed a fake `run` and a fake `batch`.
/**
 * a11ign/a11ign#3566, slice 5: THE GATE'S LANE READS WAIT TOGETHER, NOT ONE AFTER THE OTHER.
 *
 * `main` read the tracker's backlog, `needs:chairman` and open lists, then the claimed rows' comments, the closed rows that owe an answer and the
 * recently closed ones, each through the synchronous `gh`: 10 reads, 9.7 s summed in one gate run (all 10 distinct argv, none repeated, so nothing to
 * read once). The fix moves WHEN they wait (`readWithFirstWaveTogether`, slices 2 and 3's seam) and nothing else, so what is pinned is:
 *   - the control: a `run` handed in (a test's stand-in for `gh`) is NOT batched, and reads one call at a time in today's order;
 *   - wave 2 (`readTrackerLanes`): the open list goes in ONE batch and backlog and `needs:chairman` are MADE FROM IT (#4899) when it came back complete, the lanes
 *     being what the one-at-a-time read returned; a FULL page (or a refused one) is not folded, and the two label lists then arrive TOGETHER in a second batch;
 *   - wave 3 (`readOpenRowFollowUps`): the claimed rows' comments, the closed-answer `label list` and the closings arrive in one batch, and a quiet
 *     tracker asks for NO MORE than it did (the conditional reads stay conditional: the rehearsal asks only what the rows in hand ask for);
 *   - a refusal in one lane is that lane's `null` and nobody else's (#1286: "could not ask" is never "nothing there");
 *   - what a batch cannot foresee (a chairman row's events, the closed-answer reads that follow its label list) still runs one at a time, through `run`;
 *   - #5050: the label lists are by-label CONNECTION reads over `gh api graphql` (no search), and the fakes below answer that shape; a `gh issue list --label` is
 *     no longer asked, so the fake refuses one;
 *   - the wiring: `main` calls both waves, because a helper nothing calls is the most recorded shape here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readOpenRowFollowUps } from "./work-gate.ts";
import { readTrackerLanes } from "./work-gate/tick.ts";
import { closedAnswerConnection, connectionOfSelected, readsClosedAnswerRows, readsRecentlyClosed, readsRowsByLabel, recentlyClosedConnection } from "./packaging/rows-by-label-fixtures.ts";
import { workGateSource } from "./lib/work-gate-source.ts";

type Call = { args: string[], repo: string | undefined };
type Answer = { stdout: string } | { failed: true, stdout: string, stderr: string, status: number | null, code?: string };

const OPEN_ROWS = [{ number: 41, title: "open row", labels: [{ name: "ready" }], body: "", blockedBy: { nodes: [] }, milestone: null, updatedAt: "2026-10-06T05:00:00Z" }];
const CLAIMED = { number: 42, title: "claimed", labels: [{ name: "in-progress" }, { name: "session:worker-42" }], body: "", blockedBy: { nodes: [{ number: 9, state: "CLOSED" }] }, updatedAt: "2026-10-06T05:00:00Z" };
const QUIET = OPEN_ROWS;
const CLAIMED_ROWS = [...OPEN_ROWS, CLAIMED];

/** Does the call carry each word, as an argument or as the by-label read's `label=<word>`? (#5050: a label travels as `-F label=X`, not as `--label X`.) */
const has = (args: string[], ...words: string[]) => words.every((word) => args.includes(word) || args.includes(`label=${word}`));
const refused = (): never => { throw Object.assign(new Error("Command failed: gh"), { status: 1, stderr: "HTTP 502", stdout: "" }); };

/**
 * What `gh` answers, by argv. An `api` call it does not know (a chairman row's events) is refused, so the row says so by `chairmanReadRefused`. A call that would be a SEARCH
 * (`--label`, `--search`) or a list nobody asks any more (`pr list`, `issue list --state closed`) THROWS rather than answering: the gate sends none of them (#5050).
 */
function ghAnswer(args: string[], { chairmanRows = [] as unknown[], refuse = [] as string[], open = OPEN_ROWS as unknown[] } = {}): string {
  if (refuse.some((word) => has(args, word))) return refused();
  const byLabel = readsRowsByLabel(args);
  if (byLabel?.label === "needs:chairman") return connectionOfSelected(chairmanRows as never, args);
  if (byLabel?.label === "backlog") return connectionOfSelected((open as any[]).filter((row) => row.labels.some((l: { name: string }) => l.name === "backlog")), args);
  if (byLabel?.label === "in-progress") return connectionOfSelected([{ number: 42, comments: [] }], args);
  if (byLabel !== null) throw new Error(`unexpected by-label read: ${byLabel.state} rows labelled ${byLabel.label}`);
  if (readsClosedAnswerRows(args) !== null) return closedAnswerConnection([]);
  if (readsRecentlyClosed(args)) return recentlyClosedConnection([{ number: 9, closedAt: "2026-10-06T04:00:00Z", updatedAt: "2026-10-06T04:00:00Z" }]);
  if (args[0] === "api") return refused();
  if (args[0] === "label") return JSON.stringify([{ name: "answer:product-manager" }]);
  if (args[0] === "issue" && args.includes("--state") && args.includes("open") && !args.includes("--label") && !args.includes("--search")) return JSON.stringify(open);
  throw new Error(`unexpected call: gh ${args.join(" ")}`);
}

/** The `run` a test hands the gate: one call at a time, noted, answering by argv. */
function sequentialRun(seen: Call[], options = {}) {
  return (args: string[], repo?: string) => { seen.push({ args, repo }); return ghAnswer(args, options); };
}

/** A batch that answers as `ghAnswer` does and notes every call it was handed, one entry per BATCH. */
function fakeBatch(batches: Call[][], options: { chairmanRows?: unknown[], refuse?: string[], open?: unknown[] } = {}) {
  return (calls: Call[]): Answer[] => {
    batches.push(calls);
    return calls.map((call) => {
      try { return { stdout: ghAnswer(call.args, options) }; } catch { return { failed: true as const, stdout: "", stderr: "HTTP 502", status: 1 }; }
    });
  };
}

/** 500 open rows: the page that may have been cut, which nothing is made from (#4899). */
const FULL_PAGE = Array.from({ length: 500 }, (_, at) => ({ ...OPEN_ROWS[0], number: 1000 + at }));

/** A call by what it ASKS, not by the `api graphql` every connection read travels as (#5050). */
function shape({ args }: Call): string {
  const byLabel = readsRowsByLabel(args);
  if (byLabel !== null) return `rows labelled ${byLabel.label}`;
  const closedAnswer = readsClosedAnswerRows(args);
  if (closedAnswer !== null) return `closed ${closedAnswer.kind}`;
  if (readsRecentlyClosed(args)) return "recently closed";
  return args.slice(0, 2).join(" ");
}

test("POSITIVE CONTROL: the one-at-a-time wave 2 reads backlog, chairman and open in today's order, so the assertions below compare something", () => {
  const seen: Call[] = [];
  const lanes = readTrackerLanes(sequentialRun(seen) as never);
  assert.deepEqual(seen.map(shape), ["rows labelled backlog", "rows labelled needs:chairman", "issue list"]);
  assert.deepEqual(lanes.openRowsRead, OPEN_ROWS, "the open rows came from the open list, not from another lane's answer");
  assert.deepEqual(lanes.chairmanBlocked, []);
});

test("CONTROL: a run handed in is not batched -- its calls arrive one at a time, with no rehearsal pass", () => {
  const seen: Call[] = [];
  readTrackerLanes(sequentialRun(seen) as never);
  assert.equal(seen.length, 3, "each lane once");
});

test("wave 2: open arrives alone in the batch and backlog and needs:chairman are made from it; the lanes are what the one-at-a-time read returned (#4899)", () => {
  const BACKLOG_ROW = { ...OPEN_ROWS[0], number: 43, title: "backlog row", labels: [{ name: "backlog" }] };
  const open = [...OPEN_ROWS, BACKLOG_ROW];
  const batches: Call[][] = [];
  const seen: Call[] = [];
  const together = readTrackerLanes(sequentialRun(seen, { open }) as never, fakeBatch(batches, { open }));
  assert.equal(batches.length, 1, "one batch, not one per lane");
  assert.deepEqual(batches[0].map(shape), ["issue list"], "the open list alone: the two label lists are not asked");
  assert.deepEqual(seen, [], "and nothing is left over to read one at a time");
  assert.deepEqual(together.promotableRows?.map((row: { number: number }) => row.number), [43], "POSITIVE CONTROL: the backlog lane is not empty, so equal means made from the list");
  assert.deepEqual(together, readTrackerLanes(sequentialRun([], { open }) as never), "the same lanes as the one-at-a-time by-label reads give (the fake answers backlog from the open rows)");
});

test("a FULL open page is not folded: the two label lists are asked, together in ONE more batch, and the lanes are the one-at-a-time read's", () => {
  const batches: Call[][] = [];
  const seen: Call[] = [];
  const together = readTrackerLanes(sequentialRun(seen, { open: FULL_PAGE }) as never, fakeBatch(batches, { open: FULL_PAGE }));
  assert.equal(batches.length, 2, "the open list, then the lists it could not answer");
  assert.deepEqual(batches[0].map(shape), ["issue list"]);
  assert.deepEqual(batches[1].map(shape).sort(), ["rows labelled backlog", "rows labelled needs:chairman"]);
  assert.deepEqual(seen, [], "nothing left over to read one at a time");
  assert.deepEqual(together, readTrackerLanes(sequentialRun([], { open: FULL_PAGE }) as never), "the same lanes");
});

test("a refusal in ANY one lane is that lane's null, beside the other lanes' answers", () => {
  const lanes = [["promotableRows", "backlog"], ["chairmanBlocked", "needs:chairman"], ["openRowsRead", "500"]] as const;
  // a FULL page is not folded (#4899), so each lane is asked on its own and each can be refused on its own
  for (const [lane, word] of lanes) {
    const options = { open: FULL_PAGE, refuse: [word] };
    const together = readTrackerLanes(sequentialRun([], options) as never, fakeBatch([], options)) as Record<string, unknown>;
    assert.equal(together[lane], null, `${lane}: refused is null, never []`);
    for (const [other] of lanes.filter(([name]) => name !== lane)) assert.notEqual(together[other], null, `${other} keeps its answer beside ${lane}'s refusal`);
    assert.deepEqual(together, readTrackerLanes(sequentialRun([], options) as never), `${lane}: the one-at-a-time read says the same`);
  }
});

test("#4899: a refused OPEN list is its null, and the label lanes it would have made are then asked on their own, never answered [] from nothing", () => {
  const seen: Call[] = [];
  const batches: Call[][] = [];
  const options = { refuse: ["500"] };
  const together = readTrackerLanes(sequentialRun(seen, options) as never, fakeBatch(batches, options));
  assert.equal(together.openRowsRead, null, "refused is null");
  assert.notEqual(together.promotableRows, null, "the backlog lane was asked, and answered");
  assert.notEqual(together.chairmanBlocked, null, "and so was the chairman lane");
  assert.deepEqual(batches[1].map(shape).sort(), ["rows labelled backlog", "rows labelled needs:chairman"], "asked together, as the fold's fall-through");
  assert.deepEqual(seen, [], "and not one by one");
});

test("#4899: a lane refused while the open list is complete cannot be: it is not asked, so nothing is reported refused that was never sent", () => {
  const batches: Call[][] = [];
  const options = { refuse: ["backlog", "needs:chairman"] };
  const together = readTrackerLanes(sequentialRun([], options) as never, fakeBatch(batches, options));
  assert.deepEqual(batches[0].map(shape), ["issue list"]);
  assert.deepEqual(together.promotableRows, [], "made from the complete list: no backlog rows in it");
  assert.deepEqual(together.chairmanBlocked, []);
});

test("a chairman row's events are NOT foreseen by the batch: they run one at a time through run, as before", () => {
  const batches: Call[][] = [];
  const seen: Call[] = [];
  const chairmanRows = [{ number: 7, title: "asks", updatedAt: "2026-10-06T05:00:00Z", labels: [{ name: "needs:chairman" }] }];
  // the open list carries the chairman row, so the lane is made from it (#4899) and its events are what is left for `run`
  const open = [...OPEN_ROWS, ...chairmanRows];
  const together = readTrackerLanes(sequentialRun(seen, { chairmanRows, open }) as never, fakeBatch(batches, { chairmanRows, open }));
  assert.equal(batches[0].length, 1, "the open list went alone; the chairman lane was made from it");
  assert.ok(seen.length > 0 && seen.every(({ args }) => args[0] === "api"), "the events calls were left to the one-at-a-time run");
  assert.deepEqual(together.chairmanBlocked?.map((row: { number: number, chairmanReadRefused?: boolean }) => [row.number, row.chairmanReadRefused]), [[7, true]]);
});

test("wave 3: a claimed row with a cleared blocker asks comments, the closed-answer label list and the closings, all in ONE batch", () => {
  const batches: Call[][] = [];
  const seen: Call[] = [];
  const together = readOpenRowFollowUps(CLAIMED_ROWS, sequentialRun(seen) as never, fakeBatch(batches));
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map(shape).sort(), ["rows labelled in-progress", "recently closed", "label list"].sort());
  assert.deepEqual(together.claimedComments, [{ number: 42, comments: [] }]);
  assert.ok(together.closings instanceof Map && together.closings.get(9) !== undefined, "the closings are the closings read, keyed by row");
  assert.deepEqual(seen.map(shape), ["closed issues", "closed pullRequests"], "the closed-answer reads follow the label list, so they run one at a time, as they did");
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
  const source = workGateSource();
  const main = source.slice(source.indexOf("\nfunction main()"));
  assert.match(main, /readLanesAfterOutageCheck\(\)/); // slice 6: the tracker lanes ride the one wave with the other repositories' lists
  assert.match(main, /readOpenRowFollowUps\(allOpen\)/);
  assert.doesNotMatch(main, /\breadPromotableRows\(\)|\breadChairmanBlocked\(\)|\breadOpenRows\(\)|\bclaimedRowCommentsWhenHeld\(|\bclosingsWhenRowsCleared\(|\bclosedAnswerRows\(\)/);
});

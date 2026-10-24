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
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readOpenRowFollowUps } from "./work-gate.ts";
import { readTrackerLanes } from "./work-gate/tick.ts";
import { closedAnswerConnection, connectionOfSelected, readsClosedAnswerRows, readsRecentlyClosed, readsRowsByLabel, recentlyClosedConnection } from "./packaging/rows-by-label-fixtures.ts";
import { workGateSource } from "./lib/work-gate-source.ts";
import { testEach } from "./lib/test-each.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow, type FakeRowsWorld } from "./plugins/fakes/code-host-rows.ts";
import { askingRunFirst, standIn } from "./plugins/fakes/waves.test.support.ts";

afterEach(() => forgetActivation());

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
  const isOpenIssueList = args[0] === "issue" && args.includes("--state") && args.includes("open") && !args.includes("--label") && !args.includes("--search");
  if (isOpenIssueList) return JSON.stringify(open);
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

// --- THE WAVES ON THE FAKE CODE HOST (A11-160, step 9) ----------------------------------------------------------------------------------------------------------------------------------------------------
// The lanes below are the fake code host's rows; each operation the gate reads a lane with makes ONE stand-in call to the `run` it is handed (`waves.test.support.ts`), so what is pinned is the executor's: which calls
// the gate's readers make, in what order, which go out together in a batch and which do not, and what a refusal does to a lane. How a GitHub answer is read, and how the open list is folded into the label lists
// (which is made of GitHub's own argument lists), is pinned by the cases further down, over stubbed answers.

/** The stand-in call each operation of a lane makes: its name and what it is about. */
const LANE_CALLS = {
  readRowsByLabel: (request: { label: string; state: string }) => standIn("readRowsByLabel", request.label, request.state),
  openRowsOf: () => standIn("openRowsOf"),
  labelNamesWithPrefix: (request: { prefix: string }) => standIn("labelNamesWithPrefix", request.prefix),
  closedRowsCarryingLabels: (request: { kind: string }) => standIn("closedRowsCarryingLabels", request.kind),
  recentlyClosedRowsOf: () => standIn("recentlyClosedRowsOf"),
};

/** The fake code host in place with the open rows `numbers` (`ready`; `claimed` ones are `in-progress` and blocked by the closed row #9). */
function lanesWorld({ claimed = false }: { claimed?: boolean } = {}): FakeRowsWorld {
  const host = askingRunFirst(createFakeCodeHost(), LANE_CALLS);
  const world = host.rowsWorld;
  world.rows.set(41, fakeRow(world, 41, { title: "open row", labels: ["ready"], createdAt: "2026-10-06T05:00:00Z" }));
  if (claimed) {
    world.rows.set(42, fakeRow(world, 42, { title: "claimed", labels: ["in-progress", "session:worker-42"], blockedBy: [9], createdAt: "2026-10-06T05:00:00Z" }));
    world.rows.set(9, fakeRow(world, 9, { state: "CLOSED", closedAt: "2026-10-06T04:00:00Z", labels: [] }));
    world.labelsCreated.push("answer:product-manager"); // the repository has an answer label, so the closed rows that carry it are read
  }
  substituteCodeHost(host);
  return world;
}

/** The `run` a test hands the gate: one call at a time, noted, refusing the calls `refuse` names the way `execFileSync` throws, answering `[]` (a stand-in call has nothing to answer). */
function standInRun(seen: Call[], refuse: string[] = []) {
  return (args: string[], repo?: string) => {
    seen.push({ args, repo });
    if (refuse.some((word) => args.includes(word))) return refused();
    return "[]";
  };
}

/** A batch that notes every call it was handed, one entry per BATCH, and fails the calls `refuse` names. */
function standInBatch(batches: Call[][], refuse: string[] = []) {
  return (calls: Call[]): Answer[] => {
    batches.push(calls);
    return calls.map((call) => (refuse.some((word) => call.args.includes(word)) ? { failed: true as const, stdout: "", stderr: "HTTP 502", status: 1 } : { stdout: "[]" }));
  };
}

const named = ({ args }: Call): string => args.join(" ");

test("wave 2 on the fake: the one-at-a-time read asks backlog, chairman and open in today's order, and a run handed in is not batched", () => {
  lanesWorld();
  const seen: Call[] = [];
  const lanes = readTrackerLanes(standInRun(seen) as never);
  assert.deepEqual(seen.map(named), ["fake:readRowsByLabel backlog OPEN", "fake:readRowsByLabel needs:chairman OPEN", "fake:openRowsOf"], "each lane once, with no rehearsal pass");
  assert.deepEqual(lanes.openRowsRead?.map((row: { number: number }) => row.number), [41], "the open rows came from the open list");
  assert.deepEqual(lanes.chairmanBlocked, []);
});

test("wave 2 on the fake: the three lanes arrive in ONE batch and nothing is left to read one at a time; the lanes are the one-at-a-time read's", () => {
  lanesWorld();
  const batches: Call[][] = [];
  const seen: Call[] = [];
  const together = readTrackerLanes(standInRun(seen) as never, standInBatch(batches));
  assert.equal(batches.length, 1, "one batch, not one per lane");
  assert.deepEqual(batches[0].map(named), ["fake:readRowsByLabel backlog OPEN", "fake:readRowsByLabel needs:chairman OPEN", "fake:openRowsOf"]);
  assert.deepEqual(seen, []);
  assert.deepEqual(together, readTrackerLanes(standInRun([]) as never));
});

test("wave 2 on the fake: a refusal in ANY one lane is that lane's null, beside the other lanes' answers", () => {
  lanesWorld();
  const lanes = [["promotableRows", "backlog"], ["chairmanBlocked", "needs:chairman"], ["openRowsRead", "fake:openRowsOf"]] as const;
  for (const [lane, word] of lanes) {
    const together = readTrackerLanes(standInRun([], [word]) as never, standInBatch([], [word])) as Record<string, unknown>;
    assert.equal(together[lane], null, `${lane}: refused is null, never []`);
    for (const [other] of lanes.filter(([name]) => name !== lane)) assert.notEqual(together[other], null, `${other} keeps its answer beside ${lane}'s refusal`);
    assert.deepEqual(together, readTrackerLanes(standInRun([], [word]) as never), `${lane}: the one-at-a-time read says the same`);
  }
});

test("wave 3 on the fake: a claimed row with a cleared blocker asks comments, the closed-answer label list (and the reads it leads to) and the closings, all in ONE batch", () => {
  lanesWorld({ claimed: true });
  const batches: Call[][] = [];
  const seen: Call[] = [];
  const together = readOpenRowFollowUps(CLAIMED_ROWS, standInRun(seen) as never, standInBatch(batches));
  assert.equal(batches.length, 1);
  // the fake's label list is the world's, so the rehearsal foresees the closed-answer reads and they ride the batch; that they FOLLOW the label list when its answer is only known after the batch is the stubbed case below
  assert.deepEqual(batches[0].map(named).sort(), ["fake:closedRowsCarryingLabels issues", "fake:closedRowsCarryingLabels pullRequests", "fake:labelNamesWithPrefix answer:", "fake:readRowsByLabel in-progress OPEN", "fake:recentlyClosedRowsOf"].sort());
  assert.deepEqual(together.claimedComments?.map((row: { number: number }) => row.number), [42]);
  assert.ok(together.closings instanceof Map && together.closings.get(9) !== undefined, "the closings are the closings read, keyed by row");
  assert.deepEqual(seen, [], "and nothing is left to read one at a time");
  assert.deepEqual(together, readOpenRowFollowUps(CLAIMED_ROWS, standInRun([]) as never), "the same follow-ups");
});

test("THE CONDITIONAL READS STAY CONDITIONAL, on the fake: a tracker with nothing claimed asks for no more than it did", () => {
  lanesWorld();
  const batches: Call[][] = [];
  const seen: Call[] = [];
  const together = readOpenRowFollowUps(QUIET, standInRun(seen) as never, standInBatch(batches));
  const before: Call[] = [];
  const oneByOne = readOpenRowFollowUps(QUIET, standInRun(before) as never);
  assert.equal(together.claimedComments, null, "not asked, as before");
  assert.equal(together.closings, null);
  assert.deepEqual(batches, [], "one call is not a batch: it costs a spawn and saves nothing");
  assert.deepEqual(seen.map(named), before.map(named), "the same calls, none added, none dropped");
  assert.deepEqual(together, oneByOne);
});

test("a refusal in wave 3 is that read's null, beside the others' answers, on the fake", () => {
  lanesWorld({ claimed: true });
  const batches: Call[][] = [];
  const together = readOpenRowFollowUps(CLAIMED_ROWS, standInRun([]) as never, standInBatch(batches, ["in-progress"]));
  assert.equal(together.claimedComments, null, "refused is null");
  assert.ok(together.closings instanceof Map, "the closings were still read");
  assert.deepEqual(together, readOpenRowFollowUps(CLAIMED_ROWS, standInRun([], ["in-progress"]) as never));
});

// --- WHAT NEEDS GITHUB'S OWN ANSWERS: the open list folded into the label lists (#4899). The fold is made of the argument lists of `gh issue list` and of the by-label connection read, so these cases stay over stubbed answers ---

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

type FullPageRead = { batches: Call[][]; seen: Call[]; together: ReturnType<typeof readTrackerLanes> };

const FULL_PAGE_CHECKS: { name: string; check: (r: FullPageRead) => void }[] = [
  {
    name: "the open list, then the lists it could not answer",
    check: ({ batches }) => assert.equal(batches.length, 2, "the open list, then the lists it could not answer"),
  },
  { name: "the open list alone first", check: ({ batches }) => assert.deepEqual(batches[0].map(shape), ["issue list"]) },
  {
    name: "the two label lists together in the second",
    check: ({ batches }) => assert.deepEqual(batches[1].map(shape).sort(), ["rows labelled backlog", "rows labelled needs:chairman"]),
  },
  { name: "nothing left to read one at a time", check: ({ seen }) => assert.deepEqual(seen, [], "nothing left over to read one at a time") },
  {
    name: "the lanes are the one-at-a-time read's",
    check: ({ together }) => assert.deepEqual(together, readTrackerLanes(sequentialRun([], { open: FULL_PAGE }) as never), "the same lanes"),
  },
];

testEach("a FULL open page is not folded: the two label lists are asked, together in ONE more batch, and the lanes are the one-at-a-time read's", FULL_PAGE_CHECKS, (c) => {
  const batches: Call[][] = [];
  const seen: Call[] = [];
  const together = readTrackerLanes(sequentialRun(seen, { open: FULL_PAGE }) as never, fakeBatch(batches, { open: FULL_PAGE }));
  c.check({ batches, seen, together });
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

test("wave 3: the closed-answer reads FOLLOW the label list when its answer is only known after the first batch, so they run one at a time while the comments, the label list and the closings go in ONE batch", () => {
  const asked = { batches: [] as Call[][], seen: [] as Call[] };
  const together = readOpenRowFollowUps(CLAIMED_ROWS, sequentialRun(asked.seen) as never, fakeBatch(asked.batches));
  assert.equal(asked.batches.length, 1);
  assert.deepEqual(asked.batches[0].map(shape).sort(), ["rows labelled in-progress", "recently closed", "label list"].sort());
  assert.deepEqual(together.claimedComments, [{ number: 42, comments: [] }]);
  assert.ok(together.closings instanceof Map && together.closings.get(9) !== undefined, "the closings are the closings read, keyed by row");
  assert.deepEqual(asked.seen.map(shape), ["closed issues", "closed pullRequests"], "the closed-answer reads follow the label list, so they run one at a time, as they did");
  assert.deepEqual(together, readOpenRowFollowUps(CLAIMED_ROWS, sequentialRun([]) as never), "the same follow-ups");
});

test("THE WIRING: main reads the tracker lanes and the follow-ups through the two waves, and no longer one by one", () => {
  const source = workGateSource();
  const main = source.slice(source.indexOf("\nfunction main()"));
  assert.match(main, /readLanesAfterOutageCheck\(\)/); // slice 6: the tracker lanes ride the one wave with the other repositories' lists
  assert.match(main, /readOpenRowFollowUps\(allOpen\)/);
  assert.doesNotMatch(main, /\breadPromotableRows\(\)|\breadChairmanBlocked\(\)|\breadOpenRows\(\)|\bclaimedRowCommentsWhenHeld\(|\bclosingsWhenRowsCleared\(|\bclosedAnswerRows\(\)/);
});

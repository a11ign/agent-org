// no-token: gh -- importing `work-gate.mjs` reaches `defaultRun` (`execFileSync("gh", ...)`), and this file never lets it run: `orgHealthNow` is handed the clock, the last merge, the exact-start read, the fleet reading, the lab-job read, the waits and the log, and `readMilestoneMoves` is handed a `run` of its own.
/**
 * THE PRIMARY MILESTONE'S CLOCK STARTS AT THE REAL LAST MOVE (#4295, part of #4231). #4231 started it at the last merge the tick already holds, a proxy that is later than the
 * milestone's own last move whenever anything else merged (silent) and EARLIER than it when a claim was released or a pull request closed with no merge (a false alarm to `ceo`).
 * The row: when the proxy has ALREADY tripped, ONE conditional read takes the latest of the milestone's claim endings, row closings and pull-request closings, and the reading is made again.
 *
 * `moves` below is the seam for that read (`readMilestoneMoves`): `orgHealthNow` is the function the tick calls, so these run it, and the second half runs the read itself over a fake `gh`.
 * THE POSITIVE CONTROL is the first test, which TRIPS at 121 minutes with nothing newer than the merge; every "clear" differs from it by one thing: the move, 30 minutes ago.
 * The 120 is written out as `120`, never as `MILESTONE_CLOCK_MINUTES`, so moving the constant turns a test red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { orgHealthNow, readMilestoneMoves } from "../work-gate/org-health.mjs";

const MINUTE_MS = 60_000;
const NOW = Date.parse("2026-10-08T22:00:00Z");
const SUBJECT = "primary-milestone-idle";
const iso = (ms: number) => new Date(ms).toISOString();
const ago = (minutes: number) => NOW - minutes * MINUTE_MS;

const PRIMARY = { number: 10, title: "v3 — Ready for a first outside adopter", dueOn: null, description: "THE PRIMARY GOAL.\n\nPrimary: yes" };

type Row = Record<string, unknown> & { number: number };
const row = (number: number, labels: string[], createdMinutesAgo: number): Row => ({
  number, title: `row ${number}`, labels: labels.map((name) => ({ name })), body: "", milestone: PRIMARY, createdAt: iso(ago(createdMinutesAgo)), updatedAt: iso(ago(1)), blockedBy: { nodes: [] },
});
/** Three unclaimed rows, the newest opened `idle` minutes ago. */
const threeRows = (idle: number): Row[] => [row(101, ["parked", "lane:any"], idle + 300), row(102, ["backlog", "lane:any"], idle + 200), row(103, ["backlog", "lane:any"], idle)];

const decideArgs = { prs: [], required: [], readyRows: [], prFiles: new Map(), rowBranches: [], openRows: [], primaryDrift: null, claimRefusals: [] };

type Moves = { at: number | null } | null | "throws";
/** One org-health tick as `main` runs it; `moves` is what the exact-start read answers, and `asked` records every call to it. */
function tick({ rows, lastMerge = 600, moves = { at: null } }: { rows: Row[] | null; lastMerge?: number | null; moves?: Moves }) {
  const said: string[] = [];
  const asked: unknown[] = [];
  const orders = orgHealthNow(
    { prsRead: [], readyRead: [], openRowsRead: rows, decideArgs, decided: [] } as never,
    { now: NOW, lastMergedAt: () => (lastMerge === null ? null : ago(lastMerge)), log: (line: string) => said.push(line), readCopies: () => [] as never,
      readCaptures: (() => ({ captures24h: 3, lastCaptureAt: ago(10) })) as never, readLabJobs: () => [], readWaits: (() => null) as never, teamAccess: () => undefined,
      readMilestoneMoves: ((input: unknown) => { asked.push(input); if (moves === "throws") throw new Error("gh refused"); return moves; }) as never },
  );
  return { clock: orders.filter((order: { subject: string }) => order.subject === SUBJECT), orders, said, asked };
}

// --- the exact start ------------------------------------------------------------------------------------------------------

test("POSITIVE CONTROL: nothing newer than the merge still TRIPS at 121 minutes, and the extra read was asked once", () => {
  const { clock, asked } = tick({ rows: threeRows(121), lastMerge: 180, moves: { at: null } });
  assert.equal(clock.length, 1);
  assert.match(clock[0].prompt, /#101\b/, "the oldest open row is still named");
  assert.equal(asked.length, 1, "ONE extra read on the path that would alarm");
  assert.deepEqual(asked[0], { primary: 10, openRows: [101, 102, 103], since: ago(120) }, "it asks about the primary milestone's open rows, over the clock's own bound");
});

test("a claim released WITHOUT a merge 30 minutes ago, with the last merge 3 hours ago, is CLEAR (the proxy alone would have tripped)", () => {
  assert.deepEqual(tick({ rows: threeRows(121), lastMerge: 180, moves: { at: ago(30) } }).clock, []);
});

test("a pull request closed unmerged 30 minutes ago is CLEAR; the same read answering 'a move 130 minutes ago' still TRIPS, and says since WHEN", () => {
  assert.deepEqual(tick({ rows: threeRows(121), lastMerge: 180, moves: { at: ago(30) } }).clock, []);
  const late = tick({ rows: threeRows(200), lastMerge: 300, moves: { at: ago(130) } }).clock;
  assert.equal(late.length, 1);
  assert.match(late[0].prompt, new RegExp(`since ${iso(ago(130)).replace(/\.\d+Z$/, "Z")}`), "the order's start is the move, not the merge");
});

test("a merge NEWER than the move wins: the later of the two starts the clock", () => {
  assert.deepEqual(tick({ rows: threeRows(121), lastMerge: 30, moves: { at: ago(130) } }).clock, []);
  assert.equal(tick({ rows: threeRows(121), lastMerge: 130, moves: { at: ago(180) } }).clock.length, 1);
});

// --- the extra read is made only when the cheap gates tripped ---------------------------------------------------------------

test("a clear milestone makes ZERO extra calls: a merge 30 minutes ago, rows newer than 120 minutes, a claimed row, no primary milestone, a refused merge read", () => {
  const claimed = threeRows(121);
  claimed[2] = row(103, ["in-progress", "session:worker-103"], 121);
  const unmarked = threeRows(121).map((r) => ({ ...r, milestone: { ...PRIMARY, description: "Out of release." } }));
  for (const [what, args] of [["recent merge", { rows: threeRows(121), lastMerge: 30 }], ["rows 119 minutes old", { rows: threeRows(119), lastMerge: 600 }],
    ["a claimed row", { rows: claimed, lastMerge: 600 }], ["no primary milestone", { rows: unmarked, lastMerge: 600 }], ["merge read refused", { rows: threeRows(121), lastMerge: null }],
    ["open rows unread", { rows: null, lastMerge: 600 }]] as const) {
    const { asked, clock } = tick({ ...args });
    assert.equal(asked.length, 0, `${what}: no extra call`);
    assert.deepEqual(clock, [], what);
  }
});

// --- an unreadable extra read is UNKNOWN ------------------------------------------------------------------------------------

test("an unreadable extra read (null, or a throw) is UNKNOWN: no order, said on the log, never clear", () => {
  for (const moves of [null, "throws"] as const) {
    const { clock, said } = tick({ rows: threeRows(121), lastMerge: 180, moves });
    assert.deepEqual(clock, [], `${moves}: no order`);
    assert.ok(said.some((line) => line.includes(`${SUBJECT} UNKNOWN`) && line.includes("not read as clear")), `${moves}: says so`);
  }
});

// --- the other orders' ALSO TRIPPED line follows the clock ------------------------------------------------------------------

test("the other orders' `ALSO TRIPPED` line stops naming the clock when the exact start clears it, and keeps it when it still trips", () => {
  const stillTripped = tick({ rows: threeRows(121), lastMerge: 600, moves: { at: null } });
  const others = stillTripped.orders.filter((order: { subject: string }) => order.subject !== SUBJECT);
  assert.ok(others.length > 0, "POSITIVE CONTROL: another signal (`idle-with-open-rows`, which reads the same unclaimed rows) trips beside the clock");
  assert.ok(others.every((order: { prompt: string }) => order.prompt.includes(SUBJECT)), "while the clock trips, every other order names it");
  assert.match(stillTripped.clock[0].prompt, /ALSO TRIPPED \(\d+\): [^\n]*idle-with-open-rows/, "and the clock's own order names them");
  const cleared = tick({ rows: threeRows(121), lastMerge: 600, moves: { at: ago(30) } });
  assert.deepEqual(cleared.clock, []);
  const clearedOthers = cleared.orders.filter((order: { subject: string }) => order.subject !== SUBJECT);
  assert.equal(clearedOthers.length, others.length, "the other orders are still there");
  assert.ok(clearedOthers.every((order: { prompt: string }) => !order.prompt.includes(SUBJECT)), "but none names a clock that no longer trips");
});

// --- the read itself, over a fake gh -----------------------------------------------------------------------------------------

type Event = { at: string; event: string; label?: string; milestone?: number; pr?: boolean };
type Pull = { at: string; closedAt: string; body: string };
const OPEN_ROWS = [101, 102, 103];
const SINCE = ago(120);
const event = (minutes: number, over: Partial<Event> = {}): Event => ({ at: iso(ago(minutes)), event: "unlabeled", label: "session:worker-101", milestone: 10, pr: false, ...over });
const pull = (minutes: number, body = "Closes a11ign/a11ign#102"): Pull => ({ at: iso(ago(minutes)), closedAt: iso(ago(minutes)), body });

/** A fake `gh api` answering the events list and each repository's closed pull requests, a page at a time. */
function fakeGh({ events = [] as Event[], pulls = {} as Record<string, Pull[]>, refuse = "" }) {
  const calls: string[] = [];
  const run = (args: string[]) => {
    const path = args[1];
    calls.push(path);
    if (refuse !== "" && path.includes(refuse)) throw new Error("HTTP 403");
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
    const list = path.includes("/issues/events") ? events : (pulls[/repos\/([^/]+\/[^/?]+)\/pulls/.exec(path)?.[1] ?? ""] ?? []);
    return JSON.stringify(list.slice((page - 1) * 100, page * 100));
  };
  return { run, calls };
}
const read = (gh: ReturnType<typeof fakeGh>, repos = ["a11ign/agent-org"]) =>
  readMilestoneMoves({ primary: 10, openRows: OPEN_ROWS, since: SINCE }, { run: gh.run, tracker: "a11ign/a11ign", repos });

test("the read: a claim label coming off a milestone row, and a milestone row closing, are moves; the newest wins", () => {
  assert.deepEqual(read(fakeGh({ events: [event(10, { event: "closed", label: "" }), event(30), event(90)] })), { at: ago(10) });
  assert.deepEqual(read(fakeGh({ events: [event(30, { label: "in-progress" }), event(90)] })), { at: ago(30) });
});

test("the read: events that are NOT moves are ignored (another milestone, a pull request, an unrelated label, a label added, a move older than the window)", () => {
  const events = [event(5, { milestone: 7 }), event(6, { pr: true }), event(7, { label: "ready" }), event(8, { event: "labeled" }), event(9, { milestone: 0 }), event(200)];
  assert.deepEqual(read(fakeGh({ events: [...events, event(121, { event: "unlabeled" })] })), { at: null }, "nothing in the window");
  assert.deepEqual(read(fakeGh({ events: [...events, event(40)] })), { at: ago(40) }, "and the one real move among them is found");
});

test("the read: a pull request closed UNMERGED that declares it closes an open row of the milestone is a move; one closing another row, or `Closes: none`, is not", () => {
  const pulls = { "a11ign/agent-org": [pull(20, "Closes a11ign/a11ign#555"), pull(25, "Closes: none -- docs"), pull(30), pull(200)] };
  assert.deepEqual(read(fakeGh({ pulls })), { at: ago(30) });
  assert.deepEqual(read(fakeGh({ pulls: { "a11ign/agent-org": [pull(20, "Closes a11ign/a11ign#555"), pull(25, "Closes: none -- docs")] } })), { at: null });
});

test("the read: each declared repository is asked, and a bare `Closes #102` on another repository closes ITS row 102, not the tracker's", () => {
  const gh = fakeGh({ pulls: { "a11ign/agent-org": [pull(10, "Closes #102"), pull(50)], "a11ign/layer": [pull(15), pull(12, "Closes a11ign/other#102")] } });
  assert.deepEqual(read(gh, ["a11ign/agent-org", "a11ign/layer"]), { at: ago(15) });
  assert.equal(gh.calls.filter((path) => path.includes("/pulls")).length, 2, "one list per repository");
});

test("the read: a refused call is UNKNOWN (null), and so is a list that does not reach back to the window's start", () => {
  const moves = [event(30)];
  assert.equal(read(fakeGh({ events: moves, refuse: "/issues/events" })), null, "events refused");
  assert.equal(read(fakeGh({ events: moves, refuse: "/pulls" })), null, "pull requests refused");
  const crowded = Array.from({ length: 300 }, (_, i) => event(1 + (i % 100) * 0.1, { label: "ready" }));
  assert.equal(read(fakeGh({ events: crowded })), null, "300 events all newer than the window: a move beyond them cannot be ruled out");
  const reaches = [...Array.from({ length: 150 }, (_, i) => event(1 + i * 0.1, { label: "ready" })), event(500, { label: "ready" })];
  assert.deepEqual(read(fakeGh({ events: reaches })), { at: null }, "a list that reaches back past the window is answered, from its second page");
});

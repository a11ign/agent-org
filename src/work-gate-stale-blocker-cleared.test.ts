// no-token: gh -- every `gh`, `git`, clock, closing time and pull request list here is injected; nothing imported reaches the real one
/**
 * #3451: A `blocker-cleared` ORDER IS DROPPED, WITH ITS REASON, WHEN ITS HOLDER ALREADY ACTED ON THE NEWS.
 *
 * #3390's last blocker (#3384) closed at 10:35:57Z and the worker CLAIMED at 10:37:38Z -- a claim is refused while a `blockedBy` edge is open, so the claim itself
 * was the answer. The gate built the order three minutes later, deferred it 13 ticks, and delivered "PICK IT BACK UP" at 11:07:46Z, 1 min 46 s after the worker
 * opened its pull request (a11ign/agent-org#134, a repository the narrower screen never read, with a `Closes: none` body it could not parse).
 *
 * THE POSITIVE CONTROL FOR EVERY "NO ORDER" ASSERTION IS THE SAME FIXTURE WITH ONE THING CHANGED: `CONTROL` claims BEFORE the clearing with nothing done since (the #1908
 * shape this cause was written for) and gets its order; each drop case differs from it in the one field that drops it. The tick that builds the facts is the REAL
 * `claimStallTick`, so `ownsPr`, `commentMove` and the claim record's parser are exercised and not restated.
 */
import { rs } from "@rstest/core";
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockerClearedOrders } from "./work-gate.ts";
import { blockerClearedReading, decide } from "./work-gate/tick/blocker-cleared-reading.ts";
import { claimStallTick } from "./work-gate/claim-stall-tick.ts";
import { readRecentlyClosed, BLOCKER_CLEARED_DROP_REASONS } from "./work-gate/causes/rows-blocker-cleared.ts";
import { claimRecordComment } from "./row-claim.ts";
import { readsRecentlyClosed, recentlyClosedConnection } from "./packaging/rows-by-label-fixtures.ts";

const T = (hms: string, day = "2026-10-04") => Date.parse(`${day}T${hms}Z`);
const CLEARED = T("10:35:57");
const TODAY = "2026-10-04";
const ROW = 3390;
const SESSION = "worker-3390";
const BRANCH = "agent/a-needs-chairman-row-3390";
const WORKER = "a11ign-ai-workers";
const KEY = "worker-3390/blocker-cleared/row-3390/3384";

type Comment = { body: string; createdAt: string; author: { login: string } };
type Pr = { number: number; headRefName: string; title?: string; createdAt?: string; mergedAt?: string; labels?: { name: string }[]; repoKey?: string };
type Facts = Parameters<typeof blockerClearedReading>[3] extends infer R ? (R extends { claimFacts?: infer F } ? F : never) : never;

const heldRow = () => ({ number: ROW, title: "a row", body: "", labels: [{ name: "in-progress" }, { name: `session:${SESSION}` }],
  blockedBy: { nodes: [{ number: 3384, state: "CLOSED" }] } });
const claimAt = (at: number): Comment => ({ body: claimRecordComment({ session: SESSION, branch: BRANCH, worktree: "../wt-3390" }),
  createdAt: new Date(at).toISOString(), author: { login: WORKER } });
const said = (at: number): Comment => ({ body: "built the first half", createdAt: new Date(at).toISOString(), author: { login: WORKER } });
const elsewherePr = (extra: Partial<Pr> = {}): Pr => ({ number: 134, headRefName: "agent/chairman-answered-3390", title: "Answer the chairman (a11ign/a11ign#3390)",
  createdAt: "2026-10-04T11:06:00Z", repoKey: "agent-org", ...extra });

/** A git that knows no commit and no branch of anyone's: the holder has committed and pushed nothing, unless a test says otherwise. */
const io = { git: () => ({ status: 1, out: "" }), exists: () => false, mtime: () => null };

interface Scenario {
  claimed?: number; comments?: Comment[]; openElsewhere?: Pr[] | null; mergedElsewhere?: Pr[] | null; closings?: Map<number, number> | null;
  /** `false`: do not pass the facts at all (today's caller). */
  facts?: boolean;
  /** The clock `blockerClearedReading` is asked at. */
  now?: number;
}

/** The real claim-stall tick over one claimed row, handing its facts on, then `blockerClearedReading` over them. */
function read({ claimed = T("10:30:00"), comments, openElsewhere = [], mergedElsewhere = [], closings = new Map([[3384, CLEARED]]), facts = true, now = T("12:00:00") }: Scenario = {}) {
  let claimFacts: Facts = undefined as never;
  const log: string[] = [];
  claimStallTick({ rows: [heldRow()], claimedComments: [{ number: ROW, comments: comments ?? [claimAt(claimed)] }], openPrs: [], mergedPrs: [],
    elsewhere: { open: openElsewhere, merged: mergedElsewhere } as never, io, repo: "/home/agent/repos/a11y-witness", now: T("12:00:00"), restartAt: null, agents: null,
    stateDir: "/state", ledger: () => "", log: (line: string) => log.push(line), read: () => ({}), write: () => {},
    onFacts: (f: unknown) => { claimFacts = f as Facts; } });
  return blockerClearedReading([heldRow()], TODAY, now, { openPrs: [], closings, ...(facts ? { claimFacts } : {}) });
}

const only = <T,>(items: T[]): T => {
  assert.equal(items.length, 1, JSON.stringify(items));
  return items[0];
};

test("#3451 (5) THE POSITIVE CONTROL: claimed BEFORE the clearing, nothing done since, no pull request anywhere -- ONE order, today's prompt, no drop", () => {
  const reading = read();
  const order = only(reading.orders);
  assert.equal(order.causeKey, KEY);
  assert.deepEqual(reading.drops, []);
  assert.deepEqual(reading.log, []);
  assert.deepEqual(reading.orders, blockerClearedOrders([heldRow()], TODAY, T("12:00:00"), { closings: new Map([[3384, CLEARED]]) }),
    "the order is byte-for-byte what a caller without the facts gets");
  assert.match(order.prompt, /PICK IT BACK UP; you already hold the claim/);
});

test("#3451 (1) the #3390 timeline: blocker closed 10:35:57Z, claim 10:37:38Z -- no order, one drop, `claimed-after-clearing`", () => {
  const claimed = T("10:37:38");
  const reading = read({ claimed });
  assert.deepEqual(reading.orders, []);
  assert.deepEqual(reading.drops, [{ causeKey: KEY, reason: "claimed-after-clearing", at: claimed }]);
  assert.match(only(reading.log), /^SHELVED row #3390: blocker-cleared order dropped, claimed-after-clearing \(claimed 2026-10-04T10:37:38.000Z, blockers closed 2026-10-04T10:35:57.000Z/);
  // BEFORE: without the facts the same row is the order the worker was woken for.
  assert.equal(only(read({ claimed, facts: false }).orders).causeKey, KEY, "today's `blockerClearedOrders` emits it");
});

test("#3451 (2) claimed before the clearing, but the holder's pull request is OPEN in another tracked repository (a `Closes: none` one) -- `own-pull-request`", () => {
  const reading = read({ openElsewhere: [elsewherePr()] });
  assert.deepEqual(reading.orders, []);
  assert.deepEqual(reading.drops, [{ causeKey: KEY, reason: "own-pull-request", at: T("11:06:00") }]);
});

test("#3451 (3) the same pull request MERGED after the claim -- `own-pull-request`, decided at the merge", () => {
  const reading = read({ mergedElsewhere: [elsewherePr({ mergedAt: "2026-10-04T11:19:39Z" })] });
  assert.deepEqual(reading.drops, [{ causeKey: KEY, reason: "own-pull-request", at: T("11:19:39") }]);
  assert.deepEqual(reading.orders, []);
  assert.equal(only(read({ mergedElsewhere: [elsewherePr({ mergedAt: "2026-10-04T10:00:00Z" })] }).orders).causeKey, KEY,
    "CONTROL: a merge BEFORE the claim is another instance's work, and the holder is still told");
});

test("#3451 (4) no pull request, but the holder commented at 10:50:00Z -- `moved-since-clearing`; a comment BEFORE the clearing is not a move", () => {
  const reading = read({ comments: [claimAt(T("10:30:00")), said(T("10:50:00"))] });
  assert.deepEqual(reading.drops, [{ causeKey: KEY, reason: "moved-since-clearing", at: T("10:50:00") }]);
  assert.deepEqual(reading.orders, []);
  assert.equal(only(read({ comments: [claimAt(T("10:30:00")), said(T("10:33:00"))] }).orders).causeKey, KEY, "CONTROL: moved, but before the clearing");
});

test("#3451 a pull request that is HELD is a declared wait and does not answer the cause (#2493): its owner must still hear the last edge close", () => {
  const held = elsewherePr({ labels: [{ name: "hold:ceo" }] });
  assert.equal(only(read({ openElsewhere: [held] }).orders).causeKey, KEY);
  assert.equal(read({ openElsewhere: [elsewherePr({ labels: [{ name: "lane:any" }] })] }).orders.length, 0, "CONTROL: the same PR without the hold drops it");
});

test("#3451 (8) a pull request in another repository that is NOT the holder's (another row's) drops nothing", () => {
  const theirs = elsewherePr({ number: 200, headRefName: "agent/something-else-3999", title: "Something else (a11ign/a11ign#3999)" });
  const reading = read({ openElsewhere: [theirs], mergedElsewhere: [{ ...theirs, mergedAt: "2026-10-04T11:19:39Z" }] });
  assert.equal(only(reading.orders).causeKey, KEY);
  assert.deepEqual(reading.drops, []);
});

test("#3451 (6) EACH REFUSED READ FAILS TOWARD TELLING THE HOLDER: the order is kept and the log names the read", () => {
  const claimedAfter = T("10:37:38"); // every case below WOULD drop on `claimed-after-clearing` if its read had been made
  const unreadableRecord = read({ comments: [] });
  const noElsewhere = read({ claimed: claimedAfter, openElsewhere: null, mergedElsewhere: null });
  const noClosings = read({ claimed: claimedAfter, closings: null });
  // A blocker absent from `closings` closed before the window that read covers and counts as the epoch, so the order is in a window only on the 72-hour grid.
  const onTheGrid = 20_000 * 72 * 60 * 60_000 + 60_000;
  const unknownBlocker = read({ claimed: claimedAfter, closings: new Map([[999, CLEARED]]), now: onTheGrid });
  const cases: [string, ReturnType<typeof read>, RegExp][] = [
    ["claim record", unreadableRecord, /order KEPT -- the claim read was refused \(.*no claim record/],
    ["elsewhere", noElsewhere, /order KEPT -- the claim read was refused \(.*other tracked repository's open pull requests could not be read/],
    ["closings", noClosings, /order KEPT -- the closing times were not read/],
    ["a blocker absent from closings", unknownBlocker, /order KEPT -- the closing time of #3384 was not read/],
  ];
  for (const [name, reading, line] of cases) {
    assert.ok(only(reading.orders).causeKey.startsWith(KEY), `${name}: the order is kept`); // the grid case's key carries its window's \`@<hours>h\``
    assert.deepEqual(reading.drops, [], `${name}: nothing dropped`);
    assert.match(only(reading.log), line, name);
  }
  const noTick = blockerClearedReading([heldRow()], TODAY, T("12:00:00"), { closings: new Map([[3384, CLEARED]]), claimFacts: null });
  assert.equal(only(noTick.orders).causeKey, KEY, "a tick that read no claim keeps the order");
  assert.match(only(noTick.log), /the claim-stall tick read no claim/);
  assert.equal(read({ claimed: claimedAfter }).orders.length, 0, "CONTROL: with every read made, the first three DO drop");
});

test("#3451 (7) a drop's reason is one of THREE, and the three cases above each produce a different one", () => {
  assert.deepEqual([...BLOCKER_CLEARED_DROP_REASONS], ["claimed-after-clearing", "own-pull-request", "moved-since-clearing"]);
  const drops = [read({ claimed: T("10:37:38") }), read({ openElsewhere: [elsewherePr()] }), read({ comments: [claimAt(T("10:30:00")), said(T("10:50:00"))] })]
    .flatMap((reading) => reading.drops);
  assert.equal(drops.length, 3, "the population is not empty: this is the control the closed-set assertion is read against");
  assert.deepEqual(drops.map((d) => d.reason).sort(), [...BLOCKER_CLEARED_DROP_REASONS].sort());
});

test("#3451 `decide` carries it: the order is absent with the facts and present without them, and no caller that omits `claimFacts` changes", () => {
  const args = { prs: [], readyRows: [], openRows: [heldRow()], closings: new Map([[3384, CLEARED]]) };
  let claimFacts: Facts = undefined as never;
  claimStallTick({ rows: [heldRow()], claimedComments: [{ number: ROW, comments: [claimAt(T("10:37:38"))] }], openPrs: [], mergedPrs: [], elsewhere: { open: [], merged: [] } as never,
    io, repo: "/home/agent/repos/a11y-witness", now: T("12:00:00"), restartAt: null, agents: null, stateDir: "/state", ledger: () => "", log: () => {},
    read: () => ({}), write: () => {}, onFacts: (f: unknown) => { claimFacts = f as Facts; } });
  const blockerCleared = (orders: { cause: string }[]) => orders.filter((o) => o.cause === "blocker-cleared");
  // `decide` reads the wall clock for this cause, and the order is due only inside the ask window's grid after the clearing: pin it, or the test passes at some hours and not others.
  rs.useFakeTimers({ toFake: ["Date"], now: T("12:00:00") });
  try {
    assert.equal(blockerCleared(decide(args as never)).length, 1, "without `claimFacts` (an old caller) the order is emitted, as before");
    assert.equal(blockerCleared(decide({ ...args, claimFacts } as never)).length, 0);
  } finally {
    rs.useRealTimers();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// #3706: A BLOCKER ABSENT FROM THE CLOSING LIST IS BOUNDED, NOT UNREAD.
//
// `gh issue list --state closed --limit 100` is the 100 most recently CREATED closed rows, so #3534's blocker #3509 (closed 2026-10-04T20:56:24Z, created long before) was absent and the
// order was KEPT for six hours for a worker that had claimed at 18:37:10Z. The list is now read ordered by `updatedAt` (first `--search sort:updated-desc`, and since #5050 the
// `issues(states: CLOSED, orderBy: UPDATED_AT)` connection, which is no search), and `closedAt <= updatedAt` makes the OLDEST LISTED
// `updatedAt` an upper bound on every absent row's closing. THE FIXTURE PINS BOTH SORTS: its oldest listed closing (3538, 2026-10-04T20:31:42Z) is NOT its oldest listed `updatedAt`
// (3532, 2026-10-05T02:02:42Z), so a bound taken from the oldest closing -- the refuted one -- fails (3).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

const D = (iso: string) => T(iso, "2026-10-05");
const BOUND = D("02:02:42");
const NUMBER = 3534;
const HOLDER = "worker-3534";

/** The listing the live call returned, trimmed: sorted by `updatedAt` descending, with 3538's closing OLDER than anything's `updatedAt`. */
const listing = [
  { number: 3723, closedAt: "2026-10-05T22:56:16Z", updatedAt: "2026-10-05T22:56:16Z" },
  { number: 3667, closedAt: "2026-10-05T12:11:59Z", updatedAt: "2026-10-05T12:11:59Z" },
  { number: 3538, closedAt: "2026-10-04T20:31:42Z", updatedAt: "2026-10-05T03:00:00Z" },
  { number: 3532, closedAt: "2026-10-05T00:38:59Z", updatedAt: "2026-10-05T02:02:42Z" },
];
const closingsOf = (rows: object[] = listing) => readRecentlyClosed((args) => {
  if (!readsRecentlyClosed(args)) throw new Error(`unexpected call: ${args.join(" ")}`);
  return recentlyClosedConnection(rows);
});

const rowOf = (blockers: number[]) => ({ number: NUMBER, title: "a row", body: "", labels: [{ name: "in-progress" }, { name: `session:${HOLDER}` }],
  blockedBy: { nodes: blockers.map((number) => ({ number, state: "CLOSED" })) } });

/** The real claim-stall tick over the #3534 row, then `blockerClearedReading` over its facts, at `now`. */
function readBounded({ blockers, claimed, closings, now }: { blockers: number[]; claimed: number; closings: ReturnType<typeof closingsOf>; now: number }) {
  let claimFacts: Facts = undefined as never;
  const comment = { body: claimRecordComment({ session: HOLDER, branch: "agent/a-blocker-3534", worktree: "../wt-3534" }), createdAt: new Date(claimed).toISOString(), author: { login: WORKER } };
  claimStallTick({ rows: [rowOf(blockers)], claimedComments: [{ number: NUMBER, comments: [comment] }], openPrs: [], mergedPrs: [], elsewhere: { open: [], merged: [] } as never, io,
    repo: "/home/agent/repos/a11y-witness", now, restartAt: null, agents: null, stateDir: "/state", ledger: () => "", log: () => {}, read: () => ({}), write: () => {},
    onFacts: (f: unknown) => { claimFacts = f as Facts; } });
  return blockerClearedReading([rowOf(blockers)], "2026-10-05", now, { openPrs: [], closings, claimFacts });
}

const T3534 = { blockers: [3509, 3532, 3667], now: D("18:38:49") };

test("#3706 (a) the reader asks ONE call, sorted by updatedAt, and bounds an absent row by the OLDEST LISTED updatedAt (not the oldest closing)", () => {
  const calls: string[][] = [];
  const closings = readRecentlyClosed((args) => { calls.push(args); return recentlyClosedConnection(listing); });
  assert.equal(calls.length, 1);
  // #5050: the premise was "`--search sort:updated-desc`"; the same ordering is the connection's `orderBy`, and the call is NOT a search.
  assert.equal(readsRecentlyClosed(calls[0]), true);
  assert.deepEqual(calls[0].slice(0, 2), ["api", "graphql"]);
  assert.equal(calls[0].some((a) => a === "--search" || a.includes("sort:updated")), false, "a connection read, never a search");
  const query = String(calls[0].find((a) => a.startsWith("query=")));
  assert.match(query, /issues\(states:CLOSED,first:\$first,orderBy:\{field:UPDATED_AT,direction:DESC\}\)\{nodes\{number closedAt updatedAt\}\}/, "newest UPDATE first, closedAt and updatedAt");
  assert.equal(closings?.closedNoLaterThan, BOUND);
  assert.ok(Math.min(...(closings as Map<number, number>).values()) < BOUND, "CONTROL: the oldest listed closing is NOT the bound, so the two sorts are told apart");
  assert.equal(closings?.get(3667), D("12:11:59"), "the map is still a Map of closings");
});

test("#3706 (b) THE BOUND IS CHECKED, NOT TRUSTED: a listing not sorted by updatedAt, or one with an unreadable updatedAt, carries none", () => {
  const sortedByCreation = [...listing].reverse(); // what a read returns when its sort key is silently ignored: updatedAt ascending here
  const noUpdated = listing.map(({ updatedAt: _dropped, ...rest }) => rest); // an old fake, or a field `gh` stopped returning
  const garbled = listing.map((r, i) => (i === 2 ? { ...r, updatedAt: "not a date" } : r));
  for (const [name, rows] of [["unsorted", sortedByCreation], ["no updatedAt", noUpdated], ["unreadable updatedAt", garbled], ["empty", []]] as const) {
    assert.equal(closingsOf([...rows])?.closedNoLaterThan, undefined, name);
  }
  assert.equal(closingsOf()?.closedNoLaterThan, BOUND, "CONTROL: the sorted listing does carry one");
  assert.equal(readRecentlyClosed(() => { throw new Error("gh refused"); }), null);
  assert.equal(readRecentlyClosed(() => JSON.stringify({ data: { repository: { issues: null } }, errors: [{ message: "x" }] })), null, "#5050: an answer that is no connection is a refusal, never an empty list");
  assert.equal(readRecentlyClosed(() => JSON.stringify(listing)), null, "and the old `issue list` array is no answer to the connection read");
});

test("#3706 (1) the #3534 timeline: #3509 absent, claim 2026-10-05T18:37:10Z -- no order, one drop, `claimed-after-clearing` (and it was KEPT before)", () => {
  const reading = readBounded({ ...T3534, claimed: D("18:37:10"), closings: closingsOf() });
  assert.deepEqual(reading.orders, []);
  assert.deepEqual(reading.drops.map((d) => d.reason), ["claimed-after-clearing"]);
  assert.match(only(reading.log), /^SHELVED row .*3534.*blocker-cleared order dropped, claimed-after-clearing \(claimed 2026-10-05T18:37:10.000Z, blockers closed 2026-10-05T12:11:59.000Z/);
});

test("#3706 (1b) CONTROL for (1): the same row claimed BEFORE the newest listed closing (#3667, 12:11:59Z) gets ONE order", () => {
  const reading = readBounded({ ...T3534, claimed: D("10:00:00"), closings: closingsOf() });
  assert.equal(only(reading.orders).causeKey.startsWith(`${HOLDER}/blocker-cleared/row-3534/3509.3532.3667`), true);
  assert.deepEqual(reading.drops, []);
});

const BOUNDED = { blockers: [3509, 3532], now: D("02:20:00") }; // 3532 closed 00:38:59; #3509 is absent, so its closing is bounded by 02:02:42

test("#3706 (2) the same row claimed BEFORE the bound: ONE order, and the log line names the bound used", () => {
  const reading = readBounded({ ...BOUNDED, claimed: D("01:00:00"), closings: closingsOf() });
  only(reading.orders);
  assert.deepEqual(reading.drops, []);
  assert.match(only(reading.log), /order KEPT -- #3509 is absent from the closing list and closed no later than 2026-10-05T02:02:42.000Z, the oldest listed updatedAt, and the claim \(2026-10-05T01:00:00.000Z\) is not after it/);
});

test("#3706 (2b) CONTROL for (2): claimed AFTER the bound, the bound is what drops it, and the line names it", () => {
  const reading = readBounded({ ...BOUNDED, claimed: D("02:10:00"), closings: closingsOf() });
  assert.deepEqual(reading.orders, []);
  assert.match(only(reading.log), /SHELVED .*claimed-after-clearing \(claimed 2026-10-05T02:10:00.000Z, #3509 is absent from the closing list and closed no later than 2026-10-05T02:02:42.000Z/);
});

test("#3706 (3) THE POSITIVE CONTROL: an absent blocker, claim after the oldest listed CLOSING and before the oldest listed updatedAt -- ONE order, because the bound cannot prove it", () => {
  const claimed = D("01:30:00"); // after 3538's closing (2026-10-04T20:31:42Z), the refuted bound; before 02:02:42Z, the sound one
  const oldestListedClosing = Math.min(...(closingsOf() as Map<number, number>).values());
  assert.ok(oldestListedClosing < claimed && claimed < BOUND, "the fixture sits between the two bounds");
  const reading = readBounded({ ...BOUNDED, claimed, closings: closingsOf() });
  only(reading.orders);
  assert.deepEqual(reading.drops, []);
});

test("#3706 (4) an EMPTY listing, a refused read and a list that bounds nothing each KEEP the order and say which read was missing", () => {
  const claimed = D("18:37:10"); // every case WOULD drop if its read had been made: the CONTROL below is (1)
  const onTheGrid = 20_000 * 72 * 60 * 60_000 + 60_000; // an empty map reads every blocker as the epoch, so its order is due only on the 72-hour grid
  const cases: [string, ReturnType<typeof closingsOf>, number, RegExp][] = [
    ["null", null, T3534.now, /order KEPT -- the closing times were not read/],
    ["empty", closingsOf([]), onTheGrid, /order KEPT -- the closing list was empty, so no bound exists/],
    ["a map with no bound", new Map([[3532, D("00:38:59")], [3667, D("12:11:59")]]), T3534.now, /order KEPT -- the closing time of #3509 was not read/],
    ["a listing not sorted by updatedAt", closingsOf([...listing].reverse()), T3534.now, /order KEPT -- the closing time of #3509 was not read/],
  ];
  for (const [name, closings, now, line] of cases) {
    const reading = readBounded({ ...T3534, now, claimed, closings });
    assert.equal(reading.orders.length, 1, `${name}: the order is kept`);
    assert.deepEqual(reading.drops, [], `${name}: nothing dropped`);
    assert.match(only(reading.log), line, name);
  }
  assert.equal(readBounded({ ...T3534, claimed, closings: closingsOf() }).drops.length, 1, "CONTROL: with the sorted listing the same row drops");
});

// --- agent-org#805: THE POPULATION. Every order the gate can type for a HELD row, with the holder's pull request OPEN, in either tracker -------------------------
// The population is what the gate ACTUALLY types: `claimStallTick` every five minutes for four hours (claim-stalled, and a release of it) and `blockerClearedReading`
// (blocker-cleared: the home tracker's rows with the claim facts, and the other tracker's rows with their own pull requests and no claim facts, as `scopeTick` asks them). Three placements of the pull request: in the home repository, in another tracked repository
// with the row in the home tracker, and a row of the other tracker with its pull request in its own repository. THE TWIN is the same placement with NO pull request.
// The holder is IDLE at its prompt with the standing panes present (a listing without them reads `unknown`, which is no stall), and the nudge memory is carried between
// ticks as the state file carries it (an idle run is counted from its first tick, so a memory that is dropped each tick never stalls).
const POP_CLAIM = T("10:30:00");
const POP_SESSION = "worker-805";
const POP_ROW = 805;
const POP_OTHER_ROW = 806;
const POP_OTHER_TRACKER = { key: "agent-org", repo: "a11ign/agent-org" };
const POP_AGENTS = [{ label: "ceo", status: "done" }, { label: "orchestrator", status: "done" }, { label: POP_SESSION, status: "idle" }];
type Placement = "home" | "elsewhere" | "other-tracker";

const popRow = (number: number) => ({ number, title: `row ${number}`, body: "", labels: [{ name: "in-progress" }, { name: `session:${POP_SESSION}` }],
  blockedBy: { nodes: [{ number: 3384, state: "CLOSED" }] } });
const popClaim = (number: number) => ({ number, comments: [{ body: claimRecordComment({ session: POP_SESSION, branch: `agent/x-${number}`, worktree: `../wt-${number}` }),
  createdAt: new Date(POP_CLAIM).toISOString(), author: { login: WORKER } }] });
/** A pull request of the holder's, on the claim's branch, opened 15 minutes after the claim (young, and inside the clock's own interval). */
const popPr = (number: number, extra: Partial<Pr> = {}): Pr => ({ number: 900 + number, headRefName: `agent/x-${number}`, title: `row ${number}`,
  createdAt: "2026-10-04T10:45:00Z", ...extra });
/** A failing check on the holder's own pull request: the one case the #1151 ruling exempts (the red-check nudge, `redCheckNudgePrompt`). */
const POP_RED = [{ name: "gate", status: "COMPLETED", conclusion: "FAILURE" }];

/** Every order typed for the placement, as `{ cause, causeKey }`, over the claim's life. `red` puts a failing check on the holder's own pull request. */
function populationOf(placement: Placement, withPr: boolean, red = false): { cause: string; causeKey: string; }[] {
  const otherRow = placement === "other-tracker";
  const row = otherRow ? POP_OTHER_ROW : POP_ROW;
  const prExtra = red ? { statusCheckRollup: POP_RED } as Partial<Pr> : {};
  const homeOpen = withPr && placement === "home" ? [popPr(row, prExtra)] : [];
  // The other tracker's pull request closes its row BY THE TRACKER'S REFERENCE (agent-org#1162): a closing reference is what makes it the holder's work.
  const elsewhereOpen = withPr && placement !== "home" ? [popPr(row, otherRow ? { ...prExtra, repoKey: "agent-org", repo: "a11ign/agent-org", body: `Closes a11ign/agent-org#${row}` } as Partial<Pr> : { ...prExtra, repoKey: "agent-org" })] : [];
  const memory: Record<string, unknown> = {};
  const typed: { cause: string; causeKey: string; }[] = [];
  let claimFacts: Facts = undefined as never;
  for (let minutes = 0; minutes <= 240; minutes += 5) {
    const tick = claimStallTick({ rows: otherRow ? [] : [popRow(row)], claimedComments: otherRow ? [] : [popClaim(row)], openPrs: homeOpen, mergedPrs: [],
      elsewhere: { open: elsewhereOpen, merged: [] } as never, trackers: otherRow ? [{ ...POP_OTHER_TRACKER, rows: [popRow(row)], claimedComments: [popClaim(row)] }] : [],
      io, repo: "/home/agent/repos/a11y-witness", now: POP_CLAIM + minutes * 60_000, restartAt: null, agents: POP_AGENTS,
      agentSessions: null, stateDir: "/state", ledger: () => "", log: () => {}, read: () => JSON.parse(JSON.stringify(memory)),
      write: (_path: string, state: object) => { for (const k of Object.keys(memory)) delete memory[k]; Object.assign(memory, state); },
      onFacts: (f: unknown) => { if (minutes === 0) claimFacts = f as Facts; } } as never) as unknown as { cause: string; causeKey: string; }[];
    typed.push(...tick.map((o) => ({ cause: o.cause, causeKey: o.causeKey })));
  }
  // `tick.ts` asks blockerClearedOrders of the other tracker's rows with ITS pull requests and no claim facts (`scopeTick`), so that is the reading made here.
  const reading = otherRow
    ? blockerClearedReading([{ ...popRow(row), repoKey: "agent-org", repo: "a11ign/agent-org" }], TODAY, T("12:00:00"), { openPrs: elsewhereOpen, closings: new Map([[3384, CLEARED]]) })
    : blockerClearedReading([popRow(row)], TODAY, T("12:00:00"), { openPrs: homeOpen, closings: new Map([[3384, CLEARED]]), claimFacts });
  typed.push(...reading.orders.map((o) => ({ cause: "blocker-cleared", causeKey: o.causeKey })));
  return typed;
}

test("agent-org#805 THE POPULATION: no claim-stalled or blocker-cleared order is typed for a held row with an open closing pull request, in either tracker", () => {
  for (const placement of ["home", "elsewhere", "other-tracker"] as const) {
    assert.deepEqual(populationOf(placement, true), [], `${placement}: an open closing pull request types nothing`);
  }
});

test("agent-org#805 RED-CHECK CONTROL: the holder's OWN RED pull request IS nudged (the red-check nudge, the one exception), and nothing else is typed for it", () => {
  const typed = populationOf("home", true, true);
  assert.ok(typed.some((o) => o.cause === "claim-stalled"), "a red own pull request is typed: the red-check nudge is the exception the ruling names");
  assert.deepEqual([...new Set(typed.map((o) => o.cause))], ["claim-stalled"], "blocker-cleared is still not typed for it");
});

test("agent-org#805 POSITIVE CONTROL: the same rows with NO pull request ARE typed -- claim-stalled once idle, and blocker-cleared for the home row", () => {
  for (const placement of ["home", "elsewhere", "other-tracker"] as const) {
    const typed = populationOf(placement, false);
    assert.ok(typed.some((o) => o.cause === "claim-stalled"), `${placement}: claim-stalled is typed without the pull request`);
    assert.ok(typed.some((o) => o.cause === "blocker-cleared"), `${placement}: blocker-cleared is typed without the pull request`);
  }
});

// agent-org#1162: AN OTHER TRACKER'S ROW IS RESUMED BY ITS OWN PULL REQUEST. A closing reference is read against the tracker it names: `a11ign/agent-org#806` in
// any repository, `#806` in the repository the pull request is in. The gate read every reference against the PRIMARY tracker, so the holder's open pull request
// resumed nothing and blocker-cleared asked the holder to pick the row up again while its work was under review.
const otherRowOf = (number: number) => ({ ...popRow(number), repoKey: "agent-org", repo: "a11ign/agent-org" });
const otherPrOf = (body: string, extra: Record<string, unknown> = {}) => ({ number: 906, headRefName: "agent/x-806", title: "row 806", createdAt: "2026-10-04T10:45:00Z",
  body, labels: [], statusCheckRollup: [], repoKey: "agent-org", repo: "a11ign/agent-org", ...extra });
const clearedFor = (pr: Record<string, unknown>) => blockerClearedReading([otherRowOf(806)], TODAY, T("12:00:00"), { openPrs: [pr], closings: new Map([[3384, CLEARED]]) }).orders;

test("agent-org#1162 an other-tracker row whose open pull request closes it is NOT re-offered, however the reference is written", () => {
  assert.equal(clearedFor(otherPrOf("Closes a11ign/agent-org#806")).length, 0, "the tracker-qualified reference resumes the row");
  assert.equal(clearedFor(otherPrOf("Closes #806")).length, 0, "a bare reference in the tracker's own repository is the same row");
  assert.equal(clearedFor(otherPrOf("Closes #806", { repo: "a11ign/a11ign" })).length, 1, "CONTROL: a bare #806 in ANOTHER repository closes that repository's #806, not this row");
  assert.equal(clearedFor(otherPrOf("Closes a11ign/agent-org#807")).length, 1, "POSITIVE CONTROL: a pull request that closes another row resumes nothing");
});

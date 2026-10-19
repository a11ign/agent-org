// no-token: gh -- no `gh`, `herdr` or `git` is run; the rows, facts and clock are fixtures, and the only files written are in a temporary directory (#1183)
// #1183: A HOLDER THAT DECLARES ITS WAIT IN A `Waiting-for:` LINE IS NOT NUDGED. `declaredWaitOf` read only the waits the row's FIELDS carry (a label, a
// `Not-before:` date, a `Fleet-hold-until:` line), so a holder that wrote `Waiting-for: merged #4437` in its body was nudged and ledgered as
// `claimed-worker-stalled` while it waited on exactly the thing it had declared (class repeat, a11ign#5156).
//
// THE CONTROLS ARE THE SAME ROW. The same holder with NO `Waiting-for:` line is nudged at the figure; the same row with its condition MET is nudged
// at the same minute; a condition that is UNKNOWN (a `manual` wait, an unread reference, an unreadable line, no facts at all) is nudged at the same
// minute as no line. An excuse that holds past its own condition's truth, or on a read that failed, is the defect, not the fix.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claimStallTick } from "./claim-stall-tick.ts";
import { claimRecordComment } from "../row-claim.ts";
import { recordStalledNudges } from "../claim-stall.ts";
import { STALL_UNTOLD_RELEASE_MS } from "../claim-stall/claim-stalled.ts";
import { FAILURE_LEDGER_FILE, parseFailureLedger } from "../failure-ledger.ts";
import { STOPPED_CLAIMANT_MINUTES } from "../idle-claimant.ts";
import type { WaitFacts } from "../wait-condition.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-10-10T09:00:00Z");
const NUDGE_AT = STOPPED_CLAIMANT_MINUTES;
/** Long enough past the first nudge that an unanswered nudge is released, as the ledger test's horizon is. */
const HORIZON = NUDGE_AT + STALL_UNTOLD_RELEASE_MS / MIN + 5;
/** The minute the condition is met in the flip test: after the figure, so an excuse that held would show as a late nudge. */
const FLIP = NUDGE_AT + 10;
const AUTHOR = "a11ign-ai-workers";
const ROW = 4711;
const SESSION = `worker-${ROW}`;
const PARENT = 4437;
const STANDING = [{ label: "ceo", status: "done" }, { label: "orchestrator", status: "done" }];
const noGit = { git: () => ({ status: 0, out: "" }), exists: () => false, mtime: () => null };
/** A holder with an uncommitted file touched two minutes before the tick: work the gate can see, so `waitReading` has a tree to read. */
const withWork = { git: (_dir: string, args: string[]) => ({ status: 0, out: args[0] === "status" ? " M src/x.ts\n" : "" }), exists: () => true, mtime: () => T0 - 2 * MIN };

const WAITING = `Waiting-for: merged #${PARENT}`;

type Comment = { body: string; createdAt: string; author: { login: string } };
type Order = { session: string; causeKey: string; release?: { why: string } };
type Facts = WaitFacts | null;

/** The claim record as `row-claim.ts` writes it, twenty minutes before T0: the holder has been quiet since it claimed. */
const claimComment = (): Comment => ({
  body: claimRecordComment({ session: SESSION, branch: `agent/x-${ROW}`, worktree: `../wt-${ROW}` }),
  createdAt: new Date(T0 - 20 * MIN).toISOString(), author: { login: AUTHOR },
});

/** The facts the gate reads for a row's body wait: the referenced row, bare `#n`, in this repository. */
const factsOf = (state: "open" | "merged" | "closed"): WaitFacts => ({
  items: { [`#${PARENT}`]: { state, labels: [], resolvedAt: null, changedAt: null } }, releases: {},
});

function withDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "claim-stall-waiting-for-"));
  try { return body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const entriesIn = (dir: string) => existsSync(join(dir, FAILURE_LEDGER_FILE)) ? parseFailureLedger(readFileSync(join(dir, FAILURE_LEDGER_FILE), "utf8")) : [];

/**
 * One holder over the whole window, through the REAL tick and the REAL recorder. `facts` may be a function of the minute, for a condition that becomes true
 * while the holder is quiet. Returns each order with its minute, every reading the tick made with its minute, and the ledger's entries.
 */
function runWindow(body: string, facts: Facts | ((minute: number) => Facts), dir: string, io: typeof noGit | typeof withWork = noGit) {
  const memory: Record<string, unknown> = {};
  const comments = [claimComment()];
  const logPath = join(dir, FAILURE_LEDGER_FILE);
  const orders: { minute: number; order: Order; }[] = [];
  const readings: { minute: number; kind: string; waiting?: string; }[] = [];
  for (let minute = 0; minute <= HORIZON; minute++) {
    const seen: { reading: { kind: string; waiting?: string; }; }[] = [];
    const found = claimStallTick({
      rows: [{ number: ROW, title: `row ${ROW}`, body, blockedBy: { nodes: [] }, labels: ["in-progress", `session:${SESSION}`].map((name) => ({ name })) }],
      claimedComments: [{ number: ROW, comments }],
      openPrs: [], mergedPrs: null, io, repo: "/repo", now: T0 + minute * MIN, restartAt: null,
      agents: [...STANDING, { label: SESSION, status: "idle" }], stateDir: dir, ledger: () => "", log: () => undefined,
      read: () => JSON.parse(JSON.stringify(memory)),
      write: (_path: string, state: object) => { for (const k of Object.keys(memory)) delete memory[k]; Object.assign(memory, state); },
      waitFacts: typeof facts === "function" ? facts(minute) : facts,
      record: (tick: Parameters<typeof recordStalledNudges>[0]) => {
        seen.push(...(tick.readings as unknown as typeof seen));
        return recordStalledNudges({ ...tick, logPath, report: () => undefined });
      },
    } as never) as unknown as Order[];
    for (const order of found) orders.push({ minute, order });
    for (const { reading } of seen) readings.push({ minute, kind: reading.kind, waiting: reading.waiting });
  }
  return { orders, readings, entries: entriesIn(dir) };
}

/** The first minute the gate orders a nudge or a release for the holder. */
const firstOrderMinute = (r: ReturnType<typeof runWindow>) => r.orders.length === 0 ? null : r.orders[0].minute;

// --- the excuse holds while its condition is unmet --------------------------------------------------------------------------------

test("#1183 an UNMET Waiting-for excuses the holder: read `waiting` naming the condition, no order, and no ledger line", () => withDir((dir) => {
  const r = runWindow(`Ready.\n\n${WAITING}\n`, factsOf("open"), dir);
  assert.deepEqual(r.orders, [], "no nudge and no release while the condition stands");
  assert.ok(r.readings.length > 0, "the holder WAS read (not vacuous): the tick evaluated it every minute");
  assert.ok(r.readings.every((x) => x.kind === "waiting" && x.waiting === `Waiting-for: merged #${PARENT}`),
    `every reading is \`waiting\` on the declared condition: ${JSON.stringify([...new Set(r.readings.map((x) => `${x.kind}:${x.waiting}`))])}`);
  assert.deepEqual(r.entries, [], "a holder that declared its wait writes NO claimed-worker-stalled line");
}));

test("#1183 a holder with work and an UNMET Waiting-for is read `waiting`, never released", () => withDir((dir) => {
  const r = runWindow(WAITING, factsOf("open"), dir, withWork);
  assert.ok(r.readings.length > 0, "read every minute");
  assert.ok(r.readings.every((x) => x.kind === "waiting"), "the work it holds keeps it `waiting`, as it does for every declared wait");
  assert.deepEqual(r.orders.filter((o) => o.order.release !== undefined), [], "and nothing is released");
}));

// --- the controls: the same row with no line, and with the condition met ----------------------------------------------------------

test("#1183 CONTROL: the same holder with NO Waiting-for line is nudged at the figure, and ledgered once it is released unanswered", () => withDir((dir) => {
  const r = runWindow("Ready.\n", factsOf("open"), dir);
  assert.equal(firstOrderMinute(r), NUDGE_AT, "nudged at the figure: the stall clock, untouched by the wait");
  assert.equal(r.entries.length, 1, "and the one unanswered nudge is one ledger line");
}));

test("#1183 the condition MET: the same row with the Waiting-for line is nudged at the SAME minute as the control, and ledgered the same", () => withDir((dir) => {
  const control = runWindow("Ready.\n", factsOf("open"), join(dir, "control"));
  const r = runWindow(WAITING, factsOf("merged"), dir);
  assert.equal(firstOrderMinute(r), firstOrderMinute(control), "nudged at the control's minute: a met condition lifts the excuse the same tick");
  assert.equal(r.entries.length, 1, "and the unanswered nudge is ledgered as the control's is");
}));

test("#1183 a condition that becomes TRUE while the holder is quiet lifts the excuse the same tick it flips", () => withDir((dir) => {
  const r = runWindow(WAITING, (minute) => factsOf(minute < FLIP ? "open" : "merged"), dir);
  // THE EXCUSE LIFTS AT THE FLIP: the holder's first idle reading is that tick, and the stopped-claimant grace runs from the first idle tick, as it
  // does from minute 0 for a holder with no line (the control). So the nudge is `FLIP + NUDGE_AT`, never the figure while the condition stood.
  assert.equal(firstOrderMinute(r), FLIP + NUDGE_AT, "nudged the grace after the flip, which is when the holder is first read idle");
  assert.ok(FLIP > NUDGE_AT, "the flip is after the figure, so the excuse is what held the nudge back");
  assert.ok(r.readings.filter((x) => x.minute < FLIP).every((x) => x.kind === "waiting"), "read `waiting` for every minute before the flip");
}));

// --- an UNKNOWN condition is not an excuse ----------------------------------------------------------------------------------------

test("#1183 an UNKNOWN condition (manual, an unread reference, an unreadable line, no facts) is nudged at the figure, as if no line were written", () => {
  const cases: [string, Facts][] = [
    ["Waiting-for: a human to say so", factsOf("open")],
    [`Waiting-for: merged #${PARENT + 1}`, factsOf("open")],
    ["Waiting-for: ???", factsOf("open")],
    [WAITING, null],
  ];
  for (const [body, facts] of cases) {
    withDir((dir) => {
      const r = runWindow(body, facts, dir);
      assert.equal(firstOrderMinute(r), NUDGE_AT, `\`${body}\` with ${facts === null ? "no facts" : "the facts it cannot read"} is NOT an excuse`);
      assert.ok(r.readings.every((x) => x.kind !== "waiting"), `\`${body}\` is never read as \`waiting\``);
    });
  }
});

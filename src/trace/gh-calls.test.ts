// a11ign/a11ign#3516, #3589: the `gh` call ledger as a source of the trace store, keyed by the session id on each line. Fixtures only: nothing here reads a real ledger, `~/.claude` or GitHub.
// no-token: gh -- every ledger is a file this test writes in the shipped line shape (`host/gh`'s: time, account, resource, cost, status, argv[1] argv[2], workspace, the calling process's command line, the session id).
//
// POSITIVE CONTROLS, named where they live: a call is keyed by the id on its line, and the case that proves it is a second at which TWO sessions were running a tool (a keyer that ignores the id and reads the time is on
// `ambiguous` there, and RED); a call is keyed to the session it names and not to the first turn (the sessions below carry different rows, and the second call must be on the second); the cost of a call survives the
// read (a reader that drops the field reads null for the call whose response carried 3); an unkeyed call is asserted to EXIST before it is asserted to have no row (`find` asserts it), so an ingest that dropped it fails
// there and not by passing an emptiness check.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseLedger, topCallers } from "../gh-ledger.ts";
import { emptyState } from "./ingest-state.ts";
import { callsOfLedgerText, ghCallLines, ghIngestLines, ingestGhCalls, keyed, summarize } from "./gh-calls.ts";
import { appendToStore, openStore } from "./store.ts";
import type { TraceEvent } from "./store.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";

const at = (iso: string): number => Date.parse(iso);
const WORKERS = "a11ign-ai-workers";
const LEADS = "a11ign-ai-leads";
const SHELL = "/usr/bin/zsh -c source /home/agent/.claude/shell-snapshots/snapshot-zsh-1791154712872-8w57yj.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL";
const UNIT = "/usr/bin/node --import file:///home/agent/repos/agent-org/src/lib/crash-exit.ts /home/agent/repos/agent-org/src/work-gate.ts --json";
/** The transcripts' ids: a Claude Code session's `CLAUDE_CODE_SESSION_ID` is the file name of its transcript. */
const T9001 = "0b5e7f10-9001-4a00-8000-000000000001";
const T9002 = "0b5e7f10-9002-4a00-8000-000000000002";
const TORCH = "0b5e7f10-0000-4a00-8000-0000000000aa";

/** One ledger line in the shape `host/gh` writes it: the 8 fields, and the session id as the 9th when the call had one. */
const line = ({ time, account = WORKERS, resource = "graphql", cost = "", status = 0, command = "issue view", workspace = "w1AX", caller = SHELL, sessionId }:
  { time: string, account?: string, resource?: string, cost?: string | number, status?: number, command?: string, workspace?: string, caller?: string, sessionId?: string }): string =>
  [time, account, resource, cost, status, command, workspace, caller, ...(sessionId === undefined ? [] : [sessionId])].join("\t");

/** One turn, as the store holds it: `transcript` is the id of the file it was read from. */
const turn = (session: string, row: number | null, iso: string, transcript: string): TraceEvent => ({ id: `turn:${session}:${iso}`, kind: "turn", source: "transcript", at: at(iso), session, transcript, row, pr: null, repo: null, cause: null, causeKey: null, wakeId: "w" });

/**
 * worker-9001 (row 9001): a turn at 10:00:10 and the next at 10:00:40, so a tool ran in between.
 * worker-9002 (row 9002): the same shape at 10:05:00 and 10:05:30.
 * orchestrator: a tool from 10:00:05 to 10:00:30, which overlaps worker-9001's, so at 10:00:20 TWO sessions are running a tool: the case #209's time rule left `ambiguous`.
 */
const TURNS = [
  turn("worker-9001", 9001, "2026-10-04T10:00:10Z", T9001), turn("worker-9001", 9001, "2026-10-04T10:00:40Z", T9001),
  turn("worker-9002", 9002, "2026-10-04T10:05:00Z", T9002), turn("worker-9002", 9002, "2026-10-04T10:05:30Z", T9002),
  turn("orchestrator", null, "2026-10-04T10:00:05Z", TORCH), turn("orchestrator", null, "2026-10-04T10:00:30Z", TORCH),
];

const LEDGER = [
  line({ time: "2026-10-04T10:00:30Z", cost: 3, sessionId: T9001 }), // keyed to row 9001 through the turn that follows it, and its response carried 3 points
  line({ time: "2026-10-04T10:05:10Z", resource: "core", command: "api repos/a11ign/a11ign/issues/9002", sessionId: T9002 }), // keyed to row 9002: the first turn of the store is row 9001's
  line({ time: "2026-10-04T10:00:20Z", sessionId: T9001 }), // two sessions' tools were running: the id names worker-9001's
  line({ time: "2026-10-04T10:20:00Z", account: LEADS, resource: "graphql?", command: "pr list", workspace: "w2", sessionId: T9001 }), // names a session, but no turn of it follows
  line({ time: "2026-10-04T10:00:30Z", caller: UNIT, resource: "graphql?", command: "pr list", workspace: "-", sessionId: "-" }), // a unit, in worker-9001's tool window: no id, never joined by time
  line({ time: "2026-10-04T10:25:00Z" }), // a line of before the wrapper wrote an id (8 fields), from a session's shell: no id, and unkeyed
].join("\n");

const calls = (text: string = LEDGER): TraceEvent[] => callsOfLedgerText(`${text}\n`).calls;
/** The call at `time`, asserted to EXIST first: an ingest that dropped it fails here and not by an emptiness check on what follows. */
const find = (all: TraceEvent[], time: string, resource?: string, sessionId?: string): TraceEvent => {
  const hit = all.find((call) => call.at === at(time) && (resource === undefined || call.resource === resource) && (sessionId === undefined || call.sessionId === sessionId));
  assert.ok(hit, `no call at ${time}`);
  return hit;
};
const withTurns = (events: TraceEvent[] = TURNS): TraceEvent[] => keyed(calls(), events);

test("KEYED: each call is one gh-ledger record on the session its line names, through that session's next turn, and a call no turn follows keeps row: null", () => {
  const all = withTurns();
  assert.equal(all.length, 6, "one record per line");
  assert.ok(all.every((call) => call.source === "gh-ledger" && call.kind === "gh_call"));
  const first = find(all, "2026-10-04T10:00:30Z", "graphql");
  assert.deepEqual([first.session, first.row, first.keyedBy], ["worker-9001", 9001, "session"]);
  assert.equal(first.cost, 3, "the cost the response carried is held: a reader that drops the field fails here");
  assert.deepEqual([first.account, first.resource, first.exit, first.command, first.workspace, first.sessionId], [WORKERS, "graphql", 0, "issue view", "w1AX", T9001]);
  const second = find(all, "2026-10-04T10:05:10Z");
  assert.deepEqual([second.session, second.row, second.cost], ["worker-9002", 9002, null], "keyed to the SECOND session: a reader that keys every call to the first turn is on row 9001");
  const outside = find(all, "2026-10-04T10:20:00Z");
  assert.deepEqual([outside.row, outside.session, outside.keyedBy, outside.unkeyed], [null, "gh-ledger", null, "no-turn"], "the session is named and no later turn of it is held: HELD, not dropped, and retried on a later run");
});

test("KEYED: a second at which TWO sessions were running a tool keys each call to the session its line names (the case the time rule left `ambiguous`)", () => {
  const both = [line({ time: "2026-10-04T10:00:20Z", sessionId: T9001 }), line({ time: "2026-10-04T10:00:20Z", sessionId: TORCH })].join("\n");
  const [nine, orchestrator] = keyed(calls(both), TURNS);
  assert.deepEqual([nine.session, nine.row, nine.keyedBy, nine.unkeyed], ["worker-9001", 9001, "session", undefined]);
  assert.deepEqual([orchestrator.session, orchestrator.row, orchestrator.keyedBy], ["orchestrator", null, "session"], "the orchestrator's call is on the orchestrator, which has no row, and is not worker-9001's");
});

test("KEYED: a call with no id is `script`, never keyed by time, even in a session's shell and even when one session's window covers its second; an 8-field line of before the change reads as it did", () => {
  const all = withTurns();
  const unit = find(all, "2026-10-04T10:00:30Z", "graphql?");
  assert.deepEqual([unit.row, unit.session, unit.unkeyed, unit.script, unit.sessionId], [null, "gh-ledger", "script", "work-gate.ts", undefined],
    "the window of worker-9001 covers this second, and the unit is still no session's");
  const old = find(all, "2026-10-04T10:25:00Z");
  assert.deepEqual([old.row, old.unkeyed, old.script, "sessionId" in old], [null, "script", "(a session's shell)", false], "an 8-field line has no id, so it is not keyed: a shell is named for what it is, not for its snapshot file");
  assert.equal(find(all, "2026-10-04T10:00:30Z", "graphql").script, "(a session's shell)");
  const preloaded = callsOfLedgerText(`${line({ time: "2026-10-04T10:00:00Z", caller: "/usr/bin/node --import=./src/lib/crash-exit.ts src/work-tick.ts" })}\n`).calls[0];
  assert.equal(preloaded.script, "work-tick.ts", "the `--import=` form of the preload is stripped too");
});

test("KEYED: the turn that ISSUED a call is not its next turn: the call is keyed to the first turn that ended in a LATER second, in the same wake and so on the same row", () => {
  const issuing = turn("worker-9001", 9001, "2026-10-04T10:00:20Z", T9001); // ends at 10:00:20.000, and the call it issued finished in that second
  const following = { ...turn("worker-9001", 9007, "2026-10-04T10:00:22Z", T9001), id: "turn:following" };
  const [call] = keyed(calls(line({ time: "2026-10-04T10:00:20Z", sessionId: T9001 })), [following, issuing]); // out of order on purpose: the turns are sorted by the keyer, not by luck
  assert.deepEqual([call.row, call.keyedBy], [9007, "session"], "a keyer that took the first turn at or after the call's second is on the issuing turn's row, 9001");
});

/** A host: a scratch store and a ledger each of two accounts, written the way `host/gh` appends. */
function host(): { root: string, ledgers: Record<"workers" | "leads" | "absent", string>, store: ReturnType<typeof openStore>, state: { current: ReturnType<typeof emptyState> }, run: (now: number, files?: string[]) => ReturnType<typeof ingestGhCalls>["report"] } {
  const root = tmpDir("gh-calls-3516-");
  mkdirSync(join(root, "workers"));
  mkdirSync(join(root, "leads"));
  const ledgers = { workers: join(root, "workers", "gh-calls.tsv"), leads: join(root, "leads", "gh-calls.tsv"), absent: join(root, "nobody", "gh-calls.tsv") };
  const store = openStore(join(root, "events.ndjson"));
  const state = { current: emptyState({ now: 0, since: 0 }) };
  const run = (now: number, files: string[] = [ledgers.workers, ledgers.leads, ledgers.absent]) => {
    const done = ingestGhCalls({ ledgers: files, store, state: state.current, now });
    state.current = done.state;
    return done.report;
  };
  return { root, ledgers, store, state, run };
}

const lines = (...text: string[]): string => `${text.join("\n")}\n`;
const NOW = at("2026-10-04T12:00:00Z");

test("INGEST: running it twice adds nothing, an account with no ledger is said so, and the second run reads no byte", () => {
  const { ledgers, store, run } = host();
  writeFileSync(ledgers.workers, `${LEDGER}\n`);
  writeFileSync(ledgers.leads, lines(line({ time: "2026-10-04T10:21:00Z", account: LEADS, resource: "graphql?", command: "pr list", workspace: "w2" })));
  store.events.push(...TURNS);
  const first = run(NOW);
  assert.deepEqual([first.read, first.calls, first.added, first.absent.length], [2, 7, 7, 1]);
  assert.equal(store.events.filter((event) => event.kind === "gh_call").length, 7);
  const again = run(NOW);
  assert.deepEqual([again.added, again.calls, again.read, again.unchanged, again.rekeyed], [0, 0, 0, 2, 0]);
  const reread = run(NOW + 1);
  assert.equal(reread.added, 0);
  assert.match(ghIngestLines(first).join("\n"), /no ledger at .*nobody\/gh-calls.tsv/);
});

test("INGEST: only the bytes a ledger gained are parsed, and the lines of the last two seconds are held back to the next run", () => {
  const { ledgers, store, run } = host();
  writeFileSync(ledgers.workers, lines(line({ time: "2026-10-04T10:00:00Z" }), line({ time: "2026-10-04T10:00:01Z" })));
  const first = run(at("2026-10-04T10:00:30Z"), [ledgers.workers]);
  assert.deepEqual([first.calls, first.heldBack], [2, 0]);
  appendFileSync(ledgers.workers, lines(line({ time: "2026-10-04T10:00:40Z" }), line({ time: "2026-10-04T10:00:41Z" })));
  const second = run(at("2026-10-04T10:00:42Z"), [ledgers.workers]);
  assert.deepEqual([second.calls, second.heldBack, second.added], [1, 1, 1], "the second line of the second's batch is not settled: a read between two lines of one second would break their order");
  const third = run(at("2026-10-04T10:00:50Z"), [ledgers.workers]);
  assert.deepEqual([third.calls, third.added], [1, 1], "and is read once the second is over");
  assert.equal(store.events.filter((event) => event.kind === "gh_call").length, 4);
  assert.ok(third.bytes < first.bytes + second.bytes + 1000, "each run parsed its own bytes and not the whole file again");
});

test("INGEST: a trim reads as a shrink, is read again from byte 0 and SAID, and adds nothing already held; the newest half is all that is left, and the new calls after it are added", () => {
  const { ledgers, store, run } = host();
  const old = Array.from({ length: 6 }, (_, i: number) => line({ time: `2026-10-04T10:00:0${i}Z`, command: `issue view ${i}` }));
  writeFileSync(ledgers.workers, lines(...old));
  assert.equal(run(NOW, [ledgers.workers]).added, 6);
  writeFileSync(ledgers.workers, `half-a-line\tcut\n${lines(...old.slice(3), line({ time: "2026-10-04T10:00:09Z", command: "pr list" }))}`);
  const after = run(NOW, [ledgers.workers]);
  assert.match(after.reread.join("\n"), /shrank from \d+ to \d+ bytes|first bytes changed/);
  assert.deepEqual([after.added, after.skippedLines], [1, 1], "three kept lines are the records already held, the half line is skipped, one call is new");
  assert.equal(store.events.filter((event) => event.kind === "gh_call").length, 7, "the three calls the trim removed are still in the store");
  assert.match(ghIngestLines(after).join("\n"), /read again from byte 0: .*gh-calls.tsv: (shrank|its first bytes changed)/);
});

test("INGEST: a call whose turn had not been read is keyed on a LATER run, once; one that no turn ever follows stays unkeyed and is not corrected again", () => {
  const { ledgers, store, run } = host();
  writeFileSync(ledgers.workers, lines(line({ time: "2026-10-04T10:00:30Z", sessionId: T9001 }), line({ time: "2026-10-04T10:20:00Z", sessionId: T9001 })));
  assert.equal(run(NOW, [ledgers.workers]).rekeyed, 0);
  assert.deepEqual(store.events.map((event) => event.unkeyed), ["no-turn", "no-turn"], "no turn is in the store yet, so both are unkeyed");
  store.events.push(...TURNS);
  const later = run(NOW, [ledgers.workers]);
  assert.deepEqual([later.rekeyed, later.added], [1, 0], "only the call a turn now follows is corrected");
  assert.deepEqual(store.events.filter((event) => event.kind === "gh_call").map((event) => [event.row, event.keyedBy]), [[9001, "session"], [null, null]]);
  assert.equal(run(NOW, [ledgers.workers]).rekeyed, 0, "a keyed call is not asked again");
});

test("INGEST: a call the time rule left `ambiguous` (a record of before #3589) is corrected to `script` once, and its time-rule fields are gone; a `script` record is not asked again", () => {
  const { ledgers, store, run } = host();
  const [legacy] = calls(line({ time: "2026-10-04T10:00:20Z" }));
  appendToStore(store, [{ ...legacy, viaShell: true, unkeyed: "ambiguous", candidates: 2 } as unknown as TraceEvent]);
  const first = run(NOW, [ledgers.workers]);
  assert.equal(first.rekeyed, 1, "POSITIVE CONTROL: the legacy record was offered and changed");
  const held = store.events.find((event) => event.id === legacy.id);
  assert.ok(held, "the call is still held");
  assert.deepEqual([held.unkeyed, "viaShell" in held, "candidates" in held], ["script", false, false]);
  assert.equal(run(NOW, [ledgers.workers]).rekeyed, 0);
});

test("POINTS: a call's points are the cost its response carried, else one for a GraphQL call, and they agree with gh-ledger.ts's own reading of the same lines", () => {
  const text = [line({ time: "2026-10-04T10:00:00Z", cost: 3 }), line({ time: "2026-10-04T10:00:01Z", resource: "graphql?" }), line({ time: "2026-10-04T10:00:02Z", resource: "core" }),
    line({ time: "2026-10-04T10:00:03Z", resource: "other", cost: 0 })].join("\n");
  const sum = summarize(calls(text));
  assert.deepEqual([sum.calls, sum.graphql, sum.core, sum.other, sum.points, sum.read, sum.floorCalls, sum.inferredPool], [4, 2, 1, 1, 4, 3, 1, 1]);
  const theirs = topCallers(parseLedger(text), { limit: 100 }).reduce((total, row) => total + row.points, 0);
  assert.equal(sum.points, theirs, "the floor rule is gh-ledger.ts's, and a drift between the two readings of one line is this failing");
});

test("REPORT: the row's calls and GraphQL points, the floor marked, the calls of no row listed apart by caller, and from when the store holds calls", () => {
  const all = withTurns();
  const mine = all.filter((call) => call.row === 9001);
  const text = ghCallLines({ events: mine, held: all }).join("\n");
  assert.match(text, /keyed to this row \(by the session id on the line; a LOWER BOUND.*2 calls: 2 on the GraphQL pool = 4 points \(3 read from responses, 1 calls FLOOR/);
  assert.match(text, /KEYED TO NO ROW, listed apart \(3 of the store's 6 are keyed\): 3 calls/);
  assert.match(text, /because: 2 carry no session id.*; 1 name a session the store holds no later turn of yet/);
  assert.match(text, /\d+ pts +\d+ calls +a11ign-ai-workers work-gate\.ts/, "the unit that burns the pool is named by its script");
  assert.match(text, /a11ign-ai-leads +held from 2026-10-04T10:20Z/, "the earliest call per account");
  assert.match(text, /a11ign-ai-workers +held from 2026-10-04T10:00Z/);
  assert.match(text, /a call older than that is GONE/);
  const floor = ghCallLines({ events: all.filter((call) => call.resource === "graphql?" && call.unkeyed === "script") }).join("\n");
  assert.match(floor, /1 calls: 1 on the GraphQL pool = 1 points \(0 read from responses, 1 calls FLOOR at 1 point each.*1 of the pool assignments only inferred/, "a floor is marked, never stated as a reading");
  assert.match(ghCallLines({ events: [] }).join("\n"), /keyed to this row.*: none/);
});

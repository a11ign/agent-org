// a11ign/a11ign#3516: the `gh` call ledger as a source of the trace store. Fixtures only: nothing here reads a real ledger, `~/.claude` or GitHub.
// no-token: gh -- every ledger is a file this test writes in the shipped line shape (`host/gh`'s: time, account, resource, cost, status, argv[1] argv[2], workspace, the calling process's command line).
//
// POSITIVE CONTROLS, named where they live: a call is keyed to the session whose window covers it and not to the first turn (the two sessions below carry different rows, and the second call must
// be on the second); the cost of a call survives the read (a reader that drops the field reads null for the call whose response carried 3); an unkeyed call is asserted to EXIST before it is asserted
// to have no row (`assert.ok(call)` first), so an ingest that dropped it fails there and not by passing an emptiness check.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseLedger, topCallers } from "../gh-ledger.mjs";
import { emptyState } from "./ingest-state.mjs";
import { callsOfLedgerText, ghCallLines, ghIngestLines, ingestGhCalls, keyCalls, keyed, summarize, toolWindows } from "./gh-calls.mjs";
import { openStore } from "./store.mjs";

const at = (iso) => Date.parse(iso);
const WORKERS = "a11ign-ai-workers";
const LEADS = "a11ign-ai-leads";
const SHELL = "/usr/bin/zsh -c source /home/agent/.claude/shell-snapshots/snapshot-zsh-1791154712872-8w57yj.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL";
const UNIT = "/usr/bin/node --import file:///home/agent/repos/agent-org/src/lib/crash-exit.mjs /home/agent/repos/agent-org/src/work-gate.mjs --json";

/** One ledger line in the shape `host/gh` writes it. */
const line = ({ time, account = WORKERS, resource = "graphql", cost = "", status = 0, command = "issue view", workspace = "w1AX", caller = SHELL }) =>
  [time, account, resource, cost, status, command, workspace, caller].join("\t");

/** One turn, as the store holds it. `wallClockMs` runs back to the tool_result that began it. */
const turn = (session, row, iso, wallClockMs, wakeId) => ({ id: `turn:${session}:${iso}`, kind: "turn", source: "transcript", at: at(iso), session, row, pr: null, repo: null, cause: null, causeKey: null, wakeId, wallClockMs });

/**
 * worker-9001 (row 9001): a turn at 10:00:10 and the next at 10:00:40, whose tool_result came at 10:00:34, so a tool ran from 10:00:10 to 10:00:34.
 * worker-9002 (row 9002): the same shape at 10:05:00, tool until 10:05:25.
 * orchestrator: a tool from 10:00:05 to 10:00:25, which overlaps worker-9001's from 10:00:10 to 10:00:25.
 * worker-9003: a turn in each of TWO wakes: the time between them is idle, not a tool.
 */
const TURNS = [
  turn("worker-9001", 9001, "2026-10-04T10:00:10Z", 4000, "w1"), turn("worker-9001", 9001, "2026-10-04T10:00:40Z", 6000, "w1"),
  turn("worker-9002", 9002, "2026-10-04T10:05:00Z", 4000, "w2"), turn("worker-9002", 9002, "2026-10-04T10:05:30Z", 5000, "w2"),
  turn("orchestrator", null, "2026-10-04T10:00:05Z", 4000, "o1"), turn("orchestrator", null, "2026-10-04T10:00:30Z", 5000, "o1"),
  turn("worker-9003", 9003, "2026-10-04T10:10:00Z", 4000, "x1"), turn("worker-9003", 9003, "2026-10-04T10:40:00Z", 4000, "x2"),
];

const LEDGER = [
  line({ time: "2026-10-04T10:00:30Z", cost: 3 }), // from a shell, only worker-9001's tool was running: keyed to row 9001, and its response carried 3 points
  line({ time: "2026-10-04T10:05:10Z", resource: "core", command: "api repos/a11ign/a11ign/issues/9002" }), // keyed to row 9002: the first turn of the store is row 9001's
  line({ time: "2026-10-04T10:00:20Z" }), // two sessions' tools were running
  line({ time: "2026-10-04T10:20:00Z", account: LEADS, resource: "graphql?", command: "pr list", workspace: "w2" }), // no window covers it
  line({ time: "2026-10-04T10:00:30Z", caller: UNIT, resource: "graphql?", command: "pr list", workspace: "-" }), // a unit, in worker-9001's tool window: never keyed by time
  line({ time: "2026-10-04T10:25:00Z" }), // between worker-9003's two wakes: idle is not a tool
].join("\n");

const calls = (text = LEDGER) => callsOfLedgerText(`${text}\n`).calls;
const find = (all, time, resource) => all.find((call) => call.at === at(time) && (resource === undefined || call.resource === resource));
const withTurns = (events = TURNS) => keyed(calls(), events);

test("KEYED: each call is one gh-ledger record on the session whose tool window covers its second, and a call outside every window keeps row: null", () => {
  const all = withTurns();
  assert.equal(all.length, 6, "one record per line");
  assert.ok(all.every((call) => call.source === "gh-ledger" && call.kind === "gh_call"));
  const first = find(all, "2026-10-04T10:00:30Z", "graphql");
  assert.deepEqual([first.session, first.row, first.keyedBy], ["worker-9001", 9001, "time"]);
  assert.equal(first.cost, 3, "the cost the response carried is held: a reader that drops the field fails here");
  assert.deepEqual([first.account, first.resource, first.exit, first.command, first.workspace], [WORKERS, "graphql", 0, "issue view", "w1AX"]);
  const second = find(all, "2026-10-04T10:05:10Z");
  assert.deepEqual([second.session, second.row, second.cost], ["worker-9002", 9002, null], "keyed to the SECOND session: a reader that keys every call to the first turn is on row 9001");
  const outside = find(all, "2026-10-04T10:20:00Z");
  assert.ok(outside, "the call is HELD, not dropped");
  assert.deepEqual([outside.row, outside.session, outside.keyedBy, outside.unkeyed, outside.candidates], [null, "gh-ledger", null, "no-turn", 0]);
  const idle = find(all, "2026-10-04T10:25:00Z");
  assert.deepEqual([idle.row, idle.unkeyed], [null, "no-turn"], "the time between two wakes of a session is idle, and no tool ran in it");
});

test("KEYED: two sessions covering a call name NEITHER, and a call from a unit or script is never keyed by time even when one session's window covers it", () => {
  const all = withTurns();
  const both = find(all, "2026-10-04T10:00:20Z");
  assert.deepEqual([both.row, both.session, both.unkeyed, both.candidates], [null, "gh-ledger", "ambiguous", 2]);
  const unit = find(all, "2026-10-04T10:00:30Z", "graphql?");
  assert.deepEqual([unit.row, unit.session, unit.unkeyed, unit.script, unit.viaShell], [null, "gh-ledger", "script", "work-gate.mjs", false],
    "the window of worker-9001 covers this second, and the unit is still no session's");
  assert.equal(find(all, "2026-10-04T10:00:30Z", "graphql").script, "(a session's shell)", "a shell is named for what it is, not for its snapshot file");
  const preloaded = callsOfLedgerText(`${line({ time: "2026-10-04T10:00:00Z", caller: "/usr/bin/node --import=./src/lib/crash-exit.mjs src/work-tick.mjs" })}\n`).calls[0];
  assert.equal(preloaded.script, "work-tick.mjs", "the `--import=` form of the preload is stripped too");
});

test("KEYED: a window is the gap between turns of one wake up to the tool_result, widened to whole seconds, and its turn is the one that follows", () => {
  const windows = toolWindows(TURNS);
  const nine = windows.find((window) => window.session === "worker-9001");
  assert.deepEqual([nine.from, nine.to], [at("2026-10-04T10:00:10Z"), at("2026-10-04T10:00:34Z") + 999]);
  assert.equal(nine.turn.at, at("2026-10-04T10:00:40Z"));
  assert.equal(windows.some((window) => window.session === "worker-9003"), false, "two wakes are two windows of nothing");
  const edge = (iso, viaShell = true) => keyCalls([{ at: at(iso), viaShell }], windows)[0];
  assert.equal("turn" in edge("2026-10-04T10:00:34Z"), true, "the last second of the tool, whose line carries its start of the second");
  assert.equal("turn" in edge("2026-10-04T10:00:35Z"), false, "the second after the tool_result is the model's, not a tool's");
});

test("INGEST: a half line is skipped as parseLine skips it, three identical calls are three records, and a line read again is the record already held", () => {
  const same = line({ time: "2026-10-04T10:05:11Z", command: "pr list", resource: "graphql?" });
  const text = `${[same, same, same, "2026-10-04T10:05:12Z\tonly\tthree"].join("\n")}\n`;
  const first = callsOfLedgerText(text);
  assert.equal(first.skipped, 1);
  assert.equal(first.calls.length, 3);
  assert.equal(new Set(first.calls.map((call) => call.id)).size, 3, "an identical line is told apart by its order");
  assert.deepEqual(callsOfLedgerText(text).calls.map((call) => call.id), first.calls.map((call) => call.id), "ids are the line's, not the read's");
  assert.deepEqual(callsOfLedgerText(`${same}\n`).calls.map((call) => call.id), [first.calls[0].id], "a trim that keeps only the first of three still holds its id");
});

/** A host: a scratch store and a ledger each of two accounts, written the way `host/gh` appends. */
function host() {
  const root = mkdtempSync(join(tmpdir(), "gh-calls-3516-"));
  mkdirSync(join(root, "workers"));
  mkdirSync(join(root, "leads"));
  const ledgers = { workers: join(root, "workers", "gh-calls.tsv"), leads: join(root, "leads", "gh-calls.tsv"), absent: join(root, "nobody", "gh-calls.tsv") };
  const store = openStore(join(root, "events.ndjson"));
  const state = { current: emptyState({ now: 0, since: 0 }) };
  const run = (now, files = [ledgers.workers, ledgers.leads, ledgers.absent]) => {
    const done = ingestGhCalls({ ledgers: files, store, state: state.current, now });
    state.current = done.state;
    return done.report;
  };
  return { root, ledgers, store, state, run };
}

const lines = (...text) => `${text.join("\n")}\n`;
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
  const old = Array.from({ length: 6 }, (_, i) => line({ time: `2026-10-04T10:00:0${i}Z`, command: `issue view ${i}` }));
  writeFileSync(ledgers.workers, lines(...old));
  assert.equal(run(NOW, [ledgers.workers]).added, 6);
  writeFileSync(ledgers.workers, `half-a-line\tcut\n${lines(...old.slice(3), line({ time: "2026-10-04T10:00:09Z", command: "pr list" }))}`);
  const after = run(NOW, [ledgers.workers]);
  assert.match(after.reread.join("\n"), /shrank from \d+ to \d+ bytes|first bytes changed/);
  assert.deepEqual([after.added, after.skippedLines], [1, 1], "three kept lines are the records already held, the half line is skipped, one call is new");
  assert.equal(store.events.filter((event) => event.kind === "gh_call").length, 7, "the three calls the trim removed are still in the store");
  assert.match(ghIngestLines(after).join("\n"), /read again from byte 0: .*gh-calls.tsv: (shrank|its first bytes changed)/);
});

test("INGEST: a call whose turn had not been read is keyed on a LATER run, once; one that no turn ever covers stays unkeyed and is not corrected again", () => {
  const { ledgers, store, run } = host();
  writeFileSync(ledgers.workers, lines(line({ time: "2026-10-04T10:00:30Z" }), line({ time: "2026-10-04T10:20:00Z" })));
  assert.equal(run(NOW, [ledgers.workers]).rekeyed, 0);
  assert.deepEqual(store.events.map((event) => event.unkeyed), ["no-turn", "no-turn"], "no turn is in the store yet, so both are unkeyed");
  store.events.push(...TURNS);
  const later = run(NOW, [ledgers.workers]);
  assert.deepEqual([later.rekeyed, later.added], [1, 0], "only the call a turn now covers is corrected");
  assert.deepEqual(store.events.filter((event) => event.kind === "gh_call").map((event) => [event.row, event.keyedBy]), [[9001, "time"], [null, null]]);
  assert.equal(run(NOW, [ledgers.workers]).rekeyed, 0, "a keyed call is not asked again");
});

test("POINTS: a call's points are the cost its response carried, else one for a GraphQL call, and they agree with gh-ledger.mjs's own reading of the same lines", () => {
  const text = [line({ time: "2026-10-04T10:00:00Z", cost: 3 }), line({ time: "2026-10-04T10:00:01Z", resource: "graphql?" }), line({ time: "2026-10-04T10:00:02Z", resource: "core" }),
    line({ time: "2026-10-04T10:00:03Z", resource: "other", cost: 0 })].join("\n");
  const sum = summarize(calls(text));
  assert.deepEqual([sum.calls, sum.graphql, sum.core, sum.other, sum.points, sum.read, sum.floorCalls, sum.inferredPool], [4, 2, 1, 1, 4, 3, 1, 1]);
  const theirs = topCallers(parseLedger(text), { limit: 100 }).reduce((total, row) => total + row.points, 0);
  assert.equal(sum.points, theirs, "the floor rule is gh-ledger.mjs's, and a drift between the two readings of one line is this failing");
});

test("REPORT: the row's calls and GraphQL points, the floor marked, the calls of no row listed apart by caller, and from when the store holds calls", () => {
  const all = withTurns();
  const mine = all.filter((call) => call.row === 9001);
  const text = ghCallLines({ events: mine, held: all }).join("\n");
  assert.match(text, /keyed to this row \(INFERRED and a LOWER BOUND.*1 calls: 1 on the GraphQL pool = 3 points \(3 read from responses, 0 calls FLOOR/);
  assert.match(text, /KEYED TO NO ROW, listed apart \(2 of the store's 6 are keyed\): 4 calls/);
  assert.match(text, /because: 1 came from a script or unit.*; 1 had two or more sessions' tool windows covering them; 2 had none/);
  assert.match(text, /\d+ pts +\d+ calls +a11ign-ai-workers work-gate\.mjs/, "the unit that burns the pool is named by its script");
  assert.match(text, /a11ign-ai-leads +held from 2026-10-04T10:20Z/, "the earliest call per account");
  assert.match(text, /a11ign-ai-workers +held from 2026-10-04T10:00Z/);
  assert.match(text, /a call older than that is GONE/);
  const floor = ghCallLines({ events: all.filter((call) => call.unkeyed === "script") }).join("\n");
  assert.match(floor, /1 calls: 1 on the GraphQL pool = 1 points \(0 read from responses, 1 calls FLOOR at 1 point each.*1 of the pool assignments only inferred/, "a floor is marked, never stated as a reading");
  assert.match(ghCallLines({ events: [] }).join("\n"), /keyed to this row.*: none/);
});

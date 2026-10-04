// a11ign/a11ign#3526: the trace ingest reads only what a transcript gained since its last run. Fixtures only: a projects directory in the real record shape, a scratch
// store and a scratch state. Nothing here reads `~/.claude`, `~/.cache/a11ign` or GitHub.
// no-token: gh -- no test here calls `gh`; `ingestTranscripts` is the transcript half of a run and never reaches GitHub
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseLedger } from "../wakes-per-row.mjs";
import { emptyState, fingerprint, HEAD_BYTES, loadState, planRead, saveState, STATE_VERSION, stateFileFor } from "./ingest-state.mjs";
import { openStore, QUIET_MS, readStore } from "./store.mjs";
import { ingestTranscripts, render } from "./trace.mjs";

const ROW_REPO = "a11ign/a11ign";
const at = (iso) => Date.parse(iso);
const NOW = at("2026-10-05T00:00:00Z"); // long after every record below: nothing is young, so nothing is held back unless a test says so

const wake = (timestamp, session, body = "an order.") => JSON.stringify({
  type: "user", timestamp, message: { role: "user", content: `\n\n<pasted_content id="1">\nYou are \`${session}\` -- ${body}\n</pasted_content>` },
});
const toolResult = (timestamp) => JSON.stringify({ type: "user", timestamp, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
const usage = (output) => ({ input_tokens: 2, output_tokens: output, cache_read_input_tokens: 6448, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 } });
const block = (timestamp, id, output = 50) => JSON.stringify({
  type: "assistant", timestamp, requestId: `req_${id}`, message: { id, model: "claude-sonnet-5-5", role: "assistant", content: [{ type: "text", text: "x" }], usage: usage(output) },
});

/** The lead's orders are keyed by a pull request or a row, so a turn that loses its wake loses its row: `orchestrator` has no name to fall back on, unlike `worker-<n>`. */
const LEDGER = parseLedger([
  `${at("2026-10-04T10:30:00Z") - 1000}\torchestrator/draft-convinced-not-ready/pr-9100/abc12345`,
  `${at("2026-10-04T10:40:00Z") - 1000}\torchestrator/ready-row-unclaimed/9050`,
].join("\n"));

const LEAD_1 = [wake("2026-10-04T10:30:00.000Z", "orchestrator"), block("2026-10-04T10:30:10.000Z", "msg_a"), toolResult("2026-10-04T10:30:20.000Z"), block("2026-10-04T10:30:30.000Z", "msg_b")];
const LEAD_2 = [toolResult("2026-10-04T10:31:00.000Z"), block("2026-10-04T10:31:10.000Z", "msg_c")];
const LEAD_3 = [wake("2026-10-04T10:40:00.000Z", "orchestrator"), block("2026-10-04T10:40:12.000Z", "msg_d")];
const WORKER = [wake("2026-10-04T10:00:00.000Z", "worker-9001", "row 9001 has been claimed for you."), block("2026-10-04T10:00:04.000Z", "msg_w", 20)];

/** A scratch world: a projects directory, a store and (beside it) a state, all under one temporary directory. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), "ingest-state-"));
  const root = join(dir, "projects");
  mkdirSync(join(root, "-proj"), { recursive: true });
  const storePath = join(dir, "events.ndjson");
  const file = (name) => join(root, "-proj", `${name}.jsonl`);
  const write = (name, lines) => writeFileSync(file(name), `${lines.join("\n")}\n`);
  const append = (name, lines) => appendFileSync(file(name), `${lines.join("\n")}\n`);
  const run = (now = NOW, ledger = LEDGER) => ingestTranscripts({ root, since: 0, ledger, rowRepo: ROW_REPO, storePath, now }).report;
  return { dir, root, storePath, file, write, append, run, statePath: stateFileFor(storePath), stored: () => readStore(storePath) };
}
const byId = (events) => [...events].sort((a, b) => a.id.localeCompare(b.id));
const size = (lines) => Buffer.byteLength(`${lines.join("\n")}\n`);

test("(1) a second run over unchanged files reads ZERO bytes of them and adds zero events", () => {
  const w = world();
  w.write("lead", LEAD_1);
  w.write("worker", WORKER);
  const first = w.run();
  assert.equal(first.read, 2, "positive control: the first run reads both");
  assert.equal(first.bytesRead, size(LEAD_1) + size(WORKER));
  assert.ok(first.added >= 5);
  const stored = readFileSync(w.storePath, "utf8");
  const second = w.run();
  assert.deepEqual([second.read, second.unchanged, second.bytesRead, second.added], [0, 2, 0, 0]);
  assert.equal(readFileSync(w.storePath, "utf8"), stored, "the store is byte-identical");
});

test("(2) after one turn is appended, the next run parses only the appended bytes and adds exactly that turn's events", () => {
  const w = world();
  w.write("lead", LEAD_1);
  w.run();
  const before = w.stored().length;
  w.append("lead", LEAD_2);
  const second = w.run();
  // the appended bytes, and the first HEAD_BYTES that prove the file was appended to and not rewritten
  assert.equal(second.bytesRead, size(LEAD_2) + HEAD_BYTES);
  assert.deepEqual([second.read, second.added], [1, 1]);
  assert.deepEqual(w.stored().slice(before).map((event) => event.id), ["turn:msg_c"]);
});

test("(2b) a file that grew within the SAME mtime tick is still read: the size, not the mtime alone, says it changed", () => {
  const w = world();
  const tick = at("2026-10-04T10:31:00Z") / 1000; // whole seconds, so the restored mtime is bit-identical and not a float that rounds
  w.write("lead", LEAD_1);
  utimesSync(w.file("lead"), tick, tick);
  w.run();
  w.append("lead", LEAD_2);
  utimesSync(w.file("lead"), tick, tick);
  assert.equal(statSync(w.file("lead")).mtimeMs, tick * 1000, "the fixture really kept the mtime");
  assert.deepEqual([w.run().added], [1]);
});

test("(3) the turn that follows a wake written BEFORE the offset still takes its row (the wake key is carried with the offset)", () => {
  const w = world();
  w.write("lead", LEAD_1);
  w.run();
  w.append("lead", LEAD_2);
  w.run();
  const turn = w.stored().find((event) => event.id === "turn:msg_c");
  assert.equal(turn?.pr, 9100, "the order was about pull request 9100, and the order is not in the bytes this run read");
  assert.equal(turn?.row, null);
  assert.equal(turn?.causeKey, "orchestrator/draft-convinced-not-ready/pr-9100/abc12345");
  assert.equal(turn?.wakeId, `wake:orchestrator:${at("2026-10-04T10:30:00Z")}`);
  assert.equal(turn?.wallClockMs, 10000, "from the tool result at :00 to the block at :10, which are both in the new bytes");
});

test("(3b) the wall-clock of a turn that is the FIRST record read comes from the record before the offset", () => {
  const w = world();
  w.write("lead", LEAD_1);
  w.run();
  w.append("lead", [block("2026-10-04T10:30:50.000Z", "msg_e")]);
  w.run();
  assert.equal(w.stored().find((event) => event.id === "turn:msg_e")?.wallClockMs, 20000, "from msg_b's block at :30, carried in the state");
});

test("(4) a file that SHRANK is read again from zero and listed in the report; so is one whose first bytes changed", () => {
  const w = world();
  w.write("lead", [...LEAD_1, ...LEAD_2]);
  w.run();
  w.write("lead", [wake("2026-10-04T10:30:00.000Z", "orchestrator"), block("2026-10-04T10:30:10.000Z", "msg_z")]);
  const shrank = w.run();
  assert.equal(shrank.reread.length, 1);
  assert.match(shrank.reread[0], /lead\.jsonl: shrank from \d+ to \d+ bytes/);
  assert.equal(shrank.read, 1);
  assert.ok(w.stored().some((event) => event.id === "turn:msg_z"), "the new content was read, from its first byte");
  const longer = [wake("2026-10-04T10:30:00.000Z", "orchestrator", "a different order that is much longer than the one before it, so the file grew"), ...LEAD_1, ...LEAD_2, ...LEAD_3];
  w.write("lead", longer);
  assert.match(w.run().reread[0], /lead\.jsonl: its first bytes changed/);
});

test("(5) EQUIVALENCE: two incremental runs leave exactly the events (id AND content) one full ingest of the same final files does", () => {
  const w = world();
  w.write("lead", LEAD_1);
  w.write("worker", WORKER);
  w.run();
  w.append("lead", LEAD_2);
  w.run();
  w.append("lead", LEAD_3);
  w.run();
  const full = world();
  full.write("lead", [...LEAD_1, ...LEAD_2, ...LEAD_3]);
  full.write("worker", WORKER);
  full.run();
  assert.ok(full.stored().length >= 8, "positive control: the full ingest holds the events at all");
  assert.deepEqual(byId(w.stored()), byId(full.stored()));
  // the ledger line of the first order is not re-used by the later one: the third segment's wake is paired with ITS line, the first with its own
  const wakes = w.stored().filter((event) => event.kind === "wake" && event.session === "orchestrator");
  assert.deepEqual(wakes.map((event) => event.causeKey), ["orchestrator/draft-convinced-not-ready/pr-9100/abc12345", "orchestrator/ready-row-unclaimed/9050"]);
});

test("(5b) a ledger line already used by a wake before the offset is not claimed again by a wake after it", () => {
  const w = world();
  w.write("lead", LEAD_1);
  w.run();
  // 3 minutes later, a wake with no ledger line of its own: within the 10-minute window of the first order's line, which the first wake has consumed
  w.append("lead", [wake("2026-10-04T10:33:00.000Z", "orchestrator"), block("2026-10-04T10:33:10.000Z", "msg_f")]);
  w.run();
  const full = world();
  full.write("lead", [...LEAD_1, wake("2026-10-04T10:33:00.000Z", "orchestrator"), block("2026-10-04T10:33:10.000Z", "msg_f")]);
  full.run();
  assert.equal(full.stored().find((event) => event.id === `wake:orchestrator:${at("2026-10-04T10:33:00Z")}`)?.causeKey, null, "one full read leaves the second wake unpaired");
  assert.deepEqual(byId(w.stored()), byId(full.stored()));
});

test("(5c) a message that may still be gaining blocks is HELD BACK, then built from its last block once it has been quiet: the same turn one full read gives", () => {
  const w = world();
  const young = at("2026-10-04T10:00:04Z") + QUIET_MS / 5;
  w.write("worker", [wake("2026-10-04T10:00:00.000Z", "worker-9001"), block("2026-10-04T10:00:04.000Z", "msg_x", 20)]);
  const held = w.run(young);
  assert.equal(held.heldBack, 1);
  assert.deepEqual(w.stored().map((event) => event.kind), ["wake"], "the half-built turn is NOT in the store: an append-only store could never correct it");
  const settled = at("2026-10-04T10:00:04Z") + QUIET_MS + 1000;
  w.append("worker", [block("2026-10-04T10:00:08.000Z", "msg_x", 246)]);
  w.run(young + 1000);
  assert.equal(w.stored().filter((event) => event.kind === "turn").length, 0, "still young after the second block");
  const quiet = w.run(at("2026-10-04T10:00:08Z") + QUIET_MS + 1000);
  assert.equal(quiet.heldBack, 0);
  const turn = w.stored().find((event) => event.id === "turn:msg_x");
  assert.equal(turn?.tokens?.output, 246, "the final block's usage");
  assert.equal(turn?.wallClockMs, 8000, "from the order at :00, which is before the held-back bytes");
  assert.ok(settled > young);
  const full = world();
  full.write("worker", [wake("2026-10-04T10:00:00.000Z", "worker-9001"), block("2026-10-04T10:00:04.000Z", "msg_x", 20), block("2026-10-04T10:00:08.000Z", "msg_x", 246)]);
  full.run();
  assert.deepEqual(byId(w.stored()), byId(full.stored()));
});

test("(5d) a held-back message is read when it has been quiet long enough EVEN IF the file has not changed since", () => {
  const w = world();
  w.write("worker", [wake("2026-10-04T10:00:00.000Z", "worker-9001"), block("2026-10-04T10:00:04.000Z", "msg_x", 20)]);
  w.run(at("2026-10-04T10:00:30Z"));
  assert.equal(w.run(at("2026-10-04T10:01:00Z")).bytesRead, 0, "positive control: while it is still young an unchanged file is not read");
  const later = w.run(at("2026-10-04T10:00:04Z") + QUIET_MS + 1000);
  assert.deepEqual([later.read, later.added], [1, 1]);
});

test("(5e) a half-written last line is left for the next run, counted once as unreadable, and ingested exactly once when it is finished", () => {
  const w = world();
  const half = block("2026-10-04T10:31:10.000Z", "msg_c");
  w.write("lead", LEAD_1);
  appendFileSync(w.file("lead"), half.slice(0, 40));
  const first = w.run();
  assert.equal(first.unreadableLines, 1);
  assert.equal(w.stored().some((event) => event.id === "turn:msg_c"), false);
  appendFileSync(w.file("lead"), `${half.slice(40)}\n`);
  const second = w.run();
  assert.deepEqual([second.unreadableLines, second.added], [0, 1]);
  assert.equal(w.stored().filter((event) => event.id === "turn:msg_c").length, 1);
});

test("(5f) a session first named AFTER turns were read as unnamed is read again from zero and said so", () => {
  const w = world();
  w.write("late", [block("2026-10-04T10:00:04.000Z", "msg_u")]);
  w.run();
  w.append("late", [wake("2026-10-04T10:05:00.000Z", "worker-9001")]);
  const second = w.run();
  assert.match(second.reread[0], /late\.jsonl: its session was named by an order after turns it had already read/);
  assert.ok(w.stored().some((event) => event.session === "worker-9001"));
});

test("(6) a missing, unparseable, foreign-version or store-replaced state is a full ingest and a reported cold start: never an error, never a silent skip", () => {
  const w = world();
  w.write("lead", LEAD_1);
  const first = w.run();
  assert.match(first.coldStart, /no state file/);
  assert.equal(w.run().coldStart, null, "positive control: a good state is trusted, and says so by being silent");
  const idsBefore = byId(w.stored());
  writeFileSync(w.statePath, "{ not json");
  const garbled = w.run();
  assert.match(garbled.coldStart, /state file unreadable/);
  assert.equal(garbled.read, 1, "every transcript read again");
  writeFileSync(w.statePath, JSON.stringify({ version: 99, files: {} }));
  assert.match(w.run().coldStart, new RegExp(`not version ${STATE_VERSION}`));
  assert.deepEqual(byId(w.stored()), idsBefore, "a cold start adds nothing the store had: the ids are idempotent");
  rmSync(w.storePath);
  const replaced = w.run();
  assert.match(replaced.coldStart, /store is smaller/);
  assert.deepEqual(byId(w.stored()), idsBefore, "a deleted store is rebuilt from the transcripts, not left empty beside a state that says they were read");
  assert.match(render({ number: 9001, rows: [], prs: [], events: [], ingest: replaced }), /COLD START .*store is smaller/);
});

test("(7) the store is read ONCE per run, not once per file", () => {
  const w = world();
  for (const name of ["a", "b", "c", "d", "e"]) w.write(name, [wake("2026-10-04T10:00:00.000Z", `worker-900${name.charCodeAt(0) - 96}`), block("2026-10-04T10:00:04.000Z", `msg_${name}`)]);
  let reads = 0;
  const { report } = ingestTranscripts({ root: w.root, since: 0, ledger: LEDGER, rowRepo: ROW_REPO, storePath: w.storePath, now: NOW }, (path) => {
    reads += 1;
    return readStore(path);
  });
  assert.equal(report.read, 5, "positive control: five files were ingested");
  assert.equal(reads, 1);
});

test("FOOTER: says from when the state holds the transcripts, what it re-read, and what it held back", () => {
  const w = world();
  w.write("lead", LEAD_1);
  const report = w.run(at("2026-10-04T10:30:35Z"));
  const text = render({ number: 9001, rows: [], prs: [], events: [], ingest: { ...report, reread: ["/x/lead.jsonl: shrank from 9 to 3 bytes"] } });
  assert.match(text, /TRANSCRIPT STATE: holds each transcript from the run that first read it, the first run being 2026-10-04T10:30Z/);
  assert.match(text, /read again from byte 0: \/x\/lead\.jsonl: shrank/);
  assert.match(text, /2 messages written in the last 5 minutes are held back/);
  assert.match(text, /ingested 1 transcripts \(\d+ bytes read; 0 unchanged/);
});

test("STATE: written atomically beside the store, round-trips, and planRead skips on equal size AND mtime only", () => {
  const w = world();
  const state = emptyState({ now: 5, since: 1 });
  saveState(w.statePath, state);
  assert.deepEqual(loadState({ statePath: w.statePath, storePath: w.storePath, now: 9, since: 9 }), { state, coldStart: null });
  assert.equal(w.statePath, `${w.storePath}.ingest-state.json`);
  const entry = { offset: 10, size: 10, mtimeMs: 100, headBytes: 3, headHash: fingerprint(Buffer.from("abc")), firstReadAt: 1, settleAt: null, carry: { session: "s", owner: null, lastAt: null, used: [] } };
  const plan = (stat, headMatches = () => true, now = 0) => planRead({ entry, stat, now, headMatches });
  assert.equal(plan({ size: 10, mtimeMs: 100 }).action, "skip");
  assert.equal(plan({ size: 12, mtimeMs: 100 }).action, "resume", "same mtime, more bytes");
  assert.equal(plan({ size: 10, mtimeMs: 101 }).action, "resume", "same size, newer mtime");
  assert.equal(plan({ size: 9, mtimeMs: 101 }).action, "from-zero");
  assert.equal(plan({ size: 12, mtimeMs: 101 }, () => false).action, "from-zero");
  assert.equal(planRead({ entry: undefined, stat: { size: 1, mtimeMs: 1 }, now: 0, headMatches: () => true }).action, "from-zero");
  assert.equal(plan({ size: 10, mtimeMs: 100 }, () => true, 50).action, "skip", "a null settleAt waits for nothing");
});

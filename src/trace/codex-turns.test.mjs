// a11ign/a11ign#3519 (slice 2b of #3494): the Codex reviewers' turns. FIXTURES ONLY, in the record shapes measured on 2026-10-04 in `~/.codex/sessions` (a session trimmed to
// the records that matter: its ids are made up). Nothing here reads the home directory; the one directory tree a test reads is built under the temporary directory.
// no-token: gh -- `ingestTranscripts` is the transcript half of a run: nothing here reaches GitHub, and the one directory tree read is built under the temporary directory
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { eventsOfCodexSession } from "./codex-turns.mjs";
import { eventsForRow, readStore } from "./store.mjs";
import { ingestTranscripts } from "./trace.mjs";

const ROW_REPO = "a11ign/a11ign";

const record = (timestamp, ordinal, type, payload) => JSON.stringify({ timestamp, ordinal, type, payload });
const meta = (cwd) => record("2026-10-04T20:09:10.032Z", 0, "session_meta", { id: "sess-1", cwd, originator: "codex-tui" });
const started = (timestamp) => record(timestamp, 1, "event_msg", { type: "task_started", turn_id: "turn-1" });
const context = (timestamp, model) => record(timestamp, 2, "turn_context", { turn_id: "turn-1", cwd: "/x", model });
const order = (timestamp, role = "user") => record(timestamp, 3, "response_item", { type: "message", role, content: [{ type: "input_text", text: "review it" }] });
const toolOutput = (timestamp) => record(timestamp, 4, "response_item", { type: "custom_tool_call_output", call_id: "c", output: "ok" });
const reasoning = (timestamp) => record(timestamp, 5, "response_item", { type: "reasoning", summary: [] });
/** One model request: Codex counts cached tokens INSIDE `input_tokens`, and `output_tokens` includes the reasoning. */
const request = (timestamp, response, { input, cached, output, reasoningTokens = 0 }) => {
  const usage = { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoningTokens, total_tokens: input + output };
  return record(timestamp, 6, "token_usage_record", { thread_id: "sess-1", turn_id: "turn-1", response_id: response, usage, turn_token_usage: usage });
};
/** The running total Codex ALSO writes after each request: reading it as well would count every request twice. */
const running = (timestamp, input, output) => record(timestamp, 7, "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: output } } });

/** A reviewer on pull request 9100: its order, a request, a tool call and its output, a second request, and the final message. */
const REVIEWER = [
  meta("/home/agent/reviews/reviewer-9100"),
  started("2026-10-04T20:09:10.100Z"),
  context("2026-10-04T20:09:10.355Z", "gpt-5.6-luna"),
  order("2026-10-04T20:09:10.339Z", "developer"),
  order("2026-10-04T20:09:10.400Z"),
  reasoning("2026-10-04T20:09:12.900Z"),
  request("2026-10-04T20:09:13.069Z", "resp_a", { input: 13027, cached: 9984, output: 213, reasoningTokens: 39 }),
  running("2026-10-04T20:09:13.450Z", 13027, 213),
  toolOutput("2026-10-04T20:09:16.000Z"),
  request("2026-10-04T20:09:17.000Z", "resp_b", { input: 18194, cached: 12032, output: 185, reasoningTokens: 99 }),
  running("2026-10-04T20:09:17.473Z", 31221, 398),
];

const read = (lines, file = "rollout-a.jsonl", extra = {}) => eventsOfCodexSession({ text: `${lines.join("\n")}\n`, file, rowRepo: ROW_REPO, ...extra });

test("TRANSCRIPT ID (#3589): a turn carries the uuid ending its rollout's file name, which `CODEX_THREAD_ID` holds in the shell that session started; a file with no uuid carries none", () => {
  const id = "01a109e5-898a-7183-9545-94bb9ea0c2b3";
  assert.equal(read(REVIEWER, `/h/.codex/sessions/2026/10/05/rollout-2026-10-05T03-30-00-${id}.jsonl`).events[0].transcript, id);
  assert.equal("transcript" in read(REVIEWER, "rollout-a.jsonl").events[0], false, "no uuid, no key: never a guessed one");
});

test("TURNS: one per model request (not per running total), keyed to the pull request the reviewer was reviewing, with tokens, model and no invented cost", () => {
  const { session, events } = read(REVIEWER);
  assert.equal(session, "reviewer-9100");
  assert.equal(events.length, 2, "two requests are two turns; the two `token_count` totals are not read");
  const [first, second] = events;
  assert.deepEqual([first.id, first.kind, first.source, first.harness, first.pr, first.repo, first.row], ["codex-turn:resp_a", "turn", "transcript", "codex", 9100, null, null]);
  assert.deepEqual(first.tokens, { input: 13027 - 9984, output: 213, cacheRead: 9984, cacheWrite5m: 0, cacheWrite1h: 0 }, "input is the UNCACHED part: Codex counts cached tokens inside it");
  assert.equal(first.model, "gpt-5.6-luna");
  assert.equal(first.costUsd, null, "PRICES has no row for the model: unknown, never 0");
  assert.equal(first.at, Date.parse("2026-10-04T20:09:13.069Z"));
  assert.equal(first.wallClockMs, 13069 - 10400, "from the last record sent TO the model (the order) to the usage record");
  assert.equal(second.wallClockMs, 17000 - 16000, "after a tool's output, from that output");
  assert.equal(first.wakeId, null);
});

test("KEY: a keyed repository's reviewer is that repository's pull request; a session in another directory is named for it and has no subject", () => {
  const keyed = read([meta("/home/agent/reviews/reviewer-agent-org-165"), context("2026-10-04T20:00:00Z", "gpt-5.6-luna"), order("2026-10-04T20:00:01Z"),
    request("2026-10-04T20:00:05Z", "resp_k", { input: 10, cached: 0, output: 1 })]);
  assert.deepEqual([keyed.session, keyed.events[0].pr, keyed.events[0].repo], ["reviewer-agent-org-165", 165, "agent-org"]);
  const other = read([meta("/home/agent/repos/a11y-witness"), order("2026-10-04T20:00:01Z"), request("2026-10-04T20:00:05Z", "resp_o", { input: 10, cached: 0, output: 1 })]);
  assert.deepEqual([other.session, other.events[0].pr, other.events[0].row], ["codex:a11y-witness", null, null]);
  const nameless = read([order("2026-10-04T20:00:01Z"), request("2026-10-04T20:00:05Z", "resp_n", { input: 10, cached: 0, output: 1 })], "rollout-zz.jsonl");
  assert.equal(nameless.session, "unnamed:rollout-zz.jsonl");
});

test("RESUME: a read from the offset, with the carry, gives the events of one read of the whole, and a half-written last line waits", () => {
  const whole = read(REVIEWER);
  const cut = REVIEWER.slice(0, 8);
  const half = `${cut.join("\n")}\n{"timestamp":"2026-10-04T20:09:16.0`; // the line a live session is in the middle of writing
  const firstPart = eventsOfCodexSession({ text: half, file: "rollout-a.jsonl", rowRepo: ROW_REPO });
  assert.equal(firstPart.events.length, 1);
  assert.equal(firstPart.consumed, Buffer.byteLength(`${cut.join("\n")}\n`), "the half line is not consumed");
  const rest = `${REVIEWER.slice(8).join("\n")}\n`;
  const secondPart = eventsOfCodexSession({ text: rest, file: "rollout-a.jsonl", rowRepo: ROW_REPO, carry: firstPart.carry });
  assert.deepEqual([...firstPart.events, ...secondPart.events], whole.events);
});

/** A tree in the shape Codex keeps: `<root>/<year>/<month>/<day>/rollout-*.jsonl`. */
function sessionsTree(lines) {
  const dir = mkdtempSync(join(tmpdir(), "codex-turns-"));
  const day = join(dir, "sessions", "2026", "10", "04");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, "rollout-2026-10-04T20-09-06-sess-1.jsonl"), `${lines.join("\n")}\n`);
  mkdirSync(join(dir, "projects", "-proj"), { recursive: true });
  return { dir, codex: join(dir, "sessions"), claude: join(dir, "projects"), store: join(dir, "events.ndjson") };
}

test("INGEST: the Codex directory is walked, its turns reach the store and the pull request's trace; skipping the directory loses them (positive control)", () => {
  const tree = sessionsTree(REVIEWER);
  const run = (codexRoot) => ingestTranscripts({ root: tree.claude, codexRoot, since: 0, ledger: [], rowRepo: ROW_REPO, storePath: tree.store, now: Date.parse("2026-10-05T00:00:00Z") });
  const withoutCodex = run(null);
  assert.equal(withoutCodex.report.codexRead, 0);
  assert.equal(eventsForRow(readStore(tree.store), { rows: [], prs: [9100] }).length, 0, "positive control: with no Codex directory the store holds no reviewer turn, so the assertion below can fail");
  const first = run(tree.codex);
  assert.deepEqual([first.report.read, first.report.codexRead, first.report.added], [1, 1, 2]);
  const held = eventsForRow(readStore(tree.store), { rows: [], prs: [9100] });
  assert.deepEqual(held.map((event) => [event.session, event.harness, event.pr]), [["reviewer-9100", "codex", 9100], ["reviewer-9100", "codex", 9100]]);
  const stored = readFileSync(tree.store, "utf8");
  const second = run(tree.codex);
  assert.deepEqual([second.report.read, second.report.unchanged, second.report.bytesRead, second.report.added], [0, 1, 0, 0], "an unchanged session is not opened");
  assert.equal(readFileSync(tree.store, "utf8"), stored);
});

test("INGEST: a Codex directory that is absent is no error and no Codex read", () => {
  const tree = sessionsTree(REVIEWER);
  const { report } = ingestTranscripts({ root: tree.claude, codexRoot: join(tree.dir, "no-such"), since: 0, ledger: [], rowRepo: ROW_REPO, storePath: tree.store });
  assert.deepEqual([report.read, report.codexRead, report.failed], [0, 0, []]);
});

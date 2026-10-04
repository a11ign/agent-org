// a11ign/a11ign#3494: the trace store, first slice. Fixtures only: nothing here reads `~/.claude`, `~/.cache/a11ign` or GitHub.
// no-token: gh -- every source is an injected fixture; the only `gh` calls in the slice are in `resolveSubject`, which no test here calls
// The records are in the shapes measured on 2026-10-04: an `assistant` record per content block sharing one `message.id`, `usage.cache_creation` split by TTL, and a
// `user` record wrapped in `<pasted_content` for a delivered order.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseLedger } from "../wakes-per-row.mjs";
import { appendEvents, costOf, eventsForRow, eventsOfTranscript, PRICES, readStore, subjectOf, tokensOf } from "./store.mjs";
import { NOT_HELD, parseArgs, render, resolveSubject } from "./trace.mjs";

const ROW_REPO = "a11ign/a11ign";
const at = (iso) => Date.parse(iso);

const wake = (timestamp, session, body = "an order.") => JSON.stringify({
  type: "user", timestamp, message: { role: "user", content: `\n\n<pasted_content id="1">\nYou are \`${session}\` -- ${body}\n</pasted_content>` },
});
const toolResult = (timestamp) => JSON.stringify({ type: "user", timestamp, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
const compactSummary = (timestamp) => JSON.stringify({ type: "user", timestamp, isCompactSummary: true, message: { role: "user", content: "This session is being continued" } });
const usage = (input, output, read, write1h) => ({
  input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write1h,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write1h },
});
/** One block of an API message: the harness writes the message once per block, each with the SAME id and the usage as it stood. */
const block = (timestamp, id, model, tokens, extra = {}) => JSON.stringify({
  type: "assistant", timestamp, requestId: `req_${id}`, message: { id, model, role: "assistant", content: [{ type: "text", text: "x" }], usage: tokens }, ...extra,
});

const LEDGER = parseLedger([
  `${at("2026-10-04T10:00:00Z") - 2000}\tengineers/ready-row-unclaimed/9001\tworker-9001`,
  `${at("2026-10-04T11:00:00Z") - 3000}\tworker-9001/blocker-cleared/row-9001/9002`,
  `${at("2026-10-04T10:30:00Z") - 1000}\torchestrator/draft-convinced-not-ready/pr-9100/abc12345`,
  `${at("2026-10-04T10:40:00Z") - 1000}\torchestrator/ready-row-unclaimed/9050`,
].join("\n"));

/** worker-9001: one order, a three-block message and a two-block one, a compaction, a second order, an unpriced model. */
const WORKER = [
  wake("2026-10-04T10:00:00.000Z", "worker-9001", "row 9001 has been claimed for you."),
  block("2026-10-04T10:00:04.000Z", "msg_1", "claude-sonnet-5-5", usage(2, 20, 6448, 20554)),
  block("2026-10-04T10:00:06.000Z", "msg_1", "claude-sonnet-5-5", usage(2, 120, 6448, 20554)),
  block("2026-10-04T10:00:08.000Z", "msg_1", "claude-sonnet-5-5", usage(2, 246, 6448, 20554)),
  toolResult("2026-10-04T10:00:20.000Z"),
  block("2026-10-04T10:00:30.000Z", "msg_2", "claude-sonnet-5-5", usage(3, 50, 27002, 100)),
  compactSummary("2026-10-04T10:50:00.000Z"),
  wake("2026-10-04T11:00:00.000Z", "worker-9001", "IDLE FOR 46 MINUTES WITH NO WAIT"),
  block("2026-10-04T11:00:09.000Z", "msg_3", "<synthetic>", usage(1, 5, 0, 0)),
].join("\n");

/** The orchestrator, delivered one order about pull request 9100 (which closes row 9001) and one about an unrelated row. */
const ORCHESTRATOR = [
  wake("2026-10-04T10:30:00.000Z", "orchestrator"),
  block("2026-10-04T10:30:10.000Z", "msg_o1", "claude-opus-5-5", usage(5, 300, 40000, 0)),
  wake("2026-10-04T10:40:00.000Z", "orchestrator"),
  block("2026-10-04T10:40:12.000Z", "msg_o2", "claude-opus-5-5", usage(5, 100, 40000, 0)),
].join("\n");

const read = (text, file) => eventsOfTranscript({ text, file, ledger: LEDGER, rowRepo: ROW_REPO });
const worker = () => read(WORKER, "w.jsonl");
const orchestrator = () => read(ORCHESTRATOR, "o.jsonl");
const turns = (events) => events.filter((event) => event.kind === "turn");

test("COST: the price table reproduces Claude Code's own cost_usd on the two requests it was checked against", () => {
  // From `CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_LOGS_EXPORTER=console claude -p ...`, 2026-10-04: api_request.cost_usd.
  assert.equal(costOf("claude-haiku-4-5-20251001", tokensOf(usage(10, 43, 12548, 9289))), 0.0200578);
  assert.equal(costOf("claude-sonnet-5-5", tokensOf(usage(2, 4, 8650, 12311))), 0.051018);
  assert.ok(PRICES.filter((price) => price.verified).length === 2, "exactly the two checked rows are marked verified");
});

test("COST: a model with no price is null, never 0; and a missing split is priced as 1-hour writes", () => {
  assert.equal(costOf("<synthetic>", tokensOf(usage(1, 5, 0, 0))), null);
  assert.equal(costOf(undefined, tokensOf(usage(1, 5, 0, 0))), null);
  const unsplit = tokensOf({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000 });
  assert.deepEqual([unsplit.cacheWrite5m, unsplit.cacheWrite1h], [0, 1000]);
});

test("TURNS: one per message id, from its LAST block (a transcript writes a message once per block)", () => {
  const found = turns(worker().events);
  assert.equal(found.length, 3, "3 message ids, not 6 assistant records"); // positive control for the emptiness checks below
  const first = found.find((turn) => turn.id === "turn:msg_1");
  assert.equal(first?.tokens?.output, 246, "the final block's output_tokens, not the first's 20");
  assert.equal(first?.wallClockMs, 8000, "from the order at :00 to the last block at :08");
  assert.equal(found.find((turn) => turn.id === "turn:msg_2")?.wallClockMs, 10000, "from the tool result at :20 to the block at :30");
  assert.equal(first?.costUsd, costOf("claude-sonnet-5-5", first.tokens));
  assert.equal(found.find((turn) => turn.id === "turn:msg_3")?.costUsd, null);
});

test("WAKES: the ledger line pairs with the delivery, names the row, and its typing lag is measured", () => {
  const wakes = worker().events.filter((event) => event.kind === "wake");
  assert.equal(wakes.length, 2);
  assert.equal(wakes[0].causeKey, "engineers/ready-row-unclaimed/9001");
  assert.equal(wakes[0].row, 9001);
  assert.equal(wakes[0].deliveryLagMs, 2000);
  assert.equal(wakes[1].causeKey, "worker-9001/blocker-cleared/row-9001/9002");
  assert.equal(wakes[1].deliveryLagMs, 3000);
});

test("ATTRIBUTION: a turn belongs to the wake before it; the compaction too; a standing lead's turn is keyed by the order's pull request", () => {
  const events = worker().events;
  assert.deepEqual(turns(events).map((turn) => [turn.id, turn.wakeId === `wake:worker-9001:${at("2026-10-04T11:00:00Z")}` ? "second" : "first"]),
    [["turn:msg_1", "first"], ["turn:msg_2", "first"], ["turn:msg_3", "second"]]);
  const compaction = events.find((event) => event.kind === "compaction");
  assert.equal(compaction?.row, 9001);
  const lead = turns(orchestrator().events);
  assert.deepEqual(lead.map((turn) => [turn.row, turn.pr, turn.cause]), [[null, 9100, "draft-convinced-not-ready"], [9050, null, "ready-row-unclaimed"]]);
});

test("SUBJECT: what a cause key names, and the cases it must NOT guess", () => {
  const cases = {
    "worker-3490/pr-review-blocked/pr-agent-org#165/AWAITING_REVIEW": { row: null, pr: 165, repo: "agent-org" },
    "orchestrator/draft-convinced-not-ready/pr-3406/abc": { row: null, pr: 3406, repo: null },
    "product-manager/pr-review-blocked/3412:AWAITING_REVIEW": { row: null, pr: 3412, repo: null },
    "product-manager/answer-owed/row-3494": { row: 3494, pr: null, repo: null },
    "engineers/ready-row-unclaimed/3494": { row: 3494, pr: null, repo: null },
    "product-manager/row-call-count-signal/3494,3495": { row: null, pr: null, repo: null }, // two rows: no guess
    "orchestrator/fleet-batch-due/12345": { row: null, pr: null, repo: null }, // a bare number of a cause not in the table
    "ceo/org-health/order-deferred-too-long@deferred:orchestrator/pr-checks-failing/pr-3460/ejected": { row: null, pr: null, repo: null },
  };
  for (const [key, expected] of Object.entries(cases)) assert.deepEqual(subjectOf(key), expected, key);
});

test("STORE: append-only and idempotent; a second ingest adds nothing and rewrites nothing", () => {
  const path = join(mkdtempSync(join(tmpdir(), "trace-")), "events.ndjson");
  const all = [...worker().events, ...orchestrator().events];
  const first = appendEvents(path, all);
  assert.deepEqual(first, { added: all.length, skipped: 0 });
  assert.ok(first.added >= 10, "positive control: the fixtures yield events at all");
  const bytes = readFileSync(path, "utf8");
  assert.deepEqual(appendEvents(path, all), { added: 0, skipped: all.length });
  assert.equal(readFileSync(path, "utf8"), bytes);
  assert.deepEqual(appendEvents(path, [all[0], all[0]]), { added: 0, skipped: 2 });
  assert.equal(readStore(path).length, all.length);
});

test("ROW: a row's trace holds its own events and those of the pull requests that close it, in time order, and nobody else's", () => {
  const all = [...worker().events, ...orchestrator().events];
  const own = eventsForRow(all, { rows: [9001], prs: [] });
  assert.equal(own.every((event) => event.session === "worker-9001"), true);
  const withPull = eventsForRow(all, { rows: [9001], prs: [9100] });
  assert.ok(withPull.some((event) => event.session === "orchestrator" && event.pr === 9100));
  assert.equal(withPull.some((event) => event.row === 9050), false, "the other order of the same seat is another row's");
  assert.deepEqual(withPull.map((event) => event.at), [...withPull.map((event) => event.at)].sort((a, b) => a - b));
  const keyed = { id: "wake:reviewer-agent-org-9100:1", kind: "wake", source: "wake-ledger", at: 1, session: "reviewer-agent-org-9100", row: null, pr: 9100, repo: "agent-org" };
  assert.equal(eventsForRow([...all, keyed], { rows: [9001], prs: [9100] }).includes(keyed), false, "agent-org#9100 is not a11ign#9100");
});

test("REPORT: events in order with tokens and wall-clock, a priced total that excludes the unpriced turn, and what it does not hold", () => {
  const all = [...worker().events, ...orchestrator().events];
  const text = render({ number: 9001, rows: [9001], prs: [9100], events: eventsForRow(all, { rows: [9001], prs: [9100] }) });
  assert.match(text, /TRACE #9001 {2}\(rows: #9001; pull requests: #9100\)/);
  assert.match(text, /WAKE {3}engineers\/ready-row-unclaimed\/9001 {2}lag 0m02s/);
  assert.match(text, /turn +0m08s .*out 246/);
  assert.match(text, /1 turns have a model with no price and are NOT in that total/);
  assert.match(text, /COMPACTION/);
  assert.ok(text.includes(NOT_HELD));
});

test("REPORT: GitHub events print between the turns, the footer says how many calls were made, and NOT_HELD no longer lists GitHub", () => {
  const github = (kind, iso, extra) => ({ id: `gh:${kind}:${iso}`, kind, source: "github", session: "github", at: at(iso), row: null, pr: 9100, repo: null, cause: null, causeKey: null,
    wakeId: null, actor: "a11ign-bot", ...extra });
  const events = [...eventsForRow([...worker().events, ...orchestrator().events], { rows: [9001], prs: [9100] }),
    github("reviewed", "2026-10-04T10:35:00Z", { state: "APPROVED", headSha: "0fde4737ea065e2d794cfab07b39373e715fede4" }),
    github("added_to_merge_queue", "2026-10-04T10:36:00Z"), github("removed_from_merge_queue", "2026-10-04T10:46:00Z", { outcome: "unmerged" })]
    .sort((a, b) => a.at - b.at);
  const text = render({ number: 9001, rows: [9001], prs: [9100], events, github: { calls: 6, read: 3, added: 3 } });
  assert.match(text, /10:35:00 +github +REVIEW +APPROVED by a11ign-bot at head 0fde473/);
  assert.match(text, /QUEUED +by a11ign-bot/);
  assert.match(text, /DEQUEUED \(unmerged\)/);
  assert.match(text, /GitHub: 6 REST calls \(gh api\); 3 events read, 3 new to the store/);
  assert.match(text, /3 from GitHub/);
  assert.equal(text.indexOf("REVIEW") > text.indexOf("WAKE"), true, "the review falls between the turns, in time order");
  assert.doesNotMatch(NOT_HELD, /GitHub/);
  for (const still of ["gh call ledger", "deferral spans", "Codex reviewer turns"]) assert.ok(NOT_HELD.includes(still), still);
  assert.match(text, /across 2 sessions/, "`github` is a source, not a session");
});

test("ARGS: the row is required and `--` is tolerated", () => {
  assert.equal(parseArgs(["--", "3406"]).number, 3406);
  assert.equal(parseArgs(["3406", "--json", "1"]).json, true);
  assert.throws(() => parseArgs(["--", "abc"]), /usage: trace/);
  assert.throws(() => parseArgs([]), /usage: trace/);
});

/** A `gh api` that answers from a table and fails like gh does for anything else. */
const fakeGh = ({ pulls, search }) => (args) => {
  const path = args[0];
  const pull = /pulls\/(\d+)$/.exec(path);
  if (pull) {
    if (pulls[pull[1]]) return pulls[pull[1]];
    throw Object.assign(new Error("gh: Not Found (HTTP 404)"), { stderr: "gh: Not Found (HTTP 404)" });
  }
  if (path === "-X" && args[2] === "search/issues") return { items: search };
  throw new Error(`unexpected gh call ${args.join(" ")}`);
};

test("SUBJECT OF A NUMBER: a pull request resolves to the rows it closes, a row to the pull requests that close it", () => {
  const search = [{ number: 9100, body: "Closes #9001\n" }, { number: 9200, body: "Closes: none -- 9001 mentioned" }, { number: 9300, body: "Closes a11ign/other#9001" }];
  const gh = fakeGh({ pulls: { 9100: { body: "Closes #9001\n" } }, search });
  assert.deepEqual(resolveSubject(9100, ROW_REPO, gh), { rows: [9001], prs: [9100] }, "asked as a pull request");
  assert.deepEqual(resolveSubject(9001, ROW_REPO, gh), { rows: [9001], prs: [9100] }, "asked as a row: a mention that closes nothing, or closes another repository's row, is not a link");
});

test("SUBJECT OF A NUMBER: only a 404 means 'this is a row'; any other failure throws rather than printing a trace without the leads' turns", () => {
  const broken = (args) => { if (/pulls\//.test(args[0])) throw Object.assign(new Error("HTTP 403 rate limit"), { stderr: "HTTP 403 rate limit" }); return { items: [] }; };
  assert.throws(() => resolveSubject(9001, ROW_REPO, broken), /403/);
});

// a11ign/a11ign#3494: the trace store, first slice. Fixtures only: nothing here reads `~/.claude`, `~/.cache/a11ign` or GitHub.
// no-token: gh -- every source is an injected fixture; the only `gh` calls in the slice are in `resolveSubject`, which no test here calls
// The records are in the shapes measured on 2026-10-04: an `assistant` record per content block sharing one `message.id`, `usage.cache_creation` split by TTL, and a
// `user` record wrapped in `<pasted_content` for a delivered order.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFERRAL_LOG_FILE, deferralLogText } from "../deferral-log.mjs";
import { parseLedger } from "../wakes-per-row.mjs";
import { appendEvents, appendToStore, costOf, eventsForRow, eventsOfDeferrals, eventsOfTranscript, openStore, PRICES, readStore, repriceEvents, subjectOf, subjectsOf, tokensOf, touchesOf } from "./store.mjs";
import { weekStart } from "./aggregate.mjs";
import { ACTION, wakeCache } from "./wake-cache.mjs";
import { budgetedGh, githubEventsOfMerged, ingestDeferrals, ingestTranscripts, isAggregate, isMap, isWakeCache, listMergedPulls, listOpenRows, NOT_HELD, parseAggregateArgs, parseArgs, parseMapArgs, parseWakeCacheArgs, parseWeek, readListings, render, resolveSubject, waterfallsOf, writeSwimlanes } from "./trace.mjs";

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

test("COST (#3582): claude-sonnet-5 and claude-opus-5 are priced at their own rates, and the 5.5 ids still at theirs", () => {
  const tokens = tokensOf({ input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 });
  // Published rates (claude-api model docs, 2026-09-25): input + output + cache read, per million tokens.
  assert.equal(costOf("claude-sonnet-5", tokens), 2 + 10 + 0.2);
  assert.equal(costOf("claude-opus-5", tokens), 5 + 25 + 0.5);
  assert.equal(costOf("claude-opus-5-5", tokens), 4 + 20 + 0.2, "5.5 is not priced as 5: the shorter prefix must stand after the longer");
  assert.equal(costOf("claude-sonnet-5-5", tokens), 2 + 10 + 0.2);
  assert.equal(costOf("gpt-5.6-luna", tokens), null, "no Codex rate is sourced: unknown, never 0");
  assert.equal(costOf("claude-opus-4-8", tokens), null, "a model still without a row stays null");
});

test("COST (#3582): POSITIVE CONTROL: with the two rows deleted the same turns are unpriced", () => {
  const tokens = tokensOf(usage(10, 20, 30, 40));
  const without = PRICES.filter((price) => price.prefix !== "claude-opus-5" && price.prefix !== "claude-sonnet-5");
  assert.equal(without.length, PRICES.length - 2, "the table holds exactly those two rows to delete");
  const priced = (table, model) => table.find((entry) => model.startsWith(entry.prefix)) ?? null;
  assert.equal(priced(without, "claude-opus-5"), null);
  assert.equal(priced(without, "claude-sonnet-5"), null);
  assert.ok(priced(PRICES, "claude-opus-5") && priced(PRICES, "claude-sonnet-5") && costOf("claude-opus-5", tokens) !== null);
});

test("COST: a model with no price is null, never 0; and a missing split is priced as 1-hour writes", () => {
  assert.equal(costOf("<synthetic>", tokensOf(usage(1, 5, 0, 0))), null);
  assert.equal(costOf(undefined, tokensOf(usage(1, 5, 0, 0))), null);
  const unsplit = tokensOf({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000 });
  assert.deepEqual([unsplit.cacheWrite5m, unsplit.cacheWrite1h], [0, 1000]);
});

test("TRANSCRIPT ID (#3589): a turn carries the file name of its transcript without `.jsonl`, which is what `CLAUDE_CODE_SESSION_ID` holds in the session that wrote it", () => {
  const { events } = read(WORKER, "/home/agent/.claude/projects/p/0b5e7f10-9001-4a00-8000-000000000001.jsonl");
  const turns = events.filter((event) => event.kind === "turn");
  assert.ok(turns.length > 0, "POSITIVE CONTROL: there are turns to check");
  assert.ok(turns.every((turn) => turn.transcript === "0b5e7f10-9001-4a00-8000-000000000001"));
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

/** An assistant record whose one block is a tool call, as the harness writes it. */
const toolUse = (timestamp, id, toolId) => JSON.stringify({
  type: "assistant", timestamp, requestId: `req_${id}`, message: { id, model: "claude-sonnet-5-5", role: "assistant", content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command: "pnpm test" } }], usage: usage(1, 30, 100, 0) },
});
const attachment = (timestamp) => JSON.stringify({ type: "attachment", timestamp, attachment: { type: "hook_success" } });
const toolResultFor = (timestamp, toolId) => JSON.stringify({ type: "user", timestamp, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "ok" }] } });

/** worker-9001 runs a 6-minute `pnpm test`: the call at 10:00:05, its result at 10:06:05, an attachment 2 s later, the next message at 10:06:12. */
const LONG_TOOL = [
  wake("2026-10-04T10:00:00.000Z", "worker-9001", "row 9001 has been claimed for you."),
  toolUse("2026-10-04T10:00:05.000Z", "msg_t1", "tu1"),
  toolResultFor("2026-10-04T10:06:05.000Z", "tu1"),
  attachment("2026-10-04T10:06:07.000Z"),
  block("2026-10-04T10:06:12.000Z", "msg_t2", "claude-sonnet-5-5", usage(2, 40, 200, 0)),
];

test("TOOL TIME (#3669): a message that follows a 6-minute tool call carries it as `toolMs`, and its `wallClockMs` is only the model's own seconds", () => {
  const found = turns(read(LONG_TOOL.join("\n"), "t.jsonl").events);
  assert.equal(found.length, 2, "POSITIVE CONTROL: both messages are turns");
  const after = found.find((turn) => turn.id === "turn:msg_t2");
  assert.equal(after?.toolMs, 6 * 60 * 1000, "from the call's last block at 10:00:05 to its result at 10:06:05");
  assert.equal(after?.wallClockMs, 5000, "from the attachment at 10:06:07 to the block at 10:06:12: `store.mjs` once said this included the tool, and it does not");
  assert.equal(found.find((turn) => turn.id === "turn:msg_t1")?.toolMs, null, "it follows an order, not a tool call: null, never 0");
});

test("TOOL TIME (#3669): a read that resumes between the call and its result still measures it, from the carried time of the last record", () => {
  const whole = turns(read(LONG_TOOL.join("\n"), "t.jsonl").events);
  const head = `${LONG_TOOL.slice(0, 2).join("\n")}\n`;
  const first = eventsOfTranscript({ text: head, file: "t.jsonl", ledger: LEDGER, rowRepo: ROW_REPO });
  const resumed = eventsOfTranscript({ text: LONG_TOOL.slice(2).join("\n"), file: "t.jsonl", ledger: LEDGER, rowRepo: ROW_REPO, carry: first.carry });
  assert.equal(turns(resumed.events).length, 1, "POSITIVE CONTROL: the second read holds the message after the call");
  assert.equal(whole.find((turn) => turn.id === "turn:msg_t2")?.toolMs, 6 * 60 * 1000, "POSITIVE CONTROL: a whole read measures it, so equality below is not null equal to null");
  assert.equal(turns(resumed.events)[0].toolMs, 6 * 60 * 1000);
  const cold = eventsOfTranscript({ text: LONG_TOOL.slice(2).join("\n"), file: "t.jsonl", ledger: LEDGER, rowRepo: ROW_REPO });
  assert.equal(turns(cold.events)[0].toolMs, null, "with nothing carried nobody can say when the call began: null, never a guess");
});

test("TOOL TIME (#3669): an order or a prompt between two messages means no tool ran before the second, whatever the gap", () => {
  const afterOrder = [LONG_TOOL[1], wake("2026-10-04T10:30:00.000Z", "worker-9001", "a second order."), block("2026-10-04T10:30:09.000Z", "msg_t3", "claude-sonnet-5-5", usage(2, 40, 200, 0))];
  assert.equal(turns(read(afterOrder.join("\n"), "t2.jsonl").events).find((turn) => turn.id === "turn:msg_t3")?.toolMs, null);
  const promptAfterResult = [...LONG_TOOL.slice(0, 3), wake("2026-10-04T10:30:00.000Z", "worker-9001", "typed after the result."), block("2026-10-04T10:30:09.000Z", "msg_t3", "claude-sonnet-5-5", usage(2, 40, 200, 0))];
  assert.equal(turns(read(promptAfterResult.join("\n"), "t3.jsonl").events).find((turn) => turn.id === "turn:msg_t3")?.toolMs, null, "the gap before the message is the prompt's wait, not the tool's, even with a result before it");
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
  assert.deepEqual(first, { added: all.length, superseded: 0, skipped: 0 });
  assert.ok(first.added >= 10, "positive control: the fixtures yield events at all");
  const bytes = readFileSync(path, "utf8");
  assert.deepEqual(appendEvents(path, all), { added: 0, superseded: 0, skipped: all.length });
  assert.equal(readFileSync(path, "utf8"), bytes);
  assert.deepEqual(appendEvents(path, [all[0], all[0]]), { added: 0, superseded: 0, skipped: 2 });
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
  assert.ok(NOT_HELD.includes("deferral spans"));
  assert.doesNotMatch(NOT_HELD, /gh call ledger/, "#3516: the ledger is a source now, and a footer that still said it was missing would deny the report above it");
  assert.doesNotMatch(NOT_HELD, /Codex/);
  assert.match(text, /across 2 sessions/, "`github` is a source, not a session");
});

test("WATERFALL (#3511): the report prints the eight phases above the events, one waterfall per row a pull request closes, and a pull request closing none is its own", () => {
  const github = (kind, iso, extra = {}) => ({ id: `gh:${kind}:${iso}:${extra.row ?? extra.pr}`, kind, source: "github", session: "github", at: at(iso), row: null, pr: null, repo: null, cause: null,
    causeKey: null, wakeId: null, actor: "a11ign-bot", ...extra });
  const pullEvents = [github("opened", "2026-10-04T10:20:00Z", { pr: 9100 }), github("reviewed", "2026-10-04T10:35:00Z", { pr: 9100, state: "APPROVED", headSha: "0fde4737ea065e2d794cfab07b39373e715fede4" }),
    github("merged", "2026-10-04T10:50:00Z", { pr: 9100 }), github("closed", "2026-10-04T10:50:00Z", { pr: 9100 })];
  const rowEvents = (row) => [github("filed", "2026-10-04T09:00:00Z", { row }), github("claimed", "2026-10-04T09:30:00Z", { row, claimant: "worker-9001" }), github("closed", "2026-10-04T10:50:05Z", { row })];
  const events = eventsForRow([...worker().events, ...orchestrator().events, ...pullEvents, ...rowEvents(9001), ...rowEvents(9002)], { rows: [9001, 9002], prs: [9100] });
  const now = at("2026-10-04T12:00:00Z");
  const drawn = waterfallsOf({ rows: [9001, 9002], prs: [9100], number: 9100, events, now });
  assert.deepEqual(drawn.map((one) => one.title), ["row #9001", "row #9002"], "a pull request that closes two rows is drawn once for each");
  assert.deepEqual(drawn.map((one) => one.waterfall.start), [at("2026-10-04T09:00:00Z"), at("2026-10-04T09:00:00Z")]);
  const text = render({ number: 9100, rows: [9001, 9002], prs: [9100], events, now });
  assert.ok(text.indexOf("WATERFALL row #9001") > 0 && text.indexOf("WATERFALL row #9001") < text.indexOf("\nEVENTS\n"), "the waterfall comes first, then the events");
  assert.match(text, /WATERFALL row #9002 {2}\(read 2026-10-04 12:00:00Z\)/);
  for (const phase of ["spec", "claim", "build", "verify", "review", "CI", "queue", "merge"]) assert.match(text, new RegExp(`^  ${phase.padEnd(7)} [A-Z ]+ `, "m"), `the ${phase} phase is printed`);
  assert.match(text, /merge +ENDED +wall-clock 5s .* unexplained 5s/, "merged -> the row closed 5 s later, and nothing records those 5 s");
  assert.ok(text.includes("WATERFALL (#3511): the eight phases of a row"), "the definitions travel with the report");
  assert.equal(waterfallsOf({ rows: [], prs: [], number: 9100, events: pullEvents, now })[0].title, "pull request #9100");
  assert.match(render({ number: 9100, rows: [], prs: [9100], events: pullEvents, now }), /WATERFALL pull request #9100/);
});

test("ARGS: the row is required and `--` is tolerated", () => {
  assert.equal(parseArgs(["--", "3406"]).number, 3406);
  assert.equal(parseArgs(["3406", "--json", "1"]).json, true);
  assert.throws(() => parseArgs(["--", "abc"]), /usage: trace/);
  assert.throws(() => parseArgs([]), /usage: trace/);
});

test("ARGS --html: the flag takes no value, needs --out, and leaves the other flags where they were (#3512)", () => {
  const given = parseArgs(["--", "3406", "--html", "--out", "/tmp/x.html", "--since", "2026-10-01T00:00:00Z"]);
  assert.deepEqual([given.number, given.html, given.out, given.since, given.json], [3406, true, "/tmp/x.html", Date.parse("2026-10-01T00:00:00Z"), false]);
  assert.equal(parseArgs(["--", "3406", "--out", "/tmp/x.html"]).html, false, "--out alone is not --html");
  assert.equal(parseArgs(["--", "3406", "--json", "1"]).html, false);
  assert.throws(() => parseArgs(["--", "3406", "--html"]), /--html needs --out <path>/);
  assert.deepEqual([parseArgs(["--", "3406", "--out", "/tmp/x.html", "--html"]).html, parseArgs(["--", "3406", "--out", "/tmp/x.html", "--html"]).out], [true, "/tmp/x.html"], "--html in either position is read the same");
});

test("--html writes the swimlane to the path, one file per row when a number names several, and prints where (#3512)", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-swimlane-"));
  const subject = (title) => ({ title, found: [{ id: "gh:a:filed", kind: "filed", source: "github", session: "github", at: at("2026-10-04T10:00:00Z"), row: 9001, pr: null, repo: null, cause: null, causeKey: null, wakeId: null, actor: "product-manager" }] });
  const now = at("2026-10-04T12:00:00Z");
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(line);
  try {
    writeSwimlanes({ out: join(dir, "one.html"), subjects: [subject("row #9001")], now, github: { calls: 2, read: 1, added: 1 } });
    writeSwimlanes({ out: join(dir, "many.html"), subjects: [subject("row #9001"), subject("row #9002")], now, github: { calls: 2, read: 1, added: 1 } });
  } finally {
    console.log = log;
  }
  assert.match(readFileSync(join(dir, "one.html"), "utf8"), /^<!doctype html>[\s\S]*<title>Swimlane row #9001<\/title>/);
  assert.match(readFileSync(join(dir, "many-row-9001.html"), "utf8"), /<h1>Swimlane: row #9001<\/h1>/);
  assert.match(readFileSync(join(dir, "many-row-9002.html"), "utf8"), /<h1>Swimlane: row #9002<\/h1>/);
  assert.equal(lines.length, 3);
  assert.match(lines[0], new RegExp(`^wrote ${join(dir, "one.html").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: the swimlane of row #9001, 1 events; GitHub: 2 REST calls`));
});

test("ARGS --aggregate: the flag takes no value, --since is rounded down to its Monday, and a bad time is refused", () => {
  assert.equal(isAggregate(["--", "--aggregate"]), true);
  assert.equal(isAggregate(["--", "3406"]), false);
  const parsed = parseAggregateArgs(["--", "--aggregate", "--since", "2026-09-24T13:00:00Z", "--store", "/s/events.ndjson", "--json", "1"]);
  assert.deepEqual(parsed, { since: at("2026-09-21T00:00:00Z"), store: "/s/events.ndjson", json: true, budget: 1500 });
  assert.equal(parseAggregateArgs(["--aggregate"]).since, weekStart(parseAggregateArgs(["--aggregate"]).since), "the default start is a Monday too");
  assert.ok(parseAggregateArgs(["--aggregate"]).since < Date.now(), "and it is in the past");
  assert.throws(() => parseAggregateArgs(["--aggregate", "--since", "last week"]), /--since must be an ISO time/);
  assert.equal(parseAggregateArgs(["--aggregate"]).budget, 1500, "the default spends a third of the hourly REST pool");
  assert.equal(parseAggregateArgs(["--aggregate", "--calls", "0"]).budget, 0);
  assert.throws(() => parseAggregateArgs(["--aggregate", "--calls", "many"]), /--calls must be a whole number/);
});

test("ARGS --map: the flag takes no value, --out is required, the three filters are carried, and --since is NOT rounded to a Monday", () => {
  const now = at("2026-10-05T12:00:00Z");
  assert.equal(isMap(["--", "--map", "--out", "/o.html"]), true);
  assert.equal(isMap(["--", "--aggregate"]), false);
  assert.equal(isMap(["--", "3406"]), false);
  assert.throws(() => parseMapArgs(["--", "--map"], now), /usage: trace -- --map --out <path>/);
  const parsed = parseMapArgs(["--", "--map", "--out", "/o.html", "--repo", "agent-org", "--week", "2026-W40", "--cause", "pr-review-blocked", "--since", "2026-09-28T13:00:00Z", "--store", "/s/events.ndjson"], now);
  assert.deepEqual(parsed, { since: at("2026-09-28T13:00:00Z"), store: "/s/events.ndjson", out: "/o.html", budget: 1500, filter: { repo: "agent-org", week: at("2026-09-28T00:00:00Z"), cause: "pr-review-blocked" } });
  assert.deepEqual(parseMapArgs(["--map", "--out", "/o.html"], now).filter, { repo: undefined, week: undefined, cause: undefined }, "no filter is every row");
  assert.equal(parseMapArgs(["--map", "--out", "/o.html"], now).since, weekStart(now) - 4 * 7 * 24 * 60 * 60 * 1000, "the default window starts where --aggregate's does");
  assert.equal(parseMapArgs(["--map", "--out", "/o.html", "--week", "2026-W40"], now).since, at("2026-09-28T00:00:00Z"), "--week alone reads from that week's Monday, not four weeks back");
  assert.throws(() => parseMapArgs(["--map", "--out", "/o.html", "--since", "last week"], now), /--since must be an ISO time/);
  assert.throws(() => parseMapArgs(["--map", "--out", "/o.html", "--calls", "many"], now), /--calls must be a whole number/);
});

test("ARGS --wake-cache: a window that starts at --since (not rounded) or a week back, and a store; no GitHub budget", () => {
  const now = at("2026-10-05T12:00:00Z");
  assert.equal(isWakeCache(["--", "--wake-cache"]), true);
  assert.equal(isWakeCache(["--", "--aggregate"]), false);
  assert.deepEqual(parseWakeCacheArgs(["--", "--wake-cache", "--since", "2026-10-01T13:00:00Z", "--until", "2026-10-04T15:00:00Z", "--store", "/s/events.ndjson", "--json", "1"], now), { since: at("2026-10-01T13:00:00Z"), until: at("2026-10-04T15:00:00Z"), store: "/s/events.ndjson", json: true });
  assert.equal(parseWakeCacheArgs(["--wake-cache"], now).until, now, "the window ends now unless --until says otherwise");
  assert.throws(() => parseWakeCacheArgs(["--wake-cache", "--until", "soon"], now), /--until must be an ISO time/);
  assert.equal(parseWakeCacheArgs(["--wake-cache"], now).since, now - 7 * 24 * 60 * 60 * 1000, "the default window is the last seven days");
  assert.throws(() => parseWakeCacheArgs(["--wake-cache", "--since", "last week"], now), /--since must be an ISO time/);
});

test("WAKE-CACHE reads what the ingest writes: a second transcript file for the same seat is a cleared window, the same file a kept one", () => {
  const first = [
    wake("2026-10-04T10:00:00.000Z", "ceo"), block("2026-10-04T10:00:05.000Z", "msg_c1", "claude-sonnet-5-5", usage(2, 20, 23711, 30000)),
    wake("2026-10-04T10:10:00.000Z", "ceo"), block("2026-10-04T10:10:05.000Z", "msg_c2", "claude-sonnet-5-5", usage(2, 20, 60000, 900)),
  ].join("\n");
  const afterClear = [wake("2026-10-04T10:20:00.000Z", "ceo"), block("2026-10-04T10:20:05.000Z", "msg_c3", "claude-sonnet-5-5", usage(2, 20, 23711, 29000))].join("\n");
  const events = [...read(first, "/p/aaaa.jsonl").events, ...read(afterClear, "/p/bbbb.jsonl").events];
  const ceo = wakeCache({ events, window: { from: at("2026-10-04T00:00:00Z"), to: at("2026-10-05T00:00:00Z") } }).seats.find((seat) => seat.seat === "ceo");
  const by = (name) => ceo.actions.find((entry) => entry.action === name);
  assert.equal(by(ACTION.UNKNOWN).wakes, 1, "the seat's first wake has no previous turn");
  assert.equal(by(ACTION.KEPT).wakes, 1);
  assert.equal(by(ACTION.KEPT).write.p50, 900);
  assert.equal(by(ACTION.CLEARED).wakes, 1, "the second file begins at the /clear");
  assert.equal(by(ACTION.CLEARED).write.p50, 29_000);
});

test("ARGS --week: an ISO week, a bare week number of this year, or any day in the week; each is that week's Monday 00:00 UTC", () => {
  const now = at("2026-10-05T12:00:00Z");
  const monday = at("2026-09-28T00:00:00Z"); // ISO week 40 of 2026: 4 January 2026 is a Sunday, so week 1 starts Monday 2025-12-29
  assert.equal(parseWeek("2026-W40", now), monday);
  assert.equal(parseWeek("40", now), monday);
  assert.equal(parseWeek("2026-10-04", now), monday, "a Sunday is the last day of its week");
  assert.equal(parseWeek("2026-09-28T00:00:00Z", now), monday);
  assert.equal(parseWeek("2026-W01", now), at("2025-12-29T00:00:00Z"), "week 1 of 2026 starts in 2025");
  assert.equal(parseWeek("2025-W52", now), at("2025-12-22T00:00:00Z"));
  assert.throws(() => parseWeek("54", now), /not an ISO week/);
  assert.throws(() => parseWeek("0", now), /not an ISO week/);
  assert.throws(() => parseWeek("last week", now), /--week must be an ISO week/);
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

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// a11ign/a11ign#3519 (slice 2b of #3494): a standing seat's turns land on the rows they were about. The product-manager transcript below is in the shape of the one whose
// turns #3406's trace lacked: a wake whose ledger key names SEVERAL rows (`row-call-count-signal/9001,9002`, which `subjectOf` leaves unattributed because the first of
// the list is a guess), a wake with no ledger line at all (an order typed by `prompt:session`) in which the seat nonetheless acts on a row, and a read of a row.

/** One block of an API message that calls a tool, whose command is `command`. */
const toolBlock = (timestamp, id, command) => JSON.stringify({
  type: "assistant", timestamp, requestId: `req_${id}`,
  message: { id, model: "claude-opus-5-5", role: "assistant", content: [{ type: "tool_use", id: `tu_${id}`, name: "Bash", input: { command } }], usage: usage(5, 50, 1000, 0) },
});

const PM_LEDGER = parseLedger(`${at("2026-10-04T12:28:00Z") - 1000}\tproduct-manager/row-call-count-signal/9001,9002`);
const PRODUCT_MANAGER = [
  wake("2026-10-04T12:28:00.000Z", "product-manager"),
  toolBlock("2026-10-04T12:28:10.000Z", "pm_1", "gh issue view 9002 --json labels; gh issue comment 9002 --body-file /tmp/ruling.md"),
  block("2026-10-04T12:28:20.000Z", "pm_2", "claude-opus-5-5", usage(5, 70, 1000, 0)),
  wake("2026-10-04T13:00:00.000Z", "product-manager", "orchestrator, #9003 STOPPED at done-when 3."), // no ledger line: typed by prompt:session
  toolBlock("2026-10-04T13:00:10.000Z", "pm_3", "gh issue edit 9004 --add-label lane:orchestrator && gh issue edit 9003 --add-blocked-by 9004"),
  toolBlock("2026-10-04T13:00:20.000Z", "pm_4", "gh issue view 9005 --json body"),
  toolBlock("2026-10-04T13:00:30.000Z", "pm_5", "cd /home/agent/repos/agent-org-wt-1 && gh pr comment 9100 --body x"),
  toolBlock("2026-10-04T13:00:35.000Z", "pm_7", "gh issue edit 9006 --repo a11ign/elsewhere --add-label x; gh issue edit 9007 -R a11ign/a11ign --add-label x; gh api -X POST repos/a11ign/a11ign/issues/9008/comments -f body=x"),
  toolBlock("2026-10-04T13:00:40.000Z", "pm_6", "gh pr review 9100 --approve"),
].join("\n");
const readPm = () => eventsOfTranscript({ text: PRODUCT_MANAGER, file: "pm.jsonl", ledger: PM_LEDGER, rowRepo: ROW_REPO });
const turnsAbout = (events, subject) => eventsForRow(events, subject).filter((event) => event.kind === "turn").map((event) => event.id);

test("PRODUCT-MANAGER: a key that names several rows puts the wake and its turns on EACH of them, and keeps row null", () => {
  assert.deepEqual(subjectsOf("product-manager/row-call-count-signal/9001,9002"), { rows: [9001, 9002] });
  assert.deepEqual(subjectsOf("orchestrator/pr-green-unarmed/9100,9101"), { prs: [9100, 9101] }, "a pull-request cause lists pull requests");
  for (const single of ["product-manager/row-call-count-signal/9001", "orchestrator/ready-row-unclaimed/9050", "ceo/org-health/order-deferred-too-long", "product-manager/answer-owed/row-9001"]) {
    assert.deepEqual(subjectsOf(single), {}, `${single} names one subject or none`);
  }
  assert.equal(subjectOf("product-manager/row-call-count-signal/9001,9002").row, null, "subjectOf still does not guess");
  const { events } = readPm();
  const wakes = events.filter((event) => event.kind === "wake");
  assert.deepEqual([wakes[0].row, wakes[0].rows], [null, [9001, 9002]]);
  assert.deepEqual(turnsAbout(events, { rows: [9001], prs: [] }), ["turn:pm_1", "turn:pm_2"], "the turns of the wake are on row 9001, which they were not before");
  assert.deepEqual(turnsAbout(events, { rows: [9002], prs: [] }).slice(0, 2), ["turn:pm_1", "turn:pm_2"]);
  assert.equal(eventsForRow(events, { rows: [9001], prs: [] }).some((event) => event.kind === "wake"), true, "so is the wake itself");
});

test("PRODUCT-MANAGER: a turn that WROTE to a row is on that row, whatever its wake named; a read, another repository's number and a `gh api` write are not", () => {
  const { events } = readPm();
  assert.deepEqual(turnsAbout(events, { rows: [9004], prs: [] }), ["turn:pm_3"], "the edit of 9004 is on 9004 though the order was about 9003");
  assert.deepEqual(turnsAbout(events, { rows: [9003], prs: [] }), ["turn:pm_3"], "and the edit of 9003 is on 9003");
  assert.deepEqual(turnsAbout(events, { rows: [9005], prs: [] }), [], "a `gh issue view` is not what ruled on a row");
  assert.deepEqual(turnsAbout(events, { rows: [9006], prs: [] }), [], "`--repo a11ign/elsewhere` is another repository's 9006");
  assert.deepEqual(turnsAbout(events, { rows: [9008], prs: [] }), [], "a `gh api` write is not read");
  assert.deepEqual(turnsAbout(events, { rows: [9007], prs: [] }), ["turn:pm_7"], "positive control: `-R` naming the primary repository is the primary's 9007");
  assert.deepEqual(turnsAbout(events, { rows: [], prs: [9100] }), ["turn:pm_6"], "a pull request: the review in the primary checkout counts, the comment run from an agent-org clone does not");
  const pm3 = events.find((event) => event.id === "turn:pm_3");
  assert.deepEqual([pm3.row, pm3.touchedRows], [null, [9003, 9004]]);
  assert.equal(touchesOf([], ROW_REPO) && Object.keys(touchesOf([], ROW_REPO)).length, 0, "a turn that wrote to nothing carries no field");
});

test("STORE: a corrected copy of an event supersedes the stored one by being APPENDED; an identical copy adds nothing; readStore takes the last copy of an id", () => {
  const path = join(mkdtempSync(join(tmpdir(), "trace-supersede-")), "events.ndjson");
  const before = readPm().events.find((event) => event.id === "turn:pm_1");
  const stale = { ...before, rows: undefined, touchedRows: undefined, row: null }; // the turn as stored before the attribution fix
  const store = openStore(path);
  assert.deepEqual(appendToStore(store, [stale]), { added: 1, superseded: 0, skipped: 0 });
  assert.deepEqual(appendToStore(store, [stale]), { added: 0, superseded: 0, skipped: 1 });
  assert.deepEqual(appendToStore(store, [before]), { added: 0, superseded: 1, skipped: 0 });
  assert.deepEqual(appendToStore(store, [before]), { added: 0, superseded: 0, skipped: 1 }, "identical to the correction now: nothing more");
  assert.equal(readFileSync(path, "utf8").split("\n").filter(Boolean).length, 2, "the log holds both copies: nothing on disk was rewritten");
  const reopened = readStore(path);
  assert.equal(reopened.length, 1);
  assert.deepEqual(reopened[0].touchedRows, before.touchedRows);
  assert.deepEqual(eventsForRow(reopened, { rows: [9002], prs: [] }).map((event) => event.id), ["turn:pm_1"]);
});

test("REPORT: the totals are per actor, a Codex reviewer is its own actor, and the footer says from when each KIND of actor is held", () => {
  const codex = { id: "codex-turn:r1", kind: "turn", source: "transcript", at: at("2026-10-04T11:00:00Z"), session: "reviewer-9100", row: null, pr: 9100, repo: null, cause: null, causeKey: null,
    wakeId: null, model: "gpt-5.6-luna", tokens: { input: 1, output: 40, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, costUsd: null, wallClockMs: null, harness: "codex" };
  const events = [...readPm().events, codex];
  const text = render({ number: 9100, rows: [], prs: [9100], events: eventsForRow(events, { rows: [9002], prs: [9100] }), held: events });
  assert.match(text, /per actor on this row:\n/);
  assert.match(text, /\n {2}product-manager\s+3 turns\s+\$0\.0041 over 3 priced\s+out 170\n/, "3 turns: the two of the several-row wake and the review of 9100");
  assert.match(text, /\n {2}reviewer-9100 \(codex\)\s+1 turns\s+\$0\.0000 over 0 priced\s+out 40\n/, "the Codex turn is unpriced and says so, and is not folded into a Claude reviewer");
  assert.match(text, /reviewer \(codex\)\s+held from 2026-10-04T11:00Z/);
  assert.match(text, /product-manager\s+held from 2026-10-04T12:28Z/);
  assert.doesNotMatch(text, /NOT IN THIS STORE YET[^\n]*Codex/);
});

// STORED BEFORE ITS PRICE (#3638): the per-row and per-pull-request totals and the repricing function the readers share.
const storedTurn = (id, model, costUsd, extra = {}) => ({ id, kind: "turn", source: "transcript", at: at("2026-10-04T11:00:00Z"), session: "reviewer-9100", row: null, pr: 9100, repo: null, cause: null, causeKey: null,
  wakeId: null, model, tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, costUsd, wallClockMs: null, ...extra });

test("REPRICED: repriceEvents prices from PRICES now, never from the line, and leaves a model with no price null and every other event alone", () => {
  const late = storedTurn("turn:late", "claude-sonnet-5", null);
  const wrong = storedTurn("turn:wrong", "claude-sonnet-5", 99);
  const codex = storedTurn("codex-turn:r1", "gpt-5.6-luna", null, { harness: "codex" });
  const synthetic = storedTurn("turn:syn", "<synthetic>", null);
  const wake = { id: "wake:1", kind: "wake", source: "wake-ledger", at: 1, session: "x", row: null, pr: null, repo: null, cause: null, causeKey: null, wakeId: "wake:1" };
  const [a, b, c, d, e] = repriceEvents([late, wrong, codex, synthetic, wake]);
  assert.equal(a.costUsd, (1000 * 2 + 500 * 10) / 1e6, "priced since: the Sonnet 5 row did not exist when this line was written");
  assert.equal(b.costUsd, a.costUsd, "the stored 99 is not trusted over PRICES");
  assert.equal(c.costUsd, null, "no Codex rate is sourced: null, never 0");
  assert.equal(d.costUsd, null);
  assert.equal(e, wake, "not a turn: returned as it came");
  assert.equal(late.costUsd, null, "the input is not mutated: the store stays as it was written");
  const same = storedTurn("turn:same", "claude-sonnet-5", a.costUsd);
  assert.equal(repriceEvents([same])[0], same, "a turn already at PRICES is the same object");
});

test("REPRICED: a changed price in PRICES moves a turn stored at the old one", () => {
  const row = PRICES.find((price) => price.prefix === "claude-opus-5");
  const was = row.output;
  const stored = storedTurn("turn:opus", "claude-opus-5", costOf("claude-opus-5", storedTurn("x", "x", null).tokens));
  try {
    row.output = was * 2;
    assert.equal(repriceEvents([stored])[0].costUsd, (1000 * 5 + 500 * 50) / 1e6);
  } finally {
    row.output = was;
  }
  assert.equal(repriceEvents([stored])[0].costUsd, stored.costUsd);
});

test("REPRICED: the report prints a turn stored null at its price (per line and per actor), and the Codex turn beside it is still $? and unpriced", () => {
  const events = [storedTurn("turn:late", "claude-sonnet-5", null), storedTurn("codex-turn:r1", "gpt-5.6-luna", null, { harness: "codex", at: at("2026-10-04T11:05:00Z") })];
  const text = render({ number: 9100, rows: [], prs: [9100], events, held: events });
  assert.match(text, /turn\s+\?\s+\$0\.0070\s.*claude-sonnet-5\n/, "the line shows dollars");
  assert.match(text, /turn\s+\?\s+\$\?\s.*gpt-5\.6-luna\n/, "the Codex line stays unpriced");
  assert.match(text, /\n {2}reviewer-9100\s+1 turns\s+\$0\.0070 over 1 priced\s+out 500\n/);
  assert.match(text, /\n {2}reviewer-9100 \(codex\)\s+1 turns\s+\$0\.0000 over 0 priced\s+out 500\n/);
});

test("REPRICED: the waterfall's dollars are at PRICES too (a turn stored null of a model priced since is in them, a Codex turn is counted unpriced)", () => {
  const events = [storedTurn("turn:late", "claude-sonnet-5", null), storedTurn("codex-turn:r1", "gpt-5.6-luna", null, { harness: "codex" })];
  const [{ waterfall: drawn }] = waterfallsOf({ rows: [], prs: [9100], number: 9100, events, now: at("2026-10-05T00:00:00Z") });
  assert.equal(drawn.spend.dollars, (1000 * 2 + 500 * 10) / 1e6);
  assert.deepEqual([drawn.spend.priced, drawn.spend.unpriced], [1, 1]);
});

/** A `gh api` that counts what reaches it, and answers a search, the open-issue list, an issue and an empty timeline the way GitHub does. */
function listingGh({ merged = [], open = [] } = {}) {
  const seen = [];
  const gh = (args) => {
    seen.push(args.join(" "));
    const field = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
    const page = Number(field("page") ?? 1);
    const slice = (list) => list.slice((page - 1) * 100, page * 100);
    if (args.includes("search/issues")) return { total_count: merged.length, items: slice(merged) };
    if (args.some((arg) => /\/issues$/.test(arg))) return slice(open);
    if (/\/timeline\?/.test(args[0])) return [];
    return { created_at: "2026-09-29T10:00:00Z", user: { login: "someone" } };
  };
  return Object.assign(gh, { seen });
}
const mergedItem = (number, body = "") => ({ number, created_at: "2026-09-29T09:00:00Z", body, pull_request: { merged_at: "2026-09-29T11:00:00Z" } });

test("BUDGET: the (budget+1)th call is refused BEFORE it is made, every call is counted, and the refusal says why", () => {
  const underlying = listingGh();
  const bounded = budgetedGh({ gh: underlying, budget: 2 });
  bounded(["a"]);
  bounded(["b"]);
  assert.throws(() => bounded(["c"]), { code: "GH_CALLS_SPENT", message: /--calls 2 is spent/ });
  assert.deepEqual(underlying.seen, ["a", "b"], "the third call never reached gh");
  assert.equal(bounded.calls, 2);
  const failing = budgetedGh({ gh: () => { throw new Error("HTTP 500"); }, budget: 5 });
  assert.throws(() => failing(["x"]), /HTTP 500/);
  assert.equal(failing.calls, 1, "a call that failed was still a call");
});

test("BUDGET: --calls 0 makes NO gh call at all, and says the list of merged pull requests cannot be had rather than printing smaller weeks", () => {
  const underlying = listingGh({ merged: [mergedItem(1)] });
  const gh = budgetedGh({ gh: underlying, budget: 0 });
  assert.throws(() => readListings({ repos: ["a11ign/a11ign"], rowRepo: "a11ign/a11ign", window: { from: at("2026-09-28T00:00:00Z"), to: at("2026-10-05T00:00:00Z") }, gh, budget: 0 }),
    (error) => /--calls 0 is too small to list the merged pull requests \(0 made\)/.test(error.message) && error.cause.code === "GH_CALLS_SPENT");
  assert.deepEqual(underlying.seen, [], "not the merged-PR search, not the open-row list");
});

test("BUDGET: the merged-PR search and the open-row list are COUNTED, page by page; a budget spent before the open rows leaves them unknown, not empty", () => {
  const merged = Array.from({ length: 150 }, (_, index) => mergedItem(index + 1, `Closes a11ign/a11ign#${1000 + index}`));
  const open = [{ number: 7 }, { number: 8, pull_request: {} }, { number: 9 }];
  const window = { from: at("2026-09-28T00:00:00Z"), to: at("2026-10-05T00:00:00Z") };
  const whole = listingGh({ merged, open });
  const gh = budgetedGh({ gh: whole, budget: 10 });
  const listings = readListings({ repos: ["a11ign/a11ign"], rowRepo: "a11ign/a11ign", window, gh, budget: 10 });
  assert.equal(listings.pulls.length, 150, "both pages of the search");
  assert.deepEqual(listings.pulls[0], { repo: "a11ign/a11ign", number: 1, createdAt: "2026-09-29T09:00:00Z", mergedAt: "2026-09-29T11:00:00Z", body: "Closes a11ign/a11ign#1000" });
  assert.deepEqual(listings.openRows, [7, 9], "a pull request the issues endpoint lists is not an open row");
  assert.equal(gh.calls, 3, "two search pages and one issues page, each a counted call");
  const tight = listingGh({ merged, open });
  const short = readListings({ repos: ["a11ign/a11ign"], rowRepo: "a11ign/a11ign", window, gh: budgetedGh({ gh: tight, budget: 2 }), budget: 2 });
  assert.equal(short.pulls.length, 150);
  assert.equal(short.openRows, null, "unknown is null (printed `not asked`), never an empty list that calls nothing open");
  assert.equal(tight.seen.length, 2);
});

test("BUDGET: a search that holds more than GitHub returns is REFUSED, not cut short; and a list on one page is read in one call", () => {
  const window = { from: at("2026-09-14T00:00:00Z"), to: at("2026-10-05T00:00:00Z") };
  const cap = Array.from({ length: 1000 }, (_, index) => mergedItem(index + 1));
  const fits = listingGh({ merged: cap });
  assert.equal(listMergedPulls({ repo: "a11ign/a11ign", window, gh: fits }).length, 1000, "exactly the cap is all of it");
  const over = (args) => ({ total_count: 1001, items: listingGh({ merged: cap })(args).items });
  assert.throws(() => listMergedPulls({ repo: "a11ign/a11ign", window, gh: over }), /more merged pull requests since 2026-09-14T00:00:00.000Z than GitHub's search returns \(1000\).*narrow --since/);
  const one = listingGh({ open: [{ number: 3 }] });
  assert.deepEqual(listOpenRows({ rowRepo: "a11ign/a11ign", gh: one }), [3]);
  assert.equal(one.seen.length, 1);
});

test("BUDGET: a pull request costs several calls, and the budget is checked per CALL: it is never overshot, and what it cut off is named unread", () => {
  const pull = (repo, number, row, mergedAt) => ({ repo, number, createdAt: "2026-09-29T09:00:00Z", mergedAt, body: `Closes a11ign/a11ign#${row}` });
  const pulls = [pull("a11ign/a11ign", 30, 3, "2026-09-29T13:00:00Z"), pull("a11ign/agent-org", 10, 1, "2026-09-29T11:00:00Z"), pull("a11ign/a11ign", 20, 2, "2026-09-29T12:00:00Z")];
  const underlying = listingGh();
  const gh = budgetedGh({ gh: underlying, budget: 5 });
  const { events, unreadRows } = githubEventsOfMerged({ pulls, rowRepo: "a11ign/a11ign", held: [], gh });
  assert.equal(gh.calls, 5, "exactly the budget: the sixth call was refused before it was made");
  assert.equal(underlying.seen.length, 5);
  assert.deepEqual(unreadRows, [2, 3], "the oldest merge was read whole (its pull request, 2 calls, and its row, 2); the next stopped at its timeline, and nothing after it was tried");
  assert.deepEqual(events.map((event) => [event.id, event.repo]), [
    ["gh:a11ign/agent-org#10:opened:once", "agent-org"],
    ["gh:a11ign/a11ign#1:filed:once", null],
  ], "what finished is kept, a keyed repository's pull request carries its short name, and the cut-off subject stores nothing");
});

test("BUDGET: a failure that is not the budget is not swallowed, and a pull request the store already holds costs no call", () => {
  const pulls = [{ repo: "a11ign/a11ign", number: 20, createdAt: "2026-09-29T09:00:00Z", mergedAt: "2026-09-29T12:00:00Z", body: "Closes a11ign/a11ign#2" }];
  const broken = budgetedGh({ gh: () => { throw new Error("HTTP 502"); }, budget: 50 });
  assert.throws(() => githubEventsOfMerged({ pulls, rowRepo: "a11ign/a11ign", held: [], gh: broken }), /HTTP 502/);
  const held = [{ kind: "merged", pr: 20, repo: null }, { kind: "closed", row: 2 }];
  const idle = budgetedGh({ gh: listingGh(), budget: 0 });
  assert.deepEqual(githubEventsOfMerged({ pulls, rowRepo: "a11ign/a11ign", held, gh: idle }), { events: [], unreadRows: [] }, "nothing to read, so even a budget of 0 reads and marks nothing");
});

test("GH LEDGER (#3516): the run reads the gh ledgers after the transcripts, keys the calls to the turns it just read, and a second run reads nothing; the report summarises the calls and prints none", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-gh-ledger-"));
  mkdirSync(join(dir, "projects", "p"), { recursive: true });
  writeFileSync(join(dir, "projects", "p", "worker-9001.jsonl"), WORKER);
  const shell = "/usr/bin/zsh -c source /home/agent/.claude/shell-snapshots/snapshot-zsh-1791154712872-8w57yj.sh 2>/dev/null || true";
  // The id on a line is the transcript's file name (`CLAUDE_CODE_SESSION_ID`), here `worker-9001`; a line with no id is a unit's or one of before the wrapper wrote it.
  const call = (time, resource, cost, id = "worker-9001") => ["2026-10-04T" + time + "Z", "a11ign-ai-workers", resource, cost, 0, "issue view", "w1AX", shell, ...(id ? [id] : [])].join("\t");
  const ledgerFile = join(dir, "gh-calls.tsv");
  // msg_1 ended 10:00:08 and msg_2 at 10:00:30: both calls after the first and before the second name the session. The third is after every turn (the last, msg_3, is at 11:00:09), and the id-less one is never joined by time.
  writeFileSync(ledgerFile, `${[call("10:00:15", "graphql", 3), call("10:00:15", "graphql?", ""), call("11:30:00", "core", ""), call("10:00:15", "graphql", "", null)].join("\n")}\n`);
  const input = { root: join(dir, "projects"), since: 0, ledger: LEDGER, rowRepo: ROW_REPO, storePath: join(dir, "events.ndjson"), ghLedgers: [ledgerFile], now: at("2026-10-04T12:00:00Z") };
  const first = ingestTranscripts(input);
  assert.deepEqual([first.report.ghCalls.added, first.report.ghCalls.calls], [4, 4]);
  const calls = first.store.events.filter((event) => event.kind === "gh_call");
  assert.deepEqual(calls.map((event) => [event.row, event.keyedBy, event.unkeyed]), [[9001, "session", undefined], [9001, "session", undefined], [null, null, "no-turn"], [null, null, "script"]], "keyed to the turn the transcript pass JUST read: the order of the two passes is the join");
  const second = ingestTranscripts({ ...input, storePath: input.storePath });
  assert.deepEqual([second.report.ghCalls.added, second.report.ghCalls.read, second.report.ghCalls.unchanged, second.report.read], [0, 0, 1, 0], "one state holds both: nothing is read twice");
  const text = render({ number: 9001, rows: [9001], prs: [], events: eventsForRow(second.store.events, { rows: [9001], prs: [] }), ingest: second.report, held: second.store.events });
  assert.match(text, /GH CALLS keyed to this row.*: 2 calls: 2 on the GraphQL pool = 4 points \(3 read from responses, 1 calls FLOOR/);
  assert.match(text, /GH CALLS KEYED TO NO ROW.*\(2 of the store's 4 are keyed\): 2 calls/);
  assert.match(text, /gh ledgers: 0 read .*1 unchanged/);
  assert.doesNotMatch(text, /gh-ledger {2,}/, "a call is summarised, never one line of the trace");
  assert.match(text, /6 events \(0 from GitHub\), 3 turns across 1 sessions \(worker-9001\)/, "and a call is not an event of the row's listing, a turn, or a session: `gh-ledger` is a source");
});

const DEFERRED_PR = "orchestrator/pr-review-blocked/pr-9100";
const SPAN = { key: DEFERRED_PR, startMs: at("2026-10-04T10:31:00Z"), endMs: at("2026-10-04T10:43:03Z"), how: /** @type {const} */ ("delivered") };

test("DEFERRAL (#3510): a span is keyed by its cause key's pull request (subjectOf), joined to the row through the pull request, and read twice is one event", () => {
  const [event] = eventsOfDeferrals([SPAN], ROW_REPO);
  assert.deepEqual([event.kind, event.source, event.session, event.pr, event.row, event.at, event.startedAt, event.how], ["deferral", "deferral-log", "orchestrator", 9100, null, SPAN.endMs, SPAN.startMs, "delivered"]);
  assert.deepEqual(eventsForRow([event], { rows: [9001], prs: [9100] }), [event], "the pull request that closes the row carries it");
  assert.deepEqual(eventsForRow([event], { rows: [9001], prs: [] }), [], "a row alone does not reach a pull request's wait, as for every pull request event");
  assert.equal(eventsOfDeferrals([{ ...SPAN, key: "worker-9001/blocker-cleared/x" }], ROW_REPO)[0].row, 9001, "a key that names nothing falls back to the session's name, as a wake does");
  const store = openStore(join(mkdtempSync(join(tmpdir(), "trace-deferral-id-")), "events.ndjson"));
  assert.equal(appendToStore(store, [event, ...eventsOfDeferrals([SPAN], ROW_REPO)]).added, 1, "the id is the key and the start: a line appended twice by a killed tick is one event");
});

test("DEFERRAL (#3510): the log is ingested INCREMENTALLY through the ingest state: a second run reads nothing, an appended span reads only the new bytes, and a bad line fails the file and moves nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-deferral-"));
  const logFile = join(dir, DEFERRAL_LOG_FILE);
  const store = openStore(join(dir, "events.ndjson"));
  const state = { version: 2, firstRunAt: 0, firstRunSince: 0, storeBytes: 0, files: {} };
  const run = (/** @type {any} */ from) => ingestDeferrals({ logs: [logFile], rowRepo: ROW_REPO, store, state: from, now: at("2026-10-04T12:00:00Z") });
  assert.deepEqual(run(state).report.absent, [logFile], "no log is ABSENT, never an empty one");
  writeFileSync(logFile, deferralLogText([SPAN]));
  const first = run(state);
  assert.deepEqual([first.report.read, first.report.spans, first.report.added], [1, 1, 1]);
  const second = run(first.state);
  assert.deepEqual([second.report.read, second.report.unchanged, second.report.spans], [0, 1, 0], "nothing is read twice");
  const later = { key: "orchestrator/ready-queue-empty/x", startMs: SPAN.endMs, endMs: SPAN.endMs + 60_000, how: /** @type {const} */ ("gone") };
  writeFileSync(logFile, deferralLogText([SPAN, later]));
  const third = run(second.state);
  assert.deepEqual([third.report.spans, third.report.added, third.report.reread], [1, 1, []], "only the span the log gained");
  writeFileSync(logFile, `${deferralLogText([SPAN, later])}${later.key}\tnot-a-number\t1\tgone\n`);
  const bad = run(third.state);
  assert.equal(bad.report.failed.length, 1);
  assert.match(bad.report.failed[0], /has a line that is not "<causeKey>/);
  assert.deepEqual(bad.state.files, third.state.files, "the state does not move past a line that could not be read");
  writeFileSync(logFile, deferralLogText([later]));
  assert.match(run(third.state).report.reread[0], /shrank|first bytes changed/, "a log that shrank is read again from byte 0, and SAID");
});

test("DEFERRAL (#3510): through ingestTranscripts the same state holds the transcripts and the log, and the report prints the span the two events join and keeps naming what is unrecorded", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-deferral-run-"));
  mkdirSync(join(dir, "projects", "p"), { recursive: true });
  writeFileSync(join(dir, "projects", "p", "orchestrator.jsonl"), ORCHESTRATOR);
  const logFile = join(dir, DEFERRAL_LOG_FILE);
  writeFileSync(logFile, deferralLogText([SPAN]));
  const input = { root: join(dir, "projects"), since: 0, ledger: LEDGER, rowRepo: ROW_REPO, storePath: join(dir, "events.ndjson"), deferralLogs: [logFile], now: at("2026-10-04T12:00:00Z") };
  assert.equal(ingestTranscripts(input).report.deferrals.added, 1);
  const second = ingestTranscripts(input);
  assert.deepEqual([second.report.deferrals.read, second.report.deferrals.unchanged, second.report.read], [0, 1, 0]);
  const text = render({ number: 9100, rows: [9001], prs: [9100], events: eventsForRow(second.store.events, { rows: [9001], prs: [9100] }), ingest: second.report, held: second.store.events });
  assert.match(text, /2026-10-04 10:43:03 {2}orchestrator +DEFERRED orchestrator\/pr-review-blocked\/pr-9100 {2}waited 12m03s \(from 2026-10-04 10:31:00Z\), delivered/);
  assert.match(text, /deferral logs: 0 read, 1 unchanged/);
  assert.match(text, /DEFERRAL SPANS HELD: 1 ended waits, the earliest started 2026-10-04 10:31Z; a wait before the first tick that wrote the log is unrecorded/);
  const alone = render({ number: 9100, rows: [9001], prs: [9100], events: [], held: eventsOfDeferrals([SPAN], ROW_REPO) });
  assert.doesNotMatch(alone, /orchestrator +held from/, "a deferral is not a transcript: a store holding only one has no actor `held from`");
  assert.match(alone, /DEFERRAL SPANS HELD: 1 ended waits/);
  const empty = render({ number: 9100, rows: [9001], prs: [9100], events: [], held: [] });
  assert.match(empty, /DEFERRAL SPANS HELD: none in the store yet/);
});

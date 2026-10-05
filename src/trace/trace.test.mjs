// a11ign/a11ign#3494: the trace store, first slice. Fixtures only: nothing here reads `~/.claude`, `~/.cache/a11ign` or GitHub.
// no-token: gh -- every source is an injected fixture; the only `gh` calls in the slice are in `resolveSubject`, which no test here calls
// The records are in the shapes measured on 2026-10-04: an `assistant` record per content block sharing one `message.id`, `usage.cache_creation` split by TTL, and a
// `user` record wrapped in `<pasted_content` for a delivered order.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseLedger } from "../wakes-per-row.mjs";
import { appendEvents, appendToStore, costOf, eventsForRow, eventsOfTranscript, openStore, PRICES, readStore, subjectOf, subjectsOf, tokensOf, touchesOf } from "./store.mjs";
import { weekStart } from "./aggregate.mjs";
import { budgetedGh, githubEventsOfMerged, ingestTranscripts, isAggregate, listMergedPulls, listOpenRows, NOT_HELD, parseAggregateArgs, parseArgs, readListings, render, resolveSubject } from "./trace.mjs";

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

test("ARGS: the row is required and `--` is tolerated", () => {
  assert.equal(parseArgs(["--", "3406"]).number, 3406);
  assert.equal(parseArgs(["3406", "--json", "1"]).json, true);
  assert.throws(() => parseArgs(["--", "abc"]), /usage: trace/);
  assert.throws(() => parseArgs([]), /usage: trace/);
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

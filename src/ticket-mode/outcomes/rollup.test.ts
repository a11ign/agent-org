// no-token: none -- the outcome log and the host file are scratch files; nothing reads a tracker, GitHub or a transcript
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../../lib/tmp-fixture.ts";
import { PRICES } from "../../trace/prices.ts";
import { appendOutcome, outcomeRecordOf, outcomesPath, type OutcomeRecord, type OutcomeReview, type OutcomeRound } from "./outcome-record.ts";
import { PRICED_AT, pricesOf } from "./prices-config.ts";
import { rollupOf } from "./rollup.ts";
import { outcomesAnswer, windowOf } from "./route.ts";
import { passedOn } from "../remote-proxy.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-14T12:00:00Z");
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const MILLION = 1_000_000;

/** `input` million input tokens and `output` million output tokens of `model`. */
const spent = (model: string, input: number, output: number) => ({ [model]: { input: input * MILLION, output: output * MILLION, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } });
const round = (at: number, outcome: string, tokens?: ReturnType<typeof spent>): OutcomeRound => ({ startedAt: at - 1, endedAt: at, outcome, ...(tokens === undefined ? { unread: "missing" } : { tokens }) });
const review = (pr: string, verdict: string, at: number, tokens?: ReturnType<typeof spent>): OutcomeReview => ({ pr, head: `h${at}`, verdict, posted: at, at, ...(tokens === undefined ? { unread: "missing" } : { tokens }) });

type Run = Readonly<{ ticket: string; model: string; effort: string; labels: readonly string[]; prs: readonly string[]; rounds: readonly OutcomeRound[]; reviews?: readonly OutcomeReview[] }>;
const record = ({ ticket, model, effort, labels, prs, rounds, reviews }: Run): OutcomeRecord =>
  outcomeRecordOf({ ticket, model, effort, repos: ["agent-org"], labels, prs }, { since: rounds[0].endedAt - 1, rounds, ...(reviews === undefined ? {} : { reviews }) });

/** Three runs on opus/high and one on sonnet/medium in agent-org this week, and one opus run of three weeks ago. */
const WEEK: readonly OutcomeRecord[] = [
  // opus/high, one pull request, approved at its first review, one round: $4 + $20 of Claude, $0.02 + $0.12 of the reviewer (gpt-5.6-luna is priced only up to a 272K prompt).
  record({ ticket: "A11-1", model: "opus", effort: "high", labels: ["Feature"], prs: ["pr/1"], rounds: [round(NOW - DAY, "ready-pr", spent(OPUS, 1, 1))],
    reviews: [review("pr/1", "convinced", NOW - DAY + 1, spent("gpt-5.6-luna", 0.1, 0.1))] }),
  // opus/high, one pull request, blocked first and approved on the re-review: three rounds, one of which asked a person.
  record({ ticket: "A11-2", model: "opus", effort: "high", labels: ["Bug"], prs: ["pr/2"],
    rounds: [round(NOW - 3 * DAY, "needs-human", spent(OPUS, 1, 0)), round(NOW - 2 * DAY, "ready-pr", spent(OPUS, 1, 0)), round(NOW - DAY, "ready-pr", spent(OPUS, 1, 0))],
    reviews: [review("pr/2", "not-convinced", NOW - 2 * DAY + 1, spent("gpt-5.6-luna", 0.1, 0)), review("pr/2", "convinced", NOW - DAY + 1, spent("gpt-5.6-luna", 0.1, 0))] }),
  // opus/high, a plan: no pull request and no review.
  record({ ticket: "A11-3", model: "opus", effort: "high", labels: [], prs: [], rounds: [round(NOW - 4 * DAY, "planned", spent(OPUS, 1, 0))] }),
  // sonnet/medium, two pull requests, one round whose transcript could not be read: its dollars are a floor.
  record({ ticket: "A11-4", model: "sonnet", effort: "medium", labels: ["Bug"], prs: ["pr/4a", "pr/4b"], rounds: [round(NOW - 5 * DAY, "ready-pr", spent(SONNET, 1, 0)), round(NOW - 4 * DAY, "ready-pr")],
    reviews: [review("pr/4a", "convinced", NOW - 4 * DAY + 1, spent("gpt-5.6-luna", 0.1, 0))] }),
  // Three weeks ago: outside the window.
  record({ ticket: "A11-5", model: "opus", effort: "high", labels: ["Bug"], prs: ["pr/5"], rounds: [round(NOW - 21 * DAY, "ready-pr", spent(OPUS, 9, 9))] }),
];

/** Dollars to the cent, so a sum of floats compares. */
const cents = (usd: number): number => Math.round(usd * 100);

const LAST_WEEK = { from: NOW - 7 * DAY, to: NOW };

test("A11-430: the week's runs add up by model and effort: cost, rounds per pull request, first-pass approval and Needs-you rates, each with the runs behind it", () => {
  const view = rollupOf(WEEK, LAST_WEEK, pricesOf(undefined), PRICED_AT);
  const byModel = Object.fromEntries(view.byModel.map((group) => [group.key, group]));
  assert.deepEqual(Object.keys(byModel), ["opus/high", "sonnet/medium"], "the run of three weeks ago is outside the window");
  const opus = byModel["opus/high"];
  assert.deepEqual(opus.runs, [`A11-1@${NOW - DAY - 1}`, `A11-2@${NOW - 3 * DAY - 1}`, `A11-3@${NOW - 4 * DAY - 1}`]);
  assert.deepEqual([cents(opus.cost.usd), opus.cost.floor], [cents(4 + 20 + 3 * 4 + 4 + 0.14 + 0.02 + 0.02), false], "every round and review of the three runs, at Opus 5.5's and gpt-5.6-luna's prices");
  assert.equal(cents(opus.reviewerCost.usd), cents(0.14 + 0.02 + 0.02));
  assert.deepEqual([opus.roundsPerPr.value, opus.roundsPerPr.runs.length], [(1 + 3) / 2, 2], "the plan opened no pull request, so it is not in the figure");
  assert.deepEqual([opus.firstPass.value, opus.firstPass.runs, opus.firstPass.of.length], [1 / 2, [opus.runs[0]], 2], "A11-1 approved at once; A11-2 blocked first");
  assert.deepEqual([opus.needsYou.value, opus.needsYou.runs], [1 / 3, [opus.runs[1]]]);
  const sonnet = byModel["sonnet/medium"];
  assert.deepEqual([cents(sonnet.cost.usd), sonnet.cost.floor], [cents(2 + 0.02), true], "a round whose tokens could not be read makes the dollars a floor");
  assert.deepEqual([sonnet.roundsPerPr.value, sonnet.firstPass.value, sonnet.needsYou.value], [2 / 2, 1, 0]);
  assert.equal(view.pricedAt, "at configured prices");
});

test("A11-430: a run is in each of its labels' groups and its repositories', and one with no label is in the none group", () => {
  const view = rollupOf(WEEK, LAST_WEEK, pricesOf(undefined), PRICED_AT);
  assert.deepEqual(view.byLabel.map(({ key, runs }) => [key, runs.length]), [["Feature", 1], ["Bug", 2], ["(none)", 1]]);
  assert.deepEqual(view.byRepo.map(({ key, runs }) => [key, runs.length]), [["agent-org", 4]]);
});

test("A11-430: a model the configured prices leave out has no price, so the dollars are a floor, never a neighbour's rate", () => {
  const onlySonnet = pricesOf([{ prefix: "claude-sonnet", input: 2, output: 10, cacheRead: 0.1 }]);
  const opus = rollupOf(WEEK, LAST_WEEK, onlySonnet, PRICED_AT).byModel[0];
  assert.deepEqual([opus.key, opus.cost.usd, opus.cost.floor], ["opus/high", 0, true]);
});

test("A11-430: the prices default to the trace's published table, and a row the host file names is checked, naming the field", () => {
  assert.deepEqual(pricesOf(undefined).map(({ prefix, model }) => prefix ?? model), PRICES.map(({ prefix, model }) => prefix ?? model));
  assert.throws(() => pricesOf({}), /`tickets.prices` in the host file must be a list/);
  assert.throws(() => pricesOf([{ input: 1, output: 1, cacheRead: 1 }]), /`tickets.prices\[0\]` .* exactly one of prefix .* or model/);
  assert.throws(() => pricesOf([{ prefix: "a", model: "b", input: 1, output: 1, cacheRead: 1 }]), /exactly one of prefix/);
  assert.throws(() => pricesOf([{ model: "m", input: -1, output: 1, cacheRead: 1 }]), /`tickets.prices\[0\].input`/);
  assert.throws(() => pricesOf([{ model: "m", input: 1, output: 1, cacheRead: 1, maxPrompt: 0.5 }]), /`tickets.prices\[0\].maxPrompt`/);
});

/** A state folder with the week's log and a host file naming `prices`, or none. */
function board(prices?: unknown) {
  const stateDir = tmpDir("outcomes-route-");
  for (const each of WEEK) appendOutcome(outcomesPath(stateDir), each);
  const hostPath = join(stateDir, "host.json");
  writeFileSync(hostPath, JSON.stringify({ schema: 1, tickets: prices === undefined ? {} : { prices } }));
  return { stateDir, hostPath, now: NOW };
}

test("A11-430: a price changed in the host file is the price of the next read, and every dollar figure says it is at configured prices", () => {
  const reads = board();
  const [status, view] = outcomesAnswer(reads, new URLSearchParams()) as [number, ReturnType<typeof rollupOf>];
  assert.equal(status, 200);
  const opusBefore = view.byModel[0].cost.usd;
  writeFileSync(reads.hostPath, JSON.stringify({ schema: 1, tickets: { prices: [{ prefix: "claude-opus-5-5", input: 8, output: 40, cacheRead: 0.4 }, { model: "gpt-5.6-luna", input: 0.2, output: 1.2, cacheRead: 0.02 }] } }));
  const [, after] = outcomesAnswer(reads, new URLSearchParams()) as [number, ReturnType<typeof rollupOf>];
  assert.equal(cents(after.byModel[0].cost.usd - after.byModel[0].reviewerCost.usd), cents(2 * (opusBefore - view.byModel[0].reviewerCost.usd)), "Opus at twice the price costs twice as much");
  assert.equal(after.pricedAt, "at configured prices");
});

test("A11-430: the window is the query's, a week to now by default; a query that is not a window is a 400, and an unreadable log or price table a 500 naming it", () => {
  assert.deepEqual(windowOf(new URLSearchParams(), NOW), { from: NOW - 7 * DAY, to: NOW });
  assert.deepEqual(windowOf(new URLSearchParams({ from: "2026-11-01", to: String(NOW) }), NOW), { from: Date.parse("2026-11-01"), to: NOW });
  const reads = board();
  const [, wide] = outcomesAnswer(reads, new URLSearchParams({ from: String(NOW - 30 * DAY) })) as [number, ReturnType<typeof rollupOf>];
  assert.equal(wide.runs.length, 5, "a month reaches the run of three weeks ago");
  assert.equal(outcomesAnswer(reads, new URLSearchParams({ from: "soon" }))[0], 400);
  assert.equal(outcomesAnswer(reads, new URLSearchParams({ from: String(NOW), to: String(NOW - 1) }))[0], 400);
  assert.deepEqual(outcomesAnswer(board([{ input: 1 }]), new URLSearchParams()), [500, { error: "ticket mode: `tickets.prices[0]` in the host file must name exactly one of prefix (the start of a Claude model id) or model (any other model's exact name)" }]);
  appendFileSync(outcomesPath(reads.stateDir), "not a record\n");
  const [status, answer] = outcomesAnswer(reads, new URLSearchParams());
  assert.deepEqual([status, (answer as { error: string }).error], [500, `line 6 of the outcome log ${outcomesPath(reads.stateDir)} is not JSON`], "an unreadable log is an error, not empty");
});

test("A11-430: the page's proxy passes on the read of the outcomes, and no write to it", () => {
  assert.equal(passedOn("GET", "/api/outcomes"), true);
  assert.equal(passedOn("POST", "/api/outcomes"), false);
});

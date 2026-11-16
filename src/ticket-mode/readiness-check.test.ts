// no-token: gh -- pure functions over hand-made outcome records and run logs, and the checked-in check result; no model is asked
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { OutcomeRecord } from "./outcomes/outcome-record.ts";
import type { RunEvent } from "./queue/run-log.ts";
import { historiesOf, LINK_RATIO, linkOf, MAX_SET, MIN_PER_GROUP, pickSet, publicResultOf, verdictOf, type CheckedTicket, type CheckResult, type PublicResult } from "./readiness-check.ts";
import { SCHEMA } from "./config-schema.ts";
import { DEFAULT_READINESS, parseTicketSettings } from "./settings.ts";

/** A run's record: `rounds` rounds ending in `outcomes` (the last repeated), `needsYou` of them handed to a person. */
const record = (ticket: string, since: number, rounds: number, needsYou = 0, at = since + 1): OutcomeRecord => ({
  v: 1, run: `${ticket}@${since}`, ticket, at, model: "opus", effort: "high", repos: ["agent-org"], labels: [],
  rounds: Array.from({ length: rounds }, (_, index) => ({ startedAt: since + index, endedAt: since + index + 1, outcome: "reviewed" })),
  final: "reviewed", needsYou, wallMs: 1, tokens: {},
});

const replan: RunEvent = { kind: "requeued", why: "replan", at: 1 };
const nextStep: RunEvent = { kind: "requeued", why: "next-step", at: 2 };

/** A checked ticket with `rounds` rounds over one run. */
const ticket = (key: string, score: number | null, rounds: number, extra: Partial<CheckedTicket> = {}): CheckedTicket => ({ ticket: key, runs: 1, rounds, needsYou: 0, replans: 0, score, ...extra });

test("A11-443: a ticket's history adds up the rounds and Needs-you of each run's latest record, and counts its re-plans from the run log", () => {
  const records = [record("A11-1", 100, 1), record("A11-1", 100, 3, 1, 500), record("A11-1", 900, 2), record("A11-2", 200, 1)];
  const histories = historiesOf(records, { "A11-1": [replan, nextStep, replan], "A11-9": [replan] });
  assert.deepEqual(histories.get("A11-1"), { ticket: "A11-1", runs: 2, rounds: 5, needsYou: 1, replans: 2 }, "the run's earlier line is replaced by its latest");
  assert.deepEqual(histories.get("A11-2"), { ticket: "A11-2", runs: 1, rounds: 1, needsYou: 0, replans: 0 });
  assert.equal(histories.has("A11-9"), false, "a ticket with no outcome record says nothing about how its runs went");
});

test("A11-443: the set is the tickets whose first recorded run is oldest, at most 10, picked by when they ran and never by how", () => {
  assert.equal(MAX_SET, 10);
  const records = [record("A11-3", 300, 9, 2), record("A11-1", 100, 1), record("A11-2", 200, 1), record("A11-1", 50, 1)];
  assert.deepEqual(pickSet(records), ["A11-1", "A11-2", "A11-3"]);
  assert.deepEqual(pickSet(records, 2), ["A11-1", "A11-2"]);
  const many = Array.from({ length: 12 }, (_, index) => record(`A11-${100 + index}`, 1000 - index, 1));
  assert.equal(pickSet(many).length, 10);
  assert.equal(pickSet(many)[0], "A11-111", "oldest first");
});

test("A11-443: low scores going with more rounds per run, on enough tickets each side, meet the bar", () => {
  assert.equal(MIN_PER_GROUP, 3);
  assert.equal(LINK_RATIO, 1.5);
  const linked = linkOf([ticket("A11-1", 20, 4), ticket("A11-2", 30, 3), ticket("A11-3", 40, 3), ticket("A11-4", 80, 2), ticket("A11-5", 90, 2), ticket("A11-6", 95, 2)]);
  assert.deepEqual(linked.low, { tickets: 3, roundsPerRun: 10 / 3, replans: 0, needsYou: 0 });
  assert.deepEqual(linked.rest, { tickets: 3, roundsPerRun: 2, replans: 0, needsYou: 0 });
  assert.deepEqual(linked.linked, ["roundsPerRun"]);
  assert.equal(linked.meetsBar, true);
  assert.equal(verdictOf(linked), "6 scored of 6 past tickets: 3 under 60, 3 at 60 or more. Low against the rest, per ticket: rounds per run 3.33 against 2, re-plans 0 against 0, Needs-you rounds 0 against 0. A clear link on rounds per run, so the key is on by default.");
});

test("A11-443: the bar is missed with too few low tickets, with no measure 1.5 times as high, or with a measure where the low tickets did better", () => {
  const fewLow = linkOf([ticket("A11-1", 20, 9), ticket("A11-2", 30, 9), ticket("A11-4", 80, 2), ticket("A11-5", 90, 2), ticket("A11-6", 95, 2)]);
  assert.equal(fewLow.meetsBar, false, "2 low tickets");
  assert.match(verdictOf(fewLow), /2 scored under 60, short of the 3 the bar needs\.$/);
  const flat = linkOf([ticket("A11-1", 20, 2), ticket("A11-2", 30, 2), ticket("A11-3", 40, 2), ticket("A11-4", 80, 2), ticket("A11-5", 90, 2), ticket("A11-6", 95, 2)]);
  assert.deepEqual([flat.linked, flat.meetsBar], [[], false]);
  const mixed = linkOf([ticket("A11-1", 20, 4), ticket("A11-2", 30, 4), ticket("A11-3", 40, 4), ticket("A11-4", 80, 2, { replans: 1 }), ticket("A11-5", 90, 2), ticket("A11-6", 95, 2)]);
  assert.deepEqual([mixed.linked, mixed.against, mixed.meetsBar], [["roundsPerRun"], ["replans"], false]);
  assert.match(verdictOf(mixed), /the low tickets did better on re-plans\.$/);
  const zeroRest = linkOf([ticket("A11-1", 20, 2, { needsYou: 1 }), ticket("A11-2", 30, 2), ticket("A11-3", 40, 2), ticket("A11-4", 80, 2), ticket("A11-5", 90, 2), ticket("A11-6", 95, 2)]);
  assert.deepEqual([zeroRest.linked, zeroRest.meetsBar], [["needsYou"], true], "Needs-you on low tickets only is a link");
});

test("A11-443: a ticket the scorer could not score is left out of the comparison and counted as checked", () => {
  const score = linkOf([ticket("A11-1", null, 9), ticket("A11-2", 70, 1)]);
  assert.deepEqual([score.checked, score.scored, score.low.tickets, score.rest.tickets], [2, 1, 0, 1]);
  assert.equal(verdictOf(score), "1 scored of 2 past tickets: 0 under 60, 1 at 60 or more. No clear link, so the key stays off: 0 scored under 60, short of the 3 the bar needs; 1 scored 60 or more, short of the 3 the bar needs; no measure is 1.5 times as high for the low tickets.");
});

test("A11-443: the checked-in result carries no reason and no failure, only keys, scores and the board's counts", () => {
  const tickets = [{ ...ticket("A11-1", 40, 2), reasons: ["No acceptance criteria."] }, { ...ticket("A11-2", null, 1), reasons: [], failed: "exit 1: down" }];
  const full: CheckResult = { ranAt: "r", sha: "s", model: "haiku", capped: false, score: linkOf(tickets), verdict: "v", tickets };
  assert.deepEqual(publicResultOf(full).tickets, [ticket("A11-1", 40, 2), ticket("A11-2", null, 1)]);
  assert.deepEqual(linkOf(publicResultOf(full).tickets), full.score, "the score reads the same from it");
});

const stored = JSON.parse(readFileSync(new URL("../../evals/readiness/result.json", import.meta.url), "utf8")) as PublicResult;

test("A11-443: the key is on by default exactly when the stored check meets the bar, and the stored score and verdict are the ones its tickets give", () => {
  assert.deepEqual(stored.score, linkOf(stored.tickets), "the stored score is its tickets' score");
  assert.ok(stored.verdict.startsWith(verdictOf(stored.score)), "the stored verdict is its score's");
  assert.ok(stored.tickets.length <= MAX_SET, "the set is within the grill's cap");
  assert.equal(DEFAULT_READINESS, stored.score.meetsBar, "the default follows the check");
  assert.equal(parseTicketSettings({ clones: { "agent-org": "/repos/agent-org" } }, "/home/me").readiness, stored.score.meetsBar, "a host file with no tickets.readiness reads the default");
  assert.equal(SCHEMA.find(({ key }) => key === "tickets.readiness")?.default, String(stored.score.meetsBar), "the Settings page shows the same default");
});

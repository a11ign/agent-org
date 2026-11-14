import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { appendOutcome, type OutcomeRecord, outcomeRecordOf, outcomesPath } from "./outcomes/outcome-record.ts";
import type { Ticket } from "./source.ts";
import { kindOf, suggestionOf, suggestionView } from "./suggest-model.ts";

const AT = Date.UTC(2026, 10, 14, 12);
const DEPS = { repo: "agent-org", labels: ["dependency-update"] };
const APPROVED = ["convinced"];
const SENT_BACK = ["not-convinced", "convinced"];

type RunOf = Readonly<{ n: number; model: string; effort: string; verdicts: readonly string[]; repos?: readonly string[]; labels?: readonly string[] }>;

/** One run's record: one round that opened a pull request, and the reviewer's `verdicts` on it, in order. No verdict is a run the reviewer has not reviewed. */
function runOf({ n, model, effort, verdicts, repos = ["agent-org"], labels = ["dependency-update"] }: RunOf): OutcomeRecord {
  const pr = `https://github.com/a11ign/agent-org/pull/${n}`;
  const reviews = verdicts.map((verdict, at) => ({ pr, head: `h${at}`, verdict, posted: AT + at, at: AT + at }));
  return outcomeRecordOf({ ticket: `A11-${n}`, model, effort, repos, labels, prs: [pr] }, { since: AT - 10_000, rounds: [{ startedAt: AT - 5_000, endedAt: AT, outcome: "ready-pr", tokens: {} }], reviews });
}

/** `passed` runs approved at their first review and `failed` runs sent back by it, on `model`/`effort`, numbered from `from`. */
function runs(model: string, effort: string, passed: number, failed: number, from = 0, extra: Partial<RunOf> = {}): OutcomeRecord[] {
  return Array.from({ length: passed + failed }, (_, at) => runOf({ n: from + at, model, effort, verdicts: at < passed ? APPROVED : SENT_BACK, ...extra }));
}

test("31 past dependency-update runs in agent-org on sonnet/medium, 94% first pass, suggest sonnet/medium with its rate and n", () => {
  const records = [...runs("sonnet", "medium", 29, 2), ...runs("opus", "high", 20, 5, 100)];
  const suggestion = suggestionOf(records, [DEPS], { minSample: 20 });
  assert.deepEqual(suggestion, {
    model: "sonnet", effort: "medium", firstPass: 94, n: 31, label: "dependency-update", repo: "agent-org", reason: "94% first-pass, n=31, on dependency-update tickets in agent-org",
  });
});

test("fewer past runs of the kind than the minimum sample size suggest nothing", () => {
  const records = runs("sonnet", "medium", 18, 1);
  assert.equal(suggestionOf(records, [DEPS], { minSample: 20 }), null);
  assert.equal(suggestionOf(records, [DEPS], { minSample: 19 })?.n, 19, "the same runs at the minimum do");
});

test("only runs of the ticket's repository and label are counted", () => {
  const records = [...runs("sonnet", "medium", 10, 0), ...runs("sonnet", "medium", 10, 0, 100, { repos: ["control"] }), ...runs("sonnet", "medium", 10, 0, 200, { labels: ["bug"] })];
  assert.equal(suggestionOf(records, [DEPS], { minSample: 10 })?.n, 10);
  assert.equal(suggestionOf(records, [DEPS], { minSample: 11 }), null);
});

test("a tie in first-pass rate goes to the larger sample", () => {
  const records = [...runs("sonnet", "medium", 10, 0), ...runs("opus", "high", 12, 0, 100)];
  assert.deepEqual(suggestionOf(records, [DEPS], { minSample: 10 })?.model, "opus");
});

test("a batch is suggested for only when its tickets share a repository and a label", () => {
  const records = runs("sonnet", "medium", 10, 0);
  const options = { minSample: 10 };
  assert.equal(suggestionOf(records, [DEPS, { repo: "agent-org", labels: ["bug", "dependency-update"] }], options)?.label, "dependency-update");
  assert.equal(suggestionOf(records, [DEPS, { repo: "control", labels: ["dependency-update"] }], options), null);
  assert.equal(suggestionOf(records, [DEPS, { repo: "agent-org", labels: ["bug"] }], options), null);
  assert.equal(suggestionOf(records, [{ repo: null, labels: ["dependency-update"] }], options), null, "a ticket whose repository is unknown");
});

test("a run is counted once, by its latest record", () => {
  const first = runOf({ n: 1, model: "sonnet", effort: "medium", verdicts: ["not-convinced"] });
  const later = runOf({ n: 1, model: "sonnet", effort: "medium", verdicts: SENT_BACK });
  assert.deepEqual(suggestionOf([first, later], [DEPS], { minSample: 1 })?.reason, "0% first-pass, n=1, on dependency-update tickets in agent-org");
});

test("first pass is the Outcomes view's: approved at the first review; a run the reviewer has not reviewed is not counted", () => {
  const records = [...runs("sonnet", "medium", 3, 1), ...runs("sonnet", "medium", 0, 0), runOf({ n: 50, model: "sonnet", effort: "medium", verdicts: [] })];
  const suggestion = suggestionOf(records, [DEPS], { minSample: 1 });
  assert.deepEqual([suggestion?.firstPass, suggestion?.n], [75, 4], "the unreviewed run is in neither the rate nor n");
  assert.equal(suggestionOf([runOf({ n: 50, model: "sonnet", effort: "medium", verdicts: [] })], [DEPS], { minSample: 1 }), null);
});

const ticket = (over: Partial<Ticket>): Pick<Ticket, "projectSummary" | "description" | "labels"> => ({ description: "", labels: [], ...over });

test("a ticket's repository is its project's, else its description's Repository line, and only one of this machine's clones", () => {
  const clones = ["agent-org", "control"];
  assert.equal(kindOf(ticket({ projectSummary: "github.com/a11ign/control" }), clones).repo, "control");
  assert.equal(kindOf(ticket({ description: "Body.\n\n**Repository:** agent-org" }), clones).repo, "agent-org");
  assert.equal(kindOf(ticket({ projectSummary: "github.com/a11ign/control", description: "**Repository:** agent-org" }), clones).repo, "control", "the project's wins");
  assert.equal(kindOf(ticket({ description: "**Repository:** elsewhere" }), clones).repo, null);
  assert.deepEqual(kindOf(ticket({ labels: [{ name: "dependency-update", group: null }] }), clones).labels, ["dependency-update"]);
});

const fullTicket = (key: string, labels: readonly string[]): Ticket => ({
  key, title: key, description: "**Repository:** agent-org", url: "", branch: "", status: "Todo", statusOrder: 0, team: "A11", project: null, priority: 0, parent: null,
  labels: labels.map((name) => ({ name, group: null })),
});

test("the route's answer reads the outcome log in the state dir, and an unreadable log is an error, not no suggestion", () => {
  const stateDir = tmpDir("suggest-");
  for (const record of runs("sonnet", "medium", 2, 0)) appendOutcome(outcomesPath(stateDir), record);
  const input = { stateDir, clones: ["agent-org"], minSample: 2 };
  assert.equal(suggestionView({ ...input, tickets: [fullTicket("A11-9", ["dependency-update"])] }).suggestion?.reason, "100% first-pass, n=2, on dependency-update tickets in agent-org");
  assert.deepEqual(suggestionView({ ...input, tickets: [] }), { suggestion: null });
  appendFileSync(outcomesPath(stateDir), "not json\n");
  assert.throws(() => suggestionView({ ...input, tickets: [fullTicket("A11-9", ["dependency-update"])] }), /line 3 of the outcome log .* is not JSON/);
  assert.deepEqual(suggestionView({ ...input, tickets: [fullTicket("A11-9", [])] }), { suggestion: null }, "a ticket with no label has no kind, so the log is not read");
});

test("no outcome log yet suggests nothing", () => {
  const stateDir = tmpDir("suggest-");
  mkdirSync(dirname(outcomesPath(stateDir)), { recursive: true });
  assert.deepEqual(suggestionView({ stateDir, tickets: [fullTicket("A11-9", ["dependency-update"])], clones: ["agent-org"], minSample: 1 }), { suggestion: null });
});

test("the log is parsed again once it grows, so a run that ended since the last ask is counted", () => {
  const stateDir = tmpDir("suggest-");
  const [first, second] = runs("sonnet", "medium", 2, 0);
  appendOutcome(outcomesPath(stateDir), first!);
  const input = { stateDir, tickets: [fullTicket("A11-9", ["dependency-update"])], clones: ["agent-org"], minSample: 1 };
  assert.equal(suggestionView(input).suggestion?.n, 1);
  appendOutcome(outcomesPath(stateDir), second!);
  assert.equal(suggestionView(input).suggestion?.n, 2);
});

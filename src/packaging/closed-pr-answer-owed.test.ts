// no-token: gh -- every `gh` here is the injected `run` seam `readClosedAnswerRows` already takes; nothing reaches the real one
/**
 * #2641: AN `answer:<session>` LABEL ON A PULL REQUEST THAT IS NO LONGER OPEN WAS READ BY NOTHING.
 *
 * `trunkRedOrders` names the MERGED pull request that turned `main` red as its subject, and `escalateStuck` labels
 * it `answer:ceo` when six offers did not clear the red (#2636). The `answer-owed` reader covered open issues, open
 * pull requests (#2492) and closed ISSUES (#2202) -- and no pull request that is not open, so the escalation ended in
 * a label on a merged PR and no session was woken. #2202's defect one subject over.
 *
 * Its own file for #2280's reason: `work-gate.test.ts` reaches `gh`, which the token-less acceptance job refuses.
 *
 * THE FAKE IS GITHUB, NOT A CANNED REPLY. `fakeGitHub` holds issues and pull requests with states and labels and
 * answers `label list`, `issue list` and `pr list` by filtering them the way `gh` does for the arguments the reader
 * sends (`--state`, and `label:"a","b"` with or without `-is:open`). A reader that never asks about pull requests
 * therefore gets no merged PR back, and that is what makes the negative test fail for the defect and not for a
 * mismatched argv. `ignoreLabelSearch` is the same fake with the label filter switched off, so the LOCAL half of the
 * reader (`withAnswerLabel`) is tested apart from the server-side half and neither hides the other's deletion.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readClosedAnswerRows, withoutEndedAnswerSessions, rowsOwingAnswers, answerOrders, GH_READS,
  ANSWER_PREFIX } from "../work-gate.ts";

/** A row as `readClosedAnswerRows` returns it. */
type Row = { number: number, state?: string, labels: { name: string }[] };
type Subject = { kind: "issue" | "pr", number: number, state: "OPEN" | "CLOSED" | "MERGED", labels: string[] };

const issue = (number: number, state: Subject["state"], ...labels: string[]): Subject => ({ kind: "issue", number, state, labels });
const pr = (number: number, state: Subject["state"], ...labels: string[]): Subject => ({ kind: "pr", number, state, labels });

/** `gh`'s `--state` for the two commands: `pr list --state closed` is CLOSED-unmerged only; `merged` is MERGED only. */
const stateMatches = (state: string, wanted: string) => wanted === "all" || wanted.toUpperCase() === state;

/** A `run` seam answering as GitHub would for what this reader sends. `calls` records every argv, in order. */
function fakeGitHub(subjects: Subject[], { refuse = "", ignoreLabelSearch = false }:
  { refuse?: "issue" | "pr" | "label" | "", ignoreLabelSearch?: boolean } = {}) {
  const calls: string[][] = [];
  const known = [...new Set(subjects.flatMap((s) => s.labels))];
  const run = (args: string[]): string => {
    calls.push(args);
    const [noun, verb] = args;
    if (refuse === noun) throw new Error(`HTTP 502 on ${noun} ${verb}`);
    if (noun === "label") return JSON.stringify(known.map((name) => ({ name })));
    const flag = (name: string) => args[args.indexOf(name) + 1];
    const search = flag("--search") ?? "";
    const wanted = [...search.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const excludeOpen = search.includes("-is:open");
    const rows = subjects.filter((s) => s.kind === (noun === "pr" ? "pr" : "issue")
      && stateMatches(s.state, flag("--state"))
      && !(excludeOpen && s.state === "OPEN")
      && (ignoreLabelSearch || wanted.length === 0 || s.labels.some((l) => wanted.includes(l))));
    return JSON.stringify(rows.slice(0, Number(flag("--limit"))).map((s) => ({ number: s.number, title: `t${s.number}`,
      state: s.state, labels: s.labels.map((name) => ({ name })), ...(noun === "pr" ? { isDraft: false } : {}) })));
  };
  return { run, calls };
}

const ordered = (rows: unknown[] | null) =>
  (answerOrders(rows as Row[]) as { session: string, discriminator: string, prompt: string }[])
    .map((o) => [o.session, o.discriminator]);

// --- done-when 2: THE NEGATIVE TEST. Deleting the PR half of the read turns it red. ---

test("#2641 DONE-WHEN 1+2: a MERGED pull request carrying answer:ceo yields an answer-owed order for ceo, saying it is a merged PR", () => {
  const { run } = fakeGitHub([pr(2640, "MERGED", "answer:ceo", "session:worker-2636")]);
  const rows = readClosedAnswerRows(run);
  assert.deepEqual(ordered(rows), [["ceo", "2640"]]);
  const [order] = answerOrders(rows as Row[]) as { prompt: string }[];
  assert.match(order.prompt, /#2640 IS A PULL REQUEST WAITING ON AN ANSWER/, "the reader looks at a pull request");
  assert.match(order.prompt, /THE PULL REQUEST IS MERGED/, "and is told it merged, not that 'a merge closed the row'");
  assert.doesNotMatch(order.prompt, /THE ROW IS CLOSED/);
});

test("#2641 DONE-WHEN 1: a pull request CLOSED UNMERGED is read too, and is told it was closed", () => {
  const { run } = fakeGitHub([pr(2500, "CLOSED", "answer:orchestrator")]);
  const [order] = answerOrders(readClosedAnswerRows(run) as Row[]) as { session: string, prompt: string }[];
  assert.equal(order.session, "orchestrator");
  assert.match(order.prompt, /THE PULL REQUEST IS CLOSED: it was closed while your answer was still owed/);
});

test("#2641 DONE-WHEN 1: the whole path -- a merged PR reaches `answerOwed` through the shipped `rowsOwingAnswers`", () => {
  const { run } = fakeGitHub([pr(2640, "MERGED", "answer:ceo")]);
  const closedRows = withoutEndedAnswerSessions(readClosedAnswerRows(run) as Row[],
    { agents: () => ["ceo"], ended: () => new Map(), say: () => undefined });
  assert.deepEqual(ordered(rowsOwingAnswers({ openRows: [], openPrs: [], closedRows })), [["ceo", "2640"]]);
});

// --- done-when 3: the positive controls ---

test("#2641 DONE-WHEN 3a: an OPEN issue and a CLOSED issue are ordered exactly as before, beside a merged PR", () => {
  const subjects = [issue(10, "OPEN", "answer:ceo"), issue(11, "CLOSED", "answer:product-manager"),
    pr(12, "MERGED", "answer:ceo")];
  const { run } = fakeGitHub(subjects);
  const openRows = [{ number: 10, labels: [{ name: "answer:ceo" }] }];
  const closedRows = readClosedAnswerRows(run) as Row[];
  assert.deepEqual(closedRows.map((r) => r.number).sort(), [11, 12], "the open issue is not the closed read's -- the open read has it");
  const all = rowsOwingAnswers({ openRows, openPrs: [], closedRows });
  assert.deepEqual(ordered(all).sort(), [["ceo", "10"], ["ceo", "12"], ["product-manager", "11"]]);
  const closedIssue = (answerOrders(closedRows.filter((r) => r.number === 11)) as { prompt: string }[])[0];
  assert.match(closedIssue.prompt, /THE ROW IS CLOSED: a merge closed it/, "a closed ISSUE reads as before");
  assert.match(closedIssue.prompt, /A closed row takes a comment/);
});

test("#2641 DONE-WHEN 3b: a merged PR carrying NO answer: label is NOT ordered -- the test does not pass for a reader that orders every PR", () => {
  const { run } = fakeGitHub([pr(2640, "MERGED", "session:worker-2636"), pr(2641, "MERGED", "lane:any"),
    pr(2642, "MERGED", "answer:ceo")]);
  assert.deepEqual(ordered(readClosedAnswerRows(run)), [["ceo", "2642"]], "only the labelled one");
  const sloppy = fakeGitHub([pr(2640, "MERGED", "session:worker-2636"), pr(2642, "MERGED", "answer:ceo")], { ignoreLabelSearch: true });
  assert.deepEqual((readClosedAnswerRows(sloppy.run) as Row[]).map((r) => r.number), [2642],
    "even when the search hands back every merged PR, the local filter keeps only the labelled one (`answerOrders` would drop the rest anyway, so the READ is what is asserted)");
  const nothing = fakeGitHub([pr(2640, "MERGED", "session:worker-2636"), issue(1, "CLOSED", "backlog")]);
  assert.deepEqual(readClosedAnswerRows(nothing.run), [], "no answer: label in the repo at all: nothing owes, and the list is empty, not null");
  assert.equal(nothing.calls.length, 1, "and only the label list was asked");
});

test("#472: `gh label list` printing ZERO BYTES (a repository with no answer: label) is 'none', and a refusal is still null", () => {
  const calls: string[][] = [];
  const empty = (args: string[]) => { calls.push(args); return ""; };
  assert.deepEqual(readClosedAnswerRows(empty), [], "an empty stdout is no labels, not a refusal");
  assert.equal(calls.length, 1, "and nothing further is asked");
  assert.equal(readClosedAnswerRows(() => "not json"), null, "text that does not parse is still a refusal");
  assert.equal(readClosedAnswerRows(() => "{}"), null, "a non-array is still a refusal");
  assert.equal(readClosedAnswerRows(() => { throw new Error("HTTP 502"); }), null, "a thrown gh is still a refusal");
  const populated = fakeGitHub([issue(7, "CLOSED", "answer:ceo")]);
  assert.deepEqual((readClosedAnswerRows(populated.run) as Row[]).map((r) => r.number), [7],
    "POSITIVE CONTROL: the same reader still returns a row when the label list is populated");
});

test("#2641: an OPEN pull request carrying the label is not this read's -- `readPrs` has it, and it would otherwise be ordered twice", () => {
  const { run } = fakeGitHub([pr(2376, "OPEN", "answer:worker-tooling"), pr(2640, "MERGED", "answer:ceo")]);
  assert.deepEqual((readClosedAnswerRows(run) as Row[]).map((r) => r.number), [2640]);
});

// --- done-when 4: #2609's ended-session rule applies through the SAME function, not a second copy ---

test("#2641 DONE-WHEN 4: a merged PR labelled for an ENDED session is not ordered, by the one function the closed issues go through", () => {
  const { run } = fakeGitHub([pr(2640, "MERGED", "answer:worker-8", "answer:ceo"), issue(2116, "CLOSED", "answer:worker-8")]);
  const said: string[] = [];
  const kept = withoutEndedAnswerSessions(readClosedAnswerRows(run) as Row[], { agents: () => ["ceo"],
    ended: () => new Map([["worker-8", Date.parse("2026-09-26T05:00:00Z")]]), say: (line: string) => said.push(line) });
  assert.deepEqual(ordered(kept.filter((r: Row) => r.labels.length > 0)).sort(), [["ceo", "2640"]],
    "worker-8's label is off BOTH the issue and the merged PR; ceo's on the PR still orders");
  assert.equal(said.length, 2, "one line for the closed issue and one for the merged pull request -- one classifier");
  const live = withoutEndedAnswerSessions(readClosedAnswerRows(run) as Row[], { agents: () => ["ceo", "worker-8"],
    ended: () => new Map([["worker-8", Date.parse("2026-09-26T05:00:00Z")]]), say: () => undefined });
  assert.deepEqual(ordered(live).map(([s]) => s).sort(), ["ceo", "worker-8", "worker-8"], "a LIVE session's question on a merged PR still wakes it");
});

// --- the null contract: a refused read is null, never [] ---

test("#2641 DONE-WHEN 1: a refused read of EITHER half is `null`, never `[]` -- 'could not ask' is not 'nobody owes anything'", () => {
  const subjects = [issue(11, "CLOSED", "answer:ceo"), pr(12, "MERGED", "answer:ceo")];
  for (const refuse of ["label", "issue", "pr"] as const) {
    assert.equal(readClosedAnswerRows(fakeGitHub(subjects, { refuse }).run), null, `${refuse} refused`);
  }
  const base = fakeGitHub(subjects).run;
  assert.equal(readClosedAnswerRows((args) => (args[0] === "pr" ? "{}" : base(args))), null, "a PR search answering a non-list is a refusal");
  assert.equal(readClosedAnswerRows((args) => (args[0] === "pr" ? "not json" : base(args))), null);
});

// --- done-when 5: THE COST, counted ---

test("#2641 DONE-WHEN 5: the reader makes ONE more `gh` call than before (three, not two), and GH_READS names it", () => {
  const { run, calls } = fakeGitHub([pr(12, "MERGED", "answer:ceo")]);
  readClosedAnswerRows(run);
  assert.deepEqual(calls.map((c) => c.slice(0, 2).join(" ")), ["label list", "issue list", "pr list"],
    "one `label list` shared by both searches -- NOT a second one for the pull requests");
  assert.equal(GH_READS.unconditional.filter((r: string) => r.includes("readClosedAnswerRows")).length, 3,
    "the label list, the closed-issue read and the pull-request read are each named");
  assert.ok(GH_READS.unconditional.some((r: string) => r.startsWith("pr list --state all") && r.includes("readClosedAnswerRows")));
});

test("#2641 DONE-WHEN 5: the PR read is a search by label NAME with no window -- `-is:open`, exact, the same names as the issue read", () => {
  const { run, calls } = fakeGitHub([pr(12, "MERGED", "answer:ceo", "answer:worker-9")]);
  readClosedAnswerRows(run);
  const [, issueCall, prCall] = calls;
  const searchOf = (c: string[]) => c[c.indexOf("--search") + 1];
  assert.equal(searchOf(prCall), `${searchOf(issueCall)} -is:open`, "the same label names, plus the one qualifier");
  assert.equal(prCall[prCall.indexOf("--state") + 1], "all", "merged AND closed-unmerged: `--state closed` alone would miss a merge");
  assert.ok(!prCall.includes("merged"), "not a newest-N window over merged PRs (a question older than it would fall out)");
  assert.ok(prCall.join(" ").includes(`"${ANSWER_PREFIX}ceo"`));
});

// no-token: none -- every read is the fake code host's rows (a world of issues and pull requests held in memory); the `run` the reader takes is one that throws, and nothing reaches `gh`
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
 * THE FAKE IS THE CODE HOST (A11-160, step 6; it was a stub `gh` that filtered as GitHub does). `fakeGitHub` seeds the fake code host's world with issues and pull requests with states and labels, and its rows
 * answer the label list and the two closed reads (#5050: the connections `issues(labels:, states:)` and `pullRequests(...)`) by filtering the world the way GitHub does: the kind asked of, the states (closed
 * issues; closed and merged pull requests, never open ones) and the labels. A reader that never asks about pull requests therefore gets no merged PR back, and that is what makes the negative test fail for the
 * defect and not for a mismatched argv. `ignoreLabelSearch` (`world.gate.closedRowsUnfiltered`) is the same fake with the label filter switched off, so the LOCAL half of the reader (`withAnswerLabel`) is
 * tested apart from the server-side half and neither hides the other's deletion.
 *
 * What the reads SEND (a connection by label name, one alias per label, the states, `isDraft`, no search) and how the plugin reads the answer is the plugin's: `plugins/github/rows/gate-pull-reads.test.ts`
 * (#5050 and #472 cases). Here the order of the three reads and their count are asserted on the fake's rows.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readClosedAnswerRows, withoutEndedAnswerSessions, rowsOwingAnswers, answerOrders } from "../work-gate/causes/rows-answers.ts";
import { GH_READS } from "../work-gate/reads/read-memo-and-exit.ts";
import { ANSWER_PREFIX } from "../waiting-condition.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow } from "../plugins/fakes/code-host-rows.ts";

afterEach(() => forgetActivation());

/** A row as `readClosedAnswerRows` returns it. */
type Row = { number: number, state?: string, labels: { name: string }[] };
type Subject = { kind: "issue" | "pr", number: number, state: "OPEN" | "CLOSED" | "MERGED", labels: string[] };

const issue = (number: number, state: Subject["state"], ...labels: string[]): Subject => ({ kind: "issue", number, state, labels });
const pr = (number: number, state: Subject["state"], ...labels: string[]): Subject => ({ kind: "pr", number, state, labels });

/**
 * The fake code host holding `subjects`, and a `run` that throws (nothing reaches `gh`). `calls` names every read made of the rows, in order: `label list`, `issues`, `pullRequests`. `refuse` makes one of
 * the three reads throw, as GitHub refuses one.
 */
function fakeGitHub(subjects: Subject[], { refuse = "", ignoreLabelSearch = false }:
  { refuse?: "issue" | "pr" | "label" | "", ignoreLabelSearch?: boolean } = {}) {
  const host = createFakeCodeHost();
  const { rowsWorld: world, rows } = host;
  world.labelsCreated.push(...new Set(subjects.flatMap((s) => s.labels)));
  for (const s of subjects) {
    if (s.kind === "issue") world.rows.set(s.number, fakeRow(world, s.number, { title: `t${s.number}`, state: s.state === "OPEN" ? "OPEN" : "CLOSED", labels: s.labels }));
    else world.pulls.set(s.number, { number: s.number, title: `t${s.number}`, body: "", headRefName: `pr-${s.number}`, labels: s.labels, isDraft: false, armed: false, merged: s.state === "MERGED",
      mergedAt: s.state === "MERGED" ? "2026-10-01T00:00:00Z" : null, closedAt: s.state === "CLOSED" ? "2026-10-01T00:00:00Z" : null, createdAt: "2026-09-01T00:00:00Z", comments: [] });
  }
  world.gate.closedRowsUnfiltered = ignoreLabelSearch;
  if (refuse === "label") world.failures.set("labelNamesWithPrefix", new Error("HTTP 502 on label list"));
  if (refuse === "issue") world.failures.set("closedRowsCarryingLabels issues", new Error("HTTP 502 on issues"));
  if (refuse === "pr") world.failures.set("closedRowsCarryingLabels pullRequests", new Error("HTTP 502 on pullRequests"));
  return withRecordedReads(host, world);
}

/** Records the reads the closed answer read makes of `host`'s rows, and installs it as the process's code host. */
function withRecordedReads(host: ReturnType<typeof createFakeCodeHost>, world: ReturnType<typeof createFakeCodeHost>["rowsWorld"]) {
  const rows = host.rows!;
  const calls: string[] = [];
  const asks: { kind: string; names: string[] }[] = [];
  const labels = rows.labelNamesWithPrefix;
  rows.labelNamesWithPrefix = (request) => { calls.push("label list"); return labels(request); };
  const carrying = rows.closedRowsCarryingLabels;
  rows.closedRowsCarryingLabels = (request) => { calls.push(request.kind); asks.push({ kind: request.kind, names: request.names }); return carrying(request); };
  substituteCodeHost(host);
  const run = (): string => {
    throw new Error("the fake code host acts on its own state: no gh is run");
  };
  return { run, calls, asks, world };
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

test("#472: a repository with no answer: label is 'none' (not a refusal), and a label list that is refused, garbled or not a list is still null", () => {
  const empty = fakeGitHub([issue(1, "CLOSED", "backlog")]);
  assert.deepEqual(readClosedAnswerRows(empty.run), [], "no answer: label in the repository is no labels, not a refusal");
  assert.deepEqual(empty.calls, ["label list"], "and nothing further is asked");
  const notAList = fakeGitHub([issue(1, "CLOSED", "answer:ceo")]);
  notAList.world.gate.labelListNotAList = true;
  assert.equal(readClosedAnswerRows(notAList.run), null, "a non-array is still a refusal");
  const garbled = fakeGitHub([issue(1, "CLOSED", "answer:ceo")]);
  garbled.world.failures.set("labelNamesWithPrefix", new SyntaxError("Unexpected token 'o', \"not json\" is not valid JSON"));
  assert.equal(readClosedAnswerRows(garbled.run), null, "text that does not parse is still a refusal");
  assert.equal(readClosedAnswerRows(fakeGitHub([issue(1, "CLOSED", "answer:ceo")], { refuse: "label" }).run), null, "a thrown gh is still a refusal");
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
  const notWhole = fakeGitHub(subjects);
  notWhole.world.gate.closedRowsNotWhole.add("pullRequests");
  assert.equal(readClosedAnswerRows(notWhole.run), null, "a PR read answering something that is not a connection is a refusal");
  const garbled = fakeGitHub(subjects);
  garbled.world.failures.set("closedRowsCarryingLabels pullRequests", new SyntaxError("Unexpected token 'o', \"not json\" is not valid JSON"));
  assert.equal(readClosedAnswerRows(garbled.run), null);
  assert.deepEqual((readClosedAnswerRows(fakeGitHub(subjects).run) as Row[]).map((r) => r.number).sort(), [11, 12], "POSITIVE CONTROL: the same world unbroken answers both");
});

// --- done-when 5: THE COST, counted ---

test("#2641 DONE-WHEN 5: the reader makes ONE more read than before (three, not two), and GH_READS names it", () => {
  const { run, calls } = fakeGitHub([pr(12, "MERGED", "answer:ceo")]);
  readClosedAnswerRows(run);
  assert.deepEqual(calls, ["label list", "issues", "pullRequests"],
    "one label list shared by both reads -- NOT a second one for the pull requests -- then the closed issues and the closed pull requests, as two connection reads (#5050), in that order");
  assert.equal(GH_READS.unconditional.filter((r: string) => r.includes("readClosedAnswerRows")).length, 3,
    "the label list, the closed-issue read and the pull-request read are each named");
  assert.ok(GH_READS.unconditional.some((r: string) => r.startsWith("api graphql repository { a<n>: pullRequests(") && r.includes("readClosedAnswerRows")));
});

test("#2641 DONE-WHEN 5: the PR read asks for the same label NAMES as the issue read, one alias each (the connection's argument list is the plugin's: gate-pull-reads.test.ts)", () => {
  const { run, asks } = fakeGitHub([pr(12, "MERGED", "answer:ceo", "answer:worker-9")]);
  readClosedAnswerRows(run);
  assert.deepEqual(asks.map(({ kind }) => kind), ["issues", "pullRequests"]);
  assert.deepEqual(asks[1].names, asks[0].names, "the same label names for the two reads");
  assert.deepEqual(asks[1].names, ["answer:ceo", "answer:worker-9"], "one alias per answer label, each asked for by its exact name: no newest-N window over all merged PRs");
  assert.ok(asks[1].names.includes(`${ANSWER_PREFIX}ceo`));
});

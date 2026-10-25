// no-token: gh -- the tracker, the code host and the clock are all injected; nothing is spawned
//
// A11-239: a `Partial:` line that says nothing remains is the last step, which closes the ticket. On agent-org#1877 (A11-219) the body said `Partial: none; this is the last step.` and the board read a partial step:
// the card said "Partial merged: none; ..." and the ticket stayed In Progress. `pr:open`'s and CI's `closes` report refuse such a line, and the board reads one that reaches it as `Closes`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { poolFixture } from "./pool-fixture.ts";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { DEFAULT_KEYWORDS } from "./source.ts";
import { declarationOf, namedTicketClosesReport, saysNothingRemains, ticketClosesReport } from "./ticket-references.ts";
import { declare, declaredByBlockerPull } from "./queue/queue-declarations.ts";
import { runStatus } from "./board-view/pull-status-and-notes.ts";
import { reasonOf } from "./board-view/run-reason.ts";

const PR_NUMBER = 1877;
const PR = `https://github.com/a11ign/agent-org/pull/${PR_NUMBER}`;
const LAST_STEP_BODY = "Refs NBF-1\n\nPartial: none; this is the last step.\n";

const NOTHING_REMAINS = ["Partial: none", "Partial: None.", "Partial: nothing", "Partial: n/a", "Partial: N/A", "Partial: last step", "Partial: this is the last step", "Partial: nothing remains",
  "Partial: none; this is the last step.", "**Partial:** NONE", "- Partial: Nothing remains — done", "Partial: It is the final step", "Partial: nothing left to do, all done", "Partial: nil (the last step)", "Partial: none (done)"];
const REAL_REMAINDERS = ["Partial: step 2 of 3: the board view; step 3 remains", "Partial: none of the UI yet; the board view remains", "Partial: the last step's screenshots remain",
  "Partial: step 1 of 2; the last step adds the card", "Partial: nothing is wired to the card yet", "Partial: the docs",
  "Partial: none, the board view remains", "Partial: None, except the docs", "Partial: nothing (the docs remain)", "Partial: nothing - but the docs remain", "Partial: Nothing. Remaining: the docs",
  "Partial: nothing; step 3 of 3 remains", "Partial: the last step; step 3 remains", "Partial: the last step, then docs", "Partial: n/a (see #12)", "Partial: none, a11ign/lab#150 finishes it", "Partial: none remains: the docs"];

/** The words after `Partial:` on a test line, markdown around the label dropped. */
const wordsOf = (line: string): string => line.replace(/^.*?Partial:\**\s*/, "");

test("A11-239: each wording that says nothing remains is refused by `pr:open`'s report and by CI's, with the last step's own fix, beside `Refs` or `Closes`", () => {
  for (const verb of ["Refs", "Closes"]) {
    for (const line of NOTHING_REMAINS) {
      const body = `${verb} A11-239\n\n${line}\n`;
      for (const report of [ticketClosesReport(body, "A11-239", DEFAULT_KEYWORDS), namedTicketClosesReport(body, DEFAULT_KEYWORDS)]) {
        assert.equal(report?.ok, false, JSON.stringify(body));
        assert.ok(report?.lines.join(" ").includes("The last step closes the ticket: write `Closes A11-239` and no `Partial:` line"), `${JSON.stringify(body)}: ${report?.lines.join(" ")}`);
        assert.match(report?.lines.join(" ") ?? "", /^CLOSES: REFUSED -- the `Partial:` line says nothing remains \(".+"\)\./, JSON.stringify(body));
      }
    }
  }
});

test("A11-239: the refusal is the report's first after `Closes: none`, so the A11-92 refusal does not offer `Refs` to a last step", () => {
  const report = ticketClosesReport("Closes A11-239\nPartial: none\n", "A11-239", DEFAULT_KEYWORDS);
  assert.doesNotMatch(report.lines.join(" "), /write `Refs/);
  assert.match(ticketClosesReport("Closes: none\nPartial: none\n", "A11-239", DEFAULT_KEYWORDS).lines.join(" "), /`Closes: none` is not a ticket's pull request's declaration/);
});

test("A11-239: a real remainder is still accepted, as is a placeholder's reading as it is today", () => {
  for (const line of REAL_REMAINDERS) {
    const body = `Refs A11-239\n\n${line}\n`;
    for (const report of [ticketClosesReport(body, "A11-239", DEFAULT_KEYWORDS), namedTicketClosesReport(body, DEFAULT_KEYWORDS)]) assert.equal(report?.ok, true, `${JSON.stringify(body)}: ${report?.lines.join(" ")}`);
  }
  const placeholder = ticketClosesReport("Refs A11-239\n\nPartial: <what remains>\n", "A11-239", DEFAULT_KEYWORDS);
  assert.match(placeholder.lines.join(" "), /^CLOSES: REFUSED -- `Refs A11-239` links the ticket and does not complete it, and the body has no `Partial:` line/);
});

test("A11-239: `saysNothingRemains` matches the whole leading clause only", () => {
  assert.deepEqual([...NOTHING_REMAINS, ...REAL_REMAINDERS].map((line) => saysNothingRemains(wordsOf(line))), [...NOTHING_REMAINS.map(() => true), ...REAL_REMAINDERS.map(() => false)]);
  assert.deepEqual(["", "<what remains>", "NONE OF IT", "none of"].map(saysNothingRemains), [false, false, false, false]);
});

test("A11-239: the board reads each wording as `Closes`, with or without a closing line, and each real remainder as the partial it is", () => {
  for (const line of NOTHING_REMAINS) {
    for (const head of ["Refs NBF-1", "Closes NBF-1", "No ticket named"]) assert.deepEqual(declarationOf(`${head}\n\n${line}\n`, "NBF-1", DEFAULT_KEYWORDS), { kind: "closes" }, `${head}: ${line}`);
  }
  for (const line of REAL_REMAINDERS) assert.deepEqual(declarationOf(`Refs NBF-1\n\n${line}\n`, "NBF-1", DEFAULT_KEYWORDS), { kind: "partial", remains: wordsOf(line) }, line);
});

test("A11-239: a blocker's merged pull request with A11-219's body closes the blocker's ticket", () => {
  assert.deepEqual(declaredByBlockerPull(LAST_STEP_BODY, "NBF-1", 1, DEFAULT_KEYWORDS), { kind: "closes" });
  assert.deepEqual(declaredByBlockerPull("Refs NBF-1\n\nPartial: step 2 of 3: the view\n", "NBF-1", 1, DEFAULT_KEYWORDS), { kind: "partial", remains: "step 2 of 3: the view" });
});

/** NBF-1 over the in-memory tracker, in progress, finished on a ready pull request at `PR` whose merged body is `body`, under an outcome whose `partial` is `partial` (none when undefined). */
function finishedWith(body: string, partial?: string) {
  const tracker = createFakeTracker([fakeTicket("NBF-1", { status: "In Progress", statusType: "started" })]);
  const undone: string[] = [];
  const { assigned, read, download, keywords, stateTypes, pullStates, claim, claims, complete, comment, moveToWorkingState } = tracker;
  const source = { assigned, read, download, keywords, stateTypes, pullStates, claim, claims, complete, comment, moveToWorkingState,
    undoAutomaticCompletion: async (key: string, text: string) => {
      undone.push(key);
      return tracker.undoAutomaticCompletion!(key, text);
    } };
  const made = poolFixture({ keys: ["NBF-1"] });
  const codeHost = createFakeCodeHost();
  codeHost.seedPull("a11ign/agent-org", PR_NUMBER, { state: "merged", findings: { title: `Pull request ${PR_NUMBER}`, number: PR_NUMBER, body, sections: [] } });
  const [entry] = made.store.get().entries;
  const outcome = { kind: "ready-pr" as const, prs: [{ repo: "agent-org", url: PR }], ...(partial === undefined ? {} : { partial }) };
  made.store.set({ ...made.store.get(), entries: [{ ...entry, phase: "finished", outcome, finishedAt: 100, ...(partial === undefined ? {} : { partial }) }] });
  tracker.linkPull("NBF-1", PR, "merged");
  return { tracker, undone, store: made.store, pool: made.restart({ source, codeHost }) };
}

test("A11-239: A11-219's body (`Refs` and `Partial: none; this is the last step.`) with an outcome of the same words: the board completes the ticket and shows no partial merge", async () => {
  const made = finishedWith(LAST_STEP_BODY, "none; this is the last step.");
  await made.pool.refreshTracker();
  const left = made.store.get().entries[0];
  assert.equal(made.tracker.ticketOf("NBF-1")?.status, "Done", "the board's backstop completes the ticket");
  assert.deepEqual([left.closedByBoard, left.phase, left.partial, left.steps, left.partialOverruled, runStatus(left), made.undone], [true, "finished", undefined, undefined, undefined, "completed", []]);
  assert.deepEqual(left.declared, { kind: "closes", urls: [PR] });
  assert.doesNotMatch(reasonOf(left).line ?? "", /Partial merged|Partial:/);
});

test("A11-239: the same body under an outcome with no `partial` completes the ticket too", async () => {
  const made = finishedWith(LAST_STEP_BODY);
  await made.pool.refreshTracker();
  const left = made.store.get().entries[0];
  assert.deepEqual([made.tracker.ticketOf("NBF-1")?.status, left.closedByBoard, left.partial, left.partialOverruled, runStatus(left)], ["Done", true, undefined, undefined, "completed"]);
});

test("A11-239: an outcome `partial` that names real work against that body is still a disagreement the card shows", async () => {
  const made = finishedWith(LAST_STEP_BODY, "step 2 of 3: the board view");
  await made.pool.refreshTracker();
  const left = made.store.get().entries[0];
  assert.deepEqual([made.tracker.ticketOf("NBF-1")?.status, left.partial, runStatus(left)], ["Done", undefined, "completed"]);
  assert.deepEqual(left.partialOverruled, { outcome: "step 2 of 3: the board view", pull: "Closes NBF-1", urls: [PR] });
});

test("A11-239: a body that says `Closes` against an outcome `partial` that says nothing remains records no disagreement, and against one that names work it does", async () => {
  const agreeing = finishedWith("Closes NBF-1\n", "None; this is the last step");
  await agreeing.pool.refreshTracker();
  assert.deepEqual([agreeing.store.get().entries[0].partialOverruled, runStatus(agreeing.store.get().entries[0])], [undefined, "completed"]);
  const disagreeing = finishedWith("Closes NBF-1\n", "the board view");
  await disagreeing.pool.refreshTracker();
  assert.deepEqual(disagreeing.store.get().entries[0].partialOverruled, { outcome: "the board view", pull: "Closes NBF-1", urls: [PR] });
});

test("A11-239: sibling pull requests that finish a ticket together, each naming the other in free words after `none`, are a run's `none` as before, and a last-step outcome that names work still disagrees", async () => {
  const sibling = "Refs NBF-1\n\nPartial: none, a11ign/lab#150 finishes it\n";
  assert.deepEqual(declare([{ url: PR, declaration: declarationOf(sibling, "NBF-1", DEFAULT_KEYWORDS) }, { url: PR, declaration: declarationOf(sibling, "NBF-1", DEFAULT_KEYWORDS) }], 2), { kind: "none", urls: [PR, PR] });
  const named = finishedWith("Closes NBF-1\n", "Nothing, the board view remains");
  await named.pool.refreshTracker();
  assert.deepEqual(named.store.get().entries[0].partialOverruled, { outcome: "Nothing, the board view remains", pull: "Closes NBF-1", urls: [PR] });
});

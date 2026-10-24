// no-token: gh -- herdr, git, the tracker, the code host and the clock are all injected; nothing is spawned
//
// A11-181: a merged pull request's own declaration decides whether its ticket is complete, not the outcome's `partial`. On A11-155 the outcome's `partial` listed what was DONE while the body said `Closes`,
// and the board put the ticket back after the tracker's integration closed it. Every pool test here runs the real pool over the contract's in-memory tracker and the in-memory code host, whose merged
// pull requests carry the body a test seeds; the pure cases are `declare` and `recordDeclared` (the combining rules and what a declaration does to a run), and the card's words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { poolFixture } from "./pool-fixture.ts";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import type { PullState, TicketSource } from "./source.ts";
import type { Entry, Outcome, Queue } from "./queue/queue-entries-and-outcomes.ts";
import { finish } from "./queue/queue-transitions.ts";
import { declare, declarationsDue, recordDeclared, type ReadDeclaration } from "./queue/queue-declarations.ts";
import { emptyQueue } from "./queue.ts";
import { runStatus } from "./board-view/pull-status-and-notes.ts";
import { reasonOf } from "./board-view/run-reason.ts";
import type { ViewEntry } from "./board-view/view-types-and-filters.ts";

const PR = "https://github.com/a11ign/announcement-emulator/pull/2";
const PR_2 = "https://github.com/a11ign/lab/pull/150";
const DONE_LIST = "The fleet steps, the freezes and held-out measure, the miss attribution, and the Re-measure section with the Gate verdict.";
const STEP_ONE = "step 1 of 3: the board reads a body; steps 2 and 3 remain";

/** NBF-1 over the in-memory tracker, in progress, and a code host that holds the merged pull requests a test seeds. */
function world(over: Partial<TicketSource> = {}) {
  const tracker = createFakeTracker([fakeTicket("NBF-1", { status: "In Progress", statusType: "started" })]);
  const undone: string[] = [];
  const { assigned, read, download, keywords, stateTypes, pullStates, claim, claims, complete, comment, moveToWorkingState } = tracker;
  const source: TicketSource = { assigned, read, download, keywords, stateTypes, pullStates, claim, claims, complete, comment, moveToWorkingState,
    undoAutomaticCompletion: async (key, text) => {
      undone.push(key);
      return tracker.undoAutomaticCompletion!(key, text);
    }, ...over };
  const made = poolFixture({ keys: ["NBF-1"] });
  const codeHost = createFakeCodeHost();
  return { ...made, tracker, codeHost, undone, source, pool: made.restart({ source, codeHost }) };
}
type World = ReturnType<typeof world>;

/** The merged pull request at `url`, held by the code host with `body`, as GitHub holds it once it merges. */
function seed(codeHost: World["codeHost"], url: string, body: string): void {
  const [, repository, number] = /github\.com\/(.+)\/pull\/(\d+)$/.exec(url)!;
  codeHost.seedPull(repository, Number(number), { state: "merged", findings: { title: `Pull request ${number}`, number: Number(number), body, sections: [] } });
}

type Finished = Readonly<{ urls?: readonly string[]; partial?: string; state?: PullState; by?: "integration" | "person" }>;

/** NBF-1's run, finished on ready pull requests at `urls`, with the outcome's `partial` (none when undefined), the pull requests in `state`, and the ticket completed by `by` (not at all when none). */
function finishedOn({ store, tracker }: World, { urls = [PR], partial, state = "merged", by }: Finished = {}): void {
  const [entry] = store.get().entries;
  const outcome = { kind: "ready-pr" as const, prs: urls.map((url) => ({ repo: "announcement-emulator", url })), ...(partial === undefined ? {} : { partial }) };
  store.set({ ...store.get(), entries: [{ ...entry, phase: "finished", outcome, finishedAt: 100, ...(partial === undefined ? {} : { partial }) }] });
  for (const url of urls) tracker.linkPull("NBF-1", url, state);
  if (by !== undefined) tracker.completeAs("NBF-1", by);
}

/** Run `act` with the board's log captured, and return the lines it wrote. */
async function captureStderr(act: () => Promise<void>): Promise<string[]> {
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    await act();
  } finally {
    process.stderr.write = write;
  }
  return written;
}

const run = ({ store }: World): Entry => store.get().entries[0];
const reads = ({ codeHost }: World): number => codeHost.calls.filter((call) => call.startsWith("readMergedFindings")).length;

// ---- Acceptance: the merged pull request's own declaration decides ----

test("A11-181: Closes with an outcome partial that lists what was done (A11-155): the ticket stays Done, nothing is put back or queued, the run reads Completed, and the card names both", async () => {
  const made = world();
  seed(made.codeHost, PR, "https://linear.app/a11ign/issue/NBF-1\n\nCloses NBF-1\n\n## What changed\n\nThe Gate was re-measured on a clean-history corpus.\n");
  finishedOn(made, { partial: DONE_LIST, by: "integration" });
  await made.pool.refreshTracker();
  assert.deepEqual(made.undone, [], "the tracker is not asked to put anything back");
  assert.deepEqual([made.tracker.ticketOf("NBF-1")?.status, made.tracker.comments], ["Done", []], "and the integration's completion stands");
  const left = run(made);
  assert.deepEqual([left.phase, left.partial, left.steps, runStatus(left)], ["finished", undefined, undefined, "completed"], "no step is queued, and the run is Completed");
  assert.deepEqual(left.declared, { kind: "closes", urls: [PR] });
  assert.deepEqual(left.partialOverruled, { outcome: DONE_LIST, pull: "Closes NBF-1", urls: [PR] });
  const { line } = reasonOf(left);
  assert.ok(line?.startsWith("completed: a11ign/announcement-emulator #2 merged; its outcome said Partial: \"The fleet steps"), line ?? "");
  assert.ok(line?.endsWith("but a11ign/announcement-emulator #2 said Closes NBF-1, so the board followed the pull request"), line ?? "");
  await made.pool.refreshTracker();
  assert.deepEqual([made.undone, reads(made)], [[], 1], "a later sweep neither asks the tracker nor reads the body again");
});

test("A11-181: Closes with an outcome partial, the ticket still open: the board's backstop completes it, with the same note on the card", async () => {
  const made = world();
  seed(made.codeHost, PR, "Closes NBF-1\n");
  finishedOn(made, { partial: DONE_LIST });
  await made.pool.refreshTracker();
  assert.equal(made.tracker.ticketOf("NBF-1")?.status, "Done", "completed by the board, which the outcome's partial would have forbidden");
  assert.match(made.tracker.comments.map(({ text }) => text).join("\n"), /merged and its body completes NBF-1/, "and its comment does not say the body failed to close the ticket");
  const left = run(made);
  assert.deepEqual([left.closedByBoard, left.partial, left.steps, runStatus(left)], [true, undefined, undefined, "completed"]);
  assert.match(reasonOf(left).line ?? "", /^completed: a11ign\/announcement-emulator #2 merged; its outcome said Partial: ".*", but a11ign\/announcement-emulator #2 said Closes NBF-1, so the board followed the pull request$/);
});

test("A11-181: Refs with a Partial line that agrees with the outcome keeps the ticket open (A11-178's case): it is put back, step 2 is queued, and there is no disagreement to show", async () => {
  const made = world();
  seed(made.codeHost, PR, `Refs NBF-1\n\nPartial: ${STEP_ONE}\n`);
  finishedOn(made, { partial: "step 1 of 3: the same step, in other words", by: "integration" });
  await made.pool.refreshTracker();
  assert.deepEqual(made.undone, ["NBF-1"], "the integration's completion is undone");
  assert.equal(made.tracker.ticketOf("NBF-1")?.status, "In Progress");
  const queued = run(made);
  assert.deepEqual([queued.phase, queued.steps?.map(({ step }) => step), queued.partialOverruled, queued.declared], ["queued", [1], undefined, undefined], "step 2 is queued; different words for the same step are no disagreement");
  assert.equal(reasonOf(queued).line, "step 1 of 3 merged; step 2 queued");
});

test("A11-181: Refs with a Partial line against an outcome with no partial, on a run of one pull request: the pull request is followed, put back and step 2 queued, and the log says both", async () => {
  const made = world();
  seed(made.codeHost, PR, `Refs NBF-1\n\nPartial: ${STEP_ONE}\n`);
  finishedOn(made, { by: "integration" });
  const logged = await captureStderr(() => made.pool.refreshTracker());
  assert.deepEqual([made.undone, run(made).phase, run(made).steps?.map(({ step }) => step)], [["NBF-1"], "queued", [1]], "the outcome said nothing remains; the pull request did, and it decided");
  assert.ok(logged.some((line) => line.includes(`NBF-1: a11ign/announcement-emulator #2 said Partial: ${STEP_ONE}, but its outcome said nothing remains; the board followed the pull request`)), logged.join(""));
});

test("A11-181: Closes alone, with no outcome partial: Completed, nothing put back, and no note", async () => {
  const made = world();
  seed(made.codeHost, PR, "Closes NBF-1\n");
  finishedOn(made, { by: "integration" });
  await made.pool.refreshTracker();
  const left = run(made);
  assert.deepEqual([made.undone, runStatus(left), left.partialOverruled, left.declared], [[], "completed", undefined, { kind: "closes", urls: [PR] }]);
  assert.equal(reasonOf(left).line, "completed: a11ign/announcement-emulator #2 merged");
});

test("A11-181: a merged Partial the outcome did not declare, naming no step, stalls with the disagreement on the card, naming both", async () => {
  const made = world();
  seed(made.codeHost, PR, "Refs NBF-1\n\nPartial: the docs\n");
  finishedOn(made, {});
  await made.pool.refreshTracker();
  const left = run(made);
  assert.deepEqual([left.phase, runStatus(left), left.partial, left.partialOverruled], ["finished", "needs-you", "the docs", { outcome: null, pull: "Partial: the docs", urls: [PR] }]);
  assert.equal(reasonOf(left).line, "Partial merged: the docs. It names no step, so nothing was queued: Dismiss it and queue the ticket. "
    + "its outcome said nothing remains, but a11ign/announcement-emulator #2 said Partial: the docs, so the board followed the pull request");
});

test("A11-181: pull requests that finish the ticket together say Refs with free-word Partial lines and the outcome has no partial: the declaration is none, and the board completes the ticket", async () => {
  const made = world();
  seed(made.codeHost, PR, "Refs NBF-1\n\nPartial: the lab half is a11ign/lab#150\n");
  seed(made.codeHost, PR_2, "Refs NBF-1\n\nPartial: the emulator half is a11ign/announcement-emulator#2\n");
  finishedOn(made, { urls: [PR, PR_2] });
  await made.pool.refreshTracker();
  const left = run(made);
  assert.deepEqual([left.declared, left.partial, left.partialOverruled], [{ kind: "none", urls: [PR, PR_2] }, undefined, undefined]);
  assert.deepEqual([made.tracker.ticketOf("NBF-1")?.status, left.closedByBoard, runStatus(left), made.undone], ["Done", true, "completed", []]);
});

// ---- When the read cannot answer ----

test("A11-181: a merged pull request the code host cannot read, under an outcome partial: nothing is put back or queued, the card says it is reading, and the next sweep acts once it can", async () => {
  const made = world();
  finishedOn(made, { partial: STEP_ONE, by: "integration" });
  await made.pool.refreshTracker();
  const waiting = run(made);
  assert.deepEqual([made.undone, waiting.phase, waiting.declared, waiting.steps, made.tracker.ticketOf("NBF-1")?.status], [[], "finished", undefined, undefined, "Done"], "the integration's completion is not undone on words the board has not checked");
  assert.equal(runStatus(waiting), "completed", "the tracker's word, Completed, wins the card while the ticket is Done");
  const open = world();
  finishedOn(open, { partial: STEP_ONE });
  await open.pool.refreshTracker();
  assert.equal(reasonOf(run(open)).line, "reading what a11ign/announcement-emulator #2 declared (Closes or Partial:) before acting on its merge", "and a run whose ticket is not Done says what it waits on, not a silent Needs you");
  assert.deepEqual([run(open).phase, run(open).steps, runStatus(run(open))], ["finished", undefined, "needs-you"]);
  seed(open.codeHost, PR, `Refs NBF-1\n\nPartial: ${STEP_ONE}\n`);
  await open.pool.refreshTracker();
  assert.deepEqual([run(open).phase, run(open).steps?.map(({ step }) => step)], ["queued", [1]], "the next sweep reads the body and queues step 2");
  seed(made.codeHost, PR, "Closes NBF-1\n");
  await made.pool.refreshTracker();
  assert.deepEqual([made.undone, runStatus(run(made))], [[], "completed"], "and a Closes body that arrives late still leaves the ticket Done");
});

test("A11-181: a code host that throws on the read is asked again on the next sweep, as one that answers null is", async () => {
  const made = world();
  let refusing = true;
  const flaky = { ...made.codeHost, readMergedFindings: (url: string) => { if (refusing) throw new Error("gh exploded"); return made.codeHost.readMergedFindings!(url); } };
  const pool = made.restart({ source: made.source, codeHost: flaky });
  seed(made.codeHost, PR, "Closes NBF-1\n");
  finishedOn(made, { partial: DONE_LIST, by: "integration" });
  await pool.refreshTracker();
  assert.deepEqual([run(made).declared, made.undone], [undefined, []]);
  refusing = false;
  await pool.refreshTracker();
  assert.deepEqual([run(made).declared?.kind, runStatus(run(made)), made.undone], ["closes", "completed", []]);
});

test("A11-181: a run whose outcome has no partial does not wait for a read that cannot answer: the board completes it as it always did, and the read is tried again", async () => {
  const made = world();
  finishedOn(made, {});
  await made.pool.refreshTracker();
  assert.deepEqual([made.tracker.ticketOf("NBF-1")?.status, run(made).closedByBoard, run(made).declared], ["Done", true, undefined]);
  assert.deepEqual([reads(made) >= 1, declarationsDue(made.store.get()).length], [true, 1], "and it is still due a read");
});

test("A11-181: a code host that cannot read a merged pull request at all leaves the outcome in force: today's behaviour, with nothing waiting", async () => {
  const made = world();
  const blind = { ...made.codeHost, readMergedFindings: undefined };
  const pool = made.restart({ source: made.source, codeHost: blind });
  finishedOn(made, { partial: STEP_ONE, by: "integration" });
  await pool.refreshTracker();
  assert.deepEqual([made.undone, run(made).phase, run(made).steps?.map(({ step }) => step)], [["NBF-1"], "queued", [1]], "put back and queued on the outcome's words, as before");
});

// ---- The pure rules ----

const read = (url: string, declaration: ReadDeclaration["declaration"]): ReadDeclaration => ({ url, declaration });
const closes = { kind: "closes" } as const;
const partial = (remains: string) => ({ kind: "partial", remains }) as const;

test("A11-181: a run's declaration: one pull request's Partial line counts, a sibling's free words do not, and a named step always does", () => {
  assert.deepEqual(declare([read(PR, closes)], 1), { kind: "closes", urls: [PR] });
  assert.deepEqual(declare([read(PR, partial("the docs"))], 1), { kind: "partial", remains: "the docs", urls: [PR] }, "a run of one pull request");
  assert.deepEqual(declare([read(PR, partial("the lab half is lab#150")), read(PR_2, partial("the emulator half"))], 2), { kind: "none", urls: [PR, PR_2] }, "siblings that finish the ticket together");
  assert.deepEqual(declare([read(PR, partial("step 1 of 3: x")), read(PR_2, partial("step 2 of 3: y"))], 2), { kind: "partial", remains: "step 1 of 3: x", urls: [PR, PR_2] }, "a named step; the first body wins");
  assert.deepEqual(declare([read(PR, partial("the emulator half")), read(PR_2, partial("step 2 of 3: y"))], 2), { kind: "partial", remains: "step 2 of 3: y", urls: [PR, PR_2] }, "the body that names a step wins over free words");
  assert.deepEqual(declare([read(PR, closes), read(PR_2, null)], 2), { kind: "closes", urls: [PR, PR_2] }, "any body that closes it");
  assert.deepEqual(declare([read(PR, null), read(PR_2, null)], 2), { kind: "none", urls: [PR, PR_2] });
  assert.deepEqual(declare([read(PR, closes), read(PR_2, partial("step 1 of 3: x"))], 2), { kind: "partial", remains: "step 1 of 3: x", urls: [PR, PR_2] }, "a Partial line that names a step wins over a closing one, as it does within one body");
});

const queueOf = (fields: Partial<Entry>): Queue => ({ ...emptyQueue(1), entries: [{ ticket: { key: "NBF-1" }, repos: [], model: "m", effort: "e", phase: "finished", ...fields } as Entry] });
const recorded = (fields: Partial<Entry>, declared: Parameters<typeof recordDeclared>[2]): Entry => recordDeclared(queueOf(fields), "NBF-1", declared, "Closes").entries[0];

test("A11-181: what a declaration does to a run's partial, and when it is a disagreement", () => {
  const closing = { kind: "closes", urls: [PR] } as const;
  assert.deepEqual([recorded({ partial: "all of it" }, closing).partial, recorded({ partial: "all of it" }, closing).partialOverruled], [undefined, { outcome: "all of it", pull: "Closes NBF-1", urls: [PR] }], "Closes drops the outcome's partial and keeps its words");
  assert.deepEqual([recorded({}, closing).partial, recorded({}, closing).partialOverruled], [undefined, undefined], "Closes against no partial agrees");
  const stepOne = { kind: "partial", remains: "step 1 of 3: x", urls: [PR] } as const;
  assert.deepEqual([recorded({ partial: "step 1 of 3: other words" }, stepOne).partial, recorded({ partial: "step 1 of 3: other words" }, stepOne).partialOverruled], ["step 1 of 3: x", undefined], "the same step in other words: the pull request's words, no disagreement");
  assert.equal(recorded({ partial: "step 2 of 3: y" }, stepOne).partialOverruled?.pull, "Partial: step 1 of 3: x", "another step is a disagreement");
  assert.equal(recorded({ partial: "step 1 of 9: y" }, stepOne).partialOverruled?.outcome, "step 1 of 9: y", "so is another size");
  assert.equal(recorded({ partial: "the docs" }, stepOne).partialOverruled?.outcome, "the docs", "and a named step against none");
  const free = { kind: "partial", remains: "the docs", urls: [PR] } as const;
  assert.equal(recorded({ partial: "the docs and more" }, free).partialOverruled, undefined, "free words against free words agree");
  assert.deepEqual([recorded({}, free).partial, recorded({}, free).partialOverruled?.outcome], ["the docs", null], "a Partial line against an outcome with none");
  const none = { kind: "none", urls: [PR] } as const;
  assert.deepEqual([recorded({ partial: "mine" }, none).partial, recorded({ partial: "mine" }, none).partialOverruled, recorded({ partial: "mine" }, none).declared], ["mine", undefined, none], "a body that declares nothing leaves the outcome as it is");
  assert.equal(recorded({ phase: "running" } as Partial<Entry>, closing).declared, undefined, "a run that is not finished is left alone");
});

test("A11-181: what the merged pull requests declared goes with the partial it decided: a round that ends on reviewed keeps both, and a new pull request outcome or a done sets them afresh", () => {
  const held = queueOf({ partial: undefined, declared: { kind: "closes", urls: [PR] }, partialOverruled: { outcome: "all of it", pull: "Closes NBF-1", urls: [PR] } });
  const ended = (outcome: Outcome) => finish(held, "NBF-1", outcome, 20).entries[0];
  assert.deepEqual([ended({ kind: "reviewed", prs: [{ repo: "r", url: PR }] }).declared?.kind, ended({ kind: "reviewed", prs: [{ repo: "r", url: PR }] }).partialOverruled?.pull], ["closes", "Closes NBF-1"]);
  for (const outcome of [{ kind: "ready-pr", prs: [{ repo: "r", url: PR }] }, { kind: "done", reason: "nothing to build", evidence: ["e"] }] as Outcome[]) {
    assert.deepEqual([ended(outcome).declared, ended(outcome).partialOverruled], [undefined, undefined], outcome.kind);
  }
});

// ---- The card ----

const view = (fields: Partial<ViewEntry>): ViewEntry => ({ ticket: { key: "NBF-1" }, phase: "finished", outcome: { kind: "ready-pr", prs: [{ url: PR }] }, pullStates: { [PR]: "merged" }, ...fields });

test("A11-181: the card quotes the outcome's words as written, cut at a sensible length, and a run that waits says what for", () => {
  const long = "word ".repeat(60).trim();
  const line = reasonOf(view({ partialOverruled: { outcome: long, pull: "Closes NBF-1", urls: [PR] } })).line ?? "";
  assert.ok(line.includes(`Partial: "${"word ".repeat(16).trim()} …"`), line);
  assert.equal(reasonOf(view({ partial: "step 1 of 3", declared: { kind: "partial", remains: "step 1 of 3", urls: [PR] }, steps: undefined })).line, null, "a declared run with a next step to queue says nothing");
  assert.equal(reasonOf(view({ partial: "step 1 of 3" })).line, "reading what a11ign/announcement-emulator #2 declared (Closes or Partial:) before acting on its merge");
});

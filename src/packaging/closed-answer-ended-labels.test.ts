// no-token: gh -- every `gh` here is the injected `run` seam `readClosedAnswerRows` takes; nothing reaches the real one, and herdr and the ledgers are the injected `goneTest`
/**
 * agent-org#1636: THE CLOSED ANSWER READ DOES NOT ASK FOR AN ENDED SESSION'S LABEL.
 *
 * One alias per `answer:` label costs one GraphQL point per label per kind, and the label list only grows (34 in the home repository, 27 of them ended sessions': measured
 * 2026-10-17, 34 points for the issues read and 34 for the pull requests', every tick, which made `repository.issues` 55% of the scheduler's hour). A label of an ended session is
 * taken off every row afterwards (`withoutEndedAnswerSessions`), so the aliases for them bought nothing.
 *
 * Each case below has its control: the same labels with no `goneTest` ask for all of them, and a `goneTest` that cannot say (`null`, herdr or the ledgers unreadable) asks
 * for all of them too, so the cut is the test's and not an empty read's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readClosedAnswerRows, withoutEndedAnswerSessions } from "../work-gate/causes/rows-answers.ts";
import { readOpenRowFollowUps } from "../work-gate.ts";
import { KEPT_ANSWERS_MAX_AGE_MS, type ConditionalReads } from "../work-gate/reads/exit.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { closedAnswerConnection, readsClosedAnswerRows } from "./rows-by-label-fixtures.ts";

const LABELS = ["answer:ceo", "answer:worker-8", "answer:worker-9", "answer:engineers", "answer:reviewer-1"];
const ENDED = new Set(["worker-8", "worker-9"]);
const ended = () => (session: string) => session !== "engineers" && ENDED.has(session);

/** A `run` answering the label list, then every closed read with `rows`; the graphql reads it was asked are kept. */
function fakeRun(rows: Parameters<typeof closedAnswerConnection>[0] = []) {
  const asked: NonNullable<ReturnType<typeof readsClosedAnswerRows>>[] = [];
  const run = (args: string[]) => {
    if (args[0] === "label") return JSON.stringify(LABELS.map((name) => ({ name })));
    const read = readsClosedAnswerRows(args);
    if (read === null) throw new Error(`unexpected call: ${args.join(" ")}`);
    asked.push(read);
    return closedAnswerConnection(read.kind === "issues" ? rows : []);
  };
  return { run, asked };
}

test("#1636: the issues and the pull requests are asked for the labels of sessions that have not ended, and only those", () => {
  const { run, asked } = fakeRun();
  assert.deepEqual(readClosedAnswerRows(run, ended), []);
  assert.deepEqual(asked.map((read) => read.kind), ["issues", "pullRequests"]);
  for (const read of asked) assert.deepEqual(read.names, ["answer:ceo", "answer:engineers", "answer:reviewer-1"], "`engineers` is never ended and a session no ledger names is not");
});

test("#1636 CONTROL: with no goneTest, or one that cannot say, every label is asked for", () => {
  for (const goneTest of [undefined, () => null]) {
    const { run, asked } = fakeRun();
    assert.deepEqual(readClosedAnswerRows(run, goneTest), []);
    assert.equal(asked.length, 2);
    for (const read of asked) assert.deepEqual(read.names, LABELS);
  }
});

test("#1636: when every label is an ended session's nothing is read, and the answer is nobody owes (not the refusal `null`)", () => {
  const { run, asked } = fakeRun();
  assert.deepEqual(readClosedAnswerRows(run, () => () => true), []);
  assert.deepEqual(asked, []);
});

test("#1636: a row carrying a live label and an ended one still comes back, and the later pass takes only the ended label off it", () => {
  const row = { number: 7, title: "t", state: "CLOSED", labels: ["answer:ceo", "answer:worker-8"] };
  const { run } = fakeRun([row]);
  const rows = readClosedAnswerRows(run, ended) as { number: number; labels: { name: string; }[]; }[];
  assert.deepEqual(rows.map((r) => r.number), [7]);
  const kept = withoutEndedAnswerSessions(rows, { agents: () => ["ceo"], ended: () => new Map([["worker-8", 1]]), say: () => {} });
  assert.deepEqual(kept[0].labels.map((l: { name?: string; } | string) => (typeof l === "string" ? l : l.name)), ["answer:ceo"]);
});

/** The conditional a live gate has, over a scratch directory and a clock the test moves. */
function keptOn(dir: string, now: number): ConditionalReads {
  return { ask: () => { throw new Error("the answer read asks through `run`, not `ask`"); }, dir, now, repo: "a11ign/agent-org" } as unknown as ConditionalReads;
}

test("#1636: the closed answer read is kept for the same labels, asked again after the age, and a refusal is never kept", () => {
  const dir = tmpDir("kept-answers-");
  const row = { number: 7, title: "t", state: "CLOSED", labels: ["answer:ceo"] };
  const { run, asked } = fakeRun([row]);
  const t0 = 1_000_000;
  assert.deepEqual((readClosedAnswerRows(run, ended, keptOn(dir, t0)) as { number: number; }[]).map((r) => r.number), [7]);
  const first = asked.length;
  assert.ok(first > 0);
  // Same labels, inside the age: answered from the keep, no graphql asked.
  assert.deepEqual((readClosedAnswerRows(run, ended, keptOn(dir, t0 + KEPT_ANSWERS_MAX_AGE_MS - 1)) as { number: number; }[]).map((r) => r.number), [7]);
  assert.equal(asked.length, first);
  // At the age: asked again.
  readClosedAnswerRows(run, ended, keptOn(dir, t0 + KEPT_ANSWERS_MAX_AGE_MS));
  assert.equal(asked.length, 2 * first);
  // Other labels (nothing ended): asked again, whatever the age.
  readClosedAnswerRows(run, null, keptOn(dir, t0 + KEPT_ANSWERS_MAX_AGE_MS + 1));
  assert.ok(asked.length > 2 * first);
});

test("#1636: a refused closed answer read is not kept, and no conditional (a test's run, the rehearsal) keeps nothing", () => {
  const dir = tmpDir("kept-answers-");
  let refuse = true;
  const asked: string[][] = [];
  const run = (args: string[]) => {
    asked.push(args);
    if (args[0] === "label") return JSON.stringify(LABELS.map((name) => ({ name })));
    if (refuse) return "not json";
    return closedAnswerConnection([]);
  };
  assert.equal(readClosedAnswerRows(run, ended, keptOn(dir, 5)), null);
  refuse = false;
  const before = asked.length;
  assert.deepEqual(readClosedAnswerRows(run, ended, keptOn(dir, 6)), []);
  assert.ok(asked.length > before + 1, "the refusal was not kept: the graphql reads were asked again");
  const n = asked.length;
  readClosedAnswerRows(run, ended, null);
  readClosedAnswerRows(run, ended, null);
  assert.ok(asked.length >= n + 2 * 3, "with no conditional every call asks");
});

test("#1636: the follow-ups ask for the closed answers by the herdr listing they already hold, never a second read of herdr", () => {
  const { run, asked } = fakeRun([]);
  let listings = 0;
  const listing = () => { listings++; return [{ label: "ceo", status: "idle" }, { label: "worker-8", status: "idle" }, { label: "reviewer-1", status: "idle" }]; };
  // worker-9 is absent from the listing AND recorded ended; worker-8 is recorded ended but LISTED, so it is live and still asked for.
  readOpenRowFollowUps([], run, undefined, listing, () => new Map([["worker-8", 1], ["worker-9", 1]]));
  assert.equal(listings, 1);
  const labels = new Set(asked.flatMap((read) => read.names));
  assert.ok(labels.has("answer:worker-8"), "a listed session is live whatever the ledger says");
  assert.ok(!labels.has("answer:worker-9"), "an unlisted ended session is not asked for");
  // A listing that failed classifies nothing as gone: every label is asked for.
  const none = fakeRun([]);
  readOpenRowFollowUps([], none.run, undefined, () => null, () => new Map([["worker-9", 1]]));
  assert.ok(new Set(none.asked.flatMap((read) => read.names)).has("answer:worker-9"));
});

// no-token: none -- queues built with the board's own transitions
// A11-298: a queued review round whose pull request merged or closed holds nothing, and a round left with no open pull request is dropped
import { test } from "node:test";
import assert from "node:assert/strict";
import { overlapWait } from "../board-view/overlap-hold.ts";
import { runStatus } from "../board-view/pull-status-and-notes.ts";
import { openPulls } from "../board-view/view-types-and-filters.ts";
import { finishedWith, ticketOf } from "../kept-pulls-fixture.ts";
import { enqueue, find, replace, reviewRound, type Entry, type Queue } from "./queue-entries-and-outcomes.ts";
import { nextStepRuns, queueNextStep } from "./queue-next-step.ts";
import { settleRoundPulls } from "./queue-round-pulls.ts";
import { resumeQueue } from "./queue-transitions.ts";
import { logOf } from "./run-log.ts";

const REPO = "announcement-emulator";
const PULL_18 = `https://github.com/a11ign/${REPO}/pull/18`;
const PULL_19 = `https://github.com/a11ign/${REPO}/pull/19`;
const KEY = "A11-232";
const NOW = 1_000_000;

/** `KEY` finished on `urls` and queued again as a review round on them, as the watch queues one for feedback. `more` is set on the finished run first. */
function roundOn(urls: readonly string[], more: Partial<Entry> = {}, partial?: string): Queue {
  const prs = urls.map((url) => ({ repo: REPO, url }));
  const finished = finishedWith(KEY, { kind: "ready-pr", prs, ...(partial === undefined ? {} : { partial }) }, NOW - 100);
  return replace(finished, KEY, (entry) => ({ ...reviewRound({ ...entry, ...more }, prs, NOW - 50), pullFiles: { [PULL_18]: ["middleware/package.json"] } }));
}

test("A11-298: a pull request that merged leaves the round's review and stops counting, and the one still open stays", () => {
  const settled = settleRoundPulls(roundOn([PULL_18, PULL_19]), KEY, { [PULL_18]: "merged", [PULL_19]: "open" }, NOW);
  const round = find(settled, KEY)!;
  assert.deepEqual([round.phase, round.review?.map(({ url }) => url)], ["queued", [PULL_19]]);
  assert.deepEqual(openPulls(round).map(({ url }) => url), [PULL_19]);
  assert.deepEqual(logOf(settled, KEY).filter((event) => event.kind === "merged").map((event) => (event.kind === "merged" ? event.url : "")), [PULL_18]);
});

test("A11-298: a round whose only pull request merged holds nothing: the ticket queued behind its files is no longer held", () => {
  const waiting = { ...resumeQueue(enqueue(roundOn([PULL_18]), [ticketOf("A11-229")], { model: "sonnet", effort: "high" }, 1)) };
  const queue = replace(waiting, "A11-229", (entry) => ({ ...entry, paths: [`${REPO}:middleware/package.json`] }));
  assert.equal(overlapWait(find(queue, "A11-229")!, queue.entries)?.key, KEY, "held while #18 is taken to be open: the incident");
  const settled = settleRoundPulls(queue, KEY, { [PULL_18]: "merged" }, NOW);
  assert.equal(overlapWait(find(settled, "A11-229")!, settled.entries), null, "and free once it is read merged");
});

test("A11-298: a round left with no open pull request is dropped to the finished run it continued, which the sweep completes", () => {
  const settled = settleRoundPulls(roundOn([PULL_18]), KEY, { [PULL_18]: "merged" }, NOW);
  const run = find(settled, KEY)!;
  assert.deepEqual([run.phase, run.outcome, run.pullStates, run.finishedAt], ["finished", { kind: "reviewed", prs: [{ repo: REPO, url: PULL_18 }] }, { [PULL_18]: "merged" }, NOW]);
  assert.equal(runStatus(run, settled.entries), "completed");
  assert.equal(logOf(settled, KEY).filter((event) => event.kind === "merged").length, 1, "the merge is logged once");
});

test("A11-298: a round whose pull requests were all closed unmerged is dropped as a cancelled run, not a completed one", () => {
  const settled = settleRoundPulls(roundOn([PULL_18, PULL_19]), KEY, { [PULL_18]: "closed", [PULL_19]: "closed" }, NOW);
  assert.equal(runStatus(find(settled, KEY)!, settled.entries), "cancelled");
});

test("A11-298: a dropped round of a partial run is queued for its next step once the merged body is read", () => {
  const dropped = settleRoundPulls(roundOn([PULL_18], {}, "step 2 of 3"), KEY, { [PULL_18]: "merged" }, NOW);
  const read = replace(dropped, KEY, (entry) => ({ ...entry, declared: { kind: "partial", remains: "step 2 of 3", urls: [PULL_18] } }));
  const [{ entry, step }] = nextStepRuns(read);
  assert.equal(entry.ticket.key, KEY);
  const queued = find(queueNextStep(read, KEY, step, NOW + 1), KEY)!;
  assert.deepEqual([queued.phase, queued.review], ["queued", undefined]);
});

test("A11-298: a round whose pull requests are all open, or a run that is no queued round, is left as it is", () => {
  const open = roundOn([PULL_18]);
  assert.equal(settleRoundPulls(open, KEY, { [PULL_18]: "open" }, NOW), open);
  assert.equal(settleRoundPulls(open, KEY, {}, NOW), open, "a state the host could not say changes nothing");
  const talk = replace(open, KEY, (entry) => ({ ...entry, talk: true }));
  assert.equal(settleRoundPulls(talk, KEY, { [PULL_18]: "merged" }, NOW), talk, "a talk session is a person's, and keeps the pull requests it borrowed");
  const finished = finishedWith(KEY, { kind: "ready-pr", prs: [{ repo: REPO, url: PULL_18 }] }, NOW);
  assert.equal(settleRoundPulls(finished, KEY, { [PULL_18]: "merged" }, NOW), finished, "a finished run's pull requests are the tracker sweep's");
});

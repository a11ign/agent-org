// no-token: gh -- the code host, herdr and the clock are all injected fakes; nothing is spawned
// module: a pull request the merge queue removes is answered, not left for a person to find approved and not merged (A11-264)
//
// The pull request is a11ign/announcement-emulator#18 (A11-232) of 2026-10-25: approved, `gate` green on its head, removed three times for `failed_checks` because a check that came to the base with another pull request fails only on the merged result.
// The `merge_group` run, its jobs and the job's log are the ones GitHub gave (trimmed). `answerQueue` is asked directly with the fake code host's answers, and `watchFeedback` runs over `pool-fixture.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost, queueFailureKey } from "../plugins/fakes/code-host.ts";
import type { PullFeedback, QueueFailure, QueueRemoval } from "../plugins/contracts/code-host.ts";
import { queueNote } from "./board-view/run-reason.ts";
import type { QueueHead } from "./board-view/queue-head.ts";
import { poolFixture } from "./pool-fixture.ts";
import { answerQueue, HOLD_AFTER } from "./pool-merge-queue.ts";
import type { PoolContext } from "./pool-context.ts";
import type { Entry, Outcome } from "./queue/queue-entries-and-outcomes.ts";

const REPO = "a11ign/announcement-emulator";
const URL = `https://github.com/${REPO}/pull/18`;
const HEAD = "c3f2b457e09fb02e0e46763028d538694c498674";
const PUSHED = "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3";
const GROUPS = ["3a79176dacf2b6c34571d8c490daf1cb946dee88", "a2aa4d8cc7e64b33c6946186251f6c881f8bced8", "79fda13836b308534d7d3672e7cc859d75bad1f3"];
const RUN = 40192667644;
const RUN_URL = `https://github.com/${REPO}/actions/runs/${RUN}`;
const MIDDLEWARE = `${RUN_URL}/job/121166812239`;
const GATE = `${RUN_URL}/job/121166918201`;
const STEP = "The Dependabot config is what the toolchain generates";

const stamped = (lines: string[]) => lines.map((line) => `2026-10-25T12:20:40.8590310Z ${line}`).join("\n");
/** The tail of the `middleware` job's log: the check that came to the base with A11-253 and fails only on the merged result. */
const DRIFT = stamped(["##[group]Run pnpm exec dependabot-config --check --root ..", "dependabot-config: FAIL .github/dependabot.yml drifted from the template (- committed, + generated):",
  '+       - dependency-name: "@a11ign/announcement-emulator"', "dependabot-config: run `dependabot-config --write --root ..` (`pnpm exec dependabot-config --write` in the repository) and commit .github/dependabot.yml", "##[error]Process completed with exit code 1."]);
const RUNNER_LOST = stamped(["Run npm test", "##[error]The hosted runner lost communication with the server.", "##[error]Process completed with exit code 143."]);

const removal = (n: 0 | 1 | 2, over: Partial<QueueRemoval> = {}): QueueRemoval =>
  ({ at: Date.parse(["2026-10-25T11:59:08Z", "2026-10-25T12:19:35Z", "2026-10-25T12:21:15Z"][n]), reason: "failed_checks", actor: "github-merge-queue", groupCommit: GROUPS[n], ...over });
const failure = (jobs: QueueFailure["jobs"] = [{ name: "middleware", step: STEP, detailsUrl: MIDDLEWARE }, { name: "gate", step: "Every job ran, and ran clean", detailsUrl: GATE }]): QueueFailure => ({ runId: RUN, runUrl: RUN_URL, jobs });

/** The pull request's feedback at `head`, its checks green, with what the queue did. */
const feedback = (queue: PullFeedback["queue"], over: Partial<PullFeedback> = {}): PullFeedback => ({
  state: "open", feedbackAt: null, authors: [], failing: [], failures: [], failedAt: null, conflicting: false, mergeable: true, head: HEAD, approvedAtHead: true, base: "main",
  files: ["emu/a.py"], filesComplete: true, ...(queue === undefined ? {} : { queue }), ...over,
});
const removedFrom = (...removals: QueueRemoval[]) => ({ queued: false, removals });
const entryWith = (queueHeads?: Record<string, QueueHead>): Entry => ({ ticket: { key: "A11-232" }, phase: "finished", outcome: { kind: "reviewed", prs: [{ repo: "announcement-emulator", url: URL }] }, ...(queueHeads === undefined ? {} : { queueHeads }) }) as unknown as Entry;

/** A code host that holds the failing run behind the removals (by merge group) and the logs of its jobs, with the pool context `answerQueue` is asked over. */
function world(over: { runs?: (QueueFailure | null)[]; logs?: Record<string, string> } = {}) {
  const host = createFakeCodeHost();
  host.seedPull(REPO, 18, { head: HEAD });
  (over.runs ?? [failure(), failure(), failure()]).forEach((run, n) => { if (run !== null) host.queues.failures.set(queueFailureKey(URL, GROUPS[n]), run); });
  for (const [url, text] of Object.entries(over.logs ?? { [MIDDLEWARE]: DRIFT, [GATE]: stamped(["a job reported 'failure', not success"]) })) host.checksAndClaims.logs.set(url, text);
  return { host, ctx: { codeHost: host } as unknown as PoolContext };
}
const asked = (host: ReturnType<typeof createFakeCodeHost>, operation: string) => host.calls.filter((call) => call.startsWith(operation));

test("A11-264: a failed_checks removal starts a round with the merge_group run's errors", () => {
  const { ctx, host } = world();
  const answer = answerQueue(ctx, entryWith(), [{ url: URL, read: feedback(removedFrom(removal(0))) }]);
  assert.equal(answer.feedback, [
    `${URL} was removed from the merge queue at 2026-10-25T11:59:08Z because its merge_group run failed (${RUN_URL}). The failure is on the result of merging it with main, not on its own head, whose checks are green.`,
    `middleware failed at step "${STEP}":`,
    "  dependabot-config: FAIL .github/dependabot.yml drifted from the template (- committed, + generated):",
    "Merge main in, reproduce the failure, fix it, and push.",
  ].join("\n"), "the failing job and step, its error lines, that it is the merged result's, and what to do; the roll-up gate behind it is left out");
  assert.equal(answer.conflict, null);
  assert.deepEqual(answer.heads, { [URL]: { head: HEAD, step: "round", removals: 1, jobs: ["middleware"] } });
  assert.deepEqual(answer.withoutRound, {}, "and a round that is not queued is not recorded as answered");
  assert.deepEqual(asked(host, "readQueueFailure"), [`readQueueFailure ${URL} ${GROUPS[0]}`], "the run behind that removal's merge group");
  assert.deepEqual(host.queues.holds, [], "one removal holds nothing");
});

test("A11-264: the round is briefed with the roll-up gate alone when no other job failed, and says when the run or a log could not be read", () => {
  const onlyGate = world({ runs: [failure([{ name: "gate", step: "Every job ran, and ran clean", detailsUrl: GATE }])] });
  const gate = answerQueue(onlyGate.ctx, entryWith(), [{ url: URL, read: feedback(removedFrom(removal(0))) }]);
  assert.match(gate.feedback ?? "", /^gate failed at step "Every job ran, and ran clean":$/m);
  const noRun = world({ runs: [null] });
  const unread = answerQueue(noRun.ctx, entryWith(), [{ url: URL, read: feedback(removedFrom(removal(0))) }]);
  assert.match(unread.feedback ?? "", /because its merge_group run failed\. The failure is on the result of merging it with main[^\n]*\nIts merge_group run could not be read, so the failing job is not named\.\nMerge main in/);
  assert.equal(unread.heads[URL]?.step, "round", "the round still starts");
  const noLog = world({ logs: {} });
  assert.match(answerQueue(noLog.ctx, entryWith(), [{ url: URL, read: feedback(removedFrom(removal(0))) }]).feedback ?? "", /^middleware failed at step "The Dependabot config is what the toolchain generates"; its log could not be read\.$/m);
  const noJobs = world({ runs: [failure([])] });
  assert.match(answerQueue(noJobs.ctx, entryWith(), [{ url: URL, read: feedback(removedFrom(removal(0))) }]).feedback ?? "", /^The run names no failing job\.$/m);
});

test("A11-264: the brief says its own head is red too when it is, and leaves the head's checks to the red-check round", () => {
  const { ctx } = world();
  const red = feedback(removedFrom(removal(0)), { failing: ["test"], failures: [{ name: "test", detailsUrl: null }] });
  const brief = answerQueue(ctx, entryWith(), [{ url: URL, read: red }]).feedback ?? "";
  assert.match(brief, /not on its own head\.\n/, "it does not claim the head's checks are green");
});

test("A11-264: every failed job failing for an infrastructure reason is named on the card, with no round and no rerun", () => {
  const { ctx, host } = world({ logs: { [MIDDLEWARE]: RUNNER_LOST }, runs: [failure([{ name: "middleware", step: STEP, detailsUrl: MIDDLEWARE }])] });
  const answer = answerQueue(ctx, entryWith(), [{ url: URL, read: feedback(removedFrom(removal(0))) }]);
  assert.equal(answer.feedback, null);
  assert.deepEqual(answer.heads[URL], { head: HEAD, step: "named", removals: 1, jobs: ["middleware"], note: "removed from the merge queue: middleware failed for an infrastructure reason (a runner was lost or a rate limit was hit)" });
  assert.deepEqual(answer.withoutRound, answer.heads, "and the record is kept without a round, so the card names it");
  assert.deepEqual(host.checksAndClaims.reruns, [], "a rerun does not put a pull request back in the queue, so nothing is rerun");
});

test("A11-264: a job the code failed gets the round, and a job the infrastructure failed beside it is named in it", () => {
  const { ctx } = world({ logs: { [MIDDLEWARE]: DRIFT, [GATE]: RUNNER_LOST }, runs: [failure([{ name: "middleware", step: STEP, detailsUrl: MIDDLEWARE }, { name: "lint", step: null, detailsUrl: GATE }])] });
  const brief = answerQueue(ctx, entryWith(), [{ url: URL, read: feedback(removedFrom(removal(0))) }]).feedback ?? "";
  assert.match(brief, /^middleware failed at step /m);
  assert.match(brief, /^lint also failed in the merge group for an infrastructure reason \(a runner was lost or a rate limit was hit\): that is not a fault in your change, so leave it\.$/m);
});

test("A11-264: a repeat without a new push does not re-arm", () => {
  const { ctx, host } = world();
  const read = feedback(removedFrom(removal(0), removal(1), removal(2)));
  const answered: Record<string, QueueHead> = { [URL]: { head: HEAD, step: "round", removals: 1, jobs: ["middleware"] } };
  const third = answerQueue(ctx, entryWith(answered), [{ url: URL, read }]);
  assert.deepEqual([third.feedback, third.conflict], [null, null], "no second round for a head the board answered");
  assert.deepEqual(host.queues.holds, [{ url: URL, on: true }], "the pull request is held from the arm bot");
  assert.deepEqual(third.heads[URL], { head: HEAD, step: "held", removals: 3, jobs: ["middleware"], held: true, note: "removed from the merge queue 3 times: middleware" });
  assert.deepEqual(third.withoutRound, third.heads);
  assert.deepEqual(asked(host, "readQueueFailure"), [`readQueueFailure ${URL} ${GROUPS[2]}`], "the jobs are those of the newest removal's run");
  const again = answerQueue(ctx, entryWith(third.heads), [{ url: URL, read }]);
  assert.deepEqual([again.heads, host.queues.holds.length, asked(host, "readQueueFailure").length], [third.heads, 1, 1], "the next watch asks nothing more and holds nothing twice");
  assert.equal(HOLD_AFTER, 3, "more than twice is the third");
});

test("A11-264: two removals hold nothing, and the count on the record follows the removals", () => {
  const { ctx, host } = world();
  const answered: Record<string, QueueHead> = { [URL]: { head: HEAD, step: "round", removals: 1, jobs: ["middleware"] } };
  const second = answerQueue(ctx, entryWith(answered), [{ url: URL, read: feedback(removedFrom(removal(0), removal(1))) }]);
  assert.deepEqual([second.feedback, host.queues.holds, second.heads[URL]], [null, [], { head: HEAD, step: "round", removals: 2, jobs: ["middleware"] }]);
});

test("A11-264: a third removal found at the first look starts the round and holds the pull request", () => {
  const { ctx, host } = world();
  const answer = answerQueue(ctx, entryWith(), [{ url: URL, read: feedback(removedFrom(removal(0), removal(1), removal(2))) }]);
  assert.match(answer.feedback ?? "", /^middleware failed at step /m, "the newest removal's run is the round's");
  assert.deepEqual(host.queues.holds, [{ url: URL, on: true }]);
  assert.deepEqual(answer.heads[URL], { head: HEAD, step: "held", removals: 3, jobs: ["middleware"], held: true, note: "removed from the merge queue 3 times: middleware" });
  assert.deepEqual(answer.withoutRound, {}, "the round is not recorded as answered until it is queued");
});

test("A11-264: a hold the code host refuses is said on the card and asked for again on the next watch", () => {
  const { ctx, host } = world();
  host.queues.holdRefusal = "Resource not accessible by integration (HTTP 403)";
  const answered: Record<string, QueueHead> = { [URL]: { head: HEAD, step: "round", removals: 1, jobs: ["middleware"] } };
  const read = feedback(removedFrom(removal(0), removal(1), removal(2)));
  const refused = answerQueue(ctx, entryWith(answered), [{ url: URL, read }]);
  assert.deepEqual(refused.heads[URL], { head: HEAD, step: "held", removals: 3, jobs: ["middleware"], held: false,
    note: "removed from the merge queue 3 times: middleware, and could not be held from the queue (Resource not accessible by integration (HTTP 403))" });
  host.queues.holdRefusal = null;
  const retried = answerQueue(ctx, entryWith(refused.heads), [{ url: URL, read }]);
  assert.deepEqual([retried.heads[URL]?.held, retried.heads[URL]?.note, host.queues.holds], [true, "removed from the merge queue 3 times: middleware", [{ url: URL, on: true }]]);
  const plain = { ...host, holdFromQueue: undefined } as unknown as PoolContext["codeHost"];
  assert.match(answerQueue({ codeHost: plain } as PoolContext, entryWith(answered), [{ url: URL, read }]).heads[URL]?.note ?? "", /could not be held from the queue \(the code host cannot hold a pull request\)/, "a code host that cannot hold says so");
});

test("A11-264: the hold lifts when the head changes", () => {
  const { ctx, host } = world();
  const held: Record<string, QueueHead> = { [URL]: { head: HEAD, step: "held", removals: 3, jobs: ["middleware"], held: true, note: "removed from the merge queue 3 times: middleware" } };
  host.queues.held.add(URL);
  const same = answerQueue(ctx, entryWith(held), [{ url: URL, read: feedback(removedFrom(removal(0), removal(1), removal(2))) }]);
  assert.deepEqual([same.heads, host.queues.holds], [held, []], "the same head keeps the hold, and asks nothing");
  const moved = answerQueue(ctx, entryWith(held), [{ url: URL, read: feedback(removedFrom(), { head: PUSHED }) }]);
  assert.deepEqual(host.queues.holds, [{ url: URL, on: false }], "the label is taken off");
  assert.deepEqual([moved.heads, moved.feedback, moved.conflict], [{}, null, null], "and the record is dropped");
  assert.deepEqual([...host.queues.held], [], "the pull request is no longer held");
});

test("A11-264: a hold that cannot be lifted keeps the record, says so on the card, and is asked for again on the next watch", () => {
  const { ctx, host } = world();
  const held: Record<string, QueueHead> = { [URL]: { head: HEAD, step: "held", removals: 3, jobs: ["middleware"], held: true, note: "removed from the merge queue 3 times: middleware" } };
  host.queues.holdRefusal = "Resource not accessible by integration (HTTP 403)";
  const stuck = answerQueue(ctx, entryWith(held), [{ url: URL, read: feedback(removedFrom(), { head: PUSHED }) }]);
  assert.deepEqual(stuck.heads[URL], { ...held[URL], note: "removed from the merge queue 3 times: middleware, and the hold could not be lifted after the push (Resource not accessible by integration (HTTP 403))" });
  host.queues.holdRefusal = null;
  const lifted = answerQueue(ctx, entryWith(stuck.heads), [{ url: URL, read: feedback(removedFrom(), { head: PUSHED }) }]);
  assert.deepEqual([lifted.heads, host.queues.holds], [{}, [{ url: URL, on: false }]]);
});

test("A11-264: a head that moved off a record that held nothing drops it without touching the label, and answers a removal at the new head afresh", () => {
  const { ctx, host } = world();
  const answered: Record<string, QueueHead> = { [URL]: { head: HEAD, step: "round", removals: 1, jobs: ["middleware"] } };
  const quiet = answerQueue(ctx, entryWith(answered), [{ url: URL, read: feedback(removedFrom(), { head: PUSHED }) }]);
  assert.deepEqual([quiet.heads, host.queues.holds], [{}, []]);
  const removedAgain = answerQueue(ctx, entryWith(answered), [{ url: URL, read: feedback(removedFrom(removal(2)), { head: PUSHED }) }]);
  assert.match(removedAgain.feedback ?? "", /^middleware failed at step /m, "a removal after the push is a new head's, and starts a round");
  assert.equal(removedAgain.heads[URL]?.head, PUSHED);
});

test("A11-264: a head only named for another reason is still owed the round a removal for failed checks gets", () => {
  const { ctx } = world();
  const manual = answerQueue(ctx, entryWith(), [{ url: URL, read: feedback(removedFrom(removal(0, { reason: "manual", actor: "a-person", groupCommit: null }))) }]);
  assert.equal(manual.feedback, null);
  const then = answerQueue(ctx, entryWith(manual.heads), [{ url: URL, read: feedback(removedFrom(removal(0, { reason: "manual", actor: "a-person", groupCommit: null }), removal(1))) }]);
  assert.match(then.feedback ?? "", /^middleware failed at step /m, "the failed removal after it starts the round");
  assert.deepEqual(then.heads[URL], { head: HEAD, step: "round", removals: 1, jobs: ["middleware"] });
  const infra = world({ logs: { [MIDDLEWARE]: RUNNER_LOST }, runs: [failure([{ name: "middleware", step: STEP, detailsUrl: MIDDLEWARE }])] });
  const named = answerQueue(infra.ctx, entryWith(), [{ url: URL, read: feedback(removedFrom(removal(0))) }]);
  assert.equal(answerQueue(infra.ctx, entryWith(named.heads), [{ url: URL, read: feedback(removedFrom(removal(0), removal(1))) }]).feedback, null, "a head named for an infrastructure failure is not owed one");
});

test("A11-264: a conflict removal starts a conflict round", () => {
  const { ctx, host } = world();
  const conflicting = removal(0, { reason: "merge_conflict", groupCommit: null });
  const answer = answerQueue(ctx, entryWith(), [{ url: URL, read: feedback(removedFrom(conflicting)) }]);
  assert.equal(answer.feedback, null, "it is a conflict, not red checks");
  assert.equal(answer.conflict, [`${URL} conflicts with its base branch main.`, "The merge queue removed it at 2026-10-25T11:59:08Z because of it (merge_conflict). Merge main in, resolve the conflict, and push."].join("\n"),
    "the sentence a conflict round is recognised by, then why the queue named it");
  assert.deepEqual(answer.heads[URL], { head: HEAD, step: "round", removals: 0 });
  assert.deepEqual(answer.withoutRound, {});
  assert.deepEqual([asked(host, "readQueueFailure"), host.queues.holds], [[], []], "no run is read for a conflict");
  const repeat = answerQueue(ctx, entryWith(answer.heads), [{ url: URL, read: feedback(removedFrom(conflicting)) }]);
  assert.deepEqual([repeat.conflict, repeat.heads], [null, answer.heads], "and once for the head");
});

test("A11-264: another reason is named on the card", () => {
  const { ctx, host } = world();
  for (const [reason, actor, note] of [
    ["timeout", "github-merge-queue", "removed from the merge queue: timeout"],
    ["a_new_reason", null, "removed from the merge queue: a_new_reason"],
    ["manual", "a-person", "removed from the merge queue by a-person: manual"],
  ] as const) {
    const answer = answerQueue(ctx, entryWith(), [{ url: URL, read: feedback(removedFrom(removal(0, { reason, actor, groupCommit: null }))) }]);
    assert.deepEqual([answer.feedback, answer.conflict], [null, null], `${reason}: no round`);
    assert.deepEqual(answer.heads[URL], { head: HEAD, step: "named", removals: 0, note }, reason);
    assert.deepEqual(answer.withoutRound, answer.heads, `${reason}: the record is kept without a round`);
  }
  assert.deepEqual([asked(host, "readQueueFailure"), host.queues.holds], [[], []]);
});

test("A11-264: a host that does not say what the queue did, a pull request in the queue, and one no longer open change nothing the entry holds", () => {
  const { ctx, host } = world();
  const kept: Record<string, QueueHead> = { [URL]: { head: HEAD, step: "held", removals: 3, held: true, note: "removed from the merge queue 3 times" } };
  assert.deepEqual(answerQueue(ctx, entryWith(kept), [{ url: URL, read: feedback(undefined, { head: PUSHED }) }]).heads, kept, "no timeline is not no removals: the hold stays, and nothing is lifted");
  assert.deepEqual(answerQueue(ctx, entryWith(kept), [{ url: URL, read: feedback({ queued: true, removals: [removal(0)] }) }]).heads, kept, "in the queue now: nothing to answer");
  assert.deepEqual(answerQueue(ctx, entryWith(kept), []).heads, {}, "a pull request that is no longer open is dropped");
  assert.deepEqual([asked(host, "readQueueFailure"), host.queues.holds], [[], []]);
});

// -- The pool: the answers of `answerQueue` as `watchFeedback` carries them out. --

const NOW = 1_000_000;
const PR = { repo: "announcement-emulator", url: URL };

/** A finished run NBF-1 holding pull request 18, over a pool on the fake code host: `ended` is how its run ended, and `over` what the entry also holds. */
function finishedRun(outcome: Outcome, over: Partial<Entry> = {}, seed: (host: ReturnType<typeof createFakeCodeHost>) => void = () => undefined) {
  const fixture = poolFixture({ keys: ["NBF-1"], tickets: { drafts: false }, now: () => NOW });
  const host = createFakeCodeHost("worker-bot");
  host.seedPull(REPO, 18, { head: HEAD });
  host.checksAndClaims.logs.set(MIDDLEWARE, DRIFT);
  host.checksAndClaims.logs.set(GATE, stamped(["a job reported 'failure', not success"]));
  GROUPS.forEach((group, n) => host.queues.failures.set(queueFailureKey(URL, group), failure()));
  seed(host);
  const queue = fixture.store.get();
  fixture.store.set({ ...queue, entries: [{ ...queue.entries[0], phase: "finished", finishedAt: NOW / 2, outcome, ...over }] });
  return { fixture, host, pool: fixture.restart({ codeHost: host }), entry: () => fixture.store.get().entries[0] };
}
const seedQueue = (removals: QueueRemoval[], head = HEAD) => (host: ReturnType<typeof createFakeCodeHost>) => { Object.assign(host.pullAt(URL)!, { head, queue: removedFrom(...removals) }); };
const readyPr = { kind: "ready-pr", prs: [PR] } as Outcome;
const needsHuman = { kind: "needs-human", reason: "which colour?" } as Outcome;
/** What a run that asked a question after a round holds: the pull request it answered, as its `review`. */
const afterRound: Partial<Entry> = { review: [PR] };

test("A11-264: a run Ready to merge whose pull request the queue removed gets a round that names the merge_group run's errors, and the head is recorded as answered", () => {
  const run = finishedRun(readyPr, {}, seedQueue([removal(0)]));
  run.pool.watchFeedback();
  const entry = run.entry();
  assert.equal(entry.rounds, 1, "one round");
  assert.deepEqual(entry.review, [PR], "for the pull request");
  assert.match(entry.feedback ?? "", new RegExp(`^${URL} was removed from the merge queue at 2026-10-25T11:59:08Z because its merge_group run failed \\(${RUN_URL}\\)\\.`));
  assert.match(entry.feedback ?? "", /^middleware failed at step "The Dependabot config is what the toolchain generates":\n  dependabot-config: FAIL /m);
  assert.deepEqual(entry.queueHeads, { [URL]: { head: HEAD, step: "round", removals: 1, jobs: ["middleware"] } }, "carried into the round, so the same removal is not answered again");
});

test("A11-264: a run that ended needs-human gets the same round, and at the round cap is handed to a person with the removal named", () => {
  const run = finishedRun(needsHuman, afterRound, seedQueue([removal(0)]));
  run.pool.watchFeedback();
  assert.equal(run.entry().rounds, 1);
  assert.match(run.entry().feedback ?? "", /was removed from the merge queue at /);
  const capped = finishedRun(needsHuman, { ...afterRound, rounds: 3 }, seedQueue([removal(0)]));
  capped.pool.watchFeedback();
  assert.equal(capped.entry().phase, "finished", "no round at the cap");
  assert.match(capped.entry().handedBack ?? "", /^The pull requests keep getting feedback: the board answered 3 rounds on its own and stopped\. Respond to review starts another\. The latest: .*was removed from the merge queue/s);
  assert.deepEqual(capped.entry().queueHeads?.[URL]?.step, "round", "and the removal is answered, not asked again");
});

test("A11-264: a conflict removal starts a conflict round for a run Ready to merge and for one that ended needs-human, and none at the cap of the second", () => {
  const conflict = removal(0, { reason: "merge_conflict", groupCommit: null });
  for (const [kind, outcome] of [["Ready to merge", readyPr], ["needs-human", needsHuman]] as const) {
    const run = finishedRun(outcome, afterRound, seedQueue([conflict]));
    run.pool.watchFeedback();
    assert.equal(run.entry().rounds, 1, kind);
    assert.match(run.entry().feedback ?? "", new RegExp(`^${URL} conflicts with its base branch main\\.\\nThe merge queue removed it at `), kind);
  }
  const capped = finishedRun(needsHuman, { ...afterRound, rounds: 3 }, seedQueue([conflict]));
  capped.pool.watchFeedback();
  assert.deepEqual([capped.entry().phase, capped.entry().handedBack, capped.entry().queueHeads], ["finished", undefined, undefined], "a conflict needs a round left: at the cap nothing is queued and nothing is recorded, so it is asked again");
});

test("A11-264: a repeat without a new push does not re-arm: the pull request is held, the card says so, and no second round starts", () => {
  const record: Record<string, QueueHead> = { [URL]: { head: HEAD, step: "round", removals: 1, jobs: ["middleware"] } };
  const run = finishedRun(readyPr, { queueHeads: record }, seedQueue([removal(0), removal(1), removal(2)]));
  run.pool.watchFeedback();
  const entry = run.entry();
  assert.deepEqual([entry.phase, entry.rounds], ["finished", undefined], "no second round");
  assert.deepEqual(run.host.queues.holds, [{ url: URL, on: true }], "the label is put on");
  assert.equal(queueNote(entry as never), "removed from the merge queue 3 times: middleware", "the card says so");
  run.pool.watchFeedback();
  assert.equal(run.host.queues.holds.length, 1, "a later watch holds nothing twice");
});

test("A11-264: the hold lifts when the head changes, and the record goes with it", () => {
  const held: Record<string, QueueHead> = { [URL]: { head: HEAD, step: "held", removals: 3, jobs: ["middleware"], held: true, note: "removed from the merge queue 3 times: middleware" } };
  const run = finishedRun(readyPr, { queueHeads: held }, (host) => { host.queues.held.add(URL); seedQueue([], PUSHED)(host); });
  run.pool.watchFeedback();
  assert.deepEqual(run.host.queues.holds, [{ url: URL, on: false }]);
  assert.equal(run.entry().queueHeads === undefined || Object.keys(run.entry().queueHeads!).length === 0, true, "the record is dropped");
  assert.equal(queueNote(run.entry() as never), null);
});

test("A11-264: another reason is named on the card and starts no round", () => {
  const run = finishedRun(readyPr, {}, seedQueue([removal(0, { reason: "timeout", groupCommit: null })]));
  run.pool.watchFeedback();
  assert.deepEqual([run.entry().phase, run.entry().rounds], ["finished", undefined]);
  assert.equal(queueNote(run.entry() as never), "removed from the merge queue: timeout");
  const written = JSON.stringify(run.entry());
  run.pool.watchFeedback();
  assert.equal(JSON.stringify(run.entry()), written, "a later watch rewrites nothing");
});

test("A11-264: a code host that reads no queue leaves the watch as it was", () => {
  const run = finishedRun(readyPr, {}, (host) => { Object.assign(host.pullAt(URL)!, { queue: undefined }); });
  run.pool.watchFeedback();
  assert.deepEqual([run.entry().phase, run.entry().queueHeads, run.host.calls.filter((call) => call.startsWith("readQueueFailure"))], ["finished", undefined, []]);
});

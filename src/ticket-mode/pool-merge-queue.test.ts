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
import { registryCause } from "./pool-checks.ts";
import { answerQueue, HOLD_AFTER, MAX_REARMS } from "./pool-merge-queue.ts";
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
/** The tail of the install step's log of the `merge_group` run that removed a11ign/agent-org#1939 on 2026-10-26 (A11-295): a version published minutes before, which the registry the runner saw did not list yet. */
const ETARGET = stamped(["##[group]Run npm install", "npm error code ETARGET", "npm error notarget No matching version found for @typescript-eslint/types@8.72.1.", "npm error notarget In most cases you or one of your dependencies are requesting",
  "npm error notarget a package version that doesn't exist.", "npm error A complete log of this run can be found in: /home/runner/.npm/_logs/2026-10-26T17_12_03_117Z-debug-0.log", "##[error]Process completed with exit code 1."]);
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
    "If nothing in your change causes it, push nothing and say so: the board asks the arm bot to arm the pull request again.",
  ].join("\n"), "the failing job and step, its error lines, that it is the merged result's, and what to do, also when there is nothing to fix; the roll-up gate behind it is left out");
  assert.equal(answer.conflict, null);
  assert.deepEqual(answer.heads, { [URL]: { head: HEAD, step: "round", removals: 1, jobs: ["middleware"], roundStarted: true } });
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

test("A11-264: every failed job failing for an infrastructure reason starts no round and reruns nothing; a code host that cannot ask the arm bot names it on the card", () => {
  const plain = world({ logs: { [MIDDLEWARE]: RUNNER_LOST }, runs: [failure([{ name: "middleware", step: STEP, detailsUrl: MIDDLEWARE }])] });
  const host = { ...plain.host, requestStackMerge: undefined } as unknown as PoolContext["codeHost"];
  const answer = answerQueue({ codeHost: host } as PoolContext, entryWith(), [{ url: URL, read: feedback(removedFrom(removal(0))) }]);
  assert.equal(answer.feedback, null);
  assert.deepEqual(answer.heads[URL], { head: HEAD, step: "named", removals: 1, jobs: ["middleware"], note: "removed from the merge queue: middleware failed for an infrastructure reason (a runner was lost or a rate limit was hit)" });
  assert.deepEqual(answer.withoutRound, answer.heads, "and the record is kept without a round, so the card names it");
  assert.deepEqual(plain.host.checksAndClaims.reruns, [], "a rerun does not put a pull request back in the queue, so nothing is rerun");
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
  assert.deepEqual(third.heads[URL], { head: HEAD, step: "held", removals: 3, jobs: ["middleware"], held: true, note: "removed from the merge queue 3 times: middleware", roundStarted: true, roundEnded: true });
  assert.deepEqual(host.stackMerges.requests, [], "a pull request held from the arm bot is not given to it");
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
  assert.deepEqual([second.feedback, host.queues.holds], [null, []]);
  assert.deepEqual(second.heads[URL], { head: HEAD, step: "rearmed", removals: 2, jobs: ["middleware"], roundStarted: true, roundEnded: true, rearms: 1,
    note: "removed from the merge queue: its round ended with no push and it is still out of the queue; the arm bot was asked to arm it again (1 of 2)" }, "a record written before A11-295 is a round the board started: its end is handled once, here");
});

test("A11-264: a third removal found at the first look starts the round and holds the pull request", () => {
  const { ctx, host } = world();
  const answer = answerQueue(ctx, entryWith(), [{ url: URL, read: feedback(removedFrom(removal(0), removal(1), removal(2))) }]);
  assert.match(answer.feedback ?? "", /^middleware failed at step /m, "the newest removal's run is the round's");
  assert.deepEqual(host.queues.holds, [{ url: URL, on: true }]);
  assert.deepEqual(answer.heads[URL], { head: HEAD, step: "held", removals: 3, jobs: ["middleware"], held: true, note: "removed from the merge queue 3 times: middleware", roundStarted: true });
  assert.deepEqual(answer.withoutRound, {}, "the round is not recorded as answered until it is queued");
});

test("A11-264: a hold the code host refuses is said on the card and asked for again on the next watch", () => {
  const { ctx, host } = world();
  host.queues.holdRefusal = "Resource not accessible by integration (HTTP 403)";
  const answered: Record<string, QueueHead> = { [URL]: { head: HEAD, step: "round", removals: 1, jobs: ["middleware"] } };
  const read = feedback(removedFrom(removal(0), removal(1), removal(2)));
  const refused = answerQueue(ctx, entryWith(answered), [{ url: URL, read }]);
  assert.deepEqual(refused.heads[URL], { head: HEAD, step: "held", removals: 3, jobs: ["middleware"], held: false, roundStarted: true, roundEnded: true,
    note: "removed from the merge queue 3 times: middleware, and could not be held from the queue (Resource not accessible by integration (HTTP 403))" });
  assert.deepEqual(host.stackMerges.requests, [], "a pull request that is to be held is not given to the arm bot while the label is off");
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
  assert.deepEqual(then.heads[URL], { head: HEAD, step: "round", removals: 1, jobs: ["middleware"], roundStarted: true });
  const lost = failure([{ name: "middleware", step: STEP, detailsUrl: MIDDLEWARE }]);
  const infra = world({ logs: { [MIDDLEWARE]: RUNNER_LOST }, runs: [lost, lost] });
  const named = answerQueue(infra.ctx, entryWith(), [{ url: URL, read: feedback(removedFrom(removal(0))) }]);
  assert.equal(answerQueue(infra.ctx, entryWith(named.heads), [{ url: URL, read: feedback(removedFrom(removal(0), removal(1))) }]).feedback, null, "a head put back in the queue for an infrastructure failure is not owed one");
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
  host.seedPull(REPO, 18, { head: HEAD, feedback: { approvedAtHead: true } });
  host.checksAndClaims.logs.set(MIDDLEWARE, DRIFT);
  host.checksAndClaims.logs.set(GATE, stamped(["a job reported 'failure', not success"]));
  GROUPS.forEach((group, n) => host.queues.failures.set(queueFailureKey(URL, group), failure()));
  seed(host);
  const queue = fixture.store.get();
  fixture.store.set({ ...queue, entries: [{ ...queue.entries[0], phase: "finished", finishedAt: NOW / 2, outcome, ...over }] });
  return { fixture, host, pool: fixture.restart({ codeHost: host }), entry: () => fixture.store.get().entries[0] };
}
/** Let the tick that a round `watchFeedback` queues wakes, which it does not wait for, finish: left running it writes the run's state folder after the test removed it. */
const settled = async () => { for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
/** Watch the run's pull requests once, and wait for the tick that wakes. */
const watching = async (pool: { watchFeedback: () => void }) => { await pool.watchFeedback(); await settled(); };
const seedQueue = (removals: QueueRemoval[], head = HEAD) => (host: ReturnType<typeof createFakeCodeHost>) => { Object.assign(host.pullAt(URL)!, { head, queue: removedFrom(...removals) }); };
const readyPr = { kind: "ready-pr", prs: [PR] } as Outcome;
const needsHuman = { kind: "needs-human", reason: "which colour?" } as Outcome;
/** What a run that asked a question after a round holds: the pull request it answered, as its `review`. */
const afterRound: Partial<Entry> = { review: [PR] };

test("A11-264: a run Ready to merge whose pull request the queue removed gets a round that names the merge_group run's errors, and the head is recorded as answered", async () => {
  const run = finishedRun(readyPr, {}, seedQueue([removal(0)]));
  await watching(run.pool);
  const entry = run.entry();
  assert.equal(entry.rounds, 1, "one round");
  assert.deepEqual(entry.review, [PR], "for the pull request");
  assert.match(entry.feedback ?? "", new RegExp(`^${URL} was removed from the merge queue at 2026-10-25T11:59:08Z because its merge_group run failed \\(${RUN_URL}\\)\\.`));
  assert.match(entry.feedback ?? "", /^middleware failed at step "The Dependabot config is what the toolchain generates":\n  dependabot-config: FAIL /m);
  assert.deepEqual(entry.queueHeads, { [URL]: { head: HEAD, step: "round", removals: 1, jobs: ["middleware"], roundStarted: true } }, "carried into the round, so the same removal is not answered again");
});

test("A11-264: a run that ended needs-human gets the same round, and at the round cap is handed to a person with the removal named", async () => {
  const run = finishedRun(needsHuman, afterRound, seedQueue([removal(0)]));
  await watching(run.pool);
  assert.equal(run.entry().rounds, 1);
  assert.match(run.entry().feedback ?? "", /was removed from the merge queue at /);
  const capped = finishedRun(needsHuman, { ...afterRound, rounds: 3 }, seedQueue([removal(0)]));
  await watching(capped.pool);
  assert.equal(capped.entry().phase, "finished", "no round at the cap");
  assert.match(capped.entry().handedBack ?? "", /^The pull requests keep getting feedback: the board answered 3 rounds on its own and stopped\. Respond to review starts another\. The latest: .*was removed from the merge queue/s);
  assert.deepEqual(capped.entry().queueHeads?.[URL]?.step, "round", "and the removal is answered, not asked again");
});

test("A11-264: a conflict removal starts a conflict round for a run Ready to merge and for one that ended needs-human, and none at the cap of the second", async () => {
  const conflict = removal(0, { reason: "merge_conflict", groupCommit: null });
  for (const [kind, outcome] of [["Ready to merge", readyPr], ["needs-human", needsHuman]] as const) {
    const run = finishedRun(outcome, afterRound, seedQueue([conflict]));
    await watching(run.pool);
    assert.equal(run.entry().rounds, 1, kind);
    assert.match(run.entry().feedback ?? "", new RegExp(`^${URL} conflicts with its base branch main\\.\\nThe merge queue removed it at `), kind);
  }
  const capped = finishedRun(needsHuman, { ...afterRound, rounds: 3 }, seedQueue([conflict]));
  await watching(capped.pool);
  assert.deepEqual([capped.entry().phase, capped.entry().handedBack, capped.entry().queueHeads], ["finished", undefined, undefined], "a conflict needs a round left: at the cap nothing is queued and nothing is recorded, so it is asked again");
});

test("A11-264: a repeat without a new push does not re-arm: the pull request is held, the card says so, and no second round starts", async () => {
  const record: Record<string, QueueHead> = { [URL]: { head: HEAD, step: "round", removals: 1, jobs: ["middleware"] } };
  const run = finishedRun(readyPr, { queueHeads: record }, seedQueue([removal(0), removal(1), removal(2)]));
  await watching(run.pool);
  const entry = run.entry();
  assert.deepEqual([entry.phase, entry.rounds], ["finished", undefined], "no second round");
  assert.deepEqual(run.host.queues.holds, [{ url: URL, on: true }], "the label is put on");
  assert.equal(queueNote(entry as never), "removed from the merge queue 3 times: middleware", "the card says so");
  await watching(run.pool);
  assert.equal(run.host.queues.holds.length, 1, "a later watch holds nothing twice");
});

test("A11-264: the hold lifts when the head changes, and the record goes with it", async () => {
  const held: Record<string, QueueHead> = { [URL]: { head: HEAD, step: "held", removals: 3, jobs: ["middleware"], held: true, note: "removed from the merge queue 3 times: middleware" } };
  const run = finishedRun(readyPr, { queueHeads: held }, (host) => { host.queues.held.add(URL); seedQueue([], PUSHED)(host); });
  await watching(run.pool);
  assert.deepEqual(run.host.queues.holds, [{ url: URL, on: false }]);
  assert.equal(run.entry().queueHeads === undefined || Object.keys(run.entry().queueHeads!).length === 0, true, "the record is dropped");
  assert.equal(queueNote(run.entry() as never), null);
});

test("A11-264: another reason is named on the card and starts no round", async () => {
  const run = finishedRun(readyPr, {}, seedQueue([removal(0, { reason: "timeout", groupCommit: null })]));
  await watching(run.pool);
  assert.deepEqual([run.entry().phase, run.entry().rounds], ["finished", undefined]);
  assert.equal(queueNote(run.entry() as never), "removed from the merge queue: timeout");
  const written = JSON.stringify(run.entry());
  await watching(run.pool);
  assert.equal(JSON.stringify(run.entry()), written, "a later watch rewrites nothing");
});

test("A11-264: a code host that reads no queue leaves the watch as it was", async () => {
  const run = finishedRun(readyPr, {}, (host) => { Object.assign(host.pullAt(URL)!, { queue: undefined }); });
  await watching(run.pool);
  assert.deepEqual([run.entry().phase, run.entry().queueHeads, run.host.calls.filter((call) => call.startsWith("readQueueFailure"))], ["finished", undefined, []]);
});

// -- A11-295: a pull request the queue removed is put back in the queue when the change did not cause it, and when a round that pushed nothing ends. --

const ARMED = { repo: REPO, number: 18 };
const lost = (step: string | null = STEP) => failure([{ name: "middleware", step, detailsUrl: MIDDLEWARE }]);
/** Run `act` and return what the board wrote to its log meanwhile. */
async function logged(act: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { await act(); } finally { process.stderr.write = write; }
  return lines.join("");
}
/** Watch the run's pull requests once and return what the board logged for it. */
async function watchedWithLog(run: ReturnType<typeof finishedRun>): Promise<string> {
  const log = await logged(async () => { await run.pool.watchFeedback(); });
  await settled();
  return log;
}
const noRound = (run: ReturnType<typeof finishedRun>) => assert.deepEqual([run.entry().phase, run.entry().rounds, run.entry().feedback], ["finished", undefined, undefined], "no round is started");

test("A11-295: an ETARGET install failure behind a removal puts the approved pull request back in the queue once, with no round, and logs both", async () => {
  const run = finishedRun(readyPr, {}, (host) => { seedQueue([removal(0)])(host); host.checksAndClaims.logs.set(MIDDLEWARE, ETARGET); host.queues.failures.set(queueFailureKey(URL, GROUPS[0]), lost()); });
  const log = await watchedWithLog(run);
  assert.deepEqual(run.host.stackMerges.requests, [ARMED], "the arm workflow is dispatched once for the pull request");
  noRound(run);
  assert.match(log, /NBF-1: https:\/\/github\.com\/a11ign\/announcement-emulator\/pull\/18 was removed from the merge queue: middleware failed for an infrastructure reason \(the package registry did not serve a version the install asked for\); the arm bot was asked to arm it again \(1 of 2\)/, "the removal and the re-arm are logged");
  assert.deepEqual(run.entry().queueHeads?.[URL], { head: HEAD, step: "rearmed", removals: 1, jobs: ["middleware"], rearms: 1,
    note: "removed from the merge queue: middleware failed for an infrastructure reason (the package registry did not serve a version the install asked for); the arm bot was asked to arm it again (1 of 2)" });
  await watching(run.pool);
  assert.deepEqual(run.host.stackMerges.requests, [ARMED], "the same removal is not answered again by the next watch");
  assert.deepEqual(run.host.checksAndClaims.reruns, [], "nothing is rerun");
});

test("A11-295: a registry 5xx, a lost runner and a job that failed while the runner was set up are each a removal the change did not cause", () => {
  const registry503 = stamped(["npm error code E503", "npm error 503 Service Unavailable - GET https://registry.npmjs.org/@typescript-eslint%2ftypes", "##[error]Process completed with exit code 1."]);
  const refusedConnection = stamped(["npm error code ECONNRESET", "npm error network aborted", "npm error network This is a problem related to network connectivity."]);
  for (const [what, log, step] of [["a registry 503", registry503, STEP], ["a reset connection", refusedConnection, STEP], ["a lost runner", RUNNER_LOST, STEP], ["a job that failed at Set up job", stamped(["Fetching the repository"]), "Set up job"]] as const) {
    const { ctx, host } = world({ logs: { [MIDDLEWARE]: log }, runs: [lost(step)] });
    const answer = answerQueue(ctx, entryWith(), [{ url: URL, read: feedback(removedFrom(removal(0))) }]);
    assert.deepEqual([answer.feedback, answer.heads[URL]?.step, host.stackMerges.requests], [null, "rearmed", [ARMED]], what);
  }
  assert.equal(registryCause(DRIFT), null, "a failing check of the code is not the registry's");
  assert.equal(registryCause(stamped(["npm test", "npm error Lifecycle script `test` failed with error:", "npm error code ELIFECYCLE"])), null, "nor is an npm script that failed");
  assert.equal(registryCause(stamped(["npm error notarget No matching version found for left-pad@9.9.9.", ...Array.from({ length: 13 }, (_, n) => `at step ${n}: error`)])), null, "nor is an old line above the log's end");
});

test("A11-295: at most two re-arms for a head: the third removal starts a round, and holds the pull request", () => {
  const { ctx, host } = world({ logs: { [MIDDLEWARE]: ETARGET }, runs: [lost(), lost(), lost()] });
  const one = answerQueue(ctx, entryWith(), [{ url: URL, read: feedback(removedFrom(removal(0))) }]);
  const two = answerQueue(ctx, entryWith(one.heads), [{ url: URL, read: feedback(removedFrom(removal(0), removal(1))) }]);
  assert.deepEqual([one.feedback, two.feedback, one.heads[URL]?.rearms, two.heads[URL]?.rearms, host.stackMerges.requests], [null, null, 1, 2, [ARMED, ARMED]], `${MAX_REARMS} re-arms, no round`);
  const three = answerQueue(ctx, entryWith(two.heads), [{ url: URL, read: feedback(removedFrom(removal(0), removal(1), removal(2))) }]);
  assert.match(three.feedback ?? "", /^middleware failed at step "The Dependabot config is what the toolchain generates":\n  npm error code ETARGET$/m, "the third removal starts a worker round, which is shown the install's lines");
  assert.match(three.feedback ?? "", /Every job that failed did so before your code ran, and the pull request was removed again after the board asked the arm bot to arm it 2 times\./);
  assert.doesNotMatch(three.feedback ?? "", /push nothing/, "and the pull request is held, so it is not told the board will arm it again");
  assert.deepEqual(host.stackMerges.requests, [ARMED, ARMED], "and the arm bot is not asked a third time");
  assert.deepEqual([three.heads[URL]?.step, three.heads[URL]?.rearms, three.heads[URL]?.roundStarted, host.queues.holds], ["held", 2, true, [{ url: URL, on: true }]]);
});

test("A11-295: a removal that is the change's, a pull request that is not approved or conflicts, and a code host that cannot ask are not given to the arm bot", () => {
  const read = (over: Partial<PullFeedback>) => feedback(removedFrom(removal(0)), over);
  const lostRun = { logs: { [MIDDLEWARE]: ETARGET }, runs: [lost()] };
  const mixed = world({ logs: { [MIDDLEWARE]: DRIFT, [GATE]: ETARGET }, runs: [failure([{ name: "middleware", step: STEP, detailsUrl: MIDDLEWARE }, { name: "lint", step: null, detailsUrl: GATE }])] });
  assert.match(answerQueue(mixed.ctx, entryWith(), [{ url: URL, read: read({}) }]).feedback ?? "", /^middleware failed at step /m, "a job the code failed beside the registry's is a round");
  assert.deepEqual(mixed.host.stackMerges.requests, []);
  const unapproved = world(lostRun);
  const answer = answerQueue(unapproved.ctx, entryWith(), [{ url: URL, read: read({ approvedAtHead: false }) }]);
  assert.deepEqual([answer.feedback, answer.heads[URL]?.step, unapproved.host.stackMerges.requests], [null, "named", []], "not approved at this head");
  assert.match(answer.heads[URL]?.note ?? "", /not armed again: it is not approved at this head$/);
  const changes = world(lostRun);
  assert.deepEqual([answerQueue(changes.ctx, entryWith(), [{ url: URL, read: read({ approvedAtHead: true, reviewDecision: "changes-requested" }) }]).heads[URL]?.step, changes.host.stackMerges.requests], ["named", []], "GitHub asks for changes");
  const conflicting = world(lostRun);
  assert.deepEqual([answerQueue(conflicting.ctx, entryWith(), [{ url: URL, read: read({ conflicting: true }) }]).heads[URL]?.step, conflicting.host.stackMerges.requests], ["named", []], "it conflicts with its base");
});

test("A11-295: an arm bot that cannot be asked is said on the card and asked again by the next watch", async () => {
  const run = finishedRun(readyPr, {}, (host) => { seedQueue([removal(0)])(host); host.checksAndClaims.logs.set(MIDDLEWARE, ETARGET); host.queues.failures.set(queueFailureKey(URL, GROUPS[0]), lost()); host.stackMerges.requestRefusal = "workflow not found (HTTP 404)"; });
  await watching(run.pool);
  assert.match(queueNote(run.entry() as never) ?? "", /the arm bot could not be asked to arm it again \(workflow not found \(HTTP 404\)\), asked again next watch$/);
  assert.equal(run.entry().queueHeads?.[URL]?.rearms, undefined, "a refused ask is not counted");
  run.host.stackMerges.requestRefusal = null;
  await watching(run.pool);
  assert.deepEqual(run.host.stackMerges.requests, [ARMED], "asked again, once");
  assert.deepEqual([run.entry().queueHeads?.[URL]?.step, run.entry().queueHeads?.[URL]?.rearms, run.entry().queueHeads?.[URL]?.refused], ["rearmed", 1, undefined]);
  await watching(run.pool);
  assert.equal(run.host.stackMerges.requests.length, 1, "and not again");
});

/** The state of a run whose round for the removal has ended: finished again, the record of the round carried through it, the head the same. */
const afterItsRound = (over: Partial<QueueHead> = {}): Record<string, QueueHead> => ({ [URL]: { head: HEAD, step: "round", removals: 1, jobs: ["middleware"], roundStarted: true, ...over } });

test("A11-295: a round that ends with no push and the pull request still out of the queue puts it back, and logs why it was not in the queue", async () => {
  const run = finishedRun(readyPr, { queueHeads: afterItsRound() }, seedQueue([removal(0)]));
  const log = await watchedWithLog(run);
  assert.deepEqual(run.host.stackMerges.requests, [ARMED], "the arm bot is asked");
  assert.match(log, /NBF-1: https:\/\/github\.com\/a11ign\/announcement-emulator\/pull\/18 was removed from the merge queue: its round ended with no push and it is still out of the queue; the arm bot was asked to arm it again \(1 of 2\)/);
  assert.deepEqual(run.entry().queueHeads?.[URL], { head: HEAD, step: "rearmed", removals: 1, jobs: ["middleware"], roundStarted: true, roundEnded: true, rearms: 1,
    note: "removed from the merge queue: its round ended with no push and it is still out of the queue; the arm bot was asked to arm it again (1 of 2)" });
  noRound(run);
  await watching(run.pool);
  assert.equal(run.host.stackMerges.requests.length, 1, "the round's end is handled once");
  const removedAgain = finishedRun(readyPr, { queueHeads: run.entry().queueHeads }, seedQueue([removal(0), removal(1)]));
  await watching(removedAgain.pool);
  assert.deepEqual([removedAgain.host.stackMerges.requests, removedAgain.entry().queueHeads?.[URL]?.rearms, removedAgain.entry().rounds], [[ARMED], 2, undefined], "removed again, it is put back a second time, with no second round");
  const third = finishedRun(readyPr, { queueHeads: removedAgain.entry().queueHeads }, seedQueue([removal(0), removal(1), removal(2)]));
  await watching(third.pool);
  assert.deepEqual([third.host.stackMerges.requests, third.host.queues.holds, third.entry().rounds, third.entry().queueHeads?.[URL]?.step], [[], [{ url: URL, on: true }], undefined, "held"], "the third removal holds it, and nothing arms it");
});

test("A11-295: a worker round for a removal that ends reviewed with nothing pushed ends with the pull request back in the queue", async () => {
  const run = finishedRun(readyPr, {}, seedQueue([removal(0)]));
  await watching(run.pool);
  assert.equal(run.entry().rounds, 1, "the code's failure starts a round");
  assert.deepEqual(run.host.stackMerges.requests, [], "and the arm bot is not asked while it runs");
  // The worker looks, changes nothing and ends: the run is finished again, with the record the round carried and the pull request still at the head it was removed at.
  const ended = { ...run.entry(), phase: "finished", finishedAt: NOW, workspace: undefined, outcome: { kind: "reviewed", prs: [PR] } } as unknown as Entry;
  run.fixture.store.set({ ...run.fixture.store.get(), entries: [ended] });
  const log = await watchedWithLog(run);
  assert.deepEqual(run.host.stackMerges.requests, [ARMED], "the round's end re-arms it");
  assert.match(log, /its round ended with no push and it is still out of the queue; the arm bot was asked to arm it again/);
  assert.equal(run.entry().rounds, 1, "with no second round");
});

test("A11-295: a round that ends with the pull request not armed again says why in the log: held, not approved, spent re-arms, a pushed head", async () => {
  const reasons: [string, Partial<QueueHead>, (host: ReturnType<typeof createFakeCodeHost>) => void, RegExp][] = [
    ["held", { step: "held", held: true, removals: 3, note: "removed from the merge queue 3 times: middleware" }, (host) => seedQueue([removal(0), removal(1), removal(2)])(host), /not armed again: it is held from the arm bot/],
    ["not approved", {}, (host) => { seedQueue([removal(0)])(host); Object.assign(host.pullAt(URL)!, { feedback: { approvedAtHead: false } }); }, /not armed again: it is not approved at this head/],
    ["re-arms spent", { rearms: 2, roundEnded: true, removals: 0 }, (host) => seedQueue([removal(0), removal(1)])(host), /not armed again: the arm bot was asked 2 times at this head already/],
  ];
  for (const [what, record, seed, expected] of reasons) {
    const run = finishedRun(readyPr, { queueHeads: afterItsRound(record) }, seed);
    const log = await watchedWithLog(run);
    assert.match(log, expected, what);
    assert.match(log, /was removed from the merge queue: (its round ended with no push and it is still out of the queue|it was removed again after its round)/, `${what}: and the round's end is in the line`);
    assert.deepEqual(run.host.stackMerges.requests, [], `${what}: nothing is asked of the arm bot`);
  }
  const pushed = finishedRun(readyPr, { queueHeads: afterItsRound() }, seedQueue([], PUSHED));
  await watching(pushed.pool);
  assert.deepEqual(pushed.host.stackMerges.requests, [], "a round that pushed leaves the arming to the new head");
});

test("A11-295: an arm bot that refuses does not stop the hold at the third removal, and a person's removal is not armed", () => {
  const { ctx, host } = world({ logs: { [MIDDLEWARE]: ETARGET }, runs: [lost(), lost(), lost()] });
  host.stackMerges.requestRefusal = "workflow not found (HTTP 404)";
  const one = answerQueue(ctx, entryWith(), [{ url: URL, read: feedback(removedFrom(removal(0))) }]);
  assert.equal(one.heads[URL]?.refused, "workflow not found (HTTP 404)");
  const retried = answerQueue(ctx, entryWith(one.heads), [{ url: URL, read: feedback(removedFrom(removal(0))) }]);
  assert.equal(host.stackMerges.requests.length, 0, "refused every time");
  assert.equal(host.calls.filter((call) => call.startsWith("requestStackMerge")).length, 2, "and asked again by the next watch");
  const manual = answerQueue(ctx, entryWith(retried.heads), [{ url: URL, read: feedback(removedFrom(removal(0), removal(1, { reason: "manual", actor: "a-person", groupCommit: null }))) }]);
  assert.equal(host.calls.filter((call) => call.startsWith("requestStackMerge")).length, 2, "a person's removal is not asked of the arm bot");
  const two = answerQueue(ctx, entryWith(retried.heads), [{ url: URL, read: feedback(removedFrom(removal(0), removal(1), removal(2))) }]);
  assert.match(two.feedback ?? "", /^middleware failed at step /m, "the third removal starts the round whatever the arm bot said");
  assert.deepEqual([two.heads[URL]?.step, host.queues.holds, manual.heads[URL]?.refused], ["held", [{ url: URL, on: true }], "workflow not found (HTTP 404)"]);
});

test("A11-295: a round handed back at the cap, and one that ended asking a person, leave the pull request to the person", async () => {
  const capped = finishedRun(needsHuman, { ...afterRound, rounds: 3 }, seedQueue([removal(0)]));
  await watching(capped.pool);
  await watching(capped.pool);
  assert.deepEqual([capped.entry().handedBack !== undefined, capped.host.stackMerges.requests], [true, []], "handed back: the person decides");
  const asking = finishedRun(needsHuman, { ...afterRound, queueHeads: afterItsRound() }, seedQueue([removal(0)]));
  await watching(asking.pool);
  assert.deepEqual(asking.host.stackMerges.requests, [], "a worker that asked a question is waiting for the answer");
});

test("A11-295: a code host that cannot ask the arm bot keeps the round for a registry error, and a brief promises a re-arm only when the board will make one", () => {
  const plain = world({ logs: { [MIDDLEWARE]: ETARGET }, runs: [lost()] });
  const host = { ...plain.host, requestStackMerge: undefined } as unknown as PoolContext["codeHost"];
  const answer = answerQueue({ codeHost: host } as PoolContext, entryWith(), [{ url: URL, read: feedback(removedFrom(removal(0))) }]);
  assert.match(answer.feedback ?? "", /^middleware failed at step "The Dependabot config is what the toolchain generates":\n  npm error code ETARGET$/m, "as before A11-295: the code's round");
  assert.doesNotMatch(answer.feedback ?? "", /push nothing/, "and it is not told the board will arm the pull request again");
  const asks = world();
  assert.match(answerQueue(asks.ctx, entryWith(), [{ url: URL, read: feedback(removedFrom(removal(0))) }]).feedback ?? "", /push nothing and say so: the board asks the arm bot to arm the pull request again\.$/, "a pull request that will be armed again is told so");
  assert.doesNotMatch(answerQueue(asks.ctx, entryWith(), [{ url: URL, read: feedback(removedFrom(removal(0), removal(1), removal(2))) }]).feedback ?? "", /push nothing/, "a held one is not");
});

test("A11-295: a pull request back in the queue drops the card's note, and pnpm's registry errors are the registry's", () => {
  const { ctx } = world({ logs: { [MIDDLEWARE]: ETARGET }, runs: [lost()] });
  const one = answerQueue(ctx, entryWith(), [{ url: URL, read: feedback(removedFrom(removal(0))) }]);
  const queued = answerQueue(ctx, entryWith(one.heads), [{ url: URL, read: feedback({ queued: true, removals: [removal(0)] }) }]);
  assert.deepEqual(queued.heads[URL], { head: HEAD, step: "rearmed", removals: 1, jobs: ["middleware"], rearms: 1 });
  assert.equal(registryCause(" ERR_PNPM_NO_MATCHING_VERSION  No matching version found for @typescript-eslint/types@8.72.1 while fetching it from https://registry.npmjs.org/"), "the package registry did not serve a version the install asked for");
  assert.equal(registryCause(" ERR_PNPM_FETCH_503  GET https://registry.npmjs.org/x: Service Unavailable - 503"), "the package registry did not serve a version the install asked for");
});

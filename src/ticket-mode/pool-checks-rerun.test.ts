// no-token: gh -- A11-300: the board reruns a red job once before it asks a worker, records a pass on rerun as a flake, and reruns once more when a worker's reply says the failure is not its change's
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerChecks, type ReadCheck } from "./pool-checks.ts";
import { callsUnrelated, failedTestOf, saysUnrelated } from "./failure-words.ts";
import { type Flake, flakesView } from "./flakes.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import type { PullFeedback } from "../plugins/contracts/code-host.ts";
import type { ForeignReds } from "./pool-foreign-checks.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
import type { CheckHead } from "./board-view/view-types-and-filters.ts";
import type { PoolContext } from "./pool-context.ts";

const URL_1 = "https://github.com/a11ign/agent-org/pull/1946";
const HEAD = "fc707690".padEnd(40, "0");
const SUITE_JOB = "https://github.com/a11ign/agent-org/actions/runs/40382975143/job/2";
const NOW = Date.parse("2026-10-26T19:00:00Z");
const MINUTE = 60_000;
const WORKERS = "a11ign-workers";
const stamped = (lines: string[]) => lines.map((line) => `2026-10-26T18:00:00.1234567Z ${line}`).join("\n");
/** The failure of the ticket: a test file the pull request does not touch, whose sandbox was not removed. */
const SANDBOX = stamped(["FAIL  src/packaging/region-paths-checkout.test.ts > a checkout leaves nothing behind", "SandboxNotRemovedError: the sandbox was not removed"]);

/** The pull request's feedback at `HEAD`: `suite (2)` failing or not, as the host reads it; `over` says what else it reads. */
const feedback = (failing: readonly string[], over: Partial<PullFeedback> = {}): PullFeedback => ({
  state: "open", feedbackAt: null, authors: [], failing, failures: failing.map((name) => ({ name, detailsUrl: SUITE_JOB })), failedAt: null, conflicting: false,
  mergeable: true, head: HEAD, approvedAtHead: false, base: "main", files: ["src/ticket-mode/pool-checks.ts"], filesComplete: true, pendingRequired: [], ...over,
});
const RED = feedback(["suite (2)"]);
const GREEN = feedback([]);

function world(description = "") {
  const host = createFakeCodeHost();
  host.checksAndClaims.logs.set(SUITE_JOB, SANDBOX);
  host.seedPull("a11ign/agent-org", 1946, { head: HEAD });
  const recorded: Flake[] = [];
  const clock = { at: NOW };
  const ctx = { codeHost: host, now: () => clock.at, flakes: { record: (found: readonly Flake[]) => void recorded.push(...found), view: () => flakesView(recorded, clock.at) }, repliesRead: new Set<string>(), ownLogin: { value: WORKERS } } as unknown as PoolContext;
  const entry = (checkHeads?: Readonly<Record<string, CheckHead>>): Entry =>
    ({ ticket: { key: "A11-294", description }, paths: [], phase: "finished", startedAt: NOW - 30 * MINUTE, outcome: { kind: "reviewed", prs: [{ repo: "agent-org", url: URL_1 }] }, pullStates: { [URL_1]: "open" }, ...(checkHeads === undefined ? {} : { checkHeads }) }) as unknown as Entry;
  /** One watch of the pull request: the answer, and the record the next watch starts from. */
  const watch = (read: PullFeedback, known?: Readonly<Record<string, CheckHead>>) => {
    const answer = answerChecks(ctx, entry(known), [{ url: URL_1, read }]);
    return { ...answer, record: answer.heads };
  };
  return { host, ctx, recorded, clock, watch, entry };
}

test("A11-300: a required job red at a head is rerun once, before any worker is asked, and the card says so", () => {
  const { host, watch } = world();
  const first = watch(RED);
  assert.equal(first.feedback, null, "no round");
  assert.deepEqual(host.checksAndClaims.reruns, [[SUITE_JOB]], "the failed jobs of the run are rerun");
  assert.deepEqual([first.heads[URL_1]?.step, first.heads[URL_1]?.head, first.heads[URL_1]?.rerun?.for], ["rerun", HEAD, "code"]);
  assert.match(first.heads[URL_1]?.note ?? "", /^Reran suite \(2\) on fc707690 before asking a worker/);
  assert.deepEqual(first.withoutRound, first.heads, "the rerun is recorded without a round, so a watch that reads the head again does not rerun it again");
});

test("A11-300: a job that is green on rerun starts no round, and the pass is recorded as a flake: the test that failed, the run and the head", () => {
  const { host, watch, recorded, clock } = world();
  const first = watch(RED);
  const running = watch(feedback([], { pendingRequired: ["suite (2)"] }), first.record);
  assert.deepEqual([running.feedback, running.heads[URL_1]?.step, recorded], [null, "rerun", []], "while the rerun runs nothing is recorded");
  clock.at += 6 * MINUTE;
  const passed = watch(GREEN, first.record);
  assert.equal(passed.feedback, null, "green on rerun: no round");
  assert.deepEqual(recorded, [{ test: "src/packaging/region-paths-checkout.test.ts > a checkout leaves nothing behind", check: "suite (2)", run: SUITE_JOB, head: HEAD, pull: URL_1, at: clock.at }]);
  assert.deepEqual([passed.heads[URL_1]?.step, passed.heads[URL_1]?.rerun?.passed], ["rerun", true]);
  assert.match(passed.heads[URL_1]?.note ?? "", /^suite \(2\) failed on fc707690 and passed on rerun: recorded as a flake/);
  const later = watch(GREEN, passed.record);
  assert.deepEqual([recorded.length, host.checksAndClaims.reruns.length], [1, 1], "a later watch of the same head records it once and reruns nothing");
});

test("A11-300: a pass whose flake cannot be written is not marked recorded: the next watch writes it, and nothing is lost", () => {
  const { watch, recorded, ctx, clock } = world();
  const first = watch(RED);
  const write = ctx.flakes.record;
  (ctx.flakes as { record: typeof write }).record = () => { throw new Error("/state/tickets/flakes.json is not JSON (Unexpected token)"); };
  clock.at += 6 * MINUTE;
  const refused = watch(GREEN, first.record);
  assert.deepEqual([refused.heads, recorded], [first.record, []], "nothing is recorded, and the rerun's record is kept as it was, not marked passed");
  (ctx.flakes as { record: typeof write }).record = write;
  const later = watch(GREEN, first.record);
  assert.deepEqual([later.heads[URL_1]?.rerun?.passed, recorded.length], [true, 1], "once the log can be written the flake is recorded");
});

test("A11-300: a job that is red twice at a head starts a round, and only then; the rerun is made once", () => {
  const { host, watch, recorded, clock } = world();
  const first = watch(RED);
  clock.at += 10 * MINUTE;
  const twice = watch(feedback(["suite (2)"], { failedAt: clock.at - MINUTE }), first.record);
  assert.match(twice.feedback ?? "", /^suite \(2\) failed on the head commit of https:\/\/github.com\/a11ign\/agent-org\/pull\/1946:$/m, "red again after the rerun: a worker is briefed with the failure");
  assert.match(twice.feedback ?? "", /SandboxNotRemovedError/);
  assert.deepEqual([twice.heads[URL_1]?.step, recorded, host.checksAndClaims.reruns.length], ["round", [], 1], "a round, no flake, one rerun");
});

test("A11-300: the failure the rerun replaced, still on the host just after the rerun, is not the rerun failing again", () => {
  const { watch, clock } = world();
  const first = watch(RED);
  clock.at += MINUTE;
  const stale = watch(feedback(["suite (2)"], { failedAt: NOW - 2 * MINUTE }), first.record);
  assert.deepEqual([stale.feedback, stale.heads[URL_1]?.step], [null, "rerun"], "it finished before the rerun was made: no round yet");
  clock.at += 10 * MINUTE;
  const later = watch(feedback(["suite (2)"], { failedAt: NOW - 2 * MINUTE }), first.record);
  assert.equal(later.heads[URL_1]?.step, "round", "and not for ever: a failure the host still shows minutes after the rerun is red");
});

test("A11-300: a job that fails while the run's other jobs are still going waits for the run, and is rerun once it has finished or the wait is over", () => {
  const { host, watch, clock } = world();
  const running = feedback(["suite (2)"], { pendingRequired: ["suite (3)"], failedAt: NOW - MINUTE });
  const waiting = watch(running);
  assert.deepEqual([waiting.feedback, waiting.heads, host.checksAndClaims.reruns], [null, {}, []], "GitHub reruns the failed jobs of a finished run only: nothing is rerun, recorded or asked yet");
  watch(running);
  assert.equal(host.calls.filter((call) => call.startsWith("readCheckLog")).length, 0, "and no log is read on every watch while it waits");
  clock.at += 50 * MINUTE;
  const overdue = watch(running);
  assert.deepEqual([overdue.heads[URL_1]?.step, host.checksAndClaims.reruns.length], ["rerun", 1], "a check that never concludes does not hold the rerun for ever");
});

test("A11-300: a rerun the host refuses, and a red check with no job to rerun, start the round as before", () => {
  const refused = world();
  refused.host.checksAndClaims.rerunRefusal = "run 40382975143 cannot be rerun";
  const round = refused.watch(RED);
  assert.deepEqual([round.heads[URL_1]?.step, (round.feedback ?? "").startsWith("suite (2) failed on the head commit of")], ["round", true]);
  const status = world();
  const noJob = status.watch({ ...RED, failures: [{ name: "suite (2)", detailsUrl: null }] });
  assert.deepEqual([noJob.heads[URL_1]?.step, status.host.checksAndClaims.reruns], ["round", []]);
});

test("A11-300: the round's brief tells the worker how to say a failure is not its change's, so that the board reruns it", () => {
  const { watch, clock } = world();
  const first = watch(RED);
  clock.at += 10 * MINUTE;
  const twice = watch(feedback(["suite (2)"], { failedAt: clock.at - MINUTE }), first.record);
  assert.match(twice.feedback ?? "", /not your change \(it fails without your change too\), push nothing for it, and reply on https:\/\/github.com\/a11ign\/agent-org\/pull\/1946 saying the failure is unrelated to your change/);
});

// The worker's reply (A11-300): the round ended with no push and the checks still red.
const ROUND: Readonly<Record<string, CheckHead>> = { [URL_1]: { head: HEAD, step: "round" } };
const reply = (host: ReturnType<typeof world>["host"], text: string, over: Partial<{ author: string; at: number }> = {}) =>
  host.pullAt(URL_1)!.replies = [{ author: WORKERS, at: NOW - 5 * MINUTE, url: `${URL_1}#issuecomment-1`, text, ...over }];

/** A round that ended with no push, a reply that says the failure is unrelated, the rerun it asks for, and the check red again ten minutes later: the rerun's record and the answer to the second look. */
function redAgainAfterReply({ watch, clock, host }: Pick<ReturnType<typeof world>, "watch" | "clock" | "host">) {
  reply(host, "This failure is unrelated to my change.");
  const rerun = watch(RED, ROUND);
  clock.at += 10 * MINUTE;
  return { rerun, again: watch(feedback(["suite (2)"], { failedAt: clock.at - MINUTE }), rerun.record) };
}

test("A11-300: a round that ends with no push and a reply that says the failure is unrelated ends in one rerun of the failed jobs", () => {
  const { host, watch, recorded, clock } = world();
  reply(host, "No change: SandboxNotRemovedError in region-paths-checkout.test.ts is the runner's, unrelated to this pull request.");
  const rerun = watch(RED, ROUND);
  assert.equal(rerun.feedback, null, "no second round");
  assert.deepEqual(host.checksAndClaims.reruns, [[SUITE_JOB]]);
  const replyRead = host.calls.indexOf(`readReplies ${URL_1}`);
  assert.ok(replyRead > 0 && host.calls[replyRead - 1] === `refreshPull ${URL_1}`, "A11-365: the round's replies are read afresh, once, so a reply posted just before the round ended is not missed for good");
  assert.deepEqual([rerun.heads[URL_1]?.step, rerun.heads[URL_1]?.rerun?.for], ["rerun", "reply"]);
  assert.match(rerun.heads[URL_1]?.note ?? "", /^Reran suite \(2\) on fc707690: the worker's reply says the failure is not from the change/);
  assert.deepEqual(rerun.withoutRound, rerun.heads, "recorded without a round");
  clock.at += 6 * MINUTE;
  const passed = watch(GREEN, rerun.record);
  assert.deepEqual([passed.feedback, recorded.map(({ check, head }) => [check, head])], [null, [["suite (2)", HEAD]]], "and green on that rerun it is a flake too");
});

test("A11-300: red again after the rerun a reply asked for, a person decides: no second round and no second rerun", () => {
  const { host, watch, clock } = world();
  const { again } = redAgainAfterReply({ watch, clock, host });
  assert.deepEqual([again.feedback, again.heads[URL_1]?.step, host.checksAndClaims.reruns.length], [null, "named", 1]);
  assert.match(again.heads[URL_1]?.note ?? "", /^suite \(2\) failed again on fc707690 after a rerun the worker's reply asked for: a person decides$/);
});

test("A11-300: a reply that does not say so, a reply by someone else and a reply from before the round are not a rerun; a round's replies are read once", () => {
  const { host, watch, ctx } = world();
  reply(host, "Fixed the assertion, see the new commit.");
  assert.deepEqual([watch(RED, ROUND).heads, host.checksAndClaims.reruns], [ROUND, []], "the worker says the failure is its own");
  ctx.repliesRead.clear();
  reply(host, "This is unrelated to my change.", { author: "someone-else" });
  assert.deepEqual([watch(RED, ROUND).heads, host.checksAndClaims.reruns], [ROUND, []], "only the workers' account counts");
  ctx.repliesRead.clear();
  reply(host, "This is unrelated to my change.", { at: NOW - 40 * MINUTE });
  assert.deepEqual([watch(RED, ROUND).heads, host.checksAndClaims.reruns], [ROUND, []], "a reply from before the round began is another round's");
  ctx.repliesRead.clear();
  reply(host, "Fixed the assertion, see the new commit.");
  watch(RED, ROUND);
  watch(RED, ROUND);
  assert.equal(host.calls.filter((call) => call.startsWith("readReplies")).length, 4, "three watches read once each, and the last two read once between them: a round's replies are read once");
});

test("A11-300: a red head the worker pushed to is a new head: its red check is rerun before a worker is asked again", () => {
  const { host, watch } = world();
  reply(host, "This is unrelated to my change.");
  const pushed = watch(RED, { [URL_1]: { head: "0".repeat(40), step: "round" } });
  assert.deepEqual([pushed.feedback, pushed.heads[URL_1]?.step, pushed.heads[URL_1]?.rerun?.for, host.checksAndClaims.reruns.length], [null, "rerun", "code", 1]);
});

test("A11-300: the words that say a failure is not the change's, and the words that do not", () => {
  const says = ["The failure is unrelated to this pull request.", "SandboxNotRemovedError is the runner's.", "Not caused by my change.", "This test is flaky.", "It is not related to my diff, so I changed nothing.", "The infrastructure failed.", "A pre-existing failure on main.", "It already fails on main."];
  const not = ["This is not a flake: it fails every time.", "It is not unrelated, my change broke it.", "Fixed the failing assertion.", "I pushed a fix for the sandbox.", "All checks pass locally.", "The test was related to my change, so I updated it."];
  assert.deepEqual([says.filter((text) => !saysUnrelated(text)), not.filter(saysUnrelated)], [[], []]);
});

test("A11-300: the test a failing check names is the first failing test of its log, else the first test file, else the check itself", () => {
  const read = (lines: readonly string[], name = "suite (2)"): ReadCheck => ({ name, lines, refusals: [], infrastructure: null, readable: true, detailsUrl: SUITE_JOB });
  assert.equal(failedTestOf(read(["FAIL  src/a.test.ts > a thing > does it", "AssertionError: x"])), "src/a.test.ts > a thing > does it");
  assert.equal(failedTestOf(read(["not ok 3 - git spawn classification", "AssertionError: x"])), "git spawn classification");
  assert.equal(failedTestOf(read(["SandboxNotRemovedError at src/packaging/region-paths-checkout.test.ts:41"])), "src/packaging/region-paths-checkout.test.ts");
  assert.equal(failedTestOf(read(["npm error code ETARGET"], "publish")), "publish");
  assert.equal(failedTestOf(read([`FAIL  ${"x".repeat(400)}`])).length, 160);
});

// A check red elsewhere (A11-179) beside the code's own: the rerun's record is not replaced by the hold.
const FOREIGN_JOB = "https://github.com/a11ign/agent-org/actions/runs/40382975999/job/9";
const onMain: ForeignReds = () => ({ names: new Set(["ui"]), onMain: new Set(["ui"]), mainPassing: null, mainPending: null, mainBranch: "main" });

test("A11-300: a rerun still under way keeps its record when only a check red on main is red meanwhile, so the rerun is neither made again nor forgotten", () => {
  const { host, ctx, entry, recorded, clock } = world();
  host.checksAndClaims.logs.set(FOREIGN_JOB, SANDBOX);
  const both = feedback(["suite (2)", "ui"], { failures: [{ name: "suite (2)", detailsUrl: SUITE_JOB }, { name: "ui", detailsUrl: FOREIGN_JOB }] });
  const watch = (read: PullFeedback, known?: Readonly<Record<string, CheckHead>>) => answerChecks(ctx, entry(known), [{ url: URL_1, read }], onMain);
  const first = watch(both);
  assert.deepEqual([first.heads[URL_1]?.step, host.checksAndClaims.reruns], ["rerun", [[SUITE_JOB]]], "the code's own check is rerun, and the one red on main is not");
  clock.at += 10 * MINUTE;
  const meanwhile = watch(feedback(["ui"], { failures: [{ name: "ui", detailsUrl: FOREIGN_JOB }], pendingRequired: ["suite (2)"] }), first.heads);
  assert.deepEqual([meanwhile.heads[URL_1]?.step, meanwhile.heads[URL_1]?.rerun?.for], ["rerun", "code"], "the hold does not replace the record while the rerun runs");
  const green = watch(feedback(["ui"], { failures: [{ name: "ui", detailsUrl: FOREIGN_JOB }] }), meanwhile.heads);
  assert.deepEqual([recorded.length, host.checksAndClaims.reruns.length], [1, 1], "the rerun passed: the flake is recorded, and nothing was rerun again");
  assert.deepEqual([green.heads[URL_1]?.step, green.heads[URL_1]?.rerun?.passed], ["rerun", true]);
  const held = watch(feedback(["ui"], { failures: [{ name: "ui", detailsUrl: FOREIGN_JOB }] }), green.heads);
  assert.equal(held.heads[URL_1]?.step, "not-ours", "and once the flake is recorded the check red on main is held as it was");
});

test("A11-300: a rerun of a worker's reply that is red again is named even with a check red on main beside it", () => {
  const { host, ctx, entry, clock } = world();
  host.checksAndClaims.logs.set(FOREIGN_JOB, SANDBOX);
  reply(host, "This is unrelated to my change.");
  const both = feedback(["suite (2)", "ui"], { failures: [{ name: "suite (2)", detailsUrl: SUITE_JOB }, { name: "ui", detailsUrl: FOREIGN_JOB }] });
  const watch = (read: PullFeedback, known: Readonly<Record<string, CheckHead>>) => answerChecks(ctx, entry(known), [{ url: URL_1, read }], onMain);
  const rerun = watch(both, ROUND);
  assert.equal(rerun.heads[URL_1]?.rerun?.for, "reply");
  clock.at += 10 * MINUTE;
  const again = watch(feedback(["suite (2)", "ui"], { failures: both.failures, failedAt: clock.at - MINUTE }), rerun.heads);
  assert.deepEqual([again.feedback, again.heads[URL_1]?.step, host.checksAndClaims.reruns.length], [null, "named", 1]);
});

test("A11-300: an infrastructure failure after a rerun of the code's own check is rerun once itself, and a person is named only if that is red again", () => {
  const { host, watch, clock } = world();
  const first = watch(RED);
  host.checksAndClaims.logs.set(SUITE_JOB, stamped(["##[error]The hosted runner lost communication with the server.", "##[error]Process completed with exit code 143."]));
  clock.at += 10 * MINUTE;
  const lost = watch(feedback(["suite (2)"], { failedAt: clock.at - MINUTE }), first.record);
  assert.deepEqual([lost.heads[URL_1]?.step, lost.feedback, host.checksAndClaims.reruns.length], ["rerun", null, 2], "its first infrastructure rerun");
  clock.at += 10 * MINUTE;
  const again = watch(feedback(["suite (2)"], { failedAt: clock.at - MINUTE }), lost.record);
  assert.deepEqual([again.heads[URL_1]?.step, host.checksAndClaims.reruns.length], ["named", 2]);
});

// THE ROUND CAP (A11-343): a round that answers only checks which count toward no cap says so on its record.
const UNRELATED_DECISION = "Do the work.\n\n## Decisions\n\n- `suite (2)` is red on main and unrelated to this change: this pull request does not fix it.\n";
const OTHER_HEAD = "b".repeat(40);

test("A11-343: a round for a check the ticket's Decisions call unrelated is uncounted; a round for any other check, or with no such Decision, is one of the board's own", () => {
  const unrelated = (description: string) => {
    const { watch, clock } = world(description);
    const first = watch(RED);
    clock.at += 10 * MINUTE;
    return watch(feedback(["suite (2)"], { failedAt: clock.at - MINUTE }), first.record);
  };
  const round = unrelated(UNRELATED_DECISION);
  assert.deepEqual([round.heads[URL_1]?.step, round.uncounted], ["round", true]);
  const plain = unrelated("Do the work.");
  assert.deepEqual([plain.heads[URL_1]?.step, plain.uncounted], ["round", false], "CONTROL: no Decision, so the round counts");
  const otherCheck = unrelated("Do the work.\n\n## Decisions\n\n- `lint` is red on main and unrelated to this change.\n");
  assert.deepEqual([otherCheck.heads[URL_1]?.step, otherCheck.uncounted], ["round", false], "CONTROL: a Decision about another check does not exempt this one");
});

test("A11-343: a check a rerun found red again stays uncounted at the next head, so the board's rounds are not used up on a failure no one fixes here", () => {
  const { watch, clock, host } = world();
  const { again } = redAgainAfterReply({ watch, clock, host });
  assert.deepEqual(again.heads[URL_1]?.redAgain, ["suite (2)"], "the record names what the rerun found red again");
  const next = feedback(["suite (2)"], { head: OTHER_HEAD });
  const reranAtNewHead = watch(next, again.record);
  assert.deepEqual([reranAtNewHead.heads[URL_1]?.step, reranAtNewHead.heads[URL_1]?.redAgain], ["rerun", ["suite (2)"]], "the new head's rerun carries it");
  clock.at += 10 * MINUTE;
  const round = watch(feedback(["suite (2)"], { head: OTHER_HEAD, failedAt: clock.at - MINUTE }), reranAtNewHead.record);
  assert.deepEqual([round.heads[URL_1]?.step, round.uncounted], ["round", true]);
});

test("A11-343: a Decision exempts a check by its whole name, not by a piece of another name or of a word", () => {
  assert.equal(callsUnrelated("- `build` is red on main and unrelated to this change.", "ui"), false, "ui is no piece of build");
  assert.equal(callsUnrelated("- `e2e-ui` is unrelated to this change.", "e2e"), false, "e2e is no piece of e2e-ui");
  assert.equal(callsUnrelated("- `suite (2)` is unrelated to this change.", "suite (2)"), true, "a name with brackets is matched as written");
  assert.equal(callsUnrelated("- `capture` is red because this pull request does not fix it.", "capture"), true);
  assert.equal(callsUnrelated("- `capture` must pass before merge.", "capture"), false, "naming a check is not calling it unrelated");
});

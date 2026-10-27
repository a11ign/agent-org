// no-token: gh -- the code host, the reviewer, herdr, the tracker and the clock are all injected fakes; nothing is spawned
// module: a run that used up the board's own rounds goes to the planner and not to a person (A11-343) -- the planner's round, its three outcomes (one more round with a Decision, a wait on a ticket, an escalation) and the wait's end
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeTicket } from "../plugins/fakes/tracker.ts";
import { runStatus } from "./board-view/pull-status-and-notes.ts";
import { reasonOf } from "./board-view/run-reason.ts";
import { CAP_DECISION_FILE, CAP_PLANNER_FILE } from "./cap-files.ts";
import { herdrName } from "./pool-herdr.ts";
import { clock, MINUTE, PLANNER, settled, standoffRun, trackerWith } from "./pool-standoff-fixture.ts";
import { WAIT_LIMIT_MS } from "./pool-cap.ts";
import { MAX_CAP_PLANS } from "./queue/queue-cap.ts";
import { enqueue } from "./queue/queue-entries-and-outcomes.ts";
import { emptyQueue } from "./queue.ts";
import { feedbackRound, finish, MAX_FEEDBACK_ROUNDS } from "./queue/queue-transitions.ts";
import { logOf } from "./queue/run-log.ts";
import { ticketDir } from "./ticket-paths.ts";

const WAITED = "NBF-2";

/** A run NBF-1 with all its rounds used, whose pull request got new review feedback after its last round ended, so the next watch is at the cap; the tracker holds NBF-2, which a planner may wait on. */
async function cappedRun(over: { planner?: boolean } = {}) {
  const tracker = trackerWith("Make the pages draw their last data at once.");
  tracker.seed(fakeTicket(WAITED));
  const run = await standoffRun({ tickets: over.planner === false ? {} : PLANNER, tracker, rounds: MAX_FEEDBACK_ROUNDS });
  run.pull.feedback = { feedbackAt: clock.ms + MINUTE, authors: ["a-human"] };
  const dir = ticketDir(run.fixture.settings, "NBF-1");
  const status = () => runStatus(run.entry());
  /** The watch finds the feedback at the cap, and the tick starts whatever it queued. */
  const reachCap = async () => {
    run.pool.watchFeedback();
    await run.pool.tick();
    await settled();
  };
  /** The planner ends its round, having written `decision` beside its outcome, or the outcome `outcome` alone. */
  const plannerEnds = async (decision: object | null, outcome: object = { kind: "reviewed" }) => {
    if (decision !== null) writeFileSync(join(dir, CAP_DECISION_FILE), JSON.stringify(decision));
    writeFileSync(join(dir, "outcome.json"), JSON.stringify(outcome));
    run.fixture.status.set(herdrName("NBF-1"), "idle");
    await run.pool.tick();
    await settled();
  };
  return { ...run, tracker, dir, status, reachCap, plannerEnds };
}

test("A11-343: a run that reaches the round cap gets a planner round and no Needs-you note: the planner's brief names the rounds, the feedback and the way out, and its Stop is held to a decision", async () => {
  const { entry, fixture, dir, status, reachCap } = await cappedRun();
  await reachCap();
  assert.equal(entry().handedBack, undefined, "no hand-back to a person");
  assert.equal(entry().phase, "running", "the planner's round is under way");
  assert.equal(entry().capRound !== undefined, true);
  assert.equal(entry().rounds, MAX_FEEDBACK_ROUNDS, "and it is not one of the board's own rounds");
  assert.notEqual(status(), "needs-you");
  const events = logOf(fixture.store.get(), "NBF-1");
  assert.deepEqual(events.flatMap((event) => (event.kind === "round" ? [event.cause] : [])), ["cap-planner"]);
  assert.equal(events.some((event) => event.kind === "needs-you"), false, "no Needs-you event is logged");
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.match(brief, /round-cap round \(planner\)/);
  for (const named of ["New review feedback on", CAP_DECISION_FILE, "\"decision\": \"waiting\"", "Escalate", "`contradicts`", "A round cap is not on the escalation list"]) {
    assert.ok(brief.includes(named), `the planner is told: ${named}`);
  }
  assert.ok(existsSync(join(dir, CAP_PLANNER_FILE)), "its Stop is held to a decision");
  assert.ok(readFileSync(join(dir, "deny.json"), "utf8").includes("a planning run changes no repository"), "and it changes no repository");
});

test("A11-343: CONTROL: a machine with no planner still hands the run to a person at the cap, as before", async () => {
  const { entry, status, reachCap } = await cappedRun({ planner: false });
  await reachCap();
  assert.match(entry().handedBack ?? "", /^The pull requests keep getting feedback: the board answered 3 rounds on its own and stopped\./);
  assert.equal(status(), "needs-you");
  assert.equal(entry().capRound, undefined);
});

test("A11-343: the planner records a Decision: one more round of the worker starts with it, and it counts toward no cap", async () => {
  const { entry, fixture, plannerEnds, reachCap, status } = await cappedRun();
  await reachCap();
  await plannerEnds({ decision: "round", reason: "The red check is the Auth0 failure A11-61 left; answer the review comment and say so." });
  assert.equal(entry().capRound, undefined);
  assert.equal(entry().waitingOnTicket, undefined);
  assert.deepEqual([entry().rounds, entry().review !== undefined], [MAX_FEEDBACK_ROUNDS, true]);
  assert.match(entry().feedback ?? "", /New review feedback on/);
  assert.match(entry().feedback ?? "", /> The red check is the Auth0 failure A11-61 left/);
  assert.notEqual(status(), "needs-you");
  const causes = logOf(fixture.store.get(), "NBF-1").flatMap((event) => (event.kind === "round" ? [event.cause] : []));
  assert.deepEqual(causes, ["cap-planner", "cap-round"]);
});

test("A11-343: the planner marks the run as waiting on a ticket: it reads Waiting on that ticket, not Needs you, holds its answers, and starts a round again when that ticket's pull request merges", async () => {
  const { entry, fixture, host, tracker, plannerEnds, pool, reachCap, status, url } = await cappedRun();
  await reachCap();
  await plannerEnds({ decision: "waiting", ticket: WAITED, reason: "capture stays red until its Auth0 fix merges" });
  assert.deepEqual([entry().phase, entry().waitingOnTicket?.key], ["finished", WAITED]);
  assert.equal(status(), "waiting");
  const view = entry();
  assert.match(reasonOf(view).line ?? "", /^Waiting on NBF-2: capture stays red until its Auth0 fix merges/);
  assert.equal(entry().handedBack, undefined);
  // While it waits, new feedback on the pull request starts nothing: the planner already decided what the run waits for.
  host.pullAt(url)!.feedback = { feedbackAt: clock.ms + 5 * MINUTE, authors: ["a-human"] };
  pool.watchFeedback();
  assert.deepEqual([entry().phase, entry().capRound], ["finished", undefined], "the wait holds the run");
  // The ticket it waits on opens its pull request: still waiting.
  tracker.linkPull(WAITED, "https://github.com/a11ign/x/pull/9", "open");
  await pool.refreshTracker();
  assert.equal(entry().waitingOnTicket?.key, WAITED);
  // Its pull request merges: the wait ends, and the run goes back on the queue as a round.
  tracker.linkPull(WAITED, "https://github.com/a11ign/x/pull/9", "merged");
  clock.ms += MINUTE;
  await pool.refreshTracker();
  assert.equal(entry().waitingOnTicket, undefined);
  assert.deepEqual([entry().phase, entry().review !== undefined, entry().rounds], ["queued", true, MAX_FEEDBACK_ROUNDS], "a round, which counts toward no cap");
  assert.match(entry().feedback ?? "", /^NBF-2 merged its pull request, and the board marked this run as waiting on it \(capture stays red until its Auth0 fix merges\)/);
  assert.deepEqual(logOf(fixture.store.get(), "NBF-1").flatMap((event) => (event.kind === "cap" ? [event.step] : [])), ["waiting", "resumed"]);
  await settled();
});

test("A11-343: a cap reached for a reason on the escalation list still reads Needs you: the planner stops on `needs-human` naming the item", async () => {
  const { entry, plannerEnds, reachCap, status } = await cappedRun();
  await reachCap();
  await plannerEnds(null, { kind: "needs-human", reason: "the feedback asks for a new colour, a reserved product decision", escalation: "reserved" });
  assert.deepEqual([entry().phase, entry().outcome?.kind], ["finished", "needs-human"]);
  assert.equal(status(), "needs-you", "this is the only way to a person");
});

test("A11-343: a planner round that decides nothing, or waits on the run's own ticket, ends as a failure with its reason and never loses the run", async () => {
  const none = await cappedRun();
  await none.reachCap();
  await none.plannerEnds(null);
  assert.equal(none.entry().outcome?.kind, "needs-human");
  const outcome = none.entry().outcome;
  assert.match(outcome?.kind === "needs-human" ? outcome.reason : "", /the planner's round at the round cap: the planner's round wrote no cap-decision\.json/);
  const own = await cappedRun();
  await own.reachCap();
  await own.plannerEnds({ decision: "waiting", ticket: "NBF-1", reason: "itself" });
  const reason = own.entry().outcome;
  assert.match(reason?.kind === "needs-human" ? reason.reason : "", /waits on its own ticket/);
});

test("A11-343: a wait on a ticket the tracker canceled ends too, so a run is never held for ever", async () => {
  const { entry, tracker, plannerEnds, pool, reachCap } = await cappedRun();
  await reachCap();
  await plannerEnds({ decision: "waiting", ticket: WAITED, reason: "needs its fix" });
  tracker.seed(fakeTicket(WAITED, { statusType: "canceled" }));
  await pool.refreshTracker();
  assert.equal(entry().waitingOnTicket, undefined);
  assert.match(entry().feedback ?? "", /^NBF-2 was canceled/);
  await settled();
});

const CAPTURE_JOB = "https://github.com/a11ign/nbl-ui-netbox/actions/runs/7/job/1";
const DECISION_OF_THE_TICKET = "Make the pages draw their last data at once.\n\n## Decisions\n\n- `capture` is the pre-existing Auth0 failure of A11-61, unrelated to this change: this pull request does not fix it, and A11-341 unblocks it.\n";

/** A run at its cap whose only red check is `capture`, and whose ticket's text is `description`: the first watch reruns it, and the second finds it red again at the same head. */
async function redCaptureRun(description: string) {
  const run = await standoffRun({ tickets: PLANNER, rounds: MAX_FEEDBACK_ROUNDS, tracker: trackerWith(description), descriptions: { "NBF-1": description } });
  run.host.checksAndClaims.logs.set(CAPTURE_JOB, "capture: the Auth0 sign-in was refused");
  run.pull.feedback = { failing: ["capture"], failures: [{ name: "capture", detailsUrl: CAPTURE_JOB }] };
  const watch = () => { clock.ms += MINUTE; run.pool.watchFeedback(); };
  watch();
  assert.deepEqual([run.entry().phase, run.entry().checkHeads?.[run.url]?.step], ["finished", "rerun"], "the first watch reruns the red check and starts no round");
  watch();
  await settled();
  return run;
}

test("A11-343: a round that answers only a check the ticket's Decisions call unrelated counts toward no cap: at the cap it still starts, and goes to no planner and no person", async () => {
  const { entry } = await redCaptureRun(DECISION_OF_THE_TICKET);
  assert.deepEqual([entry().phase, entry().rounds, entry().handedBack, entry().capRound], ["running", MAX_FEEDBACK_ROUNDS, undefined, undefined]);
  assert.match(entry().feedback ?? "", /^capture failed on the head commit of /);
  assert.notEqual(runStatus(entry()), "needs-you");
});

test("A11-343: CONTROL: the same red check with no Decision that calls it unrelated is one of the board's own rounds, so at the cap it goes to the planner", async () => {
  const { entry } = await redCaptureRun("Make the pages draw their last data at once.");
  assert.deepEqual([entry().phase, entry().rounds, entry().capRound?.latest.startsWith("capture failed")], ["running", MAX_FEEDBACK_ROUNDS, true], "the planner's round has started");
});

test("A11-343: the planner is bounded: past MAX_CAP_PLANS a `round` decision is refused, and the run is left as a failure with the reason, not looped", async () => {
  const run = await cappedRun();
  run.fixture.store.set({ ...run.fixture.store.get(), entries: run.fixture.store.get().entries.map((entry) => ({ ...entry, capPlans: MAX_CAP_PLANS })) });
  await run.reachCap();
  assert.equal(run.entry().capPlans, MAX_CAP_PLANS + 1);
  await run.plannerEnds({ decision: "round", reason: "one more" });
  const outcome = run.entry().outcome;
  assert.match(outcome?.kind === "needs-human" ? outcome.reason : "", /another round is refused: mark the run as waiting on a ticket, or escalate/);
});

test("A11-343: uncounted rounds are bounded too: after MAX_FEEDBACK_ROUNDS of them, the next round counts and a run at its cap goes to the planner", () => {
  const queue = finish(enqueue(emptyQueue(2), [{ key: "A", title: "A", description: "", url: "u", branch: "a", status: "Todo", statusOrder: 0, team: "T", project: null, priority: 0 } as never], { model: "opus", effort: "high" }, 1), "A", { kind: "ready-pr", prs: [{ repo: "r", url: "https://github.com/a11ign/r/pull/1" }] }, 3);
  const spent = { ...queue, entries: queue.entries.map((entry) => ({ ...entry, rounds: MAX_FEEDBACK_ROUNDS, freeRounds: MAX_FEEDBACK_ROUNDS, pullStates: { "https://github.com/a11ign/r/pull/1": "open" as const } })) };
  const routed = feedbackRound(spent, "A", "capture is red", 9, undefined, { planner: true, uncounted: true });
  assert.equal(routed.entries[0].capRound !== undefined, true);
});

/** A run that reached its cap and whose planner marked it as waiting on `ticket`. */
async function waitingOn(ticket: string) {
  const run = await cappedRun();
  await run.reachCap();
  await run.plannerEnds({ decision: "waiting", ticket, reason: "needs its fix" });
  return run;
}

test("A11-343: a wait ends when the ticket is not in the tracker, had all its pull requests closed, or has run a week; and a run its own tracker settled waits on nothing", async () => {
  const closed = await waitingOn(WAITED);
  closed.tracker.linkPull(WAITED, "https://github.com/a11ign/x/pull/9", "closed");
  await closed.pool.refreshTracker();
  assert.match(closed.entry().feedback ?? "", /^NBF-2 had its pull requests closed without a merge/);
  const missing = await waitingOn("NBF-77");
  await missing.pool.refreshTracker();
  assert.match(missing.entry().feedback ?? "", /^NBF-77 is not in the tracker/);
  const slow = await waitingOn(WAITED);
  clock.ms += WAIT_LIMIT_MS;
  await slow.pool.refreshTracker();
  assert.match(slow.entry().feedback ?? "", /^NBF-2 has not merged in a week/);
  const settledRun = await waitingOn(WAITED);
  settledRun.tracker.completeAs("NBF-1", "person");
  settledRun.tracker.linkPull(WAITED, "https://github.com/a11ign/x/pull/9", "merged");
  await settledRun.pool.refreshTracker();
  assert.equal(settledRun.entry().phase, "finished", "a run its tracker completed gets no round when the ticket it waited on merges");
  await settled();
});

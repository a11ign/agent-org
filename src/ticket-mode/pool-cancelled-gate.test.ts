// no-token: gh -- the pool over the fake code host; nothing reaches a network remote
// module: an approved, armed pull request that sits BLOCKED behind a cancelled run of its required check has the run rerun on a quiet head, up to a bound, on the board's own, and the card says when the board stops (A11-342, A11-403)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost, fakePullUrl, type FakePull } from "../plugins/fakes/code-host.ts";
import { poolFixture } from "./pool-fixture.ts";
import { finishedWith } from "./kept-pulls-fixture.ts";
import { logOf } from "./queue/run-log.ts";
import { reasonOf } from "./board-view/run-reason.ts";
import type { ViewEntry } from "./board-view/view-types-and-filters.ts";
import { cancelledRerunWords } from "./board-view/cancelled-rerun-words.ts";
import { cancelledGateRuns, MAX_CANCELLED_RUNS, MAX_REFUSALS } from "./pool-cancelled-gate.ts";
import { replace } from "./queue/queue-entries-and-outcomes.ts";
import type { PullFeedback } from "../plugins/contracts/code-host.ts";

const NOW = 1_000_000;
const REPOSITORY = "a11ign/announcement-emulator";
const URL = fakePullUrl(REPOSITORY, 32);
const KEY = "A11-229";
const HEAD = "8b3d0ba9d1b24e3b5828da68e14db3d2540d87f3";
/** The cancelled run of `ci` for the head (40438392613), as the check's job page names it. */
const CANCELLED_RUN = `https://github.com/${REPOSITORY}/actions/runs/40438392613/job/119700000001`;
/** A second cancelled run of `ci` for the head, as its job page names it. */
const OTHER_CANCELLED_RUN = `https://github.com/${REPOSITORY}/actions/runs/40438392487/job/119700000002`;

/** What the host reads of pull request #32 in the incident: approved at its head, armed, BLOCKED, `gate` green in one run and cancelled in the other. `over` changes it. */
const incident = (over: FakePull["feedback"] = {}): FakePull["feedback"] => ({
  verdictAtHead: "approved", reviewDecision: "approved", armed: true, blocked: true, cancelledRequired: [{ name: "gate", detailsUrl: CANCELLED_RUN }], ...over,
});

/** The pool over a world with pull request #32 (`feedback` is what the host says of it), the ticket finished on it. */
function world({ feedback = incident(), rerunnable = true }: { feedback?: FakePull["feedback"]; rerunnable?: boolean } = {}) {
  const host = createFakeCodeHost("worker-bot");
  host.seedPull(REPOSITORY, 32, { head: HEAD, feedback });
  if (!rerunnable) delete (host as { rerunRuns?: unknown }).rerunRuns;
  const fixture = poolFixture({ keys: [KEY], now: () => NOW });
  fixture.store.set(finishedWith(KEY, { kind: "ready-pr", prs: [{ repo: "announcement-emulator", url: URL }] }, NOW - 10));
  const pool = fixture.restart({ codeHost: host });
  const reruns = () => host.checksAndClaims.runReruns;
  const events = () => logOf(fixture.store.get(), KEY).filter((event) => event.kind === "cancelled-rerun");
  /** The line the run's card shows, read from the run as the queue holds it. */
  const cardLine = () => reasonOf(fixture.store.get().entries.find((entry) => entry.ticket.key === KEY) as unknown as ViewEntry).line;
  return { host, fixture, pool, reruns, events, cardLine };
}

/** What the board said to its own log while `run` ran. */
async function logged(run: () => Promise<void>): Promise<string> {
  const said: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((line: string) => { said.push(line); return true; }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = write;
  }
  return said.join("");
}

test("A11-342: an approved, armed pull request that reads BLOCKED, with its required check green in one run and cancelled in the other, has the cancelled run, and only it, rerun whole, and the run's log says so", async () => {
  const { pool, reruns, events } = world();
  const said = await logged(async () => { await pool.watchFeedback(); });
  assert.deepEqual(reruns(), [[CANCELLED_RUN]], "the cancelled run, and only it, is rerun, whole");
  assert.deepEqual(events(), [{ kind: "cancelled-rerun", url: URL, head: HEAD, checks: ["gate"], at: NOW }], "the run's log records the rerun for the pull request and the head");
  assert.ok(said.includes(cancelledRerunWords({ url: URL, head: HEAD, checks: ["gate"] })), "and the board's own log says the same line");
});

test("A11-403: the sequence of #2017: the rerun is cancelled while a sibling runs and succeeds, the board reruns once more after the sibling finishes, and a third cancelled run stops it, which the log, the board's own log and the card say", async () => {
  const { host, pool, reruns, events, cardLine } = world();
  const state = host.checksAndClaims;
  await pool.watchFeedback();
  assert.equal(reruns().length, 1, "the first cancelled run is rerun");
  // The rerun was cancelled when the sibling's gate started; the sibling is still running, so the board does not rerun into its concurrency group.
  state.runsInProgress = true;
  await pool.watchFeedback();
  await pool.watchFeedback();
  assert.equal(reruns().length, 1, "no rerun while a run of the workflow is in progress at the head");
  assert.equal(events().length, 1, "and nothing is logged for the wait");
  // The sibling finished green and the rerun's cancellation is all that is left.
  state.runsInProgress = false;
  await pool.watchFeedback();
  assert.deepEqual(reruns(), [[CANCELLED_RUN], [CANCELLED_RUN]], "once more after the sibling finished");
  assert.equal(cardLine(), null, "two reruns are no stop");
  // The second rerun is cancelled as well: the third cancelled run of the head.
  const said = await logged(async () => { await pool.watchFeedback(); });
  const stop = { url: URL, head: HEAD, checks: ["gate"], stopped: true as const };
  assert.equal(reruns().length, 2, "the third cancelled run is not rerun");
  assert.deepEqual(events().map((event) => (event.kind === "cancelled-rerun" ? event.stopped : null)), [undefined, undefined, true], "the log says the board stopped");
  assert.ok(said.includes(cancelledRerunWords(stop)), "and so does the board's own log");
  assert.equal(cardLine(), `a11ign/announcement-emulator #32 is blocked behind a cancelled run of gate at 8b3d0ba9: cancelled ${MAX_CANCELLED_RUNS} times, the board has stopped rerunning it; a new push or a rerun clears it`, "and the card");
  for (const later of ["a later watch", "and another"]) {
    await pool.watchFeedback();
    assert.deepEqual([later, reruns().length, events().length], [later, 2, 3], "reruns and logs nothing more");
  }
});

test("A11-403: the board asks the code host about the cancelled run's workflow at the head, with the run it would rerun, before it reruns", async () => {
  const { host, pool } = world();
  await pool.watchFeedback();
  assert.deepEqual(host.checksAndClaims.inProgressAsked, [{ detailsUrls: [CANCELLED_RUN], head: HEAD }]);
});

test("A11-403: #2017's order: a sibling run is in progress when the board first reads the cancelled run, so nothing is rerun, logged or said, and the rerun is made once the sibling finished", async () => {
  const { host, pool, reruns, events, cardLine } = world();
  host.checksAndClaims.runsInProgress = true;
  const said = await logged(async () => { await pool.watchFeedback(); await pool.watchFeedback(); });
  assert.deepEqual([reruns(), events(), cardLine(), said], [[], [], null, ""]);
  host.checksAndClaims.runsInProgress = false;
  await pool.watchFeedback();
  assert.deepEqual(reruns(), [[CANCELLED_RUN]]);
});

test("A11-403: a read of the run list that failed is not a quiet head: the board reruns nothing and asks again at the next watch", async () => {
  const { host, pool, reruns, events } = world();
  host.checksAndClaims.runsInProgress = null;
  await pool.watchFeedback();
  assert.deepEqual([reruns(), events()], [[], []]);
  host.checksAndClaims.runsInProgress = false;
  await pool.watchFeedback();
  assert.equal(reruns().length, 1);
});

test("A11-403: a code host whose run read rejects is not a quiet head either: nothing is rerun and the watch goes on", async () => {
  const { host, pool, reruns } = world();
  host.runsInProgress = async () => { throw new Error("gh: stand-in"); };
  await assert.doesNotReject(async () => { await pool.watchFeedback(); });
  assert.deepEqual(reruns(), []);
});

test("A11-403: the board reruns one run for each watch, however many cancelled runs it lists, because two reruns in one concurrency group cancel each other", async () => {
  const { pool, reruns, host } = world({ feedback: incident({ cancelledRequired: [{ name: "gate", detailsUrl: CANCELLED_RUN }, { name: "gate", detailsUrl: OTHER_CANCELLED_RUN }] }) });
  await pool.watchFeedback();
  assert.deepEqual(reruns(), [[CANCELLED_RUN]]);
  assert.deepEqual(host.checksAndClaims.inProgressAsked.map(({ detailsUrls }) => detailsUrls), [[CANCELLED_RUN, OTHER_CANCELLED_RUN]], "the question covers every listed run's workflow");
});

test("A11-403: a rerun the host took is not read as another cancelled run while a run of the workflow is in progress: the board does not stop on the cancelled state it has not yet seen change", async () => {
  const { host, pool, reruns, events, cardLine } = world();
  await pool.watchFeedback();
  await pool.watchFeedback();
  assert.equal(reruns().length, 2);
  host.checksAndClaims.runsInProgress = true;
  await pool.watchFeedback();
  assert.deepEqual([events().length, cardLine()], [2, null], "the second rerun is running, and a read that still shows it cancelled is stale");
});

test("A11-403: the card's line goes when the head moves, and when the cancelled runs no longer block", async () => {
  const { host, pool, cardLine } = world();
  for (let watch = 0; watch < 3; watch += 1) await pool.watchFeedback();
  assert.ok(cardLine() !== null, "POSITIVE CONTROL: the stop is shown");
  host.pullAt(URL)!.head = "c0ffee00d1b24e3b5828da68e14db3d2540d87f3";
  await pool.watchFeedback();
  assert.equal(cardLine(), null, "a new head");
  host.pullAt(URL)!.head = HEAD;
  await pool.watchFeedback();
  assert.ok(cardLine() !== null, "the old head, read again, is still stopped: the log is what bounds it");
  host.pullAt(URL)!.feedback = incident({ cancelledRequired: [], blocked: false });
  await pool.watchFeedback();
  assert.equal(cardLine(), null, "the cancelled runs no longer block it");
});

test("A11-342, A11-403: the bound is the run's log, so a restart of the board neither reruns a third time nor stops twice", async () => {
  const { fixture, host, pool, reruns, events } = world();
  await pool.watchFeedback();
  await pool.watchFeedback();
  const restarted = fixture.restart({ codeHost: host });
  await restarted.watchFeedback();
  await restarted.watchFeedback();
  assert.equal(reruns().length, 2, "the restarted board read the log and did not rerun a third time");
  assert.equal(events().filter((event) => event.kind === "cancelled-rerun" && event.stopped === true).length, 1, "and stopped once");
});

test("A11-342: a new head is a new case: the run that is cancelled at it is rerun once as well", async () => {
  const { host, pool, reruns, events } = world();
  await pool.watchFeedback();
  const next = "c0ffee00d1b24e3b5828da68e14db3d2540d87f3";
  host.pullAt(URL)!.head = next;
  await pool.watchFeedback();
  assert.equal(reruns().length, 2, "one rerun for each head");
  assert.deepEqual(events().map((event) => (event.kind === "cancelled-rerun" ? event.head : "")), [HEAD, next]);
});

test("A11-342: a pull request that is not approved at its head has nothing rerun", async () => {
  for (const [what, over] of [["no verdict", { verdictAtHead: null }], ["changes requested", { verdictAtHead: "changes-requested" as const }], ["a review decision that still asks for a review", { reviewDecision: "review-required" as const }]] as const) {
    const { pool, reruns, events } = world({ feedback: incident(over) });
    await pool.watchFeedback();
    assert.deepEqual([what, reruns(), events()], [what, [], []]);
  }
});

test("A11-342: a pull request that is not armed, not blocked, or blocked on something other than cancelled runs has nothing rerun", async () => {
  for (const [what, over] of [["not armed", { armed: false }], ["armed is not said", { armed: undefined }], ["not blocked", { blocked: false }], ["blocked on something else", { cancelledRequired: [] }]] as const) {
    const { pool, reruns, events } = world({ feedback: incident(over) });
    await pool.watchFeedback();
    assert.deepEqual([what, reruns(), events()], [what, [], []]);
  }
});

test("A11-342: a refused rerun is logged with its reason, is not taken as done, and is asked again at the next watch", async () => {
  const { host, pool, reruns, events } = world();
  host.checksAndClaims.rerunRefusal = "run 40438392613 cannot be rerun";
  const said = await logged(async () => { await pool.watchFeedback(); });
  assert.deepEqual([reruns(), events().map((event) => (event.kind === "cancelled-rerun" ? event.refused : ""))], [[], ["run 40438392613 cannot be rerun"]]);
  assert.ok(said.includes(cancelledRerunWords({ url: URL, head: HEAD, checks: ["gate"], refused: "run 40438392613 cannot be rerun" })));
  host.checksAndClaims.rerunRefusal = null;
  await pool.watchFeedback();
  assert.deepEqual([reruns(), events().length], [[[CANCELLED_RUN]], 2], "taken at the second try");
  await pool.watchFeedback();
  await pool.watchFeedback();
  assert.deepEqual([reruns().length, events().length], [2, 4], "a refusal is no rerun: two are taken, and the third watch after them only stops");
});

test("A11-342: a rerun that is refused every time is asked three times for a head and then left, so the board does not call the host at every watch for ever", async () => {
  const { host, pool, events } = world();
  host.checksAndClaims.rerunRefusal = "Resource not accessible (HTTP 403)";
  for (let watch = 0; watch < 6; watch += 1) await pool.watchFeedback();
  assert.equal(host.calls.filter((call) => call === "rerunRuns").length, MAX_REFUSALS);
  assert.equal(events().length, MAX_REFUSALS);
});

test("A11-342: a run a person stopped, and one the tracker settled, have nothing rerun, as they have no base merged", async () => {
  for (const [what, outcome, tracker] of [["stopped", { kind: "stopped" }, undefined], ["settled by the tracker", { kind: "ready-pr", prs: [{ repo: "announcement-emulator", url: URL }] }, "completed"]] as const) {
    const { fixture, pool, reruns, events } = world();
    fixture.store.set(finishedWith(KEY, { ...outcome, prs: [{ repo: "announcement-emulator", url: URL }] } as Parameters<typeof finishedWith>[1], NOW - 10));
    if (tracker !== undefined) fixture.store.set(replace(fixture.store.get(), KEY, (entry) => ({ ...entry, trackerState: tracker })));
    await pool.watchFeedback();
    assert.deepEqual([what, reruns(), events()], [what, [], []]);
  }
});

test("A11-342: a code host that cannot rerun a whole run is left alone: nothing is recorded, and nothing throws", async () => {
  const { pool, events, cardLine } = world({ rerunnable: false });
  await assert.doesNotReject(async () => { await pool.watchFeedback(); });
  assert.deepEqual([events(), cardLine()], [[], null]);
});

test("A11-403: a code host that cannot say whether a run is in progress is read as one that has a quiet head: the board reruns as it did, under the same bound", async () => {
  const { host, pool, reruns, events } = world();
  delete (host as { runsInProgress?: unknown }).runsInProgress;
  for (let watch = 0; watch < 4; watch += 1) await pool.watchFeedback();
  assert.equal(reruns().length, 2);
  assert.deepEqual(events().map((event) => (event.kind === "cancelled-rerun" ? event.stopped : null)), [undefined, undefined, true]);
});

test("A11-342: the cancelled runs to rerun are those of an open pull request, and a run with no job page is left out", () => {
  const read = (over: Partial<PullFeedback> = {}): PullFeedback => ({ state: "open", feedbackAt: null, authors: [], failing: [], failures: [], failedAt: null, conflicting: false, mergeable: false, head: HEAD, approvedAtHead: true, base: "main",
    files: [], filesComplete: true, verdictAtHead: "approved", reviewDecision: "approved", armed: true, blocked: true, cancelledRequired: [{ name: "gate", detailsUrl: CANCELLED_RUN }, { name: "docs", detailsUrl: null }], ...over });
  assert.deepEqual(cancelledGateRuns(read()), [CANCELLED_RUN]);
  assert.deepEqual(cancelledGateRuns(read({ state: "closed" })), [], "a closed pull request");
  assert.deepEqual(cancelledGateRuns(read({ head: null })), [], "a head the host does not give");
});

// no-token: gh -- the pool over the fake code host; nothing reaches a network remote
// module: an approved, armed pull request that sits BLOCKED behind a cancelled duplicate run of its required check has the run rerun once, on the board's own (A11-342)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost, fakePullUrl, type FakePull } from "../plugins/fakes/code-host.ts";
import { poolFixture } from "./pool-fixture.ts";
import { finishedWith } from "./kept-pulls-fixture.ts";
import { logOf } from "./queue/run-log.ts";
import { cancelledRerunWords } from "./board-view/cancelled-rerun-words.ts";
import { cancelledGateRuns, MAX_REFUSALS } from "./pool-cancelled-gate.ts";
import { replace } from "./queue/queue-entries-and-outcomes.ts";
import type { PullFeedback } from "../plugins/contracts/code-host.ts";

const NOW = 1_000_000;
const REPOSITORY = "a11ign/announcement-emulator";
const URL = fakePullUrl(REPOSITORY, 32);
const KEY = "A11-229";
const HEAD = "8b3d0ba9d1b24e3b5828da68e14db3d2540d87f3";
/** The cancelled run of `ci` for the head (40438392613), as the check's job page names it. */
const CANCELLED_RUN = `https://github.com/${REPOSITORY}/actions/runs/40438392613/job/119700000001`;

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
  return { host, fixture, pool, reruns, events };
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

test("A11-342: an approved, armed pull request that reads BLOCKED, with its required check green in one run and cancelled in the other, has the cancelled run rerun exactly once, and the run's log says so", async () => {
  const { pool, reruns, events } = world();
  const said = await logged(async () => { await pool.watchFeedback(); });
  assert.deepEqual(reruns(), [[CANCELLED_RUN]], "the cancelled run, and only it, is rerun, whole");
  assert.deepEqual(events(), [{ kind: "cancelled-rerun", url: URL, head: HEAD, checks: ["gate"], at: NOW }], "the run's log records the rerun for the pull request and the head");
  assert.ok(said.includes(cancelledRerunWords({ url: URL, head: HEAD, checks: ["gate"] })), "and the board's own log says the same line");
  await pool.watchFeedback();
  await pool.watchFeedback();
  assert.equal(reruns().length, 1, "a later watch that reads it blocked again at the same head reruns nothing more");
  assert.equal(events().length, 1, "and logs nothing more");
});

test("A11-342: the once bound is the run's log, so a restart of the board does not rerun the cancelled run a second time", async () => {
  const { fixture, host, pool, reruns } = world();
  await pool.watchFeedback();
  const restarted = fixture.restart({ codeHost: host });
  await restarted.watchFeedback();
  assert.equal(reruns().length, 1, "the restarted board read the log and did not ask again");
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
  await pool.watchFeedback();
  assert.deepEqual([reruns(), events().length], [[[CANCELLED_RUN]], 2], "taken at the second try, and not asked a third time");
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
  const { pool, events } = world({ rerunnable: false });
  await assert.doesNotReject(async () => { await pool.watchFeedback(); });
  assert.deepEqual(events(), []);
});

test("A11-342: the cancelled runs to rerun are those of an open pull request, and a run with no job page is left out", () => {
  const read = (over: Partial<PullFeedback> = {}): PullFeedback => ({ state: "open", feedbackAt: null, authors: [], failing: [], failures: [], failedAt: null, conflicting: false, mergeable: false, head: HEAD, approvedAtHead: true, base: "main",
    files: [], filesComplete: true, verdictAtHead: "approved", reviewDecision: "approved", armed: true, blocked: true, cancelledRequired: [{ name: "gate", detailsUrl: CANCELLED_RUN }, { name: "docs", detailsUrl: null }], ...over });
  assert.deepEqual(cancelledGateRuns(read()), [CANCELLED_RUN]);
  assert.deepEqual(cancelledGateRuns(read({ state: "closed" })), [], "a closed pull request");
  assert.deepEqual(cancelledGateRuns(read({ head: null })), [], "a head the host does not give");
});

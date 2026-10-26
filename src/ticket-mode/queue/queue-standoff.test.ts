// no-token: none -- the queue's transitions are pure
// module: the stand-off of a re-review that stays not convinced, and the two rounds that settle it (A11-290)
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyQueue } from "../queue.ts";
import { retry, type Entry, type Queue } from "./queue-entries-and-outcomes.ts";
import { checkRound, finish } from "./queue-transitions.ts";
import { plannerDecided, recordRereview, settleStandoff, standoffRound, workerRoundEnded } from "./queue-standoff.ts";
import { interventionsView } from "./interventions.ts";
import { logOf, REREVIEW_REASONS_MAX } from "./run-log.ts";
import type { Standoff } from "./standoff-types.ts";

const URL = "https://github.com/a11ign/agent-org/pull/1933";
const ticket = { key: "A11-270", title: "t", description: "", url: "u", branch: "b", status: "s", statusOrder: 0, team: "A11", project: null, priority: 0 };
const RESULT = { url: URL, head: "h1", review: "The bundle is over 200 KB.", verdict: "not-convinced", reasons: "Still 340 KB.", reply: "Plan cannot be met.", decisions: null } as const;

/** A finished run holding the pull request, with `over` on it. */
const run = (over: Partial<Entry> = {}): Queue => ({
  ...emptyQueue(3),
  entries: [{ ticket, repos: [], model: "m", effort: "e", phase: "finished", queuedAt: 0, rounds: 1, outcome: { kind: "reviewed", prs: [{ repo: "agent-org", url: URL }] }, ...over } as unknown as Entry],
});
const entryOf = (queue: Queue): Entry => queue.entries[0];

test("A11-290: a not-convinced result opens the stand-off and is logged with the reasons; a later result for the same head keeps the stage and takes the newest reasons", () => {
  const opened = recordRereview(run(), "A11-270", RESULT, 100);
  assert.deepEqual(entryOf(opened).standoff, { url: URL, head: "h1", review: RESULT.review, reasons: "Still 340 KB.", reply: "Plan cannot be met.", decisions: null, stage: "open" });
  assert.deepEqual(logOf(opened, "A11-270").map(({ at: _at, ...event }) => event), [{ kind: "rereview", url: URL, head: "h1", verdict: "not-convinced", reasons: "Still 340 KB." }]);
  // The planner's round has run and finished, having decided; the amended plan's re-review stays not convinced.
  const decided = plannerDecided(standoffRound(opened, "A11-270", "planner", "feedback", 200), "A11-270", { decision: "amended", reason: "r" }, 250);
  const finished = { ...decided, entries: [{ ...entryOf(decided), phase: "finished" as const }] };
  const again = recordRereview(finished, "A11-270", { ...RESULT, reasons: "Still 340 KB, after the amendment." }, 300);
  assert.equal(entryOf(again).standoff?.stage, "planned", "the stage is kept");
  assert.equal(entryOf(again).standoff?.planner?.decision, "amended", "and so is what the planner decided");
  assert.equal(entryOf(again).standoff?.reasons, "Still 340 KB, after the amendment.");
});

test("A11-290: a convinced result is logged and opens nothing; a run still in its round takes the log line and no stand-off; reasons are cut", () => {
  const approved = recordRereview(run(), "A11-270", { ...RESULT, verdict: "convinced" }, 100);
  assert.equal(entryOf(approved).standoff, undefined);
  assert.equal(logOf(approved, "A11-270").length, 1);
  const mid = recordRereview(run({ phase: "running" }), "A11-270", RESULT, 100);
  assert.equal(entryOf(mid).standoff, undefined);
  const long = recordRereview(run(), "A11-270", { ...RESULT, reasons: "x".repeat(REREVIEW_REASONS_MAX + 500) }, 100);
  const event = logOf(long, "A11-270")[0];
  assert.ok(event.kind === "rereview" && event.reasons.length === REREVIEW_REASONS_MAX && event.reasons.endsWith("…"));
  assert.equal(recordRereview(run(), "A11-270", RESULT).runLog, undefined, "a caller with no clock logs nothing, as every transition does");
});

test("A11-290: the planner's round and the worker's round are review rounds of the same pull requests that carry the feedback and charge no round", () => {
  const opened = recordRereview(run(), "A11-270", RESULT, 100);
  const planner = standoffRound(opened, "A11-270", "planner", "the account", 200);
  assert.deepEqual([entryOf(planner).phase, entryOf(planner).standoff?.stage, entryOf(planner).feedback, entryOf(planner).rounds], ["queued", "planner", "the account", 1]);
  assert.deepEqual(entryOf(planner).review, [{ repo: "agent-org", url: URL }]);
  const worker = standoffRound(opened, "A11-270", "worker", "the reasons", 200);
  assert.deepEqual([entryOf(worker).standoff?.stage, entryOf(worker).rounds], ["worker", 1]);
  assert.deepEqual(logOf(worker, "A11-270").filter((event) => event.kind === "round").map((event) => event.kind === "round" && event.cause), ["standoff-worker"]);
});

test("A11-290: a round starts only from the stage it may: the planner's from open, the worker's from open or planned, and neither for a run that is not finished", () => {
  const open = recordRereview(run(), "A11-270", RESULT, 100);
  const decided = plannerDecided(standoffRound(open, "A11-270", "planner", "x", 150), "A11-270", { decision: "upheld", reason: "r" }, 160);
  assert.equal(entryOf(decided).standoff?.stage, "planned", "decided; the run has finished by now in the pool, and here the entry still holds the queued round");
  const finished = { ...decided, entries: [{ ...entryOf(decided), phase: "finished" as const }] };
  assert.equal(entryOf(standoffRound(finished, "A11-270", "planner", "x", 200)).phase, "finished", "the planner has decided: no second planner round");
  assert.equal(entryOf(standoffRound(finished, "A11-270", "worker", "x", 200)).standoff?.stage, "worker");
  assert.equal(standoffRound(run({ phase: "running", standoff: { ...(entryOf(open).standoff as Standoff) } }), "A11-270", "worker", "x", 200).entries[0].phase, "running");
  const done = workerRoundEnded({ ...finished, entries: [{ ...entryOf(finished), standoff: { ...(entryOf(finished).standoff as Standoff), stage: "worker" } }] }, "A11-270");
  assert.equal(entryOf(done).standoff?.stage, "done");
  assert.equal(entryOf(standoffRound(done, "A11-270", "worker", "x", 300)).phase, "finished", "a stand-off is routed once for each head");
});

test("A11-290: a stand-off ends with no person when the pull request moves to a new head or is approved at its head, and is counted once, then", () => {
  const open = recordRereview(run({ pullHeads: { [URL]: { head: "h1", approved: false, review: "changes-requested" } } }), "A11-270", RESULT, 100);
  assert.equal(entryOf(settleStandoff(open, "A11-270", 200)).standoff?.stage, "open", "still blocked at its head: nothing settled");
  const moved = settleStandoff({ ...open, entries: [{ ...entryOf(open), pullHeads: { [URL]: { head: "h2", approved: false, review: "none" } } }] }, "A11-270", 200);
  assert.equal(entryOf(moved).standoff, undefined);
  assert.deepEqual(moved.interventions, { "1970-01-01": { needsYou: 0, fixes: 0, standoffs: 1 } }, "counted on the day it settled, beside the interventions");
  assert.deepEqual(settleStandoff(moved, "A11-270", 300).interventions, moved.interventions, "a second read finds no stand-off to settle");
  const today = interventionsView(moved, 300).days.at(-1);
  assert.deepEqual(today, { date: "1970-01-01", needsYou: 0, fixes: 0, total: 0, standoffs: 1 }, "the health number shows it, and it is no intervention: the total stays 0");
});

test("A11-290: a stand-off round that ends on anything but reviewed has ended its route, so a later round of the run is no stand-off round", () => {
  const open = recordRereview(run(), "A11-270", RESULT, 100);
  for (const stage of ["planner", "worker"] as const) {
    const round = standoffRound(open, "A11-270", stage, "x", 200);
    const stopped = finish(round, "A11-270", { kind: "needs-human", reason: "the fix needs a licence", escalation: "legal" }, 300);
    assert.equal(entryOf(stopped).standoff?.stage, "done", stage);
    const later = checkRound(stopped, "A11-270", "a check is red", 400, {});
    assert.equal(entryOf(later).standoff?.stage, "done", `a red-check round after a ${stage} round that stopped is a plain round`);
  }
  const reviewed = finish(standoffRound(open, "A11-270", "worker", "x", 200), "A11-270", { kind: "reviewed", prs: [] }, 300);
  assert.equal(entryOf(reviewed).standoff?.stage, "worker", "a worker round that reviewed is ended by the pool, which says so (workerRoundEnded)");
});

test("A11-290: a retry of a crashed stand-off round keeps the stand-off, which its card and its flag read", () => {
  const open = recordRereview(run(), "A11-270", RESULT, 100);
  const crashed = finish(standoffRound(open, "A11-270", "worker", "x", 200), "A11-270", { kind: "crashed", reason: "herdr died" }, 300);
  const retried = retry(crashed, "A11-270", 400);
  assert.equal(entryOf(retried).standoff?.url, URL);
  assert.equal(entryOf(retried).standoff?.stage, "done");
});

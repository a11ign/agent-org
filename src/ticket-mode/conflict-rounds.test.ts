// no-token: gh -- A11-374: a conflict round answers no review, so it is not one of the board's own rounds
import { test } from "node:test";
import assert from "node:assert/strict";
import { keptPullRound } from "./pool-base-merge.ts";
import { conflictFields, conflictRoundFeedback, conflictRoundLeft } from "./queue/queue-conflict-rounds.ts";
import type { Entry, Queue } from "./queue/queue-entries-and-outcomes.ts";
import { MAX_FEEDBACK_ROUNDS, conflictRound, feedbackRound, roundsLeft } from "./queue/queue-transitions.ts";

const URL_A = "https://github.com/a11ign/agent-org/pull/21";
const URL_B = "https://github.com/a11ign/agent-org/pull/22";
const PULL = { repo: "agent-org", url: URL_A };

function run(key: string, over: Record<string, unknown> = {}): Entry {
  return ({ ticket: { key, title: key, description: "", url: `https://linear.app/a11ign/issue/${key}`, branch: key.toLowerCase() }, repos: [], model: "opus", effort: "high", phase: "queued", queuedAt: 1, ...over }) as unknown as Entry;
}

/** A finished run the board watches (its pull request is approved and green), at `rounds` of its own. */
const watched = (over: Record<string, unknown> = {}): Entry => run("A11-1", {
  phase: "finished", finishedAt: 5, outcome: { kind: "reviewed", prs: [PULL] }, pullStates: { [URL_A]: "open" }, pullHeads: { [URL_A]: { head: "h".repeat(40), approved: true, review: "approved", red: [], pending: [] } }, ...over });

/** A finished run that is parked on a question: the board resumes it for a conflict, and does not watch it. */
const parked = (over: Record<string, unknown> = {}): Entry => run("A11-1", {
  phase: "finished", finishedAt: 5, outcome: { kind: "needs-human", reason: "which colour?" }, review: [PULL], pullStates: { [URL_A]: "open" }, ...over });

const queueOf = (...entries: Entry[]): Queue => ({ entries, max: 4, paused: false }) as unknown as Queue;
const at = (queue: Queue, key = "A11-1"): Entry => queue.entries.find((entry) => entry.ticket.key === key)!;
const on = (base: string | null, url = URL_A) => ({ [url]: { base } });

test("A11-374: a conflict round does not use up the cap: a run at its 3 rounds still gets one, and its rounds are as they were", () => {
  const spent = { rounds: MAX_FEEDBACK_ROUNDS, freeRounds: 2 };
  const kept = keptPullRound(queueOf(run("A11-1", { ...spent, phase: "queued", afterRound: undefined })), "A11-1", [PULL], "Conflict.", 9, on("base-1"));
  assert.equal(at(kept).review?.length, 1, "keptPullRound queues the round");
  assert.deepEqual([at(kept).rounds, at(kept).freeRounds], [MAX_FEEDBACK_ROUNDS, 2], "keptPullRound: neither rounds nor freeRounds moved");
  const unwatched = conflictRound(queueOf(parked(spent)), "A11-1", "Conflict.", 9, on("base-1"));
  assert.equal(at(unwatched).phase, "queued", "conflictRound queues the round");
  assert.deepEqual([at(unwatched).rounds, at(unwatched).freeRounds], [MAX_FEEDBACK_ROUNDS, 2], "conflictRound: neither moved");
  const asked = feedbackRound(queueOf(watched(spent)), "A11-1", "A conflict.", 9, undefined, { conflictOnly: on("base-1") });
  assert.equal(at(asked).phase, "queued", "feedbackRound with a conflict alone queues the round");
  assert.deepEqual([at(asked).rounds, at(asked).freeRounds, at(asked).handedBack], [MAX_FEEDBACK_ROUNDS, 2, undefined], "and hands nothing back");
  assert.equal(roundsLeft(at(asked)), false, "the cap is where it was");
});

test("A11-374: any other round at the cap is handed back as before: a round that answers a review counts", () => {
  const handed = feedbackRound(queueOf(watched({ rounds: MAX_FEEDBACK_ROUNDS })), "A11-1", "New review feedback on x.", 9);
  assert.equal(at(handed).phase, "finished");
  assert.match(at(handed).handedBack ?? "", /keep getting feedback/);
  const counted = feedbackRound(queueOf(watched({ rounds: 1 })), "A11-1", "New review feedback on x.\nA conflict.", 9);
  assert.equal(at(counted).rounds, 2, "a round for a review and a conflict together counts");
});

test("A11-374: a conflict at the base the last conflict round was started at counts, and at the cap it goes where any other trigger goes", () => {
  const first = conflictRound(queueOf(parked({ rounds: 2 })), "A11-1", "Conflict.", 9, on("base-1"));
  assert.deepEqual([at(first).rounds, at(first).conflictBase], [2, { [URL_A]: "base-1" }], "a new base is uncounted, and recorded");
  const again = conflictRound(queueOf({ ...at(first), phase: "finished", review: [PULL] } as Entry), "A11-1", "Conflict.", 10, on("base-1"));
  assert.equal(at(again).rounds, 3, "the same base again is the worker's own failure to resolve it, and counts");
  const stuck = conflictRound(queueOf({ ...at(first), phase: "finished", review: [PULL], rounds: MAX_FEEDBACK_ROUNDS } as Entry), "A11-1", "Conflict.", 11, on("base-1"));
  assert.equal(at(stuck).phase, "finished", "and at the cap no round is queued");
  const capped = feedbackRound(queueOf({ ...watched({ rounds: MAX_FEEDBACK_ROUNDS, conflictBase: { [URL_A]: "base-1" } }) }), "A11-1", "A conflict.", 12, undefined, { conflictOnly: on("base-1") });
  assert.match(at(capped).handedBack ?? "", /keep getting feedback/, "a watched run is handed back there");
  assert.equal(conflictRoundLeft(at(first), on("base-2")), true, "a base that moved earns one");
  const atCap = { ...at(first), rounds: MAX_FEEDBACK_ROUNDS } as Entry;
  assert.equal(conflictRoundLeft(atCap, on("base-2")), true, "even at the cap");
  assert.equal(conflictRoundLeft(atCap, on(null)), false, "but a conflict whose base is not known counts as every conflict round did, and the cap stops it");
  assert.equal(conflictRoundLeft({ ...atCap, rounds: 0 } as Entry, on(null)), true, "while it has rounds left");
});

test("A11-374: every conflict round's reason starts with its number on the pull request, and counts are per pull request", () => {
  let queue = queueOf(parked());
  for (const [n, base] of [[1, "b1"], [2, "b2"], [3, "b3"]] as const) {
    queue = conflictRound({ ...queue, entries: queue.entries.map((entry) => ({ ...entry, phase: "finished", review: [PULL] }) as Entry) }, "A11-1", "Conflict.", 10 + n, on(base));
    assert.match(at(queue).feedback ?? "", new RegExp(`^Conflict ${n} on #21:\\nConflict\\.$`), `round ${n}`);
    assert.equal((queue.runLog?.["A11-1"]?.at(-1) as { reason?: string }).reason, `Conflict ${n} on #21:`, "the run log's reason keeps the prefix");
  }
  assert.deepEqual(at(queue).conflictRounds, { [URL_A]: 3 });
  assert.equal(at(queue).rounds ?? 0, 0, "none of them counted");
  const other = conflictFields(at(queue), on("b9", URL_B));
  assert.deepEqual(other.conflictRounds, { [URL_A]: 3, [URL_B]: 1 }, "another pull request has its own count");
});

test("A11-374: from the 4th conflict on one pull request, the round's feedback names the pull requests it keeps colliding with", () => {
  const colliding = run("A11-2", { phase: "finished", finishedAt: 20, outcome: { kind: "reviewed", prs: [{ repo: "agent-org", url: URL_B }] }, pullStates: { [URL_B]: "open" }, pullFiles: { [URL_B]: ["src/a.ts", "src/b.ts"] } });
  const unrelated = run("A11-3", { phase: "finished", outcome: { kind: "reviewed", prs: [{ repo: "agent-org", url: "https://github.com/a11ign/agent-org/pull/23" }] }, pullStates: { "https://github.com/a11ign/agent-org/pull/23": "open" }, pullFiles: { "https://github.com/a11ign/agent-org/pull/23": ["README.md"] } });
  const third = parked({ conflictRounds: { [URL_A]: 2 }, pullFiles: { [URL_A]: ["src/a.ts", "src/c.ts"] } });
  const queue = queueOf(third, colliding, unrelated);
  assert.equal(conflictRoundFeedback(queue, third, on("b1"), "Conflict.").includes("keeps colliding"), false, "the 3rd conflict is not yet one that recurs");
  const fourth = { ...third, conflictRounds: { [URL_A]: 3 } } as Entry;
  const text = conflictRoundFeedback({ ...queue, entries: [fourth, colliding, unrelated] } as Queue, fourth, { [URL_A]: { base: "b4", files: ["src/a.ts"] } }, "Conflict.");
  assert.match(text, /^Conflict 4 on #21:\nConflict\.\n\nThis pull request keeps colliding with A11-2 #22 \(src\/a\.ts\): it has conflicted 4 times\. Stack on the one most recently updated, A11-2 #22, or merge its branch in/);
  assert.equal(text.includes("A11-3"), false, "a pull request that shares no conflicting file is not named");
  const sent = conflictRound({ ...queue, entries: [fourth, colliding, unrelated] } as Queue, "A11-1", "Conflict.", 30, { [URL_A]: { base: "b4", files: ["src/a.ts"] } });
  assert.match(at(sent).feedback ?? "", /keeps colliding with A11-2 #22/, "the round still runs, with it as its feedback");
});

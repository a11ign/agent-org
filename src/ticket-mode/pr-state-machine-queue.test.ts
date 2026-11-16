// A11-437, step 2 of 3: random event sequences fed to the merge queue's transition -- the merge group's jobs are rerun within the bound at one head, the arm bot is asked within its bound, at most one round starts at a head, every pull request the queue removed shows why it waits, and merged, closed and needs-a-person are reachable
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CiRun, QueueRemoval } from "../plugins/contracts/code-host.ts";
import type { QueueHead } from "./board-view/queue-head.ts";
import { HOLD_AFTER, MAX_REARMS, QUEUE_RERUNS_PER_HEAD, queueStep, type QueueEvent, type QueuePull, type QueueStep, type ReadCheck } from "./pr-state-machine.ts";

const MINUTE = 60_000;
const URL = "https://github.com/a11ign/agent-org/pull/7";
const RUN = 40192667644;
const JOB = `https://github.com/a11ign/agent-org/actions/runs/${RUN}/job/121166812239`;
const SEQUENCES = 400;
const EVENTS_PER_SEQUENCE = 40;

/** A seeded generator (mulberry32), as `pr-state-machine.test.ts` uses: a failing sequence is found again from its seed. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** What can happen to a pull request between two watches of the board: the queue ejects it (for the code, for the infrastructure, for a conflict, or a person dequeues it), it is armed, the merge group's rerun ends, a push, an approval, a conflict with the base, a refusal by the code host, time passing, the round handed back, merged or closed. */
const EVENTS = ["ejected", "ejected-infra", "conflict", "dequeued", "armed", "rerun-done", "push", "approval", "conflicting", "refuse", "later", "handed-back", "merged", "closed"] as const;
type Event = (typeof EVENTS)[number];

/** Why the merge group behind a removal failed. */
type Cause = "code" | "infrastructure";

/** The pull request as the code host shows it, what the board holds of it, and what the machine did. */
type World = {
  head: string; pushes: number; state: "open" | "merged" | "closed"; queued: boolean; removals: QueueRemoval[]; causes: Map<string, Cause>; approved: boolean; conflicting: boolean; label: boolean;
  groupRun: "none" | "running" | "success" | "failure"; refuseNext: boolean; roundOver: boolean; canRearm: boolean; canReadRuns: boolean; now: number;
  record: QueueHead | undefined; reruns: Map<string, number>; asks: Map<string, number>; rounds: Map<string, number>; ends: Set<"merged" | "closed" | "needs-a-person">;
};

const headOf = (pushes: number): string => `q${pushes}`.padEnd(40, "0");

/** A failed_checks removal, with the merge group it was in. */
const failedRemoval = (n: number, at: number): QueueRemoval => ({ at, reason: "failed_checks", actor: "github-merge-queue", groupCommit: `g${n}`.padEnd(40, "0") });

function start(random: () => number, record?: QueueHead): World {
  const removals = Array.from({ length: record?.removals ?? 0 }, (_, n) => failedRemoval(n, n));
  return {
    head: record?.head ?? headOf(0), pushes: 0, state: "open", queued: record === undefined, removals, causes: new Map(removals.map(({ groupCommit }) => [groupCommit!, "code" as const])), approved: true, conflicting: false,
    label: record?.held === true, groupRun: record?.step === "retrying" ? "running" : "none", refuseNext: false, roundOver: true, canRearm: random() < 0.85, canReadRuns: random() < 0.85, now: Date.parse("2026-11-15T00:00:00Z"),
    record, reruns: new Map(), asks: new Map(), rounds: new Map(), ends: new Set(),
  };
}

/** The queue removes the pull request, when it is in it. */
function remove(world: World, reason: string, actor: string, cause?: Cause): void {
  if (!world.queued) return;
  const removal = cause === undefined ? { at: world.now, reason, actor, groupCommit: null } : failedRemoval(world.removals.length, world.now);
  if (cause !== undefined) world.causes.set(removal.groupCommit!, cause);
  Object.assign(world, { queued: false, removals: [...world.removals, removal] });
}

/** The arm bot, or a person, arms the pull request: it goes in the queue only when it is approved, held by nobody and clean. */
function arm(world: World): void {
  if (world.approved && !world.label && !world.conflicting) world.queued = true;
}

/** One event, as the code host, the queue and the people around the pull request make it happen. */
function happen(world: World, event: Event, random: () => number): void {
  if (world.state !== "open") return;
  if (event === "ejected" || event === "ejected-infra") remove(world, "failed_checks", "github-merge-queue", event === "ejected" ? "code" : "infrastructure");
  else if (event === "conflict") remove(world, "merge_conflict", "github-merge-queue");
  else if (event === "dequeued") remove(world, "dequeued", "a-person");
  else if (event === "armed") arm(world);
  else if (event === "rerun-done" && world.groupRun === "running") world.groupRun = random() < 0.5 ? "success" : "failure";
  else if (event === "push") Object.assign(world, { pushes: world.pushes + 1, head: headOf(world.pushes + 1), queued: false, removals: [], approved: false, conflicting: false, groupRun: "none" });
  else if (event === "approval") world.approved = true;
  else if (event === "conflicting") world.conflicting = !world.conflicting;
  else if (event === "refuse") world.refuseNext = true;
  else if (event === "later") world.now += 20 * MINUTE;
  else if (event === "handed-back") world.roundOver = !world.roundOver;
  else if (event === "merged" && world.queued) world.state = "merged";
  else if (event === "closed") world.state = "closed";
}

/** Whether the code host refuses the next call, once. */
function refuses(world: World): boolean {
  const refused = world.refuseNext;
  world.refuseNext = false;
  return refused;
}

const count = (counts: Map<string, number>, head: string): void => void counts.set(head, (counts.get(head) ?? 0) + 1);

/** The log of the merge group's failed job, as the board reads it. */
const jobCheck = (cause: Cause | undefined): ReadCheck =>
  ({ name: "suite", lines: ["FAIL  src/a.test.ts > a test"], refusals: [], infrastructure: cause === "infrastructure" ? "a runner was lost" : null, readable: true, detailsUrl: JOB });

/** The merge group's runs a rerun waits on, as the code host shows them. */
const runsOf = (world: World, ids: readonly number[]): CiRun[] =>
  ids.map(() => ({ status: world.groupRun === "running" ? "in_progress" : "completed", conclusion: world.groupRun === "success" ? "success" : "failure", url: JOB, name: "suite", jobs: null }));

/** Makes what a step names, as `pool-merge-queue.ts` does, against the world, and returns the code host's answer. */
function perform(world: World, step: Exclude<QueueStep, { do: "answer" }>): QueueEvent {
  switch (step.do) {
    case "release": {
      if (refuses(world)) return { on: "released", record: step.record, why: "HTTP 502" };
      world.label = false;
      return { on: "released", record: step.record, why: null };
    }
    case "read-runs": return { on: "runs", known: step.known, runs: runsOf(world, step.known.retry.runs), now: world.now };
    case "read-failure": {
      const cause = world.causes.get(step.removal.groupCommit ?? "");
      const job = { name: "suite", step: "Run tests", detailsUrl: JOB };
      return { on: "failure", seen: { removal: step.removal, count: step.count, prior: step.prior, failure: { runId: RUN, runUrl: JOB, jobs: [job] }, jobs: [{ job, check: jobCheck(cause) }] } };
    }
    case "read-jobs": return { on: "jobs", known: step.known, count: step.count, names: ["suite"] };
    case "rerun-jobs": {
      if (refuses(world)) return { on: "rerun-jobs", seen: step.seen, runs: step.runs, refused: "HTTP 403", now: world.now };
      count(world.reruns, world.head);
      world.groupRun = "running";
      return { on: "rerun-jobs", seen: step.seen, runs: step.runs, refused: null, now: world.now };
    }
    case "record-flakes": return { on: "flakes-written", then: step.then };
    case "ask-arm-bot": {
      if (refuses(world)) return { on: "armed", record: step.record, because: step.because, refused: "HTTP 500" };
      count(world.asks, world.head);
      arm(world);
      return { on: "armed", record: step.record, because: step.because, refused: null };
    }
    case "hold": {
      if (refuses(world)) return { on: "held", record: step.record, count: step.count, then: step.then, why: "HTTP 502" };
      world.label = true;
      return { on: "held", record: step.record, count: step.count, then: step.then, why: null };
    }
  }
}

/** One watch of the pull request, as `answerQueue` makes it: the machine's steps made one after the other until it answers. A pull request no longer open has no record. */
function watch(world: World): void {
  if (world.state !== "open") {
    world.ends.add(world.state);
    world.record = undefined;
    return;
  }
  const pull: QueuePull = {
    url: URL, read: { head: world.head, queue: { queued: world.queued, removals: world.removals }, approvedAtHead: world.approved, conflicting: world.conflicting }, canRearm: world.canRearm, canReadRuns: world.canReadRuns, roundOver: world.roundOver,
  };
  let step = queueStep(pull, { on: "watch", known: world.record });
  for (let made = 0; step.do !== "answer"; made += 1) {
    assert.ok(made < 10, `the machine made ${made} steps in one watch and did not answer`);
    step = queueStep(pull, perform(world, step));
  }
  if (step.round !== undefined) count(world.rounds, world.head);
  world.record = step.record;
  if (step.record?.step === "named" || step.record?.step === "held") world.ends.add("needs-a-person");
}

/** Whether the pull request waits on the queue at its head: open, out of the queue, and removed from it since its head last moved. */
const waits = (world: World): boolean => world.state === "open" && !world.queued && world.removals.length > 0;

/** Why it waits, as the card shows it: the record's note at the head, or a round, which is the reason itself. */
function shownReason({ record, head }: World): string | null {
  if (record?.head !== head) return null;
  return record.step === "round" ? record.note ?? "a worker's round answers the removal" : record.note ?? null;
}

/** Runs one random sequence from `record`, checking the bounds and the reasons after every watch, and returns the ends it came to. */
function runSequence(seed: number, record?: QueueHead): Set<string> {
  const random = generator(seed);
  const world = start(random, record);
  for (let index = 0; index < EVENTS_PER_SEQUENCE; index += 1) {
    const event = EVENTS[Math.floor(random() * EVENTS.length)];
    happen(world, event, random);
    watch(world);
    const where = `seed ${seed}, event ${index} (${event})`;
    assert.ok((world.reruns.get(world.head) ?? 0) <= QUEUE_RERUNS_PER_HEAD, `${where}: the merge group's jobs were rerun more than ${QUEUE_RERUNS_PER_HEAD} time at one head`);
    assert.ok((world.asks.get(world.head) ?? 0) <= MAX_REARMS, `${where}: the arm bot was asked more than ${MAX_REARMS} times at one head`);
    assert.ok((world.rounds.get(world.head) ?? 0) <= 1, `${where}: more than one round was started at one head`);
    if (waits(world)) assert.ok((shownReason(world) ?? "") !== "", `${where}: the pull request is out of the queue at ${world.head.slice(0, 8)} with no reason shown (record ${JSON.stringify(world.record)})`);
  }
  return world.ends;
}

test("A11-437: in any random sequence of ejections, pushes, approvals, reruns and refusals, the merge group is rerun and the arm bot asked within their bounds at one head, one round at most starts, and every removal shows why it waits", () => {
  for (let seed = 1; seed <= SEQUENCES; seed += 1) runSequence(seed);
});

/** The start states of a pull request's removals the property enumerates: no record, and one of each step the machine records. */
const HEAD = headOf(0);
const START_STATES: Readonly<Record<string, QueueHead | undefined>> = {
  "no record": undefined,
  "a round": { head: HEAD, step: "round", removals: 1, jobs: ["suite"], roundStarted: true },
  "named for another reason": { head: HEAD, step: "named", removals: 0, note: "removed from the merge queue by a-person: dequeued" },
  "re-armed": { head: HEAD, step: "rearmed", removals: 1, jobs: ["suite"], rearms: 1, note: "removed from the merge queue: suite failed for an infrastructure reason; the arm bot was asked to arm it again (1 of 2)" },
  "retrying": { head: HEAD, step: "retrying", removals: 1, jobs: ["suite"], retried: true, retry: { at: Date.parse("2026-11-15T00:00:00Z"), runs: [RUN], candidates: [{ test: "a", check: "suite", run: JOB }] }, note: "ejected from the merge queue: suite, retrying" },
  "held": { head: HEAD, step: "held", removals: HOLD_AFTER, jobs: ["suite"], held: true, note: `removed from the merge queue ${HOLD_AFTER} times: suite` },
};

test("A11-437: from every start state of the merge queue, merged, closed and needs-a-person are each reachable", () => {
  for (const [name, record] of Object.entries(START_STATES)) {
    const reached = new Set<string>(record?.step === "held" || record?.step === "named" ? ["needs-a-person"] : []);
    for (let seed = 1; seed <= SEQUENCES && reached.size < 3; seed += 1) for (const end of runSequence(seed, record)) reached.add(end);
    assert.deepEqual([...reached].sort(), ["closed", "merged", "needs-a-person"], `from ${name}`);
  }
});

test("A11-437: the merge queue's transition reads no clock", () => {
  const realNow = Date.now;
  Date.now = () => { throw new Error("the transition read the clock"); };
  try {
    for (let seed = 1; seed <= 20; seed += 1) runSequence(seed);
  } finally {
    Date.now = realNow;
  }
});

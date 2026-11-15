// A11-437: random event sequences fed to the pull request's check transitions -- reruns of one check on one head stay within the bound, every state that waits gives a reason, and merged, closed and needs-a-person are reachable
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cancelledStep, checkStep, MAX_CANCELLED_RERUNS, RED_RERUNS_PER_HEAD, takenRerun, type CancelledTries, type CheckStep, type ReadCheck } from "./pr-state-machine.ts";
import type { CheckHead } from "./board-view/view-types-and-filters.ts";

const MINUTE = 60_000;
const CHECK = "suite";
const JOB = "https://github.com/a11ign/agent-org/actions/runs/1/job/2";
const SEQUENCES = 400;
const EVENTS_PER_SEQUENCE = 40;

/** A seeded generator (mulberry32): a failing sequence is found again from its seed. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** What can happen to a pull request between two watches of the board. */
const EVENTS = ["red", "red-infra", "cancelled", "rerun-done", "push", "approval", "ejected", "reply", "refuse", "later", "busy", "merged", "closed"] as const;
type Event = (typeof EVENTS)[number];

/** The required check at the head as the code host shows it. */
type Check = "green" | "running" | "code" | "infrastructure" | "cancelled";

/** The pull request as the code host shows it, what the board holds of it, and what the machine did. */
type World = {
  head: string; pushes: number; state: "open" | "merged" | "closed"; check: Check; failedAt: number | null; approved: boolean; reply: boolean; refuseNext: boolean; busy: boolean; now: number;
  record: CheckHead | undefined; repliesRead: Set<string>; tries: Map<string, CancelledTries>; reruns: Map<string, number>; cancelledReruns: Map<string, number>;
  lastWait: string | null; ends: Set<"merged" | "closed" | "needs-a-person">;
};

const headOf = (pushes: number): string => `h${pushes}`.padEnd(40, "0");

function start(record?: CheckHead): World {
  return {
    head: record?.head ?? headOf(0), pushes: 0, state: "open", check: "green", failedAt: null, approved: false, reply: false, refuseNext: false, busy: false, now: Date.parse("2026-11-14T00:00:00Z"),
    record, repliesRead: new Set(), tries: new Map(), reruns: new Map(), cancelledReruns: new Map(), lastWait: null, ends: new Set(),
  };
}

const red = (world: World, kind: "code" | "infrastructure"): void => { world.check = kind; world.failedAt = world.now; };

/** What the code host does when the rerun it took finishes: green, red again for either reason, or cancelled again. */
function rerunDone(world: World, random: () => number): void {
  if (world.check !== "running") return;
  const outcome: Check = (["green", "code", "infrastructure", "cancelled"] as const)[Math.floor(random() * 4)];
  if (outcome === "code" || outcome === "infrastructure") red(world, outcome);
  else world.check = outcome;
}

/** One event, as the code host and the people around the pull request make it happen. */
function happen(world: World, event: Event, random: () => number): void {
  if (world.state !== "open") return;
  if (event === "red" || event === "ejected") red(world, "code");
  else if (event === "red-infra") red(world, "infrastructure");
  else if (event === "cancelled") world.check = "cancelled";
  else if (event === "rerun-done") rerunDone(world, random);
  else if (event === "push") Object.assign(world, { pushes: world.pushes + 1, head: headOf(world.pushes + 1), check: "running", failedAt: null, approved: false, reply: false });
  else if (event === "approval") world.approved = true;
  else if (event === "reply") world.reply = true;
  else if (event === "refuse") world.refuseNext = true;
  else if (event === "later") world.now += 20 * MINUTE;
  else if (event === "busy") world.busy = !world.busy;
  else world.state = event;
}

/** The red check's log as the board reads it: the infrastructure's when `infrastructure` says why, else the code's. */
const checkRead = (infrastructure?: string): ReadCheck =>
  ({ name: CHECK, lines: ["FAIL  src/a.test.ts > a test"], refusals: [], infrastructure: infrastructure ?? null, readable: true, detailsUrl: JOB });

/** The red check as the board reads it in `world`. */
const readCheck = (world: World): ReadCheck => checkRead(world.check === "infrastructure" ? "a runner was lost or a rate limit was hit" : undefined);

const isRed = (world: World): boolean => world.check === "code" || world.check === "infrastructure";

/** Counts one rerun of the check at the head, as the code host takes it. */
function countRerun(counts: Map<string, number>, head: string): void {
  counts.set(head, (counts.get(head) ?? 0) + 1);
}

/** Makes the rerun a step names, or feeds the host's refusal back, as `pool-checks.ts` does. */
function perform(world: World, step: CheckStep): CheckStep {
  if (step.do !== "rerun") return step;
  if (world.refuseNext) {
    world.refuseNext = false;
    return checkStep(world.record, { on: "refused", head: world.head, rerun: step, why: "HTTP 403" });
  }
  countRerun(world.reruns, world.head);
  world.check = "running";
  return takenRerun(step, world.now);
}

/** The step a watch comes to once the logs or the replies it asks for are read, as `pool-checks.ts` reads them. */
function readFor(world: World, step: CheckStep): CheckStep {
  if (step.do === "read-logs") {
    const check = readCheck(world);
    const reds = check.infrastructure === null ? { own: [check], infrastructure: [], outside: 0 } : { own: [], infrastructure: [check], outside: 0 };
    return checkStep(world.record, { on: "logs", head: world.head, reds, now: world.now });
  }
  return step.do === "read-replies" ? readReplies(world) : step;
}

/** A round's replies, read once for a head: a rerun when the worker's reply says the failure is not its change's. */
function readReplies(world: World): CheckStep {
  if (world.repliesRead.has(world.head)) return { do: "nothing" };
  world.repliesRead.add(world.head);
  return world.reply ? checkStep(world.record, { on: "unrelated-reply", head: world.head, checks: [readCheck(world)], now: world.now }) : { do: "nothing" };
}

/** The record a step leaves for the head, or null when it leaves the one there. */
const recordOf = (step: CheckStep): CheckHead | null => ("record" in step ? step.record : null);

/** One watch of the pull request's red checks, as `answerChecks` makes it: the record it keeps or makes, and the end it comes to. */
function watchChecks(world: World): void {
  const read = {
    state: world.state, head: world.head, failing: isRed(world) ? [CHECK] : [], failures: isRed(world) ? [{ name: CHECK, detailsUrl: JOB }] : [], failedAt: world.failedAt,
    pendingRequired: world.check === "running" ? [CHECK] : [],
  };
  const first = checkStep(world.record, { on: "watch", read, now: world.now });
  if (first.do === "end") {
    world.ends.add(first.as);
    world.record = undefined;
    return;
  }
  const step = perform(world, readFor(world, first));
  if (step.do === "wait") world.lastWait = step.reason;
  if (step.do === "name") world.ends.add("needs-a-person");
  const answer = recordOf(step);
  world.record = answer ?? (world.record?.head === world.head ? world.record : undefined);
}

/** One watch of the cancelled runs that block the head, as `rerunCancelledGate` makes it. */
function watchCancelled(world: World): void {
  if (world.state !== "open" || !world.approved || world.check !== "cancelled") return;
  const tries = world.tries.get(world.head) ?? { taken: 0, refused: 0, stopped: false };
  const first = cancelledStep(tries, "unread");
  const step = first.do === "ask-busy" ? cancelledStep(tries, world.busy) : first;
  if (step.do === "leave" || step.do === "wait") world.lastWait = step.reason;
  if (step.do === "stop") {
    world.tries.set(world.head, { ...tries, stopped: true });
    world.ends.add("needs-a-person");
  }
  if (step.do !== "rerun") return;
  if (world.refuseNext) {
    // The refusal is logged with its reason, which the run's timeline shows (`cancelledRerunWords`), and asked again next watch.
    world.refuseNext = false;
    world.lastWait = "could not rerun it (HTTP 403)";
    world.tries.set(world.head, { ...tries, refused: tries.refused + 1 });
    return;
  }
  world.tries.set(world.head, { ...tries, taken: tries.taken + 1 });
  countRerun(world.cancelledReruns, world.head);
  world.check = "running";
}

/** Whether a record says why its head waits: a round is the reason itself, and any other record has its card note. */
const recordSaysWhy = (record: CheckHead): boolean => record.step === "round" || (record.note ?? "") !== "";

/** Why the pull request waits after a watch, or null when it waits silently: its record at the head says why (a round is the reason itself), or the watch's step gave one. */
function shownReason(world: World): string | null {
  const { record } = world;
  if (record?.head === world.head && recordSaysWhy(record)) return record.note ?? "a worker's round answers the red checks";
  if (world.tries.get(world.head)?.stopped === true) return "the board has stopped rerunning the cancelled runs";
  return world.lastWait;
}

/** Whether the pull request waits on something at its head: a red check, or a cancelled one that blocks it once approved. */
const waits = (world: World): boolean => world.state === "open" && (isRed(world) || (world.check === "cancelled" && world.approved));

/** Runs one random sequence from `record`, checking the bounds and the reasons after every watch, and returns the ends it came to. */
function runSequence(seed: number, record?: CheckHead): Set<string> {
  const random = generator(seed);
  const world = start(record);
  for (let index = 0; index < EVENTS_PER_SEQUENCE; index += 1) {
    const event = EVENTS[Math.floor(random() * EVENTS.length)];
    happen(world, event, random);
    world.lastWait = null;
    watchChecks(world);
    watchCancelled(world);
    const where = `seed ${seed}, event ${index} (${event})`;
    assert.ok((world.reruns.get(world.head) ?? 0) <= RED_RERUNS_PER_HEAD, `${where}: the red check was rerun more than ${RED_RERUNS_PER_HEAD} times at one head`);
    assert.ok((world.cancelledReruns.get(world.head) ?? 0) <= MAX_CANCELLED_RERUNS, `${where}: the cancelled runs were rerun more than ${MAX_CANCELLED_RERUNS} times at one head`);
    if (waits(world)) assert.ok((shownReason(world) ?? "") !== "", `${where}: the pull request waits at ${world.head.slice(0, 8)} with no reason shown (record ${JSON.stringify(world.record)})`);
  }
  return world.ends;
}

test("A11-437: in any random sequence of red, cancelled, rerun, ejected, push and approval events, a check is rerun within the bound at one head, and every wait shows a reason", () => {
  for (let seed = 1; seed <= SEQUENCES; seed += 1) runSequence(seed);
});

/** The start states of a pull request's checks the property enumerates: no record, and one of each step the machine records. */
const HEAD = headOf(0);
const START_STATES: Readonly<Record<string, CheckHead | undefined>> = {
  "no record": undefined,
  "a round": { head: HEAD, step: "round" },
  "a rerun of the code's checks": { head: HEAD, step: "rerun", note: "Reran suite", rerun: { for: "code", at: Date.parse("2026-11-14T00:00:00Z"), candidates: [{ test: "a", check: CHECK, run: JOB }] } },
  "a rerun a reply asked for": { head: HEAD, step: "rerun", note: "Reran suite", rerun: { for: "reply", at: Date.parse("2026-11-14T00:00:00Z"), candidates: [{ test: "a", check: CHECK, run: JOB }] } },
  "an infrastructure rerun": { head: HEAD, step: "rerun", note: "Reran suite: a runner was lost" },
  "named for a person": { head: HEAD, step: "named", note: "a person decides" },
};

test("A11-437: from every start state, merged, closed and needs-a-person are each reachable", () => {
  for (const [name, record] of Object.entries(START_STATES)) {
    const reached = new Set<string>(record?.step === "named" ? ["needs-a-person"] : []);
    for (let seed = 1; seed <= SEQUENCES && reached.size < 3; seed += 1) for (const end of runSequence(seed, record)) reached.add(end);
    assert.deepEqual([...reached].sort(), ["closed", "merged", "needs-a-person"], `from ${name}`);
  }
});

test("A11-437: the transition functions read no file, network or clock: the module imports only types, words and pure helpers", () => {
  const source = readFileSync(new URL("./pr-state-machine.ts", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gmu)].map(([, from]) => from);
  assert.deepEqual(imports, ["../plugins/contracts/code-host.ts", "./board-view/view-types-and-filters.ts", "./board-view/check-rerun-record.ts", "./board-view/cancelled-rerun-words.ts", "./failure-words.ts"]);
  assert.doesNotMatch(source, /Date\.now|new Date\(|performance\.now|process\.|fetch\(|node:/u, "no clock, environment, network or node module");
  const realNow = Date.now;
  Date.now = () => { throw new Error("the transition read the clock"); };
  try {
    const step = checkStep(undefined, { on: "watch", read: { head: HEAD, failing: [CHECK], failures: [{ name: CHECK, detailsUrl: JOB }], failedAt: 1, pendingRequired: [] }, now: 2 });
    assert.equal(step.do, "read-logs");
    assert.equal(cancelledStep({ taken: 0, refused: 0, stopped: false }, false).do, "rerun");
  } finally {
    Date.now = realNow;
  }
});

test("A11-437: the bounds: a check red at a head is rerun before a round, a person is named after the rerun a reply asked for, and the cancelled runs are rerun twice and then stopped", () => {
  const read = { head: HEAD, failing: [CHECK], failures: [{ name: CHECK, detailsUrl: JOB }], failedAt: 1, pendingRequired: [] };
  const own = checkRead();
  assert.equal(checkStep(undefined, { on: "watch", read, now: 2 }).do, "read-logs");
  const first = checkStep(undefined, { on: "logs", head: HEAD, reds: { own: [own], infrastructure: [], outside: 0 }, now: 2 });
  assert.deepEqual([first.do, first.do === "rerun" ? first.for : null], ["rerun", "code"]);
  const again = checkStep(first.do === "rerun" ? first.record : undefined, { on: "logs", head: HEAD, reds: { own: [own], infrastructure: [], outside: 0 }, now: 20 * MINUTE });
  assert.equal(again.do, "round");
  const reply = checkStep({ head: HEAD, step: "round" }, { on: "unrelated-reply", head: HEAD, checks: [own], now: 30 * MINUTE });
  const named = checkStep(reply.do === "rerun" ? reply.record : undefined, { on: "logs", head: HEAD, reds: { own: [own], infrastructure: [], outside: 0 }, now: 60 * MINUTE });
  assert.deepEqual([reply.do, named.do], ["rerun", "name"]);
  const steps = [0, 1, 2].map((taken) => cancelledStep({ taken, refused: 0, stopped: false }, false).do);
  assert.deepEqual(steps, ["rerun", "rerun", "stop"]);
  assert.equal(cancelledStep({ taken: 0, refused: 0, stopped: false }, true).do, "wait");
});


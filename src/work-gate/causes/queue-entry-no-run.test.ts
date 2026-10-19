// no-token: none -- every read and write goes through an injected runner and a temporary state directory; nothing here reaches GitHub, git, herdr or the fleet
/**
 * agent-org#1195: A MERGE-QUEUE ENTRY WITH NO RUN IS NAMED AND RE-QUEUED ONCE BY THE GATE, AND COUNTED.
 *
 * ONE HARNESS: `Queue` is a fake `gh` that answers the entries read, the runs-by-sha read and the dequeue from a table, records every call, and a fake arming port that records the re-arm and the
 * comment. Each negative differs from its positive by one fact, and the two controls the row names are here by name:
 *   (1) a read that failed is "unread", never "no run": a runner that THROWS on the runs read names nothing and re-queues nothing (fails on an implementation that reads a throw as an empty list);
 *   (2) once, not twice: the second occurrence on the same pull request makes no dequeue and no re-arm, and raises the incident.
 * Flag OFF reads and writes nothing; the two org-health classes are declared; and a state that cannot be read takes no action.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "../../lib/tmp-fixture.ts";
import { workGateSource } from "../../lib/work-gate-source.ts";
import { emptyCanaryState } from "../../org-health/fleet-build-incident.ts";
import { withMachineryFlag } from "../../org-health.ts";
import type { QueueEntry } from "../../ticket-port/queue-entry-reads.ts";
import type { ArmingPort } from "../vocabulary.ts";
import { ORG_HEALTH_CLASSES } from "../org-health-suppression.ts";
import {
  QUEUE_ENTRY_NO_RUN_CONFIRM_MS, QUEUE_ENTRY_NO_RUN_FILE, QUEUE_ENTRY_NO_RUN_FLAG, QUEUE_ENTRY_NO_RUN_MINUTES, entriesWithoutRun, minutesStood, queueEntryNoRunOrders,
} from "./queue-entry-no-run.ts";

const SCOPE = "a11ign/agent-org";
const T0 = Date.parse("2026-10-12T14:00:00Z");
const MIN = 60_000;
const ON = withMachineryFlag(emptyCanaryState(), { name: QUEUE_ENTRY_NO_RUN_FLAG, on: true });
const SHA = (n: number) => `${String(n).padStart(4, "0")}${"a".repeat(36)}`;

/** An entry enqueued `age` minutes before T0 (so the tick at T0 reads it as that old). */
const entry = (pull: number, { age = 12, state = "AWAITING_CHECKS", position = 1, sha = SHA(pull) }: { age?: number; state?: string; position?: number; sha?: string | null } = {}): QueueEntry =>
  ({ state, enqueuedAt: new Date(T0 - age * MIN).toISOString(), position, headSha: sha, pull, pullId: `PR_node_${pull}` });

type Calls = { entries: number; runs: string[]; dequeued: string[]; armed: string[]; comments: { id: number; text: string }[] };

/** The fake `gh`: `runs` maps sha to a count, or to `"throw"`; `dequeue` is `"ok"` or `"error"`; `entries` is a function so a later tick may read another queue. */
function queue({ entries, runs = {}, dequeue = "ok", queueRead = "ok", onDequeue = () => {} }: { entries: () => QueueEntry[]; runs?: Record<string, number | "throw">; dequeue?: "ok" | "error" | "errors-in-body"; queueRead?: "ok" | "throw"; onDequeue?: () => void }) {
  const calls: Calls = { entries: 0, runs: [], dequeued: [], armed: [], comments: [] };
  const run = (args: string[]): string => {
    const text = args.join(" ");
    if (text.includes("mutation")) {
      calls.dequeued.push(String(args.find((arg) => arg.startsWith("id="))).slice(3));
      onDequeue();
      if (dequeue === "error") throw new Error("GraphQL: Could not resolve to a PullRequest");
      return dequeue === "errors-in-body" ? JSON.stringify({ errors: [{ message: "not in the queue" }] }) : JSON.stringify({ data: { dequeuePullRequest: { mergeQueueEntry: null } } });
    }
    if (text.includes("mergeQueue")) {
      calls.entries += 1;
      if (queueRead === "throw") throw new Error("HTTP 502");
      return JSON.stringify({ data: { repository: { mergeQueue: { entries: { nodes: entries().map((e) => ({ state: e.state, enqueuedAt: e.enqueuedAt, position: e.position,
        headCommit: e.headSha === null ? null : { oid: e.headSha }, pullRequest: e.pull === null ? null : { number: e.pull, id: e.pullId } })) } } } } });
    }
    const sha = /head_sha=([0-9a-f]+)/.exec(text)?.[1];
    if (sha !== undefined) {
      calls.runs.push(sha);
      const count = runs[sha] ?? 1;
      if (count === "throw") throw new Error("HTTP 403: rate limit");
      return `${count}\n`;
    }
    throw new Error(`unexpected gh call: ${text}`);
  };
  const port: ArmingPort = {
    armMerge: (ref) => { calls.armed.push(ref.id); return true; },
    postDecision: (ref, decision) => { calls.comments.push({ id: Number(ref.id), text: decision.text }); return undefined as never; },
  };
  return { run, port, calls };
}

/** One tick of the gate's call, with a state directory that persists between ticks of one test. */
function gate(dir: string, harness: ReturnType<typeof queue>, { now, state = ON }: { now: number; state?: typeof ON }) {
  const said: string[] = [];
  const orders = queueEntryNoRunOrders({ scope: SCOPE, run: harness.run, state, stateDir: dir, now, log: (line) => said.push(line), portFor: () => harness.port });
  return { orders, said };
}

const classesOf = (orders: { subject: string }[]) => orders.map((order) => order.subject);
const memoryOf = (dir: string) => JSON.parse(readFileSync(join(dir, QUEUE_ENTRY_NO_RUN_FILE), "utf8"));

// ---- the detector, pure ----

test("(1) an entry is named only when AWAITING_CHECKS for MORE than ten minutes with a run count of zero; each negative differs by one fact", () => {
  const run0 = new Map<string, number | null>([[SHA(1), 0]]);
  const named = (e: QueueEntry, runs = run0) => entriesWithoutRun({ entries: [e], runs, now: T0 }).stalled.length;
  assert.equal(QUEUE_ENTRY_NO_RUN_MINUTES, 10);
  assert.equal(named(entry(1, { age: 11 })), 1, "POSITIVE CONTROL: eleven minutes, AWAITING_CHECKS, no run");
  assert.equal(named(entry(1, { age: 10 })), 0, "exactly ten minutes is not MORE than ten");
  assert.equal(named(entry(1, { state: "QUEUED" })), 0, "a QUEUED entry has no group to have a run");
  assert.equal(named(entry(1, { state: "MERGEABLE" })), 0, "a MERGEABLE entry has passed its checks");
  assert.equal(named(entry(1), new Map([[SHA(1), 2]])), 0, "a run exists");
  assert.equal(named(entry(1, { sha: null })), 0, "an entry whose group has no head commit has nothing to ask the runs of");
  assert.equal(minutesStood({ ...entry(1), enqueuedAt: "not a time" }, T0), null, "a time that does not parse names nothing");
});

test("(1) NEGATIVE CONTROL: a run count that could not be read is UNREAD, never 'no run' -- the pure detector", () => {
  const { stalled, unread } = entriesWithoutRun({ entries: [entry(1)], runs: new Map([[SHA(1), null]]), now: T0 });
  assert.deepEqual(stalled, [], "an unread count names nothing");
  assert.equal(unread.length, 1, "and is reported as unread, so it is not lost");
  assert.deepEqual(entriesWithoutRun({ entries: [entry(1)], runs: new Map(), now: T0 }).stalled, [], "a sha the runs were never asked about is unread too");
});

// ---- the gate's tick ----

test("(1) NEGATIVE CONTROL: a runner that THROWS on the runs read names nothing and re-queues nothing, and writes no memory of a re-queue", () => {
  const dir = tmpDir("queue-no-run-");
  const harness = queue({ entries: () => [entry(5227)], runs: { [SHA(5227)]: "throw" } });
  gate(dir, harness, { now: T0 });
  const second = gate(dir, harness, { now: T0 + 2 * MIN });
  assert.deepEqual(harness.calls.dequeued, [], "no dequeue on a refused read");
  assert.deepEqual(harness.calls.armed, [], "no re-arm");
  assert.ok(!classesOf(second.orders).includes("queue-entry-no-run"), "no order names it");
  assert.deepEqual(memoryOf(dir).requeued, {}, "nothing is recorded as re-queued");
  assert.ok(harness.calls.runs.length >= 1, "POSITIVE CONTROL: the runs WERE asked for, so the throw is what stopped it");
});

test("(2) the flag OFF reads and writes nothing: no call to gh, no file", () => {
  const dir = tmpDir("queue-no-run-");
  const harness = queue({ entries: () => [entry(5227)], runs: { [SHA(5227)]: 0 } });
  const off = gate(dir, harness, { now: T0, state: emptyCanaryState() });
  assert.deepEqual(off.orders, []);
  assert.equal(harness.calls.entries, 0, "the queue was not read");
  assert.equal(existsSync(join(dir, QUEUE_ENTRY_NO_RUN_FILE)), false, "nothing was written");
  gate(dir, harness, { now: T0 });
  assert.equal(harness.calls.entries, 1, "POSITIVE CONTROL: the same harness with the flag ON reads the queue");
});

test("(2) an entry with no run is dequeued and armed again ONCE, on the tick after it was first seen, with a record on the pull request and one in the day's count", () => {
  const dir = tmpDir("queue-no-run-");
  let keptBeforeTheAct: string | undefined;
  const harness = queue({ entries: () => [entry(5227)], runs: { [SHA(5227)]: 0 }, onDequeue: () => { keptBeforeTheAct = memoryOf(dir).requeued["5227"]?.outcome; } });
  const first = gate(dir, harness, { now: T0 });
  assert.deepEqual(harness.calls.dequeued, [], "first seen: confirmed on the next tick, not acted on");
  assert.equal(memoryOf(dir).suspect[SHA(5227)], T0, "and remembered");
  assert.ok(classesOf(first.orders).includes("queue-head-age"), "the head's age is raised from the first tick");

  const second = gate(dir, harness, { now: T0 + QUEUE_ENTRY_NO_RUN_CONFIRM_MS });
  assert.deepEqual(harness.calls.dequeued, ["PR_node_5227"], "dequeued by the PULL REQUEST's node id");
  assert.deepEqual(harness.calls.armed, [`${SCOPE}#5227`], "armed again through the arming port");
  assert.equal(keptBeforeTheAct, "attempted", "THE ONCE IS WRITTEN BEFORE THE ACT: the file already held the attempt when the dequeue was sent");
  assert.equal(harness.calls.comments.length, 1, "the record is posted once");
  assert.match(harness.calls.comments[0].text, /queue-entry-no-run: 0*5227a+/);
  assert.equal(harness.calls.comments[0].id, 5227);
  const memory = memoryOf(dir);
  assert.equal(memory.requeued["5227"].outcome, "requeued");
  assert.equal(memory.days["2026-10-12"], 1, "COUNTED: one re-queue today");
  const counted = second.orders.filter((order) => order.subject === "queue-entry-no-run");
  assert.deepEqual(counted.map((order) => order.session).sort(), ["ceo", "product-manager"], "read by product-manager and ceo");
  assert.match(counted[0].prompt, /1 merge-queue entry was re-queued today/);
});

test("(3) A REPEAT IS AN INCIDENT: the same pull request with no run AGAIN is not dequeued or armed a second time, and raises the signal", () => {
  const dir = tmpDir("queue-no-run-");
  let entries = [entry(5227)];
  const harness = queue({ entries: () => entries, runs: { [SHA(5227)]: 0, [SHA(9000)]: 0 } });
  gate(dir, harness, { now: T0 });
  gate(dir, harness, { now: T0 + QUEUE_ENTRY_NO_RUN_CONFIRM_MS });
  assert.equal(harness.calls.dequeued.length, 1, "POSITIVE CONTROL: the first occurrence IS re-queued");

  // the re-queue built a new group (a new head sha) for the same pull request, and its checks never started either
  entries = [entry(5227, { age: 12, sha: SHA(9000) })];
  gate(dir, harness, { now: T0 + 20 * MIN });
  const again = gate(dir, harness, { now: T0 + 22 * MIN });
  assert.equal(harness.calls.dequeued.length, 1, "no second dequeue");
  assert.equal(harness.calls.armed.length, 1, "no second re-arm (the `pr merge` of the row's test)");
  assert.equal(harness.calls.comments.length, 1, "and no second record");
  const incident = again.orders.filter((order) => order.subject === "queue-entry-no-run");
  assert.equal(incident.length, 2, "raised to product-manager and ceo");
  assert.match(incident[0].prompt, /INCIDENT: #5227 has stood AWAITING_CHECKS \d+ minutes with no run on 9000a+ AGAIN after its one re-queue \(re-queued at 2026-10-12T14:01:00\.000Z\)/);
  assert.equal(memoryOf(dir).days["2026-10-12"], 1, "the count did not move");
});

test("(3) a re-queue whose dequeue FAILED spends the one: the next occurrence is the repeat, and says the re-queue did not complete", () => {
  const dir = tmpDir("queue-no-run-");
  const harness = queue({ entries: () => [entry(5227)], runs: { [SHA(5227)]: 0 }, dequeue: "errors-in-body" });
  gate(dir, harness, { now: T0 });
  const tried = gate(dir, harness, { now: T0 + QUEUE_ENTRY_NO_RUN_CONFIRM_MS });
  assert.equal(harness.calls.dequeued.length, 1);
  assert.deepEqual(harness.calls.armed, [], "no re-arm after a refused dequeue");
  assert.match(tried.said.join(""), /NOT re-queued -- the dequeue failed: the dequeue was refused: not in the queue/);
  const next = gate(dir, harness, { now: T0 + 3 * MIN });
  assert.equal(harness.calls.dequeued.length, 1, "not tried a second time");
  assert.match(next.orders.find((order) => order.subject === "queue-entry-no-run")?.prompt ?? "", /its one re-queue did not complete: the dequeue failed/);
});

test("a queue that cannot be read names nothing, writes nothing and says so; a memory that does not parse takes no action", () => {
  const dir = tmpDir("queue-no-run-");
  const refused = gate(dir, queue({ entries: () => [entry(1)], queueRead: "throw" }), { now: T0 });
  assert.deepEqual(refused.orders, []);
  assert.match(refused.said.join(""), /could not be read \(HTTP 502\)/);
  assert.equal(existsSync(join(dir, QUEUE_ENTRY_NO_RUN_FILE)), false);

  writeFileSync(join(dir, QUEUE_ENTRY_NO_RUN_FILE), "{ not json");
  const harness = queue({ entries: () => [entry(5227)], runs: { [SHA(5227)]: 0 } });
  gate(dir, harness, { now: T0 });
  const garbled = gate(dir, harness, { now: T0 + 5 * MIN });
  assert.deepEqual(harness.calls.dequeued, [], "a memory read as empty would re-queue twice, so nothing is done");
  assert.deepEqual(garbled.orders, []);
  assert.equal(readFileSync(join(dir, QUEUE_ENTRY_NO_RUN_FILE), "utf8"), "{ not json", "and the file is left as it was");
});

test("queue-head-age: the position-1 entry past ten minutes is named WITH whether a run exists, one order a day per pull request; a younger head is not", () => {
  const dir = tmpDir("queue-no-run-");
  const old = queue({ entries: () => [entry(7, { age: 25, position: 1, sha: SHA(7) }), entry(8, { age: 5, position: 2, state: "QUEUED" })], runs: { [SHA(7)]: 3 } });
  const orders = gate(dir, old, { now: T0 }).orders;
  const head = orders.filter((order) => order.subject === "queue-head-age");
  assert.deepEqual(head.map((order) => order.session).sort(), ["ceo", "product-manager"]);
  assert.match(head[0].prompt, /position-1 entry \(#7\) has stood 25 minutes, past 10, in AWAITING_CHECKS; 3 runs on its group/);
  assert.equal(head[0].discriminator, "queue-head-age@2026-10-12:#7");
  assert.deepEqual(old.calls.dequeued, [], "a head WITH runs is not the no-run shape and is never dequeued");
  assert.ok(!classesOf(orders).includes("queue-entry-no-run"), "and is not counted");

  const young = queue({ entries: () => [entry(7, { age: 4 })], runs: { [SHA(7)]: 0 } });
  assert.deepEqual(gate(tmpDir("queue-no-run-"), young, { now: T0 }).orders, [], "POSITIVE CONTROL's negative: four minutes is neither named nor counted");
  assert.deepEqual(gate(tmpDir("queue-no-run-"), queue({ entries: () => [] }), { now: T0 }).orders, [], "an empty queue is clear");
});

test("both new classes are declared in the suppression table as DIGEST, and a first reader is named for each", () => {
  for (const cls of ["queue-entry-no-run", "queue-head-age"]) assert.equal(ORG_HEALTH_CLASSES[cls]?.severity, "digest", `${cls} is declared`);
});

test("WIRING: the gate calls the detector with the machinery state it reads for the other flags, so the class is not dead for want of a caller (#2980's lesson)", () => {
  const gate = workGateSource();
  assert.match(gate, /import \{ queueEntryNoRunOrders \} from "\.\/work-gate\/causes\/queue-entry-no-run\.ts"/);
  assert.match(gate, /queueEntryNoRunOrders\(\{[^\n]*state: readReenqueueState\(\)/);
});

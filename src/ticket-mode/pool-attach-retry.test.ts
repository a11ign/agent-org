// no-token: gh -- herdr, the tracker and the clock are all injected; nothing is spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import { batchDir, createPool, herdrName, type QueueStore } from "./pool.ts";
import { fakeHerdr } from "./pool-fixture.ts";
import { workingNote } from "./board-view/pull-status-and-notes.ts";
import { ATTACH_WAITS_MS } from "./attach-retry.ts";
import { enqueue, type Outcome, type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { pauseQueue, resumeQueue } from "./queue/queue-transitions.ts";
import { emptyQueue } from "./queue.ts";
import { parseTicketSettings } from "./settings.ts";
import type { Ticket, TicketSource } from "./source.ts";
import { ticketDir } from "./ticket-paths.ts";

const fake = createFakeTracker();
const ticket = (key: string) => ({ key, title: key, description: "", url: `https://linear.app/x/${key}`, branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
const settled = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const reasonOf = (outcome: Outcome | undefined): string => (outcome?.kind === "needs-human" ? outcome.reason : "");

/** The pool's clock starts ahead of the real one, so an outcome file the test writes now is older than a run that ends on it, as a worker's is on a real clock. */
const START = Date.now() + 3_600_000;
const PLAN_FILE = "NBF-1-0001-plan-fit.md";
const PLAN_TEXT = "# Fit\n\n## Paths\n\n- `agent-org:src/fit.ts`\n";

/** What the tracker does with the nth attach (from 1): throws, or takes the plan. */
type Attempt = (n: number, key: string) => void;
const networkBlip = () => new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
const answered = (status: number, message: string) => Object.assign(new Error(message), { status });

/** A pool over a planning run (a batch's, with `batch`) whose plan the tracker is asked to attach; `clock.now` is the pool's time, moved by the test. Paused after its first tick, so a freed slot starts nothing. */
async function planning(attempt: Attempt, { keys = ["NBF-1"], batch = false }: { keys?: string[]; batch?: boolean } = {}) {
  const root = tmpDir("ticket-attach-retry-");
  const run = batch ? "Run the planner with: unattended: plan {keys} into {dir}" : "Run the planner with: unattended: plan {key} into {dir}";
  const settings = parseTicketSettings({ clones: { "agent-org": "/repos/agent-org" }, stateDir: join(root, "state"), tickets: { plan: "-plan-[^/]*\\.md$", planner: { run, state: "Planned" } } });
  const calls: { key: string; files: string[] }[] = [];
  const source: TicketSource = { assigned: fake.assigned, read: fake.read, download: fake.download, keywords: fake.keywords,
    attachPlan: async (key, files) => { calls.push({ key, files: [...files] }); attempt(calls.length, key); return null; } };
  let queue: Queue = resumeQueue(enqueue(emptyQueue(2), keys.map(ticket), { model: "sonnet", effort: "high" }, 0, { keys: new Set(keys), choice: { model: "opus", effort: "max" }, batch }));
  const store: QueueStore = { get: () => queue, set: (next: Queue) => { queue = next; } };
  const status = new Map<string, string>();
  const herdr = fakeHerdr(status);
  const clock = { now: START };
  const pool = createPool(store, { settings, source, hook: { node: "/node", bin: "/tool/src/bin.ts" }, herdr: herdr.run, hostFile: "/work/.agent-org/host.json", now: () => clock.now, load: () => ({ load: 1, cores: 14 }),
    transcriptsRoot: join(root, "transcripts"), wait: async () => {}, pluginRecord: join(root, "no-plugin-record.json"), codeHost: createFakeCodeHost() });
  await pool.tick();
  store.set(pauseQueue(store.get()));
  const entry = (key: string) => queue.entries.find((e) => e.ticket.key === key)!;
  const dir = batch ? batchDir(settings, "b0-0") : ticketDir(settings, keys[0]);
  const planFile = join(dir, "plan", ...(batch ? [keys[0]] : []), PLAN_FILE);
  for (const key of keys) {
    const file = join(dir, "plan", ...(batch ? [key] : []), `${key}-0001-plan-fit.md`);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, PLAN_TEXT);
  }
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "planned" }));
  status.set(herdrName(batch ? "b0-0" : keys[0]), "idle");
  /** A tick, `after` milliseconds past the last, with the attach it starts finished. */
  const tick = async (after = 0) => { clock.now += after; await pool.tick(); await settled(); };
  const prompts = () => herdr.calls.filter((args) => args.includes("prompt"));
  const starts = () => herdr.calls.filter((args) => args.includes("agent") && args.includes("start"));
  return { entry, calls, tick, prompts, starts, planFile, dir, pool, status };
}

test("a network error then success attaches with no person: the card says retry 1 while it waits, nothing is asked of the tracker before the wait is over, and the retry attaches the same files", async () => {
  const { entry, calls, tick, planFile, prompts, starts } = await planning((n) => { if (n === 1) throw networkBlip(); });
  await tick();
  assert.equal(calls.length, 1);
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").outcome], ["running", undefined], "not ended, and no person");
  assert.equal(entry("NBF-1").working?.reason, "attaching the plan (retry 1)");
  assert.deepEqual(workingNote(entry("NBF-1")), { text: "attaching the plan (retry 1)", stalled: false, waiting: false });
  const afterFirstTry = readFileSync(planFile, "utf8");
  await tick(ATTACH_WAITS_MS[0] - 1);
  assert.equal(calls.length, 1, "the wait is not over, so the tracker is not asked");
  await tick(1);
  assert.equal(calls.length, 2, "asked again once it is");
  assert.deepEqual(calls[1], calls[0], "the same plan files");
  assert.deepEqual(calls[1].files, [planFile]);
  const stamped = readFileSync(planFile, "utf8");
  assert.equal(stamped, afterFirstTry, "the retry leaves the plan on disk as the first try left it: stamped once, not again");
  assert.equal(stamped.split("## Planned against").length - 1, 1);
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").planned, entry("NBF-1").outcome, entry("NBF-1").working], ["queued", true, undefined, undefined], "queued again as planned, with no retry note left");
  assert.deepEqual([prompts(), starts().length], [[], 1], "the planner was never woken or started again: nothing was re-planned");
});

test("four network failures end Needs you, naming the error and the plan folder, after waits of 5 s, 30 s and 2 min; the tracker was asked exactly four times", async () => {
  for (const failure of [networkBlip(), answered(503, "Linear answered 503: upstream")]) {
    const { entry, calls, tick, dir } = await planning(() => { throw failure; });
    await tick();
    assert.equal(entry("NBF-1").working?.reason, "attaching the plan (retry 1)");
    await tick(ATTACH_WAITS_MS[0]);
    assert.equal(entry("NBF-1").working?.reason, "attaching the plan (retry 2)");
    await tick(ATTACH_WAITS_MS[1]);
    assert.equal(entry("NBF-1").working?.reason, "attaching the plan (retry 3)");
    assert.deepEqual([calls.length, entry("NBF-1").outcome], [3, undefined], "three failures are not yet a person's");
    await tick(ATTACH_WAITS_MS[2]);
    assert.equal(calls.length, 4);
    assert.equal(entry("NBF-1").outcome?.kind, "needs-human");
    assert.equal(reasonOf(entry("NBF-1").outcome), `the plan could not be attached after 4 tries (${failure.message}): its files are in ${join(dir, "plan")}`);
    await tick(ATTACH_WAITS_MS[2]);
    assert.equal(calls.length, 4, "an ended run is not tried again");
  }
});

test("a 4xx ends Needs you at once, naming the refusal, with one call and no retry note", async () => {
  const refusal = answered(400, "Linear answered 400: Argument Validation Error");
  const { entry, calls, tick, dir } = await planning(() => { throw refusal; });
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(reasonOf(entry("NBF-1").outcome), `the plan could not be attached (${refusal.message}): its files are in ${join(dir, "plan")}`);
  assert.equal(entry("NBF-1").working, undefined, "no retry note");
  await tick(ATTACH_WAITS_MS[0]);
  assert.equal(calls.length, 1, "no retry");
});

test("a refusal after a network failure goes to a person at once, naming the refusal", async () => {
  const { entry, calls, tick } = await planning((n) => { throw n === 1 ? networkBlip() : answered(403, "the upload of x was refused (403)"); });
  await tick();
  await tick(ATTACH_WAITS_MS[0]);
  assert.equal(calls.length, 2);
  assert.match(reasonOf(entry("NBF-1").outcome), /^the plan could not be attached \(the upload of x was refused \(403\)\)/);
});

test("a run stopped while it waits to try again is the person's last word: the tracker is not asked again", async () => {
  const { entry, calls, tick, pool } = await planning(() => { throw networkBlip(); });
  await tick();
  pool.stop("NBF-1");
  await tick(ATTACH_WAITS_MS[0]);
  assert.equal(calls.length, 1);
  assert.equal(entry("NBF-1").outcome?.kind, "stopped");
});

test("a run waiting to try again is never marked stalled or prompted, however long its agent has been idle", async () => {
  const { entry, tick, prompts } = await planning(() => { throw networkBlip(); });
  await tick();
  await tick(1_000);
  // Three minutes on, the attach is tried again; the stall watch that follows in the same tick would otherwise mark the run stalled and prompt the planner.
  await tick(180_000);
  assert.deepEqual(prompts(), []);
  assert.equal(entry("NBF-1").working?.stalled, undefined);
  assert.equal(entry("NBF-1").working?.reason, "attaching the plan (retry 2)");
});

test("a planner that writes working while an attach waits to be tried again drops the wait: its next planned is attached at once, from the first try", async () => {
  const { entry, calls, tick, dir } = await planning((n) => { if (n === 1) throw networkBlip(); });
  await tick();
  assert.equal(entry("NBF-1").working?.reason, "attaching the plan (retry 1)");
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "working", reason: "rechecking the plan" }));
  await tick(1);
  assert.equal(calls.length, 1, "working attaches nothing");
  writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "planned" }));
  await tick(1);
  assert.equal(calls.length, 2, "attached without waiting out the earlier wait");
  assert.deepEqual([entry("NBF-1").phase, entry("NBF-1").outcome], ["queued", undefined]);
});

test("a batch whose attach fails once with fetch failed is planned whole, with no member handed back", async () => {
  const { entry, calls, tick, prompts } = await planning((n) => { if (n === 1) throw networkBlip(); }, { keys: ["NBF-1", "NBF-2"], batch: true });
  await tick();
  for (const key of ["NBF-1", "NBF-2"]) assert.deepEqual([entry(key).phase, entry(key).working?.reason, entry(key).outcome], ["running", "attaching the plan (retry 1)", undefined], key);
  await tick(ATTACH_WAITS_MS[0]);
  assert.deepEqual(calls.map(({ key }) => key), ["NBF-1", "NBF-1", "NBF-2"], "the whole batch is tried again; nothing is attached twice by the board's own doing");
  for (const key of ["NBF-1", "NBF-2"]) assert.deepEqual([entry(key).phase, entry(key).planned, entry(key).outcome, entry(key).working], ["queued", true, undefined, undefined], key);
  assert.deepEqual(prompts(), []);
});

test("a batch whose attach keeps failing on the network ends every member Needs you after four tries", async () => {
  const keys = ["NBF-1", "NBF-2"];
  const { entry, calls, tick } = await planning(() => { throw networkBlip(); }, { keys, batch: true });
  await tick();
  for (const wait of ATTACH_WAITS_MS) await tick(wait);
  assert.equal(calls.length, 4);
  for (const key of keys) assert.match(reasonOf(entry(key).outcome), /^the plans could not be attached after 4 tries \(fetch failed\): their files are in .*plan$/, key);
});

test("a ticket of a batch the tracker refuses with a 4xx is handed back alone, and the others carry on", async () => {
  const { entry, calls, tick } = await planning((_n, key) => { if (key === "NBF-1") throw answered(400, "Linear answered 400: bad"); }, { keys: ["NBF-1", "NBF-2"], batch: true });
  await tick();
  assert.deepEqual(calls.map(({ key }) => key), ["NBF-1", "NBF-2"]);
  assert.match(reasonOf(entry("NBF-1").outcome), /^the plan could not be attached \(Linear answered 400: bad\): its files are in .*NBF-1$/);
  assert.deepEqual([entry("NBF-2").phase, entry("NBF-2").planned], ["queued", true]);
});

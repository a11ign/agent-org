// no-token: gh -- herdr, the tracker and the clock are injected; the pool is driven over fakes
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { poolFixture } from "./pool-fixture.ts";
import { BRIEF_FILE, OUTCOME_FILE } from "./worker-files.ts";
import { ticketDir } from "./ticket-paths.ts";

// A11-219: a run's planned steps, its current step and the machine it ran on, as the run detail draws them.
const PLAN = { plan: "-plan-[^/]*\\.md$" };
const PLAN_TEXT = ["# Plan", "", "### Step 1 of 3: Read the queue", "", "text", "", "### Step 2 of 3: Record it", "", "### Step 3 of 3: Show it", ""].join("\n");

/** Write a plan file into the folder the pool downloads a queued run's plan to. */
function writePlan(made: ReturnType<typeof poolFixture>, key: string, text: string): void {
  const dir = join(ticketDir(made.settings, key), "paths");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${key}-plan-run-detail.md`), text);
}

/** A pool whose run NBF-1 has started with a plan of `text` and is working. */
async function workingRun(text: string | null) {
  const made = poolFixture({ tickets: PLAN });
  if (text !== null) writePlan(made, "NBF-1", text);
  await made.pool.tick();
  made.status.set("t-nbf-1", "working");
  return made;
}

/** Write the run's outcome file. */
function writeOutcome(made: ReturnType<typeof poolFixture>, key: string, outcome: Record<string, unknown>): void {
  mkdirSync(ticketDir(made.settings, key), { recursive: true });
  writeFileSync(join(ticketDir(made.settings, key), OUTCOME_FILE), JSON.stringify(outcome));
}

const briefOf = (made: ReturnType<typeof poolFixture>, key: string): string => readFileSync(join(ticketDir(made.settings, key), BRIEF_FILE), "utf8");

test("A11-219: a work run's plan steps are read from its plan files when it starts, and the worker is recorded", async () => {
  const made = poolFixture({ tickets: PLAN });
  writePlan(made, "NBF-1", PLAN_TEXT);
  await made.pool.tick();
  const entry = made.entry("NBF-1");
  assert.deepEqual(entry.plannedSteps, [{ n: 1, title: "Read the queue" }, { n: 2, title: "Record it" }, { n: 3, title: "Show it" }]);
  assert.deepEqual(entry.worker, { instance: made.settings.instance, host: hostname() });
  assert.equal(entry.currentStep, undefined, "a single-pull-request plan has no current step until its worker writes one");
  assert.match(briefOf(made, "NBF-1"), /"currentStep": <N>/, "a plan with steps has its worker write the step it is on");
});

test("A11-219: a run with no plan file carries no steps and no current step, and still records its worker", async () => {
  const made = poolFixture({ tickets: PLAN });
  await made.pool.tick();
  const entry = made.entry("NBF-1");
  assert.equal(entry.plannedSteps, undefined);
  assert.equal(entry.currentStep, undefined);
  assert.deepEqual(entry.worker, { instance: made.settings.instance, host: hostname() });
  assert.doesNotMatch(briefOf(made, "NBF-1"), /currentStep/, "a run without steps is not told to write one");
});

test("A11-219: a plan that numbers no step, or a machine with no plan setting, gives a run no steps", async () => {
  const noSteps = poolFixture({ tickets: PLAN });
  writePlan(noSteps, "NBF-1", "## Approach\n\nDo it.\n");
  await noSteps.pool.tick();
  assert.equal(noSteps.entry("NBF-1").plannedSteps, undefined);
  const noSetting = poolFixture();
  writePlan(noSetting, "NBF-1", PLAN_TEXT);
  await noSetting.pool.tick();
  assert.equal(noSetting.entry("NBF-1").plannedSteps, undefined);
  assert.ok(noSetting.entry("NBF-1").worker !== undefined);
});

test("A11-219: a run queued for a later step of a multi-pull-request plan starts on that step", async () => {
  const made = poolFixture({ tickets: PLAN });
  writePlan(made, "NBF-1", PLAN_TEXT);
  made.store.set({ ...made.store.get(), entries: made.store.get().entries.map((entry) => ({ ...entry, steps: [{ step: 1, of: 3, prs: ["https://github.com/a11ign/agent-org/pull/1"] }] })) });
  await made.pool.tick();
  assert.equal(made.entry("NBF-1").currentStep, 2);
});

test("A11-219: the current step a worker writes in its outcome file is recorded while it works, as written, and the run keeps running", async () => {
  const made = await workingRun(PLAN_TEXT);
  writeOutcome(made, "NBF-1", { kind: "working", reason: "reading the queue", currentStep: 2 });
  await made.pool.tick();
  assert.equal(made.entry("NBF-1").currentStep, 2);
  assert.equal(made.entry("NBF-1").phase, "running");
  await made.pool.tick();
  assert.equal(made.entry("NBF-1").currentStep, 2, "reading the same file again changes nothing");
  writeOutcome(made, "NBF-1", { kind: "working", reason: "past the plan", currentStep: 9 });
  await made.pool.tick();
  assert.equal(made.entry("NBF-1").currentStep, 9, "a step past the last planned one is recorded as written");
  assert.equal(made.entry("NBF-1").phase, "running");
});

/** Have the working run's agent end its turn on `outcome`, and tick once: the run as the queue then holds it. */
async function endedOn(made: Awaited<ReturnType<typeof workingRun>>, outcome: Record<string, unknown>) {
  made.status.set("t-nbf-1", "idle");
  writeOutcome(made, "NBF-1", outcome);
  await made.pool.tick();
  return made.entry("NBF-1");
}

test("A11-219: a final outcome's currentStep is recorded with it, and an outcome without one keeps the step the run was on", async () => {
  const made = await workingRun(PLAN_TEXT);
  writeOutcome(made, "NBF-1", { kind: "working", reason: "step 2", currentStep: 2 });
  await made.pool.tick();
  const kept = await endedOn(made, { kind: "checked", reason: "nothing to change" });
  assert.deepEqual([kept.phase, kept.currentStep], ["finished", 2]);
  const written = await endedOn(await workingRun(null), { kind: "checked", reason: "nothing to change", currentStep: 3 });
  assert.deepEqual([written.phase, written.currentStep], ["finished", 3]);
});

test("A11-219: a currentStep that is no whole number of 1 or more is not recorded", async () => {
  const made = await workingRun(null);
  writeOutcome(made, "NBF-1", { kind: "working", reason: "step zero", currentStep: 0 });
  await made.pool.tick();
  assert.equal(made.entry("NBF-1").currentStep, undefined);
});

test("A11-219: an outcome file that cannot be read as a file does not stop the watch, and records no step", async () => {
  const made = await workingRun(null);
  mkdirSync(join(ticketDir(made.settings, "NBF-1"), OUTCOME_FILE), { recursive: true });
  await made.pool.tick();
  assert.equal(made.entry("NBF-1").currentStep, undefined);
  assert.equal(made.entry("NBF-1").phase, "running");
});

test("A11-219: a plan file that cannot be read does not start the run as if it had no plan: it ends crashed, naming the file, and no agent starts", async () => {
  const made = poolFixture({ tickets: PLAN });
  mkdirSync(join(ticketDir(made.settings, "NBF-1"), "paths", "NBF-1-plan-unreadable.md"), { recursive: true });
  await made.pool.tick();
  const entry = made.entry("NBF-1");
  assert.equal(entry.phase, "finished");
  assert.equal(entry.outcome?.kind, "crashed");
  assert.match(entry.outcome?.kind === "crashed" ? entry.outcome.reason : "", /^its plan file NBF-1-plan-unreadable\.md could not be read \(EISDIR/);
  assert.equal(entry.plannedSteps, undefined);
  assert.equal(made.herdr.calls.filter((args) => args.includes("agent") && args.includes("start")).length, 0, "no agent was started");
});

test("A11-219: a plan file over the size limit, or a ticket with no plan folder, is not an unreadable plan: the run starts without steps", async () => {
  const absent = poolFixture({ tickets: PLAN });
  await absent.pool.tick();
  assert.equal(absent.entry("NBF-1").phase, "running");
  const big = poolFixture({ tickets: PLAN });
  writePlan(big, "NBF-1", `${PLAN_TEXT}${"x".repeat(1_000_001)}`);
  await big.pool.tick();
  assert.equal(big.entry("NBF-1").phase, "running");
  assert.equal(big.entry("NBF-1").plannedSteps, undefined);
});

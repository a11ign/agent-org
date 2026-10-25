// no-token: gh -- herdr, the tracker, the clock, the fleet job service and the restart reads are injected; the pool is driven over fakes and nothing is spawned
// A11-279: a run's agent is reached by its pane, never its name; after a restart (a new boot, a new herdr start, the instance's own start) a run left at a prompt with no outcome is resumed in that pass;
// a run whose workspace is gone starts again first; an idle run is resumed once, then handed to a person
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { poolFixture } from "./pool-fixture.ts";
import { herdrName } from "./pool.ts";
import { ticketDir } from "./ticket-paths.ts";
import { BRIEF_FILE } from "./worker-files.ts";
import { reasonOf, resumeLine } from "./board-view/run-reason.ts";
import { clockOf } from "./board-view/update-banner.ts";
import { agentTarget, IDLE_RESUME_MS, readRestart, RESUME_PROMPT, resumePrompt, sendToAgent, type RestartReads } from "./pool-resume.ts";
import { newPoolContext } from "./pool-context.ts";
import { lostText } from "./brief-ticket-text.ts";
import { find, replace, type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { lostBeforeThisStart, loseInRestart } from "./queue/queue-readopt.ts";
import { requeueForUpdate } from "./queue/queue-pins.ts";
import type { PoolDeps } from "./pool-context.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 25, 15, 0, 0);
const INTERRUPTED = "⎿  Interrupted · What should Claude do instead?\n\n> ";
const PANES = { "NBF-1": "w1:p1", "NBF-2": "w2:p1" } as const;

/** Restart reads a test moves: the boot id and herdr's start time. */
function movableReads() {
  const held = { boot: "boot-1", herdr: "1" };
  const reads: RestartReads = { bootId: () => held.boot, herdrStart: () => held.herdr };
  return { held, reads };
}

/** `keys` started and seen working, each with a `working` note written at T0, on a clock a test moves, by one pool over `deps`. */
async function liveRuns(keys: readonly string[] = ["NBF-1", "NBF-2"], deps: Partial<PoolDeps> = {}) {
  let clock = T0;
  const { held, reads } = movableReads();
  const made = poolFixture({ keys, max: 3, now: () => clock, restartReads: reads });
  /** Set to herdr's reason to have it refuse every prompt with it; `tried` counts the prompts it refused. */
  const refusing: { reason: string | null; tried: number } = { reason: null, tried: 0 };
  const herdr = (args: string[]): string => {
    if (refusing.reason !== null && args[3] === "prompt") refusing.tried += 1;
    if (refusing.reason !== null && args[3] === "prompt") throw Object.assign(new Error("herdr exited 1"), { stderr: `${refusing.reason}\n` });
    return made.herdr.run(args);
  };
  const pool = made.restart({ restartReads: reads, herdr, ...deps });
  await pool.tick();
  for (const key of keys) made.status.set(herdrName(key), "working");
  await pool.tick();
  const write = (key: string, outcome: Record<string, unknown>) => {
    const file = join(ticketDir(made.settings, key), "outcome.json");
    writeFileSync(file, JSON.stringify(outcome));
    utimesSync(file, new Date(clock), new Date(clock));
  };
  for (const key of keys) write(key, { kind: "working", reason: `${key}: step 2 of 7`, currentStep: 2 });
  await pool.tick();
  const agentCalls = () => made.herdr.calls.filter((args) => args[2] === "agent" && ["prompt", "read", "send-keys", "get"].includes(args[3] ?? ""));
  const prompts = (pane: string) => made.herdr.calls.filter((args) => args[3] === "prompt" && args[4] === pane).map((args) => String(args[5]));
  const resumes = (pane: string) => prompts(pane).filter((text) => text.startsWith(RESUME_PROMPT));
  const advance = async (ms: number) => { clock += ms; await pool.tick(); await new Promise<void>((resolve) => { setImmediate(resolve); }); };
  return { ...made, pool, held, refusing, write, agentCalls, prompts, resumes, advance, now: () => clock };
}

test("A11-279: herdr restarts under two live runs: both are resumed at their panes in the next pass, carry on, and end on their own outcomes, with no person", async () => {
  const run = await liveRuns();
  // herdr's service starts again: it brings each session back interrupted, and Claude waits at its prompt.
  run.held.herdr = "2";
  for (const key of ["NBF-1", "NBF-2"] as const) {
    run.status.set(herdrName(key), "idle");
    run.herdr.screens.set(PANES[key], INTERRUPTED);
  }
  await run.advance(30_000);
  for (const key of ["NBF-1", "NBF-2"] as const) {
    assert.deepEqual(run.resumes(PANES[key]), [RESUME_PROMPT], `${key} is sent the resume prompt once, at its pane, in the pass that sees the restart`);
    assert.deepEqual(run.entry(key).resume, { at: T0 + 30_000, after: "restart" });
    assert.equal(reasonOf(run.entry(key)).line, `Resumed after a restart at ${clockOf(T0 + 30_000)}; ${key}: step 2 of 7`, "the card says so");
  }
  // They take the prompt and work; the same restart is not seen twice.
  for (const key of ["NBF-1", "NBF-2"]) run.status.set(herdrName(key), "working");
  await run.advance(30_000);
  await run.advance(30_000);
  for (const key of ["NBF-1", "NBF-2"] as const) assert.equal(run.resumes(PANES[key]).length, 1, `${key}: one resume`);
  for (const key of ["NBF-1", "NBF-2"]) {
    run.write(key, { kind: "checked", reason: "carried on and checked" });
    run.status.set(herdrName(key), "idle");
  }
  await run.advance(30_000);
  for (const key of ["NBF-1", "NBF-2"]) assert.deepEqual([run.entry(key).phase, run.entry(key).outcome?.kind, run.entry(key).resume], ["finished", "checked", undefined], key);
  // A11-279 (g): every call that reached an agent named its pane; herdr 0.9.3 refuses a name, and so does the fixture.
  assert.ok(run.agentCalls().length > 0);
  for (const args of run.agentCalls()) assert.match(args[4] ?? "", /^w\d+:p\d+$/, args.join(" "));
});

test("A11-279: an instance that starts up resumes the idle run with no outcome and leaves the working one alone, and does not end the idle one for having none", async () => {
  let clock = T0;
  const made = poolFixture({ keys: ["NBF-1", "NBF-2"], max: 3, now: () => clock });
  await made.pool.tick();
  for (const key of ["NBF-1", "NBF-2"]) made.status.set(herdrName(key), "working");
  await made.pool.tick();
  // NBF-1's agent stopped at its prompt with no outcome written while the instance was down; NBF-2 is working.
  made.status.set(herdrName("NBF-1"), "idle");
  clock += MIN;
  const next = made.restart({});
  await next.tick();
  const prompts = (pane: string) => made.herdr.calls.filter((args) => args[3] === "prompt" && args[4] === pane);
  assert.equal(prompts("w1:p1").length, 1, "the idle run is resumed");
  assert.equal(prompts("w2:p1").length, 0, "the working run is sent nothing");
  assert.deepEqual([made.entry("NBF-1").phase, made.entry("NBF-1").resume?.after], ["running", "restart"], "not ended `no-outcome` by the status read before its prompt");
  await next.tick();
  assert.equal(prompts("w1:p1").length, 1, "the instance's start is one restart");
});

test("A11-279: on a new boot a run whose workspace is gone is queued again at the front, and its brief says its worktree holds the earlier work", async () => {
  let clock = T0;
  const { held, reads } = movableReads();
  const made = poolFixture({ keys: ["NBF-1", "NBF-2", "NBF-3"], max: 2, now: () => clock, restartReads: reads });
  await made.pool.tick();
  assert.deepEqual(["NBF-1", "NBF-2", "NBF-3"].map((key) => made.entry(key).phase), ["running", "running", "queued"]);
  // The host rebooted: herdr brought NBF-2 back, and NBF-1's workspace is gone.
  held.boot = "boot-2";
  made.status.set(herdrName("NBF-2"), "working");
  clock += MIN;
  const next = made.restart({ restartReads: reads });
  next.reconcile();
  assert.deepEqual(made.store.get().entries.map((entry) => entry.ticket.key), ["NBF-1", "NBF-2", "NBF-3"], "the lost run is first, ahead of the one that was only queued");
  assert.deepEqual([made.entry("NBF-1").phase, made.entry("NBF-1").lostInRestart], ["queued", { at: clock }]);
  await next.tick();
  assert.equal(made.entry("NBF-1").phase, "running", "it takes the free slot before NBF-3");
  assert.equal(made.entry("NBF-3").phase, "queued");
  const brief = readFileSync(join(ticketDir(made.settings, "NBF-1"), BRIEF_FILE), "utf8");
  assert.ok(brief.includes(lostText(clock)), "the brief opens with the restart section");
  assert.ok(brief.includes("carry on from the earlier run's work rather than starting again"));
});

test("A11-279: a brief for a run no restart lost has no restart section", () => {
  assert.equal(lostText(undefined), "");
  assert.match(lostText(T0), /^## A restart lost this run's session\n\n.*2026-10-25T15:00:00\.000Z/);
});

test("A11-279: an idle run with no outcome is resumed once after ten minutes, with the card saying since when, and handed to a person ten minutes after that, its pane kept", async () => {
  const run = await liveRuns(["NBF-1"]);
  run.status.set(herdrName("NBF-1"), "idle");
  await run.advance(MIN);
  const since = T0 + MIN;
  assert.equal(run.entry("NBF-1").idleSince, since, "its idle clock starts");
  await run.advance(IDLE_RESUME_MS - 1);
  assert.equal(run.resumes("w1:p1").length, 0, "not before ten minutes");
  await run.advance(1);
  const resumedAt = since + IDLE_RESUME_MS;
  assert.deepEqual(run.resumes("w1:p1"), [RESUME_PROMPT], "resumed once");
  assert.deepEqual(run.entry("NBF-1").resume, { at: resumedAt, after: "idle", idleSince: since });
  assert.equal(resumeLine(run.entry("NBF-1")), `Idle since ${clockOf(since)}, resumed at ${clockOf(resumedAt)}`);
  assert.ok(reasonOf(run.entry("NBF-1"), run.now()).line?.startsWith(`Idle since ${clockOf(since)}, resumed at ${clockOf(resumedAt)}`), "the card says it, not only running");
  await run.advance(IDLE_RESUME_MS - 1);
  assert.equal(run.entry("NBF-1").phase, "running", "not before ten more minutes");
  assert.equal(run.resumes("w1:p1").length, 1, "resumed once only");
  await run.advance(1);
  const ended = run.entry("NBF-1");
  assert.deepEqual([ended.phase, ended.outcome?.kind, ended.workspace, ended.pane], ["finished", "needs-human", "w1", "w1:p1"], "Needs you, with its pane kept for the chairman's session");
  assert.equal(ended.outcome?.kind === "needs-human" ? ended.outcome.reason : "", `Off the escalation list: idle at a prompt since ${new Date(since).toISOString().slice(11, 16)}Z; the board's resume prompt at ${new Date(resumedAt).toISOString().slice(11, 16)}Z did not start it`);
  assert.deepEqual([ended.resume, ended.idleSince], [undefined, undefined], "the idle clock and the resume end with the run");
});

test("A11-279: a run that writes a new outcome after its resume has the resume spent, and its next idle spell is resumed again rather than handed back", async () => {
  const run = await liveRuns(["NBF-1"]);
  run.status.set(herdrName("NBF-1"), "idle");
  await run.advance(MIN);
  await run.advance(IDLE_RESUME_MS);
  assert.equal(run.resumes("w1:p1").length, 1);
  run.status.set(herdrName("NBF-1"), "working");
  await run.advance(MIN);
  run.write("NBF-1", { kind: "working", reason: "step 3 of 7", currentStep: 3 });
  run.status.set(herdrName("NBF-1"), "idle");
  await run.advance(MIN);
  assert.equal(run.entry("NBF-1").resume, undefined, "spent by the newer outcome");
  await run.advance(IDLE_RESUME_MS);
  assert.deepEqual([run.entry("NBF-1").phase, run.resumes("w1:p1").length], ["running", 2]);
});

test("A11-279: a run on a declared fleet job inside its `until` is not idle-resumed, and after a herdr restart its resume names the wait", async () => {
  const until = new Date(T0 + 3 * 60 * MIN).toISOString();
  const run = await liveRuns(["NBF-1"], { waitSeams: { fleetJobStatus: async () => JSON.stringify({ id: "fj-1", state: "running", progress: { done: 1, total: 6 } }) } });
  run.write("NBF-1", { kind: "working", reason: "the capture runs", waitingOn: [{ fleetJob: "fj-1" }], until });
  run.status.set(herdrName("NBF-1"), "idle");
  for (let i = 0; i < 25; i += 1) await run.advance(MIN);
  assert.equal(run.resumes("w1:p1").length, 0, "waiting on its job is not idle");
  assert.equal(run.entry("NBF-1").phase, "running");
  run.held.herdr = "2";
  run.herdr.screens.set("w1:p1", INTERRUPTED);
  await run.advance(30_000);
  assert.deepEqual(run.resumes("w1:p1"), [`${RESUME_PROMPT} You declared a wait on: fleet job fj-1. Check each again before you declare it again.`]);
});

test("A11-279: a run whose pane shows background work running is not idle, however long it sits at its prompt", async () => {
  const run = await liveRuns(["NBF-1"]);
  run.herdr.screens.set("w1:p1", "> \n  ⏵⏵ bypass permissions on · 1 shell");
  run.status.set(herdrName("NBF-1"), "idle");
  for (let i = 0; i < 25; i += 1) await run.advance(MIN);
  assert.deepEqual([run.entry("NBF-1").phase, run.resumes("w1:p1").length], ["running", 0]);
});

test("A11-279: a resume prompt herdr refuses is on the card, is not counted as the run's one resume, and is tried again", async () => {
  const run = await liveRuns(["NBF-1"]);
  run.held.herdr = "2";
  run.status.set(herdrName("NBF-1"), "idle");
  run.refusing.reason = "agent target w1:p1 is busy";
  await run.advance(30_000);
  assert.equal(run.entry("NBF-1").resume?.refused, "agent target w1:p1 is busy");
  assert.equal(resumeLine(run.entry("NBF-1")), "could not be prompted: agent target w1:p1 is busy");
  // herdr keeps refusing past the ten minutes: the board tries again, at most once a minute, and never hands the run back for a prompt that never arrived.
  for (let i = 0; i < 12; i += 1) await run.advance(MIN);
  assert.equal(run.entry("NBF-1").phase, "running", "not handed back: no prompt reached it");
  const tries = run.refusing.tried;
  assert.ok(tries >= 2 && tries <= 4, `tried again, at most once a minute (${tries} tries)`);
  run.refusing.reason = null;
  await run.advance(MIN);
  assert.deepEqual([run.resumes("w1:p1").length, run.entry("NBF-1").resume?.refused, run.entry("NBF-1").resume?.after], [1, undefined, "idle"], "taken: now it is the run's one resume");
});

test("A11-279: the restart is read from the boot id and herdr's start: the instance's first pass, then each change once, and nothing in between", () => {
  const made = poolFixture();
  const { held, reads } = movableReads();
  const ctx = newPoolContext(made.store, { settings: made.settings, source: { assigned: async () => [], read: async () => { throw new Error("unused"); }, download: async () => [] }, codeHost: {} as never, hook: { node: "n", bin: "b" }, restartReads: reads });
  assert.equal(readRestart(ctx), "instance");
  assert.equal(readRestart(ctx), null);
  held.herdr = "2";
  assert.equal(readRestart(ctx), "herdr");
  assert.equal(readRestart(ctx), null);
  held.boot = "boot-2";
  held.herdr = "3";
  assert.equal(readRestart(ctx), "boot", "a boot starts herdr too: it is said as the boot");
  const unread: RestartReads = { bootId: () => null, herdrStart: () => null };
  const blind = newPoolContext(made.store, { ...ctx.deps, restartReads: unread });
  assert.equal(readRestart(blind), "instance", "a new instance is a restart whatever it can read");
  assert.equal(readRestart(blind), null, "a value that cannot be read is no change");
});

test("A11-279: an agent is reached by its pane, or the root pane of the workspace herdr lists under its label, and never by its name", () => {
  const made = poolFixture();
  made.status.set("t-nbf-7", "idle");
  const ctx = newPoolContext(made.store, { settings: made.settings, source: { assigned: async () => [], read: async () => { throw new Error("unused"); }, download: async () => [] }, codeHost: {} as never, hook: { node: "n", bin: "b" }, herdr: made.herdr.run });
  assert.equal(agentTarget(ctx, { name: "t-nbf-7", pane: "w3:p1" }), "w3:p1");
  assert.equal(agentTarget(ctx, { name: "t-nbf-7" }), "w7:p1");
  assert.throws(() => agentTarget(ctx, { name: "t-nbf-8" }), /herdr lists no workspace for t-nbf-8/);
  assert.equal(sendToAgent(ctx, { name: "t-nbf-7" }, "hello"), null);
  assert.deepEqual(made.herdr.calls.at(-1), ["--session", "tickets", "agent", "prompt", "w7:p1", "hello"]);
  assert.match(sendToAgent(ctx, { name: "t-nbf-8" }, "hello") ?? "", /no workspace for t-nbf-8/, "a run herdr does not list is a refusal, not a throw");
  const refusing = newPoolContext(made.store, { ...ctx.deps, herdr: () => { throw Object.assign(new Error("herdr exited 1"), { stderr: "error: agent_blocked\n" }); } });
  assert.equal(sendToAgent(refusing, { name: "t-nbf-7", pane: "w7:p1" }, "hello"), "error: agent_blocked", "herdr's own reason");
});

test("A11-279: the resume prompt is one line, and names a declared wait or a job the worker waits on", () => {
  const entry = (working?: Entry["working"]) => ({ ...poolFixture().entry("NBF-1"), ...(working === undefined ? {} : { working }) }) as Entry;
  assert.equal(resumePrompt(entry()), RESUME_PROMPT);
  assert.equal(RESUME_PROMPT.includes("\n"), false, "a new line typed into a pane would submit it early");
  assert.equal(resumePrompt(entry({ reason: "r", at: 1, waits: [{ kind: "ciRun", repository: "a11ign/agent-org", runId: 9 }] })), `${RESUME_PROMPT} You declared a wait on: CI run a11ign/agent-org#9. Check each again before you declare it again.`);
  assert.equal(resumePrompt(entry({ reason: "r", at: 1, waitingOn: "the nightly build" })), `${RESUME_PROMPT} You declared a wait on: the nightly build. Check each again before you declare it again.`);
});

test("A11-279: a run the board already woke for its declared wait keeps A11-245's one wake: the idle watch sends it nothing more", async () => {
  const run = await liveRuns(["NBF-1"], { waitSeams: { fleetJobStatus: async () => JSON.stringify({ id: "fj-1", state: "running", progress: { done: 1, total: 6 } }) } });
  run.write("NBF-1", { kind: "working", reason: "the capture runs", waitingOn: [{ fleetJob: "fj-1" }], until: new Date(T0 + 5 * MIN).toISOString() });
  run.status.set(herdrName("NBF-1"), "idle");
  for (let i = 0; i < 40; i += 1) await run.advance(MIN);
  assert.equal(run.prompts("w1:p1").length, 1, "the one wake at its deadline, and no resume after it");
  assert.deepEqual([run.entry("NBF-1").phase, run.entry("NBF-1").working?.stalled], ["running", true], "stalled on the card, as A11-245 has it");
});

test("A11-279: a run that worked on for ten minutes after its resume has spent it: idle again, it is resumed again, not handed back", async () => {
  const run = await liveRuns(["NBF-1"]);
  run.held.herdr = "2";
  run.status.set(herdrName("NBF-1"), "idle");
  await run.advance(30_000);
  assert.equal(run.resumes("w1:p1").length, 1);
  run.status.set(herdrName("NBF-1"), "working");
  for (let i = 0; i < 3 * 60; i += 1) await run.advance(MIN);
  assert.equal(run.entry("NBF-1").resume, undefined, "worked on past it: spent");
  run.status.set(herdrName("NBF-1"), "idle");
  for (let i = 0; i < 11; i += 1) await run.advance(MIN);
  assert.deepEqual([run.entry("NBF-1").phase, run.resumes("w1:p1").length], ["running", 2]);
});

test("A11-279: after a herdr restart a run whose undeclared wait is past its bound gets one prompt in that pass, the resume, which names the wait", async () => {
  const run = await liveRuns(["NBF-1"]);
  run.write("NBF-1", { kind: "working", reason: "the nightly", waitingOn: "the nightly build", until: new Date(T0 + 5 * MIN).toISOString() });
  run.status.set(herdrName("NBF-1"), "idle");
  await run.advance(MIN);
  assert.equal(run.entry("NBF-1").working?.waitingOn, "the nightly build");
  run.held.herdr = "2";
  run.status.set(herdrName("NBF-1"), "idle");
  run.herdr.screens.set("w1:p1", INTERRUPTED);
  const before = run.prompts("w1:p1").length;
  await run.advance(10 * MIN);
  assert.deepEqual(run.prompts("w1:p1").slice(before), [`${RESUME_PROMPT} You declared a wait on: the nightly build. Check each again before you declare it again.`], "one prompt: the wake is not sent beside it");
});

test("A11-279: an instance-only restart leaves alone a run stalled after its wait's one wake, and one whose pane shows background work", async () => {
  const run = await liveRuns(["NBF-1", "NBF-2"], { waitSeams: { fleetJobStatus: async () => JSON.stringify({ id: "fj-1", state: "running", progress: { done: 1, total: 6 } }) } });
  run.write("NBF-1", { kind: "working", reason: "the capture runs", waitingOn: [{ fleetJob: "fj-1" }], until: new Date(T0 + 5 * MIN).toISOString() });
  run.status.set(herdrName("NBF-1"), "idle");
  run.herdr.screens.set("w2:p1", "> \n  ⏵⏵ bypass permissions on · 1 shell");
  run.status.set(herdrName("NBF-2"), "idle");
  for (let i = 0; i < 8; i += 1) await run.advance(MIN);
  assert.equal(run.entry("NBF-1").working?.woke?.why, "late", "NBF-1 was woken once at its deadline");
  const before = [run.prompts("w1:p1").length, run.prompts("w2:p1").length];
  const next = run.restart({ restartReads: { bootId: () => "boot-1", herdrStart: () => "1" } });
  await next.tick();
  assert.deepEqual([run.prompts("w1:p1").length, run.prompts("w2:p1").length], before, "the instance's start sends neither a prompt");
});

test("A11-279: a run whose workspace came back under a new id is reached at its new pane, and one whose workspace is still listed keeps its own", async () => {
  const run = await liveRuns(["NBF-1", "NBF-2"]);
  // herdr restored NBF-1 in a new workspace: the label is listed there, and its old one is gone.
  const label = herdrName("NBF-1");
  const status = run.status.get(label)!;
  run.status.delete(label);
  run.status.set("t-nbf-31", status);
  const listing = run.herdr.run;
  const moved = (args: string[]): string => {
    const out = listing(args);
    if (!(args.includes("workspace") && args.includes("list"))) return out;
    const parsed = JSON.parse(out);
    for (const w of parsed.result.workspaces) if (w.label === "t-nbf-31") w.label = label;
    return JSON.stringify(parsed);
  };
  const next = run.restart({ herdr: moved, restartReads: { bootId: () => "boot-1", herdrStart: () => "2" } });
  run.status.set("t-nbf-31", "idle");
  run.herdr.screens.set("w31:p1", INTERRUPTED);
  await next.tick();
  assert.deepEqual([run.entry("NBF-1").workspace, run.entry("NBF-1").pane], ["w31", "w31:p1"]);
  assert.deepEqual([run.entry("NBF-2").workspace, run.entry("NBF-2").pane], ["w2", "w2:p1"]);
  assert.equal(run.resumes("w31:p1").length, 1, "the resume reaches the agent where it is now");
});

test("A11-279: a restart read that fails once keeps the record, so the next good read is no restart", () => {
  const made = poolFixture();
  let herdr: string | null = "1";
  const ctx = newPoolContext(made.store, { settings: made.settings, source: { assigned: async () => [], read: async () => { throw new Error("unused"); }, download: async () => [] }, codeHost: {} as never, hook: { node: "n", bin: "b" },
    restartReads: { bootId: () => "boot-1", herdrStart: () => herdr } });
  assert.equal(readRestart(ctx), "instance");
  herdr = null;
  assert.equal(readRestart(ctx), null);
  herdr = "1";
  assert.equal(readRestart(ctx), null, "the service manager timed out once: herdr did not restart");
});

test("A11-279: the runs one restart lost are queued again at the front in the order the queue held them", async () => {
  const made = poolFixture({ keys: ["NBF-1", "NBF-2", "NBF-3", "NBF-4"], max: 2 });
  await made.pool.tick();
  const lost = loseInRestart(loseInRestart(made.store.get(), "NBF-1", 500), "NBF-2", 500);
  assert.deepEqual(lost.entries.map((e) => [e.ticket.key, e.phase]), [["NBF-1", "queued"], ["NBF-2", "queued"], ["NBF-3", "queued"], ["NBF-4", "queued"]]);
  const later = loseInRestart(made.store.get(), "NBF-2", 600);
  assert.equal(later.entries[0].ticket.key, "NBF-2", "a later restart's lost run goes first");
});

test("A11-279: a run stopped and queued again drops its idle clock and resume, and its next brief is not told of an older loss", async () => {
  const made = poolFixture({ keys: ["NBF-1"] });
  await made.pool.tick();
  const resumed = replace(made.store.get(), "NBF-1", (entry) => ({ ...entry, idleSince: 1, resume: { at: 2, after: "restart" } }));
  const requeued = find(requeueForUpdate(resumed, "NBF-1", "v0.300.0", 900), "NBF-1")!;
  assert.deepEqual([requeued.phase, requeued.idleSince, requeued.resume], ["queued", undefined, undefined]);
  const lost = find(loseInRestart(made.store.get(), "NBF-1", 500), "NBF-1")!;
  assert.equal(lostBeforeThisStart(lost), 500, "the queueing the loss made is told of it");
  assert.equal(lostBeforeThisStart({ ...lost, queuedAt: 900 }), undefined, "a later queueing of the same run is not");
});

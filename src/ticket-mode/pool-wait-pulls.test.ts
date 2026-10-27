// no-token: gh -- herdr, the tracker, the code host and the clock are injected; the hook's record is a file in the run's own state folder
// A11-358: a run whose worker wrote `working` and waits on a pull request that is blocked is told of it at once, not at its `until`; the pull requests a run opened are its own and watched; a review that stands for an hour reads Needs you
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeCodeHost, fakePullUrl } from "../plugins/fakes/code-host.ts";
import { poolFixture } from "./pool-fixture.ts";
import { herdrName } from "./pool.ts";
import { ticketDir } from "./ticket-paths.ts";
import { runStatus } from "./board-view/pull-status-and-notes.ts";
import { openPulls, pullsOf } from "./board-view/view-types-and-filters.ts";
import { listedOpenPulls } from "./board-view/listed-pulls.ts";
import { requeuesOnLoss } from "./queue/queue-readopt.ts";
import { OPENED_FILE, READY_FILE } from "./worker-files.ts";
import type { PullFeedback } from "../plugins/contracts/code-host.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";

const NAME = herdrName("NBF-1");
const PANE = "w1:p1";
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 27, 10, 0, 0);
const TOOLCHAIN = "a11ign/toolchain";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const CHANGES: Partial<PullFeedback> = { verdictAtHead: "changes-requested" };
/** The reason a run ended `needs-human` with, or "" for a run that ended any other way. */
const reasonOf = ({ outcome }: Entry): string => (outcome?.kind === "needs-human" ? outcome.reason : "");

/** NBF-1 as the board holds it once its worker wrote `working` and went idle: a pool over a code host that holds toolchain#60, and the clock a test moves. `waits` is what the worker declared, `until` when. */
async function waitingRun({ waits, until = "2026-10-28T10:00:00Z", feedback = {}, state = "open", refusePrompts = false, tickets = {} }: { waits?: readonly object[]; until?: string; feedback?: Partial<PullFeedback>; state?: "open" | "merged"; refusePrompts?: boolean; tickets?: Record<string, unknown> } = {}) {
  let clock = T0;
  const host = createFakeCodeHost();
  const { url } = host.seedPull(TOOLCHAIN, 60, { feedback, state });
  const refusal = { on: refusePrompts, attempts: 0 };
  const made = poolFixture({ now: () => clock, tickets });
  const throwing = (args: string[]) => {
    if (refusal.on && args.includes("prompt")) {
      refusal.attempts += 1;
      throw new Error("herdr refused the prompt");
    }
    return made.herdr.run(args);
  };
  const pool = made.restart({ codeHost: host, herdr: throwing });
  await pool.tick();
  made.status.set(NAME, "working");
  await pool.tick();
  const file = join(ticketDir(made.settings, "NBF-1"), "outcome.json");
  const write = async (outcome: Record<string, unknown>) => {
    writeFileSync(file, JSON.stringify(outcome));
    utimesSync(file, new Date(clock), new Date(clock));
    made.status.set(NAME, "idle");
    await pool.tick();
    await flush();
  };
  await write({ kind: "working", reason: `waits for ${url}`, waitingOn: waits ?? [{ pullRequest: url, until: "merged" }], until });
  const prompts = () => made.herdr.calls.filter((args) => args.includes("prompt") && args.includes(PANE)).map((args) => String(args.at(-1)));
  const pass = async (ms = MIN) => { clock += ms; await pool.tick(); await flush(); };
  const passes = async (count: number, ms = MIN) => { for (let i = 0; i < count; i += 1) await pass(ms); };
  const pull = host.pullAt(url)!;
  return { ...made, host, url, pull, refusal, write, prompts, pass, passes, dir: ticketDir(made.settings, "NBF-1"), run: () => made.entry("NBF-1") };
}

test("A11-358: a changes-requested review on a pull request the run waits on to merge reaches the worker at once, not at its until", async () => {
  const run = await waitingRun({ feedback: CHANGES });
  await run.passes(3);
  assert.equal(run.prompts().length, 1, "exactly one prompt, well before the day-long until");
  assert.match(run.prompts()[0], /^A pull request you wait on or opened needs you: a11ign\/toolchain #60 has a review asking for changes on its current head\. /);
  assert.equal(run.run().phase, "running", "the run goes on: the worker is asked to act, nothing is ended");
  assert.equal(run.run().working?.fed?.[run.url]?.sig, "head-60|changes", "and the board records what it told, by head");
});

test("A11-358: a review that arrives while the worker waits is told on the next read, and a clean pull request tells nothing", async () => {
  const run = await waitingRun();
  await run.passes(3);
  assert.deepEqual(run.prompts(), [], "nothing is wrong with it: nothing is sent, and the wait is still the worker's");
  run.pull.feedback = CHANGES;
  await run.passes(2);
  assert.equal(run.prompts().length, 1);
  assert.equal(run.run().working?.waits?.length, 1, "the worker's declared wait is untouched");
});

test("A11-358: a red required check and a conflict on the pull request are told too, with the check's name", async () => {
  const red = await waitingRun({ feedback: { failing: ["gate"], failures: [{ name: "gate", detailsUrl: null }] } });
  await red.passes(3);
  assert.match(red.prompts()[0], /a11ign\/toolchain #60 has failing required checks \(gate\)\. /);
  const conflicting = await waitingRun({ feedback: { conflicting: true } });
  await conflicting.passes(3);
  assert.match(conflicting.prompts()[0], /a11ign\/toolchain #60 conflicts with its base\. /);
  const all = await waitingRun({ feedback: { ...CHANGES, conflicting: true, failing: ["gate"] } });
  await all.passes(3);
  assert.match(all.prompts()[0], /has a review asking for changes on its current head and has failing required checks \(gate\) and conflicts with its base\. /);
});

test("A11-358: the same trouble at the same head is told once, a new head with trouble is told again, and a pull request clear of it drops the record", async () => {
  const run = await waitingRun({ feedback: CHANGES });
  await run.passes(10);
  assert.equal(run.prompts().length, 1, "ten minutes of the same review at the same head: one prompt");
  run.pull.head = "head-61";
  await run.passes(2);
  assert.equal(run.prompts().length, 2, "pushed, and reviewed again at the new head: told again");
  run.pull.feedback = {};
  await run.passes(2);
  assert.equal(run.run().working?.fed, undefined, "clear of it: nothing is recorded");
  assert.equal(run.prompts().length, 2);
});

test("A11-358: a worker that declares the same wait again is not told of the same review again", async () => {
  const run = await waitingRun({ feedback: CHANGES });
  await run.passes(3);
  assert.equal(run.prompts().length, 1);
  await run.pass();
  await run.write({ kind: "working", reason: "still waits", waitingOn: [{ pullRequest: run.url, until: "merged" }], until: "2026-10-28T11:00:00Z" });
  await run.passes(5);
  assert.equal(run.prompts().length, 1, "the newer note keeps what was told");
});

test("A11-358: a merged pull request is the wait's own end and a review the wait ends on is the wait's, so neither is told by this watch", async () => {
  const merged = await waitingRun({ feedback: CHANGES, state: "merged" });
  await merged.passes(3);
  assert.ok(!merged.prompts().some((prompt) => prompt.startsWith("A pull request you wait on or opened needs you")), "a merged pull request has no trouble to tell");
  const reviewed = await waitingRun({ feedback: CHANGES, waits: [{ pullRequest: fakePullUrl(TOOLCHAIN, 60), until: "reviewed" }] });
  await reviewed.passes(3);
  assert.ok(!reviewed.prompts().some((prompt) => prompt.startsWith("A pull request you wait on or opened needs you")), "the review is what that wait waits for: the wait wakes the worker with it");
  const checks = await waitingRun({ feedback: { ...CHANGES, failing: ["gate"] }, waits: [{ pullRequest: fakePullUrl(TOOLCHAIN, 60), until: "reviewed" }] });
  await checks.passes(3);
  assert.match(checks.prompts()[0], /#60 has failing required checks \(gate\)\. /, "but its red check is still the worker's to hear of");
  assert.doesNotMatch(checks.prompts()[0], /asking for changes/);
});

test("A11-358: a run that waits on something else, or whose worker works, is not told", async () => {
  const session = await waitingRun({ waits: [{ session: "run the check" }], feedback: CHANGES });
  await session.passes(3);
  assert.deepEqual(session.prompts(), [], "a pull request the run neither waits on nor opened is none of this watch's");
  const busy = await waitingRun();
  busy.status.set(NAME, "working");
  busy.pull.feedback = CHANGES;
  await busy.passes(3);
  assert.deepEqual(busy.prompts(), [], "a worker at work is not interrupted");
  busy.status.set(NAME, "idle");
  await busy.passes(2);
  assert.equal(busy.prompts().length, 1, "POSITIVE CONTROL: the same review is told once it sits idle");
});

test("A11-358: a pull request the run opened in another repository is added to its pull requests and watched, whatever its outcome lists", async () => {
  const run = await waitingRun({ waits: [{ session: "nothing to do with the pull request" }], feedback: CHANGES });
  assert.deepEqual(run.run().opened, undefined, "before the hook records it, the board knows none");
  writeFileSync(join(run.dir, OPENED_FILE), `${JSON.stringify({ repo: TOOLCHAIN, url: run.url })}\n`);
  await run.passes(3);
  assert.deepEqual(run.run().opened, [{ repo: TOOLCHAIN, url: run.url }], "recorded on the run");
  assert.equal(run.prompts().length, 1, "and its review reaches the worker");
  assert.match(run.prompts()[0], /#60 has a review asking for changes/);
  await run.passes(3);
  assert.equal(run.run().opened?.length, 1, "recorded once");
  const listed = { ...run.run(), outcome: { kind: "ready-pr", prs: [{ repo: "a11ign/lab", url: fakePullUrl("a11ign/lab", 159) }] } } as unknown as Parameters<typeof pullsOf>[0];
  assert.deepEqual(pullsOf(listed).map(({ url }) => url), [fakePullUrl("a11ign/lab", 159), run.url], "when the run ends listing only another, the opened one stays among its pull requests");
  const both = { ...run.run(), outcome: { kind: "ready-pr", prs: [{ repo: TOOLCHAIN, url: run.url }] } } as unknown as Parameters<typeof pullsOf>[0];
  assert.deepEqual(pullsOf(both).map(({ url }) => url), [run.url], "and one the outcome lists too is listed once");
});

test("A11-358: a changes-requested review that stands for an hour with the worker idle reads Needs you, naming that it was told and did not push", async () => {
  const run = await waitingRun({ feedback: CHANGES });
  await run.passes(2);
  assert.equal(run.run().phase, "running");
  await run.passes(57);
  assert.equal(run.run().phase, "running", "59 minutes have not made an hour");
  await run.passes(2);
  const ended = run.run();
  assert.equal(ended.phase, "finished");
  assert.equal(ended.outcome?.kind, "needs-human");
  assert.equal(runStatus(ended), "needs-you");
  assert.match(reasonOf(ended), /a11ign\/toolchain #60 has had a review asking for changes since 10:00Z, and the run is idle waiting on it: its worker was told at 10:00Z and has not pushed/);
});

test("A11-358: when the worker cannot be told, the hour ends Needs you naming the refusal, and the prompt is offered again meanwhile", async () => {
  const run = await waitingRun({ feedback: CHANGES, refusePrompts: true });
  await run.passes(5);
  assert.ok(run.refusal.attempts >= 5, "a refused prompt is offered again on every read");
  assert.equal(run.run().phase, "running");
  run.refusal.on = false;
  await run.pass();
  assert.equal(run.prompts().length, 1, "and delivered once herdr takes it");
  await run.passes(3);
  assert.equal(run.prompts().length, 1, "once delivered, it is not sent again");
  const stuck = await waitingRun({ feedback: CHANGES, refusePrompts: true });
  await stuck.passes(61);
  assert.equal(stuck.run().phase, "finished");
  assert.match(reasonOf(stuck.run()), /its worker could not be told \(.*herdr refused the prompt.*\)/);
});

test("A11-358: a worker that pushes a fix within the hour is never sent to Needs you", async () => {
  const run = await waitingRun({ feedback: CHANGES });
  await run.passes(30);
  run.pull.head = "head-61";
  run.pull.feedback = {};
  await run.passes(40);
  assert.equal(run.run().phase, "running");
});

test("A11-358: a run on a machine with drafts off is given the ready mark in a round that answers feedback too, and a machine that keeps drafts is not", async () => {
  const round = async (tickets: Record<string, unknown>) => {
    const clock = { ms: T0 };
    const fixture = poolFixture({ keys: ["NBF-1"], tickets, now: () => clock.ms });
    const host = createFakeCodeHost();
    const { url } = host.seedPull(TOOLCHAIN, 60, { feedback: { feedbackAt: T0 + MIN, authors: ["alice"] } });
    const opened = { repo: "a11ign/lab", url: fakePullUrl("a11ign/lab", 159) };
    host.seedPull("a11ign/lab", 159);
    const queue = fixture.store.get();
    fixture.store.set({ ...queue, entries: [{ ...queue.entries[0], phase: "finished", finishedAt: T0, outcome: { kind: "ready-pr", prs: [{ repo: TOOLCHAIN, url }] }, pullStates: { [url]: "open" }, opened: [opened] }] });
    const pool = fixture.restart({ codeHost: host });
    clock.ms += 5 * MIN;
    pool.watchFeedback();
    await pool.tick();
    await flush();
    const entry = fixture.store.get().entries[0];
    const dir = ticketDir(fixture.settings, "NBF-1");
    return { entry, ready: existsSync(join(dir, READY_FILE)), record: existsSync(join(dir, OPENED_FILE)) ? readFileSync(join(dir, OPENED_FILE), "utf8") : null, opened };
  };
  const off = await round({ drafts: false });
  assert.ok(off.entry.review !== undefined && off.entry.rounds === 1, "the round is a review round: the worker answers the feedback");
  assert.equal(off.ready, true, "and it may open a pull request ready, and mark its own ready");
  assert.equal(off.record, `${JSON.stringify(off.opened)}\n`, "and the hook is given the pull requests the run opened before, so the round may mark one ready by its URL");
  const on = await round({});
  assert.equal(on.ready, false, "a machine that keeps drafts gives no mark");
});

test("A11-358: a read of the pull request that fails neither tells the worker again nor starts the hour over", async () => {
  const run = await waitingRun({ feedback: CHANGES });
  await run.passes(2);
  const record = run.run().working?.fed?.[run.url];
  assert.equal(run.prompts().length, 1);
  const read = run.host.readPullFeedback;
  run.host.readPullFeedback = () => null;
  await run.passes(3);
  assert.deepEqual(run.run().working?.fed?.[run.url], record, "the record the board had is kept while the host cannot be asked");
  run.host.readPullFeedback = read;
  await run.passes(3);
  assert.equal(run.prompts().length, 1, "and the same review is not told again once the host answers");
  assert.deepEqual(run.run().working?.fed?.[run.url], record, "nor does its clock restart");
});

test("A11-358: the pull requests a run opened are watched, but are not the ones a person approved, and a run lost in a restart that had opened one is still queued again", () => {
  const lab = { repo: "a11ign/lab", url: fakePullUrl("a11ign/lab", 159) };
  const listed = { repo: TOOLCHAIN, url: fakePullUrl(TOOLCHAIN, 60) };
  const entry = { outcome: { kind: "draft-pr", prs: [listed] }, opened: [lab] } as unknown as Entry;
  assert.deepEqual(openPulls(entry).map(({ url }) => url), [listed.url, lab.url], "watched");
  assert.deepEqual(listedOpenPulls(entry).map(({ url }) => url), [listed.url], "but Approve, and the review run's mark to ready them, name only what the outcome lists");
  const running = { phase: "running", opened: [lab] } as unknown as Entry;
  assert.equal(requeuesOnLoss(running), true, "a run lost in a restart is queued again, as before it opened one: its brief lists the ticket's pull requests");
});

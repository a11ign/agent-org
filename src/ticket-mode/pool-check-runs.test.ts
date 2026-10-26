// no-token: gh -- herdr, git, the tracker, the clock and the restart reads are all injected; nothing is spawned
// A11-302: the board starts a verifier run for an `agent` check once its change is installed, closes the check with the run's result and files a failure's follow-up, and a one-time pass gives the checks a session ran a runner of the org's
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterMergeChecksPath, loadChecks, saveChecks } from "./after-merge/store.ts";
import type { CheckRecord } from "./after-merge/checks.ts";
import { MAX_BOARD_CHECK_RUNS, MAX_RUN_TRIES, MIGRATION_BATCH } from "./after-merge/verify.ts";
import { herdrName } from "./pool.ts";
import { poolFixture } from "./pool-fixture.ts";
import { writersViewOf } from "./read-routes.ts";
import { writerDir } from "./ticket-paths.ts";
import type { Queue } from "./queue/queue-entries-and-outcomes.ts";
import type { RunEvent } from "./queue/run-log.ts";

const HOUR = 60 * 60_000;
const LINE = "On the agents host after the release, the doctor shows one version.";
const EVIDENCE = "run the doctor on the host and quote the version line";

const settledAll = async (): Promise<void> => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

const check = (id: string, over: Partial<CheckRecord> = {}): CheckRecord => ({
  id, key: id.split("#")[0], url: `https://linear.app/a11ign/issue/${id.split("#")[0]}`, line: LINE, owner: null, runner: "agent", evidence: EVIDENCE, listedAt: 1_000, state: "open", ...over,
});

/** A pool over fakes whose clock `clock.at` the test moves, whose host names a ticket writer, and whose checks file holds `checks`; the queue's run log says which pull requests merged. */
function world(checks: readonly CheckRecord[], { writer = true, merged = {} }: { writer?: boolean; merged?: Record<string, readonly RunEvent[]> } = {}) {
  const clock = { at: 10 * HOUR };
  const made = poolFixture({ keys: [], max: 3, now: () => clock.at, tickets: writer ? { writer: { run: "Run the a11ign:create-ticket skill for this request: {request}, in {dir}." } } : {} });
  const path = afterMergeChecksPath(made.settings.stateDir);
  saveChecks(path, { checks: Object.fromEntries(checks.map((one) => [one.id, one])) });
  made.store.set({ ...made.store.get(), runLog: merged });
  const writers = () => made.store.get().writers ?? [];
  const run = (id: string) => writers().find((one) => one.id === id)!;
  const sweep = async () => { await made.pool.refreshTracker(); await settledAll(); };
  const tick = async () => { await made.pool.tick(); await settledAll(); };
  const dirOf = (id: string) => writerDir(made.settings, id);
  /** The agent of run `id` writes `outcome` and goes idle, and the pool reads it. */
  const answers = async (id: string, outcome: Record<string, unknown>) => {
    writeFileSync(join(dirOf(id), "outcome.json"), JSON.stringify(outcome));
    made.status.set(herdrName(`writer-${id}`), "working");
    await tick();
    made.status.set(herdrName(`writer-${id}`), "idle");
    await tick();
  };
  return { ...made, clock, path, writers, run, sweep, tick, dirOf, answers, checks: () => loadChecks(path).checks };
}

const MERGED_AT = 10 * HOUR - 2 * HOUR;
const mergedOther = (key: string): Record<string, readonly RunEvent[]> => ({ [key]: [{ kind: "merged", url: "https://github.com/a11ign/control/pull/9", at: MERGED_AT }] });

test("A11-302: an agent check whose change is installed is given to a verifier run on Sonnet that carries the check's line and evidence spec; one whose change is not installed waits", async () => {
  const board = world([check("A11-310#1"), check("A11-311#1")], { merged: { ...mergedOther("A11-310"), "A11-311": [{ kind: "merged", url: "https://github.com/a11ign/control/pull/10", at: 10 * HOUR - 5 * 60_000 }] } });
  await board.sweep();
  assert.deepEqual(board.writers().map(({ mode, checks, model, effort }) => [mode, checks, model, effort]), [["verify", ["A11-310#1"], "sonnet", "medium"]], "A11-311 merged five minutes ago: not installed yet");
  assert.equal(board.checks()["A11-310#1"].verifier?.tries, 1);
  assert.equal(board.checks()["A11-311#1"].verifier, undefined);
  await board.tick();
  const [started] = board.writers();
  assert.equal(started.phase, "running", "the board started the run");
  const brief = readFileSync(join(board.dirOf(started.id), "brief.md"), "utf8");
  assert.match(brief, /# Verify an After-merge check: A11-310#1/);
  assert.ok(brief.includes(`> ${LINE}`), "the line is quoted");
  assert.ok(brief.includes(EVIDENCE), "and the plan's evidence spec");
  assert.match(brief, /A11-310 \(https:\/\/linear\.app\/a11ign\/issue\/A11-310\)/);
  assert.deepEqual(JSON.parse(readFileSync(join(board.dirOf(started.id), "writer-run"), "utf8")), { mode: "verify", tools: [] }, "it may file no ticket");
  assert.ok(board.herdr.calls.some((args) => args.includes("--model") && args[args.indexOf("--model") + 1] === "sonnet"), "the agent starts on Sonnet");
  board.clock.at += 2 * HOUR;
  await board.sweep();
  assert.equal(board.writers().length, 2, "once A11-311's change is installed it is given to a run too");
});

test("A11-302: a verifier run that records passed closes its check with the evidence, through the after-merge route, and files no follow-up", async () => {
  const board = world([check("A11-310#1")], { merged: mergedOther("A11-310") });
  await board.sweep();
  await board.tick();
  const id = board.writers()[0].id;
  await board.answers(id, { kind: "passed", evidence: "the doctor on the host shows 0.5.0 on every line (14:02)" });
  const done = board.checks()["A11-310#1"];
  assert.deepEqual([done.state, done.result, done.closedBy, done.closedAt], ["passed", "the doctor on the host shows 0.5.0 on every line (14:02)", "agent", 10 * HOUR]);
  assert.equal(board.run(id).phase, "finished");
  assert.equal(board.run(id).failure, undefined);
  await board.sweep();
  assert.equal(board.writers().length, 1, "a pass starts no follow-up");
  assert.equal(done.followUp, undefined);
});

test("A11-302: a verifier run that records failed closes its check failed, and the board files the follow-up through the ticket writer", async () => {
  const board = world([check("A11-310#1")], { merged: mergedOther("A11-310") });
  await board.sweep();
  await board.tick();
  const id = board.writers()[0].id;
  await board.answers(id, { kind: "failed", evidence: "the doctor still reports 0.4.1 on the second host" });
  const failed = board.checks()["A11-310#1"];
  assert.deepEqual([failed.state, failed.result, failed.closedBy], ["failed", "the doctor still reports 0.4.1 on the second host", "agent"]);
  await board.sweep();
  const followUp = board.writers().find((one) => one.mode === "quick")!;
  assert.ok(followUp !== undefined, "a follow-up request is queued for the ticket writer");
  assert.equal(followUp.request, ["Follow-up to A11-310: its after-merge check failed.", "", `The check: ${LINE}`, "What was seen: the doctor still reports 0.4.1 on the second host", "", "Related: A11-310."].join("\n"));
  assert.equal(board.checks()["A11-310#1"].followUp, followUp.id, "the check records the request that follows it up");
  await board.sweep();
  assert.equal(board.writers().filter((one) => one.mode === "quick").length, 1, "decided once");
});

test("A11-302: a failed check with no ticket writer on the machine keeps its follow-up undecided, and says so on the ticket", async () => {
  const board = world([check("A11-310#1")], { writer: false, merged: mergedOther("A11-310") });
  await board.sweep();
  await board.tick();
  await board.answers(board.writers()[0].id, { kind: "failed", evidence: "nothing shows it" });
  await board.sweep();
  assert.deepEqual([board.checks()["A11-310#1"].state, board.checks()["A11-310#1"].followUp], ["failed", undefined]);
});

test("A11-302: a verifier run that ends with no usable result is tried again, and after the last try its check is closed failed, saying how the last ended", async () => {
  const board = world([check("A11-310#1")], { merged: mergedOther("A11-310") });
  await board.sweep();
  for (let attempt = 1; attempt <= MAX_RUN_TRIES; attempt += 1) {
    await board.tick();
    const live = board.writers().find((one) => one.mode === "verify" && one.phase === "running")!;
    assert.equal(board.checks()["A11-310#1"].verifier?.tries, attempt);
    await board.answers(live.id, { kind: "perhaps", evidence: "x" });
    assert.match(board.run(live.id).failure ?? "", /a verifier run ends on "passed", "failed" or "superseded", not "perhaps"/);
    await board.sweep();
  }
  const closed = board.checks()["A11-310#1"];
  assert.deepEqual([closed.state, closed.closedBy], ["failed", "board"]);
  assert.match(closed.result ?? "", /^the verifier run ended without a result after 2 tries: a verifier run ends on "passed", "failed" or "superseded", not "perhaps"$/);
  assert.equal(board.writers().filter((one) => one.mode === "verify").length, MAX_RUN_TRIES, "no third run");
});

test("A11-302: a verifier run over its limit is ended, and a superseded result closes the check superseded with the reason", async () => {
  const board = world([check("A11-310#1"), check("A11-312#1")], { merged: { ...mergedOther("A11-310"), ...mergedOther("A11-312") } });
  await board.sweep();
  await board.tick();
  const [first, second] = board.writers();
  await board.answers(first.id, { kind: "superseded", evidence: "that machine is no longer in use" });
  assert.deepEqual([board.checks()["A11-310#1"].state, board.checks()["A11-310#1"].result], ["superseded", "that machine is no longer in use"]);
  board.clock.at += 31 * 60_000;
  await board.tick();
  assert.match(board.run(second.id).failure ?? "", /^it did not finish within 30 minutes$/);
});

test("A11-302: at most two check runs are unfinished at once, and a check run is not a new-ticket request", async () => {
  const many = Array.from({ length: 5 }, (_, index) => check(`A11-33${index}#1`));
  const board = world(many, { merged: Object.fromEntries(many.map((one) => [one.key, mergedOther(one.key)[one.key]])) });
  await board.sweep();
  assert.equal(board.writers().length, MAX_BOARD_CHECK_RUNS);
  assert.deepEqual(writersViewOf(board.store.get() as Queue).runs, [], "the Runs page lists no new-ticket request for them");
  assert.equal(board.store.get().writers!.length, 2);
});

// --- THE ONE-TIME MIGRATION ---

const legacy = (id: string, over: Partial<CheckRecord> = {}): CheckRecord => check(id, { runner: "session", owner: "Chairman session", line: `Chairman session: ${id} line.`, evidence: undefined, ...over });

test("A11-302: the checks left on the session runner are given to one planner pass, which rewrites one as a board check and supersedes another", async () => {
  const board = world([legacy("A11-294#1", { line: "Chairman session: no `lost in a restart` crash for a starting run in the run log for a week." }), legacy("A11-225#1"), check("A11-310#1", { runner: "person" }), check("A11-320#1")]);
  await board.sweep();
  const [pass] = board.writers();
  assert.deepEqual([pass.mode, pass.checks], ["migrate", ["A11-294#1", "A11-225#1", "A11-310#1"]], "the session's, and a person's on no item of the list; not the agent's");
  assert.equal(board.checks()["A11-294#1"].migrating?.tries, 1);
  await board.tick();
  const brief = readFileSync(join(board.dirOf(pass.id), "brief.md"), "utf8");
  assert.match(brief, /# Migrate 3 After-merge checks/);
  assert.ok(brief.includes("`A11-294#1`") && brief.includes("recorded runner: session, owner: Chairman session"));
  assert.ok(brief.includes("run-log <event kind> [<text>]"), "the sources are in the brief");
  assert.deepEqual(JSON.parse(readFileSync(join(board.dirOf(pass.id), "writer-run"), "utf8")), { mode: "migrate", tools: [] });
  await board.answers(pass.id, { kind: "migrated", checks: [
    { id: "A11-294#1", runner: "board", observe: "run-log finished \"lost in a restart\"", pass: "absent", window: "7d", evidence: "the run log of every ticket, quoted if a run was lost" },
    { id: "A11-225#1", runner: "superseded", reason: "the laptop is not in use, so its onboarding is not run" },
    { id: "A11-310#1", runner: "person", escalation: "legal", evidence: "the person's choice, recorded on the ticket" },
  ] });
  const checks = board.checks();
  assert.deepEqual([checks["A11-294#1"].runner, checks["A11-294#1"].observe, checks["A11-294#1"].evidence, checks["A11-294#1"].migrated], [
    "board", { spec: { kind: "run-log", event: "finished", match: "lost in a restart", pass: "absent", windowMs: 7 * 24 * HOUR }, from: 10 * HOUR }, "the run log of every ticket, quoted if a run was lost", { from: "session", at: 10 * HOUR },
  ], "a session check is now a board check, its watch beginning now");
  assert.deepEqual([checks["A11-225#1"].state, checks["A11-225#1"].result, checks["A11-225#1"].closedBy], ["superseded", "the laptop is not in use, so its onboarding is not run", "board"], "and another is superseded with its reason");
  assert.deepEqual([checks["A11-310#1"].runner, checks["A11-310#1"].escalation], ["person", "legal"], "a person's check keeps its item");
  assert.equal(board.run(pass.id).phase, "finished");
  await board.sweep();
  assert.equal(board.writers().filter((one) => one.mode === "migrate").length, 1, "the pass runs once: nothing is left to migrate");
});

test("A11-302: a migration pass that does not answer a check, or ends with a bad outcome, is run again, and after the last pass its checks are given to an agent", async () => {
  const board = world([legacy("A11-294#1"), legacy("A11-225#1")]);
  await board.sweep();
  await board.tick();
  const first = board.writers()[0];
  await board.answers(first.id, { kind: "migrated", checks: [{ id: "A11-294#1", runner: "agent", evidence: "do what the line says and quote it" }, { id: "A11-999#1", runner: "agent", evidence: "x" }] });
  assert.deepEqual([board.checks()["A11-294#1"].runner, board.checks()["A11-225#1"].runner], ["agent", "session"], "the answered check moved; a check the pass was not given is not touched");
  assert.equal(board.checks()["A11-999#1"], undefined);
  await board.sweep();
  await board.tick();
  const second = board.writers().find((one) => one.mode === "migrate" && one.phase === "running")!;
  assert.deepEqual(second.checks, ["A11-225#1"], "the second pass is for the check the first left");
  await board.answers(second.id, { kind: "migrated", checks: [{ id: "A11-225#1", runner: "board", evidence: "x" }] });
  assert.match(board.run(second.id).failure ?? "", /is the board's and its observe spec is missing/, "a bad entry refuses the whole outcome");
  await board.sweep();
  const given = board.checks()["A11-225#1"];
  assert.deepEqual([given.runner, given.migrated?.from, given.state], ["agent", "session", "open"], "no check is left on a runner that no longer exists");
  assert.equal(board.writers().filter((one) => one.mode === "migrate").length, MAX_RUN_TRIES);
});

test("A11-302: a migration pass is given at most ten checks, and its entries are held to the plan check's rules", async () => {
  const many = Array.from({ length: MIGRATION_BATCH + 3 }, (_, index) => legacy(`A11-4${String(index).padStart(2, "0")}#1`, { listedAt: 1_000 + index }));
  const board = world(many);
  await board.sweep();
  assert.deepEqual(board.writers().map((one) => one.checks?.length), [MIGRATION_BATCH, 3]);
  await board.tick();
  const [pass] = board.writers();
  await board.answers(pass.id, { kind: "migrated", checks: [{ id: "A11-400#1", runner: "session", evidence: "x" }] });
  assert.match(board.run(pass.id).failure ?? "", /has the runner "session", which is no runner/, "the pass cannot put a check back on the session");
});

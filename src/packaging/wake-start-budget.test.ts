// no-token: gh -- every `herdr` and `git` call here is an injected seam; nothing imported reaches the real one
/**
 * `wake.ts`, agent-org#1025: THE SPAWNS OF ONE TICK SHARE A START BUDGET, AND THE COST LINE NAMES `agent start`.
 *
 * Measured: a tick of 402 s whose `wake` phase took 266 s, three `herdr --session org agent start` calls at 30,024, 30,030 and 30,031 ms (the
 * `timeout: 30_000` of `defaultRun`, not three slow starts), filed with 72 cheap `agent list` / `agent read` calls under one name, `herdr org agent`.
 *
 * DRIVEN THROUGH `deliver`, the production entry, with a herdr whose `agent start` advances an injected clock by what the start "takes". THE CONTROLS
 * ARE FIRST: a fast start is started (the budget does not refuse the ordinary case), and a deferred order is still offered by the next tick (it was
 * not dropped). Three chairman rows (`startFresh`) are the case: they are the starts `MAX_SPAWNS_PER_TICK` does not hold.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deliver as settlingDeliver, refusalReport, startBudgetDeferrals, START_BUDGET_MS } from "../wake.ts";
import { describeSpawn, summariseCensus } from "../lib/spawn-census.ts";
import { startedPanes } from "./started-pane.ts";
import { INSIDE } from "../review-trust.ts";

const deliver: typeof settlingDeliver = (orders, agents, roster, deps) => settlingDeliver(orders, agents, roster, { ...deps, sleep: () => {} });
const agents = (spec: Record<string, string>) => Object.entries(spec).map(([label, status]) => ({ label, status }));
const BUSY = agents({ ceo: "working" });

const chairmanRow = (row: number) => ({
  session: "engineers", cause: "ready-row-unclaimed", causeKey: `engineers/ready-row-unclaimed/${row}`,
  prompt: `Ready row #${row} is unclaimed.`, startFresh: true,
});
const reviewerOrder = {
  session: "reviewer-18", cause: "draft-awaiting-verdict", causeKey: "reviewer-18/draft-awaiting-verdict/pr-18/abc12345",
  prompt: "Draft #18 is green with no verdict at its head.", trust: INSIDE,
};
const promptToCeo = { session: "ceo", cause: "state-reading", causeKey: "ceo/state-reading/1", prompt: "Read the state." };
const checkoutSeams = {
  git: (_cmd: string, args: string[]) => (args.join(" ").includes("rev-parse") ? `${"d".repeat(40)}\n` : ""),
  link: () => null, exists: () => true, root: "/reviews-root", repoRoot: "/primary",
};

/**
 * A herdr whose `agent start` number `n` (from 0) takes `startsTake[n]` ms of the injected clock, and THROWS after that wait when `timeouts` says so --
 * which is what `execFileSync` does at its `timeout`. `now` is the clock `deliver` is handed.
 */
function clockedHerdr(startsTake: number[], { timeouts = false }: { timeouts?: boolean; } = {}) {
  let clock = 1_000_000;
  const calls: string[] = [];
  const pane = startedPanes();
  let starts = 0;
  const run = (args: string[]) => {
    calls.push(args.join(" "));
    if (args.includes("agent") && args[args.indexOf("agent") + 1] === "start") {
      clock += startsTake[starts] ?? 0;
      starts += 1;
      if (timeouts) throw Object.assign(new Error("Command failed: herdr agent start: spawnSync herdr ETIMEDOUT"), { stderr: "" });
      return "{}";
    }
    const answered = pane(args);
    if (answered !== null) return answered;
    if (args.includes("workspace") && args.includes("create")) {
      return JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } });
    }
    return "{}";
  };
  return {
    run, now: () => clock,
    started: () => calls.filter((c) => c.includes("agent start")),
    opened: () => calls.filter((c) => c.includes("workspace create")),
  };
}

const DEFERRED = /; deferred: this tick's agent starts have used their start budget \(\d+ s of the 60 s budget spent on agent starts\): started on the next tick$/;

test("agent-org#1025: the budget is a minute -- written out, so changing the constant turns this red", () => {
  assert.equal(START_BUDGET_MS, 60_000);
});

test("CONTROL: one fast start is started, and nothing is deferred (the budget does not refuse the ordinary case)", () => {
  const herdr = clockedHerdr([200]);
  const got = deliver([chairmanRow(101)], BUSY, [], { run: herdr.run, now: herdr.now });

  assert.deepEqual(got.refused, []);
  assert.match(got.sent[0], /^worker-101 <- engineers\/ready-row-unclaimed\/101 \(STARTED /);
  assert.equal(herdr.started().length, 1);
});

test("DONE-WHEN 1: three starts of 30 s each -- two fit the budget, the third is deferred with its order intact, and the next tick starts it", () => {
  const orders = [chairmanRow(101), chairmanRow(102), chairmanRow(103)];
  const herdr = clockedHerdr([30_000, 30_000, 30_000]);
  const recorded: string[] = [];
  const got = deliver(orders, BUSY, [], { run: herdr.run, now: herdr.now, record: (key) => recorded.push(key) });

  assert.deepEqual(got.sent.map((line) => line.split(" ")[0]), ["worker-101", "worker-102"]);
  assert.equal(herdr.started().length, 2, "POSITIVE: only two `agent start` calls were made");
  assert.equal(herdr.opened().length, 2, "and the deferred one opened no pane to close again");
  assert.equal(got.refused.length, 1);
  assert.ok(got.refused[0].startsWith("engineers/ready-row-unclaimed/103: "), got.refused[0]);
  assert.match(got.refused[0], DEFERRED);
  assert.deepEqual(recorded, ["engineers/ready-row-unclaimed/101", "engineers/ready-row-unclaimed/102"], "the deferred order was NOT written to the ledger, so nothing suppresses it");

  const next = clockedHerdr([30_000]);
  const again = deliver([orders[2]], BUSY, [], { run: next.run, now: next.now });
  assert.deepEqual(again.refused, []);
  assert.match(again.sent[0], /^worker-103 <- engineers\/ready-row-unclaimed\/103 \(STARTED /, "the next tick's budget is its own, and starts the deferred order");
});

test("a start that TIMES OUT spends its wait: two timeouts defer the third, which is the 402 s tick's shape", () => {
  const herdr = clockedHerdr([30_000, 30_000, 30_000], { timeouts: true });
  const got = deliver([chairmanRow(101), chairmanRow(102), chairmanRow(103)], BUSY, [], { run: herdr.run, now: herdr.now });

  assert.equal(herdr.started().length, 2, "POSITIVE: two attempted, not three");
  assert.equal(got.refused.length, 3);
  assert.match(got.refused[0], /herdr refused to start "worker-101"/);
  assert.match(got.refused[1], /herdr refused to start "worker-102"/);
  assert.match(got.refused[2], DEFERRED);
});

test("the boundary: starts that have used 59,999 ms still allow one more, and 60,000 ms does not", () => {
  const under = clockedHerdr([30_000, 29_999, 100]);
  const got = deliver([chairmanRow(101), chairmanRow(102), chairmanRow(103)], BUSY, [], { run: under.run, now: under.now });
  assert.deepEqual(got.refused, []);
  assert.equal(under.started().length, 3);

  const at = clockedHerdr([30_000, 30_000, 100]);
  const held = deliver([chairmanRow(101), chairmanRow(102), chairmanRow(103)], BUSY, [], { run: at.run, now: at.now });
  assert.equal(at.started().length, 2);
  assert.match(held.refused[0], DEFERRED);
});

test("a fast tick is not slowed by a deferral it does not need: many quick starts all start while the sum stays under the budget", () => {
  const herdr = clockedHerdr([1_000, 1_000, 1_000, 1_000]);
  const got = deliver([101, 102, 103, 104].map(chairmanRow), BUSY, [], { run: herdr.run, now: herdr.now });

  assert.deepEqual(got.refused, []);
  assert.equal(got.sent.length, 4);
});

test("a REVIEWER start is held by the same budget, and before its checkout is made", () => {
  const herdr = clockedHerdr([30_000, 30_000, 30_000]);
  const fetched: string[] = [];
  const checkout = { ...checkoutSeams, git: (cmd: string, args: string[]) => { fetched.push(args.join(" ")); return checkoutSeams.git(cmd, args); } };
  const got = deliver([chairmanRow(101), chairmanRow(102), reviewerOrder], BUSY, [], { run: herdr.run, now: herdr.now, checkout });

  assert.equal(got.sent.length, 2);
  assert.match(got.refused[0], /^reviewer-18\/draft-awaiting-verdict\/pr-18\/abc12345: .*; deferred: this tick's agent starts have used their start budget/);
  assert.equal(herdr.started().length, 2);
  assert.deepEqual(fetched, [], "the deferred reviewer fetched nothing and made no worktree");
});

test("CONTROL: a prompt to a LIVE seat is untouched after the budget is spent -- only starts are held", () => {
  const herdr = clockedHerdr([30_000, 30_000]);
  const got = deliver([chairmanRow(101), chairmanRow(102), promptToCeo], agents({ ceo: "idle" }), [], { run: herdr.run, now: herdr.now });

  assert.deepEqual(got.refused, []);
  assert.equal(got.sent.length, 3);
  assert.match(got.sent[2], /^ceo /);
});

test("a deferral is a WAIT, not `nowhere to go`; the same refusal without the phrase is still a fault; the tick's log counts them", () => {
  const herdr = clockedHerdr([30_000, 30_000, 30_000]);
  const { refused } = deliver([chairmanRow(101), chairmanRow(102), chairmanRow(103)], BUSY, [], { run: herdr.run, now: herdr.now });
  const report = refusalReport(refused, (keys) => new Map(keys.map((key) => [key, 5 * 60_000])));

  assert.equal(report.summary, null, "no ATTENTION exit for a start the next tick will make");
  assert.deepEqual(report.undelivered, []);
  assert.equal(report.deferred.length, 1, "POSITIVE: it is reported as DEFERRED, not merely absent from the count");
  assert.match(report.deferred[0], /^engineers\/ready-row-unclaimed\/103: .*\(waiting 5 min; retried next tick\)$/);
  assert.equal(startBudgetDeferrals(refused), 1);

  const fault = "engineers/ready-row-unclaimed/103: no engineer is idle and allowed to claim (); no spawn: the claim did not hold";
  assert.notEqual(refusalReport([fault], () => new Map()).summary, null);
  assert.equal(startBudgetDeferrals([fault]), 0);

  const over = refusalReport(refused, (keys) => new Map(keys.map((key) => [key, 31 * 60_000])));
  assert.match(over.undelivered[0], /over the 30-minute limit for the start budget\)$/, "a start that is deferred for half an hour is a fault after all");
});

// --- THE CENSUS ---

test("the census names `herdr agent start` apart from `agent list` and `agent read`, and the program's total still adds up", () => {
  const spawn = (...words: string[]) => describeSpawn("herdr", ["--session", "org", ...words]);
  assert.equal(spawn("agent", "start", "worker-5067", "--kind", "claude").sub, "agent start");
  assert.equal(spawn("agent", "list").sub, "agent list");
  assert.equal(spawn("agent", "read", "worker-1", "--lines", "40").sub, "agent read");
  assert.equal(describeSpawn("gh", ["-R", "a11ign/x", "pr", "list"]).sub, "pr list", "CONTROL: the other value options are read as before");
  // The program's name is held in a variable: this file spawns nothing, and `git-spawn-classification` reads a literal `f("git"` as a spawn.
  const vcs = "git";
  assert.equal(describeSpawn(vcs, ["-C", "/repo", "rev-parse", "HEAD"]).sub, "rev-parse");

  const records = [
    { ...spawn("agent", "start", "a"), ms: 30_024 }, { ...spawn("agent", "start", "b"), ms: 30_030 },
    { ...spawn("agent", "list"), ms: 120 }, { ...spawn("agent", "list"), ms: 130 }, { ...spawn("agent", "read", "a"), ms: 90 },
  ];
  const { subcommands, commands } = summariseCensus(records);
  assert.deepEqual(subcommands["herdr agent start"], { n: 2, wallMs: 60_054 });
  assert.deepEqual(subcommands["herdr agent list"], { n: 2, wallMs: 250 });
  assert.deepEqual(subcommands["herdr agent read"], { n: 1, wallMs: 90 });
  assert.equal(subcommands["herdr org agent"], undefined, "the value of `--session` is no subcommand");
  assert.deepEqual(commands.herdr, { n: 5, wallMs: 60_394 });
});

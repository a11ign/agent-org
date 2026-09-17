/**
 * `packages/agent-org/src/wake.mjs` -- #912's remaining half: work-gate says there is work, this says who
 * takes it.
 *
 * DRIVEN THROUGH INJECTED SEAMS, never a running org. Every export here takes its `run` or its reader as a
 * parameter, so these tests answer "given these agent states and these orders, who gets woken and what is
 * refused" -- which is this module's whole question. Standing up herdr to ask it would test herdr.
 *
 * The cases that matter are the REFUSALS. A wake that fires is visible immediately; a wake that silently
 * does not is the 2026-09-08 shape the lead-orchestrator brief records, where "every session went idle at
 * 20:52Z and nothing woke anyone for ten" hours.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { route, undelivered, parseOrders, readLedger, deliver, readAgents, WAKEABLE, EXIT }
  from "../wake.mjs";
import { afterGate, GATE, EXIT as TICK_EXIT } from "../work-tick.mjs";
import { spawnInvocation } from "../wake.mjs";

const agents = (spec: Record<string, string>) =>
  Object.entries(spec).map(([label, status]) => ({ label, status }));
const ROSTER = ["worker-capture", "worker-judge", "worker-tooling"];

/** Narrowing that ASSERTS rather than casts -- a wrong shape fails here with the value, not at a cast. */
function refusalText(got: unknown): string {
  assert.ok(got && typeof got === "object" && "refusal" in got, `expected a refusal, got ${JSON.stringify(got)}`);
  return (got as { refusal: string }).refusal;
}
function spawned(got: unknown): { args: string[]; profile: { kind: string; model: string; effort: string } } {
  assert.ok(got && typeof got === "object" && "args" in got, `expected a spawn, got ${JSON.stringify(got)}`);
  return got as { args: string[]; profile: { kind: string; model: string; effort: string } };
}

test("the exit codes match work-gate's polarity -- a refused read is never a quiet org", () => {
  assert.deepEqual({ ...EXIT }, { QUIET: 0, ATTENTION: 1, CANNOT_ASK: 2 });
});

test("only idle and done take an order -- working and blocked are not routed around", () => {
  assert.deepEqual([...WAKEABLE], ["idle", "done"]);
  for (const status of ["working", "blocked", "unknown"]) {
    const got = route("reviewer", agents({ reviewer: status }), ROSTER);
    assert.ok("refusal" in got, `"${status}" must not receive a prompt, but it was routed one`);
    assert.match(refusalText(got), new RegExp(status),
      "the refusal must name the state, or it cannot be acted on");
  }
});

test("a named session routes to itself when idle", () => {
  assert.deepEqual(route("reviewer-2", agents({ reviewer: "idle", "reviewer-2": "idle" }), ROSTER),
    { label: "reviewer-2" });
});

test("a session herdr does not know is REFUSED, never silently dropped", () => {
  const got = route("reviewer-3", agents({ reviewer: "idle" }), ROSTER);
  assert.match(refusalText(got), /no workspace labelled "reviewer-3"/);
});

/**
 * The engineer pool. `work-gate` addresses engineers collectively because whether a row is YOURS is
 * `row-claim.mjs`'s question; this only picks someone free to go and ask it.
 */
test("the engineers pool takes the first FREE engineer in roster order, deterministically", () => {
  const got = route("engineers",
    agents({ "worker-capture": "working", "worker-judge": "idle", "worker-tooling": "idle" }), ROSTER);
  assert.deepEqual(got, { label: "worker-judge" },
    "roster order decides, so the same two inputs always name the same engineer");
});

test("a fully busy pool is refused WITH the states that made it busy", () => {
  const got = route("engineers",
    agents({ "worker-capture": "working", "worker-judge": "blocked", "worker-tooling": "unknown" }), ROSTER);
  const { refusal } = got as { refusal: string };
  assert.match(refusal, /no engineer is idle/);
  for (const seen of ["worker-capture=working", "worker-judge=blocked", "worker-tooling=unknown"]) {
    assert.ok(refusal.includes(seen), `the refusal must show ${seen}, or nobody can tell why nothing woke`);
  }
});

test("an engineer absent from herdr reads as absent, not as idle", () => {
  const got = route("engineers", agents({ "worker-capture": "working" }), ROSTER);
  assert.match(refusalText(got), /worker-judge=absent/);
});

/**
 * THE LEDGER IS WHY THE GATE CAN TICK EVERY TWO MINUTES. `causeKey` is derived by `work-gate` from GitHub
 * state alone, so the same unreviewed PR at the same head yields the same key on every tick.
 */
test("a causeKey already delivered is not delivered again", () => {
  const orders = [{ causeKey: "reviewer/draft/pr-1/abc" }, { causeKey: "reviewer/draft/pr-2/def" }];
  assert.deepEqual(undelivered(orders, new Set(["reviewer/draft/pr-1/abc"])),
    [{ causeKey: "reviewer/draft/pr-2/def" }]);
});

test("a causeKey repeated WITHIN one tick wakes once, not twice", () => {
  const dup = { causeKey: "engineers/ready/7" };
  assert.deepEqual(undelivered([dup, { ...dup }], new Set()), [dup]);
});

test("a missing ledger is an empty ledger; an unreadable one is NOT", () => {
  const enoent = Object.assign(new Error("nope"), { code: "ENOENT" });
  assert.deepEqual(readLedger("/nonexistent", () => { throw enoent; }), new Set());
  const eacces = Object.assign(new Error("denied"), { code: "EACCES" });
  assert.throws(() => readLedger("/unreadable", () => { throw eacces; }), /denied/,
    "a ledger that cannot be read must not read as 'nothing has been delivered' -- that re-wakes everything");
});

test("readLedger ignores blank lines rather than storing an empty causeKey", () => {
  assert.deepEqual(readLedger("x", () => "a\n\n  \nb\n"), new Set(["a", "b"]));
});

test("an order missing session, causeKey or prompt is REFUSED, never skipped", () => {
  assert.throws(() => parseOrders(JSON.stringify({ session: "reviewer", causeKey: "k" })),
    /missing session\/causeKey\/prompt/, "a malformed order must not silently deliver nothing");
  assert.deepEqual(parseOrders(""), [], "no orders is not malformed");
});

test("readAgents: herdr not answering is null, and an empty org is [] -- they are different answers", () => {
  assert.equal(readAgents(() => { throw new Error("no socket"); }), null);
  assert.equal(readAgents(() => "not json"), null);
  assert.deepEqual(readAgents(() => JSON.stringify({ result: { workspaces: [] } })), []);
  assert.deepEqual(readAgents(() => JSON.stringify({ result: { workspaces: [{ label: "ceo" }] } })),
    [{ label: "ceo", status: "unknown" }], "a workspace with no agent_status reads as unknown, not as idle");
});

test("deliver sends the prompt to the routed agent and records only what herdr accepted", () => {
  const calls: string[][] = [];
  const recorded: string[] = [];
  const { sent, refused } = deliver(
    [{ session: "reviewer", causeKey: "k1", prompt: "review pr 7" }],
    agents({ reviewer: "idle" }), ROSTER,
    { run: (args: string[]) => { calls.push(args); return ""; }, record: (k: string) => recorded.push(k) });
  assert.deepEqual(refused, []);
  assert.deepEqual(sent, ["reviewer <- k1"]);
  assert.deepEqual(recorded, ["k1"]);
  assert.deepEqual(calls, [["--session", "org", "agent", "prompt", "reviewer", "review pr 7"]]);
});

test("a prompt herdr REFUSES is not recorded, so the next tick retries it", () => {
  const recorded: string[] = [];
  const { sent, refused } = deliver(
    [{ session: "reviewer", causeKey: "k1", prompt: "p" }],
    agents({ reviewer: "idle" }), ROSTER,
    { run: () => { throw new Error("agent_blocked"); }, record: (k: string) => recorded.push(k) });
  assert.deepEqual(sent, []);
  assert.deepEqual(recorded, [], "recording a wake that never landed loses it for good");
  assert.match(refused[0], /k1: herdr refused the prompt to "reviewer" \(agent_blocked/);
});

/**
 * The bug this test exists for: two orders for the pool in one tick both routed to the same idle engineer,
 * because the first wake had not changed the roster the second one read.
 */
test("an agent woken THIS tick is working, so a second order goes to the next engineer", () => {
  const { sent, refused } = deliver(
    [{ session: "engineers", causeKey: "k1", prompt: "row 1" },
     { session: "engineers", causeKey: "k2", prompt: "row 2" }],
    agents({ "worker-capture": "idle", "worker-judge": "idle", "worker-tooling": "working" }), ROSTER,
    { run: () => "", record: () => {} });
  assert.deepEqual(refused, []);
  assert.deepEqual(sent, ["worker-capture <- k1", "worker-judge <- k2"],
    "the second order must not be typed into the terminal of an agent woken a moment earlier");
});

test("deliver never mutates the agent list it was handed", () => {
  const live = agents({ reviewer: "idle" });
  deliver([{ session: "reviewer", causeKey: "k", prompt: "p" }], live, ROSTER,
    { run: () => "", record: () => {} });
  assert.deepEqual(live, [{ label: "reviewer", status: "idle" }]);
});

// --- work-tick: the gate's exit code decides whether the orders mean anything (#912) ---

test("work-tick: a gate that COULD NOT ASK stops the tick -- its silence is never fed forward as quiet", () => {
  const got = afterGate(GATE.CANNOT_ASK);
  assert.equal(got.deliver, false, "delivering an empty stdout from a refused read reports a quiet org");
  assert.equal(got.exit, TICK_EXIT.CANNOT_ASK);
  assert.match(String(got.why), /nothing was examined/i);
});

test("work-tick: QUIET delivers nothing and exits quiet", () => {
  assert.deepEqual(afterGate(GATE.QUIET), { deliver: false, exit: TICK_EXIT.QUIET });
});

test("work-tick: WORK delivers", () => {
  assert.equal(afterGate(GATE.WORK).deliver, true);
});

/**
 * PARTIAL is the one worth pinning: one lane answered, the other did not. The orders that exist are real,
 * and holding them back because a different queue was unreachable is the quiet-org error inverted.
 */
test("work-tick: PARTIAL still delivers the real orders, and says which lane went unread", () => {
  const got = afterGate(GATE.PARTIAL);
  assert.equal(got.deliver, true);
  assert.match(String(got.why), /one lane could not be read/);
});

test("work-tick: an exit code nobody documented is treated as CANNOT_ASK, never as quiet", () => {
  for (const code of [7, 129, -1]) {
    assert.equal(afterGate(code).deliver, false, `exit ${code} must not deliver`);
    assert.equal(afterGate(code).exit, TICK_EXIT.CANNOT_ASK);
  }
});

// --- spawnInvocation: a fresh worker per cause, at the tier that cause deserves ---

test("spawnInvocation builds a herdr start command carrying the cause's model and effort", () => {
  const got = spawnInvocation({ cause: "draft-awaiting-verdict" }, "reviewer-1630", "w7:t1");
  assert.deepEqual(spawned(got).args, [
    "--session", "org", "agent", "start", "reviewer-1630", "--kind", "codex", "--pane", "w7:t1",
    "--", "-m", "gpt-5.6-luna", "-c", 'model_reasoning_effort="medium"',
    "-c", 'approval_policy="never"', "-c", 'sandbox_mode="workspace-write"']);
});

test("spawnInvocation REFUSES a cause with no profile -- it never picks a tier on its own", () => {
  const got = spawnInvocation({ cause: "something-new" }, "w", "p");
  assert.match(refusalText(got), /cannot choose a worker for this order/);
  assert.match(refusalText(got), /no profile for cause "something-new"/);
});

test("spawnInvocation passes an operator override through to the spawned worker", () => {
  const got = spawnInvocation({ cause: "ready-row-unclaimed" }, "eng-1", "w3:t1", { effort: "max" });
  assert.ok(spawned(got).args.join(" ").includes("--effort max"));
  assert.ok(spawned(got).args.includes("claude"), "an engineer is a claude worker");
  assert.equal(spawned(got).profile.effort, "max");
});

test("the `--` separator is present, or herdr eats the agent's flags as its own", () => {
  const args: string[] = spawned(spawnInvocation({ cause: "ready-row-unclaimed" }, "e", "p")).args;
  const sep = args.indexOf("--");
  assert.ok(sep > 0, "no `--` separator");
  assert.ok(args.slice(sep).includes("--model"), "the model flag must fall AFTER the separator");
  assert.ok(!args.slice(0, sep).includes("--model"), "nothing agent-bound may precede the separator");
  assert.equal(args[args.indexOf("--kind") + 1], "claude", "herdr must be told which product to start");
});

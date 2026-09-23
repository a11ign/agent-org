/**
 * `packages/agent-org/src/wake.mjs` -- #912's remaining half: work-gate says there is work, this says who
 * takes it.
 *
 * DRIVEN THROUGH INJECTED SEAMS, never a running org. Every export here takes its `run` or its reader as a
 * parameter, so these tests answer "given these agent states and these orders, who gets woken and what is
 * refused" -- which is this module's whole question. Standing up herdr to ask it would test herdr.
 *
 * WITH ONE DELIBERATE EXCEPTION, AT THE FOOT OF THIS FILE: three tests spawn `wake.mjs` as a process with
 * a stub `herdr` on `PATH`. They exist because a seam is exactly what a DELETED CALL goes around -- a
 * reviewer removed the tick's only `backlogReport(handoffBacklog(...))` call and every test above stayed
 * green. Nothing there starts an agent either; the stub answers one question with one literal.
 *
 * The cases that matter are the REFUSALS. A wake that fires is visible immediately; a wake that silently
 * does not is the 2026-09-08 shape the lead-orchestrator brief records, where "every session went idle at
 * 20:52Z and nothing woke anyone for ten" hours.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route, undelivered, parseOrders, readLedger, deliver, readAgents, WAKEABLE, EXIT,
  WAKE_TTL_MS, JUDGMENT_TTL_MS, MAX_DELIVERIES, deliveryCounts, endedRuns, RESET,
  blockedSessions }
  from "../wake.mjs";
import { afterGate, GATE, EXIT as TICK_EXIT } from "../work-tick.mjs";
import { spawnInvocation, addressed, clearContext, CLEAR_TIMEOUT_MS, CLEAR_SETTLE_MS,
  RUN_IDLE_RESET_MS, stuckRowOf, escalateStuck }
  from "../wake.mjs";
import { spawnableRole, isPilotOrder, SPAWN_CAUSES, MAX_SPAWNS_PER_TICK }
  from "../wake.mjs";
import { handoffId, handoffQueuePath, ledgerPathFrom, readHandoffs, queueHandoff, dropHandoffs,
  deliverHandoffs, handoffOrder, staleHandoffs, nothingToDeliver, HANDOFF_STALE_MS, HANDOFF_QUEUE_FILE }
  from "../wake.mjs";
import { handoffBacklog, backlogReport, handoffBatches, fitBatch, waitedFor, staleReport,
  PROMPT_ARG_MAX, HANDOFF_BATCH_BYTES, BATCH_WRAPPER_BYTES, targetLabelBytes }
  from "../wake.mjs";

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
  // The line format is `<epochMs>\t<causeKey>` since wakes started expiring. Blank and whitespace-only
  // lines are still skipped; what changed is that a line with no timestamp is unknown-age, not a key.
  const now = Date.now();
  const raw = `${now}\ta\n\n  \n${now}\tb\n`;
  assert.deepEqual(readLedger("x", () => raw), new Set(["a", "b"]));
  assert.deepEqual(readLedger("x", () => `${now}\t\n`), new Set(),
    "a timestamp with no key is malformed, not an empty causeKey");
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
  // The prompt herdr receives is the ADDRESSED one -- the order's text plus who the session is. Asserting
  // the raw `order.prompt` here is what this test did until 2026-09-17, and it passed while the agent on
  // the other end had no idea what to put in `--session=`.
  // TWO calls now: the context is cleared, then the order is delivered. A session on its 500th turn
  // costs ~24x one on its 10th for identical output, so the clear pays for itself in one turn.
  assert.equal(calls.length, 3, "clear, wait, then the order");
  assert.deepEqual(calls[0], ["--session", "org", "agent", "prompt", "reviewer", "/clear"]);
  assert.deepEqual(calls[1], ["--session", "org", "agent", "wait", "reviewer",
    "--until", "idle", "--until", "done", "--timeout", String(CLEAR_TIMEOUT_MS)]);
  assert.deepEqual(calls[2].slice(0, 5), ["--session", "org", "agent", "prompt", "reviewer"]);
  assert.equal(calls[2][5], addressed({ session: "reviewer", prompt: "review pr 7" }, "reviewer"));
  assert.match(calls[2][5], /You are `reviewer`/);
  assert.ok(calls[2][5].includes("review pr 7"), "the order's own text must survive");
});

test("a prompt herdr REFUSES is not recorded, so the next tick retries it", () => {
  const recorded: string[] = [];
  const { sent, refused } = deliver(
    [{ session: "reviewer", causeKey: "k1", prompt: "p" }],
    agents({ reviewer: "idle" }), ROSTER,
    { run: () => { throw new Error("agent_blocked"); }, record: (k: string) => recorded.push(k) });
  assert.deepEqual(sent, []);
  assert.deepEqual(recorded, [], "recording a wake that never landed loses it for good");
  // This `run` refuses everything, so the /clear is refused too and reports first. The refusal that
  // matters here is the PROMPT's -- found by name rather than by index, or adding a step ahead of it
  // silently changes what this asserts.
  assert.ok(refused.some((r: string) => /k1: herdr refused the prompt to "reviewer" \(agent_blocked/.test(r)),
    `expected a prompt refusal, got ${JSON.stringify(refused)}`);
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

// --- #1952: THE CALLER. `spawnInvocation` was tested and had NO PRODUCTION CALLER ---
//
// Measured at `f34e5d817` while `ceo` ruled #1950: `grep -F spawnInvocation packages` outside the tests
// returned ONE line, its own `export function`. Everything above this comment tested a command string
// nothing ever ran. So these tests are driven through `deliver` -- the production entry -- and NOT through
// `spawnWorker` alone: a seam is exactly what a DELETED CALL goes around, which is the lesson this file's
// own header records about `backlogReport`.

/** A `herdr` that records every call and answers `workspace create` as the live org did on 2026-09-23. */
function recordingHerdr(refuse: (said: string) => boolean = () => false) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    const said = args.join(" ");
    // Multi-line on purpose: a refusal quotes the FIRST line, and a test that never sees a second one
    // cannot tell a bounded excerpt from the whole message.
    if (refuse(said)) throw new Error(`herdr: refused\nstack frame nobody needs`);
    if (said.includes("workspace create")) {
      return JSON.stringify({
        result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } },
      });
    }
    return "{}";
  };
  return { calls, run, said: (verb: string) => calls.map((c) => c.join(" ")).filter((s) => s.includes(verb)) };
}

const ROW_ORDER = {
  session: "engineers",
  cause: "ready-row-unclaimed",
  causeKey: "engineers/ready-row-unclaimed/2131",
  prompt: "Ready row #2131 is unclaimed. Claim it with `--session=<you>`.",
};
/** Nobody is running: every engineer role is absent from herdr's workspace list. */
const NOBODY = agents({ ceo: "working", "product-manager": "working" });

test("#1952 ACCEPTANCE: deliver STARTS a process when no engineer exists, and the order reaches it", () => {
  const h = recordingHerdr();
  const recorded: string[] = [];
  const got = deliver([ROW_ORDER], NOBODY, ROSTER, { run: h.run, record: (k) => recorded.push(k) });

  assert.deepEqual(h.said("workspace create"),
    ["--session org workspace create --label worker-capture --no-focus"],
    "the pane comes from a workspace created for the role, and `--no-focus` keeps the tick off the display");
  assert.deepEqual(h.said("agent start"),
    ["--session org agent start worker-capture --kind claude --pane wB:p1 -- --model sonnet --effort high "
      + "--dangerously-skip-permissions --disallowedTools AskUserQuestion"],
    "the pane id is the one `workspace create` just answered with, and the model/effort are the CAUSE's -- "
    + "the standing six carry neither, which is the argument only spawning answers (#1950, correction 3)");
  assert.equal(h.said("agent prompt").length, 1, "the started process is given the order");
  assert.ok(h.said("agent prompt")[0].includes("You are `worker-capture`"),
    "addressed() is the same line a standing session gets -- a spawned one must not be told less");
  assert.deepEqual(got.sent, ["worker-capture <- engineers/ready-row-unclaimed/2131 (STARTED sonnet/high)"]);
  assert.deepEqual(got.refused, []);
  assert.deepEqual(recorded, ["engineers/ready-row-unclaimed/2131"],
    "a delivered order is a spent causeKey however it was delivered, or the next tick starts another one");
});

test("#1952: the name is a ROSTER ROLE, because `session:<name>` is an address arm-pr refuses off-list", () => {
  const h = recordingHerdr();
  deliver([ROW_ORDER], NOBODY, ROSTER, { run: h.run });
  const name = h.said("agent start")[0].split(" ")[4];
  assert.equal(name, "worker-capture", "the first absent role in roster order -- deterministic, never a pick");
  // THE CLAIMABILITY PROPERTY, against the file that decides it. `arm-pr`'s LIVE_SESSIONS is this file's
  // `live` names and refuses a `session:` label outside it, and B2 caps one row in build per NAME -- so a
  // process called `eng-2131` would start fine and be unable to claim, label or comment on anything.
  const live = (JSON.parse(readFileSync(
    new URL("../../../../packages/agent-org/docs/roles/sessions.json", import.meta.url), "utf8",
  )) as { live: { name: string }[] }).live.map((s) => s.name);
  assert.ok(live.includes(name), `the started name must be a live role; sessions.json has ${live.join(", ")}`);
  assert.ok(ROSTER.every((r) => live.includes(r)), "the engineer roster is a subset of the live roles");
});

test("#1952: a session that is FREE is still prompted, never replaced by a fresh process", () => {
  const h = recordingHerdr();
  const free = agents({ "worker-capture": "working", "worker-judge": "idle", "worker-tooling": "working" });
  const got = deliver([ROW_ORDER], free, ROSTER, { run: h.run });
  // Positive control for this emptiness: the ACCEPTANCE test above, which starts one from the same order.
  assert.deepEqual(h.said("workspace create"), [], "beside the standing path means route is asked FIRST");
  assert.deepEqual(got.sent, ["worker-judge <- engineers/ready-row-unclaimed/2131"],
    "and the standing delivery is unchanged -- no STARTED clause, because nothing was started");
  assert.equal(h.said("/clear").length, 1, "a standing session is still cleared before its order");
});

test("#1952: a STARTED process is not cleared -- there is nothing in it to clear", () => {
  const h = recordingHerdr();
  deliver([ROW_ORDER], NOBODY, ROSTER, { run: h.run });
  assert.deepEqual(h.said("/clear"), [],
    "a process two seconds old has only its own prefix, and `/clear` costs a prompt, a wait and "
    + `${CLEAR_SETTLE_MS}ms of settle to reach a floor the spawn started at`);
});

test("#1952: only the pilot's cause may start a process, and any other refusal is left WORDED AS IT WAS", () => {
  const busy = agents({ "worker-capture": "working", "worker-judge": "working", "worker-tooling": "working" });
  for (const cause of ["pr-checks-failing", "blocker-cleared", undefined]) {
    const h = recordingHerdr();
    const got = deliver([{ ...ROW_ORDER, cause }], busy, ROSTER, { run: h.run });
    assert.deepEqual(h.said("workspace create"), [], `"${cause}" is not a pilot cause`);
    assert.deepEqual(got.refused, [`${ROW_ORDER.causeKey}: no engineer is idle (worker-capture=working, `
      + "worker-judge=working, worker-tooling=working)"],
      "an order that was never a candidate must not have a sentence about spawning added to its refusal");
  }
  assert.deepEqual([...SPAWN_CAUSES], ["ready-row-unclaimed"], "one cause: the pilot, not the mechanism");
});

test("#1952: an order addressed to a NAMED session never starts one, whatever its cause", () => {
  const h = recordingHerdr();
  const named = { ...ROW_ORDER, session: "orchestrator" };
  const got = deliver([named], agents({ orchestrator: "working" }), ROSTER, { run: h.run });
  assert.deepEqual(h.said("workspace create"), []);
  assert.deepEqual(got.refused, [`${ROW_ORDER.causeKey}: "orchestrator" is working`],
    "a lane-owned ready row is one session's work; the pilot is the engineer POOL");
  assert.equal(isPilotOrder(named), false);
  assert.equal(isPilotOrder(ROW_ORDER), true);
});

test("#1952: a busy, blocked or agentless role's ADDRESS is never lent to a second process", () => {
  for (const status of ["working", "blocked", "unknown"]) {
    const held = agents({ "worker-capture": status, "worker-judge": status, "worker-tooling": status });
    const got = spawnableRole(ROW_ORDER, held, ROSTER);
    assert.match(refusalText(got), /every engineer role already has a process/);
    assert.match(refusalText(got), new RegExp(`worker-capture=${status}`),
      "the refusal names what each role is doing, or nobody can tell a busy org from a broken reader");
    const h = recordingHerdr();
    assert.deepEqual(deliver([ROW_ORDER], held, ROSTER, { run: h.run }).sent, []);
    assert.deepEqual(h.said("workspace create"), [], `a ${status} role's label is not reused`);
  }
  // The one state that IS lent, so the three refusals above are not vacuous.
  assert.deepEqual(spawnableRole(ROW_ORDER, NOBODY, ROSTER), { role: "worker-capture" });
});

test("#1952: at most one process per tick, and the second order says so rather than going quiet", () => {
  const h = recordingHerdr();
  const second = { ...ROW_ORDER, causeKey: "engineers/ready-row-unclaimed/2132" };
  const got = deliver([ROW_ORDER, second], NOBODY, ROSTER, { run: h.run });
  assert.equal(MAX_SPAWNS_PER_TICK, 1);
  assert.equal(h.said("agent start").length, 1, "a partial roster read must not start the whole roster");
  assert.deepEqual(got.sent, ["worker-capture <- engineers/ready-row-unclaimed/2131 (STARTED sonnet/high)"]);
  assert.deepEqual(got.refused, [`${second.causeKey}: no engineer is idle (worker-capture=working, `
    + "worker-judge=absent, worker-tooling=absent), and this tick has already started 1 "
    + "(MAX_SPAWNS_PER_TICK is 1)"]);
  assert.ok(got.refused[0].includes("worker-capture=working"),
    "the process just started is WORKING, not a free engineer the same tick may hand a second row to -- "
    + "it is not in the agent list this tick read, so `deliver` has to add it");
});

test("#1952 TEARDOWN: a refused `agent start` closes the workspace it opened, and says which", () => {
  const h = recordingHerdr((said) => said.includes("agent start"));
  const got = deliver([ROW_ORDER], NOBODY, ROSTER, { run: h.run });
  assert.deepEqual(h.said("workspace close"), ["--session org workspace close wB"],
    "an abandoned pane carries the ROLE's label and reports `agent_status: unknown`, which WAKEABLE "
    + "excludes and spawnableRole refuses -- so leaving it removes that engineer from the org for good");
  assert.deepEqual(got.sent, []);
  assert.match(got.refused[0], /herdr refused to start "worker-capture" \(herdr: refused\)/);
  assert.ok(!got.refused[0].includes("stack frame nobody needs"), "the excerpt is the first line only");
  assert.match(got.refused[0], /the workspace it opened \(wB\) was closed/);
});

test("#1952 TEARDOWN: a workspace naming no pane is closed too, and an unparseable answer is refused", () => {
  const paneless = (args: string[]) => args.join(" ").includes("workspace create")
    ? JSON.stringify({ result: { workspace: { workspace_id: "wB" } } }) : "{}";
  const calls: string[][] = [];
  const got = deliver([ROW_ORDER], NOBODY, ROSTER,
    { run: (args) => { calls.push(args); return paneless(args); } });
  assert.match(got.refused[0], /named no pane/);
  assert.ok(calls.some((c) => c.join(" ") === "--session org workspace close wB"),
    "an unreadable answer is the one case where the thing to clean up is the thing we cannot describe");
  assert.deepEqual(got.sent, []);
});

test("#1952 TEARDOWN: a close that FAILS is reported, never swallowed -- it needs a hand", () => {
  const h = recordingHerdr((said) => said.includes("agent start") || said.includes("workspace close"));
  const got = deliver([ROW_ORDER], NOBODY, ROSTER, { run: h.run });
  assert.equal(h.said("workspace close").length, 1, "the close was attempted");
  assert.match(got.refused[0], /could NOT be closed/);
  assert.match(got.refused[0], /close it by hand, or that role reads `unknown`/);
  assert.deepEqual(got.sent, []);
});

test("#1952: a started process whose PROMPT is refused is left running, and the cause stays unspent", () => {
  const h = recordingHerdr((said) => said.includes("agent prompt"));
  const recorded: string[] = [];
  const got = deliver([ROW_ORDER], NOBODY, ROSTER, { run: h.run, record: (k) => recorded.push(k) });
  assert.deepEqual(h.said("workspace close"), [],
    "it is a healthy idle session under a roster label -- closing it throws away a working engineer");
  assert.deepEqual(recorded, [], "an unrecorded causeKey is re-offered, and the ordinary route will place it");
  assert.match(got.refused[0], /herdr refused the prompt to "worker-capture"/);
});

test("#1952: the capped cause still reaches MAX_DELIVERIES rather than starting a process forever", () => {
  const h = recordingHerdr();
  const counts = new Map([[ROW_ORDER.causeKey, MAX_DELIVERIES]]);
  const got = deliver([ROW_ORDER], NOBODY, ROSTER, { run: h.run, counts });
  assert.deepEqual(h.said("workspace create"), [],
    "the stuck cap is read BEFORE the target, so a cause nobody acts on cannot spend a process a tick");
  assert.equal(got.stuck.length, 1);
});

// --- addressed: the woken session is told WHO IT IS, and that nobody is at the terminal (2026-09-17) ---

test("the woken session is told its own name, because the order's command asks for it", () => {
  const got = addressed({ session: "engineers", prompt: "claim it with --session=<you>" }, "worker-capture");
  assert.match(got, /You are `worker-capture`/);
  assert.match(got, /--session=worker-capture/,
    "`<you>` must be SUBSTITUTED, not merely explained -- an agent handed a placeholder still has to "
    + "edit the command, and the first engineer woken by this system stopped and asked a human instead");
  assert.doesNotMatch(got, /<you>/, "no placeholder may survive into the prompt");
});

test("the woken session is told not to wait on a human, and who to ask instead", () => {
  const got = addressed({ session: "engineers", prompt: "do the thing" }, "worker-judge");
  assert.match(got, /nobody is at this terminal/);
  assert.match(got, /product-manager/,
    "agent-practices routes row questions to product-manager; an agent that blocks on a human it cannot "
    + "reach has stopped, which is the failure this whole design exists to avoid");
});

test("the order's own text survives intact -- the prefix adds, never replaces", () => {
  const got = addressed({ session: "reviewer", prompt: "Draft #1630 needs a verdict." }, "reviewer");
  assert.ok(got.includes("Draft #1630 needs a verdict."));
});

// --- #1433/#1435: a wake that did not stick must be asked again (2026-09-18) ---

/**
 * THE LEDGER RECORDED "I SENT A PROMPT", NOT "THE WORK GOT DONE". Every wake was one-shot and permanent,
 * so an agent that failed, stalled or simply did not claim left the row stranded for ever. Measured
 * 2026-09-18: rows #1433 and #1435 Ready and unclaimed, no open PRs, all eight sessions idle, the gate
 * emitting both orders correctly, and the tick exiting QUIET because both keys were in the ledger from
 * the night before.
 */
test("a wake older than the window is offered again", () => {
  const old = `${Date.now() - WAKE_TTL_MS - 1}\tengineers/ready-row-unclaimed/1433`;
  assert.deepEqual([...readLedger("x", () => old)], [],
    "a stale wake must not keep a live cause silent -- that is how #1433 sat Ready overnight");
});

test("a wake inside the window still suppresses, so a tick does not spam", () => {
  const fresh = `${Date.now() - 1000}\tengineers/ready-row-unclaimed/1433`;
  assert.deepEqual([...readLedger("x", () => fresh)], ["engineers/ready-row-unclaimed/1433"]);
});

test("a PRE-TTL line has unknown age, so it expires rather than silencing a cause for ever", () => {
  assert.deepEqual([...readLedger("x", () => "engineers/ready-row-unclaimed/1433")], [],
    "the old format carried no time; keeping those live is the bug, discarding them re-wakes everything "
    + "at once, and expiring them is the honest reading of a wake whose age cannot be known");
});

test("the window is long enough that an agent reading a brief is never interrupted", () => {
  assert.ok(WAKE_TTL_MS >= 10 * 60 * 1000, "shorter than ten minutes re-prompts mid-turn");
  assert.ok(WAKE_TTL_MS <= 60 * 60 * 1000,
    "longer than an hour and a wake that did not stick costs a night, which is the bug being fixed");
});

test("deliveryCounts spans the WHOLE ledger, not the live window", () => {
  // CONTIGUOUS DELIVERIES STILL ALL COUNT, however old. The original fixture here put a 3.3-hour gap
  // between its second and third entries, which `RUN_IDLE_RESET_MS` now correctly reads as a NEW RUN --
  // so the gaps are inside the window and the assertion tests what it meant to: age does not forgive a
  // delivery, silence does.
  const ancient = Date.now() - 10 * WAKE_TTL_MS;
  const raw = [`${ancient}\tk`, `${ancient + 1000}\tk`, `${ancient + 2000}\tk`].join("\n");
  assert.equal(deliveryCounts("x", () => raw).get("k"), 3,
    "reading only the live window would report 1 for a cause on its fortieth attempt");
});

/**
 * A QUIET SPELL ENDS A RUN, BECAUSE `endedRuns` CANNOT END ONE FOR A STANDING ROW.
 *
 * A run ends when a cause STOPS BEING EMITTED. That worked while `lane-backlog-unpromoted` was keyed on
 * a COUNT (`.../ceo/3`): any row entering or leaving the lane changed the key and reset the counter as a
 * side effect. #1799 was right that the count key re-litigated a judgment whenever an unrelated row
 * moved, and 2026-09-20's fix re-keyed it per row -- but THE CHURN THAT WAS REMOVED WAS ALSO THE THING
 * KEEPING THE COUNTER FRESH.
 *
 * MEASURED 2026-09-21: `ceo/lane-backlog-unpromoted/row-1234` -- 6 deliveries, ZERO resets, capped and
 * permanently unreachable, while the old count-keyed entries in the SAME ledger carry RESETs throughout.
 * One fix created the other's failure, in the same file, one day apart. `ceo` had two live questions it
 * could no longer be asked and every session read idle.
 */
test("a gap longer than RUN_IDLE_RESET_MS starts the count again", () => {
  const first = Date.now() - 5 * RUN_IDLE_RESET_MS;
  const raw = [`${first}\tk`, `${first + 1000}\tk`,
    `${first + 1000 + RUN_IDLE_RESET_MS + 1}\tk`].join("\n");
  assert.equal(deliveryCounts("x", () => raw).get("k"), 1,
    "nobody was told for over two hours -- that is a new run, not the third attempt of an old one");
});

test("the idle reset measures DELIVERY silence, not cause silence", () => {
  // Deliberately longer than `JUDGMENT_TTL_MS`, so it can only fire after the cause has had a full
  // chance to be re-offered and was not. A shorter window would forgive an ignored cause every two
  // hours and the breaker would never trip at all.
  assert.ok(RUN_IDLE_RESET_MS >= JUDGMENT_TTL_MS,
    "shorter than the judgment TTL and the cap could never be reached by a judgment cause");
  assert.ok(RUN_IDLE_RESET_MS >= 6 * WAKE_TTL_MS,
    "and it must exceed a full run of wake-TTL deliveries, or a stuck cause resets mid-run");
});

test("a cause delivered MAX times is named and STOPPED, never offered again", () => {
  const calls: string[][] = [];
  const counts = new Map([["k1", MAX_DELIVERIES]]);
  const { sent, stuck } = deliver([{ session: "reviewer", causeKey: "k1", prompt: "p" }],
    agents({ reviewer: "idle" }), ROSTER,
    { run: (a: string[]) => { calls.push(a); return ""; }, record: () => {}, counts });
  assert.deepEqual(sent, []);
  assert.deepEqual(calls, [], "an agent that has ignored this six times must not be prompted a seventh");
  assert.match(stuck[0], /k1: delivered 6 times and the cause is still true/);
});

test("a cause below the limit is still delivered", () => {
  const counts = new Map([["k1", MAX_DELIVERIES - 1]]);
  const { sent, stuck } = deliver([{ session: "reviewer", causeKey: "k1", prompt: "p" }],
    agents({ reviewer: "idle" }), ROSTER, { run: () => "", record: () => {}, counts });
  assert.deepEqual(stuck, []);
  assert.deepEqual(sent, ["reviewer <- k1"]);
});

// --- the largest saving: a standing session's context only grows (2026-09-18) ---

/**
 * Measured on the live org within ONE session: turn 1 read 37k, turn 548 read 895k. Every turn re-reads
 * the whole accumulated conversation, so turn 548 paid 24x turn 1 for the same few hundred output
 * tokens. Across the org that day: 786M input against 782k output, and 7% of a weekly allowance for a
 * day in which very little shipped. `/clear` on worker-capture took it 690k -> 37k.
 */
test("every delivery CLEARS the session's context before prompting it", () => {
  const calls: string[][] = [];
  deliver([{ session: "reviewer", causeKey: "k", prompt: "p" }], agents({ reviewer: "idle" }), ROSTER,
    { run: (a: string[]) => { calls.push(a); return ""; }, record: () => {} });
  assert.equal(calls[0][5], "/clear", "the clear must come FIRST, or the order pays the old context");
});

test("a REFUSED clear still delivers -- expensive beats undelivered", () => {
  const calls: string[][] = [];
  const run = (a: string[]) => {
    calls.push(a);
    if (a[5] === "/clear") throw new Error("agent_blocked");
    return "";
  };
  const { sent, refused } = deliver([{ session: "reviewer", causeKey: "k", prompt: "p" }],
    agents({ reviewer: "idle" }), ROSTER, { run, record: () => {} });
  assert.deepEqual(sent, ["reviewer <- k"], "a bloated context is worse than a fresh one, not worse than none");
  assert.match(refused[0], /\/clear refused.*delivered anyway/);
});

test("clearContext reports a refusal rather than throwing, and null on success", () => {
  assert.equal(clearContext(() => "", "reviewer"), null);
  assert.match(String(clearContext(() => { throw new Error("no socket"); }, "ceo")),
    /ceo: \/clear refused \(no socket/);
});

/**
 * THE CLEAR MUST SETTLE BEFORE THE ORDER IS SENT, and its absence broke the live org within minutes.
 * `agent prompt` SUBMITS text and returns; it does not wait for the agent to consume it. So the order was
 * typed into the same input the clear was still sitting in, and `ceo` received one concatenated line:
 *
 *     Unknown command: /clearYou are `ceo`, an org session in this repository...
 *
 * The clear refused as an unknown command AND the order was mangled into its argument: two turns spent,
 * no work done, which is the exact opposite of this function's purpose.
 */
test("the clear WAITS for the agent to settle, or it races the order that follows", () => {
  const calls: string[][] = [];
  clearContext((a: string[]) => { calls.push(a); return ""; }, "ceo");
  // SUBMIT then WAIT, as two commands. `prompt --wait` requires an observed state CHANGE within 5000ms
  // and a `/clear` to an already-`done` agent changes nothing observable -- two of three live wakes came
  // back `agent_prompt_stalled`. `agent wait` matches a STATE, so an already-idle agent passes at once.
  assert.equal(calls.length, 2, "one submit, one wait -- the settle is a delay, not a command");
  assert.deepEqual(calls[0].slice(5), ["/clear"], "the submit carries no wait flags");
  assert.equal(calls[1][3], "wait");
  assert.ok(calls[1].includes("--timeout"),
    "an unbounded wait would hang the whole tick on one stuck agent");
});

test("the clear timeout is bounded and not absurd", () => {
  assert.ok(CLEAR_TIMEOUT_MS >= 5_000, "a clear needs time to land; too short re-creates the race");
  assert.ok(CLEAR_TIMEOUT_MS <= 120_000, "longer than two minutes and one stuck agent stalls every tick");
});

test("the settle is bounded at both ends -- 0 mangles, and a long one stalls every tick", () => {
  // MEASURED on the live org: 0s produced `Unknown command: /clearYou are...`; 2s and 5s both produced
  // clean prompts. There is nothing to synchronise on -- `/clear` moves neither the agent's status nor
  // its `state_change_seq` (it sat at 6221 across one) -- so this is a delay and is named as one.
  assert.ok(CLEAR_SETTLE_MS >= 2_000, "2s was the shortest delay measured clean; below it is untested");
  assert.ok(CLEAR_SETTLE_MS <= 15_000,
    "the tick runs every two minutes and may clear several agents; a long settle eats the interval");
});

// --- #1564: a question already answered must not be asked again (2026-09-18) ---

/**
 * `orchestrator` was woken for `lane-backlog-unpromoted`, spent four shell commands establishing that
 * #1564 is a research row with no Acceptance waiting on a `ceo` ruling, and answered "staying put" --
 * correctly. The twenty-minute expiry would then have asked it again, and again, until the six-delivery
 * STUCK cap stopped it two hours later: six full model turns to reach one conclusion six times.
 */
test("a JUDGMENT cause outlives the action window -- its answer is durable while it is fresh", () => {
  const stale = `${Date.now() - WAKE_TTL_MS * 3}\torchestrator/lane-backlog-unpromoted/lane:orchestrator/1`;
  const judgment = new Set(["lane-backlog-unpromoted"]);
  assert.deepEqual([...readLedger("x", () => stale, Date.now(), judgment)],
    ["orchestrator/lane-backlog-unpromoted/lane:orchestrator/1"],
    "re-asking buys a model turn to reach a conclusion somebody already reached");
});

/**
 * THE OTHER HALF, AND IT COST A MORNING. Shipped as NEVER EXPIRES, this latched
 * `product-manager/ready-queue-empty/22` off at 08:52 and left six agents idle behind an empty Ready
 * queue for over four hours -- the very defect `ready-queue-empty` exists to catch. The key could not see
 * it: its discriminator is the BACKLOG depth, which barely moves, while the shelf it reports on drained,
 * refilled and drained again underneath it.
 *
 * So both directions are pinned here. A judgment cause that expires too fast restores #1699's six futile
 * turns; one that never expires restores this. Only the pair says the window is a window.
 */
test("a judgment cause DOES eventually expire -- durable is not eternal", () => {
  const ancient = `${Date.now() - JUDGMENT_TTL_MS - 1}\tproduct-manager/ready-queue-empty/22`;
  assert.deepEqual([...readLedger("x", () => ancient, Date.now(), new Set(["ready-queue-empty"]))], [],
    "an empty shelf nobody may be asked about again is an org that stops, and it did");
});

test("the judgment window is LONGER than the action one, or the exemption means nothing", () => {
  assert.ok(JUDGMENT_TTL_MS > WAKE_TTL_MS * 3,
    "#1699 measured six futile turns over two hours at the action expiry; a judgment window that does "
    + "not clear that span buys nothing and this file would be pinning a distinction with no difference");
});

test("an ACTION cause still expires -- a wake that did not stick must be re-offered", () => {
  const stale = `${Date.now() - WAKE_TTL_MS * 3}\tengineers/ready-row-unclaimed/1433`;
  assert.deepEqual([...readLedger("x", () => stale, Date.now(), new Set(["lane-backlog-unpromoted"]))], [],
    "#1433 sat Ready overnight because a spent key silenced it for ever -- that must still expire");
});

test("the state is in the KEY, so a real change still reaches the owner at once", () => {
  const judgment = new Set(["lane-backlog-unpromoted"]);
  const stale = `${Date.now() - WAKE_TTL_MS * 3}\torchestrator/lane-backlog-unpromoted/lane:orchestrator/1`;
  const live = readLedger("x", () => stale, Date.now(), judgment);
  // The discriminator is the lane's row count: two rows is a different key, so it is not suppressed.
  assert.ok(!live.has("orchestrator/lane-backlog-unpromoted/lane:orchestrator/2"),
    "a lane that grew is a new question and must not inherit the old answer's silence");
});

// --- the delivery cap resets when the CAUSE stops, not when the clock moves (2026-09-18) ---

/**
 * THE NINE HOURS THIS COST. `MAX_DELIVERIES` exists to stop a cause that keeps coming back and going
 * nowhere. It counted every delivery a key had ever had -- so when `ceo/ready-row-unclaimed/1452` spent
 * all six of its deliveries in the morning while B4 genuinely blocked the row behind an open PR, and that
 * PR then merged, the row became claimable and the cap kept it silent for the rest of the day. It was the
 * queue's ONLY actionable job; eight agents sat idle behind it.
 *
 * A TIME WINDOW WAS TRIED FIRST AND CANNOT WORK: those six deliveries span 2h10m, because each waits out
 * the 20-minute liveness TTL, so any window wide enough for the cap to trigger still contains them. The
 * signal is not age. It is whether the cause STOPPED being true and started again -- and from the ledger
 * alone, a gap in DELIVERY is indistinguishable from a gap in EMISSION. So emission is written down.
 */
const ledgerOf = (lines: string[]) => lines.join("\n") + "\n";

test("a RESET marker ends the run and the count starts again at zero", () => {
  const key = "ceo/ready-row-unclaimed/1452";
  const six = ledgerOf(Array.from({ length: MAX_DELIVERIES }, (_, i) => `${1000 + i}\t${key}`));
  assert.equal(deliveryCounts("x", (() => six) as never).get(key), MAX_DELIVERIES,
    "the control: six deliveries read as six, which is what silenced #1452 all day");
  const afterReset = deliveryCounts("x", (() => six + `9000\t${RESET}\t${key}\n`) as never);
  assert.equal(afterReset.get(key), 0, "the cause went away; the run it earned that cap in is over");
});

test("deliveries AFTER a reset count again, so a genuinely stuck cause is still caught", () => {
  const key = "engineers/ready-row-unclaimed/77";
  const raw = ledgerOf([`1\t${key}`, `2\t${key}`, `3\t${RESET}\t${key}`, `4\t${key}`, `5\t${key}`]);
  assert.equal(deliveryCounts("x", (() => raw) as never).get(key), 2,
    "a reset is not an amnesty -- the new run counts from zero and can reach the cap on its own");
});

/**
 * THE OTHER DIRECTION, and the one that matters more: a reset that fires while the cause is STILL being
 * emitted would restore the nagging `MAX_DELIVERIES` exists to stop. `endedRuns` may only name keys that
 * were emitted last tick and are absent now.
 */
test("endedRuns names only causes that STOPPED being emitted -- never one still on offer", () => {
  const io = { store: "a\nb\nc\n" };
  const read = (() => io.store) as never;
  const write = ((_p: string, data: string) => { io.store = data; }) as never;
  assert.deepEqual(endedRuns(["a", "b", "c"], "x", { read, write }), [],
    "every key still emitted: nothing has ended, and resetting here would un-cap a live nag");
  assert.deepEqual(endedRuns(["a"], "x", { read, write }), ["b", "c"],
    "b and c were emitted last tick and are gone now -- their runs are over");
  assert.deepEqual(endedRuns(["a"], "x", { read, write }), [],
    "and they are not reported twice: the store now says only `a` was emitted");
});

test("a first run with no remembered set ends nothing", () => {
  const missing = (() => { const e = new Error("nope") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e; }) as never;
  assert.deepEqual(endedRuns(["a"], "x", { read: missing, write: (() => {}) as never }), [],
    "an absent store is a first tick, not a claim that every cause just ended");
});

test("the #1452 sequence end to end: capped, cause clears, offered again", () => {
  const key = "ceo/ready-row-unclaimed/1452";
  let ledger = ledgerOf(Array.from({ length: MAX_DELIVERIES }, (_, i) => `${1000 + i}\t${key}`));
  const order = { session: "ceo", cause: "ready-row-unclaimed", subject: "row-1452",
    discriminator: "1452", prompt: "claim it", causeKey: key };
  const agents = [{ label: "ceo", name: "ceo", status: "idle" }];

  // while B4 blocks the row the gate emits nothing for it, so the run ends
  const store = { s: `${key}\n` };
  for (const ended of endedRuns([], "x",
    { read: (() => store.s) as never, write: ((_p: string, d: string) => { store.s = d; }) as never })) {
    ledger += `9000\t${RESET}\t${ended}\n`;
  }
  assert.equal(deliveryCounts("x", (() => ledger) as never).get(key), 0);

  // the blocking PR merges, the gate emits it again, and it is DELIVERED rather than reported STUCK
  const { sent, stuck } = deliver([order], agents, ["ceo"],
    { run: (() => "") as never, record: () => {}, counts: deliveryCounts("x", (() => ledger) as never) });
  assert.deepEqual(stuck, [], "this is the nine hours: it was reported STUCK instead of woken");
  assert.equal(sent.length, 1);
});

/**
 * THE ORDER THAT TOLD `product-manager` TO MESSAGE ITSELF. This line is appended to every order
 * regardless of recipient, so the wake that reached `product-manager` about #1717's refused verdict
 * ended "message `product-manager`" -- which the chairman read, reasonably, as the order having fired
 * twice. It had fired once; it just named a dead end.
 *
 * The routing rule already has the answer: `product-manager` is the first reader for rows, its own onward
 * route is `ceo`, and `ceo`'s is the chairman -- whom no session can message, so the line says so instead
 * of naming something unreachable.
 */
test("the escalation line names someone OTHER than the recipient, for every session", () => {
  const order = { session: "x", cause: "c", subject: "s", discriminator: "d",
    prompt: "do the thing", causeKey: "k" };
  for (const label of ["product-manager", "ceo", "worker-judge", "orchestrator", "reviewer"]) {
    const text = addressed(order, label);
    const named = text.match(/message `([^`]+)`/)?.[1];
    assert.notEqual(named, label, `${label} is told to message itself, which is a dead end`);
  }
  assert.match(addressed(order, "product-manager"), /message `ceo`/,
    "product-manager's own onward route in the routing rule");
  assert.match(addressed(order, "ceo"), /the chairman on the row itself -- no session can message them/,
    "ceo's route is the chairman, who has no session -- say that rather than name something unreachable");
  assert.match(addressed(order, "worker-judge"), /message `product-manager`/,
    "and everyone else still goes to the first reader for rows");
});

// --- a blocked session says so, because nothing else will (2026-09-19) ---

/**
 * THE WORKER THAT REMOVED ITSELF FROM THE POOL IN SILENCE. `WAKEABLE` is `idle`/`done`, so a session
 * herdr reports as `blocked` -- stopped mid-turn on a question nobody is going to answer -- is never
 * offered another cause. It writes nothing to any row, and to every check the org has it looks exactly
 * like an idle agent.
 *
 * Measured: `worker-capture` sat `blocked` on row #1335 behind an "How should I proceed?" menu, and the
 * only thing that found it was the chairman reading the terminal. The wake prompt already forbids asking
 * ("nobody is at this terminal to answer you"), so this does not try to prevent it -- an instruction
 * cannot stop a model reaching for a tool it has, and a session can meet a question genuinely worth
 * asking. What was missing is that asking made it disappear.
 *
 * `work-tick.mjs` calls this BEFORE its quiet exit, because a blocked session is most invisible exactly
 * when the queue is quiet: `afterGate` returns `deliver: false` on QUIET and `wake` never runs at all.
 */
test("a session herdr calls `blocked` is named, so asking a human cannot be silent", () => {
  assert.deepEqual(blockedSessions([
    { label: "worker-capture", status: "blocked" },
    { label: "ceo", status: "idle" },
    { label: "worker-judge", status: "working" },
  ]), ["worker-capture"]);
});

/**
 * THE POSITIVE CONTROL. A predicate that named every session would make the tick shout on every quiet
 * minute, which is how a real signal becomes something people filter out -- the failure this whole file
 * is written against one level up.
 */
test("no session is named when none is blocked, including a full and busy roster", () => {
  assert.deepEqual(blockedSessions([]), [], "an empty roster names nobody");
  assert.deepEqual(blockedSessions(WAKEABLE.map((status, i) => ({ label: `s${i}`, status }))), [],
    "every WAKEABLE status is the ordinary state and must never be reported");
  assert.deepEqual(blockedSessions([{ label: "a", status: "working" }, { label: "b", status: "unknown" }]), [],
    "`working` is the org doing its job; `unknown` is herdr not knowing, which is not the same claim as "
    + "a session stopped on a question and must not be reported as one");
});

test("several blocked sessions are all named, in the order herdr gave them", () => {
  assert.deepEqual(blockedSessions([
    { label: "reviewer", status: "blocked" },
    { label: "ceo", status: "idle" },
    { label: "worker-tooling", status: "blocked" },
  ]), ["reviewer", "worker-tooling"],
  "reporting only the first would leave the second exactly as invisible as before");
});

/**
 * ENDING A TURN WITH A QUESTION IS THE SAME AS STOPPING.
 *
 * `--disallowedTools AskUserQuestion` stopped a session raising a MENU and waiting. It did not stop a
 * session ending its turn with a question in prose, which has the same outcome: nobody reads the
 * terminal, so the work does not happen -- except this way it also looks like progress.
 *
 * MEASURED 2026-09-21: `product-manager` ended two consecutive turns this way. The second held a
 * COMPLETE, EVIDENCED ROW DRAFT -- two incidents, commit hashes, timestamps -- and asked permission to
 * file it, when filing is the first line of its own brief (`agent-practices.md`: "first reader for rows,
 * the queue and process ... filing and amendments"). The row did not get filed; the chairman filed it.
 *
 * The preamble already said "never stop and wait on a human", and that was satisfied LITERALLY: the
 * turn ended, nothing blocked. The instruction was about blocking; the failure was about the work.
 */
test("the preamble refuses a question as an ending, and says what to do instead", () => {
  const out = addressed({ prompt: "Do the thing." } as never, "product-manager");
  assert.match(out, /ENDING YOUR TURN WITH A QUESTION IS THE SAME AS STOPPING/);
  assert.match(out, /IF THE ACTION IS IN YOUR LANE, TAKE IT AND REPORT WHAT YOU DID/,
    "refusing the question is half an instruction -- it must name the alternative");
  assert.match(out, /answer:<session>/,
    "and for work that is genuinely not yours, route it rather than ask about it");
});

test("it names polling as the specific waste it is", () => {
  // The first of the two turns polled a PR for a verdict that `draft-awaiting-verdict` already has a
  // cause for -- a turn spent on a question the tick answers by itself.
  const out = addressed({ prompt: "Do the thing." } as never, "product-manager");
  assert.match(out, /polling a pull request for a verdict that has its own cause/);
  assert.match(out, /The gate will bring you back when something changes/,
    "a session must know that ending its turn is safe, or refusing to ask just becomes refusing to stop");
});

/**
 * A TRIPPED BREAKER MUST REACH A PERSON, NOT A JOURNAL.
 *
 * `MAX_DELIVERIES` is a circuit breaker and its reasoning is sound. What was missing is the half every
 * real breaker has: TRIPPING RAISES AN ALARM. This one wrote `STUCK <key>` to stderr and stopped.
 *
 * MEASURED 2026-09-21: two of `ceo`'s causes tripped, the tick printed `STUCK` every two minutes for
 * over half an hour, every session read idle, and the only thing that noticed was the chairman saying
 * "the AI agents have all stopped completely".
 */
test("a stuck cause labels its row needs:chairman", () => {
  const calls: string[][] = [];
  const out: string[] = [];
  const labelled = escalateStuck(["ceo/lane-backlog-unpromoted/row-1234: delivered 6 times"],
    (a: string[]) => { calls.push(a); return ""; }, (l: string) => out.push(l));
  assert.deepEqual(labelled, [1234]);
  assert.deepEqual(calls, [["issue", "edit", "1234", "--add-label", "needs:chairman"]]);
  assert.match(out.join(""), /ESCALATED #1234/);
});

test("a causeKey naming no row is reported, never guessed at", () => {
  // `chairman` and `ready-queue` are subjects, not rows. Labelling the wrong row would be worse than
  // labelling none, so it says so and moves on.
  const out: string[] = [];
  const labelled = escalateStuck(["ceo/chairman-blocked/0: delivered 6 times"],
    () => { throw new Error("must not be called"); }, (l: string) => out.push(l));
  assert.deepEqual(labelled, []);
  assert.match(out.join(""), /names no row/);
});

test("stuckRowOf reads row- and pr- keys and nothing else", () => {
  assert.equal(stuckRowOf("ceo/lane-backlog-unpromoted/row-1234"), 1234);
  assert.equal(stuckRowOf("reviewer/draft-awaiting-verdict/pr-1837/abc12345"), 1837);
  assert.equal(stuckRowOf("product-manager/ready-queue-empty/3"), null);
  assert.equal(stuckRowOf("ceo/org-stalled/55"), null);
});

test("a gh refusal is reported, never swallowed", () => {
  // A breaker whose alarm silently fails is the exact shape being fixed.
  const out: string[] = [];
  escalateStuck(["x/y/row-9: delivered 6 times"],
    () => { throw new Error("HTTP 403: forbidden"); }, (l: string) => out.push(l));
  assert.match(out.join(""), /COULD NOT ESCALATE #9: HTTP 403/);
});

// ---------------------------------------------------------------------------------------------------
// HANDOFFS -- THE AUTHORED ORDERS `prompt-session.mjs` COULD NOT DELIVER (#1966).
//
// `deliver` above has handled a busy target since #912: the order is simply not recorded, and the next
// tick offers it again. `prompt-session.mjs` had no equivalent -- it printed `NOT PROMPTED` and exited,
// and that was the end of the order. Measured 2026-09-22 on draft #1963: three refusals in 4m37s, no
// trace on the row, the PR, the ledger or any log.
//
// The half tested here is the delivery: what the queue holds, when it is dropped, and -- the case the
// whole thing turns on -- that an order NOT delivered is still there afterwards.

const HANDOFF = { id: handoffId("reviewer", "Draft #1963"), session: "reviewer",
  prompt: "Draft #1963", queuedAt: 1_000 };

/** A `run` that records every herdr invocation and never refuses. */
function recorder(): { run: (a: string[]) => string; calls: string[][] } {
  const calls: string[][] = [];
  return { run: (a: string[]) => { calls.push(a); return ""; }, calls };
}

test("an authored order's identity is its TARGET and its TEXT, and nothing else", () => {
  // Not a causeKey: there is no GitHub state to derive one from. Two calls that would send the same
  // words to the same session are the same order -- which is what makes an author's second, hopeful
  // attempt collapse into the first instead of clearing the reviewer twice.
  assert.equal(handoffId("reviewer", "Draft #1963"), handoffId("reviewer", "Draft #1963"));
  assert.notEqual(handoffId("reviewer", "Draft #1963"), handoffId("reviewer", "Draft #1965"));
  assert.notEqual(handoffId("reviewer", "Draft #1963"), handoffId("reviewer-2", "Draft #1963"));
  assert.match(handoffId("reviewer", "x"), /^handoff\/reviewer\/[0-9a-f]{8}$/,
    "and it names the target in the clear, so a queue is readable by eye");
});

test("the queue sits beside the ledger, under the SAME --ledger both halves are given", () => {
  // The author's command and the tick have to agree on one path or the order is written where nothing
  // looks. One definition, used by `prompt-session.mjs`, `wake.mjs` and `work-tick.mjs`.
  assert.equal(handoffQueuePath("/var/x/wake-ledger"), `/var/x/${HANDOFF_QUEUE_FILE}`);
  assert.equal(ledgerPathFrom(["--ledger=/tmp/l"]), "/tmp/l");
  assert.match(String(ledgerPathFrom([])), /\/\.cache\/a11ign\/wake-ledger$/);
});

test("queueing APPENDS -- two authors at once both land, with no lock between them", () => {
  const writes: { path: string; data: string; opts: unknown }[] = [];
  const entry = queueHandoff("/q/handoffs", {
    session: "reviewer", prompt: "Draft #1963", now: 1_000,
    write: ((p: string, d: string, o: unknown) => { writes.push({ path: p, data: d, opts: o }); }) as never,
    mkdir: (() => undefined) as never,
  });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].opts, { flag: "a" }, "O_APPEND, not read-modify-write: there is no lock");
  assert.equal(JSON.parse(writes[0].data).id, entry.id);
  assert.equal(entry.queuedAt, 1_000, "and the entry carries when it started waiting");
});

test("a duplicate collapses on READ, and the FIRST queuedAt survives", () => {
  // The age that matters is how long the order has been waiting, not when a hopeful second call
  // restated it. A later `queuedAt` winning would reset the staleness clock on every retry.
  const raw = [JSON.stringify({ ...HANDOFF, queuedAt: 1_000 }),
    JSON.stringify({ ...HANDOFF, queuedAt: 9_000 })].join("\n");
  const got = readHandoffs("q", (() => raw) as never);
  assert.equal(got.length, 1);
  assert.equal(got[0].queuedAt, 1_000);
});

test("a missing queue is empty; an unreadable one is NOT, and a malformed line THROWS", () => {
  const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });
  assert.deepEqual(readHandoffs("/nonexistent", (() => { throw enoent; }) as never), [],
    "nobody has queued anything yet -- the ordinary case");
  assert.throws(() => readHandoffs("/unreadable",
    (() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }) as never), /denied/);
  // `parseOrders`' rule, for its reason: a SKIPPED order is the defect this queue exists to remove, and
  // an order this script cannot read is still an order somebody is waiting on. The throw reaches
  // `work-tick`, which prints it -- loud within one tick beats quietly one prompt short.
  assert.throws(() => readHandoffs("q", (() => '{"session":"reviewer"}') as never),
    /missing id\/session\/prompt/);
});

test("A REFUSED HANDOFF STAYS QUEUED -- the assertion the whole row is about", () => {
  // The author is gone. If this tick drops the order because the reviewer is still busy, nothing else
  // in the world has a copy, and the draft is one nobody has been told about.
  const { run, calls } = recorder();
  const dropped: string[][] = [];
  const out = deliverHandoffs([HANDOFF], agents({ reviewer: "working" }), ROSTER,
    { run, queuePath: "/q", drop: ((_p: string, ids: string[]) => dropped.push(ids)) as never });

  assert.deepEqual(out.sent, []);
  assert.deepEqual(out.refused, [`${HANDOFF.id}: "reviewer" is working`]);
  assert.deepEqual(dropped.flat(), [], "NOTHING was removed from the queue");
  assert.deepEqual(calls, [], "and the busy session was not typed at -- the refusal is load-bearing");
  assert.deepEqual([...out.busied], []);
});

test("a delivered handoff is CLEARED first, then prompted, then and only then dropped", () => {
  const { run, calls } = recorder();
  const dropped: string[][] = [];
  const out = deliverHandoffs([HANDOFF], agents({ reviewer: "idle" }), ROSTER,
    { run, queuePath: "/q", now: 1_000,
      drop: ((_p: string, ids: string[]) => dropped.push(ids)) as never });

  assert.deepEqual(out.sent, [`reviewer <- ${HANDOFF.id}`]);
  assert.deepEqual(out.refused, []);
  const verbs = calls.map((a) => a.slice(2).join(" "));
  assert.equal(verbs[0], "agent prompt reviewer /clear", "the clear is why this command exists at all");
  assert.match(String(verbs.at(-1)), /^agent prompt reviewer You are `reviewer`/,
    "and the order arrives addressed, exactly as one the gate derived would");
  // REPORT BEFORE RECORD, read backwards: the queue IS the record, so removal is the receipt. A crash
  // between the prompt and this drop re-delivers -- visible -- rather than losing the order.
  assert.deepEqual(dropped, [[HANDOFF.id]]);
  assert.deepEqual([...out.busied], ["reviewer"],
    "and the session is marked busy, so the gate's own orders this tick go elsewhere");
});

test("a delivered order tells its reader HOW LONG it waited", () => {
  // A prompt written 40 minutes ago may name a head that has since moved, and `update-branch`
  // invalidates a verdict sha. Handing it over silently trades one invisible failure for another.
  const order = handoffOrder(HANDOFF, HANDOFF.queuedAt + 40 * 60_000);
  assert.equal(order.session, "reviewer");
  assert.equal(order.causeKey, HANDOFF.id);
  assert.ok(order.prompt.startsWith("Draft #1963"), "the author's own words come first, unaltered");
  assert.match(order.prompt, /Queued 40 minute\(s\) ago/);
  assert.match(order.prompt, /a head may have moved since/);
});

test("DELIVERY APPENDS, so nothing a concurrent author wrote can be collateral of it", () => {
  // #2009's blocker, pinned at its cause rather than at its symptom. The first cut re-read the queue and
  // rewrote it without the delivered ids, and an author appending between that read and that write lost
  // the append -- after `prompt-session.mjs` had already printed `QUEUED` and `DO NOT RETRY` to the only
  // process holding a copy. A writer that only ever appends has no such window to lose anything in.
  const writes: { data: string; opts: unknown }[] = [];
  dropHandoffs("/q", [HANDOFF.id], { now: 5_000,
    write: ((_p: string, d: string, o: unknown) => writes.push({ data: d, opts: o })) as never });

  assert.equal(writes.length, 1, "one short write, which is what makes O_APPEND atomic");
  assert.deepEqual(writes[0].opts, { flag: "a" },
    "THE ASSERTION THE FIX IS: no truncating write exists on this path at all");
  assert.deepEqual(JSON.parse(writes[0].data.trim()), { delivered: HANDOFF.id, at: 5_000 });
});

test("the reviewer's own reproduction: an append DURING the drop survives it", () => {
  // Reproduced against the committed function by injecting an append into the write callback -- which
  // left the queue empty and the concurrent order gone. The same injection, run against this one.
  const onDisk: string[] = [JSON.stringify(HANDOFF)];
  const racer = { id: "handoff/ceo/deadbeef", session: "ceo", prompt: "later", queuedAt: 2_000 };
  dropHandoffs("/q", [HANDOFF.id], {
    write: ((_p: string, d: string) => {
      onDisk.push(JSON.stringify(racer));   // the author's append, landing mid-drop
      onDisk.push(d.trim());
    }) as never,
  });

  const left = readHandoffs("/q", (() => onDisk.join("\n")) as never);
  assert.deepEqual(left.map((h) => h.id), [racer.id],
    "the delivered order is retired and the order queued during the tick is still there");
});

test("a delivered line retires only what PRECEDES it -- the same order sent again is live", () => {
  // `handoffId` is a hash of the target and the text, so an author who sends the same words to the same
  // session twice a day apart sends the same id twice. A set of retired ids consulted out of order would
  // swallow the second one in silence, which is this row's own defect one layer down.
  const again = { ...HANDOFF, queuedAt: 9_000 };
  const raw = [JSON.stringify(HANDOFF), JSON.stringify({ delivered: HANDOFF.id, at: 5_000 }),
    JSON.stringify(again)].join("\n");
  assert.deepEqual(readHandoffs("q", (() => raw) as never), [again],
    "and it carries the SECOND queuedAt -- this is a new wait, not a resumed one");

  const done = [JSON.stringify(HANDOFF), JSON.stringify({ delivered: HANDOFF.id, at: 5_000 })].join("\n");
  assert.deepEqual(readHandoffs("q", (() => done) as never), [],
    "the control: delivered and not re-sent reads as an empty queue");
});

test("dropping nothing writes nothing -- an empty delivery never touches the queue", () => {
  // A tick that delivered nothing has nothing to say, and a line per tick would grow the file for no
  // information at all.
  dropHandoffs("/q", [], { write: (() => { throw new Error("must not write"); }) as never });
});

test("ON A REAL FILE: queue, queue again mid-tick, deliver one -- and the other is still there", () => {
  // The seams above prove the SHAPE of every write; this proves the two halves agree about a real file
  // with real `O_APPEND` semantics. The order is deliberately the losing one under the old code: the
  // second author's append lands after this tick would have read the queue, and before it writes.
  const dir = mkdtempSync(join(tmpdir(), "wake-handoffs-"));
  try {
    const path = join(dir, HANDOFF_QUEUE_FILE);
    const first = queueHandoff(path, { session: "reviewer", prompt: "Draft #1963", now: 1_000 });
    const beingDelivered = readHandoffs(path);          // the tick reads
    const second = queueHandoff(path, { session: "ceo", prompt: "later", now: 2_000 });
    dropHandoffs(path, beingDelivered.map((h) => h.id));  // ... and only then writes

    assert.deepEqual(readHandoffs(path).map((h) => h.id), [second.id],
      "the delivered order is gone and the one queued during the tick survived it");
    assert.match(readFileSync(path, "utf8"), new RegExp(`"delivered":"${first.id.replace(/\//g, "\\/")}"`),
      "and the delivery is recorded as a line of its own, never as a line removed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an order nobody ever takes is NAMED, never silently held", () => {
  // A target that never becomes free -- a session herdr reports `unknown`, a label never started --
  // would otherwise hold an order in silence, which is this row's own defect moved one file over.
  const now = 10 * 60 * 60 * 1000;
  const fresh = { ...HANDOFF, queuedAt: now - 60_000 };
  const old = { ...HANDOFF, id: "handoff/ceo/1", queuedAt: now - HANDOFF_STALE_MS - 1 };
  assert.deepEqual(staleHandoffs([fresh], now).map((h) => h.id), [],
    "a minute old is the ordinary case, and must not be shouted about");
  assert.deepEqual(staleHandoffs([fresh, old], now).map((h) => h.id), ["handoff/ceo/1"]);
});

test("A QUIET GATE STILL RUNS wake WHEN AN ORDER IS QUEUED", () => {
  // The case the queue exists for is a reviewer who is busy REVIEWING -- which is very often a tick with
  // nothing else outstanding. Exiting on the gate's code alone would hold the order back exactly when it
  // is the only work there is, and the author was told something would deliver it.
  assert.deepEqual(afterGate(GATE.QUIET), { deliver: false, exit: TICK_EXIT.QUIET },
    "an empty queue is still a quiet tick");
  assert.deepEqual(afterGate(GATE.QUIET, { queued: 0 }), { deliver: false, exit: TICK_EXIT.QUIET });
  const queued = afterGate(GATE.QUIET, { queued: 2 });
  assert.equal(queued.deliver, true);
  assert.match(String(queued.why), /2 authored order\(s\) are queued/);
  assert.equal(afterGate(GATE.CANNOT_ASK, { queued: 2 }).deliver, false,
    "a gate that could not ask still stops the tick -- a queued order is not a reason to guess");
});

test("an empty stdin is NOT a quiet tick while an order is queued", () => {
  // `main` exits QUIET on this, and the case a queued order exists for is a reviewer busy REVIEWING --
  // very often a tick with nothing else outstanding. Reading an empty stdin as an empty org would hold
  // the order back exactly when it is the only work there is.
  assert.equal(nothingToDeliver([], []), true, "no orders and no queue really is a quiet tick");
  assert.equal(nothingToDeliver([], [HANDOFF]), false, "a queued order is work with no gate order behind it");
  assert.equal(nothingToDeliver([{ causeKey: "k" }], []), false);
});

// ---------------------------------------------------------------------------------------------------
// A QUEUE THAT NEVER DRAINS TO A SESSION THAT IS NEVER IDLE (#2102).
//
// #1966 replaced "NOT PROMPTED, and that was the end of the order" with a queue, which was right. What
// it did not decide is what happens when the drain condition never becomes true.
//
// MEASURED 2026-09-23 by replaying the live handoff queue -- `handoffQueuePath(ledgerPathFrom([]))`, and
// it is named that way rather than spelled out because `control-plane-checkout-is-one-fact.test.ts`
// classifies every directory a tracked file names under a home root, and this one is not its business --
// 59 orders pending, 57 of them for `product-manager` and every other session's queue empty, oldest
// 9.7h, 31 over two hours. Among them `ceo`'s own RULING on #2094, a STOP-THE-LINE, two MAIN IS RED
// reports and an ORG-WIDE report -- the ruling reached its target only because `ceo` sent it again by a
// path outside this mechanism. Nothing the tick printed said any of it.
//
// TWO DEFECTS, AND THE SECOND IS WHY THE FIRST WAS SURVIVABLE FOR TEN HOURS. The backlog was invisible;
// and `deliver` marks a session `working` the moment it accepts a prompt, so a per-order loop reached
// exactly ONE of the 57 per tick and refused the other 56 -- one order every two minutes against an
// inbox filling faster than that.

/** `n` orders for one session, `gap` minutes apart, oldest first -- the shape that actually occurred. */
function backlogOf(session: string, n: number, now: number, gap = 10): {
  id: string; session: string; prompt: string; queuedAt: number;
}[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `handoff/${session}/${String(i).padStart(4, "0")}`,
    session,
    prompt: `report ${i}`,
    queuedAt: now - (n - i) * gap * 60_000,
  }));
}

test("ONE DIALECT FOR A WAIT: minutes under the hour, hours above it", () => {
  // Two dialects would be read side by side in the same output. The minutes branch is `handoffOrder`'s
  // existing wording to the letter, so the sentence it has always printed is unchanged; "587 minute(s)"
  // is a number a reader has to do arithmetic on before it means anything.
  assert.equal(waitedFor(40 * 60_000), "40 minute(s)");
  assert.equal(waitedFor(0), "0 minute(s)");
  // A SMALL NEGATIVE PROVES NOTHING, and `npm run mutate` said so: `waitedFor(-5)` rounds to `-0`, which
  // a template literal prints as "0", so dropping the `Math.max(0, ms)` clamp is INVISIBLE at that
  // magnitude and the mutant survived. A clock that went backwards goes back by minutes or hours, not by
  // five milliseconds, and at that magnitude the clamp is the difference between "0 minute(s)" and
  // "-120 minute(s)" in a report somebody is meant to act on.
  assert.equal(waitedFor(-5), "0 minute(s)", "a clock that went backwards is not a negative wait");
  assert.equal(waitedFor(-2 * 3_600_000), "0 minute(s)",
    "and the magnitude that actually distinguishes the clamp: unclamped this reads -120 minute(s)");
  assert.equal(waitedFor(9.7 * 3_600_000), "9.7h", "the reading this row was filed on");
  assert.equal(waitedFor(60 * 60_000), "1.0h", "and the boundary belongs to hours");
});

test("THE BACKLOG IS A READING PER TARGET: count, oldest, and how many are stale", () => {
  // THE POSITIVE CONTROL for the empty case below -- this is the population being non-empty, and it is
  // the 2026-09-23 shape: one session holding everything while the others hold nothing.
  const now = 10 * 60 * 60 * 1000;
  // THE FRESH SESSION IS ALPHABETICALLY FIRST, DELIBERATELY. The first draft of this used `reviewer-2`,
  // which sorts after `product-manager` by name as well as by age -- so `sort by name` and `sort by worst
  // wait` agreed on the fixture and `npm run mutate` reported the name-sort mutant as a SURVIVOR. A
  // fixture where the two orderings agree cannot pin either of them.
  const got = handoffBacklog([...backlogOf("product-manager", 57, now),
    ...backlogOf("ceo", 1, now, 1)], now);

  assert.equal(got.length, 2, "one row per target, never one per order");
  assert.deepEqual(got.map((b) => b.session), ["product-manager", "ceo"],
    "WORST FIRST: the session whose oldest order has waited longest is the one to look at, and a "
    + "name sort would put `ceo` first");
  assert.equal(got[0].waiting, 57);
  assert.equal(waitedFor(got[0].oldestMs), "9.5h", "57 orders 10 minutes apart");
  assert.equal(got[0].stale, 46, "and how many of them passed the two-hour line");
  assert.equal(got[1].waiting, 1);
  assert.equal(got[1].stale, 0, "a one-minute-old order is the ordinary case");
});

test("equal ages sort by NAME, so the same queue prints the same way twice", () => {
  // `route`'s own rule, for its reason: a report that reorders itself between ticks cannot be diffed.
  const now = 1_000_000;
  const same = [{ id: "a", session: "zzz", prompt: "x", queuedAt: now - 5 },
    { id: "b", session: "aaa", prompt: "x", queuedAt: now - 5 }];
  assert.deepEqual(handoffBacklog(same, now).map((b) => b.session), ["aaa", "zzz"]);
  assert.deepEqual(handoffBacklog([...same].reverse(), now).map((b) => b.session), ["aaa", "zzz"]);
});

test("THE TICK REPORTS THE COUNT AND THE OLDEST AGE -- the row's own Acceptance", () => {
  const now = 10 * 60 * 60 * 1000;
  const lines = backlogReport(handoffBacklog(backlogOf("product-manager", 57, now), now)).join("");

  assert.match(lines, /QUEUE BACKLOG product-manager: 57 authored order\(s\) waiting/,
    "the count, per session, in the tick's own output rather than in a cache file read by hand");
  assert.match(lines, /oldest 9\.5h/, "and how long the oldest has waited");
  assert.match(lines, /46 over 2h/);
  assert.match(lines, /BETWEEN TASKS/,
    "with the one thing a count does not say: delivery waits on a state the TARGET controls");
  assert.doesNotMatch(lines, /handoff\/product-manager\/0001/,
    "and not 57 lines of ids, which is the shape that said nothing");
});

test("THE CONTROL: A QUIET QUEUE REPORTS NOTHING", () => {
  // Without this, every assertion above passes against a reporter that prints unconditionally, and the
  // tick grows a line that is noise on the overwhelming majority of ticks. This repo's Assertions rule
  // names where the positive control lives; it is the two tests immediately above.
  assert.deepEqual(handoffBacklog([]), []);
  assert.deepEqual(backlogReport([]), []);
  assert.deepEqual(backlogReport(handoffBacklog([])), []);
});

test("a backlog with nothing stale is reported WITHOUT the stalled-inbox warning", () => {
  // The warning is the loud half and it must stay loud. A queue two minutes deep is the mechanism
  // working, and shouting about it is how a reader learns to skip the line that matters.
  const now = 10 * 60 * 60 * 1000;
  const fresh = backlogReport(handoffBacklog(backlogOf("reviewer", 2, now, 1), now)).join("");
  assert.match(fresh, /QUEUE BACKLOG reviewer: 2 authored order\(s\) waiting/);
  assert.doesNotMatch(fresh, /over 2h/);
  assert.doesNotMatch(fresh, /BETWEEN TASKS/);
});

test("57 ORDERS FOR ONE SESSION ARE ONE DELIVERY, NOT 57 -- and all 57 are retired", () => {
  // THE THROUGHPUT DEFECT, pinned at its arithmetic. `deliver` marks a session `working` as soon as it
  // accepts a prompt, so the per-order loop this replaces sent ONE and refused 56 on every tick, for
  // ever. The old shape fails this on two counts at once: `refused` had 56 entries and `ids` had 1.
  const { run, calls } = recorder();
  const now = 10 * 60 * 60 * 1000;
  const out = deliverHandoffs(backlogOf("product-manager", 57, now),
    agents({ "product-manager": "idle" }), ROSTER, { run, now, queuePath: undefined });

  assert.equal(out.sent.length, 1, "one wake");
  assert.deepEqual(out.refused, [], "and nothing refused for being behind a session this tick just woke");
  assert.equal(out.ids.length, 57, "carrying every one of them");
  assert.equal(calls.filter((a) => a.includes("/clear")).length, 1,
    "AND CLEARED ONCE. 57 clears would have erased the context each previous order created (#1966)");
  const prompt = String(calls.at(-1)?.at(-1));
  assert.match(prompt, /57 ORDERS WERE QUEUED FOR YOU AND ARRIVE TOGETHER/);
  assert.match(prompt, /ORDER 1 of 57, queued 9\.5h ago/, "oldest first, each with its own age");
  assert.match(prompt, /ORDER 57 of 57, queued 10 minute\(s\) ago/);
  assert.match(prompt, /report 0\b/, "and every author's own words are in it");
  assert.match(prompt, /report 56\b/);
});

test("ONE order is still ONE order, with its own id and its own wording", () => {
  // The common case -- an author prompting one reviewer about one draft -- must not start reading like a
  // digest of itself, and `WOKE reviewer <- handoff/reviewer/1a2b3c4d` stays greppable back to the queue.
  const [only] = handoffBatches([HANDOFF], { now: HANDOFF.queuedAt + 40 * 60_000 });
  assert.equal(only.causeKey, HANDOFF.id, "not `batch-of-1`");
  assert.deepEqual(only.ids, [HANDOFF.id]);
  assert.equal(only.prompt, handoffOrder(HANDOFF, HANDOFF.queuedAt + 40 * 60_000).prompt,
    "byte-for-byte the sentence this file has printed since #1966");
  assert.doesNotMatch(only.prompt, /ARRIVE TOGETHER/);
});

test("A BATCH IS BOUNDED BY BYTES, AND THE KERNEL IS WHY", () => {
  // MEASURED ON THIS HOST 2026-09-23 by spawning `/bin/true` with arguments of increasing length:
  // 131,071 bytes is accepted and 131,072 is E2BIG -- `MAX_ARG_STRLEN`, 32 pages. `deliver` passes the
  // prompt as ONE argv entry. The queue that produced this row held 136,919 characters for one session,
  // so an unbounded "one delivery whose body is all 57 reports" would have failed E2BIG on the very
  // backlog it was written for.
  assert.equal(PROMPT_ARG_MAX, 131_072);
  assert.ok(HANDOFF_BATCH_BYTES * 2 <= PROMPT_ARG_MAX,
    "and the budget leaves the ceiling above it, because a single oversized order is taken anyway");

  const now = 10 * 60 * 60 * 1000;
  const big = backlogOf("product-manager", 40, now).map((h) => ({ ...h, prompt: "x".repeat(4_000) }));
  const [batch] = handoffBatches(big, { now, budget: HANDOFF_BATCH_BYTES });
  assert.equal(batch.ids.length, 15, "64 KiB of 4,000-byte reports, less what the framing costs");
  assert.ok(Buffer.byteLength(addressed(batch, "product-manager"), "utf8") < PROMPT_ARG_MAX,
    "THE ASSERTION THE BOUND IS FOR: what reaches execFileSync fits in one argument");
  assert.match(batch.prompt, /25 further order\(s\) for you did not fit/);
  assert.match(batch.prompt, /STILL QUEUED; the next tick brings them\. Nothing has been dropped/);
});

test("MANY TINY ORDERS OVERFLOW TOO, AND THE AUTHORED TEXT IS NOT WHAT THE KERNEL COUNTS", () => {
  // THE REVIEW BLOCKER ON #2125, PINNED. The budget used to charge only `h.prompt`, so 3,000 valid
  // ONE-BYTE orders cost 3,000 bytes of the 64 KiB and all 3,000 were carried -- while the argv that
  // `deliver` actually hands `execFileSync` rendered 165,408 bytes against the 131,072-byte ceiling.
  // The kernel refused it with E2BIG, herdr reported a refusal, `deliverHandoffs` retired nothing, and
  // the queue stalled exactly as this row describes. The per-order heading and the batch's own wrapper
  // are 50-odd bytes and 2 KB that nobody had charged for.
  //
  // THE FIXTURE IS THE CONFOUND THE OTHER BOUNDS TESTS LACK: their prompts are thousands of bytes each,
  // where framing is a rounding error and an uncharged heading changes no count. Here the framing is
  // FIFTY TIMES the authored text, so the two readings cannot agree.
  const now = 10 * 60 * 60 * 1000;
  const tiny = backlogOf("product-manager", 3_000, now, 1).map((h) => ({ ...h, prompt: "x" }));
  const [batch] = handoffBatches(tiny, { now, budget: HANDOFF_BATCH_BYTES });

  assert.equal(batch.ids.length, 1_280,
    "the batch is bounded by what it RENDERS, not by the 3,000 bytes its senders typed -- and the "
    + "EXACT count is pinned because the reserve is deliberately generous: an uncharged TERM (the "
    + "blank line between orders, the widest `of N` the batch can print) is absorbed by that slack "
    + "and hides, until the day somebody spends the slack on a longer header");
  const argv = Buffer.byteLength(addressed(batch, "product-manager"), "utf8");
  assert.ok(argv < PROMPT_ARG_MAX,
    `THE ASSERTION: ${argv} bytes reach execFileSync, under the kernel's ${PROMPT_ARG_MAX}`);
  assert.ok(argv <= HANDOFF_BATCH_BYTES,
    `and the budget bounds the RENDERED delivery: ${argv} bytes rendered against a ${HANDOFF_BATCH_BYTES}`
    + "-byte budget, which is what reserving the wrapper up front buys");
  assert.ok(argv > HANDOFF_BATCH_BYTES / 2,
    "and the bound is not achieved by carrying almost nothing -- a batch that fits by being empty "
    + "would satisfy the lines above and starve the queue it exists to drain");
  assert.match(batch.prompt, /further order\(s\) for you did not fit/,
    "with the remainder named to the reader, because a bound is never a drop");
});

test("A BATCH RESERVES MORE THAN THE WRAPPER IT ACTUALLY RENDERS", () => {
  // `BATCH_WRAPPER_BYTES` is a reserve taken before the first order is charged, and both things it
  // reserves for -- `batchedOrder`'s header and `addressed`'s prefix and footer -- are PROSE SOMEBODY
  // WILL EDIT. Prose that grows past its reserve has to fail here rather than at an execFileSync, so
  // this measures the rendered wrapper instead of trusting the comment that states its size.
  const now = 10 * 60 * 60 * 1000;
  const three = backlogOf("product-manager", 3, now);
  const [batch] = handoffBatches(three, { now });
  const rendered = addressed(batch, "product-manager");
  const orders = batch.ids.length;
  const body = three.reduce((n, h) => n + Buffer.byteLength(h.prompt, "utf8"), 0);
  const headings = /--- ORDER \d+ of \d+, queued [^\n]+ ---/g;
  const framing = (batch.prompt.match(headings) ?? [])
    .reduce((n, s) => n + Buffer.byteLength(s, "utf8") + "\n".length, 0);
  const wrapper = Buffer.byteLength(rendered, "utf8") - body - framing - (orders - 1) * "\n\n".length;

  assert.equal(orders, 3, "three orders rendered, so the subtraction above is over a real batch");
  assert.ok(wrapper > 0 && wrapper < BATCH_WRAPPER_BYTES,
    `the header and wrapper render ${wrapper} bytes, inside the ${BATCH_WRAPPER_BYTES}-byte reserve`);
});

test("THE BUDGET COUNTS BYTES, AND AN EM DASH COSTS THREE OF THEM", () => {
  // `npm run mutate` reported `fitBatch counts characters, not bytes` as a SURVIVOR: the test above
  // fills its prompts with "x", where a character IS a byte, so both readings agree and neither is
  // pinned. THE REAL QUEUE IS FULL OF EM DASHES -- this repo writes them everywhere -- and the ceiling
  // `fitBatch` exists to stay under counts bytes. A character count would therefore let roughly three
  // times as much text into one argv as the kernel accepts, which is E2BIG with extra steps.
  const now = 10 * 60 * 60 * 1000;
  const wide = backlogOf("product-manager", 60, now).map((h) => ({ ...h, prompt: "\u2014".repeat(4_000) }));
  assert.equal(Buffer.byteLength(wide[0].prompt, "utf8"), 12_000, "4,000 characters, 12,000 bytes");

  const [batch] = handoffBatches(wide, { now, budget: HANDOFF_BATCH_BYTES });
  assert.equal(batch.ids.length, 5, "five orders of 12,000 bytes fit in 64 KiB; a sixth does not");
  assert.ok(Buffer.byteLength(addressed(batch, "product-manager"), "utf8") < PROMPT_ARG_MAX,
    "THE ASSERTION THE BOUND IS FOR, in the encoding the kernel uses: counting characters here would "
    + "have taken 15 orders, 180,000 bytes, and been refused by execFileSync");
});

test("THE NAME IS SUBSTITUTED AFTER THE BUDGET, SO THE BUDGET HAS TO KNOW HOW WIDE IT IS", () => {
  // THE SECOND REVIEW BLOCKER ON #2125, PINNED. `chargeFor` moved the budget off the authored text and
  // onto the heading and the wrapper -- and `addressed` still does one more thing to the body before
  // `execFileSync` sees it: it replaces every `<you>` with the target's name. `work-gate.mjs` writes
  // that placeholder into the row orders it queues, so this is the real corpus and not a contrivance.
  // `<you>` is five bytes; `worker-capture` is fourteen. Reproduced by the reviewer at `43f5e65e`:
  // 3,000 `engineers` orders repeating `<you>` 100 times were charged as 112 fitting and rendered
  // 163,952 bytes -- past the 65,536-byte budget AND past the kernel's 131,072-byte ceiling.
  //
  // THE FIXTURE IS THE CONFOUND: an order is 500 authored bytes and 1,400 rendered ones, so a charge
  // taken before substitution and a charge taken after it cannot agree.
  const now = 10 * 60 * 60 * 1000;
  const withPlaceholder = backlogOf("engineers", 3_000, now, 1)
    .map((h) => ({ ...h, prompt: "<you>".repeat(100) }));
  const [batch] = handoffBatches(withPlaceholder, { now, budget: HANDOFF_BATCH_BYTES, roster: ROSTER });

  const widest = ROSTER.reduce((a, b) => (b.length > a.length ? b : a));
  const argv = Buffer.byteLength(addressed(batch, widest), "utf8");
  assert.ok(argv <= HANDOFF_BATCH_BYTES,
    `THE ASSERTION: ${argv} bytes reach execFileSync after substitution, inside the `
    + `${HANDOFF_BATCH_BYTES}-byte budget -- charged before the fix, this rendered 163,952`);
  assert.ok(argv < PROMPT_ARG_MAX, `and under the kernel's ${PROMPT_ARG_MAX}`);
  assert.ok(argv > HANDOFF_BATCH_BYTES / 2,
    "and the bound is not achieved by carrying almost nothing -- a batch that fits by being empty "
    + "would satisfy both lines above and starve the queue it exists to drain");
  assert.match(batch.prompt, /<you>/,
    "sanity: the placeholder really is still in the body the budget charged, so the substitution "
    + "below is what changes its size");
  assert.doesNotMatch(addressed(batch, widest), /<you>/,
    "and it is all gone after `addressed`, which is why the charge has to anticipate it");

  // THE CONTROL, and it is the whole finding: the SAME 500 authored bytes with no placeholder in them
  // fit MORE orders, because nothing expands. A charge on the authored text alone cannot tell these
  // two fixtures apart -- it takes the same count for both, and only one of them renders inside the
  // budget.
  const inert = withPlaceholder.map((h) => ({ ...h, prompt: "xxxxx".repeat(100) }));
  const [control] = handoffBatches(inert, { now, budget: HANDOFF_BATCH_BYTES, roster: ROSTER });
  assert.ok(control.ids.length > batch.ids.length,
    `the placeholder costs the batch orders: ${batch.ids.length} carried against ${control.ids.length} `
    + "for byte-identical authored text that does not expand");
  assert.ok(Buffer.byteLength(addressed(control, widest), "utf8") <= HANDOFF_BATCH_BYTES,
    "and the control is inside the budget too, so the difference above is the expansion and not a "
    + "batch that was over-charged into fitting");
});

test("A NAMED TARGET IS CHARGED EXACTLY; THE ENGINEER POOL IS CHARGED AT ITS WIDEST", () => {
  // `handoffBatches` runs BEFORE `route` picks the engineer, so for the pool there is no name to charge
  // and the charge has to hold whichever way the routing goes. Under-charging here is E2BIG; the only
  // safe reading of an unknown target is the widest one it could be.
  assert.equal(targetLabelBytes("reviewer-2"), "reviewer-2".length,
    "a named session renders its own name and nothing else");
  assert.equal(targetLabelBytes("engineers", ROSTER),
    Math.max(...ROSTER.map((l) => l.length)),
    "the pool renders whichever roster member is free, so it is charged at the widest of them");
  assert.ok(Math.max(...ROSTER.map((l) => l.length)) > "engineers".length,
    "and the roster really is wider than the pool's own name, so the line above is not a tautology");
  assert.equal(targetLabelBytes("engineers", []), "<you>".length,
    "an empty roster charges no expansion: with no engineer to route to, `deliver` refuses the batch "
    + "and no argv is ever built");
  assert.equal(targetLabelBytes("ceo"), 3,
    "and a name NARROWER than the placeholder charges its own width, never a negative expansion");
});

test("THE CALL SITE IS CHARGED TOO -- deliverHandoffs budgets against the roster it routes to", () => {
  // THE MUTANT THAT SURVIVED THE TWO TESTS ABOVE, and it is the whole reason this one exists.
  // `handoffBatches` TAKES the roster, so both of them pass against a `deliverHandoffs` that never
  // passes one -- an `engineers` batch would then be charged `<you>`'s own five bytes per occurrence
  // and every order in it under-charged. Dropping `roster` from the one call in `deliverHandoffs`
  // changed NO assertion: 0 red, 119 green.
  //
  // SO THE SUBJECT IS THE ARGV, READ OFF THE RECORDER. `deliver` hands exactly one string to
  // `execFileSync`, and that string is the only thing the kernel ever measures -- an argument to a
  // helper is not.
  const now = 10 * 60 * 60 * 1000;
  const queued = backlogOf("engineers", 3_000, now, 1)
    .map((h) => ({ ...h, prompt: "<you>".repeat(100) }));
  const { run, calls } = recorder();

  const out = deliverHandoffs(queued, agents({ "worker-capture": "idle" }), ROSTER, { run, now });

  const orders = calls.filter((a) => a[2] === "agent" && a[3] === "prompt" && a[5] !== "/clear");
  assert.equal(orders.length, 1, "one batch, one prompt -- the coalescing this row is about");
  assert.equal(orders[0][4], "worker-capture",
    "routed to the widest roster label, which is the one `targetLabelBytes` charged for");
  const argv = Buffer.byteLength(String(orders[0][5]), "utf8");
  assert.ok(argv <= HANDOFF_BATCH_BYTES,
    `THE ASSERTION: ${argv} bytes are handed to execFileSync, inside the ${HANDOFF_BATCH_BYTES}-byte `
    + "budget -- with the roster dropped from the call this renders past it");
  assert.ok(argv < PROMPT_ARG_MAX, `and under the kernel's ${PROMPT_ARG_MAX}`);
  assert.ok(argv > HANDOFF_BATCH_BYTES / 2,
    "and it carries a real batch rather than fitting by being nearly empty");
  assert.ok(out.ids.length > 1 && out.ids.length < queued.length,
    `${out.ids.length} of ${queued.length} carried: a batch, and a remainder still queued`);
});

test("WHAT DID NOT FIT STAYS QUEUED -- a bound must never be a drop", () => {
  const now = 10 * 60 * 60 * 1000;
  const big = backlogOf("product-manager", 40, now).map((h) => ({ ...h, prompt: "x".repeat(4_000) }));
  const { run } = recorder();
  const dropped: string[][] = [];
  const out = deliverHandoffs(big, agents({ "product-manager": "idle" }), ROSTER,
    { run, now, queuePath: "/q", drop: ((_p: string, ids: string[]) => dropped.push(ids)) as never });

  assert.equal(out.ids.length, 15);
  assert.deepEqual(dropped, [out.ids], "only what the accepted batch carried is retired");
  const left = big.filter((h) => !new Set(out.ids).has(h.id));
  assert.equal(left.length, 25, "and the remainder is still there for the next tick");
  assert.deepEqual(handoffBacklog(left, now).map((b) => b.waiting), [25],
    "where the backlog report will name it -- the wait is made visible, never overridden");
});

test("FIFO: the oldest order is in the batch, whatever it costs", () => {
  // The failure being fixed is an order that waited ten hours. Filling a batch with whatever is newest
  // would starve exactly that order for ever while the queue looked like it was draining -- and a single
  // order bigger than the budget must still be attempted, for the same reason.
  const now = 10 * 60 * 60 * 1000;
  const huge = { id: "handoff/ceo/huge", session: "ceo", prompt: "y".repeat(HANDOFF_BATCH_BYTES * 2),
    queuedAt: now - 9 * 3_600_000 };
  const small = { id: "handoff/ceo/small", session: "ceo", prompt: "later", queuedAt: now - 60_000 };
  const { take, held } = fitBatch([small, huge], HANDOFF_BATCH_BYTES);
  assert.deepEqual(take.map((h) => h.id), [huge.id], "the oldest is taken even though it alone overflows");
  assert.deepEqual(held.map((h) => h.id), [small.id]);
});

test("each target gets its OWN delivery, and a busy one blocks only its own", () => {
  // The queue is per session and so is the stall. `product-manager` being unreachable must not hold an
  // order addressed to a reviewer who is sitting idle.
  const { run } = recorder();
  const now = 10 * 60 * 60 * 1000;
  const out = deliverHandoffs([...backlogOf("product-manager", 3, now), ...backlogOf("reviewer-2", 2, now)],
    agents({ "product-manager": "working", "reviewer-2": "idle" }), ROSTER, { run, now });

  assert.deepEqual([...out.busied], ["reviewer-2"]);
  assert.equal(out.ids.length, 2, "the reviewer's two orders landed");
  assert.deepEqual(out.refused, ['handoff/product-manager/batch-of-3: "product-manager" is working'],
    "ONE refusal for the stalled inbox, not three -- and it names how many it was carrying");
});

test("a refused BATCH retires nothing at all, not even part of it", () => {
  // The assertion the whole queue is for, at the batch's granularity: nothing leaves the queue until
  // herdr has accepted the delivery that carried it. Partial credit here would lose orders silently.
  const { run, calls } = recorder();
  const now = 10 * 60 * 60 * 1000;
  const dropped: string[][] = [];
  const out = deliverHandoffs(backlogOf("product-manager", 20, now),
    agents({ "product-manager": "working" }), ROSTER,
    { run, now, queuePath: "/q", drop: ((_p: string, ids: string[]) => dropped.push(ids)) as never });

  assert.deepEqual(out.ids, []);
  assert.deepEqual(dropped.flat(), [], "NOTHING was removed from the queue");
  assert.deepEqual(calls, [], "and the busy session was not typed at -- the refusal is load-bearing");
});

test("AN ORDER JUST DELIVERED IS NOT ANNOUNCED AS 'still not delivered'", () => {
  // `main` prints `STALE QUEUED ORDER <id> ... still not delivered` for anything past two hours, and
  // built those lines from the PRE-delivery list -- so an order handed over seconds earlier was announced
  // as undelivered. With a batch retiring dozens at once that is dozens of false statements per tick, in
  // the one output an operator is meant to trust.
  const { run } = recorder();
  const now = 10 * 60 * 60 * 1000;
  const queued = backlogOf("product-manager", 30, now);
  const out = deliverHandoffs(queued, agents({ "product-manager": "idle" }), ROSTER, { run, now });

  // THE POSITIVE CONTROL, and it is the pre-fix behaviour exactly: told nothing was retired, the same
  // function names every stale order. So the empty result below is a subtraction, not a mute reporter.
  const pretendNothingLanded = staleReport(queued, [], now);
  assert.ok(pretendNothingLanded.length > 0, "these orders ARE stale by age");
  assert.match(String(pretendNothingLanded[0]), /STALE QUEUED ORDER handoff\/product-manager\/.* still not delivered/);

  assert.equal(out.ids.length, 30, "the delivery carried all of them");
  assert.deepEqual(staleReport(queued, out.ids, now), [],
    "and none is announced as waiting, because none is");
});

test("stale lines survive for what the delivery did NOT carry", () => {
  // The other half: a bound that leaves orders behind must leave their stale lines behind too, or the
  // subtraction above would have silenced the very backlog this row is about.
  const now = 10 * 60 * 60 * 1000;
  const queued = backlogOf("product-manager", 30, now);
  const carried = queued.slice(0, 10).map((h) => h.id);
  const lines = staleReport(queued, carried, now).join("");
  assert.doesNotMatch(lines, new RegExp(queued[0].id.replace("/", "\\/")), "carried: not announced");
  assert.match(lines, new RegExp(queued[15].id.replace(/\//g, "\\/")), "left behind: still announced");
});

// ---------------------------------------------------------------------------------------------------
// THE TICK ITSELF, RUN AS A PROCESS.
//
// THE REVIEW BLOCKER THIS CLOSES (#2125 at `43f5e65e`): every assertion above drives `handoffBacklog`
// and `backlogReport` directly, and the reviewer deleted the ONE call that joins them to the tick --
// `wake.mjs`'s `for (const line of backlogReport(handoffBacklog(handoffs)))` -- and watched all 114
// tests stay green. Two functions that work and are never called is precisely the shape of the defect
// #2102 is about: a fact the org could have printed and did not.
//
// SO THE SUBJECT HERE IS THE ENTRY POINT, not an export of it. `herdr` is a stub on PATH rather than a
// seam, because the seam is what the deleted line went around -- a test that injects one cannot fail
// for the deletion. This file's own header says these tests never stand up a running org, and that
// still holds: nothing here starts an agent, and the stub answers one question with one literal.

const WAKE_ENTRY = fileURLToPath(new URL("../wake.mjs", import.meta.url));
const STUB_MODE = 0o755; // the tick invokes `herdr` as a command, so the stub has to be runnable

/** herdr answering with one session in `status`, or refusing outright when `status` is null. */
const herdrStub = (status: string | null) => (status === null
  ? "#!/bin/sh\nexit 1\n"
  : "#!/bin/sh\ncase \"$*\" in\n  *'workspace list') printf '%s' "
    + `'{"result":{"workspaces":[{"label":"product-manager","agent_status":"${status}"}]}}'`
    + " ;;\n  *) : ;;\nesac\n");

/** One real tick: the queue on disk, the gate's orders on stdin, and herdr stubbed on PATH. */
function runTick({ queued, stdin = "", herdr = "working" as string | null }:
  { queued: { id: string; session: string; prompt: string; queuedAt: number }[];
    stdin?: string; herdr?: string | null }) {
  const dir = mkdtempSync(join(tmpdir(), "wake-tick-"));
  try {
    const ledger = join(dir, "wake-ledger");
    const stub = join(dir, "herdr");
    writeFileSync(stub, herdrStub(herdr));
    chmodSync(stub, STUB_MODE);
    writeFileSync(handoffQueuePath(ledger), queued.map((h) => JSON.stringify(h)).join("\n") + "\n");
    return spawnSync(process.execPath, [WAKE_ENTRY, `--ledger=${ledger}`], {
      input: stdin, encoding: "utf8",
      env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}` },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("THE TICK PRINTS THE BACKLOG -- the entry point, not the two functions it calls", () => {
  const now = Date.now();
  const ages = [9.5, 8.5, 7.5]; // hours, so all three are stale and the oldest is the row's own 9.5h
  const queued = backlogOf("product-manager", ages.length, now)
    .map((h, i) => ({ ...h, queuedAt: now - ages[i] * 3_600_000 }));
  const ran = runTick({ queued });

  assert.match(ran.stderr, /QUEUE BACKLOG product-manager: 3 authored order\(s\) waiting/,
    "THE ASSERTION THE BLOCKER ASKED FOR: deleting the tick's own `backlogReport(handoffBacklog(...))` "
    + "call leaves this line unprinted, and this test red -- where every unit test above stays green");
  assert.match(ran.stderr, /oldest 9\.5h/, "with the age that made this row worth filing");
  assert.match(ran.stderr, /3 over 2h/);
  assert.match(ran.stderr, /BETWEEN TASKS/, "and the stalled-inbox warning, because all three are stale");
  assert.match(ran.stderr, /UNDELIVERED .*"product-manager" is working/,
    "and the tick really did run to its end: the stub says the target is mid-turn, so the batch is "
    + "refused and stays queued -- the backlog is reported BEFORE that and regardless of it");
  assert.equal(ran.status, 1, "an order with nowhere to go is ATTENTION, not a quiet tick");
});

test("THE CONTROL: A REAL TICK OVER A QUIET QUEUE SAYS NOTHING ABOUT A BACKLOG", () => {
  // Without this the test above passes against a tick that prints the header unconditionally, and the
  // line becomes noise on the overwhelming majority of ticks. The gate's own order on stdin is what
  // keeps the tick from exiting QUIET before it would have printed anything at all -- an empty tick
  // proves nothing here.
  const order = JSON.stringify({ session: "product-manager", causeKey: "row/1", prompt: "a row" });
  const ran = runTick({ queued: [], stdin: `${order}\n` });

  assert.doesNotMatch(ran.stderr, /QUEUE BACKLOG/, "nothing is waiting, so nothing is said");
  assert.match(ran.stderr, /UNDELIVERED row\/1/,
    "and the tick reached its delivery, so the silence above is a quiet queue rather than a tick that "
    + "stopped before the report");
});

test("A TICK THAT CANNOT REACH herdr STILL PRINTS THE BACKLOG -- the worst tick to be silent on", () => {
  // `readAgents` returning null exits the tick without delivering anything, so this is the one tick
  // where a ten-hour backlog is most worth saying and the least likely to be said. The report sits
  // ABOVE that exit for exactly this case.
  const now = Date.now();
  const queued = backlogOf("product-manager", 2, now, 10).map((h) => ({ ...h, queuedAt: now - 3_600_000 }));
  const ran = runTick({ queued, herdr: null });

  assert.match(ran.stderr, /QUEUE BACKLOG product-manager: 2 authored order\(s\) waiting/);
  assert.match(ran.stderr, /CANNOT ASK: herdr did not answer/, "and the tick did take that exit");
  assert.equal(ran.status, 2, "CANNOT_ASK");
});

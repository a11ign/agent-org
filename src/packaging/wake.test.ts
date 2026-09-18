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
import { route, undelivered, parseOrders, readLedger, deliver, readAgents, WAKEABLE, EXIT,
  WAKE_TTL_MS, MAX_DELIVERIES, deliveryCounts }
  from "../wake.mjs";
import { afterGate, GATE, EXIT as TICK_EXIT } from "../work-tick.mjs";
import { spawnInvocation, addressed, clearContext, CLEAR_TIMEOUT_MS, CLEAR_SETTLE_MS }
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
  const ancient = Date.now() - 10 * WAKE_TTL_MS;
  const raw = [`${ancient}\tk`, `${ancient + 1}\tk`, `${Date.now()}\tk`].join("\n");
  assert.equal(deliveryCounts("x", () => raw).get("k"), 3,
    "reading only the live window would report 1 for a cause on its fortieth attempt");
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
test("a JUDGMENT cause does not expire -- its answer is durable until the state moves", () => {
  const stale = `${Date.now() - WAKE_TTL_MS * 3}\torchestrator/lane-backlog-unpromoted/lane:orchestrator/1`;
  const judgment = new Set(["lane-backlog-unpromoted"]);
  assert.deepEqual([...readLedger("x", () => stale, Date.now(), judgment)],
    ["orchestrator/lane-backlog-unpromoted/lane:orchestrator/1"],
    "re-asking buys a model turn to reach a conclusion somebody already reached");
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

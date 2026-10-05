// no-token: gh -- every `herdr` and claim here is an injected seam; nothing imported spawns the real one
/**
 * #3546: A SPAWNED ENGINEER'S FIRST PROMPT IS CONFIRMED SUBMITTED, AND A REFUSED WAKE IS NEVER LOGGED DELIVERED.
 *
 * Found by the chairman, 2026-10-04: `WOKE worker-3544 <- ... (STARTED sonnet/high)` and the same for `worker-3486`, and herdr showed
 * both idle with the prompt TYPED in the box and no turn ever started, for 16 and 10 minutes. The gate had logged the wake as
 * delivered because `agent prompt` returned. Every case below drives `deliver` itself against a fake pane that models what
 * the live one did, so the decision under test is the wake path's own and not a copy of it.
 *
 * WHERE THE POSITIVE CONTROLS ARE. The Enter test is read against the control beside it: the same pane, the same order, where
 * the prompt DOES start a turn, must send no Enter at all -- or "one Enter, then undelivered" would pass for a gate that
 * presses Enter on everything. The refusal tests are read against a control in which the refusal is harmless.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deliver, READY_BOUND_MS, SUBMIT_BOUND_MS, ENTER_BOUND_MS } from "../wake.mjs";

const ORDER = {
  session: "engineers",
  cause: "ready-row-unclaimed",
  causeKey: "engineers/ready-row-unclaimed/3546",
  prompt: "Ready row #3546 is unclaimed. Claim it with `--session=<you>`.",
};
const ROSTER = ["worker-capture", "worker-judge", "worker-tooling"];
const BUSY = ROSTER.map((label) => ({ label, status: "working" }));
const CLAIMED = { row: 3546, branch: "agent/first-prompt-3546", worktree: "/tmp/wt-3546", launchDir: "/tmp" };

/** What the pane does after the prompt, as the live one did. */
type Pane = {
  /** Does the prompt start a turn on its own? `false` is the bug: the text is typed and the submit landed as a newline. */
  promptStartsTurn: boolean;
  /** Does one Enter submit what is in the box? */
  enterStartsTurn?: boolean;
  /** `interactive_ready` as `agent get` reports it; `false` for the whole run models an agent that never gets there. */
  ready?: boolean;
};

/** A `herdr` that is one pane: it records every call and answers `agent get` from the state the calls leave it in. */
function pane({ promptStartsTurn, enterStartsTurn = false, ready = true }: Pane) {
  const calls: string[][] = [];
  let status = "idle";
  const run = (args: string[]) => {
    calls.push(args);
    const verb = args.slice(2, 4).join(" ");
    if (verb === "workspace create") {
      return JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } });
    }
    if (verb === "agent get") {
      return JSON.stringify({ result: { agent: { agent_status: status, interactive_ready: ready, state_change_seq: 1 } } });
    }
    if (verb === "agent prompt" && promptStartsTurn) status = "working";
    if (verb === "agent send-keys" && enterStartsTurn) status = "working";
    return "{}";
  };
  const said = (verb: string) => calls.map((c) => c.slice(2).join(" ")).filter((s) => s.startsWith(verb));
  return { run, said };
}

/** A claimer that records what is released; `claim` answers as a row claimed for the role. */
function claimer() {
  const released: string[] = [];
  return {
    released,
    claim: () => CLAIMED,
    release: (_claimed: unknown, role: string) => { released.push(role); return " -- the claim on #3546 was released"; },
  };
}

const noWait = () => {};
const spawnInto = (p: ReturnType<typeof pane>, extra = {}) => {
  const c = claimer();
  const record: string[] = [];
  const got = deliver([ORDER], BUSY, ROSTER,
    { run: p.run, sleep: noWait, claimer: c, record: (key: string) => { record.push(key); }, ...extra });
  return { got, record, released: c.released };
};

test("(a) the prompt is typed and the agent stays idle: ONE Enter, then UNDELIVERED -- never STARTED, never recorded", () => {
  const p = pane({ promptStartsTurn: false });
  const { got, record, released } = spawnInto(p);
  assert.equal(p.said("agent send-keys").length, 1, "exactly one Enter");
  assert.match(p.said("agent send-keys")[0], /^agent send-keys worker-3546 enter$/);
  assert.deepEqual(got.sent, [], "a wake that did not start a turn is not a STARTED line");
  assert.equal(got.refused.length, 1, JSON.stringify(got));
  assert.match(got.refused[0], /never started a turn: still idle/);
  assert.deepEqual(record, [], "and the ledger does not count it delivered");
  assert.equal(p.said("workspace close").length, 1, "the pane with the typed text is closed, so a retry is not a second copy on top of it");
  assert.deepEqual(released, ["worker-3546"], "and the claim is released, so the row reads unclaimed and the gate offers it again");
});

test("(b) CONTROL: the same pane where the prompt starts a turn gets NO Enter, and is DELIVERED", () => {
  const p = pane({ promptStartsTurn: true });
  const { got, record, released } = spawnInto(p);
  assert.deepEqual(p.said("agent send-keys"), [], "the Enter is evidence-driven, not unconditional");
  assert.deepEqual(got.sent, ["worker-3546 <- engineers/ready-row-unclaimed/3546 (STARTED sonnet/high)"]);
  assert.deepEqual(got.refused, []);
  assert.deepEqual(record, [ORDER.causeKey]);
  assert.deepEqual(p.said("workspace close"), []);
  assert.deepEqual(released, []);
});

test("(b2) an Enter that DOES submit rescues the wake: one Enter, then delivered", () => {
  const p = pane({ promptStartsTurn: false, enterStartsTurn: true });
  const { got, record } = spawnInto(p);
  assert.equal(p.said("agent send-keys").length, 1);
  assert.equal(got.sent.length, 1, JSON.stringify(got));
  assert.deepEqual(got.refused, []);
  assert.deepEqual(record, [ORDER.causeKey]);
});

test("(d) an agent that never reports interactive-ready is typed NOTHING, and is UNDELIVERED with that reason", () => {
  const p = pane({ promptStartsTurn: true, ready: false });
  const { got, record, released } = spawnInto(p);
  assert.deepEqual(p.said("agent prompt"), [], "nothing is typed into a pane that is not ready");
  assert.deepEqual(got.sent, []);
  assert.match(got.refused[0], /never reported it interactive-ready within 30s/);
  assert.deepEqual(record, []);
  assert.deepEqual(released, ["worker-3546"]);
});

test("the bounds are the ones the row names: 30 s to be ready, 30 s to start a turn, then one Enter and a short wait", () => {
  assert.equal(READY_BOUND_MS, 30_000);
  assert.equal(SUBMIT_BOUND_MS, 30_000);
  assert.ok(ENTER_BOUND_MS > 0 && ENTER_BOUND_MS <= SUBMIT_BOUND_MS);
  const slept: number[] = [];
  const p = pane({ promptStartsTurn: false });
  deliver([ORDER], BUSY, ROSTER, { run: p.run, sleep: (ms: number) => { slept.push(ms); }, claimer: claimer() });
  const total = slept.reduce((a, b) => a + b, 0);
  assert.ok(total >= SUBMIT_BOUND_MS + ENTER_BOUND_MS && total < SUBMIT_BOUND_MS + ENTER_BOUND_MS + 2_000,
    `the gate waited ${total} ms in all, not unbounded and not short`);
});

// --- a refusal is never reported as delivery -----------------------------------------------------------------------

const STANDING = [{ label: "product-manager", status: "idle" }];
const TO_PM = { session: "product-manager", causeKey: "product-manager/answer-owed/row-1", prompt: "p" };

/** A seat whose `/clear` is refused with herdr's own error on stderr, as `execFileSync` raises it. */
function refusingClear(code: string) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[5] === "/clear") {
      throw Object.assign(new Error("Command failed: herdr --session org agent prompt product-manager /clear"),
        { stderr: `{"error":{"code":"${code}","message":"agent target product-manager not found"},"id":"cli:agent:prompt"}\n` });
    }
    return "{}";
  };
  return { run, typedOrder: () => calls.some((c) => c[3] === "prompt" && c[5] !== "/clear") };
}

test("(c) a context command answered `agent_not_found` is UNDELIVERED with herdr's words, and the order is not typed", () => {
  const h = refusingClear("agent_not_found");
  const got = deliver([TO_PM], STANDING, ROSTER, { run: h.run, sleep: noWait, record: () => {} });
  assert.deepEqual(got.sent, []);
  assert.equal(got.refused.length, 1);
  assert.match(got.refused[0], /agent_not_found/);
  assert.equal(h.typedOrder(), false, "an agent that is gone is not typed at");
});

test("(c) CONTROL: a refusal that leaves the session reachable still delivers, on the DELIVERED line, and says so without 'delivered anyway'", () => {
  const h = refusingClear("agent_blocked");
  const got = deliver([TO_PM], STANDING, ROSTER, { run: h.run, sleep: noWait, record: () => {} });
  assert.equal(h.typedOrder(), true);
  assert.deepEqual(got.refused, [], "one order, one status: delivered, so not also UNDELIVERED");
  assert.equal(got.sent.length, 1);
  assert.match(got.sent[0], /\/clear refused \(.*agent_blocked/, "the refusal rides on the delivered line");
});

test("no outcome above says 'delivered anyway': the phrase claimed a delivery nobody checked", () => {
  const lines = [
    ...spawnInto(pane({ promptStartsTurn: false })).got.refused,
    ...spawnInto(pane({ promptStartsTurn: true })).got.sent,
    ...deliver([TO_PM], STANDING, ROSTER, { run: refusingClear("agent_not_found").run, sleep: noWait }).refused,
    ...deliver([TO_PM], STANDING, ROSTER, { run: refusingClear("agent_blocked").run, sleep: noWait }).sent,
  ];
  assert.ok(lines.length >= 4, "the positive control: the loop above read four outcomes");
  for (const line of lines) assert.doesNotMatch(line, /delivered anyway/);
});

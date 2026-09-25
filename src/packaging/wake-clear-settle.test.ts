// no-token: clearContext -- every herdr call is the injected `run`; nothing here reaches gh or a real session
/**
 * #2546: THE CLEAR'S FIVE-SECOND SETTLE IS A SEAM, AND THE PRODUCTION DELAY IS PINNED WHERE A FAST TEST CANNOT MOVE IT.
 *
 * `clearContext` waits `CLEAR_SETTLE_MS` between typing `/clear` and typing the order after it: a MEASURED production
 * delay (0s produced `Unknown command: /clearYou are...` on the live org; 5s has margin). Every test that drove a
 * standing seat's clear through `deliver`, `deliverHandoffs` or `clearThenPrompt` used to pay it for real, which was
 * about 300 of the 929 CPU-seconds the PR gate's test step spent. `sleep` is a dependency of all three now, REAL BY
 * DEFAULT, and the other test files inject a no-op. What keeps that honest is here, in three pins:
 *
 *  1. `CLEAR_SETTLE_MS === 5000`, exactly. `wake.test.ts` used to allow 2s to 15s, which let a fast test lower the
 *     production value and still pass.
 *  2. THE ORDER, driven through `deliver`: `/clear`, wait, sleep(`CLEAR_SETTLE_MS`), then the order. A recording fake
 *     shares one log with `run`, so the position of the sleep is read rather than assumed.
 *  3. THE DEFAULT IS REAL, by the ONE test in the tree that does not inject. A `sleep` that defaulted to a no-op would
 *     make every test fast and the production path silently instant. It costs five seconds on purpose.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deliver, deliverHandoffs, CLEAR_SETTLE_MS } from "../wake.mjs";
import { clearThenPrompt } from "../prompt-session.mjs";

const ROSTER = ["ceo", "product-manager", "orchestrator", "worker-capture", "worker-judge", "worker-tooling"];
const agents = (labels: string[]) => labels.map((label) => ({ label, status: "idle" }));
const ORDER_TEXT = "Your PR has a refusal to answer.";
const order = (session: string) => ({ session, cause: "changes-requested", causeKey: `${session}/changes-requested/pr-2546/k`,
  prompt: ORDER_TEXT });

/** One log for herdr and for the settle, so the ORDER between them is what is asserted. */
function recorder() {
  const log: string[] = [];
  const run = (args: string[]) => {
    const [, , , verb, , text] = args;
    log.push(verb === "prompt" ? `prompt:${String(text).slice(0, 8)}` : verb);
    return "{}";
  };
  const sleep = (ms: number) => { log.push(`sleep:${ms}`); };
  return { log, run, sleep };
}

test("#2546 (1) the settle is EXACTLY 5000 ms, so no fast test can lower the production value", () => {
  assert.equal(CLEAR_SETTLE_MS, 5_000);
});

test("#2546 (2) THROUGH deliver: /clear, wait, sleep(CLEAR_SETTLE_MS), and only then the order", () => {
  const r = recorder();
  const got = deliver([order("ceo")], agents(["ceo"]), ROSTER, { run: r.run, sleep: r.sleep, record: () => {} });
  assert.deepEqual(got.refused, [], `delivered: ${JSON.stringify(got)}`);
  assert.equal(r.log.length, 4, `exactly four events, in order: ${JSON.stringify(r.log)}`);
  assert.deepEqual(r.log.slice(0, 3), ["prompt:/clear", "wait", `sleep:${CLEAR_SETTLE_MS}`],
    "the settle sits BETWEEN the wait and the order, or the order is typed into the input the clear still occupies");
  assert.match(r.log[3], /^prompt:(?!\/clear)/, "the order is the last thing typed, and it is not another /clear");
});

test("#2546 (2) the same seam reaches deliverHandoffs and clearThenPrompt, each waiting exactly CLEAR_SETTLE_MS once", () => {
  const handed = recorder();
  const out = deliverHandoffs([{ id: "h1", session: "ceo", prompt: ORDER_TEXT, queuedAt: Date.now() }],
    agents(["ceo"]), ROSTER, { run: handed.run, sleep: handed.sleep });
  assert.deepEqual(out.refused, [], `delivered: ${JSON.stringify(out)}`);
  assert.deepEqual(handed.log.filter((e) => e.startsWith("sleep")), [`sleep:${CLEAR_SETTLE_MS}`]);

  const direct = recorder();
  assert.equal(clearThenPrompt(direct.run, "ceo", ORDER_TEXT, { sleep: direct.sleep }), null);
  assert.deepEqual(direct.log.slice(0, 3), ["prompt:/clear", "wait", `sleep:${CLEAR_SETTLE_MS}`]);
});

test("#2546 (2) CONTROL: a per-row instance is not cleared, so it does not settle either", () => {
  const r = recorder();
  deliver([order("reviewer-2546")], agents(["reviewer-2546"]), ROSTER, { run: r.run, sleep: r.sleep, record: () => {} });
  assert.deepEqual(r.log.filter((e) => e.startsWith("sleep") || e === "wait"), [],
    "a settle with nothing cleared before it would be five seconds spent for no reason");
  assert.equal(r.log.length, 1, "one event: the order itself");
});

test("#2546 (3) THE DEFAULT IS REAL: deliver with no sleep dependency waits at least CLEAR_SETTLE_MS (five seconds, on purpose)", () => {
  const r = recorder();
  const started = process.hrtime.bigint();
  const got = deliver([order("ceo")], agents(["ceo"]), ROSTER, { run: r.run, record: () => {} });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.deepEqual(got.refused, [], `delivered: ${JSON.stringify(got)}`);
  assert.ok(elapsedMs >= CLEAR_SETTLE_MS,
    `no sleep injected, so the settle must really wait: ${elapsedMs.toFixed(0)} ms elapsed against ${CLEAR_SETTLE_MS}`);
});

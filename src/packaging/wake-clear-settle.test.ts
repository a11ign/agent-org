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
 *
 * #2688 EXTENDS THIS TO `/compact`: the same seam ({@link settleAfter} in `wake.ts`) backs both commands, so the same
 * three pins apply to it -- and `contextRoot` is fixed to an EMPTY directory throughout, so a fixture naming a real
 * org label (`ceo`, `reviewer-2546`) is never compacted by a coincidence of a shared host's real transcripts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliver, CLEAR_SETTLE_MS } from "../wake/fyi-queue.ts";
import { deliverHandoffs } from "../wake/ended-sessions.ts";
import { COMPACT_THRESHOLD_TOKENS } from "../wake/holds-as-fyi.ts";
import { clearThenPrompt } from "../prompt-session.ts";
import { testEach } from "../lib/test-each.ts";

const ROSTER = ["ceo", "product-manager", "orchestrator", "worker-capture", "worker-judge", "worker-tooling"];
const agents = (labels: string[]) => labels.map((label) => ({ label, status: "idle" }));
const ORDER_TEXT = "Your PR has a refusal to answer.";
const order = (session: string) => ({ session, cause: "changes-requested", causeKey: `${session}/changes-requested/pr-2546/k`,
  prompt: ORDER_TEXT });
/** #2688: real `~/.claude/projects` is a SHARED host's live state; fixing this constant keeps every test below it. */
const NO_TRANSCRIPTS = join(tmpdir(), "a11y-2546-no-transcripts");

/** #2688: one file naming `label`, whose last turn read `cacheRead` tokens -- see `wake-no-clear-for-instances.test.ts`. */
function transcriptRootFor(label: string, cacheRead: number): string {
  const dir = mkdtempSync(join(tmpdir(), "compact-2546-"));
  writeFileSync(join(dir, "t.jsonl"), `${[
    JSON.stringify({ type: "user", message: { role: "user", content: `You are \`${label}\`, an org session in this repository.` } }),
    JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-sonnet-5",
      usage: { input_tokens: 5, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0, output_tokens: 12 } } }),
  ].join("\n")}\n`);
  return dir;
}

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

// --- #2688: `/compact` GOES THROUGH THE SAME SEAM, FOR AN OVER-THRESHOLD PER-ROW INSTANCE ---

testEach("#2546 (2) THROUGH deliver: /clear, wait, sleep(CLEAR_SETTLE_MS), and only then the order", [
  { name: "/clear", label: "ceo", command: "/clear", cacheRead: undefined,
    between: "the settle sits BETWEEN the wait and the order, or the order is typed into the input the clear still occupies",
    notAgain: /^prompt:(?!\/clear)/ },
  { name: "#2688 /compact for an over-threshold instance", label: "reviewer-2546", command: "/compact", cacheRead: COMPACT_THRESHOLD_TOKENS + 1,
    between: "the settle sits BETWEEN the wait and the order, exactly as it does for /clear",
    notAgain: /^prompt:(?!\/compact)/ },
], (c) => {
  const dir = c.cacheRead === undefined ? NO_TRANSCRIPTS : transcriptRootFor(c.label, c.cacheRead);
  try {
    const r = recorder();
    const got = deliver([order(c.label)], agents([c.label]), ROSTER, { run: r.run, sleep: r.sleep, record: () => {}, contextRoot: dir });
    assert.deepEqual(got.refused, [], `delivered: ${JSON.stringify(got)}`);
    assert.equal(r.log.length, 4, `exactly four events, in order: ${JSON.stringify(r.log)}`);
    assert.deepEqual(r.log.slice(0, 3), [`prompt:${c.command}`, "wait", `sleep:${CLEAR_SETTLE_MS}`], c.between);
    assert.match(r.log[3], c.notAgain, `the order is the last thing typed, and it is not another ${c.command}`);
  } finally {
    if (c.cacheRead !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// `worker-11`, NOT `reviewer-2546`, for the handoff half: a queued handoff to a reviewer names no pull
// request in its causeKey, so `reviewerMismatch` refuses it before any clear/compact question arises
// (the same caveat `wake-no-clear-for-instances.test.ts` documents on its own handoff test).
testEach("#2546 (2) the same seam reaches deliverHandoffs and clearThenPrompt, each waiting exactly CLEAR_SETTLE_MS once", [
  { name: "/clear", handoffLabel: "ceo", directLabel: "ceo", command: "/clear", cacheRead: undefined },
  { name: "#2688 /compact for an over-threshold instance", handoffLabel: "worker-11", directLabel: "reviewer-2546", command: "/compact",
    cacheRead: COMPACT_THRESHOLD_TOKENS + 1 },
], (c) => {
  const handoffDir = c.cacheRead === undefined ? NO_TRANSCRIPTS : transcriptRootFor(c.handoffLabel, c.cacheRead);
  const directDir = c.cacheRead === undefined ? NO_TRANSCRIPTS : transcriptRootFor(c.directLabel, c.cacheRead);
  try {
    const handed = recorder();
    const out = deliverHandoffs([{ id: "h1", session: c.handoffLabel, prompt: ORDER_TEXT, queuedAt: Date.now() }],
      agents([c.handoffLabel]), ROSTER, { run: handed.run, sleep: handed.sleep, contextRoot: handoffDir });
    assert.deepEqual(out.refused, [], `delivered: ${JSON.stringify(out)}`);
    assert.deepEqual(handed.log.filter((e) => e.startsWith("sleep")), [`sleep:${CLEAR_SETTLE_MS}`]);

    const direct = recorder();
    assert.equal(clearThenPrompt(direct.run, c.directLabel, ORDER_TEXT, { sleep: direct.sleep, contextRoot: directDir }), null);
    assert.deepEqual(direct.log.slice(0, 3), [`prompt:${c.command}`, "wait", `sleep:${CLEAR_SETTLE_MS}`]);
  } finally {
    if (c.cacheRead !== undefined) {
      rmSync(handoffDir, { recursive: true, force: true });
      rmSync(directDir, { recursive: true, force: true });
    }
  }
});

testEach("#2546 (2) CONTROL: a per-row instance is not cleared, so it does not settle either", [
  { name: "a per-row instance", cacheRead: undefined,
    msg: "a settle with nothing cleared before it would be five seconds spent for no reason" },
  { name: "#2688 an instance below the threshold", cacheRead: COMPACT_THRESHOLD_TOKENS,
    msg: "AT the threshold is not OVER it, so nothing is sent and nothing settles" },
], (c) => {
  const dir = c.cacheRead === undefined ? NO_TRANSCRIPTS : transcriptRootFor("reviewer-2546", c.cacheRead);
  try {
    const r = recorder();
    deliver([order("reviewer-2546")], agents(["reviewer-2546"]), ROSTER,
      { run: r.run, sleep: r.sleep, record: () => {}, contextRoot: dir });
    assert.deepEqual(r.log.filter((e) => e.startsWith("sleep") || e === "wait"), [], c.msg);
    assert.equal(r.log.length, 1, "one event: the order itself");
  } finally {
    if (c.cacheRead !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

testEach("#2546 (3) THE DEFAULT IS REAL: deliver with no sleep dependency waits at least CLEAR_SETTLE_MS (five seconds, on purpose)", [
  { name: "/clear", label: "ceo", cacheRead: undefined },
  { name: "#2688 /compact for an over-threshold instance", label: "reviewer-2546", cacheRead: COMPACT_THRESHOLD_TOKENS + 1 },
], (c) => {
  const dir = c.cacheRead === undefined ? NO_TRANSCRIPTS : transcriptRootFor(c.label, c.cacheRead);
  try {
    const r = recorder();
    const started = process.hrtime.bigint();
    const got = deliver([order(c.label)], agents([c.label]), ROSTER, { run: r.run, record: () => {}, contextRoot: dir });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.deepEqual(got.refused, [], `delivered: ${JSON.stringify(got)}`);
    assert.ok(elapsedMs >= CLEAR_SETTLE_MS,
      `no sleep injected, so the settle must really wait: ${elapsedMs.toFixed(0)} ms elapsed against ${CLEAR_SETTLE_MS}`);
  } finally {
    if (c.cacheRead !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

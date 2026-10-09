// no-token: clearContext -- every herdr call is the injected `run`; the claim is a fake; nothing here reaches gh
/**
 * #4070 (#4055 move 2): HALF OF NEW WORKERS GET THE CALM FINISH PARAGRAPH, ASSIGNED BY ROW NUMBER, AND A CLAIM'S REPEAT ORDERS ARE COUNTED AND CAPPED.
 *
 * Each claim has its negative control beside it: a paragraph given to every worker would pass the `calm` half, a cap that never fires would pass the
 * "first and second are not escalated" half, and a count kept per session would pass every single-claim case. Driven through `deliver`, the path
 * that types an order, because a check over `addressed` alone passes with `deliver` never reaching it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressed, deliver, claimOrdersIn, claimOrdersPath, ledgerLine, CONTINUATION_ESCALATE_TO } from "./wake.ts";
import { armOf, ARM, CALM_FINISH_PARAGRAPH } from "./worker-profile.ts";
import { MAX_CONTINUATIONS } from "./claim-stall.ts";

const AT = 1_791_000_000_000;
/** An EMPTY transcript root, so a real label this file reuses is never compacted by a coincidence of a live session's own transcript. */
const NO_TRANSCRIPTS = join(tmpdir(), "a11y-4070-no-transcripts");
// 4046 is calm AND not batched (floor(4046 / 2) is odd), 4047 control AND not batched: this file reads the calm arm alone, so neither row may carry the round-trips paragraph (#4182).
const CALM_ROW = 4046;
const CONTROL_ROW = 4047;
const FIRST_SENTENCE = "No one watches this session live.";

const claimed = (row) => ({ row, branch: `agent/x-${row}`, worktree: `/home/agent/repos/wt-${row}` });
const readyOrder = (row) => ({ session: "engineers", cause: "ready-row-unclaimed", causeKey: `engineers/ready-row-unclaimed/${row}`,
  title: "A title", prompt: `Ready row #${row} is unclaimed.` });
const occurrences = (text, needle) => text.split(needle).length - 1;

/** A fresh directory for the claim-orders record, removed by the caller. */
const scratch = () => mkdtempSync(join(tmpdir(), "wake-calm-arm-"));

/** A herdr that records what is TYPED to each label (the `/clear` is not an order), answers a started pane as ready, and opens a workspace on request. */
function herdr() {
  const calls = [];
  const prompted = new Set();
  const run = (args) => {
    calls.push(args);
    const verb = args.slice(2, 4).join(" ");
    if (verb === "agent prompt") prompted.add(args[4]);
    if (verb === "agent get") {
      return JSON.stringify({ result: { agent: { agent_status: prompted.has(args[4]) ? "working" : "idle", interactive_ready: true, state_change_seq: 1 } } });
    }
    if (args.join(" ").includes("workspace create")) {
      return JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } });
    }
    return "{}";
  };
  const typed = (label) => calls.filter((c) => c.slice(2, 4).join(" ") === "agent prompt" && c[4] === label && c[5] !== "/clear").map((c) => c[5]);
  return { run, typed };
}

/** A claimer that always lands the row the order names, in the worktree a real claim would make. */
const fakeClaimer = { claim: (order) => claimed(Number(order.causeKey.split("/").at(-1))), release: () => "" };

/** One tick that STARTS the worker for `row`; returns what it was typed and the claim-orders path's lines. */
function spawnFor(row, dir) {
  const h = herdr();
  const got = deliver([readyOrder(row)], [], [], { run: h.run, claimer: fakeClaimer, claimOrders: claimOrdersIn(join(dir, "claim-orders")),
    now: () => AT, sleep: () => {}, contextRoot: NO_TRANSCRIPTS, record: () => {} });
  return { got, typed: h.typed(`worker-${row}`)[0], lines: recordLines(join(dir, "claim-orders")) };
}

const recordLines = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// --- (1) the arm is the row number's parity, and nothing else -----------------------------------------------------------------------------

test("#4070 row 4048 is calm and row 4047 is control; the same on a second call; a spread of rows uses both arms", () => {
  assert.equal(armOf(CALM_ROW), ARM.CALM);
  assert.equal(armOf(CONTROL_ROW), ARM.CONTROL);
  assert.equal(armOf(CALM_ROW), armOf(CALM_ROW), "no randomness: the same row is the same arm");
  const arms = Array.from({ length: 100 }, (_, i) => armOf(4000 + i));
  assert.equal(arms.filter((a) => a === ARM.CALM).length, 50, "THE POSITIVE CONTROL: both arms occur, half each, so 'control' is not simply what the rule returns");
});

// --- (2) the paragraph is the LAST text of a calm first-contact preamble and is in no control one ----------------------------------------------

test("#4070 the calm paragraph ends a calm spawned preamble, appears once, and appears nowhere in a control one (byte-compared)", () => {
  const calm = addressed(readyOrder(CALM_ROW), `worker-${CALM_ROW}`, { spawned: claimed(CALM_ROW) });
  const control = addressed(readyOrder(CONTROL_ROW), `worker-${CONTROL_ROW}`, { spawned: claimed(CONTROL_ROW) });
  assert.ok(calm.endsWith(`\n\n${CALM_FINISH_PARAGRAPH}`), "the paragraph is the last text");
  assert.equal(occurrences(calm, FIRST_SENTENCE), 1);
  assert.equal(occurrences(control, FIRST_SENTENCE), 0, "NEGATIVE CONTROL: the control arm never carries it");
  assert.ok(!control.includes("keep going"), "nor any line of it");
  const same = (text, row) => text.replaceAll(String(row), "<row>");
  assert.equal(same(calm, CALM_ROW).slice(0, -`\n\n${CALM_FINISH_PARAGRAPH}`.length), same(control, CONTROL_ROW),
    "and the two preambles are byte-identical up to the paragraph");
  assert.doesNotMatch(CALM_FINISH_PARAGRAPH, /\b[A-Z]{4,}\b/, "the paragraph has no capitals-for-emphasis, as the report's does not");
});

test("#4070 the paragraph reaches no standing seat's first order and no follow-up, in either arm", () => {
  const standing = addressed(readyOrder(CALM_ROW), "worker-capture", { engineers: ["worker-capture"] });
  assert.equal(occurrences(standing, FIRST_SENTENCE), 0, "a standing seat's first order is not a new per-row worker's");
  const followUp = (row) => addressed({ ...readyOrder(row), cause: "pr-checks-failing" }, `worker-${row}`, { followUp: true, orderId: `wake:worker-${row}:${AT}` });
  const [calm, control] = [followUp(CALM_ROW), followUp(CONTROL_ROW)];
  assert.equal(occurrences(calm, FIRST_SENTENCE), 0);
  assert.equal(calm.replaceAll(String(CALM_ROW), "<row>"), control.replaceAll(String(CONTROL_ROW), "<row>"), "neither arm's follow-up orders change");
});

test("#4070 through deliver: a started calm worker is typed the paragraph last, a control one is not, and the arm is written once at the spawn", () => {
  const dir = scratch();
  try {
    const calm = spawnFor(CALM_ROW, dir);
    assert.deepEqual(calm.got.refused, []);
    assert.ok(calm.typed?.endsWith(CALM_FINISH_PARAGRAPH), "THE POSITIVE CONTROL: the order WAS typed, and ends with the paragraph");
    assert.deepEqual(calm.lines, [{ kind: "arm", at: AT, session: `worker-${CALM_ROW}`, row: CALM_ROW, arm: "calm", tripsArm: "control" }]);
    const control = spawnFor(CONTROL_ROW, dir);
    assert.ok(control.typed && !control.typed.includes(FIRST_SENTENCE));
    assert.deepEqual(control.lines.slice(1), [{ kind: "arm", at: AT, session: `worker-${CONTROL_ROW}`, row: CONTROL_ROW, arm: "control", tripsArm: "control" }]);
    assert.equal(control.lines.length, 2, "one line per spawn, and no other line");
    const other = scratch();
    try {
      const respawn = spawnFor(CALM_ROW, other);
      assert.equal(respawn.lines[0].arm, "calm", "a respawn of the same row is the same arm");
      assert.equal(respawn.typed, calm.typed, "and is typed the same bytes");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- (3) the third gate order to one claim goes to orchestrator; the first and second do not --------------------------------------------------

const AGENTS = ["worker-4070", "worker-4071", "worker-capture", "orchestrator", "product-manager"].map((label) => ({ label, status: "idle" }));
let sequence = 0;
const gateOrder = (session, cause, extra = {}) => ({ session, cause, causeKey: `${session}/${cause}/pr-${++sequence}/h`, subject: `pr-${sequence}`,
  prompt: `${cause} for #${sequence} (text the worker would have been sent).`, ...extra });

/** One tick over `path`'s record, as the tick reads it: a fresh `claimOrdersIn` each call. Returns who was typed what. */
function tick(orders, path, extra = {}) {
  const h = herdr();
  const got = deliver(orders, AGENTS, ["worker-capture"], { run: h.run, claimOrders: claimOrdersIn(path), now: () => AT, sleep: () => {},
    contextRoot: NO_TRANSCRIPTS, record: () => {}, ...extra });
  return { got, h };
}

test("#4070 the third gate order to one claim is sent to orchestrator, and the first and second are not; the count crosses causes and ticks", () => {
  const dir = scratch();
  const path = join(dir, "claim-orders");
  try {
    const causes = ["pr-checks-failing", "claim-stalled", "pr-review-blocked", "answer-label-unexplained"];
    const where = causes.map((cause) => {
      const { got, h } = tick([gateOrder("worker-4070", cause)], path);
      assert.deepEqual(got.refused, [], cause);
      return h.typed("worker-4070").length ? "worker-4070" : h.typed(CONTINUATION_ESCALATE_TO).length ? CONTINUATION_ESCALATE_TO : "nowhere";
    });
    assert.equal(MAX_CONTINUATIONS, 3);
    assert.deepEqual(where, ["worker-4070", "worker-4070", CONTINUATION_ESCALATE_TO, CONTINUATION_ESCALATE_TO],
      "two to the worker, then every later one to orchestrator (mixed causes: the claim is counted, not the cause)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#4070 the escalated order names the claim and carries the worker's own text; the worker is not typed it", () => {
  const dir = scratch();
  const path = join(dir, "claim-orders");
  try {
    for (let i = 0; i < 2; i++) tick([gateOrder("worker-4070", "pr-checks-failing")], path);
    const third = gateOrder("worker-4070", "pr-checks-failing", { fallback: "product-manager", fallbackPrompt: "dead owner", resume: true });
    const { h, got } = tick([third], path);
    assert.deepEqual(h.typed("worker-4070"), []);
    const [typed] = h.typed(CONTINUATION_ESCALATE_TO);
    assert.match(typed, /`worker-4070` HAS NOW BEEN SENT 2 GATE ORDERS ON ONE CLAIM \(`row-4070`; the cap is 3, #4070\)/);
    assert.ok(typed.includes(third.prompt) && typed.includes(third.causeKey));
    assert.ok(!typed.includes("dead owner"), "the worker's dead-owner fallback text is dropped with its routing");
    assert.match(got.sent[0], /^orchestrator <- .* \[continuation 3 -> orchestrator\]$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#4070 the count is per CLAIM, not per worker session or per cause", () => {
  const dir = scratch();
  const path = join(dir, "claim-orders");
  try {
    for (let i = 0; i < 3; i++) tick([gateOrder("worker-4070", "pr-checks-failing")], path);
    const other = tick([gateOrder("worker-4071", "pr-checks-failing")], path);
    assert.equal(other.h.typed("worker-4071").length, 1, "another claim of the same kind starts at one although worker-4070 is capped");
    // a STANDING seat holds successive claims: three orders on three subjects are three claims; three on one subject are one
    const seat = (subject) => tick([gateOrder("worker-capture", "claim-stalled", { subject })], path).h.typed("worker-capture").length;
    assert.deepEqual(["row-1", "row-2", "row-3"].map(seat), [1, 1, 1], "three claims of one session: none is capped");
    assert.deepEqual(["row-9", "row-9", "row-9"].map(seat), [1, 1, 0], "three on one claim: the third is not typed to the seat");
    // not a repeat order to a live worker's claim: never counted
    const other_causes = [gateOrder("worker-4070", "something-else"), gateOrder("product-manager", "pr-review-blocked")];
    other_causes.forEach((o) => assert.equal(tick([o], path).h.typed(o.session).length, 1, `${o.session}/${o.cause} is not capped`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- (4) every continuation writes one record line, and only a landed delivery does ---------------------------------------------------------

test("#4070 every continuation writes one line with claim, cause and number; a refused delivery writes none and keeps its number", () => {
  const dir = scratch();
  const path = join(dir, "claim-orders");
  try {
    const causes = ["pr-checks-failing", "claim-stalled"];
    causes.forEach((cause) => tick([gateOrder("worker-4070", cause)], path));
    const refused = tick([gateOrder("worker-4070", "pr-review-blocked")], path, { unavailable: (label) => (label === CONTINUATION_ESCALATE_TO ? "out of allowance" : null) });
    assert.equal(refused.got.refused.length, 1);
    assert.equal(recordLines(path).length, 2, "the refused delivery wrote nothing");
    const retried = tick([gateOrder("worker-4070", "pr-review-blocked")], path);
    assert.equal(retried.h.typed(CONTINUATION_ESCALATE_TO).length, 1);
    const lines = recordLines(path);
    assert.deepEqual(lines.map((l) => [l.kind, l.claim, l.cause, l.continuation, l.to]), [
      ["continuation", "row-4070", "pr-checks-failing", 1, "worker-4070"],
      ["continuation", "row-4070", "claim-stalled", 2, "worker-4070"],
      ["continuation", "row-4070", "pr-review-blocked", 3, CONTINUATION_ESCALATE_TO],
    ], "the retry is number 3 again, not 4");
    assert.ok(lines.every((l) => l.at === AT && typeof l.causeKey === "string"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#4070 an unreadable record line is skipped WITH a warning; a record that is absent is empty; no record means no cap", () => {
  const dir = scratch();
  const path = join(dir, "claim-orders");
  try {
    assert.equal(claimOrdersIn(path).counts.size, 0, "absent is empty");
    writeFileSync(path, `${JSON.stringify({ kind: "continuation", claim: "row-1" })}\n{not json\n`);
    const warned = [];
    const read = claimOrdersIn(path, { warn: (l) => warned.push(l) });
    assert.equal(read.counts.get("row-1"), 1);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /skipped an unreadable line/);
    const h = herdr();
    for (let i = 0; i < 4; i++) deliver([gateOrder("worker-4070", "pr-checks-failing")], AGENTS, [], { run: h.run, sleep: () => {}, contextRoot: NO_TRANSCRIPTS, record: () => {} });
    assert.equal(h.typed("worker-4070").length, 4, "without a record, nothing is counted or capped (callers that predate it are unchanged)");
    assert.equal(claimOrdersPath("/x/wake-ledger"), "/x/claim-orders", "the record sits beside the ledger");
    assert.ok(ledgerLine(AT, "k").split("\t").length === 2, "and the ledger's own line format is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// no-token: clearContext -- every herdr call is the injected `run`; the claim is a fake; nothing here reaches gh
/**
 * #4182 (#4055 next wave, item 3): HALF OF NEW WORKERS GET THE ROUND-TRIPS PARAGRAPH, ASSIGNED BY THE SECOND BIT OF THE ROW NUMBER, SO IT IS INDEPENDENT OF THE CALM ARM.
 *
 * Each claim has its negative control beside it: a `tripsArmOf` that returned `armOf`'s answer passes every per-arm case and fails only the independence count; a paragraph
 * given to every worker passes the `batched` half; an order typed without going through `deliver` passes a check over `addressed` alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressed, deliver, claimOrdersIn } from "./wake.mjs";
import { armOf, tripsArmOf, ARM, TRIPS_ARM, CALM_FINISH_PARAGRAPH, ROUND_TRIPS_PARAGRAPH } from "./worker-profile.mjs";

const AT = 1_791_000_000_000;
const NO_TRANSCRIPTS = join(tmpdir(), "a11y-4182-no-transcripts");
const FIRST_SENTENCE = "Every tool call is a round trip";
/** One row of each cell: row mod 4 is 0 calm+batched, 1 control+batched, 2 calm+control, 3 control+control. */
const CELLS = { calmBatched: 4048, controlBatched: 4049, calmControl: 4046, controlControl: 4047 };

const claimed = (row: number) => ({ row, branch: `agent/x-${row}`, worktree: `/home/agent/repos/wt-${row}`, launchDir: `/home/agent/repos/wt-${row}` });
const readyOrder = (row: number) => ({ session: "engineers", cause: "ready-row-unclaimed", causeKey: `engineers/ready-row-unclaimed/${row}`,
  title: "A title", prompt: `Ready row #${row} is unclaimed.` });
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
const spawnedOrder = (row: number) => addressed(readyOrder(row), `worker-${row}`, { spawned: claimed(row) });

// --- (1) independence ------------------------------------------------------------------------------------------------------------------------

test("#4182 over rows 4000 to 4099 each of the four cells holds exactly 25 rows, and the cells are the ones CELLS names", () => {
  const counts = new Map<string, number>();
  for (let row = 4000; row < 4100; row += 1) {
    const cell = `${armOf(row)}+${tripsArmOf(row)}`;
    counts.set(cell, (counts.get(cell) ?? 0) + 1);
  }
  assert.equal(counts.size, 4, "THE POSITIVE CONTROL: all four cells occur, so a map that kept two would not pass");
  for (const [cell, n] of counts) assert.equal(n, 25, `${cell} holds 25 rows`);
  assert.deepEqual([CELLS.calmBatched, CELLS.controlBatched, CELLS.calmControl, CELLS.controlControl].map((r) => `${armOf(r)}+${tripsArmOf(r)}`),
    ["calm+batched", "control+batched", "calm+control", "control+control"]);
});

test("#4182 the same row is the same arm on every call, and tripsArmOf is not armOf under another name", () => {
  for (const row of [4046, 4047, 4048, 4049]) assert.equal(tripsArmOf(row), tripsArmOf(row), "no randomness");
  const agreeing = Array.from({ length: 100 }, (_, i) => 4000 + i).filter((row) => (armOf(row) === ARM.CALM) === (tripsArmOf(row) === TRIPS_ARM.BATCHED));
  assert.equal(agreeing.length, 50, "NEGATIVE CONTROL: the two assignments agree on half the rows, not on all (a copy of armOf) or none (its inverse)");
});

// --- (2) the paragraph's place -----------------------------------------------------------------------------------------------------------------

test("#4182 the paragraph is the LAST text of a batched order, after the calm paragraph on a row that is both, and in no control order", () => {
  const both = spawnedOrder(CELLS.calmBatched);
  assert.ok(both.endsWith(`\n\n${CALM_FINISH_PARAGRAPH}\n\n${ROUND_TRIPS_PARAGRAPH}`), "calm, then round trips, last");
  assert.equal(occurrences(both, FIRST_SENTENCE), 1);
  const batchedOnly = spawnedOrder(CELLS.controlBatched);
  assert.ok(batchedOnly.endsWith(`\n\n${ROUND_TRIPS_PARAGRAPH}`));
  assert.equal(occurrences(batchedOnly, "No one watches this session live."), 0, "and no calm paragraph on a row that is not calm");
  for (const row of [CELLS.calmControl, CELLS.controlControl]) {
    assert.equal(occurrences(spawnedOrder(row), FIRST_SENTENCE), 0, `NEGATIVE CONTROL: row ${row} carries none of it`);
  }
});

test("#4182 a control row's order is byte-identical to the order before this row existed (the calm paragraph or nothing, and nothing after it)", () => {
  const same = (text: string, row: number) => text.replaceAll(String(row), "<row>");
  const plain = same(spawnedOrder(CELLS.controlControl), CELLS.controlControl);
  assert.equal(same(spawnedOrder(CELLS.calmControl), CELLS.calmControl), `${plain}\n\n${CALM_FINISH_PARAGRAPH}`);
  assert.equal(same(spawnedOrder(CELLS.controlBatched), CELLS.controlBatched), `${plain}\n\n${ROUND_TRIPS_PARAGRAPH}`);
});

test("#4182 the paragraph has no word of four or more capitals, and states its reason", () => {
  assert.doesNotMatch(ROUND_TRIPS_PARAGRAPH, /\b[A-Z]{4,}\b/);
  assert.match(ROUND_TRIPS_PARAGRAPH, /so fewer round trips cost less/, "the reason sentence is there");
  assert.match(ROUND_TRIPS_PARAGRAPH, /same turn/);
  assert.match(ROUND_TRIPS_PARAGRAPH, /one script that prints a summary/);
});

test("#4182 an order that is not a row's first contact carries neither paragraph, in any cell", () => {
  const standing = addressed(readyOrder(CELLS.calmBatched), "worker-capture", { engineers: ["worker-capture"] });
  assert.equal(occurrences(standing, FIRST_SENTENCE), 0, "a standing seat's first order is not a new per-row worker's");
  for (const row of Object.values(CELLS)) {
    const text = addressed({ ...readyOrder(row), cause: "pr-checks-failing" }, `worker-${row}`,
      { followUp: true, orderId: `wake:worker-${row}:${AT}` });
    assert.equal(occurrences(text, FIRST_SENTENCE), 0, `row ${row}'s follow-up`);
    assert.equal(occurrences(text, "No one watches this session live."), 0);
  }
});

// --- (3) through deliver, and the ledger ---------------------------------------------------------------------------------------------------------

const herdr = () => {
  const calls: string[][] = [];
  const prompted = new Set<string>();
  const run = (args: string[]) => {
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
  const typed = (label: string) => calls.filter((c) => c.slice(2, 4).join(" ") === "agent prompt" && c[4] === label && c[5] !== "/clear").map((c) => c[5]);
  return { run, typed };
};
const fakeClaimer = { claim: (order: { causeKey: string }) => claimed(Number(order.causeKey.split("/").at(-1))), release: () => "" };

test("#4182 through deliver: the typed order ends as addressed says, and the arm record carries both arms for a claimed row, once", () => {
  for (const [name, row] of Object.entries(CELLS)) {
    const dir = mkdtempSync(join(tmpdir(), "wake-round-trips-arm-"));
    try {
      const h = herdr();
      const got = deliver([readyOrder(row)], [], [], { run: h.run, claimer: fakeClaimer, claimOrders: claimOrdersIn(join(dir, "claim-orders")),
        now: () => AT, sleep: () => {}, contextRoot: NO_TRANSCRIPTS, record: () => {} });
      assert.deepEqual(got.refused, [], name);
      const typed = h.typed(`worker-${row}`)[0];
      assert.ok(typed, `THE POSITIVE CONTROL: the order for ${name} WAS typed`);
      assert.equal(typed.endsWith(ROUND_TRIPS_PARAGRAPH), tripsArmOf(row) === TRIPS_ARM.BATCHED, name);
      const path = join(dir, "claim-orders");
      const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      assert.deepEqual(lines, [{ kind: "arm", at: AT, session: `worker-${row}`, row, arm: armOf(row), tripsArm: tripsArmOf(row) }], name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

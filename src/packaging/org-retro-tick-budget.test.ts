// no-token: gh -- every `gh` and `journalctl` here is a script that exits 1, written into a temp directory and put first on PATH; HOME is a temp directory, so no transcript is read
/**
 * a11ign/agent-org#1089: THE RETRO READ HAS ITS OWN TICK BUDGET. The DORA read was cut into ticks (#3736), but once it was complete the rest of the read ran in ONE
 * tick with no budget: the merged lists, the journal, the transcripts and the GitHub reads, past the gate's 300 s. The tick was cut before the order was written, so the
 * day was never delivered, and the next tick began the whole read again.
 *
 * THE POSITIVE CONTROL IS THE FIRST TEST: the same reads, with a budget no tick reaches, offer the order on the first tick. The CUT test spends more than the budget in
 * the first class (the merged lists, through its seam, on a fake clock), so the next class is left for the next tick, nothing is offered, and the log names the class.
 * The second tick reads the classes the first left, does NOT read the merged lists again, and offers exactly one order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as retro_0 from "../org-retro.ts";
import { tmpDir, tmpDirForFile } from "../lib/tmp-fixture.ts";

const NOW = Date.parse("2026-10-12T01:00:00Z");
const NEXT_TICK = NOW + 2 * 60 * 1000;

/** `gh` and `journalctl` answer nothing: every read they make is refused, which is a reading that says so, not a throw. */
function installRefusingTools() {
  const bin = tmpDirForFile("retro-budget-tools-");
  for (const name of ["gh", "journalctl"]) {
    const script = join(bin, name);
    writeFileSync(script, "#!/bin/sh\nexit 1\n");
    chmodSync(script, 0o755);
  }
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.HOME = tmpDirForFile("retro-budget-home-");
}
installRefusingTools();

/**
 * One gate tick of the daily retrospective, with the merged lists as the class that spends the clock: `MERGED_COST_MS` on the fake clock, every time it is read.
 * DORA is complete at once (no repositories), so the rest of the read is the whole question. `budgetMs` is the tick's budget (the constant, unless a test says otherwise).
 */
const MERGED_COST_MS = 70 * 1000;
function tickWith(stateDir: string, now: number, { budgetMs, clock }: { budgetMs?: number; clock: { ms: number } }) {
  const said: string[] = [];
  const merged = { reads: 0 };
  const orders = retro_0.retrospectiveTick({
    now, stateDir, log: (line) => said.push(line), readLedger: () => "", readUntiered: () => null,
    read: (where) => retro_0.readWhenDoraIsRead(where, {
      dora: { repositories: [] },
      readRest: (rest) => retro_0.readRetroClasses({
        ...rest,
        readMergedRepositories: () => {
          merged.reads += 1;
          clock.ms += MERGED_COST_MS;
          return [];
        },
      }, { budgetMs, clock: () => clock.ms }),
    }),
  });
  return { orders: orders.filter((order) => order.cause === "org-retrospective"), said, merged };
}

test("THE CONTROL: with a budget no tick reaches, the first tick offers the day's retrospective", () => {
  const stateDir = tmpDir("retro-budget-control-");
  const clock = { ms: NOW };
  const { orders, said } = tickWith(stateDir, NOW, { budgetMs: 10 * 60 * 1000, clock });
  assert.equal(orders.length, 1);
  assert.equal(said.some((line) => line.includes("read stopped at")), false);
});

test("THE CUT: a class that starts past the budget waits for the next tick, nothing is offered, and the log names it", () => {
  const stateDir = tmpDir("retro-budget-cut-");
  const clock = { ms: NOW };
  const first = tickWith(stateDir, NOW, { budgetMs: retro_0.RETRO_TICK_BUDGET_MS, clock });
  assert.equal(first.orders.length, 0);
  const stop = first.said.find((line) => line.startsWith("org-retro: read stopped at "));
  assert.equal(stop, "org-retro: read stopped at open pull requests after 70 s (1 of 15 classes read); no org-retrospective order until every class is read.\n");
  assert.equal(existsSync(join(stateDir, retro_0.RETRO_CLASSES_FILE)), true);
});

test("THE RESUME: the next tick reads the classes the first left, not the merged lists again, and offers exactly one order", () => {
  const stateDir = tmpDir("retro-budget-resume-");
  const clock = { ms: NOW };
  tickWith(stateDir, NOW, { budgetMs: retro_0.RETRO_TICK_BUDGET_MS, clock });
  const second = tickWith(stateDir, NEXT_TICK, { clock: { ms: NEXT_TICK } });
  assert.equal(second.merged.reads, 0);
  assert.equal(second.orders.length, 1);
  assert.equal(second.said.some((line) => line.includes("read stopped at")), false);
});

test("THE BUDGET IS WELL UNDER THE GATE'S (300 s): one tick's share of the retro read is 60 s", () => {
  assert.equal(retro_0.RETRO_TICK_BUDGET_MS, 60_000);
  assert.ok(retro_0.RETRO_TICK_BUDGET_MS < 300_000);
});

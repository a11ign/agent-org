// no-token: gh -- nothing here reaches `gh`: the report is a pure function and the one child process is `finishTick` over injected arguments
/**
 * #3029: `N order(s) had nowhere to go` SEPARATES AN ORDER WAITING FOR A SEAT'S TURN FROM ONE THAT HAS NO WAY TO ARRIVE.
 *
 * The line fired for 30 consecutive ticks (2026-10-02) because `ceo` was `working` on one long turn and held two queued orders, and it shared
 * its count with three real faults. The row's positive controls are all here: a refused-to-start order ALONE still writes the line and exits 1,
 * and a busy-seat order under the limit yields neither. THE LIMIT IS WRITTEN OUT AS 15 MINUTES (it was 60 until #3448), never as `BUSY_SEAT_DEFERRAL_MS`: a test built
 * from the constant moves with it, so changing the limit would leave it green.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitRefusals, refusalReport, deferralAges, BUSY_SEAT_DEFERRAL_MS } from "../wake.ts";

const MINUTE = 60_000;
const WAKE = fileURLToPath(new URL("../wake.ts", import.meta.url));

const BUSY = (key = "handoff/ceo/07ed9f53", seat = "ceo") => `${key}: "${seat}" is working`;
const REFUSED_TO_START = "reviewer-agent-org-16/pr-review-due/pr-16/0a1b2c3d: herdr refused to start \"reviewer-agent-org-16\" (the workspace it opened was closed)";
const NO_TAKER = "handoff/reviewer-3013/0f2761c3: \"reviewer-3013\" reviews PR #3013 and nothing else, and this order is about no pull request";
const at = (minutes: number) => (keys: string[]) => new Map(keys.map((k) => [k, minutes * MINUTE]));

test("#3448: the limit is fifteen minutes (it was one hour, #3029), and the measurement behind it is in `org-health.ts` beside the signal that shares it", () => {
  assert.equal(BUSY_SEAT_DEFERRAL_MS, 15 * MINUTE);
});

test("#3029: only `\"<seat>\" is working` is a busy seat -- every other refusal the tick writes is a fault", () => {
  const { busy, faults } = splitRefusals([
    BUSY(), BUSY("ceo/blocker-cleared/row-2974/1931.1959"),
    `ceo/chairman-blocked/0: "ceo" is working; and the fallback "product-manager": "product-manager" is working`,
    REFUSED_TO_START, NO_TAKER, `x/y/1: "ceo" is blocked`, `x/y/2: no workspace labelled "ceo"`,
    `engineers/ready-row-unclaimed/3008: no engineer is idle (worker-4: B4 against #3020)`,
    `x/y/3: "ceo" is working; and the fallback "product-manager": no workspace labelled "product-manager"`,
  ]);
  assert.equal(busy.length, 3, "a count that is not zero: the positive control for the faults list below");
  assert.deepEqual(busy.map((b) => b.key), ["handoff/ceo/07ed9f53", "ceo/blocker-cleared/row-2974/1931.1959", "ceo/chairman-blocked/0"]);
  assert.equal(faults.length, 6, "a fallback that failed for a different reason is NOT a seat waiting its turn");
  assert.ok(faults.includes(REFUSED_TO_START) && faults.includes(NO_TAKER));
});

test("#3029 THE ROW'S TICK: one busy-seat refusal and one refused-to-start refusal -- the summary counts 1, not 2, and the busy one is DEFERRED", () => {
  const report = refusalReport([BUSY(), REFUSED_TO_START], at(12));
  assert.match(report.summary ?? "", /^1 order\(s\) had nowhere to go\./);
  assert.deepEqual(report.undelivered, [REFUSED_TO_START]);
  assert.equal(report.deferred.length, 1);
  assert.match(report.deferred[0], /^handoff\/ceo\/07ed9f53: "ceo" is working \(waiting 12 min; retried next tick\)$/, "its own line, with the order's age");
});

test("#3029 POSITIVE CONTROL: a refused-to-start order ALONE still writes the summary", () => {
  const report = refusalReport([REFUSED_TO_START], at(0));
  assert.match(report.summary ?? "", /^1 order\(s\) had nowhere to go\. A derived cause is NOT in the ledger/);
  assert.deepEqual(report.deferred, []);
});

test("#3029 POSITIVE CONTROL: a busy-seat order younger than the limit yields NO summary and no fault line", () => {
  const report = refusalReport([BUSY(), BUSY("ceo/blocker-cleared/row-2974/1931.1959")], at(14));
  assert.equal(report.summary, null);
  assert.deepEqual(report.undelivered, []);
  assert.equal(report.deferred.length, 2);
});

test("#3029: a busy-seat order OVER the limit is `nowhere to go` after all, named with its age; exactly 15 minutes is not yet over", () => {
  assert.equal(refusalReport([BUSY()], at(15)).summary, null, "the boundary is `over`, not `at`");
  const over = refusalReport([BUSY(), BUSY("ceo/answer-owed/row-1")], (keys) => new Map([[keys[0], 16 * MINUTE], [keys[1], 5 * MINUTE]]));
  assert.match(over.summary ?? "", /^1 order\(s\) had nowhere to go\./, "only the overdue one is counted");
  assert.match(over.undelivered[0], /^handoff\/ceo\/07ed9f53: "ceo" is working \(deferred 16 min, over the 15-minute limit/);
  assert.equal(over.deferred.length, 1);
});

test("#3029: no refusals at all is no report", () => {
  assert.deepEqual(refusalReport([], at(0)), { deferred: [], undelivered: [], summary: null });
});

// --- the age a derived order is given ------------------------------------------------------------------------------

function inTmp<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "wake-deferral-"));
  try { return body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("#3029: a key is aged from the tick that FIRST deferred it, survives across ticks, and is forgotten once it is no longer deferred", () => {
  inTmp((dir) => {
    const path = join(dir, "state", "wake-deferred");
    const T0 = 1_000_000_000_000;
    assert.deepEqual([...deferralAges(path, ["a", "b"], T0)], [["a", 0], ["b", 0]], "no file is no history, not an error");
    assert.deepEqual([...deferralAges(path, ["a", "b"], T0 + 2 * MINUTE)], [["a", 2 * MINUTE], ["b", 2 * MINUTE]]);
    assert.deepEqual([...deferralAges(path, ["a"], T0 + 4 * MINUTE)], [["a", 4 * MINUTE]], "b was delivered this tick");
    assert.deepEqual([...deferralAges(path, ["a", "b"], T0 + 6 * MINUTE)], [["a", 6 * MINUTE], ["b", 0]], "b is a NEW wait, not the old one resumed");
    assert.deepEqual([...deferralAges(path, [], T0 + 8 * MINUTE)], []);
    assert.equal(readFileSync(path, "utf8"), "", "nothing deferred leaves nothing remembered");
  });
});

test("#3029: a malformed state file is an error, never a quiet reset to age 0 that would hide a stuck order", () => {
  inTmp((dir) => {
    const path = join(dir, "wake-deferred");
    writeFileSync(path, "a\tyesterday\n");
    assert.throws(() => deferralAges(path, ["a"], Date.now()), /not "<causeKey>\\t<ms>"/);
  });
});

// --- the whole tick, as a process: the exit code is part of the claim ----------------------------------------------

/** `finishTick` over the given refusals in a child process (it ends with `process.exit`), against a ledger in `dir`. */
function tick(dir: string, { handedRefused = [] as string[], gateRefused = [] as string[] }) {
  const code = `import { finishTick } from ${JSON.stringify(WAKE)};
    finishTick({ handed: { sent: [], refused: ${JSON.stringify(handedRefused)}, ids: [], busied: new Set() }, sent: [],
      gateRefused: ${JSON.stringify(gateRefused)}, stuck: [], outaged: [], ledgerPath: ${JSON.stringify(join(dir, "wake-ledger"))}, unavailable: () => null });`;
  const ran = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  return { status: ran.status, stderr: ran.stderr };
}

test("#3029: a tick whose only refusals are busy seats writes DEFERRED, no `nowhere to go`, and exits 0", () => {
  inTmp((dir) => {
    const got = tick(dir, { handedRefused: [BUSY()], gateRefused: [BUSY("ceo/blocker-cleared/row-2974/1931.1959")] });
    assert.equal(got.status, 0, got.stderr);
    assert.equal(got.stderr.split("\n").filter((l) => l.startsWith("DEFERRED ")).length, 2, got.stderr);
    assert.doesNotMatch(got.stderr, /nowhere to go|UNDELIVERED/);
    assert.ok(existsSync(join(dir, "wake-deferred")), "the age is remembered beside the ledger for the next tick");
  });
});

test("#3029: the mixed tick exits 1 and its summary counts the one refused-to-start order", () => {
  inTmp((dir) => {
    const got = tick(dir, { handedRefused: [BUSY()], gateRefused: [REFUSED_TO_START] });
    assert.equal(got.status, 1, got.stderr);
    assert.match(got.stderr, /^1 order\(s\) had nowhere to go\./m);
    assert.match(got.stderr, /^UNDELIVERED reviewer-agent-org-16\//m);
    assert.match(got.stderr, /^DEFERRED handoff\/ceo\/07ed9f53: /m);
  });
});

test("#3029: a refused-to-start order alone exits 1 (the positive control for the exit code being able to fire)", () => {
  inTmp((dir) => {
    const got = tick(dir, { gateRefused: [REFUSED_TO_START] });
    assert.equal(got.status, 1, got.stderr);
    assert.match(got.stderr, /1 order\(s\) had nowhere to go/);
  });
});

test("#3029: the same busy-seat order, remembered as first deferred 16 minutes ago, exits 1 as `nowhere to go`", () => {
  inTmp((dir) => {
    writeFileSync(join(dir, "wake-deferred"), `handoff/ceo/07ed9f53\t${Date.now() - 16 * MINUTE}\n`);
    const got = tick(dir, { handedRefused: [BUSY()] });
    assert.equal(got.status, 1, got.stderr);
    assert.match(got.stderr, /^UNDELIVERED handoff\/ceo\/07ed9f53: "ceo" is working \(deferred 16 min/m);
    assert.match(got.stderr, /1 order\(s\) had nowhere to go/);
    assert.doesNotMatch(got.stderr, /^DEFERRED /m);
  });
});

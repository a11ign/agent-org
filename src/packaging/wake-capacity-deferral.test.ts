// no-token: gh -- nothing here reaches `gh`: the report is a pure function and the one child process is `finishTick` over injected arguments
/**
 * a11ign/a11ign#3266: A READY ROW WAITING FOR A FREE ENGINEER SEAT IS `DEFERRED`, NOT `nowhere to go`.
 *
 * #3029 did this for a seat mid-turn. The same summary kept counting a queue longer than the seats: on 2026-10-03 11:57Z to 15:20Z 54 ticks wrote
 * `N order(s) had nowhere to go` and 43 of them carried a `ready-row-unclaimed` refusal in which EVERY seat read `working` or `has held #n`, each
 * claimed within minutes. The fixtures below are that journal's own lines. THE LIMIT IS WRITTEN OUT AS 30 MINUTES, never as the constant: a test
 * built from `CAPACITY_WAIT_LIMIT_MS` moves with it, so changing the limit would leave it green.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitRefusals, refusalReport, spentSeen, CAPACITY_WAIT_LIMIT_MS } from "../wake.ts";
import { idleStats } from "../org-retro.ts";

const MINUTE = 60_000;
const WAKE = fileURLToPath(new URL("../wake.ts", import.meta.url));
const KEY = "engineers/ready-row-unclaimed/3254";
const HELD = (n: number) => `worker-${n}=${spentSeen([n])}`;
const SEATS = `${HELD(3161)}, worker-3209=working, ${HELD(3198)}, worker-3212=working`;
const ALL_WORKING = `${KEY}: no engineer is idle (worker-3209=working, worker-3212=working)`;
const ALLOWED = `${KEY}: no engineer is idle and allowed to claim (${SEATS})`;
const THROTTLED = `${KEY}: no engineer is idle and allowed to claim (${SEATS}), and this tick has already started 1 (MAX_SPAWNS_PER_TICK is 1)`;
const NO_WORKSPACE = `ceo/blocker-cleared/row-2974/1931.1959: no workspace labelled "ceo"`;
const at = (minutes: number) => (keys: string[]) => new Map(keys.map((k) => [k, minutes * MINUTE]));

test("#3266: the limit is half an hour, measured: the first round number above the longest capacity wait that ended in a claim (13 min)", () => {
  assert.equal(CAPACITY_WAIT_LIMIT_MS, 30 * MINUTE);
});

test("#3266 DONE-WHEN 1: a ready row refused ONLY because every seat is `working` or holds its one row is DEFERRED with its age, and is not counted", () => {
  for (const refusal of [ALL_WORKING, ALLOWED, THROTTLED]) {
    const report = refusalReport([refusal], at(7));
    assert.equal(report.summary, null, refusal);
    assert.deepEqual(report.undelivered, [], refusal);
    assert.deepEqual(report.deferred.length, 1, "POSITIVE: the DEFERRED line is present, not merely absent from the count");
    assert.match(report.deferred[0], /^engineers\/ready-row-unclaimed\/3254: no engineer is idle .*\(waiting 7 min; retried next tick\)$/);
  }
});

test("#3266 DONE-WHEN 2: past 30 minutes a capacity wait is `nowhere to go` after all, with its age; exactly 30 is not yet over", () => {
  assert.equal(refusalReport([ALLOWED], at(30)).summary, null, "the boundary is `over`, not `at`");
  const over = refusalReport([ALLOWED], at(31));
  assert.match(over.summary ?? "", /^1 order\(s\) had nowhere to go\./);
  assert.match(over.undelivered[0], /^engineers\/ready-row-unclaimed\/3254: no engineer is idle and allowed to claim .*\(deferred 31 min, over the 30-minute limit for a free engineer seat\)$/);
  assert.deepEqual(over.deferred, []);
});

test("#3266 DONE-WHEN 3: a refusal with an idle, drained, skipped, absent or blocked seat in it stays a fault", () => {
  const faulty = [
    `${KEY}: no engineer is idle and allowed to claim (worker-judge=holds #1926 in build, worker-3209=working)`,
    `${KEY}: no engineer is idle and allowed to claim (worker-judge=drained (#2324), worker-3209=working)`,
    `${KEY}: no engineer is idle and allowed to claim (worker-3209=working, worker-3212=unknown)`,
    `${KEY}: no engineer is idle (worker-3209=working, worker-3212=absent)`,
    `${KEY}: no engineer is idle (worker-3209=working, worker-3212=blocked)`,
    `${KEY}: no engineer is idle (worker-3209=working, worker-3212=idle)`,
    `${KEY}: no engineer is idle ()`,
  ];
  for (const refusal of faulty) {
    const report = refusalReport([refusal], at(0));
    assert.deepEqual(report.undelivered, [refusal], refusal);
    assert.match(report.summary ?? "", /^1 order\(s\) had nowhere to go\./, refusal);
    assert.deepEqual(report.deferred, [], refusal);
  }
});

test("#3266: the seat shape follows `spentSeen`, the text `route` really writes -- a copy that drifted would call every capacity wait a fault", () => {
  const written = `${KEY}: no engineer is idle and allowed to claim (worker-3161=${spentSeen([3161])}, worker-3162=${spentSeen([3162, 3163])})`;
  assert.equal(splitRefusals([written]).busy.length, 1, "positive: the marker notices the remedy");
  assert.equal(splitRefusals([written.replace("one row (#2407)", "one row (#9999)")]).busy.length, 0, "and stops at a text it does not know");
});

test("#3266: a seat-working refusal that carries a SPAWN fault is that fault, never a capacity wait", () => {
  const faulty = [
    `${ALLOWED}; no spawn: the claim of #3254 as worker-3254 did not hold (NOT CLAIMED: overlaps #3223, which already touches: x.mjs)`,
    `${ALLOWED}; no spawn: all 6 engineer roles hold a process (worker-3209=working) and this order names no row`,
    `${KEY}: herdr refused the prompt to "worker-3242" (Command failed)`,
  ];
  const { busy, faults } = splitRefusals(faulty);
  assert.equal(busy.length, 0);
  assert.equal(faults.length, 3);
});

test("#3266 DONE-WHEN 4d: a mixed tick (one capacity wait, one `no workspace labelled`) still counts exactly one", () => {
  const report = refusalReport([ALLOWED, NO_WORKSPACE], at(5));
  assert.match(report.summary ?? "", /^1 order\(s\) had nowhere to go\./);
  assert.deepEqual(report.undelivered, [NO_WORKSPACE]);
  assert.equal(report.deferred.length, 1);
});

test("#3266: a seat mid-turn keeps its own limit and wording (#3029, fifteen minutes since #3448), beside a capacity wait's half hour", () => {
  const busy = `handoff/ceo/07ed9f53: "ceo" is working`;
  const report = refusalReport([busy, ALLOWED], at(20));
  assert.deepEqual(report.undelivered.length, 1, "20 minutes is over a seat mid-turn's limit and under a capacity wait's");
  assert.match(report.undelivered[0], /^handoff\/ceo\/07ed9f53: "ceo" is working \(deferred 20 min, over the 15-minute limit for a seat mid-turn\)/);
  assert.match(report.deferred[0], /^engineers\/ready-row-unclaimed\/3254: .*\(waiting 20 min/);
  assert.equal(refusalReport([busy, ALLOWED], at(35)).undelivered.length, 2, "past the half hour both are overdue");
});

// --- a gone author's order, reached through `routeWithFallback` (a11ign/a11ign#3814) ----------------------------------------------

const TRUNK_KEY = "worker-3776/trunk-red/pr-3795/eae7806c";
const GONE = `no workspace labelled "worker-3776"; and the fallback "engineers": `;
const GONE_ALLOWED = `${TRUNK_KEY}: ${GONE}no engineer is idle and allowed to claim (worker-3566=${spentSeen([3566])}, worker-3749=working)`;

test("#3814 DONE-WHEN: a gone author's order refused only because the fallback pool is full is a capacity wait, under the same half hour", () => {
  const { busy, faults } = splitRefusals([GONE_ALLOWED]);
  assert.deepEqual(faults, [], "the journal's own line is not a fault on its first tick");
  assert.equal(busy.length, 1, "POSITIVE: it is a busy entry, not merely absent from the faults");
  assert.equal(busy[0].key, TRUNK_KEY);
  assert.equal(busy[0].limitFor, "a free engineer seat");
  assert.equal(busy[0].limitMs, 30 * MINUTE);
  const report = refusalReport([GONE_ALLOWED], at(7));
  assert.equal(report.summary, null);
  assert.match(report.deferred[0], /^worker-3776\/trunk-red\/pr-3795\/eae7806c: no workspace labelled "worker-3776"; and the fallback "engineers": no engineer is idle .*\(waiting 7 min; retried next tick\)$/);
  const over = refusalReport([GONE_ALLOWED], at(31));
  assert.match(over.undelivered[0], /\(deferred 31 min, over the 30-minute limit for a free engineer seat\)$/);
});

test("#3814 POSITIVE CONTROL: the same line with a seat idle, a `; no spawn:` tail, or a first half that is not an absent author stays a fault", () => {
  const faulty = [
    `${GONE_ALLOWED.replace("worker-3749=working", "worker-3749=idle")}`,
    `${GONE_ALLOWED}; no spawn: all 6 engineer roles hold a process (worker-3749=working) and this order names no row`,
    `${TRUNK_KEY}: "worker-3776" is working; and the fallback "engineers": no engineer is idle (worker-3749=working)`,
    `${TRUNK_KEY}: no workspace labelled "worker-3776"; and the fallback "product-manager": no engineer is idle (worker-3749=working)`,
  ];
  const { busy, faults } = splitRefusals(faulty);
  assert.equal(busy.length, 0, "none of them is a capacity wait");
  assert.deepEqual(faults, faulty);
});

// --- the retro reads the same journal --------------------------------------------------------------------------------

test("#3266 DONE-WHEN 3: `idleStats` counts a `ready-row-unclaimed` offer in both forms, so the idle-minutes figure is the same on the same journal", () => {
  const tick = (...messages: string[]) => ["Starting a11ign-work-tick.service - tick", ...messages];
  const old = idleStats([
    ...tick("UNDELIVERED engineers/ready-row-unclaimed/1: no engineer is idle ()"),
    ...tick("UNDELIVERED ceo/x/1: \"ceo\" is working"),
  ].map((message, at) => ({ at, message })));
  const now = idleStats([
    ...tick("DEFERRED engineers/ready-row-unclaimed/1: no engineer is idle (w=working) (waiting 2 min; retried next tick)"),
    ...tick("DEFERRED ceo/x/1: \"ceo\" is working (waiting 2 min; retried next tick)"),
  ].map((message, at) => ({ at, message })));
  assert.equal(old.ticksWithIdleOffer, 1, "positive control: the UNDELIVERED form is counted");
  assert.deepEqual(now, old);
});

// --- the whole tick, as a process: the exit code is part of the claim ----------------------------------------------

function inTmp<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "wake-capacity-"));
  try { return body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** `finishTick` over the given refusals in a child process (it ends with `process.exit`), against a ledger in `dir`. */
function tick(dir: string, gateRefused: string[]) {
  const code = `import { finishTick } from ${JSON.stringify(WAKE)};
    finishTick({ handed: { sent: [], refused: [], ids: [], busied: new Set() }, sent: [],
      gateRefused: ${JSON.stringify(gateRefused)}, stuck: [], outaged: [], ledgerPath: ${JSON.stringify(join(dir, "wake-ledger"))}, unavailable: () => null });`;
  const ran = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  return { status: ran.status, stderr: ran.stderr };
}

test("#3266: a tick whose only refusal is a capacity wait writes DEFERRED, no `nowhere to go`, and exits 0", () => {
  inTmp((dir) => {
    const got = tick(dir, [ALLOWED]);
    assert.equal(got.status, 0, got.stderr);
    assert.match(got.stderr, /^DEFERRED engineers\/ready-row-unclaimed\/3254: /m);
    assert.doesNotMatch(got.stderr, /nowhere to go|UNDELIVERED/);
  });
});

test("#3266: the same wait, remembered as first deferred 31 minutes ago, exits 1 as `nowhere to go`", () => {
  inTmp((dir) => {
    writeFileSync(join(dir, "wake-deferred"), `${KEY}\t${Date.now() - 31 * MINUTE}\n`);
    const got = tick(dir, [ALLOWED]);
    assert.equal(got.status, 1, got.stderr);
    assert.match(got.stderr, /^UNDELIVERED engineers\/ready-row-unclaimed\/3254: .*\(deferred 31 min, over the 30-minute limit/m);
    assert.match(got.stderr, /1 order\(s\) had nowhere to go/);
  });
});

test("#3266 POSITIVE CONTROL: an idle-seat refusal alone still exits 1 (the exit code can fire)", () => {
  inTmp((dir) => {
    const got = tick(dir, [`${KEY}: no engineer is idle and allowed to claim (worker-judge=holds #1926 in build)`]);
    assert.equal(got.status, 1, got.stderr);
    assert.match(got.stderr, /1 order\(s\) had nowhere to go/);
  });
});

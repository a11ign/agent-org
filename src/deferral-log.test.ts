// a11ign/a11ign#3510 (slice 3 of #3494): the durable deferral log. Fixtures in a scratch directory only: nothing here reaches the fleet, GitHub or a real ledger.
//
// POSITIVE CONTROLS: every "appends nothing" assertion below has a twin that DOES append (`endedDeferrals` is not vacuous), and a leaf that appended on every tick rather than on the end is
// RED in "a key still deferred yields no line" and in "the same tick run twice" (measured by mutation, pasted in the pull request).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFERRAL_LOG_FILE, deferralLogText, endedDeferrals, parseDeferralLog, recordEndedDeferrals } from "./deferral-log.ts";
import { deferralAges, ledgerLine } from "./wake.ts";

const T0 = 1_000_000_000_000;
const MINUTE = 60_000;
const KEY = "orchestrator/pr-review-blocked/pr-3406";

/** @param {(dir: string) => void} body */
function inTmp(body: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "deferral-log-"));
  try { body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const noDeliveries = () => [];

test("a key present in the previous reading and absent from the current one yields ONE line with its start and its end", () => {
  const ended = endedDeferrals({ previous: new Map([[KEY, T0]]), current: new Map(), deliveries: noDeliveries, now: T0 + 5 * MINUTE });
  assert.deepEqual(ended, [{ key: KEY, startMs: T0, endMs: T0 + 5 * MINUTE, how: "gone" }]);
  assert.equal(deferralLogText(ended), `${KEY}\t${T0}\t${T0 + 5 * MINUTE}\tgone\n`);
});

test("a key still deferred yields no line, and a key first deferred this tick yields none either", () => {
  const still = endedDeferrals({ previous: new Map([[KEY, T0]]), current: new Map([[KEY, T0]]), deliveries: noDeliveries, now: T0 + MINUTE });
  assert.deepEqual(still, []);
  assert.deepEqual(endedDeferrals({ previous: new Map(), current: new Map([[KEY, T0]]), deliveries: noDeliveries, now: T0 }), []);
});

test("`delivered` is the ledger holding that key at or after the start; a delivery BEFORE the start, or of another key, is `gone`", () => {
  const read = (deliveries: { at: number; key: string; }[]) => endedDeferrals({ previous: new Map([[KEY, T0]]), current: new Map(), deliveries: () => deliveries, now: T0 + MINUTE })[0].how;
  assert.equal(read([{ at: T0 + MINUTE, key: KEY }]), "delivered");
  assert.equal(read([{ at: T0, key: KEY }]), "delivered", "at the start counts: the order went out the tick it was first deferred, as a retry");
  assert.equal(read([{ at: T0 - 1, key: KEY }]), "gone", "an earlier delivery of the same key is the PREVIOUS span's");
  assert.equal(read([{ at: T0 + MINUTE, key: "orchestrator/other/pr-1" }]), "gone");
});

test("the ledger is read only when something ended", () => {
  let reads = 0;
  const counting = () => { reads += 1; return []; };
  endedDeferrals({ previous: new Map([[KEY, T0]]), current: new Map([[KEY, T0]]), deliveries: counting, now: T0 });
  assert.equal(reads, 0);
  endedDeferrals({ previous: new Map([[KEY, T0]]), current: new Map(), deliveries: counting, now: T0 });
  assert.equal(reads, 1);
});

/** One tick as the gate runs it: `deferralAges` over this tick's deferred keys, the ledger beside the file. */
function tick(dir: string, keys: string[], now: number) {
  return deferralAges(join(dir, "wake-deferred"), keys, now, { ledgerPath: join(dir, "wake-ledger") });
}

const logOf = (dir: string) => { try { return readFileSync(join(dir, DEFERRAL_LOG_FILE), "utf8"); } catch (cause) { if ((cause as any).code === "ENOENT") return ""; throw cause; } };

test("through the gate's own writer: a deferral is logged by the tick that ENDS it, once, with how it ended", () => {
  inTmp((dir) => {
    tick(dir, [KEY], T0);
    tick(dir, [KEY], T0 + 2 * MINUTE);
    assert.equal(logOf(dir), "", "a deferral still open is not in the log");
    writeFileSync(join(dir, "wake-ledger"), ledgerLine(T0 + 4 * MINUTE, KEY));
    tick(dir, [], T0 + 4 * MINUTE);
    assert.equal(logOf(dir), `${KEY}\t${T0}\t${T0 + 4 * MINUTE}\tdelivered\n`);
    tick(dir, [], T0 + 6 * MINUTE);
    tick(dir, [], T0 + 6 * MINUTE);
    assert.equal(logOf(dir).split("\n").filter(Boolean).length, 1, "the same tick run again appends nothing twice");
  });
});

test("a key that reappears after its delivery starts a NEW span, and a span that left with no delivery is `gone`", () => {
  inTmp((dir) => {
    writeFileSync(join(dir, "wake-ledger"), ledgerLine(T0 + 2 * MINUTE, KEY));
    tick(dir, [KEY], T0);
    tick(dir, [], T0 + 2 * MINUTE);
    tick(dir, [KEY], T0 + 10 * MINUTE);
    tick(dir, [], T0 + 13 * MINUTE);
    assert.deepEqual(parseDeferralLog(logOf(dir)), [
      { key: KEY, startMs: T0, endMs: T0 + 2 * MINUTE, how: "delivered" },
      { key: KEY, startMs: T0 + 10 * MINUTE, endMs: T0 + 13 * MINUTE, how: "gone" },
    ]);
  });
});

test("the log is appended BEFORE `wake-deferred` is rewritten: a failed append leaves the old file, so the ending is found again", () => {
  inTmp((dir) => {
    tick(dir, [KEY], T0);
    const failing = () => { throw new Error("disk full"); };
    assert.throws(() => recordEndedDeferrals({ logPath: join(dir, DEFERRAL_LOG_FILE), previous: new Map([[KEY, T0]]), current: new Map(), deliveries: noDeliveries, now: T0 + MINUTE, append: failing }), /disk full/);
    assert.equal(readFileSync(join(dir, "wake-deferred"), "utf8"), `${KEY}\t${T0}\n`);
    tick(dir, [], T0 + 2 * MINUTE);
    assert.equal(logOf(dir), `${KEY}\t${T0}\t${T0 + 2 * MINUTE}\tgone\n`);
  });
});

test("a caller that names no ledger keeps no log (it could not say `delivered`), and the gate's own call names one", () => {
  inTmp((dir) => {
    deferralAges(join(dir, "wake-deferred"), [KEY], T0);
    deferralAges(join(dir, "wake-deferred"), [], T0 + MINUTE);
    assert.equal(logOf(dir), "");
  });
  // The control that the skip above is not what the gate does: `finishTick` is the gate's one caller, and it hands the ledger over.
  const wake = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "wake.ts"), "utf8");
  assert.match(wake, /deferralAges\(`\$\{dirname\(ledgerPath\)\}\/wake-deferred`, keys, Date\.now\(\), \{ ledgerPath \}\)/);
});

test("a line that does not parse THROWS, naming the file, as readDeferralHistory does", () => {
  assert.deepEqual(parseDeferralLog(`${KEY}\t${T0}\t${T0 + 1}\tdelivered\n\n`), [{ key: KEY, startMs: T0, endMs: T0 + 1, how: "delivered" }]);
  for (const bad of [`${KEY}\t${T0}`, `${KEY}\t${T0}\t${T0 + 1}`, `${KEY}\t${T0}\t${T0 + 1}\tmaybe`, `${KEY}\tx\t${T0}\tgone`, `${KEY}\t${T0}\t${T0 - 1}\tgone`, `${KEY}\t${T0}\t${T0 + 1}\tgone\textra`, `\t${T0}\t${T0 + 1}\tgone`]) {
    assert.throws(() => parseDeferralLog(bad, "/x/wake-deferral-log"), /\/x\/wake-deferral-log has a line that is not/, bad);
  }
});

test("the default append creates the log's directory and writes the line", () => {
  inTmp((dir) => {
    const logPath = join(dir, "nested", DEFERRAL_LOG_FILE);
    recordEndedDeferrals({ logPath, previous: new Map([[KEY, T0]]), current: new Map(), deliveries: noDeliveries, now: T0 + MINUTE });
    assert.equal(readFileSync(logPath, "utf8"), `${KEY}\t${T0}\t${T0 + MINUTE}\tgone\n`);
  });
});

test("the QUIET tick (nothing offered, nothing queued) ends a deferral that went away: `finishTick` is never reached from there, so the entry itself must", () => {
  inTmp((dir) => {
    const wake = join(dirname(fileURLToPath(import.meta.url)), "wake.ts");
    writeFileSync(join(dir, "wake-deferred"), `${KEY}\t${T0}\n`);
    // No herdr is asked: the quiet exit comes before the roster is read, so this is the whole entry run for real against a scratch ledger directory.
    const ran = spawnSync(process.execPath, [wake, `--ledger=${join(dir, "wake-ledger")}`], { input: "", encoding: "utf8", env: { ...process.env, HOME: dir } });
    assert.equal(ran.status, 0, ran.stderr);
    const [span, ...rest] = parseDeferralLog(logOf(dir));
    assert.deepEqual([span.key, span.startMs, span.how, rest.length], [KEY, T0, "gone", 0]);
    assert.ok(span.endMs > T0, "ended by the tick's own clock");
    assert.equal(readFileSync(join(dir, "wake-deferred"), "utf8"), "", "nothing is deferred when nothing is offered, so the stale key is not left to give a later re-deferral the old start");
  });
});

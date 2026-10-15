// no-token: isAppLogin -- every input is handed in (`io`, `facts`, `options`, a throwaway state directory); the only reach to `isAppLogin` is `ledgerSpender`, which none of these tests calls, and nothing reaches GitHub, git or herdr
/**
 * a11ign#5444 (agent-org#1424): THE CANARY'S BAR IS BUILT FROM THE DAY, NOT FROM ONE QUIET HOUR.
 *
 * THE DEFECT, 2026-10-13: `rows.closedUnderOpenHalf` was turned on and reverted 34 minutes later on `claims-refused` "0 in the hour before, 3 since: reached 3 (2x and +3)". A zero
 * hour set the bar at the org's own base rate, so three ordinary refusals reverted a flag that never touches a claim. The bar now takes the higher of the hour and the day's hourly mean.
 *   (1) 0 before, 3 after, 24 h mean 3/h: `ok`, through the real `signalReading`, and through the tick that keeps the samples (`machineryCanaryTick`);
 *   (2) 0 before, 20 after, same mean: still `degraded` (the storm test);
 *   (3) a day unread, or less than half recorded: today's rule, pinned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANARY_STATE_FILE, DEFAULT_CANARY_OPTIONS, MACHINERY_SIGNALS, machineryCanaryTick, machineryFlagOn, parseCanaryState, signalReading, withMachineryFlag,
  type CanaryFacts, type CanaryIo, type CanarySample,
} from "./org-health.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ON = Date.parse("2026-10-13T14:38:00Z");
const CLAIMS = MACHINERY_SIGNALS.CLAIMS_REFUSED;
const OPTIONS = { ...DEFAULT_CANARY_OPTIONS };
const FLAG = "rows.closedUnderOpenHalf";

/** One hour of samples ending `hoursBefore` hours before the flag was turned on: `0` for the quiet hour, `perHour` for every other. */
const hourSample = (hoursBefore: number, value: number | null): CanarySample => ({
  from: ON - (hoursBefore + 1) * HOUR, to: ON - hoursBefore * HOUR, values: { [CLAIMS]: value },
});

/** The day before the flag: 24 hours, the one before quiet at `0` and the other 23 at `perHour`. */
const dayBefore = (perHour: number): CanarySample[] => Array.from({ length: 24 }, (_, k) => hourSample(k, k === 0 ? 0 : perHour));

const after = (count: number, minutes = 34): CanarySample => ({ from: ON, to: ON + minutes * MINUTE, values: { [CLAIMS]: count } });

const read = (samples: CanarySample[], count: number) =>
  signalReading({ signal: CLAIMS, samples: [...samples, after(count)], onAt: ON, now: ON + 34 * MINUTE, options: OPTIONS });

test("#5444 (1) 0 BEFORE, 3 AFTER, A DAY AT 3 AN HOUR: `ok`, and the detail names the baseline", () => {
  const reading = read(dayBefore(3), 3);
  assert.equal(reading.status, "ok", reading.detail);
  assert.equal(reading.before, 0, "the hour before is still reported as it was");
  assert.match(reading.detail, /0 in the hour before; 24 h mean 2\.9\/h is the baseline, 3 since \(34 min\): stayed under 5\.9/);
});

test("#5444 (2) 0 BEFORE, 20 AFTER, THE SAME DAY: still `degraded`, the storm the canary exists to catch", () => {
  const reading = read(dayBefore(3), 20);
  assert.equal(reading.status, "degraded", reading.detail);
  assert.match(reading.detail, /reached 5\.9 \(2x and \+3\)/);
});

test("#5444 (3a) A DAY UNREAD: today's rule stands, so 3 after a quiet hour is `degraded`", () => {
  const reading = read([hourSample(0, 0)], 3);
  assert.equal(reading.status, "degraded", reading.detail);
  assert.doesNotMatch(reading.detail, /24 h mean/);
});

test("#5444 (3b) A DAY LESS THAN HALF RECORDED: no baseline from it, so today's rule stands", () => {
  const tenHours = Array.from({ length: 10 }, (_, k) => hourSample(k, k === 0 ? 0 : 3));
  const reading = read(tenHours, 3);
  assert.equal(reading.status, "degraded", reading.detail);
  assert.doesNotMatch(reading.detail, /24 h mean/);
});

test("#5444 (4) THROUGH THE TICK: a quiet hour after a day at 3 an hour does not revert the flag, and the samples reach back a day", () => {
  const refusals: number[] = [];
  for (let hour = -24; hour <= -2; hour += 1) refusals.push(ON + (hour * 60 + 10) * MINUTE, ON + (hour * 60 + 30) * MINUTE, ON + (hour * 60 + 50) * MINUTE);
  const files = new Map<string, string>();
  const filed: string[] = [];
  const io: CanaryIo = {
    read: (path) => files.get(path) ?? null,
    write: (path, text) => { files.set(path, text); },
    fileIncident: (title) => { filed.push(title); return "https://github.com/a11ign/a11ign/issues/1"; },
    log: () => {},
  };
  const dir = "/state";
  const facts = (refusalsAt: number[]): CanaryFacts => ({ claimRefusals: refusalsAt.map((at) => ({ at, reason: "B4" })), unread: [], deferredWakes: 0, unarmed: [], releaseRuns: { runs: [] } as any });
  const tickAt = (minute: number, refusalsAt: number[]) => machineryCanaryTick({ now: ON + minute * MINUTE, facts: facts(refusalsAt), suppressed: [], dir, options: OPTIONS, io });
  const state = () => parseCanaryState(files.get(`${dir}/${CANARY_STATE_FILE}`) ?? null);

  for (let minute = -1440; minute <= -10; minute += 10) tickAt(minute, refusals);
  const earliest = state().samples[0];
  assert.ok(earliest.from <= ON - 24 * HOUR, `the samples reach back a day (earliest from ${new Date(earliest.from).toISOString()})`);

  files.set(`${dir}/${CANARY_STATE_FILE}`, JSON.stringify(withMachineryFlag(state(), { name: FLAG, on: true, signals: [CLAIMS] })));
  tickAt(0, refusals); // the quiet hour, which the flag's first tick starts
  for (const minute of [10, 20, 30]) {
    refusals.push(ON + (minute - 5) * MINUTE);
    tickAt(minute, refusals);
  }

  assert.equal(machineryFlagOn(state(), FLAG), true, "THE FLAG STAYS ON");
  assert.equal(filed.length, 0, "no incident");
  const reading = state().flags[FLAG].readings.find((r) => r.signal === CLAIMS);
  assert.equal(reading?.status, "ok", reading?.detail);
  assert.match(reading?.detail ?? "", /24 h mean/);
});

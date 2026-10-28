// no-token: none -- the clock, the files and the deps are injected; nothing reaches Linear or the disk beyond a temporary folder
//
// A11-359: the board logs how often its calls to Linear fail, and doctor flags more than one failure in a hundred calls over an hour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../../src/lib/tmp-fixture.ts";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import { callLog, CALLS_FILE, describeCounts, isFlagged, readCounts, WINDOW_MS } from "./call-log.ts";
import { callsCheck } from "./checks.ts";
import { doctorChecks } from "./index.ts";

const HOUR = WINDOW_MS;

test("more than one failure in a hundred calls is flagged: two in a hundred is, one in a hundred is not, and a single failure never is", () => {
  assert.equal(isFlagged({ calls: 100, failures: 2 }), true);
  assert.equal(isFlagged({ calls: 100, failures: 1 }), false, "exactly one in a hundred is not more than one in a hundred");
  assert.equal(isFlagged({ calls: 150, failures: 2 }), true);
  assert.equal(isFlagged({ calls: 300, failures: 2 }), false);
  assert.equal(isFlagged({ calls: 3, failures: 1 }), false, "one failure alone is not a rate");
  assert.equal(isFlagged({ calls: 0, failures: 0 }), false);
});

test("the log counts the attempts of the last hour: older ones drop out, so a bad hour does not shadow the next", () => {
  let clock = 1_000_000;
  const log = callLog({ stateDir: "", now: () => clock });
  log.record(true);
  clock += 10 * 60_000;
  log.record(false);
  assert.deepEqual(pick(log.record(false)), { calls: 3, failures: 1 });
  clock += HOUR - 10 * 60_000;
  assert.deepEqual(pick(log.record(false)), { calls: 3, failures: 0 }, "the failure of an hour ago is out of the window");
});

const pick = ({ calls, failures }: { calls: number; failures: number }) => ({ calls, failures });

test("the count is written to the state folder for doctor, a failure within a second of the last write waits for the next, and a state folder that cannot be written fails nothing", () => {
  const dir = tmpDir("call-log-");
  let clock = 5_000;
  const log = callLog({ stateDir: dir, now: () => clock });
  log.record(true);
  assert.deepEqual(pick(readCounts(readFileSync(join(dir, CALLS_FILE), "utf8"))!), { calls: 1, failures: 1 });
  clock += 500;
  log.record(true);
  assert.deepEqual(pick(readCounts(readFileSync(join(dir, CALLS_FILE), "utf8"))!), { calls: 1, failures: 1 }, "written at most once a second after a failure");
  clock += 1_000;
  log.record(true);
  assert.deepEqual(pick(readCounts(readFileSync(join(dir, CALLS_FILE), "utf8"))!), { calls: 3, failures: 3 });
  const broken = callLog({ stateDir: dir, now: () => clock, write: () => { throw new Error("EROFS"); } });
  assert.deepEqual(pick(broken.record(true)), { calls: 1, failures: 1 }, "the count goes on in memory");
});

test("describeCounts and readCounts: the words a log line and a doctor row use, and a file that is not a count", () => {
  assert.equal(describeCounts({ calls: 140, failures: 2 }), "2 of 140 calls failed in the last hour (1.4%)");
  assert.equal(describeCounts({ calls: 0, failures: 0 }), "0 of 0 calls failed in the last hour");
  assert.equal(readCounts("not json"), null);
  assert.equal(readCounts(JSON.stringify({ at: 1, windowMs: 2, calls: "x", failures: 0 })), null);
});

const NOW = 10 * HOUR;
const depsWith = (file: string | undefined) => fakePluginDeps({ stateDir: "/state", readFile: (path) => { if (path === `/state/${CALLS_FILE}` && file !== undefined) return file; throw new Error("ENOENT"); } });
const written = (calls: number, failures: number, at = NOW - 60_000) => JSON.stringify({ at, windowMs: HOUR, calls, failures });

test("doctor's linear calls row fails above one failure in a hundred over the last hour, says the rate, and names where to look", () => {
  const bad = callsCheck(depsWith(written(120, 4)), NOW);
  assert.deepEqual([bad.name, bad.ok, bad.detail], ["linear calls", false, "4 of 120 calls failed in the last hour (3.3%)"]);
  assert.match(bad.fix ?? "", /Linear: a call failed/);
  const fine = callsCheck(depsWith(written(400, 2)), NOW);
  assert.deepEqual([fine.ok, fine.detail], [true, "2 of 400 calls failed in the last hour (0.5%)"]);
});

test("doctor's linear calls row passes where there is nothing to flag: no file, and a count older than the hour", () => {
  assert.equal(callsCheck(depsWith(undefined), NOW).ok, true);
  assert.match(callsCheck(depsWith(undefined), NOW).detail, /no call to Linear yet/);
  const stale = callsCheck(depsWith(written(50, 20, NOW - HOUR - 1)), NOW);
  assert.deepEqual([stale.ok, stale.detail], [true, "the board has made no call to Linear in the last hour"]);
});

test("doctor's linear calls row fails when the count is there but unknown: not JSON, the wrong shape, or unreadable", () => {
  for (const file of ["{", "not json", JSON.stringify({ at: NOW, windowMs: HOUR, calls: "x", failures: 0 })]) {
    const row = callsCheck(depsWith(file), NOW);
    assert.deepEqual([row.ok, /unknown/.test(row.detail)], [false, true], file);
    assert.match(row.fix ?? "", /writes .* afresh/);
  }
  const unreadable = fakePluginDeps({ stateDir: "/state", readFile: () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); } });
  const row = callsCheck(unreadable, NOW);
  assert.deepEqual([row.ok, /could not be read .*EACCES/.test(row.detail)], [false, true]);
});

test("the plugin's doctor rows include the calls row", () => {
  assert.deepEqual(doctorChecks({}, depsWith(undefined)).map(({ name }) => name).slice(-1), ["linear calls"]);
});

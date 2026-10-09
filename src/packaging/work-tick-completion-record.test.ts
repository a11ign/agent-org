// no-token: gh
//
// Nothing here reaches the network or a real `gh`. The tick under test runs from a temporary `src/` whose `work-gate.ts` and `wake.ts` are stubs,
// with the PATH pointed at an empty directory, so no `herdr` is found and no order can reach a session. ERASABLE TYPESCRIPT ONLY: node strips the
// types itself (`--experimental-strip-types` on node 22 before 22.18's default), so there is no enum, namespace or parameter property here.

/**
 * #3040: `incident:gate-crash` CANNOT SEE A TICK THAT CRASHED, because the unit's last-run time moves on a crashed tick.
 *
 * On 2026-10-02 the work-tick unit ran 63 ticks that each died at import (15:23Z to about 17:40Z) and `InactiveEnterTimestamp` advanced on every one
 * exactly as on a good tick. The tick therefore writes a record of its own, and ONLY when it reaches the end of `main()`; the incident reads that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT } from "../work-tick.ts";
import { COMPLETION_FILE, completionPath, readCompletion, writeCompletion } from "../lib/tick-completion.ts";
import { DEFAULT_INCIDENT_CONFIG, gateCrashEvents } from "../messaging/sources/incidents.ts";
import { TICK_INTERVAL_MS } from "../messaging/sources/stall.ts";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const PRELOAD = join(SRC, "lib", "crash-exit.mjs");
const TICKS = 63;

type Tick = { gate: string; wake?: string; tickPrefix?: string; recordIsADirectory?: boolean };

/**
 * A tool checkout of one file's worth: the real `work-tick.ts` COPIED (it finds its children beside itself), every other entry of `src/` linked, and
 * `work-gate.ts` and `wake.ts` written as stubs. The tick runs under the preload, as the unit runs it. Returns what the record held when the tick ended.
 */
function runTick({ gate, wake = "process.exit(0);", tickPrefix = "", recordIsADirectory = false }: Tick) {
  const dir = mkdtempSync(join(tmpdir(), "tick-record-"));
  try {
    const src = join(dir, "src");
    mkdirSync(src);
    writeFileSync(join(src, "package.json"), '{"type":"module"}'); // tsx reads a loose .ts as CommonJS without it, and a .mjs it reaches then fails on its top-level await
    const own = new Set(["work-tick.ts", "work-gate.ts", "wake.ts"]);
    for (const name of readdirSync(SRC).filter((entry) => !own.has(entry))) symlinkSync(join(SRC, name), join(src, name));
    writeFileSync(join(src, "work-tick.ts"), tickPrefix + readFileSync(join(SRC, "work-tick.ts"), "utf8"));
    writeFileSync(join(src, "work-gate.ts"), gate);
    writeFileSync(join(src, "wake.ts"),
      `export * from ${JSON.stringify(join(SRC, "wake.ts"))};\n`
      + `import { fileURLToPath } from "node:url";\n`
      + `if (process.argv[1] === fileURLToPath(import.meta.url)) {\n  ${wake}\n}\n`);
    mkdirSync(join(dir, "empty"));
    const ledger = join(dir, "ledger.jsonl");
    const record = completionPath(ledger);
    if (recordIsADirectory) mkdirSync(record);
    const before = Date.now();
    const ran = spawnSync(process.execPath, [`--import=${PRELOAD}`, join(src, "work-tick.ts"), `--ledger=${ledger}`], {
      encoding: "utf8", cwd: dir, env: { ...process.env, PATH: join(dir, "empty"), GH_CONFIG_DIR: "" }, // (#4148) none: a tick given an account directory probes GitHub and writes a read-cache under it; these tests must do neither

    });
    const after = Date.now();
    const written = !recordIsADirectory && existsSync(record) ? readCompletion(record) : null;
    return { ran, record: written, window: { before, after } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GATE_THROWS = 'throw new Error("ENOENT: open /home/agent/.agent-org/project.json");\n';

test("#3040: a QUIET tick writes the record, with the time it finished and the code it exits with", () => {
  const { ran, record, window } = runTick({ gate: "process.exit(0);" });
  assert.equal(ran.status, EXIT.QUIET, ran.stderr);
  assert.ok(record !== null, "a tick that reached the end of main() is on record");
  assert.equal(record.exit, EXIT.QUIET);
  assert.ok(record.at >= window.before && record.at <= window.after, `${record.at} is not within the run ${window.before}..${window.after}`);
});

test("#3040 POSITIVE CONTROL: a tick whose orders had nowhere to go (ATTENTION, exit 1) STILL writes the record, and is NOT an incident", () => {
  const { ran, record } = runTick({ gate: "process.exit(1);", wake: "process.exit(1);" });
  assert.equal(ran.status, EXIT.ATTENTION, ran.stderr);
  assert.ok(record !== null, "the organisation waiting is not the gate crashing");
  assert.equal(record.exit, EXIT.ATTENTION);
  const now = record.at + TICK_INTERVAL_MS;
  const [event] = gateCrashEvents({ failed: false, lastRunAt: now - 1000, lastRecordAt: record.at }, now, DEFAULT_INCIDENT_CONFIG);
  assert.equal(event.resolved, true);
});

test("#3040: a tick that could not ASK (the gate exited 2) completed too, and says exit 2", () => {
  const { ran, record } = runTick({ gate: "process.exit(2);" });
  assert.equal(ran.status, EXIT.CANNOT_ASK, ran.stderr);
  assert.equal(record?.exit, EXIT.CANNOT_ASK);
});

test("#3040: a tick that CRASHES writes NO record -- the gate throwing, wake throwing, and the tick itself throwing at import", () => {
  const gate = runTick({ gate: GATE_THROWS });
  assert.equal(gate.ran.status, EXIT.CRASH, gate.ran.stderr);
  assert.equal(gate.record, null, "a gate that crashed is not a tick that completed");
  const wake = runTick({ gate: "process.exit(1);", wake: 'throw new Error("wake blew up");' });
  assert.equal(wake.ran.status, EXIT.CRASH, wake.ran.stderr);
  assert.equal(wake.record, null);
  // The 2026-10-02 shape: the throw is at IMPORT, before main() exists.
  const atImport = runTick({ gate: "process.exit(0);", tickPrefix: 'throw new Error("ENOENT: open /home/agent/.agent-org/project.json");\n' });
  assert.equal(atImport.ran.status, EXIT.CRASH, atImport.ran.stderr);
  assert.equal(atImport.record, null);
});

test("#3040: a record that cannot be WRITTEN is said on stderr and does not turn a finished tick into a failure", () => {
  const { ran } = runTick({ gate: "process.exit(0);", recordIsADirectory: true });
  assert.equal(ran.status, EXIT.QUIET, "the tick did its work");
  assert.match(ran.stderr, /COMPLETION NOT RECORDED at .*work-tick-completion\.json/);
});

test("#3040: the record sits beside the ledger, and an absent or unreadable one is a TypeError", () => {
  assert.equal(completionPath("/state/agent-org/wake-ledger"), `/state/agent-org/${COMPLETION_FILE}`);
  const dir = mkdtempSync(join(tmpdir(), "tick-record-read-"));
  try {
    const path = join(dir, COMPLETION_FILE);
    assert.throws(() => readCompletion(path), TypeError);
    writeCompletion(path, { at: 1790950909000, exit: 0 });
    assert.deepEqual(readCompletion(path), { at: 1790950909000, exit: 0 });
    writeFileSync(path, "{");
    assert.throws(() => readCompletion(path), TypeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#3040 end to end: after a real completed tick, 63 intervals in which the unit keeps RUNNING and no record is written are the incident, and it names that tick", () => {
  const { record } = runTick({ gate: "process.exit(0);" });
  assert.ok(record !== null);
  const outcomes = Array.from({ length: TICKS }, (_, index) => {
    const started = record.at + (index + 1) * TICK_INTERVAL_MS;
    return gateCrashEvents({ failed: false, lastRunAt: started + 1000, lastRecordAt: record.at }, started + 2000, DEFAULT_INCIDENT_CONFIG)[0];
  });
  const firstDown = outcomes.findIndex((event) => event.resolved === false) + 1;
  assert.ok(firstDown >= 1 && firstDown <= DEFAULT_INCIDENT_CONFIG.gateStaleTicks, `the incident opened at interval ${firstDown}, past gateStaleTicks`);
  assert.ok(outcomes.slice(firstDown - 1).every((event) => event.resolved === false));
  assert.ok(String(outcomes[TICKS - 1].text).includes(new Date(record.at).toISOString()), String(outcomes[TICKS - 1].text));
  assert.match(String(outcomes[TICKS - 1].text), /ticks are still starting/);
});

test("#3040 POSITIVE CONTROL: 63 consecutive intervals in which each tick completes and records are never an incident", () => {
  const { record } = runTick({ gate: "process.exit(0);" });
  assert.ok(record !== null);
  for (let index = 1; index <= TICKS; index += 1) {
    const finished = record.at + index * TICK_INTERVAL_MS;
    const [event] = gateCrashEvents({ failed: false, lastRunAt: finished, lastRecordAt: finished }, finished + 1000, DEFAULT_INCIDENT_CONFIG);
    assert.equal(event.resolved, true, `interval ${index}`);
  }
});

test("#3040: every way out of main() goes through finish(), so none can skip the record", () => {
  const source = readFileSync(join(SRC, "work-tick.ts"), "utf8");
  assert.equal((source.match(/process\.exit\(/g) ?? []).length, 1, "ONE exit in the tick (finish), so no path out of main() skips the record");
});

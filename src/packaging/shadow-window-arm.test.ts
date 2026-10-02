// no-token: gh
//
// Nothing here reaches the network, a real `gh`, the fleet or the lab. Every directory is a temp one this file builds and deletes, `systemctl` is a
// stub wherever the code under test would call it, and the rendered units are read, not installed.

/**
 * #2867 (the split, child 5f of #69): ARMING THE SHADOW WINDOW -- a separate `Type=oneshot` unit pair beside the work-tick unit that runs the #2846 runner
 * every two minutes, ENDS ITSELF, and records a gap as a row. `ceo` sanctioned the arrangement on #2623 and NOT the cut-over, so what this file pins is
 * what keeps the arrangement from being one: the live unit's text does not move, the shadow service shares nothing with it, and the window stops by
 * itself on either of two clocks.
 *
 * THE FIXTURES ARE REAL: a live state directory on disk, tap files in the format #2849 writes, a candidate module the runner spawns as a child, and a
 * marker made by `armWindow` itself (never hand-written, so the writer and the reader cannot drift). The clock is the `now` the runner is handed.
 *
 * POSITIVE CONTROLS, so no emptiness or "does not stop" assertion passes on an empty population: a record of exactly 1,440 ticks STOPS the window, a
 * record with one gap holds a gap row AND still counts every tick, the closure check names a file that differs and then stops complaining once it is
 * restored, and the same exit status 2 is a SUCCESS for the live unit and a FAILURE for the shadow one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SHIPPED_DIR, TOOL_ENTRIES, hostUnitsInstall, shippedUnitText, shippedUnits } from "../host-units.mjs";
import { HARD_STOP_MS, WINDOW_TICKS, armWindow, readRecordRows, readWindowMarker, ticksRecorded, windowTick } from "../shadow-window.mjs";
import { SHADOW_WINDOW_MARKER, tapShadowReads } from "../shadow-reads.mjs";
import { homeHostConfig } from "../host-config.mjs";
import { sandboxGitEnv } from "../lib/git-env.mjs";

const RUNNER = fileURLToPath(new URL("../shadow-window.mjs", import.meta.url));
const REPO_SRC = fileURLToPath(new URL("../../../agent-org/src", import.meta.url));
const MINUTE = 60_000;
const TICK = 2 * MINUTE;
const T0 = Date.parse("2026-10-02T12:00:00Z");
const TIMER = "a11ign-shadow-window.timer";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
/** The digest of the work-tick unit the host runs today, restated from `host-tool-install.test.ts` so this file's claim is checkable alone. */
const TODAYS_WORK_TICK_SHA = "9704e2c1c8371234816275a81cf32cbe591dbb679543b50765a4adc581110a35"; // #2974: the pnpm line; the plain rendering, see `plainHost`
/** a11ign's host with no `tool`, so the digest above is of the template whether or not the cut has set the key. */
const plainHost = (() => {
  const { tool: _tool, ...plain } = homeHostConfig();
  return Object.freeze(plain);
})() as never;

/** What systemd reads out of a unit's non-comment lines. */
const directives = (unit: string) => unit.split("\n").filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));

// --- 1. the unit pair ---------------------------------------------------------------------------------------------------------------

test("the shadow pair is shipped as two templates, classified as the tool's, and renders beside the work-tick pair", () => {
  assert.ok(TOOL_ENTRIES.includes("shadow-window.service.in") && TOOL_ENTRIES.includes("shadow-window.timer.in"));
  const names = shippedUnits();
  for (const name of ["a11ign-shadow-window.service", "a11ign-shadow-window.timer", "a11ign-work-tick.service", "a11ign-work-tick.timer"]) {
    assert.ok(names.includes(name), `${name} is shipped: ${names.join(", ")}`);
  }
  const service = shippedUnitText("a11ign-shadow-window.service") ?? "";
  const timer = shippedUnitText(TIMER) ?? "";
  assert.ok(service !== "" && timer !== "", "both render");
  assert.doesNotMatch(service + timer, /@@/, "no placeholder is left unfilled");
  assert.match(service, /^Type=oneshot$/m);
  assert.match(timer, /^OnUnitActiveSec=2min$/m, "the live timer's own cadence");
  assert.match(shippedUnitText("a11ign-work-tick.timer") ?? "", /^OnUnitActiveSec=2min$/m, "POSITIVE CONTROL: the live timer says the same line, so the equality above is of two real lines");
});

test("installing the pair changes no byte of the work-tick unit: it matches today's digest AND a rendering of the host directory without the pair", () => {
  const withoutPair = mkdtempSync(join(tmpdir(), "a11y-shadow-arm-without-"));
  try {
    for (const name of readdirSync(SHIPPED_DIR)) {
      if (!name.startsWith("shadow-window.")) cpSync(join(SHIPPED_DIR, name), join(withoutPair, name));
    }
    assert.equal(readdirSync(withoutPair).length, readdirSync(SHIPPED_DIR).length - 2, "POSITIVE CONTROL: the copy lacks exactly the two shadow templates");
    for (const unit of ["a11ign-work-tick.service", "a11ign-work-tick.timer"]) {
      assert.equal(shippedUnitText(unit), shippedUnitText(unit, { shippedDir: withoutPair, projectUnitsDir: null }), `${unit}: the same text with and without the pair`);
    }
  } finally {
    rmSync(withoutPair, { recursive: true, force: true });
  }
  const installed = mkdtempSync(join(tmpdir(), "a11y-shadow-arm-installed-"));
  try {
    const calls: string[] = [];
    hostUnitsInstall({ host: plainHost, installedDir: installed, systemctl: (args: string[]) => (calls.push(args.join(" ")), ""), out: () => undefined });
    assert.equal(sha256(readFileSync(join(installed, "a11ign-work-tick.service"), "utf8")), TODAYS_WORK_TICK_SHA, "the installed live service is today's bytes");
    for (const unit of ["a11ign-shadow-window.service", TIMER]) assert.ok(existsSync(join(installed, unit)), `${unit} was installed`);
    assert.ok(calls.includes(`enable --now ${TIMER}`), `the timer is enabled with --now, as every timer is: ${calls.join(" | ")}`);
  } finally {
    rmSync(installed, { recursive: true, force: true });
  }
});

/** systemd's rule for whether an exit status is a success: 0, plus the listed statuses. */
function succeeds(unit: string, status: number): boolean {
  const listed = /^SuccessExitStatus=(.*)$/m.exec(unit)?.[1].split(/\s+/).map(Number) ?? [];
  return status === 0 || listed.includes(status);
}

test("a failing shadow run fails the SHADOW service and not the live tick: no coupling, and the same exit 2 is a success only for the live unit", () => {
  const shadow = shippedUnitText("a11ign-shadow-window.service") ?? "";
  const live = shippedUnitText("a11ign-work-tick.service") ?? "";
  const live2 = succeeds(live, 2), shadow2 = succeeds(shadow, 2);
  assert.equal(live2, true, "POSITIVE CONTROL: the live tick treats 2 as an ordinary state");
  assert.equal(shadow2, false, "the shadow service treats 2 as a failed run");
  const coupled = directives(shadow).filter((line) => /work-tick|^(After|Before|Requires|Wants|BindsTo|PartOf|OnFailure|Upholds|Conflicts)=.*work-tick/.test(line));
  assert.deepEqual(coupled, [], "nothing in the shadow service names the live tick");
  assert.notEqual(directives(live).length, 0, "POSITIVE CONTROL: the filter reads real directives");
  assert.deepEqual(directives(shadow).filter((line) => /^(After|Before|Requires|BindsTo|PartOf|OnFailure)=/.test(line)), ["After=herdr.service"],
    "the shadow service's only ordering is the one the live unit also has");
  assert.deepEqual(directives(shippedUnitText(TIMER) ?? "").filter((line) => /work-tick/.test(line)), [], "nor does its timer");
});

test("the rendered service carries memory and CPU caps, the swap cap that makes the memory cap hold, and the host declaration", () => {
  const service = shippedUnitText("a11ign-shadow-window.service") ?? "";
  for (const key of ["MemoryHigh", "MemoryMax", "CPUQuota", "TasksMax"]) assert.match(service, new RegExp(`^${key}=\\S+$`, "m"), `${key} is present`);
  assert.match(service, /^MemorySwapMax=0$/m, "MemoryMax alone let a runaway put 7.9 GB into swap for 19 s (measured 2026-10-01)");
  assert.match(service, /^Environment=NODE_OPTIONS=--max-old-space-size=\d+$/m, "the heap cap, which the candidate child inherits");
  assert.match(service, /^Environment=AGENT_ORG_HOST=\/\S+\/\.agent-org\/host\.json$/m, "the candidate resolves a11ign's project from the host declaration (#2873)");
  assert.match(service, /^Environment=NODE_COMPILE_CACHE=%h\/\.cache\/node-compile-cache$/m);
  const exec = /^ExecStart=(.*)$/m.exec(service)?.[1] ?? "";
  assert.match(exec, /--window-timer=a11ign-shadow-window\.timer\b/, "the runner is told which timer to disable");
  assert.match(exec, /--candidate=\S+\/repos\/agent-org\/src\/work-gate\.mjs\b/, "the candidate is the #2866 clone's gate");
  const scratch = [/--copy-dir=(\S+)/, /--record=(\S+)/].map((flag) => flag.exec(exec)?.[1] ?? "");
  for (const path of scratch) {
    assert.match(path, /\.local\/state\/a11ign-shadow-window\//, `${path} is in the scratch area the runner owns`);
    assert.doesNotMatch(path, /\.cache\/a11ign\//, `${path} is not inside the live state directory`);
  }
  const without = service.replace(/^MemoryMax=.*$/m, "");
  assert.doesNotMatch(without, /^MemoryMax=/m, "POSITIVE CONTROL: removing the line is noticed by the same reader");
});

// --- 2. the window ------------------------------------------------------------------------------------------------------------------

const DECIDE = "(args) => args.rows.map((r) => ({ causeKey: `row:${r}`, cause: 'ready-row', session: 's', subject: r, discriminator: 'd', prompt: 'p' }))";

type Rig = { root: string; live: string; copy: string; record: string; candidate: string; monorepo: string; stopped: string[] };

/** A live state directory, a candidate checkout and a monorepo whose gate closure matches it, and a stub `disableTimer` that records its calls. */
function rig(): Rig {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a11y-shadow-arm-")));
  const live = join(root, "live");
  mkdirSync(join(live, "shadow-reads"), { recursive: true });
  writeFileSync(join(live, "wake-ledger"), "line-1\n");
  const gate = `import { helper } from "./lib/helper.mjs";\nexport const decide = (args) => helper(${DECIDE})(args);\n`;
  for (const base of [join(root, "candidate"), join(root, "monorepo", "packages", "agent-org")]) {
    mkdirSync(join(base, "src", "lib"), { recursive: true });
    writeFileSync(join(base, "src", "work-gate.mjs"), gate);
    writeFileSync(join(base, "src", "lib", "helper.mjs"), "export const helper = (decide) => decide;\n");
    writeFileSync(join(base, "src", "unrelated.mjs"), "export const x = 1;\n");
  }
  return { root, live, copy: join(root, "copy"), record: join(root, "out", "diff.jsonl"), candidate: join(root, "candidate", "src", "work-gate.mjs"),
    monorepo: join(root, "monorepo"), stopped: [] };
}

function withRig(body: (r: Rig) => void) {
  const r = rig();
  try {
    body(r);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
}

const arm = (r: Rig, now = new Date(T0)) => armWindow({ liveDir: r.live, copyDir: r.copy, recordPath: r.record, candidate: r.candidate, monorepoRoot: r.monorepo, now,
  headOf: (root: string) => (root === r.monorepo ? "mono-sha" : "cand-sha") });

const writeTick = (live: string, tickMs: number) => writeFileSync(join(live, "shadow-reads", `${tickMs}.json`),
  JSON.stringify({ tick: tickMs, args: { rows: ["a"] }, orders: [{ causeKey: "row:a", cause: "ready-row", session: "s", subject: "a", discriminator: "d", prompt: "p" }] }));

/** A record of `count` ticks at the live cadence from T0, in the shape a run writes them. */
function writeRecord(record: string, count: number, bootId = "boot-a") {
  mkdirSync(join(record, ".."), { recursive: true });
  const rows = Array.from({ length: count }, (_, i) => ({ tick: T0 + i * TICK, tickMs: T0 + i * TICK, utc: new Date(T0 + i * TICK).toISOString(), differences: [], bootId }));
  writeFileSync(record, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}

const run = (r: Rig, now: Date, extra: { bootId?: string | null; disableTimer?: (unit: string) => void } = {}) => windowTick({
  liveDir: r.live, copyDir: r.copy, recordPath: r.record, candidate: r.candidate, timerUnit: TIMER, now, bootId: "boot-a",
  disableTimer: (unit: string) => void r.stopped.push(unit), ...extra });

test("--arm creates the marker whose content is T0, T-end (1,440 ticks later) and the hard stop (52 hours), naming the candidate and monorepo commits", () => {
  withRig((r) => {
    assert.equal(readWindowMarker(r.live), null, "no marker before arming: the window is not open");
    const armed = arm(r);
    assert.equal(armed.t0, "2026-10-02T12:00:00.000Z");
    assert.equal(armed.tEnd, new Date(T0 + WINDOW_TICKS * TICK).toISOString());
    assert.equal(armed.tEnd, "2026-10-04T12:00:00.000Z", "1,440 ticks at two minutes is 48 hours");
    assert.equal(armed.hardStop, new Date(T0 + HARD_STOP_MS).toISOString());
    assert.equal(armed.hardStop, "2026-10-04T16:00:00.000Z");
    assert.deepEqual([armed.candidate.commit, armed.monorepo.commit], ["cand-sha", "mono-sha"], "the pair the arming comment names");
    assert.deepEqual(readWindowMarker(r.live), { t0: armed.t0, tEnd: armed.tEnd, hardStop: armed.hardStop });
    assert.ok(existsSync(join(r.live, SHADOW_WINDOW_MARKER)));
    assert.equal(readdirSync(r.live).filter((name) => name.endsWith(".tmp")).length, 0, "no temp file is left in the live directory");
  });
});

test("the marker --arm writes is the one the live gate's tap reads as OPEN, and with no marker the tap records nothing", () => {
  withRig((r) => {
    const reads = join(r.root, "tap-live");
    mkdirSync(reads);
    assert.equal(tapShadowReads({ args: {}, orders: [], tick: T0, stateDir: reads, log: () => undefined }).recorded, false, "dormant before arming");
    arm({ ...r, live: reads, copy: join(r.root, "tap-copy"), record: join(r.root, "tap", "d.jsonl") });
    assert.equal(tapShadowReads({ args: {}, orders: [], tick: T0, stateDir: reads, log: () => undefined }).recorded, true, "the armed marker switches the tap on");
  });
});

test("--arm is refused when the candidate's closure differs, names the file, and stops complaining once it is restored (both directions)", () => {
  withRig((r) => {
    const helper = join(r.root, "candidate", "src", "lib", "helper.mjs");
    const original = readFileSync(helper, "utf8");
    writeFileSync(helper, "export const helper = (decide) => (args) => decide(args).slice(1);\n");
    assert.throws(() => arm(r), /does not correspond[^]*1 of 2 files[^]*lib\/helper\.mjs/);
    assert.equal(readWindowMarker(r.live), null, "a refused arming creates no marker");
    writeFileSync(helper, original);
    assert.doesNotThrow(() => arm(r), "restored, the same call arms");
  });
  withRig((r) => {
    writeFileSync(join(r.root, "candidate", "src", "unrelated.mjs"), "export const x = 2;\n");
    assert.doesNotThrow(() => arm(r), "a file OUTSIDE the gate's import closure may differ: the closure is what the freeze covers");
  });
  withRig((r) => {
    rmSync(join(r.monorepo, "packages", "agent-org", "src", "lib", "helper.mjs"));
    assert.throws(() => arm(r), /lib\/helper\.mjs/, "a candidate file this checkout lacks is named too");
  });
});

test("--arm happens once: an armed window and a record that already holds rows are both refused, naming what they hold", () => {
  withRig((r) => {
    arm(r);
    assert.throws(() => arm(r, new Date(T0 + MINUTE)), /already armed \(T0 2026-10-02T12:00:00\.000Z\)/);
    assert.equal(readWindowMarker(r.live)?.t0, "2026-10-02T12:00:00.000Z", "the second call changed nothing");
  });
  withRig((r) => {
    writeRecord(r.record, 3);
    assert.throws(() => arm(r), /already holds rows/);
    assert.equal(readWindowMarker(r.live), null);
  });
});

test("a marker with no T0 (a `touch`) REFUSES instead of opening a window nothing can stop", () => {
  withRig((r) => {
    writeFileSync(join(r.live, SHADOW_WINDOW_MARKER), "");
    assert.throws(() => readWindowMarker(r.live), /not JSON/);
    writeFileSync(join(r.live, SHADOW_WINDOW_MARKER), "{}");
    assert.throws(() => readWindowMarker(r.live), /carries no T0/);
  });
});

test("DORMANT: with no marker a windowed run writes nothing and disables nothing", () => {
  withRig((r) => {
    writeTick(r.live, T0);
    assert.equal(run(r, new Date(T0 + TICK)).status, "NOT-OPEN");
    assert.equal(existsSync(r.record), false, "no record is created");
    assert.equal(existsSync(r.copy), false, "no copy is made");
    assert.deepEqual(r.stopped, []);
  });
});

test("POSITIVE CONTROL: a record of exactly 1,440 ticks STOPS the window -- stop row, timer disabled, marker removed, and the waiting tick is NOT run", () => {
  withRig((r) => {
    arm(r);
    writeRecord(r.record, WINDOW_TICKS);
    writeTick(r.live, T0 + WINDOW_TICKS * TICK);
    const result = run(r, new Date(T0 + 40 * 60 * MINUTE));
    assert.deepEqual([result.status, result.cause, result.ticks], ["STOPPED", "count", WINDOW_TICKS]);
    assert.deepEqual(r.stopped, [TIMER], "the runner disabled its own timer, once");
    assert.equal(existsSync(join(r.live, SHADOW_WINDOW_MARKER)), false, "the marker is gone, so the live gate's tap is off");
    const rows = readRecordRows(r.record);
    assert.equal(ticksRecorded(rows), WINDOW_TICKS, "the pending tick was not recorded after the stop");
    assert.deepEqual(rows.filter((row: { kind?: string }) => row.kind !== undefined).map((row: { kind: string; cause: string }) => [row.kind, row.cause]), [["stop", "count"]]);
  });
});

test("a record of 1,439 ticks before T-end does NOT stop it; a quiet run leaves it open, and the 1,440th tick stops it in the same run", () => {
  withRig((r) => {
    arm(r);
    writeRecord(r.record, WINDOW_TICKS - 1);
    const before = new Date(T0 + 47 * 60 * MINUTE);
    assert.equal(run(r, before).status, "QUIET");
    assert.deepEqual(r.stopped, [], "not stopped");
    assert.ok(existsSync(join(r.live, SHADOW_WINDOW_MARKER)), "still open");
    writeTick(r.live, T0 + (WINDOW_TICKS - 1) * TICK);
    const last = run(r, before);
    assert.deepEqual([last.status, last.cause, last.ticks], ["STOPPED", "count", WINDOW_TICKS]);
    assert.ok(last.record, "the 1,440th tick was recorded before it stopped");
    assert.deepEqual(r.stopped, [TIMER]);
  });
});

test("the hard stop fires at T0 plus 52 hours with fewer ticks, and one millisecond before it does not", () => {
  withRig((r) => {
    arm(r);
    writeRecord(r.record, 100);
    assert.equal(run(r, new Date(T0 + HARD_STOP_MS - 1)).status, "QUIET", "BOUNDARY CONTROL: the instant before the hard stop");
    assert.deepEqual(r.stopped, []);
    const result = run(r, new Date(T0 + HARD_STOP_MS));
    assert.deepEqual([result.status, result.cause, result.ticks], ["STOPPED", "wall-clock", 100]);
    assert.deepEqual(r.stopped, [TIMER]);
    assert.equal(existsSync(join(r.live, SHADOW_WINDOW_MARKER)), false);
  });
});

test("a stop whose timer could not be disabled is retried, not forgotten: the stop row stays, the marker stays, and the next run finishes the job", () => {
  withRig((r) => {
    arm(r);
    writeRecord(r.record, 100);
    const failing = () => { throw new Error("systemctl: no bus"); };
    assert.throws(() => run(r, new Date(T0 + HARD_STOP_MS), { disableTimer: failing }), /no bus/);
    assert.ok(existsSync(join(r.live, SHADOW_WINDOW_MARKER)), "the marker is kept, so the next run can find the window");
    assert.equal(readRecordRows(r.record).filter((row: { kind?: string }) => row.kind === "stop").length, 1);
    const again = run(r, new Date(T0 + HARD_STOP_MS + TICK));
    assert.equal(again.status, "ENDED");
    assert.deepEqual(r.stopped, [TIMER]);
    assert.equal(existsSync(join(r.live, SHADOW_WINDOW_MARKER)), false);
    assert.equal(readRecordRows(r.record).filter((row: { kind?: string }) => row.kind === "stop").length, 1, "a second stop row is not written");
    assert.equal(run(r, new Date(T0 + HARD_STOP_MS + 2 * TICK)).status, "NOT-OPEN", "and the window is then dormant");
  });
});

// --- 3. a gap is a row -------------------------------------------------------------------------------------------------------------

const lastTwo = (record: string) => readRecordRows(record).slice(-2);

test("POSITIVE CONTROL: one gap records a gap row naming the time and the cause, and every tick is still counted", () => {
  withRig((r) => {
    arm(r);
    const now = new Date(T0 + 30 * MINUTE);
    writeTick(r.live, T0);
    writeTick(r.live, T0 + TICK);
    writeTick(r.live, T0 + 4 * TICK);
    writeTick(r.live, T0 + 5 * TICK);
    for (let i = 0; i < 4; i += 1) assert.equal(run(r, now).status, "RECORDED");
    const rows = readRecordRows(r.record);
    assert.equal(ticksRecorded(rows), 4, "all four ticks are counted: a gap does not drop the rest");
    const gaps = rows.filter((row: { kind?: string }) => row.kind === "gap");
    assert.equal(gaps.length, 1, "ONE gap row");
    assert.deepEqual(gaps[0], { kind: "gap", at: now.toISOString(), missing: 2, firstMissingUtc: new Date(T0 + 2 * TICK).toISOString(),
      lastMissingUtc: new Date(T0 + 3 * TICK).toISOString(), causes: ["no-tap-file"] });
    assert.deepEqual(rows.map((row: { kind?: string }) => row.kind ?? "tick"), ["tick", "tick", "gap", "tick", "tick"], "the gap row sits BEFORE the tick that revealed it");
    assert.equal(run(r, now).status, "QUIET", "and a recorded gap is not re-recorded");
  });
});

test("POSITIVE CONTROL: a tap file from BEFORE T0 is not a tick of the window: it is skipped, counts for nothing, and makes no gap (the 2026-10-01 arming)", () => {
  withRig((r) => {
    const stale = T0 - 6 * 60 * MINUTE;
    writeTick(r.live, stale);
    arm(r);
    assert.equal(run(r, new Date(T0 + MINUTE)).status, "QUIET", "a live directory holding only a pre-T0 file has nothing to record");
    assert.equal(readRecordRows(r.record).length, 0, "and wrote no row");
    writeTick(r.live, T0 + TICK);
    assert.equal(run(r, new Date(T0 + 3 * MINUTE)).status, "RECORDED");
    const rows = readRecordRows(r.record);
    assert.deepEqual(rows.map((row: { tickMs?: number; kind?: string }) => row.tickMs ?? row.kind), [T0 + TICK], "the post-T0 tick is the FIRST row, and there is no gap row ahead of it");
    assert.equal(ticksRecorded(rows), 1);
  });
});

test("a record the first armed run already wrote with a pre-T0 tick and its false gap row is read from T0: neither counts, and the next tick adds no new gap", () => {
  withRig((r) => {
    arm(r);
    const stale = T0 - 6 * 60 * MINUTE;
    const row = (tickMs: number) => ({ tick: tickMs, tickMs, utc: new Date(tickMs).toISOString(), differences: [], bootId: "boot-a" });
    const gap = { kind: "gap", at: new Date(T0 + MINUTE).toISOString(), missing: 194, firstMissingUtc: new Date(stale + TICK).toISOString(),
      lastMissingUtc: new Date(T0 - TICK).toISOString(), causes: ["no-tap-file"] };
    mkdirSync(join(r.record, ".."), { recursive: true });
    writeFileSync(r.record, [row(stale), gap, row(T0 + TICK)].map((line) => `${JSON.stringify(line)}\n`).join(""));
    assert.equal(ticksRecorded(readRecordRows(r.record)), 2, "the unqualified count still reads the stale row, as the stored record does");
    assert.equal(ticksRecorded(readRecordRows(r.record), T0), 1, "from T0 it is ONE tick");
    writeTick(r.live, stale);
    writeTick(r.live, T0 + 2 * TICK);
    assert.equal(run(r, new Date(T0 + 5 * MINUTE)).status, "RECORDED");
    const rows = readRecordRows(r.record);
    assert.equal(rows.filter((line: { kind?: string }) => line.kind === "gap").length, 1, "still only the one gap row already there");
    assert.equal(ticksRecorded(rows, T0), 2);
  });
});

test("a record holding ONLY a pre-T0 tick starts the window at the next real tick: no gap row is written for the hours before T0", () => {
  withRig((r) => {
    arm(r);
    const stale = T0 - 6 * 60 * MINUTE;
    mkdirSync(join(r.record, ".."), { recursive: true });
    writeFileSync(r.record, `${JSON.stringify({ tick: stale, tickMs: stale, utc: new Date(stale).toISOString(), differences: [], bootId: "boot-a" })}\n`);
    writeTick(r.live, T0 + TICK);
    assert.equal(run(r, new Date(T0 + 3 * MINUTE)).status, "RECORDED");
    assert.deepEqual(readRecordRows(r.record).map((row: { kind?: string }) => row.kind ?? "tick"), ["tick", "tick"], "no gap row between them");
    assert.equal(ticksRecorded(readRecordRows(r.record), T0), 1);
  });
});

test("a gap across a host restart names it, and a gap across a refused run names that, and both together name both", () => {
  withRig((r) => {
    arm(r);
    writeTick(r.live, T0);
    run(r, new Date(T0 + TICK), { bootId: "boot-a" });
    writeTick(r.live, T0 + 3 * TICK);
    run(r, new Date(T0 + 8 * MINUTE), { bootId: "boot-b" });
    assert.deepEqual(lastTwo(r.record)[0].causes, ["host-restarted"]);
  });
  withRig((r) => {
    arm(r);
    writeTick(r.live, T0);
    run(r, new Date(T0 + TICK));
    rmSync(r.copy, { recursive: true });
    mkdirSync(r.copy, { recursive: true });
    writeFileSync(join(r.copy, "someone-elses-file"), "x");
    writeTick(r.live, T0 + 2 * TICK);
    assert.throws(() => run(r, new Date(T0 + 3 * TICK)), /not empty and was not made by this runner/);
    const refused = readRecordRows(r.record).filter((row: { kind?: string }) => row.kind === "refused");
    assert.equal(refused.length, 1, "a refused run is a row");
    assert.equal(refused[0].at, new Date(T0 + 3 * TICK).toISOString(), "naming the time");
    assert.match(refused[0].cause, /not empty and was not made by this runner/, "and the cause");
    rmSync(r.copy, { recursive: true });
    writeTick(r.live, T0 + 5 * TICK);
    run(r, new Date(T0 + 8 * MINUTE), { bootId: "boot-b" });
    run(r, new Date(T0 + 9 * MINUTE), { bootId: "boot-b" });
    const gap = readRecordRows(r.record).find((row: { kind?: string }) => row.kind === "gap");
    assert.deepEqual(gap?.causes, ["runner-refused", "host-restarted"]);
  });
});

test("a refusal because the RECORD is inside the live directory writes no row there: the live directory is never a place to write one", () => {
  withRig((r) => {
    arm(r);
    const inside = join(r.live, "diff.jsonl");
    const before = readdirSync(r.live).sort();
    assert.throws(() => windowTick({ liveDir: r.live, copyDir: r.copy, recordPath: inside, candidate: r.candidate, timerUnit: TIMER, now: new Date(T0), bootId: "b",
      disableTimer: () => undefined }), /inside the live state directory/);
    assert.deepEqual(readdirSync(r.live).sort(), before);
  });
});

test("an ordinary windowed tick leaves the live directory's bytes alone, apart from the tap's own files it reads", () => {
  withRig((r) => {
    arm(r);
    writeTick(r.live, T0);
    const bytes = (dir: string): Record<string, string> => Object.fromEntries(readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? Object.entries(bytes(path)).map(([k, v]) => [`${name}/${k}`, v]) : [[name, readFileSync(path, "utf8")]];
    }));
    const before = bytes(r.live);
    assert.ok(Object.keys(before).length >= 3, "POSITIVE CONTROL: the live directory holds the marker, a ledger and a tap file");
    assert.equal(run(r, new Date(T0 + TICK)).status, "RECORDED");
    assert.deepEqual(bytes(r.live), before);
  });
});

// --- 4. the command line ------------------------------------------------------------------------------------------------------------

function cli(r: Rig, ...flags: string[]) {
  return spawnSync(process.execPath, [RUNNER, `--live-dir=${r.live}`, `--copy-dir=${r.copy}`, `--record=${r.record}`, `--candidate=${r.candidate}`, ...flags],
    { encoding: "utf8", env: { ...process.env, AGENT_ORG_HOST: "" } });
}

test("the command line: a windowed run with no marker says NOT-OPEN and exits 0, and a refused one exits 2 and leaves a refused row", () => {
  withRig((r) => {
    const dormant = cli(r, `--window-timer=${TIMER}`);
    assert.equal(dormant.status, 0, dormant.stderr);
    assert.match(dormant.stdout, /^NOT-OPEN/);
    arm(r, new Date());
    mkdirSync(r.copy, { recursive: true });
    writeFileSync(join(r.copy, "someone-elses-file"), "x");
    writeTick(r.live, Date.now());
    const refused = cli(r, `--window-timer=${TIMER}`);
    assert.equal(refused.status, 2, "a refused windowed run fails the SHADOW unit");
    assert.match(refused.stderr, /not empty and was not made by this runner/);
    assert.equal(readRecordRows(r.record).filter((row: { kind?: string }) => row.kind === "refused").length, 1);
  });
});

test("the command line: --arm over the REAL gate's closure prints T0, T-end, the hard stop, the commit pair and the stop command; a changed closure file refuses it", () => {
  withRig((r) => {
    const tool = join(r.root, "tool");
    mkdirSync(tool);
    cpSync(join(REPO_SRC), join(tool, "src"), { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", tool, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { env: sandboxGitEnv(), encoding: "utf8" });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "snapshot");
    const gate = join(tool, "src", "work-gate.mjs");
    const armCli = () => spawnSync(process.execPath, [RUNNER, "--arm", `--live-dir=${r.live}`, `--copy-dir=${r.copy}`, `--record=${r.record}`, `--candidate=${gate}`, `--window-timer=${TIMER}`],
      { encoding: "utf8" });
    const shared = join(tool, "src", "host-config.mjs");
    const original = readFileSync(shared, "utf8");
    writeFileSync(shared, `${original}\n// drifted\n`);
    const refused = armCli();
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /does not correspond[^]*host-config\.mjs/, "the file that differs is named");
    assert.equal(readWindowMarker(r.live), null);
    writeFileSync(shared, original);
    const armed = armCli();
    assert.equal(armed.status, 0, armed.stderr);
    const marker = readWindowMarker(r.live);
    assert.ok(marker, "the marker exists");
    assert.match(armed.stdout, new RegExp(`T0:\\s+${marker.t0}`));
    assert.match(armed.stdout, new RegExp(`T-end:\\s+${marker.tEnd}`));
    assert.match(armed.stdout, /Candidate: [0-9a-f]{40} /);
    assert.match(armed.stdout, /Monorepo: {2}[0-9a-f]{40} /);
    assert.match(armed.stdout, new RegExp(`Stop:\\s+systemctl --user disable --now ${TIMER}`));
    assert.equal(cli(r, "--arm").status, 2, "armed once");
  });
});

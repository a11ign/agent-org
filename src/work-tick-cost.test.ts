// no-token: gh
//
// Nothing here reaches the network or a real `gh`. The tick under test runs from a temporary `src/` whose `work-gate.mjs` and `wake.mjs` are stubs,
// with the PATH pointed at an empty directory. ERASABLE TYPESCRIPT ONLY (no enum, namespace or parameter property): node strips the types itself.

/**
 * a11ign/a11ign#3566: every tick appends ONE `tick-cost` line, so that "the tick takes 2 to 10 minutes" is a reading from a file and not from a
 * journal, and says where the minutes went: per phase, wall AND CPU (children included), and per command the tick started.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT, TICK_COST_BYTES, TICK_COST_FILE, appendTickCost, childrenCpuMs, createMeter, tickCostPath } from "./work-tick.mjs";
import { CENSUS_ENV, describeSpawn, summariseCensus } from "./lib/spawn-census.mjs";
import { LIVE_TRANSCRIPT_HORIZON_MS, liveClaudeTurns } from "./work-gate/row-call-count-orders.mjs";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const PRELOAD = join(SRC, "lib", "crash-exit.mjs");

type Tick = { gate: string; wake?: string; costIsADirectory?: boolean; ticks?: number };

/** The same checkout-of-one-file's-worth as `packaging/work-tick-completion-record.test.ts`, returning the cost lines the tick left beside its ledger. */
function runTick({ gate, wake = "process.exit(0);", costIsADirectory = false, ticks = 1 }: Tick) {
  const dir = mkdtempSync(join(tmpdir(), "tick-cost-"));
  try {
    const src = join(dir, "src");
    mkdirSync(src);
    const own = new Set(["work-tick.mjs", "work-gate.mjs", "wake.mjs"]);
    for (const name of readdirSync(SRC).filter((entry) => !own.has(entry))) symlinkSync(join(SRC, name), join(src, name));
    writeFileSync(join(src, "work-tick.mjs"), readFileSync(join(SRC, "work-tick.mjs"), "utf8"));
    writeFileSync(join(src, "work-gate.mjs"), gate);
    writeFileSync(join(src, "wake.mjs"),
      `export * from ${JSON.stringify(join(SRC, "wake.mjs"))};\n`
      + `import { fileURLToPath } from "node:url";\n`
      + `if (process.argv[1] === fileURLToPath(import.meta.url)) {\n  ${wake}\n}\n`);
    mkdirSync(join(dir, "empty"));
    const ledger = join(dir, "ledger.jsonl");
    const cost = tickCostPath(ledger);
    if (costIsADirectory) mkdirSync(cost);
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: join(dir, "empty") };
    delete env.INVOCATION_ID; // a test run under systemd would otherwise ask systemd about ITS unit
    const run = () => spawnSync(process.execPath, [`--import=${PRELOAD}`, join(src, "work-tick.mjs"), `--ledger=${ledger}`], { encoding: "utf8", cwd: dir, env });
    let ran = run();
    for (let tick = 1; tick < ticks; tick += 1) ran = run();
    const lines = !costIsADirectory && existsSync(cost) ? readFileSync(cost, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    return { ran, lines };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A clock and a CPU meter that read from a script, so a "tick" of two phases has numbers a test can state. */
function scripted(readings: { wall: number[]; cpu: number[] }) {
  const wall = [...readings.wall];
  const cpu = [...readings.cpu];
  return { clock: () => wall.shift() as number, cpu: () => ({ selfMs: cpu.shift() as number, childrenMs: 0 }) };
}

test("#3566: a fake tick of TWO phases leaves each one's wall and CPU, and the total", () => {
  const meter = createMeter({
    ...scripted({ wall: [0, 100, 100, 1600], cpu: [10, 10, 10, 10, 60, 90] }),
    uptimeMs: () => 1700, maxRssKb: () => 2_700_000,
  });
  meter.phase("gate", () => "ignored");
  assert.equal(meter.phase("wake", () => 7), 7, "a phase returns what its step returned");
  const reading = meter.reading();
  assert.deepEqual(reading.phases.gate, { wallMs: 100, cpuMs: 0 });
  assert.deepEqual(reading.phases.wake, { wallMs: 1500, cpuMs: 50 });
  assert.equal(reading.wallMs, 1700);
  assert.equal(reading.maxRssKb, 2_700_000);
});

test("#3566 CONTROL: a tick that does NOTHING still writes the line, with ZERO wakes and no commands it did not start", () => {
  const { ran, lines } = runTick({ gate: "process.exit(0);" });
  assert.equal(ran.status, EXIT.QUIET, ran.stderr);
  assert.equal(lines.length, 1, "one line per tick");
  const [line] = lines;
  assert.equal(line.exit, EXIT.QUIET);
  assert.equal(line.wakes, 0);
  assert.ok(line.wallMs > 0 && line.cpuMs.self > 0, JSON.stringify(line));
  assert.deepEqual(Object.keys(line.phases).filter((name) => ["startup", "gate", "roster"].includes(name)).sort(), ["gate", "roster", "startup"]);
  assert.equal(line.phases.wake, undefined, "a quiet tick never runs wake, so it has no wake phase");
  assert.equal(line.spawns.node.n, 1, "the gate is the one process this tick started");
});

test("#3566: a second tick APPENDS a second line rather than replacing the first", () => {
  const { lines } = runTick({ gate: "process.exit(0);", ticks: 2 });
  assert.equal(lines.length, 2);
  assert.notEqual(lines[0].at, lines[1].at, "two ticks, two readings");
});

test("#3566: wakes are counted from what wake reports, and wake is a phase", () => {
  const { ran, lines } = runTick({ gate: "process.exit(1);", wake: 'process.stdout.write("WOKE a\\nWOKE b\\n");' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(lines[0].wakes, 2);
  assert.ok(lines[0].phases.wake.wallMs >= 0);
});

test("#3566: a command the GATE starts is counted by command, with its wall -- the tick's own CPU alone under-reads it", () => {
  const gate = `import { execFileSync } from "node:child_process";\n`
    + `for (let i = 0; i < 2; i += 1) execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 150)"]);\n`
    + `process.exit(0);\n`;
  const { lines } = runTick({ gate });
  const [line] = lines;
  assert.equal(line.spawns.node.n, 3, "the gate (started by the tick) plus the two it started");
  assert.ok(line.spawns.node.wallMs >= 300, `two 150 ms children are at least 300 ms of wall: ${JSON.stringify(line.spawns)}`);
  assert.ok(line.slowest.length >= 1 && line.slowest.length <= 5);
  assert.ok(line.slowest[0].ms >= line.slowest[line.slowest.length - 1].ms, "slowest first");
});

test("#3566: a cost line that cannot be WRITTEN is said on stderr and does not change the tick's exit", () => {
  const { ran } = runTick({ gate: "process.exit(0);", costIsADirectory: true });
  assert.equal(ran.status, EXIT.QUIET, "the tick did its work");
  assert.match(ran.stderr, /TICK COST NOT RECORDED at .*tick-cost\.jsonl/);
});

test("#3566: the cost file sits beside the ledger and is trimmed to its last lines past the cap, never emptied", () => {
  assert.equal(tickCostPath("/state/agent-org/wake-ledger"), `/state/agent-org/${TICK_COST_FILE}`);
  const dir = mkdtempSync(join(tmpdir(), "tick-cost-trim-"));
  try {
    const path = join(dir, TICK_COST_FILE);
    const line = JSON.stringify({ pad: "x".repeat(1000) });
    const count = Math.ceil(TICK_COST_BYTES / line.length) + 50;
    for (let index = 0; index < count; index += 1) appendTickCost(path, { pad: "x".repeat(1000), index });
    const kept = readFileSync(path, "utf8").split("\n").filter(Boolean).map((text) => JSON.parse(text));
    assert.ok(kept.length > 0 && kept.length < count, `${kept.length} of ${count}`);
    assert.equal(kept[kept.length - 1].index, count - 1, "the newest line survives the trim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#3566: children's CPU is read from /proc/self/stat past a command name with spaces and brackets, and a REAL child moves it", () => {
  const fields = Array.from({ length: 52 }, (_, index) => String(index + 1));
  fields[13] = "0"; fields[14] = "0"; fields[15] = "150"; fields[16] = "50"; // utime stime cutime cstime, in clock ticks (100 a second)
  const stat = `4242 (a (b) c) ${fields.slice(2).join(" ")}\n`;
  assert.equal(childrenCpuMs(() => stat), 2000);
  const before = childrenCpuMs();
  spawnSync(process.execPath, ["-e", "const end = Date.now() + 300; while (Date.now() < end);"]);
  assert.ok(childrenCpuMs() - before >= 150, `a 300 ms busy child moved children CPU by ${childrenCpuMs() - before} ms`);
});

test("#3566: the census names a command by its basename, cuts an argument to its tail, and keeps the slowest 5 by wall", () => {
  assert.deepEqual(describeSpawn("/home/agent/.local/bin/gh", ["pr", "list"]), { cmd: "gh", line: "gh pr list" });
  assert.equal(describeSpawn("git status --short", undefined).line, "git status --short", "an execSync string is split, not taken as one name");
  const long = describeSpawn("node", [`/very/long/${"d/".repeat(40)}work-gate.mjs`]);
  assert.match(long.line, /work-gate\.mjs$/);
  const records = [
    { cmd: "gh", line: "gh a", ms: 5 }, { cmd: "gh", line: "gh b", ms: 900 }, { cmd: "git", line: "git c", ms: 70 },
    { cmd: "herdr", line: "herdr d", ms: 300 }, { cmd: "gh", line: "gh e", ms: 20 }, { cmd: "gh", line: "gh f", ms: 600 }, { cmd: "gh", line: "gh async", ms: null },
  ];
  const { commands, slowest } = summariseCensus(records);
  assert.deepEqual(commands.gh, { n: 5, wallMs: 1525 }, "an asynchronous spawn counts and adds no wall");
  assert.deepEqual(slowest.map((entry) => entry.line), ["gh b", "gh f", "herdr d", "git c", "gh e"]);
});

test("#3566: the tick still has ONE exit, so no path out of main() skips the cost line", () => {
  const source = readFileSync(join(SRC, "work-tick.mjs"), "utf8");
  assert.equal((source.match(/process\.exit\(/g) ?? []).length, 1);
});

test("#3566: the census preload keeps `promisify(execFile)` and `promisify(exec)` resolving `{ stdout, stderr }`, and counts each spawn ONCE", () => {
  const dir = mkdtempSync(join(tmpdir(), "census-promisify-"));
  try {
    const census = join(dir, "census.jsonl");
    const script = [
      'const { promisify } = require("node:util"); const cp = require("node:child_process");',
      'Promise.all([promisify(cp.execFile)("echo", ["file"]), promisify(cp.exec)("echo shell")])',
      '  .then(([a, b]) => console.log(JSON.stringify([a, b]))).catch((e) => { console.error(e); process.exit(1); });',
    ].join("\n");
    const run = spawnSync(process.execPath, ["--import", join(SRC, "lib", "spawn-census.mjs"), "-e", script], {
      encoding: "utf8", env: { ...process.env, [CENSUS_ENV]: census },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), [{ stdout: "file\n", stderr: "" }, { stdout: "shell\n", stderr: "" }]);
    const lines = readFileSync(census, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(lines.filter((l) => l.cmd === "echo").length, 2, "each promisified spawn is counted once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** One transcript under `root` whose newest write was `ageMs` ago, holding one billed turn for `session`. */
function transcript(root: string, name: string, { session, ageMs, now }: { session: string; ageMs: number; now: number }) {
  const file = join(root, `${name}.jsonl`);
  const line = (record: object) => `${JSON.stringify(record)}\n`;
  writeFileSync(file, line({ type: "user", message: { content: `You are \`${session}\`.` } })
    + line({ timestamp: new Date(now - ageMs).toISOString(), message: { id: `m-${name}`, usage: { input_tokens: 1, output_tokens: 1 } } }));
  utimesSync(file, new Date(now - ageMs), new Date(now - ageMs));
}

test("#3566: liveClaudeTurns does not read a transcript no write has touched within the horizon, and reads one that has", () => {
  const root = mkdtempSync(join(tmpdir(), "live-turns-"));
  try {
    const now = Date.now();
    mkdirSync(join(root, "project"));
    transcript(join(root, "project"), "recent", { session: "worker-1", ageMs: LIVE_TRANSCRIPT_HORIZON_MS / 2, now });
    transcript(join(root, "project"), "stale", { session: "worker-2", ageMs: LIVE_TRANSCRIPT_HORIZON_MS * 2, now });
    assert.deepEqual(liveClaudeTurns(root, { now }).map((turn) => turn.session), ["worker-1"], "the control: the recent one IS read, so the empty side is not an empty root");
    assert.deepEqual(liveClaudeTurns(root, { now, horizonMs: LIVE_TRANSCRIPT_HORIZON_MS * 3 }).map((turn) => turn.session).sort(), ["worker-1", "worker-2"], "a wider horizon reads both");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

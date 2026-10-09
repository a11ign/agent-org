// no-token: gh
//
// Nothing here reaches the network or a real `gh`. The tick under test runs from a temporary `src/` whose `work-gate.ts` and `wake.ts` are stubs,
// with the PATH pointed at an empty directory. ERASABLE TYPESCRIPT ONLY (no enum, namespace or parameter property): node strips the types itself.

/**
 * a11ign/a11ign#3566: every tick appends ONE `tick-cost` line, so that "the tick takes 2 to 10 minutes" is a reading from a file and not from a
 * journal, and says where the minutes went: per phase, wall AND CPU (children included), and per command the tick started.
 */
import { TSX_IMPORT } from "./tsx-import.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT, TICK_COST_BYTES, TICK_COST_FILE, appendTickCost, childrenCpuMs, createMeter, tickCostPath } from "./work-tick.ts";
import { CENSUS_ENV, currentCensusPhase, describeSpawn, summariseCensus } from "./lib/spawn-census.mjs";
import { sandboxGitEnv } from "./lib/git-env.mjs";
import { readElsewherePrs } from "./work-gate.ts";
import { claimRow } from "./row-claim.ts";
import { instanceCacheRead } from "./wake.ts";
import { LIVE_TRANSCRIPT_HORIZON_MS, liveClaudeTurns } from "./work-gate/row-call-count-orders.mjs";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const PRELOAD = join(SRC, "lib", "crash-exit.mjs");

/**
 * A `node -e` script that runs until the CHILD has used `ms` of its own CPU. Looping on `Date.now()` times the wall clock, and a child descheduled on a
 * loaded runner gets less CPU than wall: a 400 ms wall loop read 260 ms of CPU (run 37800171274). `process.cpuUsage()` is in microseconds.
 */
const burnCpu = (ms: number): string =>
  `const budget = ${ms * 1000}; while (process.cpuUsage().user + process.cpuUsage().system < budget);`;

type Tick = { gate: string; wake?: string; costIsADirectory?: boolean; ticks?: number };

/** The same checkout-of-one-file's-worth as `packaging/work-tick-completion-record.test.ts`, returning the cost lines the tick left beside its ledger. */
function runTick({ gate, wake = "process.exit(0);", costIsADirectory = false, ticks = 1 }: Tick) {
  const dir = mkdtempSync(join(tmpdir(), "tick-cost-"));
  try {
    const src = join(dir, "src");
    mkdirSync(src);
    writeFileSync(join(src, "package.json"), '{"type":"module"}'); // tsx reads a loose .ts as CommonJS without it, and a .mjs it reaches then fails on its top-level await
    const own = new Set(["work-tick.ts", "work-gate.ts", "wake.ts"]);
    for (const name of readdirSync(SRC).filter((entry) => !own.has(entry))) symlinkSync(join(SRC, name), join(src, name));
    writeFileSync(join(src, "work-tick.ts"), readFileSync(join(SRC, "work-tick.ts"), "utf8"));
    writeFileSync(join(src, "work-gate.ts"), gate);
    writeFileSync(join(src, "wake.ts"),
      `export * from ${JSON.stringify(join(SRC, "wake.ts"))};\n`
      + `import { fileURLToPath } from "node:url";\n`
      + `if (process.argv[1] === fileURLToPath(import.meta.url)) {\n  ${wake}\n}\n`);
    mkdirSync(join(dir, "empty"));
    const ledger = join(dir, "ledger.jsonl");
    const cost = tickCostPath(ledger);
    if (costIsADirectory) mkdirSync(cost);
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: join(dir, "empty") };
    delete env.INVOCATION_ID; // a test run under systemd would otherwise ask systemd about ITS unit
    delete env.GH_CONFIG_DIR; // (#4148) the tick's snapshot refresh probes GitHub and writes under the account's config: with none, it says SNAPSHOT OFF and starts nothing, which is what these tests count
    const run = () => spawnSync(process.execPath, [...TSX_IMPORT, `--import=${PRELOAD}`, join(src, "work-tick.ts"), `--ledger=${ledger}`], { encoding: "utf8", cwd: dir, env });
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
  const named = (command: string) => Object.entries(line.subcommands).filter(([key]) => key.startsWith(`${command} `)).reduce((sum, [, entry]) => sum + (entry as { n: number }).n, 0);
  for (const command of ["gh", "git", "herdr"]) {
    assert.equal(named(command), line.spawns[command]?.n ?? 0, `every ${command} the tick started is named by a subcommand, none twice or lost: ${JSON.stringify(line.subcommands)}`);
  }
  assert.equal(Object.keys(line.subcommands).some((key) => key.startsWith("node ")), false, "a node is not named by a subcommand");
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
  assert.ok(line.hottest.length >= 1 && line.hottest.length <= 5 && line.hottest[0].cpuMs >= line.hottest[line.hottest.length - 1].cpuMs, "hottest first");
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
  spawnSync(process.execPath, ["-e", burnCpu(300)]);
  assert.ok(childrenCpuMs() - before >= 150, `a 300 ms busy child moved children CPU by ${childrenCpuMs() - before} ms`);
});

test("#3566: the census names a command by its basename, cuts an argument to its tail, and keeps the slowest 5 by wall", () => {
  assert.deepEqual(describeSpawn("/home/agent/.local/bin/gh", ["pr", "list"]), { cmd: "gh", line: "gh pr list", sub: "pr list" });
  assert.equal(describeSpawn("git status --short", undefined).line, "git status --short", "an execSync string is split, not taken as one name");
  const long = describeSpawn("node", [...TSX_IMPORT, `/very/long/${"d/".repeat(40)}work-gate.ts`]);
  assert.match(long.line, /work-gate\.ts$/);
  const records = [
    { cmd: "gh", line: "gh a", ms: 5 }, { cmd: "gh", line: "gh b", ms: 900 }, { cmd: "git", line: "git c", ms: 70 },
    { cmd: "herdr", line: "herdr d", ms: 300 }, { cmd: "gh", line: "gh e", ms: 20 }, { cmd: "gh", line: "gh f", ms: 600 }, { cmd: "gh", line: "gh async", ms: null },
  ];
  const { commands, slowest } = summariseCensus(records);
  assert.deepEqual(commands.gh, { n: 5, wallMs: 1525 }, "an asynchronous spawn counts and adds no wall");
  assert.deepEqual(slowest.map((entry) => entry.line), ["gh b", "gh f", "herdr d", "git c", "gh e"]);
});

test("#3566: the census records each synchronous spawn's CPU, so a busy child and a sleeping one are told apart, and `hottest` ranks by CPU", () => {
  const dir = mkdtempSync(join(tmpdir(), "census-cpu-"));
  try {
    const census = join(dir, "census.jsonl");
    const driver = join(dir, "driver.mjs");
    writeFileSync(driver, [
      `import { spawnSync } from "node:child_process";`,
      // Burn 400 ms of CPU, not of wall: a descheduled child on a loaded runner gets less CPU than wall (260 of 400, run 37800171274).
      `spawnSync(process.execPath, ["-e", ${JSON.stringify(burnCpu(400))}]);`,
      `spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 400);"]);`,
    ].join("\n"));
    const ran = spawnSync(process.execPath, [...TSX_IMPORT, `--import=${new URL("./lib/spawn-census.mjs", import.meta.url).href}`, driver],
      { env: { ...process.env, [CENSUS_ENV]: census }, encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    const records = readFileSync(census, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const [busy, asleep] = records.filter((record: { cmd: string }) => record.cmd === "node");
    assert.ok(busy.cpuMs >= 300, `a 400 ms busy child read ${busy.cpuMs} ms of CPU`);
    assert.ok(asleep.ms >= 350 && asleep.cpuMs < asleep.ms / 2, `the control: a sleeping child waited ${asleep.ms} ms and used ${asleep.cpuMs} ms of CPU`);
    assert.deepEqual(summariseCensus(records).hottest.map((entry) => entry.cpuMs), [busy.cpuMs, asleep.cpuMs].sort((a, b) => b - a));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#3566: `hottest` keeps 5 by CPU and leaves out a spawn with no CPU reading (asynchronous, or `/proc` unreadable), which is not zero CPU", () => {
  const records = [
    { cmd: "gh", line: "gh a", ms: 900, cpuMs: 10 }, { cmd: "node", line: "node b", ms: 400, cpuMs: 800 }, { cmd: "git", line: "git c", ms: 70, cpuMs: 60 },
    { cmd: "herdr", line: "herdr d", ms: 300, cpuMs: 300 }, { cmd: "gh", line: "gh e", ms: 20, cpuMs: 20 }, { cmd: "gh", line: "gh f", ms: 600, cpuMs: 5 },
    { cmd: "gh", line: "gh unread", ms: 50, cpuMs: null }, { cmd: "gh", line: "gh async", ms: null },
  ];
  assert.deepEqual(summariseCensus(records).hottest.map((entry) => entry.line), ["node b", "herdr d", "git c", "gh e", "gh a"]);
});

test("#3566: a `gh` aimed by GH_REPO carries its repository, a `gh` with no aim and a non-`gh` carry none, and the summary counts reads per repository", () => {
  const aimed = describeSpawn("gh", ["pr", "list"], { env: { GH_REPO: "a11ign/agent-org" } });
  assert.equal(aimed.repo, "a11ign/agent-org");
  assert.equal("repo" in describeSpawn("gh", ["pr", "list"], { encoding: "utf8" }), false, "the control: no GH_REPO, no repo field");
  assert.equal("repo" in describeSpawn("herdr", ["agent", "list"], { env: { GH_REPO: "a11ign/agent-org" } }), false, "only `gh` is aimed by GH_REPO");
  const { ghRepos, commands } = summariseCensus([
    { ...aimed, ms: 400 }, { ...aimed, ms: 600 }, { cmd: "gh", line: "gh pr list", ms: 50 },
    { ...describeSpawn("gh", ["issue", "list"], { env: { GH_REPO: "a11ign/a11ign" } }), ms: 100 },
  ]);
  assert.deepEqual(ghRepos, { "a11ign/agent-org": { n: 2, wallMs: 1000 }, "a11ign/a11ign": { n: 1, wallMs: 100 } });
  assert.deepEqual(commands.gh, { n: 4, wallMs: 1150 }, "an unaimed gh still counts under its command");
});

test("#3566: a gh, git or herdr call is named by its SUBCOMMAND, with the numbers and flags that would make every call its own key left out", () => {
  const sub = (file: string, argv: string[]) => describeSpawn(file, argv).sub;
  assert.equal(sub("gh", ["issue", "list", "--state", "open", "--limit", "500"]), "issue list");
  assert.equal(sub("gh", ["issue", "view", "3680", "--json", "labels"]), "issue view", "an issue number is not part of the name");
  assert.equal(sub("gh", ["api", "repos/a11ign/a11ign/issues/3578/timeline", "--paginate"]), "api repos/a11ign/a11ign/issues/#/timeline", "a path keeps its shape and loses its numbers");
  assert.equal(sub("gh", ["-R", "a11ign/agent-org", "pr", "list"]), "pr list", "the value of a flag that takes one is not a subcommand");
  assert.equal(sub("git", ["-C", "/home/agent/repos/x", "-c", "core.quotepath=off", "rev-parse", "HEAD"]), "rev-parse", "git's -C and -c take a value");
  assert.equal(sub("herdr", ["agent", "list", "--json"]), "agent list");
  assert.equal(describeSpawn("git rev-list --count HEAD", undefined).sub, "rev-list", "an execSync string is split like an argv");
  assert.equal("sub" in describeSpawn("node", [...TSX_IMPORT, "work-gate.ts"]), false, "the control: a node is named by its script in `slowest`, and has no subcommand");
  assert.equal("sub" in describeSpawn("gh", ["--version"]), false, "a call with only flags names no subcommand, rather than an empty one");
});

test("#3566: the summary counts and times each subcommand, keeps the 10 slowest, and folds the rest into `other` so the total still adds up", () => {
  const records = [
    { cmd: "gh", sub: "pr list", line: "", ms: 900 }, { cmd: "gh", sub: "pr list", line: "", ms: 700 }, { cmd: "gh", sub: "issue list", line: "", ms: 1700 },
    { cmd: "git", sub: "rev-parse", line: "", ms: 20 }, { cmd: "gh", sub: "issue view", line: "", ms: null }, { cmd: "node", line: "", ms: 5000 },
  ];
  const { subcommands } = summariseCensus(records);
  assert.deepEqual(subcommands, {
    "gh issue list": { n: 1, wallMs: 1700 }, "gh pr list": { n: 2, wallMs: 1600 }, "git rev-parse": { n: 1, wallMs: 20 }, "gh issue view": { n: 1, wallMs: 0 },
  }, "an asynchronous call counts and adds no wall, a node has no subcommand, and the slowest comes first");
  assert.deepEqual(Object.keys(subcommands), ["gh issue list", "gh pr list", "git rev-parse", "gh issue view"]);

  const many = Array.from({ length: 13 }, (_, i) => ({ cmd: "gh", sub: `api route-${i}`, line: "", ms: 100 * (i + 1) }));
  const folded = summariseCensus(many).subcommands;
  assert.equal(Object.keys(folded).length, 11, "10 kept and one `other`");
  assert.deepEqual(folded.other, { n: 3, wallMs: 100 + 200 + 300 }, "the three cheapest are the ones folded");
  assert.equal(Object.values(folded).reduce((sum, e) => sum + e.n, 0), 13, "no call is lost by folding");
});

test("#3566 slice 7: the summary splits the calls by the PHASE that started them, names a command with no subcommand by itself, and leaves an unattributed call out", () => {
  const records = [
    { cmd: "gh", sub: "issue list", line: "", ms: 900, phase: "tearDownSpares" }, { cmd: "gh", sub: "issue list", line: "", ms: 300, phase: "tearDownSpares" },
    { cmd: "systemctl", line: "", ms: 8, phase: "tearDownSpares" }, { cmd: "herdr", sub: "org agent", line: "", ms: 40, phase: "tearDownReviewers" },
    { cmd: "gh", sub: "pr list", line: "", ms: 700 }, { cmd: "node", line: "", ms: 5000 },
  ];
  const { phaseCalls, subcommands } = summariseCensus(records);
  assert.deepEqual(phaseCalls, {
    tearDownSpares: { "gh issue list": { n: 2, wallMs: 1200 }, systemctl: { n: 1, wallMs: 8 } },
    tearDownReviewers: { "herdr org agent": { n: 1, wallMs: 40 } },
  }, "a call made outside every phase (the gate's children, the wake's) is in no phase's split, never under an empty name");
  assert.equal(subcommands["gh pr list"].n, 1, "the whole-tick figure still counts every call, attributed or not");
  assert.deepEqual(summariseCensus([{ cmd: "gh", sub: "pr list", line: "", ms: 1 }]).phaseCalls, {}, "records from before the field give an empty split, not a throw");
});

test("#3566 slice 7: a phase's split keeps its 10 slowest and folds the rest into `other` so the total still adds up", () => {
  const many = Array.from({ length: 13 }, (_, i) => ({ cmd: "gh", sub: `api route-${i}`, line: "", ms: 100 * (i + 1), phase: "wake" }));
  const split = summariseCensus(many).phaseCalls.wake;
  assert.equal(Object.keys(split).length, 11, "10 kept and one `other`");
  assert.equal(Object.values(split).reduce((sum, e) => sum + e.n, 0), 13, "no call is lost by folding");
});

test("#3566 slice 7: the meter names the phase while its step runs, clears it after, and clears it when the step THROWS", () => {
  const meter = createMeter({ ...scripted({ wall: [0, 1, 1, 2, 2, 3], cpu: [0, 0, 0, 0, 0, 0] }), uptimeMs: () => 0, maxRssKb: () => 0 });
  assert.equal(currentCensusPhase(), undefined);
  assert.equal(meter.phase("gate", () => currentCensusPhase()), "gate");
  assert.equal(currentCensusPhase(), undefined, "a finished phase leaves no name behind");
  assert.throws(() => meter.phase("wake", () => { throw new Error("boom"); }), /boom/);
  assert.equal(currentCensusPhase(), undefined, "a throwing phase cannot leave a stale name for the spawns after it");
});

test("#3566 slice 7: a REAL in-process spawn is recorded with the phase set when it started, and one after the phase with none", () => {
  const dir = mkdtempSync(join(tmpdir(), "census-phase-"));
  try {
    const census = join(dir, "census.jsonl");
    const driver = join(dir, "driver.mjs");
    const module = new URL("./lib/spawn-census.mjs", import.meta.url).href;
    writeFileSync(driver, `import { spawnSync } from "node:child_process";\nimport { installSpawnCensus, setCensusPhase } from ${JSON.stringify(module)};\n`
      + `installSpawnCensus(${JSON.stringify(census)});\nsetCensusPhase("tearDownSpares");\nspawnSync("git", ["--version"]);\nsetCensusPhase(undefined);\nspawnSync("git", ["--version"]);\n`);
    const ran = spawnSync(process.execPath, [...TSX_IMPORT, driver], { env: sandboxGitEnv({}), encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    const records = readFileSync(census, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(records.map((record: { phase?: string }) => record.phase), ["tearDownSpares", undefined]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#3566 slice 7 CONTROL: a quiet tick's line carries `phaseCalls`, and every phase in it is a phase the line also timed", () => {
  const { lines } = runTick({ gate: "process.exit(0);" });
  const { phaseCalls, phases } = lines[0];
  assert.equal(typeof phaseCalls, "object", JSON.stringify(lines[0]));
  for (const name of Object.keys(phaseCalls)) assert.ok(name in phases, `${name} is attributed to a phase the line does not have`);
  assert.deepEqual(Object.keys(phaseCalls.gate), ["node"], "the tick started the gate (one node) inside its phase; the gate's OWN children are another process, counted whole-tick");
});

test("#3566: a REAL git spawn through the preload leaves a record with its subcommand", () => {
  const dir = mkdtempSync(join(tmpdir(), "census-sub-"));
  try {
    const census = join(dir, "census.jsonl");
    const driver = join(dir, "driver.mjs");
    writeFileSync(driver, `import { spawnSync } from "node:child_process";\nspawnSync("git", ["-C", ${JSON.stringify(dir)}, "rev-parse", "HEAD"]);\n`);
    const ran = spawnSync(process.execPath, [...TSX_IMPORT, `--import=${new URL("./lib/spawn-census.mjs", import.meta.url).href}`, driver],
      { env: sandboxGitEnv({ [CENSUS_ENV]: census }), encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    const records = readFileSync(census, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.find((record: { cmd: string }) => record.cmd === "git")?.sub, "rev-parse");
    assert.equal(summariseCensus(records).subcommands["git rev-parse"].n, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#3566: an open list the tick already read is not read again by `readElsewherePrs`, a refusal is kept as a refusal, and a repository not yet read still is", () => {
  const scopes = [
    { key: "", code: { repo: "a11ign/a11ign" }, tracker: { repo: "a11ign/a11ign" } },
    { key: "agent-org", code: { repo: "a11ign/agent-org" }, tracker: null },
    { key: "control", code: { repo: "a11ign/control" }, tracker: null },
  ];
  const asked: string[] = [];
  const run = (args: string[], repo?: string) => {
    asked.push(`${repo} ${args.includes("merged") ? "merged" : "open"}`);
    return JSON.stringify(args.includes("merged") ? [] : [{ number: 38 }]);
  };
  readElsewherePrs(scopes as never, run as never);
  assert.deepEqual(asked, ["a11ign/agent-org open", "a11ign/agent-org merged", "a11ign/control open", "a11ign/control merged"], "the control: with nothing known, both lists are asked of both");

  asked.length = 0;
  const readAlready = [{ number: 41, repoKey: "agent-org", repo: "a11ign/agent-org" }];
  const known = [{ scope: scopes[1], read: { prs: readAlready } }, { scope: scopes[2], read: { prs: null } }];
  const read = readElsewherePrs(scopes as never, run as never, known as never)!;
  assert.deepEqual(asked, ["a11ign/agent-org merged", "a11ign/control merged"], "only the merged lists, which the lanes do not read, are asked");
  assert.equal(read.open, null, "a refused list stays refused: the claim is skipped, never read as `no open pull request`");
  const oneKnown = readElsewherePrs([scopes[0], scopes[1]] as never, run as never, known as never)!;
  assert.deepEqual(oneKnown.open, readAlready, "the known list is what is returned, not a re-read one");

  asked.length = 0;
  readElsewherePrs(scopes as never, run as never, [known[0]] as never);
  assert.deepEqual(asked, ["a11ign/agent-org merged", "a11ign/control open", "a11ign/control merged"], "a repository not among the known lanes is still read in full");
});

test("#3566: `main` hands the lanes `readOtherScopes` read to the claim-stall read, so no other repository's open list is asked twice", () => {
  const source = readFileSync(join(SRC, "work-gate.ts"), "utf8");
  assert.match(source, /claimStallsWithFacts\(openRowsRead, claimedComments, prs, otherScopes\)/);
  assert.match(source, /elsewhere: \(\) => readElsewherePrs\(undefined, undefined, otherScopes\)/);
});

test("#3566: the tick still has ONE exit, so no path out of main() skips the cost line", () => {
  const source = readFileSync(join(SRC, "work-tick.ts"), "utf8");
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

/** A `gh` for one `ready` row whose body states its template fields and whose `blockedBy` is empty; every call it is asked is kept, in order. */
function claimReads({ failBody = false } = {}) {
  const calls: string[][] = [];
  let labelReads = 0;
  const run = (_cmd: string, args: string[]): string => {
    calls.push(args);
    const json = args[args.indexOf("--json") + 1];
    if (args[1] === "view" && json === "number,title,labels,state") {
      labelReads += 1;
      const labels = labelReads === 1 ? ["ready"] : ["in-progress", "session:worker-9", "started", "was-ready"];
      return JSON.stringify({ number: 77, title: "A row", state: "OPEN", labels: labels.map((name) => ({ name })) });
    }
    if (args[1] === "view" && json === "body") {
      if (failBody) throw new Error("simulated: the body read failed");
      return JSON.stringify({ body: "Region: none\nAcceptance: x\nOpen-check: y\n" });
    }
    if (args[1] === "view" && json === "blockedBy") return JSON.stringify({ blockedBy: { nodes: [] } });
    return "[]";
  };
  return { calls, run };
}
const rowReads = (calls: string[][], json: string) => calls.filter((args) => args[0] === "issue" && args[1] === "view" && args.includes(json)).length;

test("#3566: one claim reads the row's body and its blockedBy edge ONCE each, and still reads its labels fresh before and after the write", () => {
  const { calls, run } = claimReads();
  const got = claimRow(77, "worker-9", { run, moveStatus: () => ({ moved: true }) });
  assert.equal(got.claimed, true, JSON.stringify(got));
  assert.equal(rowReads(calls, "body"), 1, "the template check and B4's Region lookup both ask for the body");
  assert.equal(rowReads(calls, "blockedBy"), 1, "the claim's own check and B2/B4's both ask for the edge");
  assert.equal(rowReads(calls, "number,title,labels,state"), 3, "the labels are NOT remembered: before the checks, before the write, after it");
});

test("#3566 CONTROL: a read that FAILED is retried, not remembered, so a failed body read still reaches the second check", () => {
  const { calls, run } = claimReads({ failBody: true });
  claimRow(77, "worker-9", { run, moveStatus: () => ({ moved: true }) });
  assert.equal(rowReads(calls, "body"), 2, "the template check's read failed (the claim fails open) and B4's Region lookup asked again");
});

/** One transcript line: the wake prompt, or a billed assistant turn with this cache-read figure. */
const wakePrompt = (session: string) => JSON.stringify({ type: "user", message: { role: "user", content: `You are \`${session}\`. Do the row.` } });
const billedTurn = (id: string, cacheRead: number) => JSON.stringify({ type: "assistant", timestamp: "2026-10-05T08:00:00Z",
  message: { id, model: "m", usage: { input_tokens: 1, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0, output_tokens: 1 } } });

/** A transcript root whose files are written with the given mtimes (seconds), plus a reader that counts every file it is asked to open. */
function transcriptRoot(files: { name: string; lines: string[]; mtime: number }[]) {
  const root = mkdtempSync(join(tmpdir(), "transcripts-"));
  mkdirSync(join(root, "-project"));
  for (const { name, lines, mtime } of files) {
    writeFileSync(join(root, "-project", name), `${lines.join("\n")}\n`);
    utimesSync(join(root, "-project", name), mtime, mtime);
  }
  const whole: string[] = [];
  const heads: string[] = [];
  const reader = {
    readText: (file: string) => { whole.push(file.split("/").pop()!); return readFileSync(file, "utf8"); },
    readHead: (file: string) => { heads.push(file.split("/").pop()!); return readFileSync(file, "utf8").slice(0, 64 * 1024); },
  };
  return { root, reader, whole, heads };
}

test("#3566: the newest transcript naming a session answers, and the older ones are never read whole", () => {
  const { root, reader, whole } = transcriptRoot([
    { name: "old.jsonl", lines: [wakePrompt("worker-7"), billedTurn("a", 111)], mtime: 1000 },
    { name: "new.jsonl", lines: [wakePrompt("worker-7"), billedTurn("b", 222)], mtime: 3000 },
    { name: "other.jsonl", lines: [wakePrompt("worker-8"), billedTurn("c", 333)], mtime: 4000 },
    { name: "older.jsonl", lines: [wakePrompt("worker-7"), billedTurn("d", 444)], mtime: 500 },
  ]);
  try {
    assert.equal(instanceCacheRead("worker-7", root, reader), 222, "the newest file naming worker-7, not the newest file");
    assert.deepEqual(whole, ["new.jsonl"], "worker-8's file is skipped on its head, and nothing older than the answer is opened");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#3566 CONTROL: a file whose head names nothing is still read whole, and a session with no transcript is `null`, never zero", () => {
  const { root, reader, whole } = transcriptRoot([
    { name: "resumed.jsonl", lines: [JSON.stringify({ type: "summary" }), billedTurn("a", 555), wakePrompt("worker-7"), billedTurn("b", 666)], mtime: 2000 },
  ]);
  // The wake prompt sits past the head the reader is shown: the first match is found only by reading the whole file, as before this change.
  const far = { ...reader, readHead: () => JSON.stringify({ type: "summary" }) };
  try {
    assert.equal(instanceCacheRead("worker-7", root, far), 666);
    assert.deepEqual(whole, ["resumed.jsonl"]);
    assert.equal(instanceCacheRead("worker-nobody", root, reader), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const gateSaying = (...lines: string[]) => `${lines.map((line) => `process.stderr.write(${JSON.stringify(`${line}\n`)});`).join(" ")} process.exit(0);`;

test("#3730: the gate's `github-status: operational (call N ms).` line is a phase of its own, named beside `gate` and not folded into it", () => {
  const { lines } = runTick({ gate: gateSaying("github-status: operational (call 251 ms).") });
  const { phases } = lines[0];
  assert.deepEqual(phases["github-status"], { wallMs: 251 }, JSON.stringify(phases));
  assert.ok("gate" in phases, "the gate is still a phase: the call's wall sits INSIDE its wall, so the two are read beside each other and never added");
});

test("#3730: a read that FAILED (`UNKNOWN (...; N ms)`) and a held one (`GITHUB INCIDENT: ... (call N ms)`) carry their wall too, so a slow failing page is visible", () => {
  const unknown = runTick({ gate: gateSaying("github-status: UNKNOWN (no answer within the bound; 5003 ms) -- nothing is held, the gate reads as it always did.") });
  assert.deepEqual(unknown.lines[0].phases["github-status"], { wallMs: 5003 });
  const incident = runTick({ gate: gateSaying("GITHUB INCIDENT: Actions degraded (call 1840 ms); holding 2 runner-start order(s) #1 #2.") });
  assert.deepEqual(incident.lines[0].phases["github-status"], { wallMs: 1840 });
});

test("#3730 CONTROL: a gate that says no such line, or one whose wall was not read, adds NO phase and the tick neither fails nor writes a zero", () => {
  for (const gate of [gateSaying(), gateSaying("github-status: UNKNOWN (the worker could not start (boom); wall not read) -- nothing is held."),
    gateSaying("github-status: operational (call N ms)."), gateSaying("a line that merely mentions github-status: operational (call 9 ms).")]) {
    const { ran, lines } = runTick({ gate });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(lines.length, 1, "the cost line is still written");
    assert.equal("github-status" in lines[0].phases, false, JSON.stringify(lines[0].phases));
  }
});

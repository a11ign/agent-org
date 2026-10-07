// no-token: gh
//
// Nothing here reaches the network or a real `gh`. The tick under test runs from a temporary `src/` whose `work-gate.mjs` and `wake.mjs` are stubs
// (the `wake` one records what it was handed), with the PATH pointed at an empty directory. ERASABLE TYPESCRIPT ONLY: node strips the types itself.

/**
 * a11ign/a11ign#3567: a tick over `TICK_SLOW_SECONDS` wakes `ceo` in the same tick, and a tick killed by the timeout is read by the NEXT one from the
 * start marker it left. Neither is noise: the control comes first (a 60 s tick says nothing), then 181 s says it ONCE, then a dead tick's marker says it
 * once and is cleared.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TICK_KILLED, TICK_MARKER_FILE, TICK_OVERRAN, TICK_SLOW, TICK_SLOW_SECONDS, clearOwnMarker, deliverTickOrders, killedTickOrders, readKilledTick,
  readMarker, slowThresholdSeconds, slowTickOrders, tickMarkerPath, writeStartMarker } from "./work-tick-health.mjs";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const PRELOAD = join(SRC, "lib", "crash-exit.mjs");
const COST_PATH = "/state/agent-org/tick-cost.jsonl";
const START = Date.parse("2026-10-04T21:40:04Z");

/** A `tick-cost` line as `work-tick.mjs` writes it, with only what the health reading reads; `wallS` is the wall in seconds. */
const costLine = (wallS: number, extra: Record<string, unknown> = {}) => ({
  at: START + wallS * 1000, wallMs: wallS * 1000, prestartMs: null, cpuMs: { self: 4000, children: 21_000 },
  phases: { startup: { wallMs: 900, cpuMs: 800 }, gate: { wallMs: wallS * 800, cpuMs: 15_000 }, wake: { wallMs: 700, cpuMs: 100 } }, ...extra,
});
const slow = (line: ReturnType<typeof costLine>) => slowTickOrders(line, { costPath: COST_PATH });

// --- SLOW: THE CONTROL FIRST ---------------------------------------------------------------------------------------------------------------------

test("#3567 CONTROL: a 60 s tick reports nothing, and neither does one of exactly the limit", () => {
  assert.equal(TICK_SLOW_SECONDS, 180, "the limit is the row's named constant");
  assert.deepEqual(slow(costLine(60)), []);
  assert.deepEqual(slow(costLine(TICK_SLOW_SECONDS)), [], "over the limit, not at it");
});

test("#3567: a 181 s tick reports ONCE, to ceo, with its wall, its CPU and the phase that took longest", () => {
  const orders = slow(costLine(181));
  assert.equal(orders.length, 1);
  const [order] = orders;
  assert.equal(order.session, "ceo");
  assert.equal(order.cause, TICK_OVERRAN);
  assert.equal(order.subject, TICK_SLOW);
  assert.match(order.prompt, /TOOK 181\.0 s/);
  assert.match(order.prompt, /CPU 25\.0 s \(4\.0 s its own, 21\.0 s its children's\)/);
  assert.match(order.prompt, /took longest: `gate`, 144\.8 s wall, 15\.0 s CPU/);
  assert.ok(order.prompt.includes(COST_PATH), "it says where the rest of the reading is");
});

test("#3567: the key is the tick's START, so the same tick read twice is one key and the next tick is another", () => {
  const [first] = slow(costLine(181));
  const [again] = slow(costLine(181));
  const [next] = slow({ ...costLine(181), at: costLine(181).at + 120_000 });
  assert.equal(first.causeKey, again.causeKey);
  assert.notEqual(first.causeKey, next.causeKey);
  assert.equal(first.causeKey, `ceo/${TICK_OVERRAN}/${TICK_SLOW}-${START}`);
});

test("#3567: ExecStartPre counts toward the wall, because `TimeoutStartSec` counts it", () => {
  const line = costLine(100, { prestartMs: 90_000 });
  const [order] = slow(line);
  assert.match(order.prompt, /TOOK 190\.0 s/);
  assert.match(order.prompt, /of which 90\.0 s was `ExecStartPre`/);
});

test("#3567: the limit is overridable only by a positive number, and a bad one falls back to the constant", () => {
  assert.equal(slowThresholdSeconds({}), TICK_SLOW_SECONDS);
  assert.equal(slowThresholdSeconds({ A11Y_TICK_SLOW_SECONDS: "2" }), 2);
  for (const bad of ["", "0", "-5", "soon"]) assert.equal(slowThresholdSeconds({ A11Y_TICK_SLOW_SECONDS: bad }), TICK_SLOW_SECONDS, bad);
});

// --- KILLED: THE MARKER ------------------------------------------------------------------------------------------------------------------------

/** A pid that belonged to a process that has ended. */
function deadPid(): number {
  const ran = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(ran.stdout);
}

function inDir<T>(use: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "tick-health-"));
  try {
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#3567: no marker is no killed tick, and a marker whose process ENDED is one", () => inDir((dir) => {
  const path = join(dir, TICK_MARKER_FILE);
  assert.equal(readKilledTick(path), null, "CONTROL: nothing there");
  writeStartMarker(path, { at: START, pid: deadPid() });
  assert.deepEqual(readKilledTick(path), { at: START, pid: readMarker(path)?.pid, unreadable: false });
}));

test("#3567: a marker whose process is still ALIVE is a tick running beside this one, not a killed one", () => inDir((dir) => {
  const path = join(dir, TICK_MARKER_FILE);
  // The worker's PARENT, which is alive: asking about a pid is `process.kill(pid, 0)`, and rstest's worker throws on that call for its own pid.
  writeStartMarker(path, { at: START, pid: process.ppid });
  assert.equal(readKilledTick(path), null);
}));

test("#3567: a marker that cannot be parsed is STILL a killed tick, said to be unreadable, and not a quiet one", () => inDir((dir) => {
  const path = join(dir, TICK_MARKER_FILE);
  writeFileSync(path, '{"at": 17');
  const marker = readKilledTick(path);
  assert.equal(marker?.unreadable, true);
  const [order] = killedTickOrders(marker, { foundAt: Date.now() + 5000, costPath: COST_PATH });
  assert.match(order.prompt, /MARKER WAS UNREADABLE/);
}));

test("#3567: a tick clears only ITS OWN marker", () => inDir((dir) => {
  const path = join(dir, TICK_MARKER_FILE);
  writeStartMarker(path, { at: START, pid: 4242 });
  clearOwnMarker(path, process.pid);
  assert.equal(existsSync(path), true, "another process's marker is left for its reader");
  clearOwnMarker(path, 4242);
  assert.equal(existsSync(path), false);
  clearOwnMarker(path, 4242); // idempotent
}));

test("#3567: a killed tick's order names when it started and how long it ran at most, once per start time", () => {
  assert.deepEqual(killedTickOrders(null, { foundAt: START, costPath: COST_PATH }), [], "CONTROL: no marker, no order");
  const found = START + 613_000;
  const [order] = killedTickOrders({ at: START, pid: 1, unreadable: false }, { foundAt: found, costPath: COST_PATH });
  assert.equal(order.session, "ceo");
  assert.equal(order.subject, TICK_KILLED);
  assert.match(order.prompt, /started at 2026-10-04T21:40:04\.000Z never finished/);
  assert.match(order.prompt, /at most 613\.0 s/);
  assert.equal(order.causeKey, `ceo/${TICK_OVERRAN}/${TICK_KILLED}-${START}`);
});

// --- DELIVERY ----------------------------------------------------------------------------------------------------------------------------------

test("#3567: delivery hands `wake` one JSON line per order, and a `wake` that refuses is SAID, never swallowed", () => {
  const [order] = slow(costLine(181));
  const said: string[] = [];
  const seen: { input: string }[] = [];
  const fake = (status: number) => ((_node: string, _args: string[], options: { input: string }) => { seen.push(options); return { status, stdout: "", stderr: "" }; }) as unknown as typeof spawnSync;
  assert.equal(deliverTickOrders([], { node: "n", args: [], spawn: fake(0), say: (text) => said.push(text) }), false, "no order, no wake");
  assert.equal(seen.length, 0);
  assert.equal(deliverTickOrders([order], { node: "n", args: [], spawn: fake(0), say: (text) => said.push(text) }), true);
  assert.deepEqual(JSON.parse(seen[0].input), order);
  assert.deepEqual(said, []);
  const refused: string[] = [];
  assert.equal(deliverTickOrders([order], { node: "n", args: [], spawn: fake(1), say: (text) => refused.push(text) }), false);
  assert.match(refused.join(""), /TICK HEALTH NOT DELIVERED \(tick-slow\).*nowhere to go/);
});

// --- THROUGH THE REAL TICK ---------------------------------------------------------------------------------------------------------------------

/** A tick run from a temporary `src/`, whose `wake` appends whatever it is handed to `delivered.jsonl` beside the ledger. */
function tickIn(dir: string, gate = "process.exit(0);") {
  const src = join(dir, "src");
  mkdirSync(src);
  const own = new Set(["work-tick.mjs", "work-gate.mjs", "wake.mjs"]);
  for (const name of readdirSync(SRC).filter((entry) => !own.has(entry))) symlinkSync(join(SRC, name), join(src, name));
  writeFileSync(join(src, "work-tick.mjs"), readFileSync(join(SRC, "work-tick.mjs"), "utf8"));
  writeFileSync(join(src, "work-gate.mjs"), gate);
  writeFileSync(join(src, "wake.mjs"),
    `export * from ${JSON.stringify(join(SRC, "wake.mjs"))};\n`
    + `import { appendFileSync, readFileSync } from "node:fs";\nimport { fileURLToPath } from "node:url";\n`
    + `if (process.argv[1] === fileURLToPath(import.meta.url)) appendFileSync(${JSON.stringify(join(dir, "delivered.jsonl"))}, readFileSync(0, "utf8"));\n`);
  mkdirSync(join(dir, "empty"));
  const ledger = join(dir, "ledger.jsonl");
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
    const base: NodeJS.ProcessEnv = { ...process.env, PATH: join(dir, "empty"), ...extra };
    delete base.INVOCATION_ID;
    return base;
  };
  const args = [`--import=${PRELOAD}`, join(src, "work-tick.mjs"), `--ledger=${ledger}`];
  return {
    marker: tickMarkerPath(ledger),
    run: (extra?: NodeJS.ProcessEnv) => spawnSync(process.execPath, args, { encoding: "utf8", cwd: dir, env: env(extra) }),
    runUntilKilled: (killAfterMs: number) => spawnSync(process.execPath, args, { encoding: "utf8", cwd: dir, env: env(), timeout: killAfterMs, killSignal: "SIGKILL" }),
    delivered: () => (existsSync(join(dir, "delivered.jsonl")) ? readFileSync(join(dir, "delivered.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []),
  };
}

test("#3567 CONTROL, through the tick: an ordinary tick tells nobody, and leaves no marker behind", () => inDir((dir) => {
  const tick = tickIn(dir);
  const ran = tick.run();
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(tick.delivered(), []);
  assert.equal(existsSync(tick.marker), false, "a tick that ends by itself clears its marker");
}));

test("#3567, through the tick: a tick over the limit wakes ceo once, before it exits, and clears its marker", () => inDir((dir) => {
  const tick = tickIn(dir, `setTimeout(() => process.exit(0), 1300);`);
  const ran = tick.run({ A11Y_TICK_SLOW_SECONDS: "1" });
  assert.equal(ran.status, 0, ran.stderr);
  const delivered = tick.delivered();
  assert.equal(delivered.length, 1, JSON.stringify(delivered));
  assert.equal(delivered[0].subject, TICK_SLOW);
  assert.equal(delivered[0].session, "ceo");
  assert.match(delivered[0].prompt, /took longest: `gate`/);
  assert.equal(existsSync(tick.marker), false);
}));

test("#3567, through the tick: a tick SIGKILLed mid-run leaves its marker, and the NEXT tick reports it ONCE and the one after reports nothing", () => inDir((dir) => {
  const tick = tickIn(dir, `setTimeout(() => process.exit(0), 3000);`);
  const killed = tick.runUntilKilled(1200);
  assert.equal(killed.signal, "SIGKILL");
  assert.equal(existsSync(tick.marker), true, "a killed tick cannot clear its marker, and that is the whole signal");
  assert.deepEqual(tick.delivered(), [], "and it told nobody, which is why the next one must");

  const next = tick.run();
  assert.equal(next.status, 0, next.stderr);
  const delivered = tick.delivered();
  assert.equal(delivered.length, 1, JSON.stringify(delivered));
  assert.equal(delivered[0].subject, TICK_KILLED);
  assert.equal(delivered[0].session, "ceo");
  assert.equal(existsSync(tick.marker), false, "read, and cleared");

  assert.equal(tick.run().status, 0);
  assert.equal(tick.delivered().length, 1, "a third tick finds nothing: one report per killed tick");
}));

test("#3567, through the tick: a tick whose gate CRASHES clears its marker too, so it is not later reported as killed (`incident:gate-crash` reads a crash)", () => inDir((dir) => {
  const tick = tickIn(dir, `throw new Error("the gate crashed");`);
  const ran = tick.run();
  assert.notEqual(ran.status, 0, "CONTROL: the tick did not complete quietly");
  assert.equal(existsSync(tick.marker), false);
  assert.equal(tick.run().status, ran.status);
  assert.deepEqual(tick.delivered(), [], "and the next tick has no marker to read");
}));

test("#3730: a longest phase some other process timed has a wall and NO CPU, and the order says so rather than printing NaN", () => {
  const line = costLine(181);
  line.phases = { ...line.phases, "github-status": { wallMs: 999_999 } } as typeof line.phases;
  const [order] = slow(line);
  assert.match(order.prompt, /took longest: `github-status`, 1000\.0 s wall, CPU not measured\./);
  assert.doesNotMatch(order.prompt, /NaN/);
});

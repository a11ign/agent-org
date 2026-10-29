// no-token: gh -- the clock and the stack are injected; the one process started is this Node, running `sleep` under the installed ledger
import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { callSiteOf, createBlockingLedger, programOf, SLOW_MS } from "./blocking-ledger.ts";

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LEDGER = join(CHECKOUT, "src", "ticket-mode", "blocking-ledger.ts");

/** A stack as V8 writes it: the wrapper's frame first, then the frames `frames` names. */
const stackOf = (...frames: string[]): string => ["Error: call site", `    at timed (file://${LEDGER}:90:7)`, ...frames.map((frame) => `    at ${frame}`)].join("\n");
const SWEEP = `sweep (${CHECKOUT}/plugins/github/pull-feedback.ts:74:12)`;

/** A ledger whose clock moves `ms` across each call, saying what it logs. */
function ledgerTiming(ms: number, stack = () => stackOf(SWEEP)) {
  const said: string[] = [];
  let clock = 0;
  let across = false;
  const ledger = createBlockingLedger({ now: () => { clock += across ? ms : 0; across = !across; return clock; }, err: (line) => said.push(line), name: "ticket:serve", stack });
  return { ledger, said };
}

test("a wrapped spawn is called with the same arguments and this, answers what the original answered, and is counted against its call site", () => {
  const { ledger } = ledgerTiming(40);
  const calls: unknown[][] = [];
  const original = function (this: unknown, ...args: unknown[]) { calls.push([this, ...args]); return { status: 0, stdout: "out" }; };
  const timed = ledger.wrap("spawnSync", original as (...args: never[]) => unknown);
  const owner = { name: "owner" };
  assert.deepEqual(timed.call(owner, ...(["gh", ["pr", "list"], { encoding: "utf8" }] as never[])), { status: 0, stdout: "out" });
  assert.deepEqual(calls, [[owner, "gh", ["pr", "list"], { encoding: "utf8" }]]);
  timed(...(["gh", ["api", "x"]] as never[]));
  assert.deepEqual(ledger.worst(10), [{ site: "plugins/github/pull-feedback.ts:74", program: "gh", count: 2, totalMs: 80, maxMs: 40 }]);
});

test("a spawn that throws throws the same error, and is still counted", () => {
  const { ledger } = ledgerTiming(5);
  const failure = new Error("Command failed: git fetch");
  const timed = ledger.wrap("execFileSync", (() => { throw failure; }) as (...args: never[]) => unknown);
  assert.throws(() => timed(...(["git", ["fetch"]] as never[])), (err) => err === failure);
  assert.equal(ledger.worst(1)[0]?.count, 1);
});

test("a ledger that cannot count a call still answers, and throws, what the spawn did", () => {
  const unreadable = createBlockingLedger({ err: () => {}, stack: () => stackOf("sweep (file://elsewhere/plugins/github/pull-feedback.ts:74:12)") });
  const answered = unreadable.wrap("spawnSync", (() => "answered") as (...args: never[]) => unknown);
  assert.equal(answered(...(["gh"] as never[])), "answered", "a frame on another host is not a path the ledger can read");
  let clock = 0;
  const silent = createBlockingLedger({ now: () => (clock += SLOW_MS), err: () => { throw new Error("EPIPE"); }, stack: () => stackOf(SWEEP) });
  const failure = new Error("Command failed: gh api");
  const failing = silent.wrap("execFileSync", (() => { throw failure; }) as (...args: never[]) => unknown);
  assert.throws(() => failing(...(["gh"] as never[])), (err) => err === failure, "a stderr that refuses the line");
});

test(`a call that holds the loop ${SLOW_MS} ms or more is said on one line as it returns, and a shorter one is not`, () => {
  const slow = ledgerTiming(SLOW_MS);
  slow.ledger.wrap("spawnSync", (() => null) as (...args: never[]) => unknown)(...(["gh"] as never[]));
  assert.deepEqual(slow.said, ["ticket:serve: a synchronous gh held the loop 250 ms, at plugins/github/pull-feedback.ts:74\n"]);
  const quick = ledgerTiming(SLOW_MS - 1);
  quick.ledger.wrap("spawnSync", (() => null) as (...args: never[]) => unknown)(...(["gh"] as never[]));
  assert.deepEqual(quick.said, []);
});

test("worst answers the sites with the most time in all, the worst first, as many as asked", () => {
  const sites = [`a (${CHECKOUT}/src/a.ts:1:1)`, `b (${CHECKOUT}/src/b.ts:2:1)`, `c (${CHECKOUT}/src/c.ts:3:1)`];
  let next = 0;
  const { ledger } = ledgerTiming(10, () => stackOf(sites[next]));
  const timed = ledger.wrap("execSync", (() => "") as (...args: never[]) => unknown);
  for (const [site, times] of [[0, 1], [1, 3], [2, 2]] as const) {
    next = site;
    for (let made = 0; made < times; made += 1) timed(...(["herdr pane list"] as never[]));
  }
  assert.deepEqual(ledger.worst(2).map(({ site, program, totalMs }) => [site, program, totalMs]), [["src/b.ts:2", "herdr", 30], ["src/c.ts:3", "herdr", 20]]);
});

test("the call site is the first frame outside Node, the ledger and the seams that only pass a spawn on", () => {
  const stack = stackOf(
    "spawnSync (node:child_process:870:11)",
    `realExec (${CHECKOUT}/src/plugins/real-seams.ts:30:10)`,
    `run (file://${CHECKOUT}/plugins/github/gh.ts:50:3)`,
    `exec (file://${CHECKOUT}/plugins/github/call-counter.ts:99:14)`,
    `readFeedback (file://${CHECKOUT}/plugins/github/pull-feedback.ts:74:12)`,
    `sweep (${CHECKOUT}/src/ticket-mode/pool.ts:12:1)`,
  );
  assert.equal(callSiteOf(stack, CHECKOUT, LEDGER), "plugins/github/pull-feedback.ts:74");
  assert.equal(callSiteOf(stackOf(`${CHECKOUT}/src/ticket-mode/server.ts:866:84`), CHECKOUT, LEDGER), "src/ticket-mode/server.ts:866", "a frame with no function name");
  assert.equal(callSiteOf(stackOf("spawnSync (node:child_process:870:11)"), CHECKOUT, LEDGER), "unknown");
});

test("herdr's own runners are seams too, so a herdr call is the code that asked for it and not herdr-agents.ts (A11-282)", () => {
  const stack = stackOf(
    "execFileSync (node:child_process:870:11)",
    `herdrRun (${CHECKOUT}/src/herdr-agents.ts:46:12)`,
    `defaultHerdr (${CHECKOUT}/src/ticket-mode/pool-herdr.ts:10:62)`,
    `readSessionIds (${CHECKOUT}/src/ticket-mode/pool-watch.ts:98:30)`,
  );
  assert.equal(callSiteOf(stack, CHECKOUT, LEDGER), "src/ticket-mode/pool-watch.ts:98");
});

test("the program is the file's own name, a command line's first word, and node for this Node", () => {
  assert.equal(programOf("spawnSync", "/home/me/.local/bin/gh"), "gh");
  assert.equal(programOf("execFileSync", "git"), "git");
  assert.equal(programOf("execSync", "  herdr pane list --json"), "herdr");
  assert.equal(programOf("spawnSync", process.execPath), "node");
});

test("install puts the wrappers on node:child_process once, and what it answers puts the originals back", () => {
  const before = { spawnSync: childProcess.spawnSync, execFileSync: childProcess.execFileSync, execSync: childProcess.execSync };
  const ledger = createBlockingLedger({ err: () => {} });
  const uninstall = ledger.install();
  try {
    assert.notEqual(childProcess.spawnSync, before.spawnSync);
    assert.notEqual(childProcess.execFileSync, before.execFileSync);
    assert.notEqual(childProcess.execSync, before.execSync);
    const wrapped = childProcess.spawnSync;
    assert.equal(ledger.install(), uninstall, "a second install changes nothing");
    assert.equal(childProcess.spawnSync, wrapped);
  } finally {
    uninstall();
  }
  assert.deepEqual({ spawnSync: childProcess.spawnSync, execFileSync: childProcess.execFileSync, execSync: childProcess.execSync }, before);
});

test("installed at start, the ledger times a spawn made through a named import a module took before it, as every module of the instance holds one", () => {
  const dir = tmpDir("blocking-ledger-");
  const probe = join(dir, "probe.mjs");
  writeFileSync(probe, [
    "import { execFileSync } from \"node:child_process\";",
    `const { startHealth } = await import(${JSON.stringify(new URL("./health-route.ts", import.meta.url).href)});`,
    "const health = startHealth(\"probe\");",
    "const answered = execFileSync('sh', ['-c', 'sleep 0.3; echo slept'], { encoding: 'utf8' });",
    "process.stdout.write(JSON.stringify({ answered, health: health.view() }));",
    "",
  ].join("\n"));
  const run = spawnSync(process.execPath, [probe], { encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr);
  const { answered, health } = JSON.parse(run.stdout) as { answered: string; health: { blocking: { site: string; program: string; count: number; maxMs: number }[] } };
  assert.equal(answered, "slept\n", "the spawn answered what it always did");
  const site = health.blocking.find((entry) => entry.site.endsWith("probe.mjs:4"));
  assert.ok(site !== undefined, JSON.stringify(health.blocking));
  assert.equal(site.program, "sh");
  assert.equal(site.count, 1);
  assert.ok(site.maxMs >= SLOW_MS, `held ${site.maxMs} ms`);
  assert.match(run.stderr, /^probe: a synchronous sh held the loop \d+ ms, at .*probe\.mjs:4$/m);
});

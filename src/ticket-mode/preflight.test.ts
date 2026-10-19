// no-token: none -- the gate runs an injected executor; the real one is driven with `true`, `false`, `echo` and `sleep`, never `gh` or the tracker
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGate, firstLine, reasonOf, runPreflights, shellPreflight, REASON_CHARS, type Preflight, type PreflightExec } from "./preflight.ts";

const check = (name: string, run = name): Preflight => ({ name, run, timeoutSeconds: 5 });
const exits = (table: Record<string, { status: number | null; output?: string; timedOut?: boolean }>): PreflightExec => async (command) => {
  const row = table[command];
  if (row === undefined) throw new Error(`no such command: ${command}`);
  return { status: row.status, timedOut: row.timedOut ?? false, output: row.output ?? "" };
};

test("firstLine: the first line a command printed, with no colour or blank lines, cut to the longest reason", () => {
  assert.equal(firstLine("\n  \n\u001b[31mEXPIRED\u001b[0m: run it\nthen this"), "EXPIRED: run it");
  assert.equal(firstLine(""), null);
  assert.equal(firstLine("x".repeat(REASON_CHARS + 50))?.length, REASON_CHARS);
});

test("reasonOf: what the command printed, else how it ended", () => {
  assert.equal(reasonOf({ status: 1, timedOut: false, output: "login is dead" }, 30), "login is dead");
  assert.equal(reasonOf({ status: 7, timedOut: false, output: "" }, 30), "exited 7 and printed nothing");
  assert.equal(reasonOf({ status: null, timedOut: true, output: "" }, 30), "did not finish within 30 s");
  assert.equal(reasonOf({ status: null, timedOut: false, output: "" }, 30), "was stopped before it finished");
});

test("runPreflights: every command must pass, in order, and the first that does not names itself and stops the rest", async () => {
  const asked: string[] = [];
  const exec = exits({ a: { status: 0 }, b: { status: 2, output: "b is down" }, c: { status: 0 } });
  const recording: PreflightExec = async (command, ms) => { asked.push(command); return exec(command, ms); };
  assert.deepEqual(await runPreflights([check("a"), check("b"), check("c")], recording), { ok: false, name: "b", reason: "b is down" });
  assert.deepEqual(asked, ["a", "b"], "c is never asked after b fails");
  assert.deepEqual(await runPreflights([check("a")], exec), { ok: true });
  assert.deepEqual(await runPreflights([], exec), { ok: true });
});

test("runPreflights: a command that cannot be started, or that times out, is a failure with a reason, never a pass", async () => {
  assert.deepEqual(await runPreflights([check("missing")], exits({})), { ok: false, name: "missing", reason: "no such command: missing" });
  assert.deepEqual(await runPreflights([check("slow")], exits({ slow: { status: null, timedOut: true } })), { ok: false, name: "slow", reason: "did not finish within 5 s" });
  assert.equal((await runPreflights([check("ok-but-late")], exits({ "ok-but-late": { status: 0, timedOut: true } }))).ok, false, "a command killed for time is never a pass, whatever status it left");
});

test("createGate: a pass stands for a minute, a failure is tried again after a minute, and two asks at once share one run", async () => {
  let clock = 0;
  let runs = 0;
  let status = 1;
  const exec: PreflightExec = async () => { runs += 1; await new Promise((resolve) => setImmediate(resolve)); return { status, timedOut: false, output: "down" }; };
  const gate = createGate([check("x")], exec, () => clock);
  const [first, second] = await Promise.all([gate.check(), gate.check()]);
  assert.deepEqual([first.ok, second.ok, runs], [false, false, 1]);
  clock = 59_000;
  await gate.check();
  assert.equal(runs, 1, "a failure is not asked again inside a minute");
  status = 0;
  clock = 61_000;
  assert.equal((await gate.check()).ok, true);
  assert.equal(runs, 2);
  clock = 100_000;
  await gate.check();
  assert.equal(runs, 2, "a pass stands inside a minute");
});

test("createGate: held() says why while a command fails, keeps the time it began, and is null once it passes", async () => {
  let clock = 1000;
  let status = 1;
  const gate = createGate([check("login")], async () => ({ status, timedOut: false, output: "expired" }), () => clock);
  assert.equal(gate.held(), null, "nothing is held before the first ask");
  await gate.check();
  assert.deepEqual(gate.held(), { name: "login", reason: "expired", since: 1000 });
  clock = 70_000;
  await gate.check();
  assert.equal(gate.held()?.since, 1000, "the time a hold began does not move while it lasts");
  status = 0;
  clock = 140_000;
  await gate.check();
  assert.equal(gate.held(), null);
});

test("createGate: with no commands it passes and runs nothing", async () => {
  let runs = 0;
  const gate = createGate([], async () => { runs += 1; return { status: 1, timedOut: false, output: "" }; });
  assert.deepEqual(await gate.check(), { ok: true });
  assert.deepEqual([runs, gate.held()], [0, null]);
});

test("shellPreflight: exit status and output of a real shell command, in the instance's own environment", async () => {
  assert.deepEqual(await shellPreflight("true", 5000), { status: 0, timedOut: false, output: "" });
  assert.deepEqual(await shellPreflight("echo hello; exit 3", 5000), { status: 3, timedOut: false, output: "hello\n" });
  assert.equal((await shellPreflight("echo oops >&2; exit 1", 5000)).output, "oops\n", "what a command prints on stderr is read too");
  assert.equal((await shellPreflight("echo $PREFLIGHT_PROBE", 5000)).output, "\n", "a variable the instance does not have is empty");
});

test("shellPreflight: a command that outlives its time is stopped and says it timed out", async () => {
  const run = await shellPreflight("sleep 5", 200);
  assert.equal(run.timedOut, true);
});

test("shellPreflight: a command is given no input to wait on", async () => {
  const run = await shellPreflight("cat; echo done", 5000);
  assert.deepEqual([run.status, run.output], [0, "done\n"]);
});

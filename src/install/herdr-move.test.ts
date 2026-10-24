// no-token: none -- `launchctl`, `herdr` and `ps` are a recording stand-in, and every plist is written into a temporary HOME
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { COMMANDS } from "../commands.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { startHerdr, type MoveDeps } from "./herdr-move.ts";
import type { HerdrPlace } from "./herdr-place.ts";
import { retireGuards } from "./interim-guards.ts";
import { main, unitFor, type RunResult, type ServiceDeps } from "./service.ts";

const done = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const IN_UNIT: HerdrPlace = { kind: "unit", where: "process group of io.github.agent-org.herdr" };

type Mac = Readonly<{
  /** Where the server runs when the move starts. */
  from: HerdrPlace;
  /** Where it runs once launchd has bootstrapped the unit: `IN_UNIT`, or `none` for a unit whose server never comes up. */
  afterStart?: HerdrPlace;
  /** Answers that replace the stand-in's own, by the command's first words (`launchctl bootstrap`). */
  answers?: Record<string, RunResult>;
}>;

/** A Mac: launchd, `herdr` and `ps` answer through one `run`, and the server's place moves as the commands run: `server stop` ends it, and a `bootstrap` or `kickstart` of the unit starts one. */
function mac({ from, afterStart = IN_UNIT, answers = {} }: Mac) {
  const home = tmpDir("herdr-move-");
  const files = new Map<string, string>([[join(home, ".agent-org", "host.json"), JSON.stringify({ tickets: { herdrSession: "work" } })], ["/opt/bin/herdr", ""], ["/opt/bin/bun", ""]]);
  const calls: string[] = [];
  let current = from;
  const run: ServiceDeps["run"] = (file, args) => {
    const call = [file, ...args].join(" ");
    calls.push(call);
    const answer = Object.entries(answers).find(([prefix]) => call.startsWith(prefix));
    if (answer) return answer[1];
    if (file === "herdr" && args.includes("stop")) current = { kind: "none" };
    if (file === "launchctl" && (args[0] === "bootstrap" || args[0] === "kickstart")) current = afterStart;
    if (file === "launchctl" && args[0] === "print") return { status: 113, stdout: "", stderr: "Could not find service" };
    return done();
  };
  const services: ServiceDeps = {
    platform: "darwin", env: { PATH: "/opt/bin:/usr/bin" }, home, uid: 501, node: "/opt/node/bin/node", toolRoot: join(home, ".agent-org", "tool", "current"), commands: COMMANDS, user: "alice",
    exists: (path) => files.has(path), read: (path) => files.get(path) ?? null, write: (path, text) => { files.set(path, text); }, run,
  };
  const deps: MoveDeps = {
    services, liveRuns: () => 0, placeOf: () => current, wait: async () => undefined,
    retire: () => retireGuards({ platform: "darwin", env: {}, home, exists: services.exists, remove: () => undefined, run, replacements: async () => ({ ghWrapperDeclared: true, herdrInOwnUnit: true }) }),
  };
  return { deps, services, calls, files, unit: unitFor("herdr", services) };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, console: { log: (line: string) => out.push(line), error: (line: string) => err.push(line) } };
}

test("the macOS move, with launchctl and herdr stubbed, completes and reports each step in order, then a result line", async () => {
  const { deps, services, calls, unit } = mac({ from: { kind: "elsewhere", where: "process group of pid 4242" } });
  const said = io();
  assert.equal(await main(["start", "herdr", "--move"], services, said.console, deps), 0);
  assert.deepEqual(said.err, []);
  const [one, two, three, four, ...rest] = said.out;
  assert.equal(one, `step 1 of 4: registered the herdr unit (launchd io.github.agent-org.herdr, ${unit.path})`);
  assert.equal(two, "step 2 of 4: stopped the herdr server that ran outside the unit (process group of pid 4242); herdr restores its workspaces when the unit's server is up");
  assert.equal(three, `step 3 of 4: started the herdr unit (launchd io.github.agent-org.herdr), logging to ${unit.log}`);
  assert.equal(four, `step 4 of 4: the herdr server for session work answers in the unit (${IN_UNIT.where})`);
  assert.equal(rest.at(-1), "moved herdr into its service: the server for session work runs in io.github.agent-org.herdr, and herdr restores its workspaces in it");
  const stop = calls.indexOf("herdr --session work server stop");
  const bootstrap = calls.findIndex((call) => call.startsWith("launchctl bootstrap gui/501 "));
  assert.ok(stop >= 0 && bootstrap > stop, `the outside server is stopped, then launchd bootstraps the unit: ${calls.join(" | ")}`);
});

test("a move on a server already in the unit says it stopped nothing, and a unit already registered is said so", async () => {
  const { deps, unit, files } = mac({ from: IN_UNIT });
  files.set(unit.path, "registered earlier");
  const said: string[] = [];
  await startHerdr({ move: true }, deps, (line) => said.push(line));
  assert.equal(said[0], `step 1 of 4: registered the herdr unit (launchd io.github.agent-org.herdr, already registered at ${unit.path})`);
  assert.equal(said[1], "step 2 of 4: no herdr server ran outside the unit, so none was stopped");
  assert.match(said[3], /^step 4 of 4: the herdr server for session work answers in the unit/);
});

test("a server that never comes up in the unit refuses at step 4, naming the log and the fix, after steps 1 to 3 were said", async () => {
  const { deps, services, unit } = mac({ from: { kind: "none" }, afterStart: { kind: "none" } });
  const said = io();
  assert.equal(await main(["start", "herdr", "--move"], services, said.console, deps), 2);
  assert.deepEqual(said.out.map((line) => line.slice(0, 11)), ["step 1 of 4", "step 2 of 4", "step 3 of 4"], "what was done stays on screen");
  assert.equal(said.err.length, 1);
  assert.ok(said.err[0].startsWith("agent-org: step 4 of 4 (waiting for the server in the unit) failed: the herdr server for session work is not running in the unit 10s after it started."), said.err[0]);
  assert.ok(said.err[0].includes(`Read ${unit.log}, then run \`agent-org start herdr\``), said.err[0]);
});

test("a launchctl that refuses the unit fails step 3 with the fix, and a herdr that will not stop fails step 2 with its hand-run command", async () => {
  const started = mac({ from: { kind: "none" }, answers: { "launchctl bootstrap": { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" } } });
  await assert.rejects(() => startHerdr({ move: true }, started.deps), (err: Error) => err.message.startsWith("step 3 of 4 (starting the unit) failed: ")
    && err.message.includes("Bootstrap failed: 5") && err.message.includes("Run `agent-org status herdr` and read "));
  const stuck = mac({ from: { kind: "instance", where: "/i" }, answers: { "herdr --session": { status: 1, stdout: "", stderr: "boom" } } });
  await assert.rejects(() => startHerdr({ move: true }, stuck.deps), (err: Error) => err.message.startsWith("step 2 of 4 (stopping the outside server) failed: herdr would not stop its server for session work: boom. Nothing was started.")
    && err.message.includes("Run `herdr --session work server stop` by hand, then `agent-org start herdr --move` again"));
});

test("a unit that cannot be written fails step 1 and says which folder to make writable", async () => {
  const { deps, unit } = mac({ from: { kind: "none" } });
  const unwritable: MoveDeps = { ...deps, services: { ...deps.services, write: () => { throw new Error("EACCES: permission denied"); } } };
  await assert.rejects(() => startHerdr({ move: true }, unwritable), (err: Error) => err.message.startsWith("step 1 of 4 (registering the unit) failed: EACCES: permission denied. Make ")
    && err.message.includes(unit.path.slice(0, unit.path.lastIndexOf("/"))));
});

test("guards whose retirement never settles time out with a message instead of ending the process", async () => {
  const { deps } = mac({ from: { kind: "none" } });
  const hanging: MoveDeps = { ...deps, limitMs: 50, retire: () => new Promise(() => undefined) };
  await assert.rejects(() => startHerdr({ move: true }, hanging), { message: "`retiring the interim guards` did not finish within 0.05s" });
});

test("a plain start of herdr prints no steps and does not wait for the server to answer", async () => {
  const { deps } = mac({ from: { kind: "none" }, afterStart: { kind: "none" } });
  const said: string[] = [];
  const started = await startHerdr({ move: false }, deps, (line) => said.push(line));
  assert.equal(started.id, "io.github.agent-org.herdr");
  assert.deepEqual(said, []);
});

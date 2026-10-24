// no-token: gh
//
// Nothing here reaches the network or the real `gh`. The tick under test runs from a temporary `src/` whose `work-gate.ts` and `wake.ts` are stubs,
// with the PATH pointed at one directory holding a `gh` STUB that records what it was asked and whether the completion file already existed when it
// was (a child process runs the GitHub plugin, so what it is asked is the plugin's own argument list; the unit-level cases below run on the fake code host's rows, A11-160 step 9).
// ERASABLE TYPESCRIPT ONLY: node strips the types itself, so no enum, namespace or parameter property here.

/**
 * a11ign/a11ign#3880: the gate's last COMPLETION is written to one GitHub object (the Actions variable `GATE_LAST_TICK`), so the control plane (#3851)
 * can read it without an ssh into the agents host. The write is the file's sibling and inherits its meaning: a tick that reached the end of `main()`.
 * a11ign/a11ign#3896: the same completion is also written to one standing COMMENT, because the control plane's token has no scopes and GitHub refuses it the
 * variable; the comment's `updated_at` is what a tokenless reader takes.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homeProjectDeclaration } from "../project-config.ts";
import { EXIT, HEARTBEAT_COMMENT_ID, HEARTBEAT_COMMENT_MARKER, HEARTBEAT_VARIABLE, heartbeatCommentBody, writeHeartbeat } from "../work-tick.ts";
import { completionPath, readCompletion } from "../lib/tick-completion.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow } from "../plugins/fakes/code-host-rows.ts";

afterEach(() => forgetActivation());

const SRC = fileURLToPath(new URL("..", import.meta.url));
const PRELOAD = join(SRC, "lib", "crash-exit.ts");
// #4080: the variable is written to EVERY declared tracker and the standing comment to the FIRST alone, so what a tick writes follows the project's declaration:
// one tracker was two writes, a second tracker (a11ign/agent-org, declared at the pin) makes it three. The expectations below are derived from the declaration.
const TRACKERS = homeProjectDeclaration().tracker.map((tracker) => tracker.repo);
const TRACKER = TRACKERS[0];
const WRITES = TRACKERS.length + 1;
const GATE_THROWS = 'throw new Error("gate blew up");\n';

type Call = { argv: string[]; completionExisted: boolean };
type Fails = false | "all" | "comment";
type Tick = { gate: string; wakeExit?: number; ghFails?: Fails; recordIsADirectory?: boolean; tickSource?: (original: string) => string };

/** The `gh` stub: a node script (the shebang is the absolute `node`, since the PATH holds only this directory) that logs one JSON line per call. */
function ghStub(log: string, completion: string, fails: Fails) {
  return `#!${process.execPath}\n`
    + `const fs = require("node:fs");\n`
    + `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), completionExisted: fs.existsSync(${JSON.stringify(completion)}) }) + "\\n");\n`
    + (fails ? `if (${fails === "all"} || process.argv.some((arg) => arg.includes("/issues/comments/"))) { process.stderr.write("gh: Resource not accessible (HTTP 403)\\n"); process.exit(1); }\n` : "");
}

function runTick({ gate, wakeExit = 0, ghFails = false as Fails, recordIsADirectory = false, tickSource = (original) => original }: Tick) {
  const dir = mkdtempSync(join(tmpdir(), "tick-heartbeat-"));
  try {
    const src = join(dir, "src");
    const bin = join(dir, "bin");
    mkdirSync(src);
    writeFileSync(join(src, "package.json"), '{"type":"module"}'); // tsx reads a loose .ts as CommonJS without it, and a .mjs it reaches then fails on its top-level await
    mkdirSync(bin);
    const own = new Set(["work-tick.ts", "work-gate.ts", "wake.ts"]);
    for (const name of readdirSync(SRC).filter((entry) => !own.has(entry))) symlinkSync(join(SRC, name), join(src, name));
    writeFileSync(join(src, "work-tick.ts"), tickSource(readFileSync(join(SRC, "work-tick.ts"), "utf8")));
    writeFileSync(join(src, "work-gate.ts"), gate);
    writeFileSync(join(src, "wake.ts"),
      `export * from ${JSON.stringify(join(SRC, "wake.ts"))};\n`
      + `import { fileURLToPath } from "node:url";\n`
      + `if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(${wakeExit});\n`);
    const ledger = join(dir, "ledger.jsonl");
    const record = completionPath(ledger);
    if (recordIsADirectory) mkdirSync(record);
    const log = join(dir, "gh.log");
    writeFileSync(join(bin, "gh"), ghStub(log, record, ghFails));
    chmodSync(join(bin, "gh"), 0o755);
    const ran = spawnSync(process.execPath, [`--import=${PRELOAD}`, join(src, "work-tick.ts"), `--ledger=${ledger}`], {
      // (#4148) NO GH_CONFIG_DIR: with one the tick's snapshot refresh makes its own (read-only) `gh` probes and writes under that account's config, and this test counts the tick's WRITES.
      encoding: "utf8", cwd: dir, env: { ...process.env, PATH: bin, GH_CONFIG_DIR: "" },
    });
    const calls: Call[] = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    return { ran, calls, record: !recordIsADirectory && existsSync(record) ? readCompletion(record) : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const commentPath = `repos/${TRACKER}/issues/comments/${HEARTBEAT_COMMENT_ID}`;
const variablePath = (repo: string) => `repos/${repo}/actions/variables/${HEARTBEAT_VARIABLE}`;

test("#3880/#3896/#4080: a tick that reaches its end makes EXACTLY the declared writes, of the completion's own `at` -- each tracker's variable, the standing comment after the first's -- each AFTER the completion file exists", () => {
  const { ran, calls, record } = runTick({ gate: "process.exit(0);" });
  assert.equal(ran.status, EXIT.QUIET, ran.stderr);
  assert.ok(record !== null);
  assert.ok(TRACKERS.length >= 1, "the project declares a tracker, or the expectation below is vacuous");
  const expected = TRACKERS.flatMap((repo, index) => [
    ["api", "-X", "PATCH", variablePath(repo), "-f", `value=${record.at}`],
    ...(index === 0 ? [["api", "-X", "PATCH", commentPath, "-f", `body=${heartbeatCommentBody(record.at)}`]] : []),
  ]);
  assert.equal(calls.length, WRITES, JSON.stringify(calls));
  assert.deepEqual(calls.map((call) => call.argv), expected);
  assert.ok(calls.every((call) => call.completionExisted), "the heartbeat is written AFTER the completion file, never before");
});

test("#3880: every exit a COMPLETED tick can have writes it -- the organisation waiting (ATTENTION) is not the gate crashing", () => {
  const attention = runTick({ gate: "process.exit(1);", wakeExit: 1 });
  assert.equal(attention.ran.status, EXIT.ATTENTION, attention.ran.stderr);
  assert.equal(attention.calls.length, WRITES);
  const cannotAsk = runTick({ gate: "process.exit(2);" });
  assert.equal(cannotAsk.ran.status, EXIT.CANNOT_ASK, cannotAsk.ran.stderr);
  assert.equal(cannotAsk.calls.length, WRITES);
});

test("#3880: a tick that ends with CRASH makes NO write -- the gate throwing, and the tick throwing at import", () => {
  const gate = runTick({ gate: GATE_THROWS });
  assert.equal(gate.ran.status, EXIT.CRASH, gate.ran.stderr);
  assert.deepEqual(gate.calls, []);
  const atImport = runTick({ gate: "process.exit(0);", tickSource: (original) => `throw new Error("ENOENT: project.json");\n${original}` });
  assert.equal(atImport.ran.status, EXIT.CRASH, atImport.ran.stderr);
  assert.deepEqual(atImport.calls, []);
});

test("#3880: a write that FAILS leaves the exit code unchanged and says one line on stderr naming the object", () => {
  const { ran, calls, record } = runTick({ gate: "process.exit(0);", ghFails: "all" });
  assert.equal(ran.status, EXIT.QUIET, "the tick did its work");
  assert.equal(calls.length, WRITES, "one attempt at each object, no retry");
  assert.ok(record !== null, "the file is written regardless");
  const lines = ran.stderr.split("\n").filter((line) => line.includes("HEARTBEAT NOT WRITTEN"));
  assert.equal(lines.length, TRACKERS.length, ran.stderr);
  TRACKERS.forEach((repo, index) => {
    assert.ok(lines[index].includes(HEARTBEAT_VARIABLE) && lines[index].includes(repo), lines[index]);
    assert.ok(lines[index].includes("HTTP 403"), "it carries gh's own reason");
  });
});

test("#3896: a comment write that FAILS says HEARTBEAT COMMENT NOT WRITTEN once, leaves the exit unchanged, and the variable write still happened (positive control: a stub failing ONLY the comment call)", () => {
  const { ran, calls, record } = runTick({ gate: "process.exit(0);", ghFails: "comment" });
  assert.equal(ran.status, EXIT.QUIET, "the tick did its work");
  assert.ok(record !== null, "the file is written regardless");
  assert.equal(calls.length, WRITES, "one attempt at each object, no retry and no creating a comment");
  assert.ok(calls[0].argv.includes(variablePath(TRACKER)), "the variable write happened");
  assert.deepEqual(calls.filter((call) => call.argv.some((arg) => arg.startsWith("repos/") && arg.includes("/actions/variables/"))).length, TRACKERS.length,
    "every tracker's variable was still written");
  assert.ok(calls.every((call) => !call.argv.includes("POST")), "a missing comment is never created by the tick");
  const lines = ran.stderr.split("\n").filter((line) => line.includes("HEARTBEAT COMMENT NOT WRITTEN"));
  assert.equal(lines.length, 1, ran.stderr);
  assert.ok(lines[0].includes(String(HEARTBEAT_COMMENT_ID)) && lines[0].includes(TRACKER) && lines[0].includes("HTTP 403"), lines[0]);
  assert.equal(ran.stderr.split("\n").filter((line) => line.includes("HEARTBEAT NOT WRITTEN")).length, 0, "the variable write did not fail, so it says nothing");
});

test("#3896: two consecutive completions carry DIFFERENT bodies, each opening with the marker (an edit that changes nothing does not move `updated_at`, measured)", () => {
  const bodies = [1_000, 1_001].map((at) => heartbeatCommentBody(at));
  assert.notEqual(bodies[0], bodies[1]);
  assert.ok(bodies.every((body) => body.startsWith(`${HEARTBEAT_COMMENT_MARKER}\n`)));
  const host = createFakeCodeHost();
  const standing = fakeRow(host.rowsWorld, 1);
  standing.comments.push({ id: HEARTBEAT_COMMENT_ID, body: "the standing comment", createdAt: new Date(host.rowsWorld.now()).toISOString() });
  host.rowsWorld.rows.set(1, standing);
  substituteCodeHost(host);
  const sent: string[] = [];
  for (const at of [Date.now(), Date.now() + 1]) {
    writeHeartbeat(at, () => [{ repo: TRACKER }]);
    sent.push(standing.comments[0]!.body);
  }
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0], sent[1]);
  assert.ok(sent.every((body) => body.startsWith(`${HEARTBEAT_COMMENT_MARKER}\n`)), "and the standing comment holds what was sent");
});

test("#3880: a completion record that could NOT be written leaves the heartbeat alone -- the off-host reader sees the stale value the file's reader sees", () => {
  const { ran, calls } = runTick({ gate: "process.exit(0);", recordIsADirectory: true });
  assert.equal(ran.status, EXIT.QUIET, "the tick did its work");
  assert.match(ran.stderr, /COMPLETION NOT RECORDED/);
  assert.deepEqual(calls, []);
});

test("#3880: the unit-level `writeHeartbeat` never throws, whatever the code host does", () => {
  const host = createFakeCodeHost();
  host.rowsWorld.failures.set("writeHeartbeatVariable", Object.assign(new Error("boom"), { stderr: "gh: nope" }));
  host.rowsWorld.failures.set("editComment", Object.assign(new Error("boom"), { stderr: "gh: nope" }));
  substituteCodeHost(host);
  const written: string[] = [];
  const realWrite = process.stderr.write;
  process.stderr.write = ((text: string) => { written.push(text); return true; }) as typeof process.stderr.write;
  try {
    assert.doesNotThrow(() => writeHeartbeat(1, () => TRACKERS.map((repo) => ({ repo }))));
  } finally {
    process.stderr.write = realWrite;
  }
  assert.equal(written.length, WRITES, "one line per object, the comment is attempted though the variable failed, and a refusal on one tracker stops no other write");
  assert.match(written[0], new RegExp(`HEARTBEAT NOT WRITTEN to ${TRACKER} variable ${HEARTBEAT_VARIABLE}: gh: nope`));
  assert.match(written[1], new RegExp(`HEARTBEAT COMMENT NOT WRITTEN to ${TRACKER} comment ${HEARTBEAT_COMMENT_ID}: gh: nope`));
  TRACKERS.slice(1).forEach((repo, index) => {
    assert.match(written[2 + index], new RegExp(`HEARTBEAT NOT WRITTEN to ${repo} variable ${HEARTBEAT_VARIABLE}: gh: nope`));
  });
});

test("#3880: a code host the tick cannot reach is a line on stderr like any refused write, never a throw (the heartbeat is the last thing a completed tick does)", () => {
  substituteCodeHost(null);
  const written: string[] = [];
  const realWrite = process.stderr.write;
  process.stderr.write = ((text: string) => { written.push(text); return true; }) as typeof process.stderr.write;
  const saved = process.env.AGENT_ORG_HOST;
  process.env.AGENT_ORG_HOST = "/nonexistent/host.json";
  try {
    assert.doesNotThrow(() => writeHeartbeat(1, () => [{ repo: TRACKER }]));
  } finally {
    process.stderr.write = realWrite;
    if (saved === undefined) delete process.env.AGENT_ORG_HOST; else process.env.AGENT_ORG_HOST = saved;
  }
  assert.equal(written.length, 2, "the variable and the comment each say they were not written");
  assert.match(written[0], /HEARTBEAT NOT WRITTEN to /);
});

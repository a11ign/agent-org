// no-token: gh
//
// Nothing here reaches the network or the real `gh`. The tick under test runs from a temporary `src/` whose `work-gate.mjs` and `wake.mjs` are stubs,
// with the PATH pointed at one directory holding a `gh` STUB that records what it was asked and whether the completion file already existed when it
// was. ERASABLE TYPESCRIPT ONLY: node strips the types itself, so no enum, namespace or parameter property here.

/**
 * a11ign/a11ign#3880: the gate's last COMPLETION is written to one GitHub object (the Actions variable `GATE_LAST_TICK`), so the control plane (#3851)
 * can read it without an ssh into the agents host. The write is the file's sibling and inherits its meaning: a tick that reached the end of `main()`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homeProjectDeclaration } from "../project-config.mjs";
import { EXIT, HEARTBEAT_VARIABLE, writeHeartbeat } from "../work-tick.mjs";
import { completionPath, readCompletion } from "../lib/tick-completion.mjs";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const PRELOAD = join(SRC, "lib", "crash-exit.mjs");
const TRACKER = homeProjectDeclaration().tracker[0].repo;
const GATE_THROWS = 'throw new Error("gate blew up");\n';

type Call = { argv: string[]; completionExisted: boolean };
type Tick = { gate: string; wakeExit?: number; ghFails?: boolean; tickSource?: (original: string) => string };

/** The `gh` stub: a node script (the shebang is the absolute `node`, since the PATH holds only this directory) that logs one JSON line per call. */
function ghStub(log: string, completion: string, fails: boolean) {
  return `#!${process.execPath}\n`
    + `const fs = require("node:fs");\n`
    + `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), completionExisted: fs.existsSync(${JSON.stringify(completion)}) }) + "\\n");\n`
    + (fails ? `process.stderr.write("gh: Resource not accessible (HTTP 403)\\n"); process.exit(1);\n` : "");
}

function runTick({ gate, wakeExit = 0, ghFails = false, tickSource = (original) => original }: Tick) {
  const dir = mkdtempSync(join(tmpdir(), "tick-heartbeat-"));
  try {
    const src = join(dir, "src");
    const bin = join(dir, "bin");
    mkdirSync(src);
    mkdirSync(bin);
    const own = new Set(["work-tick.mjs", "work-gate.mjs", "wake.mjs"]);
    for (const name of readdirSync(SRC).filter((entry) => !own.has(entry))) symlinkSync(join(SRC, name), join(src, name));
    writeFileSync(join(src, "work-tick.mjs"), tickSource(readFileSync(join(SRC, "work-tick.mjs"), "utf8")));
    writeFileSync(join(src, "work-gate.mjs"), gate);
    writeFileSync(join(src, "wake.mjs"),
      `export * from ${JSON.stringify(join(SRC, "wake.mjs"))};\n`
      + `import { fileURLToPath } from "node:url";\n`
      + `if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(${wakeExit});\n`);
    const ledger = join(dir, "ledger.jsonl");
    const record = completionPath(ledger);
    const log = join(dir, "gh.log");
    writeFileSync(join(bin, "gh"), ghStub(log, record, ghFails));
    chmodSync(join(bin, "gh"), 0o755);
    const ran = spawnSync(process.execPath, [`--import=${PRELOAD}`, join(src, "work-tick.mjs"), `--ledger=${ledger}`], {
      encoding: "utf8", cwd: dir, env: { ...process.env, PATH: bin },
    });
    const calls: Call[] = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    return { ran, calls, record: existsSync(record) ? readCompletion(record) : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#3880: a tick that reaches its end makes EXACTLY ONE write, of the completion's own `at`, to the variable, AFTER the completion file exists", () => {
  const { ran, calls, record } = runTick({ gate: "process.exit(0);" });
  assert.equal(ran.status, EXIT.QUIET, ran.stderr);
  assert.ok(record !== null);
  assert.equal(calls.length, 1, JSON.stringify(calls));
  assert.deepEqual(calls[0].argv, ["api", "-X", "PATCH", `repos/${TRACKER}/actions/variables/${HEARTBEAT_VARIABLE}`, "-f", `value=${record.at}`]);
  assert.equal(calls[0].completionExisted, true, "the heartbeat is written AFTER the completion file, never before");
});

test("#3880: every exit a COMPLETED tick can have writes it -- the organisation waiting (ATTENTION) is not the gate crashing", () => {
  const attention = runTick({ gate: "process.exit(1);", wakeExit: 1 });
  assert.equal(attention.ran.status, EXIT.ATTENTION, attention.ran.stderr);
  assert.equal(attention.calls.length, 1);
  const cannotAsk = runTick({ gate: "process.exit(2);" });
  assert.equal(cannotAsk.ran.status, EXIT.CANNOT_ASK, cannotAsk.ran.stderr);
  assert.equal(cannotAsk.calls.length, 1);
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
  const { ran, calls, record } = runTick({ gate: "process.exit(0);", ghFails: true });
  assert.equal(ran.status, EXIT.QUIET, "the tick did its work");
  assert.equal(calls.length, 1, "one attempt, no retry");
  assert.ok(record !== null, "the file is written regardless");
  const lines = ran.stderr.split("\n").filter((line) => line.includes("HEARTBEAT NOT WRITTEN"));
  assert.equal(lines.length, 1, ran.stderr);
  assert.ok(lines[0].includes(HEARTBEAT_VARIABLE) && lines[0].includes(TRACKER), lines[0]);
  assert.ok(lines[0].includes("HTTP 403"), "it carries gh's own reason");
});

test("#3880: the unit-level `writeHeartbeat` never throws, whatever `gh` does", () => {
  const written: string[] = [];
  const realWrite = process.stderr.write;
  process.stderr.write = ((text: string) => { written.push(text); return true; }) as typeof process.stderr.write;
  try {
    assert.doesNotThrow(() => writeHeartbeat(1, () => { throw Object.assign(new Error("boom"), { stderr: Buffer.from("gh: nope") }); }));
  } finally {
    process.stderr.write = realWrite;
  }
  assert.equal(written.length, 1);
  assert.match(written[0], new RegExp(`HEARTBEAT NOT WRITTEN to ${TRACKER} variable ${HEARTBEAT_VARIABLE}: gh: nope`));
});

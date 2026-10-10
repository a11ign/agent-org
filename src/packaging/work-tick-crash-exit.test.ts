// no-token: gh
//
// Nothing here reaches the network or a real `gh`. The tick under test runs from a temporary `src/` whose `work-gate.ts` and `wake.ts`
// are stubs, with the PATH pointed at an empty directory, so no `herdr` is found and no order can reach a session.

/**
 * #3038: A TICK THAT CRASHES EXITS WITH A CODE NOTHING READS AS SUCCESS, AT ALL THREE LAYERS.
 *
 * On 2026-10-02 the work-tick unit ran 63 ticks that each died on `ENOENT: open '.../project.json'` at import time, and each was journalled
 * `Finished`: node exits `1` on any uncaught exception, and `1` is the contract's ATTENTION, which the unit declares a success
 * (`SuccessExitStatus=0 1 2`). The same collision lives in the gate child (`GATE.WORK` is `1`) and in the `ExecStartPre=-` update step.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SHIPPED_DIR, TOOL_UPDATE_EXEC, programCandidates, toolForm } from "../host-units.ts";
import { renderTemplate, templateValues, parseHostConfig } from "../host-config.ts";
import { EXIT, GATE, afterGate } from "../work-tick.ts";
import { linkToolchain } from "./copied-tool-fixture.ts";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const PRELOAD = join(SRC, "lib", "crash-exit.ts");

/** Run a temporary entry module under node, with or without the preload. */
function runEntry(body: string, { preload }: { preload: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "crash-exit-"));
  try {
    const entry = join(dir, "entry.mjs");
    writeFileSync(entry, body);
    return spawnSync(process.execPath, [...(preload ? [`--import=${PRELOAD}`] : []), entry], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#3038 layer 1: an entry that throws at IMPORT exits with the crash code under the preload, and with 1 without it", () => {
  const throwing = 'throw new Error("ENOENT: open /home/agent/.agent-org/project.json");\n';
  const bare = runEntry(throwing, { preload: false });
  assert.equal(bare.status, 1, "POSITIVE CONTROL: this is the collision -- node's own exit for a throw is the contract's ATTENTION");
  const crashed = runEntry(throwing, { preload: true });
  assert.equal(crashed.status, EXIT.CRASH);
  assert.notEqual(EXIT.CRASH, EXIT.ATTENTION);
  assert.match(crashed.stderr, /ENOENT: open .*project\.json/, "the preload replaces node's own report of the throw, so it must write one");
});

test("#3038 layer 1: the preload changes no exit that was not a crash, and catches an unhandled rejection too", () => {
  assert.equal(runEntry("process.exit(1);\n", { preload: true }).status, 1, "a deliberate ATTENTION is still 1");
  assert.equal(runEntry("process.exit(2);\n", { preload: true }).status, 2);
  assert.equal(runEntry("", { preload: true }).status, 0, "a quiet entry is still 0");
  assert.equal(runEntry("await Promise.reject(new Error('late'));\n", { preload: true }).status, EXIT.CRASH);
});

/** The shipped unit as it renders for a host with no `tool`, and as it renders in tool form. */
function renderedUnits() {
  const host = parseHostConfig(JSON.stringify({
    schema: 1, home: "/srv/acme", binDir: "/srv/acme/bin", primary: "widgets",
    projects: [{ id: "widgets", checkout: "/srv/acme/repos/widgets" }],
    gh: { workers: "/srv/acme/workers", leads: "/srv/acme/leads", leadsHeader: ["acme leads"], leadsWorkspaces: [{ id: "w1", role: "lead" }] },
  }), "acme host.json");
  const template = readFileSync(join(SHIPPED_DIR, "work-tick.service.in"), "utf8");
  const shipped = renderTemplate(template, templateValues(host, { prefix: "acme-", boardReportWorkflow: "board.yml", own: [] as string[] }), "work-tick");
  const tool = toolForm("work-tick.service.in", shipped,
    { tool: "/srv/acme/tools/agent-org", checkout: "/srv/acme/repos/widgets", beforeTicks: [] });
  return { shipped, tool };
}

const directive = (unit: string, name: string) => unit.split("\n").filter((line) => line.startsWith(`${name}=`));

test("#3038 layer 1: the crash code is in NEITHER form's SuccessExitStatus, and the contract's 0 1 2 still are", () => {
  const { shipped, tool } = renderedUnits();
  for (const [form, unit] of Object.entries({ shipped, tool })) {
    const [line] = directive(unit, "SuccessExitStatus");
    const codes = line.slice("SuccessExitStatus=".length).split(/\s+/).map(Number);
    assert.deepEqual(codes, [EXIT.QUIET, EXIT.ATTENTION, EXIT.CANNOT_ASK], `${form}: the ATTENTION contract is unchanged`);
    assert.ok(!codes.includes(EXIT.CRASH), `${form}: a crash must end the unit failed`);
  }
});

test("#3038 layers 1 and 3: the tick and the update step both run under the preload, in both forms, and the update's `-` stays", () => {
  const { shipped, tool } = renderedUnits();
  assert.deepEqual(directive(shipped, "ExecStart"),
    ["ExecStart=%h/.local/bin/node --import=./packages/agent-org/src/lib/crash-exit.ts packages/agent-org/src/work-tick.ts"]);
  assert.deepEqual(directive(tool, "ExecStart"), ["ExecStart=%h/.local/bin/node --import=./src/lib/crash-exit.ts src/work-tick.ts"]);
  assert.deepEqual(directive(tool, "ExecStartPre")[0], `ExecStartPre=-${TOOL_UPDATE_EXEC}`,
    "the `-` stays: a failed update is still not a reason to stop the org");
  assert.match(TOOL_UPDATE_EXEC, /--import=\.\/src\/lib\/crash-exit\.ts src\/update-tool\.ts$/);
  assert.match(shipped, /^# `1` HERE IS THE CONTRACT'S ATTENTION AND NOT node's CRASH/m, "the template's header says which `1` this is");
});

test("#3038: a unit's script is still found behind node's own leading options, and `bash -c` is still read as nothing", () => {
  const found = programCandidates("/usr/bin/node --import=./src/lib/crash-exit.ts src/work-tick.ts", { repoRoot: "/r", scripts: {} });
  assert.deepEqual(found, ["/r/src/work-tick.ts"], "without this the unit leaves `unitsSpendingGh`'s population, silently");
  assert.deepEqual(programCandidates("/usr/bin/bash -c 'echo hi'", { repoRoot: "/r", scripts: {} }), []);
  assert.deepEqual(programCandidates("/usr/bin/node src/update-tool.ts", { repoRoot: "/r", scripts: {} }), ["/r/src/update-tool.ts"]);
});

/**
 * A tool checkout of one file's worth: the real `work-tick.ts` COPIED (it finds its children beside itself, so a symlink would find the real
 * ones), every other entry of `src/` linked, and `work-gate.ts` and `wake.ts` written as stubs. `wake.ts` re-exports the real module so
 * `work-tick.ts`'s imports resolve, and leaves a marker file when it RUNS as the child (not when the tick merely imports it).
 */
function tickWith({ gate, wake }: { gate: string; wake: string }) {
  const dir = mkdtempSync(join(tmpdir(), "tick-crash-"));
  try {
    const src = join(dir, "src");
    mkdirSync(src);
    writeFileSync(join(src, "package.json"), '{"type":"module"}'); // tsx reads a loose .ts as CommonJS without it, and a .mjs it reaches then fails on its top-level await
    const own = new Set(["work-tick.ts", "work-gate.ts", "wake.ts"]);
    for (const name of readdirSync(SRC).filter((entry) => !own.has(entry))) symlinkSync(join(SRC, name), join(src, name));
    linkToolchain(dir); // the tick imports `@a11ign/toolchain/lib/*` (a11ign/agent-org#522): the one dependency a staged tick tree holds
    copyFileSync(join(SRC, "work-tick.ts"), join(src, "work-tick.ts"));
    writeFileSync(join(src, "work-gate.ts"), gate);
    const marker = join(dir, "wake-ran");
    writeFileSync(join(src, "wake.ts"),
      `export * from ${JSON.stringify(join(SRC, "wake.ts"))};\n`
      + `import { writeFileSync } from "node:fs";\nimport { fileURLToPath } from "node:url";\n`
      + `if (process.argv[1] === fileURLToPath(import.meta.url)) {\n  writeFileSync(${JSON.stringify(marker)}, "ran");\n  ${wake}\n}\n`);
    mkdirSync(join(dir, "empty"));
    // `--ledger=<path>` (the `=` form is the only one `flagValue` reads) puts the handoff queue beside it, so a real queued order cannot make a quiet tick deliver.
    const ran = spawnSync(process.execPath, [join(src, "work-tick.ts"), `--ledger=${join(dir, "ledger.jsonl")}`], {
      encoding: "utf8", cwd: dir, env: { ...process.env, PATH: join(dir, "empty"), GH_CONFIG_DIR: "" }, // (#4148) none: a tick given an account directory probes GitHub and writes a read-cache under it; these tests must do neither

    });
    return { ran, wakeRan: existsSync(marker) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GATE_THROWS = 'throw new Error("ENOENT: open /home/agent/.agent-org/project.json");\n';

test("#3038 layer 2: a work-gate that crashes ends the tick with the crash code, names the gate, and does NOT take the GATE.WORK branch", () => {
  const { ran, wakeRan } = tickWith({ gate: GATE_THROWS, wake: "process.exit(0);" });
  assert.equal(ran.status, EXIT.CRASH, ran.stderr);
  assert.match(ran.stderr, /work-gate CRASHED/);
  assert.match(ran.stderr, /ENOENT: open .*project\.json/, "the gate's own stack reaches the journal");
  assert.equal(wakeRan, false, "wake was NOT handed an empty stdin as though the gate had found work");
});

test("#3038 layer 2 (positive controls): a gate that found work reaches wake, and a tick whose orders had nowhere to go is still 1", () => {
  const { ran, wakeRan } = tickWith({ gate: "process.exit(1);", wake: "process.exit(1);" });
  assert.equal(wakeRan, true, "POSITIVE CONTROL: the WORK branch is still taken for a gate that really exited 1, so the test above can tell the two apart");
  assert.equal(ran.status, EXIT.ATTENTION, "the ATTENTION contract is unchanged, and is still a success to the unit");
});

test("#3038 (positive control): a quiet tick still exits 0 and wakes nobody", () => {
  const { ran, wakeRan } = tickWith({ gate: "process.exit(0);", wake: "process.exit(0);" });
  assert.equal(ran.status, EXIT.QUIET, ran.stderr);
  assert.equal(wakeRan, false, ran.stderr);
  // #3443: the FIRST line of a tick names the agent-org version that made its decisions, so a journal read says which. This child has no `git` on its PATH,
  // so the line it can print is the "unreadable" one -- which is the proof that a version that cannot be read is SAID and does not stop the tick.
  assert.match(ran.stdout.split("\n")[0], /^agent-org (v\d+\.\d+\.\d+|\(at no release tag: \w+\)|\(version unreadable: .+\))$/, ran.stdout);
});

test("#3038: a wake that crashes ends the tick with the crash code and says it was wake", () => {
  const { ran } = tickWith({ gate: "process.exit(1);", wake: 'throw new Error("wake blew up");' });
  assert.equal(ran.status, EXIT.CRASH, ran.stderr);
  assert.match(ran.stderr, /wake CRASHED/);
});

test("#3038: `afterGate` reads the crash code before the WORK branch, and every other code as it did", () => {
  assert.deepEqual(afterGate(EXIT.CRASH).deliver, false);
  assert.equal(afterGate(EXIT.CRASH).exit, EXIT.CRASH);
  assert.equal(afterGate(GATE.WORK).deliver, true);
  assert.equal(afterGate(GATE.QUIET).exit, EXIT.QUIET);
  assert.equal(afterGate(GATE.CANNOT_ASK).exit, EXIT.CANNOT_ASK);
  assert.equal(afterGate(GATE.PARTIAL).deliver, true);
});

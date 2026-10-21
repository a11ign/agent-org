// no-token: none -- git runs in a remote this file builds; the services, `systemctl` and the dependency install are stand-ins (`update-fixture.ts`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { update } from "./update.ts";
import { toolEntryOf, toolVersionAt, versionNameOf } from "./tool-versions.ts";
import { currentVersionName, withUpdateLock } from "./tool-install.ts";
import { unitFor } from "./service.ts";
import { updateFixture } from "./update-fixture.ts";

/** An install at v0.1.0 in version folders, with the process running from it, and v0.2.0 cut since. */
function installedAtFirst(options: Parameters<typeof updateFixture>[0] = {}) {
  const f = updateFixture(options);
  f.release("0.1.0");
  assert.equal(update({ version: undefined, channel: "release" }, f.deps()), true);
  f.runFromVersion("v0.1.0");
  f.said.length = 0;
  f.restarted.length = 0;
  f.calls.length = 0;
  f.release("0.2.0");
  return f;
}

test("an update builds versions/<tag>, swaps current, and restarts the instance and the ui but never herdr, the terminal or the updater", () => {
  const f = installedAtFirst({ states: { herdr: "running", instance: "running", ui: "running", terminal: "running", "auto-update": "running" } });
  assert.equal(currentVersionName(f.tool), "v0.1.0");
  assert.equal(update({ version: undefined, channel: "release" }, f.deps()), true);
  assert.equal(currentVersionName(f.tool), "v0.2.0");
  assert.equal(lstatSync(join(f.tool, "current")).isSymbolicLink(), true);
  assert.equal(readFileSync(join(f.tool, "versions", "v0.2.0", "src", "bin.ts"), "utf8"), "// agent-org 0.2.0\n");
  assert.equal(existsSync(join(f.tool, "versions", "v0.2.0", "node_modules")), true, "the release's dependencies are installed in its own folder");
  assert.equal(existsSync(join(f.tool, "versions", "v0.2.0.partial")), false, "no half folder is left beside it");
  assert.deepEqual(f.restarted, ["instance", "ui"]);
  assert.equal(f.calls.some((call) => call.includes("herdr")), false, "no systemctl call names herdr");
  assert.equal(f.statuses.at(-1)?.installed, "v0.2.0");
});

test("an update leaves the folder of the version a live run started on, and removes one no run names", () => {
  const f = installedAtFirst({ states: { instance: "running" } });
  const old = join(f.tool, "versions", "v0.1.0");
  f.state.inUse = [old];
  update({ version: undefined, channel: "release" }, f.deps());
  f.runFromVersion("v0.2.0");
  assert.equal(existsSync(old), true, "a run that started on v0.1.0 still has its hooks and commands there");
  f.said.length = 0;
  f.state.inUse = [];
  update({ version: undefined, channel: "release" }, f.deps());
  assert.equal(existsSync(old), false, "no live or parked run names it any more");
  assert.equal(existsSync(join(f.tool, "versions", "v0.2.0")), true, "current is never pruned");
  assert.match(f.said.join("\n"), /removed v0\.1\.0, which no run uses/);
});

test("the folder of the process that prunes is kept, and nothing is pruned when the queue cannot be read", () => {
  const f = installedAtFirst({ states: { instance: "running" } });
  const old = join(f.tool, "versions", "v0.1.0");
  f.state.inUse = [];
  update({ version: undefined, channel: "release" }, f.deps());
  assert.equal(existsSync(old), true, "this process runs from v0.1.0, so the folder it is running from stays");
  f.runFromVersion("v0.2.0");
  f.state.inUse = null;
  update({ version: undefined, channel: "release" }, f.deps());
  assert.equal(existsSync(old), true, "a queue that cannot be read says nothing about what is in use");
});

test("a failed build leaves current and the services untouched, and no drain record", () => {
  const f = installedAtFirst({ states: { instance: "running", ui: "running" } });
  f.state.failBuild = true;
  assert.throws(() => update({ version: undefined, channel: "release" }, f.deps()), /agent-org stays at v0\.1\.0, not moved to v0\.2\.0, because building it failed: pnpm could not reach the registry/);
  assert.equal(currentVersionName(f.tool), "v0.1.0");
  assert.deepEqual(f.restarted, []);
  assert.equal(existsSync(f.drainFile), false);
});

test("a build killed half way leaves no folder that looks built, and the next update builds it whole", () => {
  const f = installedAtFirst({ states: { instance: "running" } });
  const partial = join(f.tool, "versions", "v0.2.0.partial");
  mkdirSync(join(partial, "src"), { recursive: true });
  writeFileSync(join(partial, "src", "bin.ts"), "// half\n");
  assert.equal(update({ version: undefined, channel: "release" }, f.deps()), true);
  assert.equal(readFileSync(join(f.tool, "versions", "v0.2.0", "src", "bin.ts"), "utf8"), "// agent-org 0.2.0\n");
  assert.equal(existsSync(partial), false);
});

test("the first update from a checkout builds the first folder and rewrites the units, the launcher and the host file's tool once", () => {
  const f = updateFixture({ states: { instance: "running", ui: "running", "auto-update": "running" } });
  f.release("0.1.0");
  mkdirSync(f.checkout, { recursive: true });
  const registered = ["instance", "ui", "auto-update", "herdr"] as const;
  for (const name of registered) {
    const unit = unitFor(name, { ...f.services, toolRoot: f.checkout });
    f.files.set(unit.path, unit.text);
    if (unit.companion !== null) f.files.set(unit.companion.path, unit.companion.text);
  }
  const launcher = join(f.binDir, "agent-org");
  mkdirSync(f.binDir, { recursive: true });
  writeFileSync(launcher, `#!/bin/sh\nexec node '${f.checkout}/src/bin.ts' "$@"\n`, { mode: 0o755 });
  writeFileSync(f.hostPath, `${JSON.stringify({ clones: {}, tool: f.checkout }, null, 2)}\n`);
  f.files.set(f.hostPath, readFileSync(f.hostPath, "utf8"));
  f.calls.length = 0;

  assert.equal(update({ version: undefined, channel: "release" }, f.deps()), true);

  const entry = join(f.tool, "current");
  assert.equal(currentVersionName(f.tool), "v0.1.0");
  for (const name of ["instance", "ui"] as const) {
    const unit = unitFor(name, { ...f.services, toolRoot: entry });
    assert.equal(f.files.get(unit.path), unit.text, `${name}'s unit runs through current`);
    assert.ok((f.files.get(unit.path) ?? "").includes(`"${entry}/src/bin.ts"`));
  }
  assert.ok((f.files.get(unitFor("auto-update", { ...f.services, toolRoot: entry }).companion?.path ?? "") ?? "").includes(`"${entry}/src/bin.ts"`), "the updater runs through current too");
  assert.equal(readFileSync(launcher, "utf8"), `#!/bin/sh\nexec node '${entry}/src/bin.ts' "$@"\n`);
  assert.equal(JSON.parse(readFileSync(f.hostPath, "utf8")).tool, entry);
  assert.equal(f.calls.filter((call) => call === "systemctl --user daemon-reload").length, 1, "systemd reads the new units once");
  assert.deepEqual(f.restarted, ["instance", "ui"]);
  assert.equal(existsSync(join(f.checkout)), true, "the old checkout is left where it is");

  // The old checkout's own timer firing again, before the timer was re-armed: nothing is rewritten and nothing restarts.
  f.calls.length = 0;
  f.restarted.length = 0;
  assert.equal(update({ version: undefined, channel: "release" }, f.deps()), false);
  assert.deepEqual([f.calls, f.restarted], [[], []]);
});

test("node started through current has TOOL_ROOT = the version folder, and a unit and the hook path name the folder, not the link", () => {
  const f = installedAtFirst();
  update({ version: undefined, channel: "release" }, f.deps());
  // The real expression, pinned: the probe below is its replica, because the real module's imports are the whole tool.
  const real = readFileSync(fileURLToPath(new URL("./paths.ts", import.meta.url)), "utf8");
  const expression = "export const TOOL_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));";
  assert.ok(real.includes(expression), "paths.ts still derives TOOL_ROOT from its own real path");
  const folder = join(f.tool, "versions", "v0.2.0");
  mkdirSync(join(folder, "src", "install"), { recursive: true });
  writeFileSync(join(folder, "src", "install", "paths.ts"), `import { dirname } from "node:path";\nimport { fileURLToPath } from "node:url";\n${expression}\n`);
  writeFileSync(join(folder, "src", "probe.ts"), `import { TOOL_ROOT } from "./install/paths.ts";\nprocess.stdout.write(TOOL_ROOT);\n`);
  const ran = spawnSync(process.execPath, [join(f.tool, "current", "src", "probe.ts")], { encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout, realpathSync(folder));
  assert.equal(versionNameOf(ran.stdout), "v0.2.0");
  assert.equal(toolVersionAt(ran.stdout), "v0.2.0");
  assert.equal(toolEntryOf(ran.stdout), join(f.tool, "current"), "a unit written by a process running from a version folder names the link");
  assert.equal(readlinkSync(join(f.tool, "current")), join("versions", "v0.2.0"));
});

test("a checkout's version is its package's, and a main build is main-<sha>", () => {
  const f = updateFixture({ states: { instance: "running" } });
  f.release("0.1.0");
  f.onMain("one more commit");
  update({ version: undefined, channel: "main" }, f.deps());
  assert.equal(currentVersionName(f.tool), f.mainName());
  assert.match(currentVersionName(f.tool) ?? "", /^main-[0-9a-f]{8}$/);
  assert.equal(toolVersionAt(f.work), "v0.1.0", "a checkout is named by its package.json's version");
});

test("two updates never run at once: the lock refuses a live holder by name, and a holder that is gone is taken over", () => {
  const f = updateFixture();
  const lock = join(f.tool, "update.lock");
  mkdirSync(f.tool, { recursive: true });
  const ran: string[] = [];
  withUpdateLock(f.tool, () => {
    ran.push("first");
    assert.throws(() => withUpdateLock(f.tool, () => ran.push("second"), () => true), /another agent-org update is running \(pid \d+\)/);
  });
  assert.deepEqual(ran, ["first"]);
  assert.equal(existsSync(lock), false, "released when the work ends");
  writeFileSync(lock, "999999\n");
  withUpdateLock(f.tool, () => ran.push("taken over"), () => false);
  assert.deepEqual(ran, ["first", "taken over"]);
  assert.throws(() => withUpdateLock(f.tool, () => { throw new Error("work failed"); }), /work failed/);
  assert.equal(existsSync(lock), false, "released when the work throws");
});

test("the migration registers herdr's unit, written and not started, so an instance that finds no server starts the unit and never spawns one", () => {
  const f = updateFixture({ states: { instance: "running" } });
  f.release("0.1.0");
  assert.equal(f.files.has(unitFor("herdr", f.services).path), false);
  update({ version: undefined, channel: "release" }, f.deps());
  assert.equal(f.files.has(unitFor("herdr", f.services).path), true);
  assert.equal(f.calls.some((call) => call.includes("start") && call.includes("herdr")), false, "written, never started or restarted by an update");
});

test("an org host (one that declares a primary project) keeps its tool and its launcher: they name the git checkout update-tool moves", () => {
  const f = updateFixture({ states: { instance: "running" } });
  f.release("0.1.0");
  mkdirSync(f.checkout, { recursive: true });
  mkdirSync(f.binDir, { recursive: true });
  const launcher = join(f.binDir, "agent-org");
  writeFileSync(launcher, `#!/bin/sh\nexec node "${f.checkout}/src/bin.ts" "$@"\n`, { mode: 0o755 });
  writeFileSync(f.hostPath, `${JSON.stringify({ primary: "p", tool: f.checkout })}\n`);
  update({ version: undefined, channel: "release" }, f.deps());
  assert.equal(JSON.parse(readFileSync(f.hostPath, "utf8")).tool, f.checkout);
  assert.ok(readFileSync(launcher, "utf8").includes(f.checkout));
});

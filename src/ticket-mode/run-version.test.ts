// no-token: gh -- herdr, git, the tracker and the clock are all injected; the only process spawned is `node`, to read the path a script runs from
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { poolFixture } from "./pool-fixture.ts";
import { pluginCopiesOf } from "./pool-pin.ts";
import { herdrName, ticketDir, ticketFolder } from "./pool.ts";
import { approve } from "./queue/queue-transitions.ts";
import { runVersions, toolRootsInUse } from "./queue/queue-pins.ts";
import { reasonOf, updateLines } from "./board-view/run-reason.ts";

/** A tool directory with two version folders and a `current` link to the first, each holding a `src/bin.ts` that prints the path node runs it from. */
function toolWithVersions() {
  const tool = join(tmpDir("ticket-tool-"), "tool");
  for (const version of ["v0.273.0", "v0.280.0"]) {
    mkdirSync(join(tool, "versions", version, "src"), { recursive: true });
    writeFileSync(join(tool, "versions", version, "src", "bin.ts"), "console.log(import.meta.filename);\n");
  }
  const point = (version: string) => {
    rmSync(join(tool, "current"), { force: true });
    symlinkSync(join("versions", version), join(tool, "current"));
  };
  point("v0.273.0");
  /** The path a process started through `current` runs `src/bin.ts` from, which is the `hook.bin` an instance started through the launcher gets (`server.ts`). */
  const binNow = () => execFileSync(process.execPath, [join(tool, "current", "src", "bin.ts")], { encoding: "utf8" }).trim();
  return { tool, point, binNow };
}

const hookOf = (bin: string) => ({ node: "/node", bin });
/** The run `key`'s worker goes idle with `outcome` written, and the pool reads it. */
async function endRun(made: ReturnType<typeof poolFixture>, key: string, outcome: Record<string, unknown>) {
  made.status.set(herdrName(key), "idle");
  writeFileSync(join(ticketDir(made.settings, key), "outcome.json"), JSON.stringify(outcome));
  await made.pool.tick();
}

const DRAFT = { kind: "draft-pr", prs: [{ repo: "a/b", url: "https://github.com/a/b/pull/1" }] };
const ASKED = { kind: "needs-human", reason: "which repo?" };

/** A pool restarted onto `bin`, where the person asks to talk to NBF-1 and the pass starts the session. */
async function talkAfterRestart(made: ReturnType<typeof poolFixture>, bin: string) {
  const after = made.restart({ hook: hookOf(bin) });
  after.talk("NBF-1");
  await after.tick();
}

const settingsOf = (root: string, settings: Parameters<typeof ticketFolder>[0], key: string) => readFileSync(join(ticketFolder(settings, key), ".claude", "settings.local.json"), "utf8");

test("A11-169: node run through `current` runs the version folder, so a hook written from it names that folder", () => {
  const { tool, point, binNow } = toolWithVersions();
  assert.equal(binNow(), realpathSync(join(tool, "versions", "v0.273.0", "src", "bin.ts")));
  point("v0.280.0");
  assert.equal(binNow(), realpathSync(join(tool, "versions", "v0.280.0", "src", "bin.ts")), "the link moved, and so did the path a new process runs from");
});

test("A11-169: a start writes hooks and brief commands naming its version folder, and records the folder and the version", async () => {
  const { binNow } = toolWithVersions();
  const bin = binNow();
  const made = poolFixture({ hook: hookOf(bin) });
  await made.pool.tick();
  const root = dirname(dirname(bin));
  assert.equal(made.entry("NBF-1").toolRoot, root);
  assert.equal(made.entry("NBF-1").toolVersion, "v0.273.0");
  assert.ok(settingsOf(made.root, made.settings, "NBF-1").includes(`${root}/src/bin.ts`), "the Stop hook runs the version folder's bin.ts");
  assert.ok(readFileSync(join(ticketDir(made.settings, "NBF-1"), "brief.md"), "utf8").includes(`${root}/src/bin.ts ticket:worktree`), "the brief's commands name it too");
});

test("A11-169: after `current` moves, a new round names the new folder and records its version, and a run left running keeps the old one", async () => {
  const { point, binNow } = toolWithVersions();
  const old = binNow();
  const made = poolFixture({ keys: ["NBF-1", "NBF-2"], hook: hookOf(old) });
  await made.pool.tick();
  // NBF-1 ends with a draft pull request and is approved, so its round is queued; NBF-2 keeps running.
  await endRun(made, "NBF-1", DRAFT);
  made.store.set(approve(made.store.get(), "NBF-1", 200));
  const runningSettings = settingsOf(made.root, made.settings, "NBF-2");
  point("v0.280.0");
  const next = binNow();
  const after = made.restart({ hook: hookOf(next) });
  after.reconcile();
  await after.tick();
  assert.equal(made.entry("NBF-1").toolRoot, dirname(dirname(next)), "the new round is on the new version");
  assert.equal(made.entry("NBF-1").toolVersion, "v0.280.0");
  assert.ok(settingsOf(made.root, made.settings, "NBF-1").includes(`${dirname(dirname(next))}/src/bin.ts`));
  assert.equal(made.entry("NBF-2").toolVersion, "v0.273.0", "a run the new instance re-adopted keeps the version it started on");
  assert.equal(settingsOf(made.root, made.settings, "NBF-2"), runningSettings, "and its settings are not rewritten");
});

test("A11-169: an answered park resumes on the settings and the version it had", async () => {
  const { point, binNow } = toolWithVersions();
  const made = poolFixture({ hook: hookOf(binNow()) });
  await made.pool.tick();
  await endRun(made, "NBF-1", ASKED);
  assert.ok(made.entry("NBF-1").workspace !== undefined, "the run is parked with its workspace open");
  const before = settingsOf(made.root, made.settings, "NBF-1");
  point("v0.280.0");
  const after = made.restart({ hook: hookOf(binNow()) });
  made.status.set("t-nbf-1", "working");
  await after.tick();
  assert.equal(made.entry("NBF-1").phase, "running", "the person's answer put the run back to work");
  assert.equal(made.entry("NBF-1").toolVersion, "v0.273.0");
  assert.equal(settingsOf(made.root, made.settings, "NBF-1"), before);
});

test("A11-169: a version folder stays in use while a run holds a workspace, parked ones included, and is free once none does", async () => {
  const { binNow } = toolWithVersions();
  const made = poolFixture({ keys: ["NBF-1", "NBF-2"], hook: hookOf(binNow()) });
  await made.pool.tick();
  const root = dirname(dirname(binNow()));
  assert.deepEqual(toolRootsInUse(made.store.get()), [root]);
  await endRun(made, "NBF-2", ASKED);
  assert.deepEqual(toolRootsInUse(made.store.get()), [root], "a parked run still names it");
  assert.deepEqual(runVersions(made.store.get()).map((run) => [run.key, run.toolVersion]), [["NBF-1", "v0.273.0"], ["NBF-2", "v0.273.0"]]);
  made.pool.stop("NBF-1");
  made.pool.close("NBF-2");
  assert.deepEqual(toolRootsInUse(made.store.get()), [], "nothing holds a workspace");
});

/** NBF-1 finished with a draft pull request and a saved session, under the pool whose hook is `old`. */
async function finishedWithSession(old: string) {
  const made = poolFixture({ hook: hookOf(old) });
  await made.pool.tick();
  await endRun(made, "NBF-1", DRAFT);
  const session = join(made.root, "transcripts", "p");
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, "session-t-nbf-1.jsonl"), "{}\n");
  return made;
}

test("A11-169: a talk session whose version folder was pruned gets hooks naming this instance's folder", async () => {
  const { tool, point, binNow } = toolWithVersions();
  const made = await finishedWithSession(binNow());
  assert.ok(settingsOf(made.root, made.settings, "NBF-1").includes("v0.273.0"));
  point("v0.280.0");
  rmSync(join(tool, "versions", "v0.273.0"), { recursive: true });
  const newer = binNow();
  await talkAfterRestart(made, newer);
  assert.equal(made.entry("NBF-1").toolRoot, dirname(dirname(newer)), "the pin moved with the rewritten hooks");
  assert.ok(settingsOf(made.root, made.settings, "NBF-1").includes(`${dirname(dirname(newer))}/src/bin.ts`));
  assert.ok(!settingsOf(made.root, made.settings, "NBF-1").includes("v0.273.0"));
});

test("A11-169: a talk session whose version folder is still there keeps the version it had", async () => {
  const { point, binNow } = toolWithVersions();
  const made = await finishedWithSession(binNow());
  const before = settingsOf(made.root, made.settings, "NBF-1");
  point("v0.280.0");
  await talkAfterRestart(made, binNow());
  assert.equal(made.entry("NBF-1").phase, "running", "the talk session started");
  assert.equal(made.entry("NBF-1").toolVersion, "v0.273.0");
  assert.equal(settingsOf(made.root, made.settings, "NBF-1"), before);
});

test("A11-169: a start records the conventions plugin's install path and commit, and none when the record cannot be read", async () => {
  const dir = tmpDir("ticket-plugin-");
  const install = join(dir, "cache", "a11ign", "0.1.0");
  mkdirSync(install, { recursive: true });
  const record = join(dir, "installed_plugins.json");
  writeFileSync(record, JSON.stringify({ version: 2, plugins: { "a11ign@m": [{ scope: "user", installPath: install, gitCommitSha: "abc123" }] } }));
  assert.deepEqual(pluginCopiesOf(["a11ign@m"], "/work/t", record), [{ plugin: "a11ign@m", path: install, commit: "abc123" }]);
  assert.deepEqual(pluginCopiesOf(["a11ign@m"], "/work/t", join(dir, "missing.json")), []);
  const made = poolFixture({ tickets: { plugins: ["a11ign@m"] }, pluginRecord: record });
  await made.pool.tick();
  assert.deepEqual(made.entry("NBF-1").pluginCopy, [{ plugin: "a11ign@m", path: install, commit: "abc123" }]);
});

test("A11-169: a run shows its version only when it is not the instance's", () => {
  const run = { ticket: { key: "NBF-1" }, phase: "running", workspace: "w1", toolVersion: "v0.273.0" };
  assert.deepEqual(updateLines(run, { note: null, instanceVersion: "v0.280.0" }), ["on v0.273 (instance v0.280)"]);
  assert.deepEqual(updateLines(run, { note: null, instanceVersion: "v0.273.0" }), [], "a run on the instance's version says nothing extra");
  assert.deepEqual(updateLines(run, undefined), []);
  assert.deepEqual(updateLines({ ...run, toolVersion: "v0.273.1" }, { note: null, instanceVersion: "v0.273.2" }), ["on v0.273.1 (instance v0.273.2)"], "versions that differ only by patch are told apart");
  assert.deepEqual(updateLines({ ...run, phase: "finished", workspace: undefined }, { note: null, instanceVersion: "v0.280.0" }), [], "a finished run holds no copy");
  assert.deepEqual(reasonOf(run), { line: null, question: null });
});

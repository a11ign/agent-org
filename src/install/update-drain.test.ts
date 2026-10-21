// no-token: none -- git runs in a remote this file builds; the services, `systemctl` and the dependency install are stand-ins (`update-fixture.ts`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pinnedVersion, update, UpdateRefusal } from "./update.ts";
import { breakingLines } from "./breaking-release.ts";
import { currentVersionName } from "./tool-install.ts";
import { readDrain, writeDrain } from "./update-drain.ts";
import { HOUR, NOW, updateFixture } from "./update-fixture.ts";

const CHANGELOG = [
  "# agent-org", "",
  "## 0.3.0", "", "### Minor Changes", "", "- 3333333: a new flag", "",
  "## 0.2.0", "", "### Minor Changes", "", "- 2222222: Breaking: the instance's queue file moves; a run started before it cannot be resumed",
  "  and the second line of that entry", "- 2222223: another change", "",
  "## 0.1.0", "", "### Minor Changes", "", "- 1111111: Breaking: this one is already installed", "",
].join("\n");

test("a Breaking line anywhere in the range after the installed release makes the move breaking, and the installed release's own does not", () => {
  const found = breakingLines(CHANGELOG, "v0.1.0", "v0.3.0");
  assert.deepEqual(found.map(({ release }) => release), ["v0.2.0"], "0.2.0 is in (0.1.0, 0.3.0]; 0.1.0's own line is behind the install");
  assert.match(found[0].summary, /^Breaking: the instance's queue file moves/);
  assert.deepEqual(breakingLines(CHANGELOG, "v0.2.0", "v0.3.0"), [], "after the breaking release, the move is not");
  assert.deepEqual(breakingLines(CHANGELOG, "v0.1.0", "v0.1.0"), [], "a move to the installed release is no move");
  assert.deepEqual(breakingLines(CHANGELOG, null, "v0.2.0").map(({ release }) => release), ["v0.2.0"], "an install at no release reads only the target's own section");
  assert.deepEqual(breakingLines(CHANGELOG, null, "v0.3.0"), []);
});

test("only a summary whose first line starts Breaking: counts, with or without the commit hash, and a bump level does not", () => {
  const entry = (line: string) => `## 0.4.0\n\n### Major Changes\n\n${line}\n`;
  assert.equal(breakingLines(entry("- abcdef1: Breaking: x"), "v0.3.0", "v0.4.0").length, 1);
  assert.equal(breakingLines(entry("- Breaking: x"), "v0.3.0", "v0.4.0").length, 1, "an entry written by hand has no hash");
  assert.equal(breakingLines(entry("- abcdef1: This is not Breaking: at the start"), "v0.3.0", "v0.4.0").length, 0);
  assert.equal(breakingLines(entry("- abcdef1: breaking: lower case"), "v0.3.0", "v0.4.0").length, 0, "the marker is exact");
  assert.equal(breakingLines(entry("- abcdef1: a major bump with no marker"), "v0.3.0", "v0.4.0").length, 0, "a `Major Changes` heading is not the marker");
});

/** An install at v0.1.0 in version folders with `live` runs live, and the releases after it cut: the second is breaking when `breaking`. */
function installed(breaking: boolean, live: number) {
  const f = updateFixture({ states: { instance: "running", ui: "running" }, live: 0 });
  f.release("0.1.0");
  update({ version: undefined, channel: "release" }, f.deps());
  f.runFromVersion("v0.1.0");
  f.release("0.2.0", breaking ? "Breaking: the queue file moves" : "a fix");
  f.said.length = 0;
  f.restarted.length = 0;
  f.state.live = live;
  return f;
}

test("with no Breaking line, an update applies whatever is live: it swaps, restarts the instance and the ui, and writes no record", () => {
  const f = installed(false, 3);
  assert.equal(update({ version: undefined, channel: "release" }, f.deps()), true);
  assert.equal(currentVersionName(f.tool), "v0.2.0");
  assert.deepEqual(f.restarted, ["instance", "ui"]);
  assert.equal(existsSync(f.drainFile), false);
});

test("a breaking release with runs live builds its folder, writes the drain record, and swaps and restarts nothing", () => {
  const f = installed(true, 2);
  assert.equal(update({ version: undefined, channel: "release" }, f.deps()), false);
  assert.equal(currentVersionName(f.tool), "v0.1.0", "current has not moved");
  assert.deepEqual(f.restarted, []);
  assert.equal(existsSync(join(f.tool, "versions", "v0.2.0", "src", "bin.ts")), true, "the folder is built now, so the swap later is instant");
  const drain = readDrain(f.drainFile);
  assert.equal(drain.kind, "draining");
  if (drain.kind !== "draining") return;
  assert.deepEqual(drain.record, { target: "v0.2.0", since: new Date(NOW).toISOString(), deadline: new Date(NOW + 2 * HOUR).toISOString(), stopped: [] },
    "the deadline is tickets.updateMaxDeferHours after the drain began");
  assert.match(f.said.join("\n"), /v0\.2\.0 is breaking \(v0\.2\.0: Breaking: the queue file moves\)\. 2 runs are live, so it is built and waits/);
});

test("the next ten-minute update keeps the drain's start, so the live runs do not get a fresh wait", () => {
  const f = installed(true, 2);
  update({ version: undefined, channel: "release" }, f.deps());
  f.state.now = NOW + 10 * 60e3;
  update({ version: undefined, channel: "release" }, f.deps());
  const drain = readDrain(f.drainFile);
  assert.equal(drain.kind === "draining" ? drain.record.since : null, new Date(NOW).toISOString());
  assert.equal(drain.kind === "draining" ? drain.record.deadline : null, new Date(NOW + 2 * HOUR).toISOString());
});

test("a newer release that supersedes the one being waited for takes over the drain without moving its start", () => {
  const f = installed(true, 1);
  update({ version: undefined, channel: "release" }, f.deps());
  f.state.now = NOW + HOUR;
  f.release("0.3.0");
  update({ version: undefined, channel: "release" }, f.deps());
  const drain = readDrain(f.drainFile);
  assert.deepEqual(drain.kind === "draining" ? [drain.record.target, drain.record.since] : null, ["v0.3.0", new Date(NOW).toISOString()]);
});

test("with no live run left, a breaking release swaps, restarts the instance and the ui, and clears the record", () => {
  const f = installed(true, 2);
  update({ version: undefined, channel: "release" }, f.deps());
  assert.equal(existsSync(f.drainFile), true);
  f.state.live = 0;
  f.restarted.length = 0;
  assert.equal(update({ version: undefined, channel: "release" }, f.deps()), true);
  assert.equal(currentVersionName(f.tool), "v0.2.0");
  assert.deepEqual(f.restarted, ["instance", "ui"]);
  assert.equal(existsSync(f.drainFile), false, "the board's banner clears with the record");
});

test("a record the instance has marked forced (its runs stopped and re-queued) is applied the moment none is live", () => {
  const f = installed(true, 1);
  update({ version: undefined, channel: "release" }, f.deps());
  const record = JSON.parse(readFileSync(f.drainFile, "utf8"));
  writeDrain(f.drainFile, { ...record, forcedAt: new Date(NOW + 2 * HOUR).toISOString(), stopped: ["A11-1"] });
  f.state.live = 0;
  assert.equal(update({ version: undefined, channel: "release" }, f.deps()), true);
  assert.equal(currentVersionName(f.tool), "v0.2.0");
  assert.equal(existsSync(f.drainFile), false);
});

test("--force applies a breaking release at once past the drain, and a release already current clears a stale record", () => {
  const f = installed(true, 4);
  assert.equal(update({ version: undefined, channel: "release", force: true }, f.deps()), true);
  assert.equal(currentVersionName(f.tool), "v0.2.0");
  assert.deepEqual(f.restarted, ["instance", "ui"]);
  assert.equal(existsSync(f.drainFile), false);
  writeDrain(f.drainFile, { target: "v0.2.0", since: new Date(NOW).toISOString(), deadline: new Date(NOW + HOUR).toISOString(), stopped: [] });
  update({ version: undefined, channel: "release" }, f.deps());
  assert.equal(existsSync(f.drainFile), false, "nothing is newer, so a leftover record is over");
});

test("a breaking release with the instance not running, or its queue unreadable, is not held: nothing is live to drain", () => {
  const stopped = installed(true, 3);
  stopped.states.instance = "stopped";
  assert.equal(update({ version: undefined, channel: "release" }, stopped.deps()), true);
  const blind = installed(true, 0);
  blind.state.live = null as unknown as number;
  assert.equal(update({ version: undefined, channel: "release" }, blind.deps({ liveRuns: () => null })), true);
  assert.equal(existsSync(blind.drainFile), false);
});

test("a build that fails clears the drain record it would have waited for, so the queue is not held for a release that cannot be applied", () => {
  const f = installed(true, 2);
  update({ version: undefined, channel: "release" }, f.deps());
  assert.equal(existsSync(f.drainFile), true);
  f.release("0.3.0");
  f.state.failBuild = true;
  assert.throws(() => update({ version: undefined, channel: "release" }, f.deps()), /building it failed/);
  assert.equal(existsSync(f.drainFile), false);
});

test("the live runs are counted after the build, not before it: a run that starts during a long build is waited for, and one that finished is not", () => {
  const started = installed(true, 0);
  const during = started.deps({ build: (name, ref) => { started.state.live = 2; return started.deps().build(name, ref); } });
  assert.equal(update({ version: undefined, channel: "release" }, during), false);
  assert.equal(readDrain(started.drainFile).kind, "draining");
  assert.equal(currentVersionName(started.tool), "v0.1.0");
  const finished = installed(true, 3);
  const meanwhile = finished.deps({ build: (name, ref) => { finished.state.live = 0; return finished.deps().build(name, ref); } });
  assert.equal(update({ version: undefined, channel: "release" }, meanwhile), true);
  assert.equal(existsSync(finished.drainFile), false);
});

test("a changelog that cannot be read is not known not to be breaking: with runs live the release waits", () => {
  const f = installed(false, 2);
  const git = f.deps().git;
  const blind = f.deps({ git: (args) => { if (args[0] === "show" && args[1]?.endsWith(":CHANGELOG.md")) throw new Error("fatal: path 'CHANGELOG.md' does not exist"); return git(args); } });
  assert.equal(update({ version: undefined, channel: "release" }, blind), false);
  assert.equal(readDrain(f.drainFile).kind, "draining");
  assert.match(f.said.join("\n"), /its changelog could not be read/);
});

test("a host file toolVersion that is neither latest nor a release tag is refused by name, not read as latest", () => {
  const f = installed(false, 0);
  const host = (toolVersion: unknown) => { writeFileSync(f.hostPath, JSON.stringify({ clones: {}, toolVersion })); return { ...f.env, AGENT_ORG_HOST: f.hostPath }; };
  assert.equal(pinnedVersion(host("v0.2.0")), "v0.2.0");
  assert.equal(pinnedVersion(host("latest")), undefined);
  assert.throws(() => pinnedVersion(host("main")), (err: Error) => err instanceof UpdateRefusal && /toolVersion is "main", which is neither "latest" nor a release tag/.test(err.message));
  mkdirSync(f.tool, { recursive: true });
});

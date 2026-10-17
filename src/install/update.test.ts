// no-token: none -- git runs in a bare repository and a clone this file builds; the dependency installs and the services are stand-ins
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import type { ServiceName, ServiceState } from "./service.ts";
import { dependencyInstalls, readLiveRuns, update, type UpdateDeps } from "./update.ts";
import { pinnedPnpm } from "./pnpm.ts";

const ENV = sandboxGitEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
const gitIn = (cwd: string) => (args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A clone at v0.1.0 of a repository that has since tagged v0.2.0 and v0.10.0, and holds one more commit on main. */
function installed() {
  const root = tmpDir("update-");
  const work = join(root, "work");
  mkdirSync(work);
  const git = gitIn(work);
  git(["init", "--quiet", "--initial-branch=main"]);
  const commit = (label: string, tag?: string) => {
    writeFileSync(join(work, "version.txt"), `${label}\n`);
    git(["add", "-A"]);
    git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", label]);
    if (tag) git(["tag", tag]);
  };
  commit("v0.1.0", "v0.1.0");
  const checkout = join(root, "agent-org");
  gitIn(root)(["clone", "--quiet", work, checkout]);
  gitIn(checkout)(["checkout", "--quiet", "--detach", "refs/tags/v0.1.0"]);
  commit("v0.2.0", "v0.2.0");
  commit("v0.10.0", "v0.10.0");
  commit("main");
  return { checkout, git: gitIn(checkout) };
}

function deps(checkout: string, git: (args: string[]) => string, states: Partial<Record<ServiceName, ServiceState>>, live: number | null = 0) {
  const restarted: ServiceName[] = [];
  const said: string[] = [];
  const installs: string[] = [];
  const value: UpdateDeps = {
    root: checkout, git,
    installForTag: (tag) => { installs.push(tag); return { state: "current" }; },
    installInPlace: () => { installs.push("main"); },
    state: (name) => states[name] ?? "not-registered",
    restart: (name) => { restarted.push(name); },
    liveRuns: () => live,
    out: { log: (line: string) => { said.push(line); }, error: () => {} },
  };
  return { deps: value, restarted, installs, said };
}

const at = (git: (args: string[]) => string) => git(["show", "HEAD:version.txt"]).trim();

test("update moves to the newest release by numeric order, and restarts only the service that was running", () => {
  const { checkout, git } = installed();
  const { deps: d, restarted, installs } = deps(checkout, git, { instance: "running", ui: "stopped" });
  assert.equal(update({ version: undefined, channel: "release" }, d), true);
  assert.equal(at(git), "v0.10.0");
  assert.deepEqual(installs, ["v0.10.0"]);
  assert.deepEqual(restarted, ["instance"]);
});

test("update --version checks out that release, and restarts nothing when no service runs", () => {
  const { checkout, git } = installed();
  const { deps: d, restarted } = deps(checkout, git, { instance: "stopped" });
  update({ version: "v0.2.0", channel: "release" }, d);
  assert.equal(at(git), "v0.2.0");
  assert.deepEqual(restarted, []);
});

test("update restarts nothing when the checkout is already at the release", () => {
  const { checkout, git } = installed();
  const { deps: d, restarted } = deps(checkout, git, { instance: "running" });
  update({ version: "v0.1.0", channel: "release" }, d);
  assert.equal(update({ version: "v0.1.0", channel: "release" }, d), false);
  assert.deepEqual(restarted, []);
});

test("update --channel main follows main and installs in place", () => {
  const { checkout, git } = installed();
  const { deps: d, restarted, installs } = deps(checkout, git, { instance: "running" });
  update({ version: undefined, channel: "main" }, d);
  assert.equal(at(git), "main");
  assert.deepEqual(installs, ["main"]);
  assert.deepEqual(restarted, ["instance"]);
});

test("update refuses a tag that is not a release, --version with --channel main, and a dirty checkout", () => {
  const { checkout, git } = installed();
  const { deps: d } = deps(checkout, git, {});
  assert.throws(() => update({ version: "v0.2", channel: "release" }, d), /not a release tag/);
  assert.throws(() => update({ version: "v0.2.0", channel: "main" }, d), /give one of them/);
  writeFileSync(join(checkout, "version.txt"), "edited\n");
  assert.throws(() => update({ version: undefined, channel: "main" }, d), /changes to tracked files/);
  assert.throws(() => update({ version: undefined, channel: "release" }, d), /uncommitted changes/);
});

test("update --channel main puts the checkout back when main's dependencies fail to install", () => {
  const { checkout, git } = installed();
  const { deps: d, restarted } = deps(checkout, git, { instance: "running" });
  assert.throws(() => update({ version: undefined, channel: "main" }, { ...d, installInPlace: () => { throw new Error("pnpm failed"); } }), /stays at/);
  assert.equal(at(git), "v0.1.0");
  assert.deepEqual(restarted, []);
});

const failing = { state: "failed" as const, names: ["@a11ign/toolchain"], command: "pnpm install", reason: "Cannot find module pnpm.cjs" };

test("a failed install on the release the checkout is already at refuses, saying it is already there", () => {
  const { checkout, git } = installed();
  git(["fetch", "--quiet", "--tags", "origin"]);
  git(["checkout", "--quiet", "--detach", "refs/tags/v0.10.0"]);
  const { deps: d } = deps(checkout, git, {});
  assert.throws(() => update({ version: undefined, channel: "release" }, { ...d, installForTag: () => failing }),
    /^Error: agent-org is already at v0\.10\.0, but installing its dependencies failed: Cannot find module pnpm\.cjs\. Run `agent-org doctor`/);
});

test("a failed install on a newer release refuses, saying where the checkout stays, and restarts nothing", () => {
  const { checkout, git } = installed();
  const before = git(["rev-parse", "HEAD"]).trim();
  const { deps: d, restarted } = deps(checkout, git, { instance: "running" });
  assert.throws(() => update({ version: undefined, channel: "release" }, { ...d, installForTag: () => failing }),
    new RegExp(`agent-org stays at ${before}, not moved to v0\\.10\\.0, because installing its dependencies failed`));
  assert.equal(at(git), "v0.1.0");
  assert.deepEqual(restarted, []);
});

test("the default installs run the pinned pnpm through corepack, for a release and for main, never the pnpm on PATH", () => {
  const ran: { file: string; args: string[] }[] = [];
  const exec = (file: string, args: string[]) => { ran.push({ file, args }); return ""; };
  // A release whose package.json needs one dependency, which this checkout does not have installed.
  const git = (args: string[]) => {
    if (args[0] === "ls-tree") return "package.json\n";
    if (args[0] === "show") return JSON.stringify({ dependencies: args[1].startsWith("refs/tags/") ? { "@a11ign/toolchain": "^1.0.0" } : {} });
    return "";
  };
  const installs = dependencyInstalls(tmpDir("update-wiring-"), git, exec);
  installs.installForTag("v0.10.0");
  installs.installInPlace();
  const pinned = pinnedPnpm(["install", "--prod", "--no-frozen-lockfile", "--ignore-scripts", "--ignore-workspace"]);
  assert.deepEqual(ran, [pinned, pinned].map(({ command, args }) => ({ file: command, args })));
});

test("update restarts the services that run this checkout, not the web terminal or the auto-update timer that ran it", () => {
  const { checkout, git } = installed();
  const { deps: d, restarted } = deps(checkout, git, { instance: "running", ui: "running", terminal: "running", "auto-update": "running" });
  assert.equal(update({ version: undefined, channel: "release" }, d), true);
  assert.deepEqual(restarted, ["instance", "ui"]);
});

// A11-78: a restart of the instance interrupted a worker mid-turn, and the auto-update timer restarts it every hour a release lands.
test("update with a live run on the running instance moves nothing and restarts nothing, says it deferred, and --force updates and restarts", () => {
  const { checkout, git } = installed();
  const { deps: d, restarted, installs, said } = deps(checkout, git, { instance: "running", ui: "running" }, 2);
  assert.equal(update({ version: undefined, channel: "release" }, d), false);
  assert.equal(at(git), "v0.1.0", "the checkout is not moved, so the next hourly run still has a move to make, and restarts then");
  assert.deepEqual([installs, restarted], [[], []]);
  assert.match(said.join("\n"), /deferred: 2 runs live/);
  assert.equal(update({ version: undefined, channel: "release", force: true }, d), true);
  assert.equal(at(git), "v0.10.0");
  assert.deepEqual(restarted, ["instance", "ui"]);
});

test("update is not held back by live runs when the instance is not running, nor when its queue cannot be read", () => {
  for (const [state, live] of [["stopped", 3], ["running", null], ["running", 0]] as const) {
    const { checkout, git } = installed();
    const { deps: d } = deps(checkout, git, { instance: state }, live);
    assert.equal(update({ version: undefined, channel: "release" }, d), true, `instance ${state}, ${live} live`);
  }
});

test("the live runs are read from the queue file in the state directory the host file names, and none is null without a host file", () => {
  const root = tmpDir("update-live-");
  const host = join(root, "host.json");
  const stateDir = join(root, "state");
  writeFileSync(host, JSON.stringify({ clones: { a: "/r/a" }, stateDir }));
  mkdirSync(join(stateDir, "tickets"), { recursive: true });
  const entry = (key: string, phase: string, batch?: string) => ({ ticket: { key }, repos: [], model: "opus", effort: "high", phase, queuedAt: 0, ...(batch ? { batch } : {}) });
  writeFileSync(join(stateDir, "tickets", "queue.json"), JSON.stringify({ max: 3, paused: false,
    entries: [entry("A-1", "running"), entry("A-2", "starting"), entry("A-3", "queued"), entry("A-4", "finished"), entry("A-5", "running", "b1"), entry("A-6", "running", "b1")] }));
  assert.equal(readLiveRuns({ AGENT_ORG_HOST: host, HOME: root }), 3, "two runs and one batch's run; queued and finished are not live");
  assert.equal(readLiveRuns({ AGENT_ORG_HOST: join(root, "none.json"), HOME: root }), null);
});

// no-token: none -- git runs in a bare repository and a clone this file builds; the dependency installs and the services are stand-ins
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import type { ServiceName, ServiceState } from "./service.ts";
import { conventionsWiring, dependencyInstalls, readLiveRuns, update, type UpdateDeps } from "./update.ts";
import { pluginUpkeep } from "./plugin-upkeep.ts";
import { fakePluginDeps } from "../plugins/fakes/deps.ts";
import type { PluginDeps } from "../plugins/manifest.ts";
import { parseTicketSettings } from "../ticket-mode/settings.ts";
import { deferralPath, readDeferral } from "./plugin-install.ts";
import { pinnedPnpm } from "./pnpm.ts";
import { midToolCall, type Isolation, type MidToolCall, type UpdateStatus } from "./update-safety.ts";

const ENV = sandboxGitEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
const gitIn = (cwd: string) => (args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A clone at v0.1.0 of a repository that has since tagged v0.2.0 and v0.10.0, and holds one more commit on main. */
function installed() {
  const root = tmpDir("update-");
  const work = join(root, "work");
  mkdirSync(work);
  const git = gitIn(work);
  git(["init", "--quiet", "--initial-branch=main"]);
  git(["config", "gc.auto", "0"]);
  const commit = (label: string, tag?: string) => {
    writeFileSync(join(work, "version.txt"), `${label}\n`);
    git(["add", "-A"]);
    git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", label]);
    if (tag) git(["tag", tag]);
  };
  commit("v0.1.0", "v0.1.0");
  const checkout = join(root, "agent-org");
  // No auto-maintenance: the clone's `gc --auto` can detach and write into the folder after the test has returned (#2606 in the other fixtures).
  gitIn(root)(["clone", "--quiet", "-c", "gc.auto=0", "-c", "maintenance.auto=false", work, checkout]);
  gitIn(checkout)(["checkout", "--quiet", "--detach", "refs/tags/v0.1.0"]);
  commit("v0.2.0", "v0.2.0");
  commit("v0.10.0", "v0.10.0");
  commit("main");
  return { checkout, git: gitIn(checkout) };
}

// A11-90: the clock the deferral is measured on, and the readings a host gives. By default herdr is inside the instance's cgroup and a worker is working,
// which is the A11-78 situation: a live run holds the move.
const NOW = Date.parse("2026-10-18T10:00:00.000Z");
const HOUR = 3600e3;
const INSIDE: Isolation = { kind: "inside", cgroup: "/user.slice/agent-org-instance.service", unit: "agent-org-instance.service" };
const OUTSIDE: Isolation = { kind: "outside", scope: "/user.slice/agent-org-herdr-tickets.scope" };
const WORKING: MidToolCall = { busy: true, why: "working: worker-1" };
const IDLE: MidToolCall = { busy: false, why: "2 agents, none working" };

function deps(checkout: string, git: (args: string[]) => string, states: Partial<Record<ServiceName, ServiceState>>, live: number | null = 0, over: Partial<UpdateDeps> = {}) {
  const restarted: ServiceName[] = [];
  const said: string[] = [];
  const installs: string[] = [];
  const statuses: UpdateStatus[] = [];
  const errors: string[] = [];
  const value: UpdateDeps = {
    root: checkout, git,
    installForTag: (tag) => { installs.push(tag); return { state: "current" }; },
    installInPlace: () => { installs.push("main"); },
    state: (name) => states[name] ?? "not-registered",
    restart: (name) => { restarted.push(name); },
    liveRuns: () => live,
    isolation: () => INSIDE,
    busy: () => WORKING,
    maxDeferHours: 2,
    now: () => NOW,
    status: { read: () => statuses.at(-1) ?? null, write: (status) => { statuses.push(status); } },
    upkeep: () => [],
    conventions: () => ({ said: [], failed: [] }),
    conventionsDeferral: { defer: () => {}, clear: () => {} },
    out: { log: (line: string) => { said.push(line); }, error: (line: string) => { errors.push(line); } },
    ...over,
  };
  return { deps: value, restarted, installs, said, statuses, errors };
}

/** The status a previous run left, for the release `installed()` holds as its newest, deferred since `since`. */
const previous = (since: number | undefined): UpdateStatus => ({
  checkedAt: new Date(NOW - HOUR).toISOString(), channel: "release", installed: "v0.1.0", latest: "v0.10.0", latestSince: "2026-10-17T09:00:00.000Z",
  ...(since === undefined ? {} : { deferredSince: new Date(since).toISOString(), deferredReason: "herdr is inside the instance's cgroup" }),
});

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

// A11-90: a live run holds the release only while a restart would interrupt a worker, and then only for tickets.updateMaxDeferHours.
test("A11-90 restart-safe: with herdr outside the instance's cgroup, a live working run does not hold the release; it is applied, the instance restarted, and the reason logged", () => {
  const { checkout, git } = installed();
  const { deps: d, restarted, said, statuses } = deps(checkout, git, { instance: "running", ui: "running" }, 2, { isolation: () => OUTSIDE });
  assert.equal(update({ version: undefined, channel: "release" }, d), true);
  assert.equal(at(git), "v0.10.0");
  assert.deepEqual(restarted, ["instance", "ui"]);
  assert.match(said.join("\n"), /^agent-org update: herdr is outside the instance's cgroup, so a restart interrupts no worker \(the herdr server is in \/user\.slice\/agent-org-herdr-tickets\.scope\)$/m);
  assert.deepEqual([statuses.at(-1)?.installed, statuses.at(-1)?.deferredSince], ["v0.10.0", undefined], "the move is recorded, and no deferral is left");
});

test("A11-90 restart-safe: with herdr inside the cgroup but every agent idle, a live run does not hold the release; the instance is restarted and the reason logged", () => {
  const { checkout, git } = installed();
  const { deps: d, restarted, said } = deps(checkout, git, { instance: "running" }, 2, { busy: () => IDLE });
  assert.equal(update({ version: undefined, channel: "release" }, d), true);
  assert.equal(at(git), "v0.10.0");
  assert.deepEqual(restarted, ["instance"]);
  assert.match(said.join("\n"), /^agent-org update: no run is mid-tool-call \(2 agents, none working\)$/m);
});

test("A11-90 deferral: with herdr inside and an agent working, the move waits and the checkout is not moved", () => {
  const { checkout, git } = installed();
  const { deps: d } = deps(checkout, git, { instance: "running" }, 2);
  assert.equal(update({ version: undefined, channel: "release" }, d), false);
  assert.equal(at(git), "v0.1.0", "not moved, so the next hourly run still has a move to make");
});

test("A11-90 deferral: with herdr inside and an agent working, the move waits, says why and until when, and records when the deferral began", () => {
  const { checkout, git } = installed();
  const { deps: d, restarted, installs, said, statuses } = deps(checkout, git, { instance: "running" }, 2);
  assert.equal(update({ version: undefined, channel: "release" }, d), false);
  assert.deepEqual([installs, restarted], [[], []]);
  assert.match(said.join("\n"), /deferred: 2 runs live on the instance, which a restart would interrupt: herdr is inside the instance's cgroup \(\/user\.slice\/agent-org-instance\.service\), and an agent is mid-tool-call \(working: worker-1\)\. It updates anyway at 2026-10-18T12:00:00\.000Z/);
  assert.deepEqual([statuses.at(-1)?.deferredSince, statuses.at(-1)?.latest], ["2026-10-18T10:00:00.000Z", "v0.10.0"]);
});

test("A11-90 deferral: a deferral that began an hour ago keeps its start, so each hourly run does not restart the clock", () => {
  const { checkout, git } = installed();
  const written: UpdateStatus[] = [];
  const began = NOW - HOUR;
  const { deps: d } = deps(checkout, git, { instance: "running" }, 2, { status: { read: () => previous(began), write: (status) => { written.push(status); } } });
  assert.equal(update({ version: undefined, channel: "release" }, d), false);
  assert.equal(written.at(-1)?.deferredSince, new Date(began).toISOString());
});

test("A11-90 max-defer: a deferral that has run tickets.updateMaxDeferHours is applied anyway, and one second short of the limit still waits", () => {
  for (const [since, applied] of [[NOW - 2 * HOUR, true], [NOW - 2 * HOUR + 1000, false]] as const) {
    const { checkout, git } = installed();
    const { deps: d, restarted, said } = deps(checkout, git, { instance: "running" }, 2, { status: { read: () => previous(since), write: () => {} } });
    assert.equal(update({ version: undefined, channel: "release" }, d), applied, `deferred since ${new Date(since).toISOString()}`);
    if (applied) {
      assert.equal(at(git), "v0.10.0");
      assert.deepEqual(restarted, ["instance"]);
      assert.match(said.join("\n"), /deferred for 2 hours, updating anyway/);
    } else {
      assert.equal(at(git), "v0.1.0");
      assert.deepEqual(restarted, []);
    }
  }
});

test("A11-90 deferral: an unreadable herdr listing holds the move, and so does an isolation that cannot be read while an agent works; with every agent idle an unreadable isolation does not", () => {
  const unreadable = midToolCall({ agents: () => null, queue: () => ({ entries: [] }) });
  assert.equal(unreadable.busy, true, "a listing that cannot be read is never read as idle");
  const blind: Isolation = { kind: "unknown", why: "/proc/3655416/cgroup cannot be read" };
  const cases: [string, Partial<UpdateDeps>, boolean][] = [
    ["an unreadable herdr listing", { busy: () => unreadable }, false],
    ["an unknown isolation with a worker working", { isolation: () => blind }, false],
    ["an unknown isolation with every agent idle", { isolation: () => blind, busy: () => IDLE }, true],
  ];
  for (const [label, over, applied] of cases) {
    const { checkout, git } = installed();
    const { deps: d, restarted } = deps(checkout, git, { instance: "running" }, 2, over);
    assert.equal(update({ version: undefined, channel: "release" }, d), applied, label);
    assert.deepEqual(restarted, applied ? ["instance"] : [], label);
  }
});

test("A11-90: at the newest release a live run says nothing about deferring, moves nothing, and clears any deferral", () => {
  const { checkout, git } = installed();
  git(["fetch", "--quiet", "--tags", "origin"]);
  git(["checkout", "--quiet", "--detach", "refs/tags/v0.10.0"]);
  const written: UpdateStatus[] = [];
  const { deps: d, restarted, installs, said } = deps(checkout, git, { instance: "running" }, 2,
    { status: { read: () => previous(NOW - HOUR), write: (status) => { written.push(status); } } });
  assert.equal(update({ version: undefined, channel: "release" }, d), false);
  assert.deepEqual([installs, restarted], [[], []]);
  assert.equal(said.join("\n").includes("deferred"), false, "nothing newer is not a deferral");
  assert.deepEqual([written.at(-1)?.installed, written.at(-1)?.deferredSince], ["v0.10.0", undefined]);
});

test("A11-90: --force asks nothing of herdr or the queue, and updates and restarts", () => {
  const { checkout, git } = installed();
  const asked = (): never => { throw new Error("--force asks nothing"); };
  const { deps: d, restarted } = deps(checkout, git, { instance: "running" }, 2, { isolation: asked, busy: asked });
  assert.equal(update({ version: undefined, channel: "release", force: true }, d), true);
  assert.equal(at(git), "v0.10.0");
  assert.deepEqual(restarted, ["instance"]);
});

// Review fixes (A11-90): a live run never makes the hourly update fail where it used to defer, and a status write cannot leave a moved install on old modules.
test("A11-90: with a live run and the remote unreachable, the run defers as before, and nothing is moved or thrown", () => {
  const { checkout, git } = installed();
  const offline = (args: string[]) => { if (args[0] === "fetch") throw new Error("Command failed: git fetch (offline)"); return git(args); };
  const { deps: d, restarted, said } = deps(checkout, offline, { instance: "running" }, 2);
  assert.equal(update({ version: undefined, channel: "release" }, d), false);
  assert.equal(at(git), "v0.1.0");
  assert.deepEqual(restarted, []);
  assert.match(said.join("\n"), /^agent-org update deferred: 2 runs live on the instance, which a restart would interrupt\. /m);
});

test("A11-90: with a live run and a pinned release the remote does not hold, the run defers as before rather than refusing", () => {
  const { checkout, git } = installed();
  const { deps: d, said } = deps(checkout, git, { instance: "running" }, 2);
  assert.equal(update({ version: "v9.9.9", channel: "release" }, d), false);
  assert.equal(at(git), "v0.1.0");
  assert.match(said.join("\n"), /deferred: 2 runs live/);
});

test("A11-90: a status that cannot be written after the move still restarts the services that ran the old version", () => {
  const { checkout, git } = installed();
  const { deps: d, restarted } = deps(checkout, git, { instance: "running", ui: "running" }, 0,
    { status: { read: () => null, write: () => { throw new Error("EACCES: status"); } } });
  assert.throws(() => update({ version: undefined, channel: "release" }, d), /EACCES: status/);
  assert.equal(at(git), "v0.10.0");
  assert.deepEqual(restarted, ["instance", "ui"]);
});

test("A11-106: update keeps what the plugins keep true, the stacking extension among it, whether the checkout moved, did not move, or was deferred", () => {
  for (const [live, moved] of [[0, true], [1, false]] as const) {
    const { checkout, git } = installed();
    const ensured: string[] = [];
    const { deps: d } = deps(checkout, git, { instance: "running" }, live, { upkeep: () => { ensured.push("ensured"); return []; } });
    assert.equal(update({ version: undefined, channel: "release" }, d), moved);
    assert.deepEqual(ensured, ["ensured"], `live ${live}, moved ${moved}`);
  }
});

test("A11-106: an extension that was installed is said, and one that could not be installed is said as missing, without failing the update", () => {
  const { checkout, git } = installed();
  const installedNow = deps(checkout, git, { instance: "running" }, 0, { upkeep: () => [{ ok: true, detail: "installed the github/gh-stack extension (v0.2.1)" }] });
  assert.equal(update({ version: undefined, channel: "release" }, installedNow.deps), true);
  assert.ok(installedNow.said.includes("agent-org update: installed the github/gh-stack extension (v0.2.1)"));

  const fresh = installed();
  const missing = deps(fresh.checkout, fresh.git, {}, 0, { upkeep: () => [{ ok: false, detail: "the github/gh-stack extension is missing and could not be installed: could not reach github.com" }] });
  assert.equal(update({ version: undefined, channel: "release" }, missing.deps), true, "the move still happens: a failed extension does not stop it");
  assert.deepEqual(missing.errors, ["agent-org update: the github/gh-stack extension is missing and could not be installed: could not reach github.com"]);
});

test("A11-106: what the plugins keep is kept even when the update refuses, and its failure never replaces the refusal", () => {
  const { checkout, git } = installed();
  const refused = deps(checkout, git, {}, 0, { upkeep: () => [{ ok: false, detail: "the github/gh-stack extension is missing and could not be installed: no network" }] });
  assert.throws(() => update({ version: "v0.2", channel: "release" }, refused.deps), /not a release tag/);
  assert.equal(refused.errors.length, 1);
});

// A11-145: a live run holds the conventions plugin's refresh back, as it holds back a release, and records the wait for doctor to say so.
test("A11-145: a live run holds the conventions refresh back and records it; with none live, the refresh runs and the record is cleared", () => {
  const refreshed: string[] = [];
  const recorded: number[] = [];
  const cleared: string[] = [];
  const conventionsDeferral = { defer: (live: number) => { recorded.push(live); }, clear: () => { cleared.push("cleared"); } };
  const conventions = () => { refreshed.push("refreshed"); return { said: [], failed: [] }; };
  const { checkout, git } = installed();
  const busy = deps(checkout, git, { instance: "running" }, 2, { conventions, conventionsDeferral });
  update({ version: undefined, channel: "release" }, busy.deps);
  assert.deepEqual([refreshed, recorded], [[], [2]], "no refresh while two runs are live, and the wait is recorded");
  assert.ok(busy.said.includes("agent-org update: the conventions plugin refresh waits while 2 runs are live, and runs at the next update with none live"));

  const idle = deps(checkout, git, { instance: "running" }, 0, { conventions, conventionsDeferral });
  update({ version: undefined, channel: "release" }, idle.deps);
  assert.deepEqual([refreshed, cleared], [["refreshed"], ["cleared"]], "the refresh runs once none is live, and the record is cleared");
});

// A11-145: the production wiring of the refresh runs claude for a GitHub-sourced plugin, and records and clears the wait under the agent-org home.
test("A11-145: the production conventions wiring refreshes a GitHub-sourced plugin through claude, and records and clears a wait in the agent-org home", () => {
  const home = tmpDir("wiring-");
  const calls: string[] = [];
  const run = (file: string, args: string[]) => {
    calls.push([file, ...args].join(" "));
    const line = args.join(" ");
    const stdout = line === "plugin marketplace list --json" ? JSON.stringify([{ name: "example-marketplace", source: "github", repo: "example-org/example-plugin" }]) : "";
    return { status: 0, stdout, stderr: "" };
  };
  const wiring = conventionsWiring({ plugins: ["example@example-marketplace"] }, {}, home, run);
  wiring.conventionsDeferral.defer(2);
  const recorded = readDeferral(deferralPath({}, home));
  assert.deepEqual([recorded.kind, recorded.kind === "waiting" ? recorded.live : 0], ["waiting", 2]);
  assert.deepEqual(wiring.conventions(), { said: [], failed: [] });
  assert.deepEqual(calls, ["claude plugin marketplace list --json", "claude plugin marketplace update example-marketplace", "claude plugin update example@example-marketplace"]);
  wiring.conventionsDeferral.clear();
  assert.deepEqual(readDeferral(deferralPath({}, home)), { kind: "none" });
});

// A11-160: what the plugins keep true is asked of each enabled plugin that says it keeps something, from the code loaded before the checkout moves.
const settingsFor = (tickets: Record<string, unknown> = {}) => parseTicketSettings({ clones: { netbox: "/src/netbox" }, stateDir: "/state", tickets });

test("A11-160: the upkeep asks the code host plugin to keep the stacking extension, as the workers' account, and reads no tracker key for it", async () => {
  const programs: { file: string; args: readonly string[]; env: unknown }[] = [];
  const exec: PluginDeps["exec"] = (file, args, options) => {
    programs.push({ file, args, env: options?.env });
    return { status: 0, stdout: "", stderr: "" };
  };
  const upkeep = await pluginUpkeep(settingsFor(), {}, { deps: fakePluginDeps({ exec }) });
  assert.equal(programs.length, 0, "nothing runs until the update is done: the modules are imported, not built");
  const said = upkeep();
  assert.deepEqual([...new Set(programs.map(({ file }) => file))], ["gh"], "only gh is run: the Linear key is not read from the Keychain to ask what it keeps");
  assert.deepEqual(programs.map(({ args }) => args.join(" ")), ["extension list", "extension install github/gh-stack", "extension list"], "the extension is missing, so it is installed, and read back");
  assert.deepEqual(said.map(({ ok }) => ok), [false], "and the read-back found none, which is said as an error");
  assert.match(said[0].detail, /the github\/gh-stack extension is missing and could not be installed: the install succeeded, but the extension list does not show github\/gh-stack/);
});

test("A11-160: a host whose extension is listed keeps nothing to say, and one that names the workers' account runs gh as it", async () => {
  const programs: { args: readonly string[]; env: unknown }[] = [];
  const exec: PluginDeps["exec"] = (_file, args, options) => {
    programs.push({ args, env: options?.env });
    return { status: 0, stdout: "gh stack  github/gh-stack  v0.2.1\n", stderr: "" };
  };
  const upkeep = await pluginUpkeep(settingsFor({ providers: { codeHost: { provider: "github", gh: { workers: "/home/agent/workers" } } } }), {}, { deps: fakePluginDeps({ exec }) });
  assert.deepEqual(upkeep(), []);
  assert.deepEqual(programs, [{ args: ["extension", "list"], env: { GH_CONFIG_DIR: "/home/agent/workers/gh" } }]);
});

test("A11-160: a plugin that cannot be imported, and a keep that throws, are said as errors and never raised; a host file that cannot be read keeps nothing", async () => {
  const importing = async (url: string): Promise<unknown> => {
    if (url.endsWith("/plugins/linear/index.ts")) throw new Error("cannot import");
    return { create: () => ({}), doctorChecks: () => [], onboardSteps: [], keep: () => { throw new Error("gh exploded"); } };
  };
  const said = (await pluginUpkeep(settingsFor(), {}, { deps: fakePluginDeps(), importModule: importing }))();
  assert.deepEqual(said.map(({ ok, detail }) => [ok, detail]), [
    [false, "the tracker plugin linear was refused: cannot import"],
    [false, "the github plugin could not be kept up: gh exploded"],
  ]);
  assert.deepEqual((await pluginUpkeep(null))(), []);
});

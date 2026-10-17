// no-token: none -- git runs in a bare repository and a clone this file builds; the dependency installs and the services are stand-ins
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import type { ServiceName, ServiceState } from "./service.ts";
import { update, type UpdateDeps } from "./update.ts";

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

function deps(checkout: string, git: (args: string[]) => string, states: Partial<Record<ServiceName, ServiceState>>) {
  const restarted: ServiceName[] = [];
  const installs: string[] = [];
  const value: UpdateDeps = {
    root: checkout, git,
    installForTag: (tag) => { installs.push(tag); return { state: "current" }; },
    installInPlace: () => { installs.push("main"); },
    state: (name) => states[name] ?? "not-registered",
    restart: (name) => { restarted.push(name); },
    out: { log: () => {}, error: () => {} },
  };
  return { deps: value, restarted, installs };
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

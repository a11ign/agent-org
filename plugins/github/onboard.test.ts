// no-token: none -- `gh` is a fake `exec`: no GitHub CLI runs, and no extension is installed
//
// THE PLUGIN'S ONBOARD STEP, AND WHAT `agent-org update` KEEPS (A11-160), moved from `install/onboard.test.ts` and `install/update.test.ts` with their words unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import type { ExecOptions, ExecResult, OnboardStepDeps, PluginSettings } from "../../src/plugins/manifest.ts";
import { keep, ONBOARD_STEPS } from "./onboard.ts";

const LISTED = "gh stack  github/gh-stack  v0.2.1\n";
const WORKERS: PluginSettings = { gh: { workers: "/home/agent/workers" } };

/** A `gh` whose extension is listed once `install` has run (when it succeeds), recording each call's environment and command. */
function machine(install: ExecResult, listedAtFirst = false) {
  let listed = listedAtFirst;
  const calls: { command: string; env: ExecOptions["env"] }[] = [];
  const exec = (_file: string, args: readonly string[], options?: ExecOptions): ExecResult => {
    calls.push({ command: args.join(" "), env: options?.env });
    if (args[1] === "install") {
      if (install.status === 0) listed = true;
      return install;
    }
    return { status: 0, stdout: listed ? LISTED : "", stderr: "" };
  };
  const step = (deps: Partial<OnboardStepDeps> = {}): OnboardStepDeps => ({ ...fakePluginDeps({ exec }), interactive: false, answered: false, ask: async () => "", askSecret: async () => "", writeFile: () => undefined, platform: "linux", home: "/home/me", agentOrgHome: "/home/me/.agent-org", flags: {}, ...deps });
  return { calls, exec, step, deps: fakePluginDeps({ exec }) };
}

const run = (settings: PluginSettings, deps: OnboardStepDeps) => ONBOARD_STEPS[0].run(settings, deps);

test("the plugin has one onboard step, the extension's", () => {
  assert.deepEqual(ONBOARD_STEPS.map(({ name }) => name), ["gh stack extension"]);
  assert.ok(ONBOARD_STEPS[0].explain.length > 0);
});

test("A11-106: onboard installs the stack extension for the workers' account when it is missing, and says so", async () => {
  const { calls, step } = machine({ status: 0, stdout: "", stderr: "" });
  const answer = await run(WORKERS, step());
  assert.ok(calls.some(({ command }) => command === "extension install github/gh-stack"), "the extension is installed");
  assert.ok(calls.every(({ env }) => env?.GH_CONFIG_DIR === "/home/agent/workers/gh"), "every call runs as the workers' account");
  assert.deepEqual(answer, { ok: true, detail: "installed the github/gh-stack extension (v0.2.1), which a worker links a stacked pull request with" });
});

test("A11-106: onboard does not install the stack extension again where it is listed", async () => {
  const { calls, step } = machine({ status: 0, stdout: "", stderr: "" }, true);
  const answer = await run({}, step());
  assert.deepEqual(calls.map(({ command }) => command), ["extension list"], "a listed extension is not installed again");
  assert.deepEqual(answer, { ok: true, detail: "the github/gh-stack extension is installed (v0.2.1), which a worker links a stacked pull request with" });
});

test("A11-106: a stack extension that fails to install is said with its reason and the command to run, and is not thrown", async () => {
  const { step } = machine({ status: 1, stdout: "", stderr: "could not reach github.com\nmore" });
  const answer = await run(WORKERS, step());
  assert.equal(answer.ok, false);
  assert.equal(answer.detail, "could not install the github/gh-stack extension: could not reach github.com. Run `GH_CONFIG_DIR=/home/agent/workers/gh gh extension install github/gh-stack` by hand, then `agent-org doctor`.");
});

test("A11-145: a host that sets stack to false is not asked for the stack extension", async () => {
  const { calls, step } = machine({ status: 0, stdout: "", stderr: "" });
  assert.deepEqual(await run({ stack: false }, step()), { ok: true, detail: "" });
  assert.deepEqual(calls, []);
});

test("A11-106: update keeps the extension present: said when it was installed, said as an error when it could not be, and nothing when it is there", () => {
  const installed = machine({ status: 0, stdout: "", stderr: "" });
  assert.deepEqual(keep(WORKERS, installed.deps), [{ ok: true, detail: "installed the github/gh-stack extension (v0.2.1)" }]);
  const there = machine({ status: 0, stdout: "", stderr: "" }, true);
  assert.deepEqual(keep(WORKERS, there.deps), []);
  assert.deepEqual(there.calls.map(({ command }) => command), ["extension list"]);
  const failing = machine({ status: 1, stdout: "", stderr: "no network" });
  assert.deepEqual(keep(WORKERS, failing.deps), [{ ok: false, detail: "the github/gh-stack extension is missing and could not be installed: no network" }]);
});

test("A11-106: update keeps the extension whatever the stack setting says, as it always did", () => {
  const { calls, deps } = machine({ status: 0, stdout: "", stderr: "" }, true);
  keep({ stack: false }, deps);
  assert.deepEqual(calls.map(({ command }) => command), ["extension list"]);
});

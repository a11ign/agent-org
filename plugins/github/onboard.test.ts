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

test("the plugin has two onboard steps, the extension's and the Apps' keys", () => {
  assert.deepEqual(ONBOARD_STEPS.map(({ name }) => name), ["gh stack extension", "App keys"]);
  assert.ok(ONBOARD_STEPS.every(({ explain }) => explain.length > 0));
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

// ---- the Apps' keys (A11-145, moved here from `install/onboard.ts`'s `reviewerIdentity` by A11-160) ----------------------------------------------

const KEY_TEXT = "-----BEGIN RSA PRIVATE KEY-----\nSECRET-KEY-BYTES\n-----END RSA PRIVATE KEY-----\n";
const REVIEWER_APP = { slug: "acme-reviewer", appId: 4242, installationId: 77 };
const runKeys = (settings: PluginSettings, deps: OnboardStepDeps) => ONBOARD_STEPS[1].run(settings, deps);

/** A person at a terminal who answers `answer` for the key's path, with `files` on disk, recording what was written and what was asked. */
function person(answer: string, files: Record<string, string> = { "/home/me/Downloads/key.pem": KEY_TEXT }, over: Partial<OnboardStepDeps> = {}) {
  const written: Record<string, string> = {};
  const asked: string[] = [];
  const deps: OnboardStepDeps = { ...fakePluginDeps({ readFile: (path) => { if (files[path] === undefined) throw new Error(`ENOENT: ${path}`); return files[path]; }, mode: (path) => (files[path] === undefined ? null : 0o600) }),
    interactive: true, answered: true, ask: async (question) => { asked.push(question); return answer; }, askSecret: async () => "", writeFile: (path, text) => { written[path] = text; }, platform: "linux",
    home: "/home/me", agentOrgHome: "/home/me/.agent-org", flags: { reviewerApp: REVIEWER_APP }, ...over };
  return { deps, written, asked };
}

test("A11-145: the reviewer App's key is copied beside the host file, mode 600 by the writer, and the identity names it; the key's text is never said", async () => {
  const { deps, written, asked } = person("~/Downloads/key.pem");
  const answer = await runKeys({}, deps);
  assert.deepEqual(asked, ["Path to the downloaded private key (.pem) of the reviewer App acme-reviewer, or an empty line to add it later: "]);
  assert.deepEqual(written, { "/home/me/.agent-org/apps/acme-reviewer.pem": KEY_TEXT }, "the key is written where the host file will name it, and nowhere else");
  assert.deepEqual(answer, { ok: true, detail: "copied the reviewer App's key to /home/me/.agent-org/apps/acme-reviewer.pem, mode 600; its text is not shown",
    settings: { identity: { reviewer: { mode: "github-apps", slug: "acme-reviewer", appId: 4242, installationId: 77, keyPath: "/home/me/.agent-org/apps/acme-reviewer.pem" } } } });
  assert.ok(!JSON.stringify(answer).includes("SECRET-KEY-BYTES"));
});

test("A11-145: the identity the step returns keeps the roles the host file already declares", async () => {
  const { deps } = person("/home/me/Downloads/key.pem");
  const held = { workers: { mode: "github-apps", appId: "1", keyPath: "/k/workers.pem" }, reviewer: { mode: "github-apps", appId: "9", keyPath: "/gone/reviewer.pem" } };
  const answer = await runKeys({ identity: held }, deps);
  assert.deepEqual(Object.keys((answer.settings?.identity as Record<string, unknown>)), ["workers", "reviewer"]);
  assert.deepEqual((answer.settings?.identity as Record<string, unknown>).workers, held.workers, "another role's App is as it was");
  assert.equal(((answer.settings?.identity as Record<string, { keyPath: string }>).reviewer).keyPath, "/home/me/.agent-org/apps/acme-reviewer.pem", "a reviewer whose key is gone is replaced by the one just copied");
});

test("A11-145: a reviewer identity whose key is readable is kept, nothing is asked, and a profile that names no App asks nothing either", async () => {
  const held = { identity: { reviewer: { mode: "github-apps", appId: "9", keyPath: "/home/me/Downloads/key.pem" } } };
  const kept = person("never asked");
  assert.deepEqual(await runKeys(held, kept.deps), { ok: true, detail: "" });
  assert.deepEqual([kept.asked, kept.written], [[], {}]);
  const none = person("never asked", undefined, { flags: {} });
  assert.deepEqual(await runKeys({}, none.deps), { ok: true, detail: "" });
  assert.deepEqual(none.asked, []);
});

test("A11-145: with no terminal the step says where the key is missing and how to add it, and asks for nothing", async () => {
  const { deps, asked, written } = person("never asked", undefined, { interactive: false });
  assert.deepEqual(await runKeys({}, deps), { ok: true, detail: "NO reviewer App key is set for acme-reviewer. Run `agent-org onboard --profile <name>` at a terminal, which asks for the path of the App's downloaded .pem file." });
  assert.deepEqual([asked, written], [[], {}]);
});

test("A11-145: an empty answer adds the key later: nothing is copied and no identity is named", async () => {
  const { deps, written } = person("   ");
  assert.deepEqual(await runKeys({}, deps), { ok: true, detail: "" });
  assert.deepEqual(written, {});
});

test("A11-145: a key's path that is not absolute, or cannot be read, THROWS its sentence, which refuses onboard, and nothing is written", async () => {
  const relative = person("keys/app.pem");
  await assert.rejects(runKeys({}, relative.deps), /^Error: the reviewer App's key must be an absolute path$/);
  const missing = person("/home/me/Downloads/nothing.pem");
  await assert.rejects(runKeys({}, missing.deps), /^Error: the reviewer App's key cannot be read at \/home\/me\/Downloads\/nothing\.pem$/);
  assert.deepEqual([relative.written, missing.written], [{}, {}]);
});

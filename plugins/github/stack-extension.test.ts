// no-token: none -- every runner is a fake: no GitHub CLI runs, and no extension is installed
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureStackExtension, githubRepoOf, installCommand, STACK_EXTENSION, stackExtensionIn, stacksOf, type Program, type ProgramRunner, workerAccount } from "./stack-extension.ts";

const LISTED = "gh stack  github/gh-stack  v0.2.1\ngh dash  dlvhdr/gh-dash  v4.0.0\n";
const ok = (stdout = ""): Program => ({ status: 0, stdout, stderr: "" });

/** A runner that answers `extension list` with each of `listings` in turn, and `install` with `install`, and records each call. */
function fakeRunner(listings: string[], install: Program = ok()) {
  const calls: string[][] = [];
  const run: ProgramRunner = (args) => {
    calls.push(args);
    if (args[1] === "install") return install;
    return ok(listings.shift() ?? "");
  };
  return { run, calls };
}

test("A11-106: the extension is found in a listing, with its version, and not in another listing", () => {
  assert.deepEqual(stackExtensionIn(LISTED), { version: "v0.2.1" });
  assert.equal(stackExtensionIn("gh dash  dlvhdr/gh-dash  v4.0.0\n"), null);
  assert.equal(stackExtensionIn(""), null);
});

test("A11-106: onboard's install is idempotent: a listed extension runs the listing and no install", () => {
  const fake = fakeRunner([LISTED]);
  assert.deepEqual(ensureStackExtension(fake.run), { state: "present", version: "v0.2.1" });
  assert.deepEqual(fake.calls, [["extension", "list"]], "no install is run for a present extension");
});

test("A11-106: a missing extension is installed, and the listing reads its version back", () => {
  const fake = fakeRunner(["", LISTED]);
  assert.deepEqual(ensureStackExtension(fake.run), { state: "installed", version: "v0.2.1" });
  assert.deepEqual(fake.calls, [["extension", "list"], ["extension", "install", "github/gh-stack"], ["extension", "list"]]);
});

test("A11-106: a failed install is a reason, never a throw, and it is the first line the install printed", () => {
  const fake = fakeRunner([""], { status: 1, stdout: "", stderr: "could not reach github.com\nmore detail" });
  assert.deepEqual(ensureStackExtension(fake.run), { state: "failed", reason: "could not reach github.com" });
});

test("A11-106: an install that succeeds but is not listed afterwards is a failure, not a pass", () => {
  const result = ensureStackExtension(fakeRunner(["", ""]).run);
  assert.equal(result.state, "failed");
  assert.match(result.state === "failed" ? result.reason : "", /does not show github\/gh-stack/);
});

test("A11-106: a listing that cannot run is a failure with its reason, and nothing is installed", () => {
  const calls: string[][] = [];
  const run: ProgramRunner = (args) => { calls.push(args); return { status: null, stdout: "", stderr: "spawn ENOENT" }; };
  assert.deepEqual(ensureStackExtension(run), { state: "failed", reason: "the extension list failed: spawn ENOENT" });
  assert.deepEqual(calls, [["extension", "list"]], "nothing is installed when the list cannot run");
});

test("A11-106: the workers' account is the gh folder inside the block's gh.workers, else the environment's, else none", () => {
  assert.deepEqual(workerAccount({ workers: "/home/agent/workers", leads: "/home/agent/leads" }, { GH_CONFIG_DIR: "/home/me/gh" }), { GH_CONFIG_DIR: "/home/agent/workers/gh" }, "the host file wins over the environment");
  assert.deepEqual(workerAccount({ workers: "/home/agent/workers/" }, {}), { GH_CONFIG_DIR: "/home/agent/workers/gh" });
  assert.deepEqual(workerAccount(undefined, { GH_CONFIG_DIR: "/home/me/gh" }), { GH_CONFIG_DIR: "/home/me/gh" }, "a laptop's host file declares no gh, and its gh is the environment's");
  assert.deepEqual(workerAccount({ workers: "relative/dir" }, {}), {}, "a folder that is not absolute names no account");
  assert.deepEqual(workerAccount(null, {}), {});
});

test("A11-106: the install command to paste names the account's folder when there is one", () => {
  assert.equal(installCommand({}), `gh extension install ${STACK_EXTENSION}`);
  assert.equal(installCommand({ GH_CONFIG_DIR: "/home/agent/workers/gh" }), `GH_CONFIG_DIR=/home/agent/workers/gh gh extension install ${STACK_EXTENSION}`);
});

test("A11-106: GitHub's answer for a repository is enabled on a list, refused on its 404, and unknown with the reason otherwise", async () => {
  const answer = (program: Program) => stacksOf(async () => program, "a11ign/agent-org");
  assert.deepEqual(await answer(ok("[]")), { kind: "enabled" });
  assert.deepEqual(await answer({ status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" }), { kind: "refused" });
  assert.deepEqual(await answer({ status: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)\n" }), { kind: "unknown", reason: "gh: Bad credentials (HTTP 401)" });
});

test("A11-106: the stacks question asks GitHub about the repository named", async () => {
  const asked: string[][] = [];
  await stacksOf(async (args) => { asked.push(args); return ok("[]"); }, "a11ign/agent-org");
  assert.deepEqual(asked, [["api", "repos/a11ign/agent-org/stacks"]]);
});

test("A11-106: a GitHub remote, https or ssh, names its owner and repository, and any other remote names none", () => {
  assert.equal(githubRepoOf("https://github.com/a11ign/agent-org.git"), "a11ign/agent-org");
  assert.equal(githubRepoOf("git@github.com:a11ign/agent-org.git"), "a11ign/agent-org");
  assert.equal(githubRepoOf("https://gitlab.com/a11ign/agent-org.git"), null);
  assert.equal(githubRepoOf(""), null);
});

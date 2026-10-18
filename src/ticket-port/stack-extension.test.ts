// no-token: none -- every runner is a fake: no GitHub CLI runs, and no extension is installed
import { test } from "node:test";
import assert from "node:assert/strict";
import { asAccount, ensureStackExtension, githubRepoOf, stackExtensionIn, stacksOf, type Program, type ProgramRunner } from "./stack-extension.ts";

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

test("A11-106: an account's runner sets the account's config directory for its call only, and puts the old value back", () => {
  const before = process.env.GH_CONFIG_DIR;
  process.env.GH_CONFIG_DIR = "/home/me/gh";
  try {
    let during: string | undefined;
    const run = asAccount(() => { during = process.env.GH_CONFIG_DIR; return "listed"; }, { GH_CONFIG_DIR: "/home/agent/workers/gh" });
    assert.deepEqual(run(["extension", "list"]), { status: 0, stdout: "listed", stderr: "" });
    assert.equal(during, "/home/agent/workers/gh", "the call runs as the workers' account");
    assert.equal(process.env.GH_CONFIG_DIR, "/home/me/gh", "and the environment is as it was");
  } finally {
    if (before === undefined) delete process.env.GH_CONFIG_DIR;
    else process.env.GH_CONFIG_DIR = before;
  }
});

test("A11-106: an account's runner turns a failed call into its status and its error output, and does not throw", () => {
  const failing = Object.assign(new Error("Command failed: gh api"), { status: 1, stderr: "gh: Not Found (HTTP 404)\n" });
  const run = asAccount(() => { throw failing; }, {});
  assert.deepEqual(run(["api", "repos/a11ign/nbl-ui-netbox/stacks"]), { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)\n" });
});

test("A11-106: GitHub's answer for a repository is enabled on a list, refused on its 404, and unknown with the reason otherwise", () => {
  const answer = (program: Program) => stacksOf(() => program, "a11ign/agent-org");
  assert.deepEqual(answer(ok("[]")), { kind: "enabled" });
  assert.deepEqual(answer({ status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" }), { kind: "refused" });
  assert.deepEqual(answer({ status: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)\n" }), { kind: "unknown", reason: "gh: Bad credentials (HTTP 401)" });
});

test("A11-106: the stacks question asks GitHub about the repository named", () => {
  const asked: string[][] = [];
  stacksOf((args) => { asked.push(args); return ok("[]"); }, "a11ign/agent-org");
  assert.deepEqual(asked, [["api", "repos/a11ign/agent-org/stacks"]]);
});

test("A11-106: a GitHub remote, https or ssh, names its owner and repository, and any other remote names none", () => {
  assert.equal(githubRepoOf("https://github.com/a11ign/agent-org.git"), "a11ign/agent-org");
  assert.equal(githubRepoOf("git@github.com:a11ign/agent-org.git"), "a11ign/agent-org");
  assert.equal(githubRepoOf("https://gitlab.com/a11ign/agent-org.git"), null);
  assert.equal(githubRepoOf(""), null);
});

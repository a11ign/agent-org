// no-token: none -- the runner is a fake: no GitHub CLI runs
import { test } from "node:test";
import assert from "node:assert/strict";
import { asAccount } from "./gh-account.ts";

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

// no-token: none -- `exec` is a recorder: no GitHub CLI runs
/**
 * A11-160 (step 7): WHAT A CLAIM'S `gh` IS RUN WITH. Its calls are the code host's now, and the code host's own runner cuts a call at 30 s; a claim's writes had no bound before, and a write cut after GitHub applied it
 * would be reported as a partial claim. So `claimGh` asks for its own bound and for `GIT_*` to be taken off (the spawn helper's old `sandboxGitEnv()`), and a code host that serves no rows is refused by name, not read as a
 * row that could not be read.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { CLAIM_CALL_MS, claimGh, fetchClaimComments, fetchLabels } from "./row-claim.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { fakePluginDeps } from "./plugins/fakes/deps.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { createCodeHost } from "../plugins/github/code-host.ts";

afterEach(() => forgetActivation());

test("a claim's `gh` is cut at the claim's bound and runs without the variables a hook sets", () => {
  const seen: { args: readonly string[]; options: { timeoutMs?: number; withoutEnv?: readonly string[] } }[] = [];
  substituteCodeHost(createCodeHost(fakePluginDeps({ env: { GIT_DIR: "/elsewhere/.git", HOME: "/home/x" }, exec: (_file, args, options) => { seen.push({ args, options: options ?? {} }); return { status: 0, stdout: "[]", stderr: "" }; } })));
  assert.equal(claimGh(["api", "repos/o/r/issues/1"]), "[]");
  assert.equal(seen[0].options.timeoutMs, CLAIM_CALL_MS);
  assert.ok(CLAIM_CALL_MS > 30_000, "longer than the code host's own cut, which would report a write that landed as one that did not");
  assert.deepEqual(seen[0].options.withoutEnv, ["GIT_DIR"]);
});

test("a claim's body with a leak in it is refused before `gh` is started", () => {
  const seen: unknown[] = [];
  substituteCodeHost(createCodeHost(fakePluginDeps({ exec: (_file, args) => { seen.push(args); return { status: 0, stdout: "", stderr: "" }; } })));
  assert.throws(() => claimGh(["issue", "comment", "1", "--body", "the host is at 192.168.1.20"]), /192\.168\.1\.20|leak/i);
  assert.deepEqual(seen, [], "nothing was sent");
});

test("a code host that serves no rows is refused by name when a claim reads a row, and not read as a row that could not be read", () => {
  substituteCodeHost({ ...createFakeCodeHost(), rows: undefined });
  assert.throws(() => fetchLabels(7), /row mode needs a code host that implements rows/);
  assert.throws(() => fetchClaimComments(7), /row mode needs a code host that implements rows/);
});

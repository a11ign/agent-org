/**
 * EVERY NETWORK/PROCESS LOOKUP THE RULES READ -- #455's split into `packages/agent-org/src/merge-guard/lookups.ts`.
 * `null` on failure, never an empty answer -- most of these need a live `gh`/`git` to exercise fully, so
 * only the offline-testable parsing is driven here; each rule's own test covers what the LOOKUP feeds it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupBranchTip, lookup, lookupRequiredContexts } from "../merge-guard/lookups.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";

test("lookupBranchTip reads the real tip of a real branch in this repo", () => {
  const tip = lookupBranchTip("main");
  assert.ok(tip, "main always has a tip");
  assert.match(tip as string, /^[0-9a-f]{40}$/, "a full sha, not an abbreviation or a ref name");
});

test("lookupBranchTip returns null for a branch that does not exist, never an empty string", () => {
  const tip = lookupBranchTip("this-branch-does-not-exist-294");
  assert.equal(tip, null);
});

test("lookup returns null on a thrown error, never lets the exception escape", () => {
  const result = lookup(() => {
    throw new Error("simulated failure");
  });
  assert.equal(result, null);
});

test("lookup returns the function's real result on success, including a falsy one", () => {
  assert.equal(lookup(() => 0), 0);
  assert.equal(lookup(() => ""), "");
  assert.equal(lookup(() => null), null);
});

/**
 * THE REQUIRED CONTEXTS ARE THE CODE HOST'S (#2331, A11-160 step 5). What the GitHub plugin ASKS -- `branches/main` and never the admin-only `branches/main/protection*`, which 404s for every agent
 * credential -- and how it reads the answer (a protected branch that shows no list is null, not a default) are asserted in `plugins/github/rows/merge-guard-reads.test.ts` ("#2331: ..."), against a
 * `gh` that plays the non-admin credential. HERE the lookup runs on the fake code host: it hands the rule what the code host answered, `null` where the code host had no list, and `null` -- never `[]` --
 * where the read was refused.
 */
test("lookupRequiredContexts hands the rule the contexts the code host answered, null for a branch that shows no list, and null for a refused read -- #2331's control", () => {
  const host = createFakeCodeHost();
  substituteCodeHost(host);
  try {
    host.rowsWorld.requiredContexts = ["gate"];
    assert.deepEqual(lookupRequiredContexts(), ["gate"]);
    host.rowsWorld.requiredContexts = null;
    assert.equal(lookupRequiredContexts(), null, "a protected branch showing no list is null, not a default: without this the test above is satisfied by a lookup that returns [\"gate\"] unconditionally");
    host.rowsWorld.requiredContexts = ["gate"];
    host.rowsWorld.failures.set("requiredContextsOf", new Error("HTTP 404"));
    assert.equal(lookupRequiredContexts(), null);
  } finally {
    forgetActivation();
  }
});

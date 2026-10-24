// no-token: none -- the labels are the fake code host's world; nothing here reaches GitHub
/**
 * #266 AND A11-160 (step 9): WHO HOLDS A PULL REQUEST IS READ FROM ITS LABELS, AND A READ THAT FAILED IS NEVER "NOBODY HOLDS IT". `prLabels` asks the code host's rows; an empty list reads as unheld, which is the answer that lets
 * a hold be handed out, so every way the read can fail -- a pull request the code host does not have, a refused read, a code host with no rows at all -- is `null`. How the labels are asked (`pr view --json labels`) and
 * what an answer that is not a list of named labels is are the plugin's (`plugins/github/rows/pullwork-rows.test.ts`); the CLI as a process, over a stub `gh`, is `src/packaging/pr-hold.test.ts`.
 */
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { prLabels } from "./pr-hold.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakePull } from "./plugins/fakes/code-host-pulls.ts";

let host = createFakeCodeHost();
beforeEach(() => { host = createFakeCodeHost(); substituteCodeHost(host); });
afterEach(() => forgetActivation());
const REPO = "a11ign/agent-org";

test("a pull request's labels are the code host's, and one with none is the empty list (a read that worked and found no holder)", () => {
  fakePull(host.rowsWorld, 5, { labels: ["hold:worker-1", "ready"] });
  fakePull(host.rowsWorld, 6);
  assert.deepEqual(prLabels(5, REPO), ["hold:worker-1", "ready"]);
  assert.deepEqual(prLabels(6, REPO), []);
});

test("NEVER `[]` ON FAILURE: a pull request the code host does not have, a read it refuses and a code host with no rows are each null", () => {
  fakePull(host.rowsWorld, 5, { labels: ["hold:worker-1"] });
  assert.equal(prLabels(99, REPO), null, "a pull request that cannot be read");
  host.rowsWorld.failures.set("heldPullLabelsOf", new Error("HTTP 502"));
  assert.equal(prLabels(5, REPO), null, "a refused read: the hold would be handed out on the strength of a network error");
  substituteCodeHost({ ...host, rows: undefined });
  assert.equal(prLabels(5, REPO), null, "a code host that cannot be reached");
});

// no-token: none -- the fake code host stands in for GitHub's; the runner a default is asked for is recorded, and nothing is started
/**
 * A11-160 (step 8): THE RUNNER THE CHAIRMAN'S WRITER AND WATCHER START `gh` WITH IS THE CODE HOST'S, UNDER THE POLICY THEY HAVE ALWAYS HAD. Their default `run` was `execFileAsync("gh", ..., { timeout, maxBuffer })`: stderr was
 * CAPTURED on the rejection and never let through to the unit's own, so `Label does not exist` (a resumed answer repeating a removal) did not appear in the journal as an error line. It is `rows().asyncRunnerWith(...)` now, and
 * `echo: false` is what keeps that: without it the plugin's runner tells every line `gh` printed on stderr to this process's own.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import type { RunnerRequest } from "../plugins/contracts/code-host-rows-facts.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow } from "../plugins/fakes/code-host-rows.ts";
import { createGithubWriter } from "./github-writer.ts";
import { createGhReader } from "./watch.ts";

afterEach(() => forgetActivation());

/** The fake code host in place, its asked-for runners recorded, and an operation that runs the default `run` its caller handed it once. */
function watched() {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.repo = "o/r";
  world.rows.set(7, fakeRow(world, 7, { state: "OPEN", labels: ["ready"] }));
  const asked: RunnerRequest[] = [];
  const rows = host.rows!;
  rows.asyncRunnerWith = (request = {}) => { asked.push(request); return async () => "[]"; };
  const readRow = rows.readRowAsync;
  rows.readRowAsync = async (request) => { await request.run(["issue", "view", "7", "-R", "o/r", "--json", "comments"]); return readRow(request); };
  const issueComments = rows.issueCommentsAsync;
  rows.issueCommentsAsync = async (request) => { await request.run(["issue", "view", "7", "-R", "o/r", "--json", "comments"]); return issueComments(request); };
  substituteCodeHost(host);
  return asked;
}

test("the writer's default run is the code host's async runner with the bound and the buffer it always had, and stderr kept to the failure", async () => {
  const asked = watched();
  await createGithubWriter().readRow({ repo: "o/r", number: 7 });
  assert.deepEqual(asked, [{ timeoutMs: 60_000, maxBuffer: 64_000_000, echo: false }]);
});

test("the watcher's default run is the same, and the read-only allowlist is still what stands between the reader and a write", async () => {
  const asked = watched();
  await createGhReader().issueComments({ repo: "o/r", number: 7 });
  assert.deepEqual(asked, [{ timeoutMs: 60_000, maxBuffer: 64_000_000, echo: false }]);
  const reader = createGhReader({ run: async () => "[]" });
  assert.equal(Array.isArray(await reader.issueComments({ repo: "o/r", number: 7 })), true, "an injected run is used as it is");
});

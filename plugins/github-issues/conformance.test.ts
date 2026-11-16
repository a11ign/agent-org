// no-token: gh -- GitHub is a recorded `fetch` that answers the REST calls from a small in-memory repository (`fake-github.ts`); nothing reaches GitHub
//
// THE TRACKER CONTRACT'S SUITE, RUN ON THE GITHUB ISSUES PLUGIN (A11-447): `runTrackerConformance` is the only definition of "a tracker", so the second tracker passes the same checks Linear does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTrackerConformance } from "../../src/plugins/conformance/tracker.ts";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import { defaultCatalog, pluginNamed } from "../../src/plugins/registry.ts";
import { FAKE_REPO, fakeGitHub, fakeIssue } from "./fake-github.ts";
import { create } from "./index.ts";

const TOKEN_FILE = "/k/github-issues.token";
const depsOver = (fetch: typeof globalThis.fetch) => fakePluginDeps({ fetch, readFile: (path) => (path === TOKEN_FILE ? "ghp_x\n" : (() => { throw new Error("ENOENT"); })()) });

test("the GitHub Issues plugin passes the tracker contract suite, every check its operations take part in", async () => {
  const github = fakeGitHub([fakeIssue(1), fakeIssue(2)]);
  const source = create({ repo: FAKE_REPO, token: { path: TOKEN_FILE } }, depsOver(github.fetch));
  const plugin = pluginNamed(defaultCatalog(), "github-issues");
  assert.equal(plugin?.concern, "tracker", "the registry finds the plugin as a tracker");
  const result = await runTrackerConformance(source, { known: "GH-1", missing: "GH-404", other: "GH-2" });
  assert.deepEqual(result.skipped.map(({ check }) => check).filter((check) => !check.startsWith("writing ") && !/^(people|scoped) /.test(check)), [],
    "the plugin implements every optional operation but people, scoped and the writer tooling, so the suite skips none other");
  for (const check of [
    "complete finishes a ticket once and leaves a finished one alone", "claim records the claimant, claims reads the latest one back, and a repeated claim changes nothing",
    "addBlockers records a relation once, and again without error", "readComments answers each comment's author, ISO time and body, and is refused for a key the tracker has none of",
    "detachPlan of a title the ticket has no attachment under changes nothing and is no error", "undoAutomaticCompletion answers who completed the ticket, moves back only the integration's completion, and is refused for a key the tracker has none of",
    "projects lists the open projects by id and name", "projectPage pages a project's tickets", "search of no words finds nothing",
  ]) assert.ok(result.passed.includes(check), `passed: ${check}`);
  assert.equal(github.held.get(1)?.state, "closed", "the suite's complete closed the issue in the recorded repository");
  assert.deepEqual(github.held.get(1)?.blockedBy, [2], "GH-2 blocks GH-1 once");
  assert.deepEqual(github.held.get(1)?.comments.map(({ body }) => body).filter((body) => body.startsWith("agent-org: claimed")), ["agent-org: claimed by conformance.a", "agent-org: claimed by conformance.b"], "the repeated claim wrote no comment");
  assert.ok(github.requests.every(({ path }) => !path.includes("://")), "every request went to the fake's API");
});

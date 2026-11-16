// no-token: gh -- GitHub is a recorded `fetch` that answers from an in-memory repository (`fake-github.ts`), and the board is the fault-injection fixture instance over in-memory fakes; nothing reaches GitHub
//
// A TICKET OF GITHUB ISSUES, END TO END ON FAKES (A11-447): the fixture instance's throwaway host file names `github-issues` as its tracker, the host file is read back through the settings reader, and the
// plugin is built from the block core resolved, with the deps core gives a tracker. A ticket read from the plugin is queued, its scripted worker opens a pull request and ends with `ready-pr`, GitHub merges it
// and cross-references it on the issue, and the board's own sweeps carry the ticket to closed, as a Linear ticket ends Done. The same run on the contract's in-memory fake (Linear's shape) is the comparison.
import { test } from "node:test";
import assert from "node:assert/strict";
import { depsFor, settingsOfBlock } from "../../src/plugins/loader.ts";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import { readyPr } from "../../src/ticket-mode/fault-injection/fault-pulls.ts";
import { fixtureInstance, type FixtureInstance, type FixtureTracker } from "../../src/ticket-mode/fault-injection/fixture-instance.ts";
import { PASS_MS, SETTLE_MS } from "../../src/ticket-mode/fault-injection/scenarios.ts";
import { FAKE_REPO, fakeGitHub, fakeIssue } from "./fake-github.ts";
import { create } from "./index.ts";
import { numberOf } from "./mapping.ts";

const TOKEN_FILE = "/fixture/github-issues.token";
const PREFIX = "GH";

/** The token file's text, and no other file: the plugin reads nothing else from disk. */
function readTokenFile(path: string): string {
  if (path !== TOKEN_FILE) throw new Error(`ENOENT: ${path}`);
  return "ghp_fixture\n";
}

/** GitHub Issues as the fixture's tracker: the block a host file names it by, built as the loader builds it, over `github`. */
function githubIssuesTracker(github: ReturnType<typeof fakeGitHub>): FixtureTracker {
  const deps = fakePluginDeps({ fetch: github.fetch, readFile: readTokenFile });
  return {
    block: { provider: "github-issues", repo: FAKE_REPO, prefix: PREFIX, token: { path: TOKEN_FILE } },
    build: (settings) => create(settingsOfBlock(settings.providers.blocks.tracker), depsFor("tracker", deps)),
    linkPull: (key, url, state) => github.linkPull(numberOf(PREFIX, key)!, url, state),
  };
}

/** The scripted worker of `key` starts, opens its pull request, and ends with `ready-pr`; then the board passes until `done` holds or the fixture's settle time is over. */
async function workAndMerge(fixture: FixtureInstance, key: string, done: () => boolean): Promise<void> {
  await fixture.pass();
  assert.equal(fixture.entry(key)?.phase, "running", `${key}'s run started`);
  fixture.working(key);
  await fixture.pass(PASS_MS);
  fixture.finish(key, readyPr(fixture.pulls.open(key, fixture.now())));
  const until = fixture.now() + SETTLE_MS;
  while (!done() && fixture.now() < until) await fixture.pass(PASS_MS);
}

test("a GitHub Issues ticket queued, worked and merged on fakes ends closed, as a Linear ticket ends Done", async () => {
  const github = fakeGitHub([fakeIssue(1, { labels: ["state: Todo"] })]);
  const fixture = fixtureInstance({ keys: ["GH-1"], tracker: githubIssuesTracker(github) });
  try {
    assert.equal(fixture.settings.providers.blocks.tracker.provider, "github-issues", "the host file read back names GitHub Issues as the tracker");
    const ticket = await fixture.source.read("GH-1");
    assert.equal(ticket?.status, "Todo");
    fixture.queueTickets([ticket!]);
    await workAndMerge(fixture, "GH-1", () => github.held.get(1)?.state === "closed");
    const issue = github.held.get(1)!;
    assert.equal(fixture.pulls.allMerged(), true, "the pull request merged");
    assert.equal(issue.state, "closed", "the issue is closed");
    assert.equal(issue.state_reason, "completed", "closed as completed, which the plugin reads as Done");
    assert.equal((await fixture.source.read("GH-1"))?.statusType, "completed", "the board reads the ticket back as Done");
    assert.equal(fixture.entry("GH-1")?.closedByBoard, true, "the board's own sweep completed it: GitHub does not read a closing word followed by GH-1");
    assert.ok(issue.comments.some(({ body }) => body.includes("merged") && body.includes("GH-1")), "the board said on the issue why it closed it");
  } finally {
    fixture.dispose();
  }
});

test("the same run on the contract's in-memory fake, Linear's shape, ends Done the same way", async () => {
  const fixture = fixtureInstance({ keys: ["FIX-1"] });
  try {
    await workAndMerge(fixture, "FIX-1", () => fixture.entry("FIX-1")?.closedByBoard === true);
    assert.equal(fixture.entry("FIX-1")?.closedByBoard, true);
    assert.equal((await fixture.source.read("FIX-1"))?.statusType, "completed");
  } finally {
    fixture.dispose();
  }
});

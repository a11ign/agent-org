// no-token: gh -- GitHub is the in-memory repository of `fake-github.ts` behind an injected `fetch`; nothing reaches GitHub or the Keychain
//
// THE GITHUB ISSUES PLUGIN'S OWN BEHAVIOUR (A11-447), past what the contract suite asks: how a ticket is read from an issue's labels, milestone and sub-issues, how a state move is written
// as labels, a plan kept as a comment, a closing by GitHub told from a person's, and a pull request linked by its cross-reference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import type { TicketSource } from "../../src/plugins/contracts/tracker.ts";
import { FAKE_REPO, type FakeIssue, fakeGitHub, fakeIssue } from "./fake-github.ts";
import { create } from "./index.ts";
import { numberOf, priorityOf, stateOf, ticketLabelsOf } from "./mapping.ts";

const TOKEN_FILE = "/k/token";
const PLAN = "/plans/A-0001-plan-x.md";

function sourceOver(issues: FakeIssue[], milestones: { number: number; title: string; description: string | null }[] = []): { source: TicketSource; github: ReturnType<typeof fakeGitHub> } {
  const github = fakeGitHub(issues, milestones);
  const files: Record<string, string> = { [TOKEN_FILE]: "ghp_x\n", [PLAN]: "# The plan\n" };
  const readFile = (path: string): string => {
    if (path in files) return files[path];
    throw new Error(`ENOENT: ${path}`);
  };
  return { source: create({ repo: FAKE_REPO, token: { path: TOKEN_FILE } }, fakePluginDeps({ fetch: github.fetch, readFile })), github };
}

test("the mapping: a state label, a closing reason, a priority label and a label group each read as Linear's", () => {
  assert.equal(stateOf({ state: "open", state_reason: null }, []).name, "Backlog", "an open issue with no state label is in Backlog");
  assert.equal(stateOf({ state: "open", state_reason: null }, ["state: Todo", "State: in progress"]).name, "In Progress", "the later of two state labels, in any case");
  assert.equal(stateOf({ state: "open", state_reason: null }, ["state: Done", "state: Nowhere"]).name, "Backlog", "a state label naming a closed or unknown state is ignored");
  assert.deepEqual(["completed", "not_planned", "duplicate", null].map((reason) => stateOf({ state: "closed", state_reason: reason }, []).name), ["Done", "Canceled", "Duplicate", "Done"]);
  assert.deepEqual([priorityOf([]), priorityOf(["priority: low", "priority: High"]), priorityOf(["priority: someday"])], [0, 2, 0]);
  assert.deepEqual(ticketLabelsOf(["Bucket: Bug", "docs", "state: Todo", "priority: low"]), [{ name: "Bug", group: "Bucket" }, { name: "docs", group: null }]);
  assert.deepEqual([numberOf("GH", "gh-12"), numberOf("GH", "XY-12"), numberOf("GH", "GH-")], [12, null, null]);
});

test("read gives an issue's state, priority, labels, milestone, parent and open sub-issues; a pull request's number is no ticket", async () => {
  const { source } = sourceOver([
    fakeIssue(1, { labels: ["state: Todo", "priority: urgent", "Bucket: Bug"], milestone: 3 }), fakeIssue(2, { parent: 1 }), fakeIssue(3, { parent: 1, state: "closed", state_reason: "completed" }),
    fakeIssue(4, { pullRequest: true }),
  ], [{ number: 3, title: "Ticket mode", description: "github.com/acme/app" }]);
  const ticket = await source.read("GH-1");
  assert.deepEqual(ticket && { status: ticket.status, statusType: ticket.statusType, priority: ticket.priority, labels: ticket.labels, project: ticket.project, projectSummary: ticket.projectSummary, children: ticket.children, branch: ticket.branch },
    { status: "Todo", statusType: "unstarted", priority: 1, labels: [{ name: "Bug", group: "Bucket" }], project: "Ticket mode", projectSummary: "github.com/acme/app", children: ["GH-2"], branch: "gh-1" });
  assert.equal((await source.read("GH-2"))?.parent, "GH-1");
  assert.equal(await source.read("GH-4"), null, "a pull request shares the issue numbers, and is not a ticket");
  assert.deepEqual((await source.assigned()).map(({ key }) => key), ["GH-1", "GH-2"], "the token holder's open issues, without the closed one or the pull request");
});

test("a state move writes the state label, a move back takes it off, and a name outside the workflow keeps the state with a note", async () => {
  const { source, github } = sourceOver([fakeIssue(1)]);
  const started = await source.moveToWorkingState!("GH-1", "In Progress");
  assert.deepEqual(started, { moved: { from: "Backlog", to: "In Progress" }, note: null });
  assert.deepEqual(github.held.get(1)?.labels, ["state: In Progress"]);
  assert.deepEqual(await source.moveToWorkingState!("GH-1", "In Progress"), { moved: null, note: null }, "a started ticket is left where it is");
  assert.equal(await source.restoreState!("GH-1", started.moved!), null);
  assert.deepEqual(github.held.get(1)?.labels, [], "back in Backlog, which has no label");
  assert.match((await source.moveToWorkingState!("GH-1", "Doing")).note ?? "", /no state named "Doing"/);
});

test("a plan is kept as a comment once, moves a Backlog ticket to the planned state, downloads as its file, and a re-plan deletes it", async () => {
  const { source, github } = sourceOver([fakeIssue(1)]);
  assert.equal(await source.attachPlan!("GH-1", [PLAN], "Planned"), null);
  await source.attachPlan!("GH-1", [PLAN], "Planned");
  assert.equal(github.held.get(1)?.comments.length, 1, "the file already kept is not posted again");
  const ticket = await source.read("GH-1");
  assert.deepEqual([ticket?.status, ticket?.uploads], ["Planned", ["A-0001-plan-x.md"]]);
  assert.deepEqual((await source.readComments!("GH-1")).comments, [], "a plan comment is a file, not discussion");
  const dir = mkdtempSync(join(tmpdir(), "github-issues-"));
  try {
    const [path, ...rest] = await source.download(ticket!, dir);
    assert.deepEqual([readFileSync(path, "utf8"), rest], ["# The plan\n", []]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await source.detachPlan!("GH-1", ["A-0001-plan-x.md"]);
  assert.deepEqual((await source.read("GH-1"))?.uploads, []);
});

test("undoAutomaticCompletion reopens an issue GitHub closed from a commit, in its labelled state, and leaves a person's closing alone", async () => {
  const byCommit = { event: "closed", commit_id: "abc123", actor: { type: "User" } };
  const byPerson = { event: "closed", commit_id: null, actor: { type: "User" } };
  const { source, github } = sourceOver([
    fakeIssue(1, { state: "closed", state_reason: "completed", labels: ["state: In Review"], events: [byCommit] }), fakeIssue(2, { state: "closed", state_reason: "completed", events: [byPerson] }), fakeIssue(3),
  ]);
  assert.deepEqual(await source.undoAutomaticCompletion!("GH-1", "partial: reopened"), { reopened: { from: "Done", to: "In Review" }, by: "integration", note: null });
  assert.deepEqual([github.held.get(1)?.state, github.held.get(1)?.comments.map(({ body }) => body)], ["open", ["partial: reopened"]]);
  assert.deepEqual(await source.undoAutomaticCompletion!("GH-2", "x"), { reopened: null, by: "person", note: null });
  assert.equal(github.held.get(2)?.state, "closed");
  assert.equal((await source.undoAutomaticCompletion!("GH-3", "x")).by, "none");
});

test("complete closes an open ticket with its comment and leaves a canceled one alone", async () => {
  const { source, github } = sourceOver([fakeIssue(1), fakeIssue(2, { state: "closed", state_reason: "not_planned" })]);
  await source.complete!("GH-1", "merged: done");
  assert.deepEqual([github.held.get(1)?.state, github.held.get(1)?.state_reason, github.held.get(1)?.comments.map(({ body }) => body)], ["closed", "completed", ["merged: done"]]);
  await source.complete!("GH-2", "merged: done");
  assert.deepEqual([github.held.get(2)?.state_reason, github.held.get(2)?.comments], ["not_planned", []]);
});

test("pull requests are read from the issue's cross-references, and a blocker carries its branch and pull requests", async () => {
  const pull = { html_url: "https://github.com/acme/app/pull/9", title: "feat: the fix", state: "closed", merged_at: "2026-11-13T10:00:00Z" };
  const { source } = sourceOver([fakeIssue(1, { blockedBy: [2] }), fakeIssue(2, { labels: ["state: In Review"], crossReferences: [pull] })]);
  assert.deepEqual((await source.pullStates!(["GH-2"])).get("GH-2"), { [pull.html_url]: "merged" });
  assert.deepEqual((await source.blockers!(["GH-1", "GH-404"])).get("GH-1"),
    [{ key: "GH-2", state: "started", status: "In Review", branch: "gh-2", pulls: { [pull.html_url]: "merged" }, titles: { [pull.html_url]: "feat: the fix" } }]);
});

test("the settings are refused by name: a repository that is not owner/name, a prefix that is not a word, and an unreadable token", () => {
  const deps = fakePluginDeps();
  assert.throws(() => create({ repo: "tracker" }, deps), /tickets\.providers\.tracker\.repo must name the repository/);
  assert.throws(() => create({ repo: FAKE_REPO, prefix: "G H" }, deps), /tickets\.providers\.tracker\.prefix must be letters/);
  assert.throws(() => create({ repo: FAKE_REPO, token: { path: "/k/none" } }, deps), /the GitHub token file \/k\/none cannot be read/);
});

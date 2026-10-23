// no-token: none -- the fake acts on a world held in memory; nothing here reaches GitHub
/**
 * A11-160 (step 8): THE FAKE CODE HOST'S OPERATIONS FOR THE BOARD'S READS AND POSTS. Core's tests of the board (the report, the document, the Discussion carrier, the truth audit, the schedule's liveness) run on this fake,
 * so these cases hold what they rely on: the issues page by cursor and its totals; a listing by state that a test can refuse one state of; a repository the code host refuses; the Discussions the carrier creates and
 * updates; the draft release's three states; the `Roadmap` answer capped at the items the code host asks for; and the day's comment, issue and label-event reads the prose audit makes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "./code-host.ts";
import { fakeRow } from "./code-host-rows.ts";

const refused = (): string => {
  throw new Error("the fake acts on its own state: no run is made");
};

test("the issues page by cursor: a hundred at a time, oldest first, with the total, the next cursor, and each row's labels and milestone as nodes", () => {
  const host = createFakeCodeHost();
  host.rowsWorld.repo = "x/y";
  const milestone = { number: 1, title: "v0.1.0", description: null, dueOn: null };
  for (let number = 1; number <= 250; number++) host.rowsWorld.rows.set(number, fakeRow(host.rowsWorld, number, { labels: ["ready"], ...(number === 1 ? { milestone } : {}) }));
  const first = host.rows!.issuePageOf({ repo: "x/y", after: null, run: refused }).data.repository.issues;
  assert.equal(first.totalCount, 250);
  assert.equal(first.nodes.length, 100);
  assert.deepEqual(first.pageInfo, { hasNextPage: true, endCursor: "100" });
  assert.deepEqual(first.nodes[0].labels, { totalCount: 1, nodes: [{ name: "ready" }] });
  assert.deepEqual(first.nodes[0].milestone, milestone);
  assert.equal(first.nodes[1].milestone, null);
  const last = host.rows!.issuePageOf({ repo: "x/y", after: "200", run: refused }).data.repository.issues;
  assert.deepEqual([last.nodes.length, last.pageInfo], [50, { hasNextPage: false, endCursor: null }]);
  assert.deepEqual(last.nodes.map((n: any) => n.number).slice(0, 2), [201, 202]);
});

test("a listing by state is the newest first and cut at the limit, and a test can refuse one state of it, or one repository", () => {
  const host = createFakeCodeHost();
  host.rowsWorld.repo = "x/y";
  host.rowsWorld.rows.set(1, fakeRow(host.rowsWorld, 1, { labels: ["ready"] }));
  host.rowsWorld.rows.set(2, fakeRow(host.rowsWorld, 2, { state: "CLOSED", closedAt: "2026-10-01T00:00:00Z" }));
  host.rowsWorld.rows.set(3, fakeRow(host.rowsWorld, 3, { labels: ["backlog"], blockedBy: [2] }));
  host.rowsWorld.foreignRows.set("x/other#9", fakeRow(host.rowsWorld, 9, { labels: ["ready"] }));
  const list = (repo: string, state: "open" | "closed", limit = 10, fields = "number,labels,blockedBy") => host.rows!.rowsListedIn({ repo, state, limit, fields, run: refused });
  assert.deepEqual(list("x/y", "open").map((r) => r.number), [3, 1]);
  assert.deepEqual(list("x/y", "open", 1).map((r) => r.number), [3]);
  assert.deepEqual(list("x/y", "closed").map((r) => r.number), [2]);
  assert.deepEqual(list("x/y", "open")[0].blockedBy, { totalCount: 1, nodes: [{ number: 2, state: "CLOSED" }] }, "the edge is a connection, with the blocker's own state");
  assert.deepEqual(list("x/other", "open").map((r) => r.number), [9], "another repository's rows are its own");
  assert.deepEqual(Object.keys(list("x/y", "open", 10, "number")[0]), ["number"], "only the fields asked");
  host.rowsWorld.failures.set("rowsListedIn closed", new Error("HTTP 502"));
  assert.throws(() => list("x/y", "closed"), /502/);
  assert.equal(list("x/y", "open").length, 2, "and the other state is read");
  host.rowsWorld.reports.board.refusals.set("x/other", new Error("HTTP 403 from x/other"));
  assert.throws(() => list("x/other", "open"), /403 from x\/other/);
  assert.throws(() => host.rows!.issuePageOf({ repo: "x/other", after: null, run: refused }), /403/);
  assert.equal(list("x/y", "open").length, 2, "and only that repository");
});

test("merged pull requests are the newest first with the fields asked, the world's own for its repository and `pullsByRepo`'s for another, and open ones are not merged ones", () => {
  const host = createFakeCodeHost();
  host.rowsWorld.repo = "x/y";
  const pull = (number: number, over: object = {}) => ({ number, body: `Closes #${number}`, headRefName: `agent/p-${number}`, labels: [], isDraft: false, armed: false, merged: true, mergedAt: `2026-10-0${number}T00:00:00Z`, createdAt: "2026-10-01T00:00:00Z", comments: [], ...over });
  host.rowsWorld.pulls.set(1, pull(1));
  host.rowsWorld.pulls.set(2, pull(2));
  host.rowsWorld.pulls.set(3, pull(3, { merged: false, mergedAt: null }));
  host.rowsWorld.reports.board.pullsByRepo.set("x/code", [pull(7)]);
  const merged = (repo: string, fields = "number,body,mergedAt") => host.rows!.pullsListedIn({ repo, state: "merged", limit: 10, fields, run: refused });
  assert.deepEqual(merged("x/y"), [{ number: 2, body: "Closes #2", mergedAt: "2026-10-02T00:00:00Z" }, { number: 1, body: "Closes #1", mergedAt: "2026-10-01T00:00:00Z" }]);
  assert.deepEqual(merged("x/code").map((p) => p.number), [7]);
  assert.deepEqual(merged("x/unheld"), [], "a repository with no pull requests lists none");
  assert.deepEqual(host.rows!.pullsListedIn({ repo: "x/y", state: "open", limit: 10, fields: "number", run: refused }), [{ number: 3 }]);
  host.rowsWorld.failures.set("pullsListedIn merged", new Error("HTTP 502"));
  assert.throws(() => merged("x/y"), /502/);
});

test("the editions: a repository the world holds no Discussions of is refused, a created one is the newest and carries its category, an updated one has the new body, and an unknown id is refused", () => {
  const host = createFakeCodeHost();
  assert.throws(() => host.rows!.discussionCategoriesOf({ owner: "x", name: "y", run: refused }), /holds no Discussions of x\/y/);
  host.rowsWorld.reports.board.discussions.set("x/y", { repositoryId: "R_1", categories: [{ id: "C_1", slug: "board-editions" }], editions: [{ id: "D_old", title: "old", url: "u/old", body: "b" }] });
  assert.deepEqual(host.rows!.discussionCategoriesOf({ owner: "x", name: "y", run: refused }), { repository: { id: "R_1", discussionCategories: { nodes: [{ id: "C_1", slug: "board-editions" }] } } });
  const created = host.rows!.createDiscussion({ repositoryId: "R_1", categoryId: "C_1", title: "new", body: "the edition", run: refused });
  const editions = host.rows!.discussionEditionsOf({ owner: "x", name: "y", categoryId: "C_1", run: refused }).repository.discussions.nodes;
  assert.deepEqual(editions.map((e: any) => e.title), ["new", "old"]);
  assert.equal(created.createDiscussion.discussion.url, editions[0].url);
  assert.deepEqual(host.rowsWorld.reports.board.discussions.get("x/y")!.editions[0], { id: editions[0].id, title: "new", url: editions[0].url, body: "the edition", categoryId: "C_1" });
  host.rows!.updateDiscussion({ discussionId: "D_old", body: "replaced", run: refused });
  assert.equal(host.rowsWorld.reports.board.discussions.get("x/y")!.editions[1].body, "replaced");
  assert.throws(() => host.rows!.updateDiscussion({ discussionId: "D_none", body: "x", run: refused }), /holds no Discussion D_none/);
  assert.throws(() => host.rows!.createDiscussion({ repositoryId: "R_none", categoryId: "C", title: "t", body: "b", run: refused }), /holds no repository R_none/);
});

test("the draft release: none is `null`, a created one is a draft with the file, an upload replaces an asset of the same name, and an upload to no release is refused", () => {
  const host = createFakeCodeHost();
  const ask = () => host.rows!.draftReleaseOf({ repo: "x/y", tag: "board/2026-10-16", run: refused });
  assert.equal(ask(), null);
  host.rows!.createDraftRelease({ repo: "x/y", tag: "board/2026-10-16", file: "a.pdf", title: "t", notes: "n", run: refused });
  assert.deepEqual(ask(), { isDraft: true });
  host.rows!.uploadReleaseAsset({ repo: "x/y", tag: "board/2026-10-16", file: "b.pdf", run: refused });
  host.rows!.uploadReleaseAsset({ repo: "x/y", tag: "board/2026-10-16", file: "a.pdf", run: refused });
  assert.deepEqual(host.rowsWorld.reports.board.releases.get("x/y@board/2026-10-16")!.assets, ["b.pdf", "a.pdf"]);
  assert.throws(() => host.rows!.uploadReleaseAsset({ repo: "x/y", tag: "none", file: "a.pdf", run: refused }), /holds no release x\/y@none/);
  host.rowsWorld.reports.board.releases.set("x/y@published", { isDraft: false, assets: [] });
  assert.deepEqual(host.rows!.draftReleaseOf({ repo: "x/y", tag: "published", run: refused }), { isDraft: false });
});

test("a workflow's runs are the newest first, cut at the limit, with the fields asked; its registration date is as seeded; an unseeded workflow is refused", () => {
  const host = createFakeCodeHost();
  host.rowsWorld.reports.board.workflowRuns.set("x/y@trunk.yml", [{ createdAt: "3", event: "push", status: "completed" }, { createdAt: "2", event: "schedule", status: "queued" }, { createdAt: "1", event: "push", status: "completed" }]);
  host.rowsWorld.reports.board.workflowCreated.set("x/y@trunk.yml", "2026-09-06T16:23:01.000+01:00");
  assert.deepEqual(host.rows!.workflowRunListOf({ repo: "x/y", workflow: "trunk.yml", fields: "createdAt,event", limit: 2, run: refused }), [{ createdAt: "3", event: "push" }, { createdAt: "2", event: "schedule" }]);
  assert.equal(host.rows!.workflowCreatedAtOf({ repo: "x/y", workflow: "trunk.yml", run: refused }), "2026-09-06T16:23:01.000+01:00");
  assert.throws(() => host.rows!.workflowRunListOf({ repo: "x/y", workflow: "board-liveness.yml", fields: "createdAt", limit: 2, run: refused }), /holds no runs of x\/y@board-liveness\.yml/);
});

test("the Roadmap answer: a row the world holds (or has an entry for) is answered, a parent chain is nested with each node's own repository, items past the twenty asked are counted and cut, and an absent row has no alias", () => {
  const host = createFakeCodeHost();
  host.rowsWorld.repo = "x/y";
  host.rowsWorld.rows.set(1, fakeRow(host.rowsWorld, 1));
  host.rowsWorld.rows.set(2, fakeRow(host.rowsWorld, 2));
  const roadmaps = host.rowsWorld.reports.board.roadmaps;
  roadmaps.set(10, { items: [{ owner: "a11ign", project: 2, value: "Self-healing org" }], parent: null, repo: "x/other" });
  roadmaps.set(1, { items: [{ owner: "a11ign", project: 2, value: null }, { owner: "a11ign", project: 3, value: "Spend" }], parent: 10 });
  roadmaps.set(2, { items: Array.from({ length: 21 }, (_, i) => ({ owner: "a11ign", project: i + 1, value: null })), parent: null });
  const answer = host.rows!.roadmapFactsOf({ repo: "x/y", numbers: [1, 2, 3], run: refused });
  assert.deepEqual(Object.keys(answer), ["r1", "r2"], "row 3 is nowhere");
  assert.deepEqual(answer.r1.projectItems.nodes, [{ project: { number: 2, owner: { login: "a11ign" } }, value: null }, { project: { number: 3, owner: { login: "a11ign" } }, value: { name: "Spend" } }]);
  assert.equal(answer.r1.repository.nameWithOwner, "x/y");
  assert.deepEqual([answer.r1.parent.number, answer.r1.parent.repository.nameWithOwner, answer.r1.parent.projectItems.nodes[0].value], [10, "x/other", { name: "Self-healing org" }]);
  assert.deepEqual([answer.r2.projectItems.totalCount, answer.r2.projectItems.nodes.length], [21, 20]);
  assert.equal(host.rows!.roadmapFactsOf({ repo: "x/y", numbers: [10], run: refused }).r10.number, 10, "an entry alone is answered for");
});

test("the comments: the edition's count is by title since a time, the heading's ids are one per line, the org's comments carry their row and author, and a row the world lacks is refused", () => {
  const host = createFakeCodeHost();
  host.rowsWorld.repo = "x/y";
  host.rowsWorld.rows.set(20, fakeRow(host.rowsWorld, 20, { comments: [
    { id: 1, body: "# Board report — 2026-10-15\nyesterday", createdAt: "2026-10-15T07:00:00Z", author: "a11ign-ai-workers" },
    { id: 2, body: "# Board report — 2026-10-16\ntoday", createdAt: "2026-10-16T07:00:00Z", author: "a11ign-ai-workers" },
    { id: 3, body: "# Board report — 2026-10-16\nold", createdAt: "2026-10-01T07:00:00Z", author: "someone" },
  ] }));
  const count = (title: string, since: string) => host.rows!.editionCommentCountOf({ repo: "x/y", issue: "20", since, title, run: refused });
  assert.equal(count("# Board report — 2026-10-16", "2026-10-14T00:00:00Z"), 1, "the one inside the window");
  assert.equal(count("# Board report — 2026-10-16", "2026-09-01T00:00:00Z"), 2);
  assert.equal(count("# Board report — 2026-10-17", "2026-09-01T00:00:00Z"), 0);
  assert.equal(host.rows!.headedCommentIdsText({ repo: "x/y", row: "20", since: "2026-09-01T00:00:00Z", heading: "# Board report", run: refused }), "1\n2\n3\n");
  assert.deepEqual(host.rows!.commentBodiesOfIssue({ repo: "x/y", number: 20, run: refused }).map((b) => b.split("\n")[0]), ["# Board report — 2026-10-15", "# Board report — 2026-10-16", "# Board report — 2026-10-16"]);
  const org = host.rows!.orgCommentsSinceOf({ repo: "x/y", since: "2026-10-14T00:00:00Z", loginPrefix: "a11ign-", run: refused });
  assert.deepEqual(org.map((c) => [c.number, c.author.login, c.url]), [[20, "a11ign-ai-workers", "https://github.com/x/y/issues/20#issuecomment-1"], [20, "a11ign-ai-workers", "https://github.com/x/y/issues/20#issuecomment-2"]]);
  assert.equal(host.rows!.commentAuthorOf({ repo: "x/y", id: "3", run: refused }), "someone");
  assert.throws(() => host.rows!.commentAuthorOf({ repo: "x/y", id: "99", run: refused }), /holds no comment 99/);
  assert.throws(() => host.rows!.commentBodiesOfIssue({ repo: "x/y", number: 21, run: refused }), /holds no row x\/y#21/);
});

test("the issues since a time carry their state, author and text, a row last updated earlier is left out, and a row's labeled events come from the world's label history (a refused history is refused)", () => {
  const host = createFakeCodeHost();
  host.rowsWorld.repo = "x/y";
  host.rowsWorld.rows.set(1, fakeRow(host.rowsWorld, 1, { title: "one", body: "the body", openedBy: "a11ign-ai-leads", createdAt: "2026-10-08T10:00:00Z" }));
  host.rowsWorld.rows.set(2, fakeRow(host.rowsWorld, 2, { title: "two", state: "CLOSED", createdAt: "2026-09-01T00:00:00Z", closedAt: "2026-09-02T00:00:00Z" }));
  assert.deepEqual(host.rows!.issuesSinceOf({ repo: "x/y", since: "2026-10-07T00:00:00Z", run: refused }), [{ number: 1, state: "open", author: "a11ign-ai-leads", createdAt: "2026-10-08T10:00:00Z", text: "one\nthe body" }]);
  assert.deepEqual(host.rows!.issuesSinceOf({ repo: "x/y", since: "2026-09-01T00:00:00Z", run: refused }).map((i) => [i.number, i.state]), [[1, "open"], [2, "closed"]]);
  host.rowsWorld.gate.events.set(1, [{ event: "labeled", label: "answer:ceo", actor: "a11ign-ai-leads", at: "2026-10-08T10:05:00Z" }, { event: "unlabeled", label: "answer:ceo", actor: "x", at: "2026-10-08T10:06:00Z" }]);
  assert.deepEqual(host.rows!.labeledEventsOfRow({ repo: "x/y", number: 1, run: refused }), [{ number: 1, label: "answer:ceo", actor: "a11ign-ai-leads", createdAt: "2026-10-08T10:05:00Z" }]);
  assert.deepEqual(host.rows!.labeledEventsOfRow({ repo: "x/y", number: 2, run: refused }), []);
  host.rowsWorld.gate.events.set(2, new Error("HTTP 502"));
  assert.throws(() => host.rows!.labeledEventsOfRow({ repo: "x/y", number: 2, run: refused }), /502/);
});

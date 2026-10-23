// no-token: REPO
// This file imports board-data.ts, whose closure reads REPO. Every test here reads the issues through the fake code host's rows; nothing here calls or spawns `gh` (#2435).
/**
 * #2435: `issues()` pages to exhaustion. It refused a listing of exactly its 1000-row limit, and the tracker passed
 * 1000, so `npm run board:report`, `board-document.ts` and `collect()` all failed together. Raising the number only
 * moves the cliff; the read now walks the cursor and proves completeness against the tracker's own `totalCount`.
 *
 * POSITIVE CONTROL for every refusal below: `trackerOf` over the intact fixture is the one that must return all
 * rows (first test), so the refusals cannot be passing because the fixture is unreadable.
 *
 * A11-160, STEP 8: THE PAGES ARE THE CODE HOST'S (`issuePageOf`), so the tracker is the fake code host holding its rows and paging them honestly; a case that needs a page GitHub would not give (a total that is short, a cursor
 * that stands still, a shape that is no page) changes the honest page, and what `issues()` makes of it is what is asserted. The GraphQL document and its `after` variable are the plugin's (`plugins/github/rows/board-rows.test.ts`).
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { issues } from "../board-data.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow } from "../plugins/fakes/code-host-rows.ts";
import { watchedRows } from "../plugins/fakes/watched-rows.test.support.ts";

afterEach(() => forgetActivation());

const REPO_UNDER_TEST = "x/y";
const OLD_LIMIT = 1000; // the `--limit` the read used to refuse at
const TRACKER = OLD_LIMIT + 201; // what the live tracker held when #2435 was filed

/**
 * The fake code host holding `total` rows (odd ones open, even ones closed), and every page the board asked for (`pages`: the cursor of each). `fault` changes the page the code host answers, to say what the fake's honest
 * paging cannot: a page that fails, a total that is short, a cursor that stands still, a shape that is not a page. THE FAKE'S PAGES ARE THE HONEST ONES; what `issues()` makes of a dishonest one is the board's decision.
 */
function trackerOf(total: number, fault: (page: any, after: string | null) => any = (page) => page) {
  const host = createFakeCodeHost();
  host.rowsWorld.repo = REPO_UNDER_TEST;
  for (let number = 1; number <= total; number++) {
    host.rowsWorld.rows.set(number, fakeRow(host.rowsWorld, number, { title: `row ${number}`, labels: ["ready"], state: number % 2 ? "OPEN" : "CLOSED", closedAt: number % 2 ? null : "2026-09-01T00:00:00Z" }));
  }
  const pages: (string | null)[] = [];
  const watched = watchedRows(host);
  const honest = watched.host.rows!.issuePageOf;
  watched.host.rows!.issuePageOf = (request) => { pages.push(request.after); return fault(honest(request), request.after); };
  substituteCodeHost(watched.host);
  return { pages };
}
const read = () => issues({ repo: REPO_UNDER_TEST });
/** One page of one node, as GitHub states a tracker of one row, for the cases that corrupt a page. */
const page = (nodes: unknown[], more: Record<string, unknown> = {}) => ({ data: { repository: { issues: { totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes, ...more } } } });
const row1 = (over: Record<string, unknown> = {}) => ({ number: 1, title: "row 1", state: "OPEN", closedAt: null, createdAt: "2026-09-01T00:00:00Z", url: "https://github.com/x/y/issues/1", labels: { totalCount: 1, nodes: [{ name: "ready" }] }, milestone: null, ...over });

test("#2435: a tracker larger than the old 1000-row limit comes back whole, none twice, in the old row shape", () => {
  const { pages } = trackerOf(TRACKER);
  const all = read();
  assert.equal(all.length, TRACKER);
  assert.equal(new Set(all.map((i: { number: number }) => i.number)).size, TRACKER, "a row came back twice");
  assert.equal(pages.length, 13, "1201 rows at 100 a page is 13 reads");
  assert.equal(pages[0], null, "the first read starts at the first page");
  assert.equal(new Set(pages).size, 13, "and every other read starts at a cursor of its own");
  const row = all[0];
  assert.deepEqual(Object.keys(row).sort(),
    ["closedAt", "createdAt", "labelNames", "labels", "milestone", "number", "state", "title", "url"]);
  assert.deepEqual(row.labelNames, ["ready"]);
  assert.deepEqual(row.labels, [{ name: "ready" }]);
});

test("#2435: exactly one page over the old limit is not refused (the case the old check could not tell apart)", () => {
  trackerOf(OLD_LIMIT);
  assert.equal(read().length, OLD_LIMIT);
});

test("#2435 POSITIVE CONTROL: the same fixture with its FINAL page failing REFUSES, naming that it could not prove completeness", () => {
  trackerOf(TRACKER, (honestPage, after) => {
    if (after !== null && Number(after) >= TRACKER - 1) throw new Error("HTTP 502 from GraphQL");
    return honestPage;
  });
  assert.throws(() => read(), (e: Error) => {
    assert.match(e.message, /could not be proved complete/);
    assert.match(e.message, new RegExp(`after ${TRACKER - 1} rows`), "must say how much it had read, not return it");
    assert.match(e.message, /HTTP 502/, "the underlying failure travels with the refusal");
    assert.equal((e.cause as Error | undefined)?.message, "HTTP 502 from GraphQL");
    return true;
  });
});

test("#2435: a repository the code host refuses REFUSES the listing, naming that nothing was read", () => {
  const refused = createFakeCodeHost();
  refused.rowsWorld.repo = REPO_UNDER_TEST;
  refused.rowsWorld.reports.board.refusals.set(REPO_UNDER_TEST, new Error("HTTP 403 from GraphQL"));
  substituteCodeHost(refused);
  assert.throws(() => read(), /failed after 0 rows, so it could not be proved complete[^]*HTTP 403/);
});

test("#2435: a shortfall against the tracker's own totalCount refuses", () => {
  trackerOf(250, (honestPage) => { honestPage.data.repository.issues.totalCount = 251; return honestPage; });
  assert.throws(() => read(), /250 rows \(250 distinct\) against the 251 the tracker reports, so it could not be proved complete/);
});

test("#2435: a cursor that does not advance refuses instead of looping", () => {
  trackerOf(300, (honestPage, after) => { honestPage.data.repository.issues.pageInfo.endCursor = after ?? "0"; return honestPage; });
  assert.throws(() => read(), /could not be proved complete.*the cursor did not advance/);
});

test("#2435: an issue whose labels were cut off by the label page refuses", () => {
  trackerOf(1, (honestPage) => { honestPage.data.repository.issues.nodes[0].labels.totalCount = 101; return honestPage; });
  assert.throws(() => read(), /#1 carries 101 labels and only 1 were read/);
});

test("#2435: an unexpected response shape refuses rather than reporting an empty tracker", () => {
  trackerOf(1, () => ({ errors: [{ message: "rate limited" }] }));
  assert.throws(() => read(), /could not be proved complete.*unexpected response shape/);
});

test("#2435: a page with no pageInfo refuses as a shape error, even when its row count matches totalCount", () => {
  // The count check alone would pass this one-row page, so only the shape guard can refuse it.
  const onePage = (pageInfo?: unknown) => () => ({ data: { repository: { issues: { totalCount: 1, ...(pageInfo === undefined ? {} : { pageInfo }), nodes: [row1()] } } } });
  trackerOf(1, onePage());
  assert.throws(() => read(), /could not be proved complete.*unexpected response shape/);
  trackerOf(1, onePage({ endCursor: null }));
  assert.throws(() => read(), /unexpected response shape/, "pageInfo without a boolean hasNextPage is no better");
  trackerOf(1, onePage({ hasNextPage: false, endCursor: null }));
  assert.equal(read().length, 1, "positive control: the intact page reads");
});

test("#2435: a page with no pageInfo AND a shortfall refuses, and names the shape rather than the count", () => {
  trackerOf(1, () => ({ data: { repository: { issues: { totalCount: 5, nodes: [row1()] } } } }));
  assert.throws(() => read(), /unexpected response shape/);
});

// no-token: REPO
// This file imports board-data.ts, whose closure reads REPO and can spawn `gh`. Every test here hands `issues()` a
// recorded `run`; nothing here calls or spawns `gh` (#2435).
/**
 * #2435: `issues()` pages to exhaustion. It refused a listing of exactly its 1000-row limit, and the tracker passed
 * 1000, so `npm run board:report`, `board-document.ts` and `collect()` all failed together. Raising the number only
 * moves the cliff; the read now walks the cursor and proves completeness against the tracker's own `totalCount`.
 *
 * POSITIVE CONTROL for every refusal below: `pagedRun` over the intact fixture is the one that must return all
 * rows (first test), so the refusals cannot be passing because the fixture is unreadable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { issues } from "../board-data.ts";

const PAGE = 100;
const OLD_LIMIT = 1000; // the `--limit` the read used to refuse at
const TRACKER = OLD_LIMIT + 201; // what the live tracker held when #2435 was filed

function issueNode(number: number, over: Record<string, unknown> = {}) {
  return {
    number, title: `row ${number}`, state: number % 2 ? "OPEN" : "CLOSED",
    closedAt: number % 2 ? null : "2026-09-01T00:00:00Z", url: `https://github.com/x/y/issues/${number}`,
    labels: { totalCount: 1, nodes: [{ name: "ready" }] }, milestone: null, ...over,
  };
}

/** A GraphQL answer per cursor: `cursor:<n>` is the page starting after row n. */
function pagedRun(total: number, opts: { failAfterRows?: number; totalCount?: number; stuckCursor?: boolean } = {}) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    const afterArg = args.find((a) => a.startsWith("after="));
    const start = afterArg ? Number(afterArg.slice("after=cursor:".length)) : 0;
    if (opts.failAfterRows !== undefined && start >= opts.failAfterRows) throw new Error("HTTP 502 from GraphQL");
    const end = Math.min(start + PAGE, total);
    const nodes = Array.from({ length: end - start }, (_, i) => issueNode(start + i + 1));
    const cursor = opts.stuckCursor ? (afterArg?.slice("after=".length) ?? "cursor:0") : `cursor:${end}`;
    return JSON.stringify({ data: { repository: { issues: {
      totalCount: opts.totalCount ?? total,
      pageInfo: { hasNextPage: end < total, endCursor: cursor }, nodes } } } });
  };
  return { run, calls };
}

test("#2435: a tracker larger than the old 1000-row limit comes back whole, none twice, in the old row shape", () => {
  const { run, calls } = pagedRun(TRACKER);
  const all = issues({ run });
  assert.equal(all.length, TRACKER);
  assert.equal(new Set(all.map((i: { number: number }) => i.number)).size, TRACKER, "a row came back twice");
  assert.equal(calls.length, 13, "1201 rows at 100 a page is 13 reads");
  const row = all[0];
  assert.deepEqual(Object.keys(row).sort(),
    ["closedAt", "labelNames", "labels", "milestone", "number", "state", "title", "url"]);
  assert.deepEqual(row.labelNames, ["ready"]);
  assert.deepEqual(row.labels, [{ name: "ready" }]);
});

test("#2435: exactly one page over the old limit is not refused (the case the old check could not tell apart)", () => {
  assert.equal(issues({ run: pagedRun(OLD_LIMIT).run }).length, OLD_LIMIT);
});

test("#2435 POSITIVE CONTROL: the same fixture with its FINAL page failing REFUSES, naming that it could not prove completeness", () => {
  const { run } = pagedRun(TRACKER, { failAfterRows: TRACKER - 1 });
  assert.throws(() => issues({ run }), (e: Error) => {
    assert.match(e.message, /could not be proved complete/);
    assert.match(e.message, new RegExp(`after ${TRACKER - 1} rows`), "must say how much it had read, not return it");
    assert.match(e.message, /HTTP 502/, "the underlying failure travels with the refusal");
    assert.equal((e.cause as Error | undefined)?.message, "HTTP 502 from GraphQL");
    return true;
  });
});

test("#2435: a shortfall against the tracker's own totalCount refuses", () => {
  assert.throws(() => issues({ run: pagedRun(250, { totalCount: 251 }).run }),
    /250 rows \(250 distinct\) against the 251 the tracker reports, so it could not be proved complete/);
});

test("#2435: a cursor that does not advance refuses instead of looping", () => {
  assert.throws(() => issues({ run: pagedRun(300, { stuckCursor: true }).run }),
    /could not be proved complete.*the cursor did not advance/);
});

test("#2435: an issue whose labels were cut off by the label page refuses", () => {
  const run = () => JSON.stringify({ data: { repository: { issues: { totalCount: 1,
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [issueNode(1, { labels: { totalCount: 101, nodes: [{ name: "ready" }] } })] } } } });
  assert.throws(() => issues({ run }), /#1 carries 101 labels and only 1 were read/);
});

test("#2435: an unexpected response shape refuses rather than reporting an empty tracker", () => {
  assert.throws(() => issues({ run: () => JSON.stringify({ errors: [{ message: "rate limited" }] }) }),
    /could not be proved complete.*unexpected response shape/);
});

test("#2435: a page with no pageInfo refuses as a shape error, even when its row count matches totalCount", () => {
  // The count check alone would pass this one-row page, so only the shape guard can refuse it.
  const onePage = (pageInfo?: unknown) => () => JSON.stringify({ data: { repository: { issues: {
    totalCount: 1, ...(pageInfo === undefined ? {} : { pageInfo }), nodes: [issueNode(1)] } } } });
  assert.throws(() => issues({ run: onePage() }), /could not be proved complete.*unexpected response shape/);
  assert.throws(() => issues({ run: onePage({ endCursor: null }) }), /unexpected response shape/,
    "pageInfo without a boolean hasNextPage is no better");
  assert.equal(issues({ run: onePage({ hasNextPage: false, endCursor: null }) }).length, 1, "positive control: the intact page reads");
});

test("#2435: a page with no pageInfo AND a shortfall refuses, and names the shape rather than the count", () => {
  const run = () => JSON.stringify({ data: { repository: { issues: { totalCount: 5, nodes: [issueNode(1)] } } } });
  assert.throws(() => issues({ run }), /unexpected response shape/);
});

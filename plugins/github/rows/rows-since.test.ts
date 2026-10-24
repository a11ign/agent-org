// no-token: none -- the pages are text handed in; nothing here spawns `gh`
/**
 * A11-160 (step 8, review of #1834): A PAGE THAT SAYS ANOTHER FOLLOWS AND NAMES NO CURSOR IS A MALFORMED ANSWER, NOT A WHOLE READ. `foldPage` reads a null cursor as "the read is whole", so a page with
 * `hasNextPage: true` and no `endCursor` used to end the window short and answer the rows so far as if they were all of them. It throws now, in the sync reader's `parsePage` and so in the async one the chairman's watch uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SinceRead } from "../../../src/plugins/contracts/code-host-rows.ts";
import { parsePage, readRowsSince, readRowsSinceAsync } from "./rows-since.ts";

const ASK: SinceRead = { kind: "issues", states: ["OPEN"], orderBy: "CREATED_AT", repo: "o/r", select: "number", newest: 500 };
const page = (pageInfo: Record<string, unknown>, numbers: number[] = [1]) => JSON.stringify({ data: { repository: { issues: { nodes: numbers.map((number) => ({ number })), pageInfo } } } });
class CutShort extends Error {}

test("a page with another page after it and no cursor is refused, whether the cursor is absent, null or empty", () => {
  for (const pageInfo of [{ hasNextPage: true }, { hasNextPage: true, endCursor: null }, { hasNextPage: true, endCursor: "" }]) {
    assert.throws(() => parsePage(page(pageInfo), ASK), /hasNextPage and no endCursor/, JSON.stringify(pageInfo));
  }
});

test("CONTROLS: a last page needs no cursor, and a page with one names it", () => {
  assert.deepEqual(parsePage(page({ hasNextPage: false }), ASK), { nodes: [{ number: 1 }], hasNextPage: false, endCursor: null });
  assert.deepEqual(parsePage(page({ hasNextPage: false, endCursor: null }), ASK).endCursor, null);
  assert.deepEqual(parsePage(page({ hasNextPage: true, endCursor: "c1" }), ASK), { nodes: [{ number: 1 }], hasNextPage: true, endCursor: "c1" });
});

test("the async reader rejects such a page and does not answer the rows so far: a read that stopped short is not a read", async () => {
  const asked: string[][] = [];
  await assert.rejects(() => readRowsSinceAsync({ ask: ASK, run: async (args) => { asked.push([...args]); return page({ hasNextPage: true }); } }, { WindowCutShort: CutShort }), /hasNextPage and no endCursor/);
  assert.equal(asked.length, 1, "it asked once and refused, and did not ask the same page again");
  const rows = await readRowsSinceAsync({ ask: ASK, run: async () => page({ hasNextPage: false }, [3, 2]) }, { WindowCutShort: CutShort });
  assert.deepEqual(rows.map((row) => row.number), [3, 2]);
});

// --- the sync and the async reader walk the same pages (review of #1834: one page loop, not two) ----------------------------------

const POOL = { fromResponse: () => null, rawResponse: () => null, fromRateLimitField: () => null };
const THREE_PAGES = [page({ hasNextPage: true, endCursor: "c1" }, [5, 4]), page({ hasNextPage: true, endCursor: "c2" }, [3, 2]), page({ hasNextPage: false }, [1])];

test("the sync and the async reader ask the same pages in the same order with the same cursors, and answer the same rows", async () => {
  const asked = { sync: [] as string[][], async: [] as string[][] };
  let at = { sync: 0, async: 0 };
  const sync = readRowsSince({ ask: ASK, run: (args) => { asked.sync.push(args); return THREE_PAGES[at.sync++]!; } }, { pool: POOL, WindowCutShort: CutShort });
  const later = await readRowsSinceAsync({ ask: ASK, run: async (args) => { asked.async.push([...args]); return THREE_PAGES[at.async++]!; } }, { WindowCutShort: CutShort });
  assert.deepEqual(asked.async, asked.sync);
  assert.equal(asked.sync.length, 3);
  assert.deepEqual(asked.sync.map((args) => args.filter((arg) => arg.startsWith("after="))), [[], ["after=c1"], ["after=c2"]]);
  assert.deepEqual(later.map((row) => row.number), sync.map((row) => row.number));
  assert.deepEqual(sync.map((row) => row.number), [5, 4, 3, 2, 1]);
});

test("both refuse a window longer than its pages with the same error", async () => {
  const ask: SinceRead = { ...ASK, newest: undefined, since: "2020-01-01T00:00:00Z", maxPages: 2 };
  const endless = (n: number) => page({ hasNextPage: true, endCursor: `c${n}` }, [n]).replace(/"number":\d+/, `"number":${n},"createdAt":"2026-01-01T00:00:00Z"`);
  let n = 0;
  assert.throws(() => readRowsSince({ ask, run: () => endless(++n) }, { pool: POOL, WindowCutShort: CutShort }), (error: unknown) => error instanceof CutShort && /may be cut short/.test((error as Error).message));
  n = 0;
  await assert.rejects(() => readRowsSinceAsync({ ask, run: async () => endless(++n) }, { WindowCutShort: CutShort }), (error: unknown) => error instanceof CutShort && /may be cut short/.test((error as Error).message));
});

// --- the pull-request window of the board's conflict metrics (A11-160, step 9: moved here from `src/packaging/conflict-metrics.test.ts`, which now runs on the fake code host) ---

test("a window of exactly its five pages is read whole, 100 rows a page and by a connection, never a search; one row more is cut short", () => {
  const ask: SinceRead = { kind: "pullRequests", states: ["OPEN", "CLOSED", "MERGED"], orderBy: "CREATED_AT", repo: "o/r", select: "number title createdAt", since: "2026-09-08T00:00:00.000Z", maxPages: 5 };
  const rowsOf = (count: number) => Array.from({ length: count }, (_, i) => ({ number: i + 1, createdAt: new Date(Date.parse(ask.since!) + (count - i) * 1000).toISOString() }));
  const pagesOf = (rows: { number: number }[], asked: string[][]) => (args: string[]): string => {
    asked.push(args);
    const from = Number(args.find((arg) => arg.startsWith("after="))?.slice("after=".length).replace(/^c/, "") ?? 0);
    const more = from + 100 < rows.length;
    return JSON.stringify({ data: { repository: { pullRequests: { nodes: rows.slice(from, from + 100), pageInfo: { hasNextPage: more, endCursor: more ? `c${from + 100}` : null } } } } });
  };
  const asked: string[][] = [];
  assert.equal(readRowsSince({ ask, run: pagesOf(rowsOf(500), asked) }, { pool: POOL, WindowCutShort: CutShort }).length, 500, "the connection PROVES the window whole: its fifth page has no next one");
  assert.equal(asked.length, 5, "paged 100 at a time");
  assert.deepEqual(asked.filter((args) => args.includes("--search") || args.includes("--label")), [], "and none is a GitHub search (#5076)");
  assert.ok(asked.every((args) => args[0] === "api" && args[1] === "graphql" && args.some((arg) => /pullRequests\(states:\[OPEN,CLOSED,MERGED\],first:100,after:\$after,orderBy:\{field:CREATED_AT,direction:DESC\}/.test(arg))));
  const over: string[][] = [];
  assert.throws(() => readRowsSince({ ask, run: pagesOf(rowsOf(501), over) }, { pool: POOL, WindowCutShort: CutShort }), (error: unknown) => error instanceof CutShort && /may be cut short/.test((error as Error).message));
  assert.equal(over.length, 5, "it read its five pages and no more");
});

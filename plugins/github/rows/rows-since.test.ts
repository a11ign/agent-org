// no-token: none -- the pages are text handed in; nothing here spawns `gh`
/**
 * A11-160 (step 8, review of #1834): A PAGE THAT SAYS ANOTHER FOLLOWS AND NAMES NO CURSOR IS A MALFORMED ANSWER, NOT A WHOLE READ. `foldPage` reads a null cursor as "the read is whole", so a page with
 * `hasNextPage: true` and no `endCursor` used to end the window short and answer the rows so far as if they were all of them. It throws now, in the sync reader's `parsePage` and so in the async one the chairman's watch uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SinceRead } from "../../../src/plugins/contracts/code-host-rows.ts";
import { parsePage, readRowsSinceAsync } from "./rows-since.ts";

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

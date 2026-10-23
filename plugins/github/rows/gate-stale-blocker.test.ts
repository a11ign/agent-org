// no-token: none -- `run` answers from a recorded table: no GitHub CLI runs
/**
 * A11-160 (step 6): WHAT THE RECENTLY CLOSED ROWS READ SENDS AND HOW IT READS THE ANSWER (#3706, #5050). Moved from `work-gate-stale-blocker-cleared.test.ts`, whose cases about the BOUND a listing gives
 * (sorted by `updatedAt`, checked and not trusted) are the gate's and now run on the fake code host. Here: one connection read, newest UPDATE first and no search, and an answer that is no connection is `null`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RowsHelpers } from "../../../src/plugins/contracts/code-host-rows.ts";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import { createRows } from "./index.ts";
import { forgetRefusedReads } from "./rows-by-label.ts";
import { recording } from "./recording-run.test.support.ts";

const rows = () => createRows(() => rowsReadHelpers() as unknown as RowsHelpers);
const NODES = [{ number: 3723, closedAt: "2026-10-05T22:56:16Z", updatedAt: "2026-10-05T22:56:16Z" }];

test("#3706 (a), #5050: the read is ONE call, a connection ordered by the update time, newest first, and it is no search", () => {
  forgetRefusedReads();
  const read = recording({ data: { repository: { issues: { nodes: NODES } } } });
  assert.deepEqual(rows().recentlyClosedRowsOf({ limit: 100, run: read.run }), NODES);
  assert.equal(read.asked.length, 1);
  const [args] = read.asked;
  assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
  assert.equal(args.some((arg) => arg === "--search" || arg.includes("sort:updated")), false, "a connection read, never a search");
  assert.match(String(args.find((arg) => arg.startsWith("query="))), /issues\(states:CLOSED,first:\$first,orderBy:\{field:UPDATED_AT,direction:DESC\}\)\{nodes\{number closedAt updatedAt\}\}/, "newest UPDATE first, closedAt and updatedAt");
  forgetRefusedReads();
});

test("#5050: an answer that is no connection is null, never an empty list: errors beside no data, and the old `issue list` array", () => {
  forgetRefusedReads();
  for (const answer of [{ data: { repository: { issues: null } }, errors: [{ message: "x" }] }, NODES, { data: {} }]) {
    assert.equal(rows().recentlyClosedRowsOf({ limit: 100, run: recording(answer).run }), null, JSON.stringify(answer).slice(0, 60));
  }
  assert.throws(() => rows().recentlyClosedRowsOf({ limit: 100, run: recording(new Error("gh refused")).run }), /gh refused/);
  forgetRefusedReads();
});

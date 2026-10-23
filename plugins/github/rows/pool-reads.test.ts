// no-token: none -- `run` answers from a recorded table: no GitHub CLI runs
/**
 * #1969 (A11-160, step 5): THE POOL A REFUSED READ NAMES, read by the code host. `arm-pr` says whether a refused read is about one pull request or about the arming credential's whole API pool, and the minute the pool
 * returns; that sentence is core's (`refusalScope`, tested on the fake code host in `auto-arm-token.test.ts`), and what is the code host's is the probe it sends and how the refusing response's headers are read.
 * Moved from `src/packaging/auto-arm-token.test.ts`, whose `run` stub threw the 403 for `arm-pr` itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import type { RowsHelpers } from "../../../src/plugins/contracts/code-host-rows.ts";
import { createRows } from "./index.ts";

/**
 * The real 403's own shape. Confirmed 2026-09-23 against a REAL refusal: the unauthenticated core pool was driven to `403` and the refusing response carried `x-ratelimit-remaining: 0` and
 * `x-ratelimit-reset: 1790156710`. The same day, `gh api ... -i` was confirmed to put the whole response on the thrown error's `stdout`. The reset below is the real outage's own end -- 19:13:44Z.
 */
const REFUSED_403 = "HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 0\r\n"
  + "X-Ratelimit-Reset: 1758568424\r\nX-Ratelimit-Resource: graphql\r\n\r\n"
  + '{"message":"API rate limit exceeded for user ID 46429371."}';

/** The rows, with only what reads no project handed over (the pool is a leaf), and the `run` the pool is read through. */
const rows = () => createRows(() => rowsReadHelpers() as unknown as RowsHelpers);

test("#1969: the pool is read from the headers on the thrown 403's stdout: the reset minute is X-Ratelimit-Reset, never inferred", () => {
  const asked: string[][] = [];
  const pool = rows().graphqlPoolOf((args) => {
    asked.push(args);
    throw Object.assign(new Error("gh: the pool refused this too"), { stdout: REFUSED_403 });
  });
  assert.deepEqual(asked, [["api", "graphql", "-f", "query=query { viewer { login } }", "-i"]], "the probe is one GraphQL read with the response headers");
  assert.deepEqual([pool?.remaining, pool?.limit, pool?.resource, pool?.resetAt], [0, 5000, "graphql", "2025-09-22T19:13:44.000Z"]);
});

test("#1969: a probe that brings no headers back is null, never a guessed pool -- an instrument that cannot answer must not answer", () => {
  assert.equal(rows().graphqlPoolOf(() => { throw new Error("gh: HTTP 502"); }), null, "a refused probe with no stdout");
  assert.equal(rows().graphqlPoolOf(() => ""), null, "an empty answer");
  assert.equal(rows().graphqlPoolOf(() => "HTTP/2.0 200 OK\r\n\r\n{}"), null, "an answer with no rate-limit headers");
});

test("#1969: a pool with budget LEFT is read as it is -- the number is never dressed up as an exhausted pool", () => {
  const pool = rows().graphqlPoolOf(() => "HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 4812\r\nX-Ratelimit-Reset: 1758568424\r\nX-Ratelimit-Resource: graphql\r\n\r\n{}");
  assert.deepEqual([pool?.remaining, pool?.limit, pool?.used], [4812, 5000, 188]);
});

// no-token: gh -- #3448. The reading is pure, `readRowsOffBoard` is handed a fake `run`, and `orgHealthNow` is handed every read as a seam; nothing here spends a point.
/**
 * #3448: A POOL BELOW A FIFTH OF ITS LIMIT IS A HEALTH SIGNAL, NAMING THE ACCOUNT, THE POOL AND THE RESET.
 *
 * 2026-10-04: `a11ign-ai-leads` spent all 5,000 GraphQL points in the hour from 11:57Z and three standing seats slept on the reset at once, with nothing in the org
 * knowing why. `gh api rate_limit` said 4,882 left at the same moment (#1967), so the reading comes from a real call's own answer: the `rateLimit` field of the
 * off-board query the tick was sending anyway, which is never charged. THE FRACTION IS WRITTEN OUT AS 20% HERE, never as `POOL_LOW_FRACTION`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { POOL_LOW_FRACTION, SIGNALS, poolLowReading, orgHealthReadings, orgHealthOrders } from "../org-health.ts";
import { poolFromRateLimitField } from "../api-pool.ts";
import { ROW_OFF_BOARD_QUERY, readRowsOffBoard, decide } from "../work-gate.ts";
import { orgHealthNow } from "../work-gate/org-health.ts";

const RESET = "2026-10-04T12:57:14Z";
const pool = (remaining: number, over: Record<string, unknown> = {}) => ({ account: "a11ign-ai-leads", resource: "graphql", remaining, limit: 5000, resetAt: RESET, ...over });

test("#3448 (3): the threshold is one named constant, a fifth", () => {
  assert.equal(POOL_LOW_FRACTION, 0.2);
});

test("#3448 (3): a pool below 20% is a named signal carrying the account, the pool and the reset; at or above it is not", () => {
  const low = poolLowReading({ pools: [pool(999)] });
  assert.equal(low.status, "tripped", "POSITIVE CONTROL: 999 of 5000 is 19.98%");
  for (const part of ["a11ign-ai-leads", "graphql", RESET, "999 of 5000"]) assert.ok(low.detail.includes(part), `the detail carries ${part}: ${low.detail}`);
  assert.equal(poolLowReading({ pools: [pool(1000)] }).status, "clear", "exactly 20% is not below it");
  assert.equal(poolLowReading({ pools: [pool(1001)] }).status, "clear");
  assert.equal(poolLowReading({ pools: [pool(4882)] }).status, "clear", "a healthy pool");
  assert.equal(poolLowReading({ pools: [pool(0)] }).status, "tripped", "an empty one, which is what a session sleeps on");
  assert.equal(poolLowReading({ pools: [pool(0, { limit: 0 })] }).status, "clear", "a limit of nothing is an unread pool, never a divide");
});

test("#3448 (3): the signal is one per spent WINDOW, names every low pool, and is an order to ceo", () => {
  const both = poolLowReading({ pools: [pool(10), pool(20, { account: "a11ign-ai-workers" }), pool(4000, { account: "a-person" })] });
  assert.match(both.detail, /a11ign-ai-leads.*a11ign-ai-workers/s, "both low accounts named, the healthy one not");
  assert.doesNotMatch(both.detail, /a-person/);
  const next = poolLowReading({ pools: [pool(10, { resetAt: "2026-10-04T13:57:14Z" })] });
  assert.notEqual(next.discriminator, poolLowReading({ pools: [pool(10)] }).discriminator, "the next window is a new signal");
  assert.equal(poolLowReading({ pools: [pool(10)] }).discriminator, poolLowReading({ pools: [pool(11)] }).discriminator, "and the same window is one signal however far it drains");

  const [order] = orgHealthOrders(orgHealthReadings({ now: 0, lastMergedAt: 0, work: null, redPrs: [], refusals: {}, drift: null, primarySince: null, pools: [pool(10)] })
    .filter((r) => r.signal === SIGNALS.POOL_LOW));
  assert.equal(order.session, "ceo");
  assert.equal(order.cause, "org-health");
  assert.match(order.prompt, /api-pool-low/);
});

test("#3448 (3): no pool read is a stated unknown, never a clear, and an omitted fact asks nothing", () => {
  assert.equal(poolLowReading({ pools: null }).status, "unknown");
  const base = { now: 0, lastMergedAt: 0, work: null, redPrs: [], refusals: {}, drift: null, primarySince: null };
  assert.equal(orgHealthReadings(base).some((r) => r.signal === SIGNALS.POOL_LOW), false, "a caller that does not ask is silent");
  assert.equal(orgHealthReadings({ ...base, pools: null }).some((r) => r.signal === SIGNALS.POOL_LOW && r.status === "unknown"), true);
});

test("#3448 (3): the pool comes from a real answer's `rateLimit` field, which the off-board query now asks for beside the account", () => {
  assert.deepEqual(poolFromRateLimitField({ viewer: { login: "a11ign-ai-leads" }, rateLimit: { limit: 5000, remaining: 0, resetAt: RESET } }), pool(0));
  assert.equal(poolFromRateLimitField({ rateLimit: { limit: 5000, remaining: 7, resetAt: RESET } })?.account, null, "an answer that names nobody is not given a name");
  assert.equal(poolFromRateLimitField({ viewer: { login: "x" } }), null, "no rateLimit: could not ask, not empty");
  assert.equal(poolFromRateLimitField({ rateLimit: { limit: "5000", remaining: "0" } }), null, "a malformed one is not read as zero");
  assert.match(ROW_OFF_BOARD_QUERY, /rateLimit \{ limit remaining resetAt \}/);
  assert.match(ROW_OFF_BOARD_QUERY, /viewer \{ login \}/);
});

test("#3448 (3): `readRowsOffBoard` leaves the pool it saw, once, and a refused read leaves none", () => {
  const issues = { nodes: [], pageInfo: { hasNextPage: true, endCursor: "c1" } };
  let calls = 0;
  const run = (_args: string[]) => {
    calls += 1;
    return JSON.stringify({ data: { viewer: { login: "a11ign-ai-workers" }, rateLimit: { limit: 5000, remaining: 29 - calls, resetAt: RESET },
      repository: { issues: calls === 1 ? issues : { ...issues, pageInfo: { hasNextPage: false } } } } });
  };
  const pools: unknown[] = [];
  assert.deepEqual(readRowsOffBoard(run, pools as never), []);
  assert.equal(calls, 2, "two pages were read");
  assert.deepEqual(pools, [pool(28, { account: "a11ign-ai-workers" })], "ONE pool: the first page's, not one per page");

  const refused: unknown[] = [];
  assert.equal(readRowsOffBoard(() => { throw new Error("HTTP 403"); }, refused as never), null);
  assert.deepEqual(refused, [], "a refusal pushes nothing");
});

test("#3448 (3): the org-health tick raises a low pool to ceo, is silent about a healthy one, and says an unread one was not read", () => {
  const NOW = Date.parse("2026-10-04T13:00:00Z");
  const decideArgs = { prs: [], required: [], readyRows: [], prFiles: new Map(), rowBranches: [], openRows: [], primaryDrift: null, claimRefusals: [] };
  const lines: string[] = [];
  const tick = (pools: unknown) => orgHealthNow({ prsRead: [], readyRead: [], openRowsRead: [], decideArgs, decided: decide({ prs: [], readyRows: [] } as never), pools } as never,
    { now: NOW, lastMergedAt: () => NOW, log: (line: string) => lines.push(line), readCaptures: (() => undefined) as never,
      readLabJobs: () => [], readWaits: (() => ({ facts: new Map(), stale: [], bare: [], manual: 0 })) as never,
      // #3672: no remote: a project that declares `teamAccess` would otherwise make the live `gh api` read here
      teamAccess: () => undefined }) as { subject: string; session: string }[];
  assert.deepEqual(tick([pool(10)]).filter((o) => o.subject === SIGNALS.POOL_LOW).map((o) => o.session), ["ceo"], "POSITIVE CONTROL: a low pool is an order to ceo");
  assert.deepEqual(tick([pool(4000)]).filter((o) => o.subject === SIGNALS.POOL_LOW), []);
  assert.deepEqual(tick([]).filter((o) => o.subject === SIGNALS.POOL_LOW), [], "an unread pool raises nothing...");
  assert.match(lines.join(""), /api-pool-low UNKNOWN -- no API pool was read this tick/, "...and says so");
});

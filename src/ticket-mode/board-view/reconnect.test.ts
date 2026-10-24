import { test } from "node:test";
import assert from "node:assert/strict";
import { isUnreachable, looksLikeRestart, MAX_BACKOFF_MS, MIN_BACKOFF_MS, nextDelay, POLL_MS } from "./reconnect.ts";

const LOCAL = { kind: "local" };
const SSH = { kind: "ssh" };

test("a read with no answer, or a 502 or 503 from a proxy, looks like a restart", () => {
  assert.equal(looksLikeRestart(LOCAL, 0, "Failed to fetch"), true, "connection refused or a network error");
  assert.equal(looksLikeRestart(null, 0, ""), true, "with no connection chosen");
  assert.equal(looksLikeRestart(LOCAL, 502, "cannot reach work's instance at 127.0.0.1:7317: ECONNREFUSED. Is agent-org ticket:serve running there?"), true, "the proxy's own 502 for a local instance that is down");
  assert.equal(looksLikeRestart(LOCAL, 502, "Bad Gateway"), true, "a 502 from tailscale serve");
  assert.equal(looksLikeRestart(LOCAL, 503, "Service Unavailable"), true);
  assert.equal(looksLikeRestart({ kind: "https" }, 503, "x"), true, "an https connection too");
  assert.equal(looksLikeRestart(SSH, 503, "x"), true, "an SSH remote's 503 is not the proxy's 'cannot reach'");
  assert.equal(looksLikeRestart(SSH, 0, "Failed to fetch"), true, "the page's own service is down, whatever the connection");
});

test("an SSH remote its proxy cannot reach is unreachable, not a restart", () => {
  const refusal = "cannot reach personal over SSH: agents: Permission denied (publickey).";
  assert.equal(isUnreachable(SSH, 502, refusal), true);
  assert.equal(looksLikeRestart(SSH, 502, refusal), false);
  assert.equal(looksLikeRestart(SSH, 502, "the instance answered with something that is not JSON"), true, "an SSH 502 that is not 'cannot reach' is not unreachable");
});

test("an error the server answered with is not a restart", () => {
  for (const status of [400, 401, 403, 404, 409, 500, 504]) assert.equal(looksLikeRestart(LOCAL, status, "refused"), false, String(status));
  assert.equal(looksLikeRestart(SSH, 500, "cannot reach personal"), false, "the wording alone does not make a restart");
});

test("nextDelay waits 5s after a success and backs off from 2s, doubling to 60s", () => {
  assert.equal(nextDelay(0), POLL_MS);
  assert.deepEqual([1, 2, 3, 4, 5].map(nextDelay), [2_000, 4_000, 8_000, 16_000, 32_000]);
  assert.deepEqual([6, 7, 1_000].map(nextDelay), [60_000, 60_000, 60_000]);
  assert.deepEqual([POLL_MS, MIN_BACKOFF_MS, MAX_BACKOFF_MS], [5_000, 2_000, 60_000]);
});

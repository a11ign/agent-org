// no-token: none -- pure
// A11-399: where a run's retries stand after a transient crash past the retry cap: it carries a recovery with a back-off that lengthens with the restarts of the last 24 h, and the day's bound.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CRASH_RETRIES, crashRetryAfter, RECOVERY_RESTARTS, RECOVERY_WINDOW_MS, restartFreeAt } from "./crash-retry.ts";

const NOW = 1_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const transient = new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });

test("the retries come first, with the waits A11-345 decided", () => {
  assert.deepEqual(crashRetryAfter(transient, undefined, NOW), { count: 1, retryAt: NOW + 30_000 });
  assert.deepEqual(crashRetryAfter(transient, { count: 1 }, NOW), { count: 2, retryAt: NOW + 2 * MIN });
});

test("a transient crash with the retries used carries a recovery, and the count stays at the cap", () => {
  assert.equal(CRASH_RETRIES, 2);
  assert.deepEqual(crashRetryAfter(transient, { count: 2 }, NOW), { count: 2, recovery: { notBefore: NOW + 10 * MIN, restarts: [] } });
});

test("each crash past the cap waits longer, 10 min then 30 min then 2 h, by the restarts of the last 24 h", () => {
  const after = (restarts: readonly number[]) => crashRetryAfter(transient, { count: 2, recovery: { restarts } }, NOW)?.recovery;
  assert.deepEqual(after([NOW - HOUR]), { notBefore: NOW + 30 * MIN, restarts: [NOW - HOUR] });
  assert.deepEqual(after([NOW - 2 * HOUR, NOW - HOUR]), { notBefore: NOW + 2 * HOUR, restarts: [NOW - 2 * HOUR, NOW - HOUR] });
  assert.equal(after([NOW - 3 * HOUR, NOW - 2 * HOUR, NOW - HOUR])?.notBefore, NOW + 2 * HOUR, "it stays at 2 h");
  assert.deepEqual(after([NOW - RECOVERY_WINDOW_MS - 1]), { notBefore: NOW + 10 * MIN, restarts: [] }, "a restart from over a day ago is forgotten");
});

test("a crash for another reason carries no recovery, whatever came before", () => {
  const other = new Error("the plan could not be read");
  assert.equal(crashRetryAfter(other, undefined, NOW), undefined);
  assert.deepEqual(crashRetryAfter(other, { count: 2, recovery: { notBefore: NOW, restarts: [NOW - HOUR] } }, NOW), { count: 2 });
});

test("the day's bound leaves a restart free until three are in the last 24 h, and then until the oldest ages out", () => {
  const restarts = [NOW - 20 * HOUR, NOW - 10 * HOUR, NOW - HOUR];
  assert.equal(RECOVERY_RESTARTS, 3);
  assert.equal(restartFreeAt({ restarts: restarts.slice(1) }, NOW), undefined);
  assert.equal(restartFreeAt({ restarts }, NOW), NOW - 20 * HOUR + RECOVERY_WINDOW_MS);
  assert.equal(restartFreeAt(undefined, NOW), undefined);
});

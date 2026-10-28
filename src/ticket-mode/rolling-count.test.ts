// no-token: gh -- the clock is injected; nothing is spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUCKET_MS, rollingCount } from "./rolling-count.ts";

const HOUR = 3_600_000;

test("events are counted within the window, and an event drops out once its whole minute is older than the window", () => {
  let clock = 10 * HOUR;
  const count = rollingCount(HOUR, () => clock);
  count.add();
  count.add(2);
  assert.equal(count.total(), 3);
  clock += HOUR;
  assert.equal(count.total(), 3, "an hour on, the minute they were in has not wholly passed out of the window yet");
  clock += BUCKET_MS;
  assert.equal(count.total(), 0, "an hour and a minute on, it is out");
});

test("a count keeps no more than an hour of buckets however many events it is given", () => {
  let clock = 0;
  const count = rollingCount(HOUR, () => clock);
  for (let minute = 0; minute < 500; minute++) {
    clock = minute * BUCKET_MS;
    count.add();
  }
  assert.equal(count.total(), 61, "the window's sixty minutes and the one it is in");
});

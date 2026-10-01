import assert from "node:assert/strict";
import { test } from "node:test";

test("DELIBERATELY RED: proves gate fails on a failing messaging test (a11ign/a11ign#2900 done-when 6); never merged", () => {
  assert.equal(1, 2);
});

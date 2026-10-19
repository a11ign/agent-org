// no-token: none -- a test of the case registration only; nothing here reaches `gh`, `herdr` or `git`
import { test } from "node:test";
import assert from "node:assert/strict";
import { caseTitle, testEach } from "./test-each.ts";

testEach("a case table registers one test per case", [{ name: "first", value: 1 }, { name: "second", value: 2 }], (c) => {
  assert.ok(c.value > 0);
});

test("a case's test is titled with the table's title and its own name", () => {
  assert.equal(caseTitle("a table", { name: "first" }), "a table: first");
});

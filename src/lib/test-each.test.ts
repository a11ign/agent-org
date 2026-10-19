// no-token: none -- a test of the case registration only; nothing here reaches `gh`, `herdr` or `git`
import { test } from "node:test";
import assert from "node:assert/strict";
import { caseTitle, testEach } from "./test-each.ts";

test("a case table registers one test per case, titled with the table's title and each case's name, in table order", () => {
  const registered: { name: string; skip: unknown }[] = [];
  testEach("a table", [{ name: "first" }, { name: "second" }], () => {}, { register: (name, options) => registered.push({ name, skip: options.skip }) });
  assert.deepEqual(registered, [{ name: "a table: first", skip: false }, { name: "a table: second", skip: false }]);
});

test("a case table passes its skip option to every case it registers", () => {
  const registered: { name: string; skip: unknown }[] = [];
  testEach("a table", [{ name: "only" }], () => {}, { skip: "this file cannot run here", register: (name, options) => registered.push({ name, skip: options.skip }) });
  assert.deepEqual(registered, [{ name: "a table: only", skip: "this file cannot run here" }]);
});

test("a case's test is titled with the table's title and its own name", () => {
  assert.equal(caseTitle("a table", { name: "first" }), "a table: first");
});

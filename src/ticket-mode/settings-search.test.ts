// no-token: gh -- the search is pure: its inputs are rows written in the test
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchGroups } from "./settings-search.ts";

const GROUPS = [
  { group: "Exposure", rows: [{ key: "tickets.port", explanation: "The loopback port the instance listens on." }] },
  { group: "Machine", rows: [{ key: "binDir", explanation: "The folder the routing gh is installed in." }, { key: "tickets.max", explanation: "How many workers run at once." }] },
];
const keysOf = (groups: readonly { rows: readonly { key: string }[] }[]) => groups.map((group) => group.rows.map((row) => row.key));

test("an empty query leaves every group and every row, in their order", () => {
  assert.deepEqual(keysOf(searchGroups(GROUPS, "")), [["tickets.port"], ["binDir", "tickets.max"]]);
});

test("a query matches a key or an explanation, ignoring case, and a group with no match stays with no rows", () => {
  assert.deepEqual(keysOf(searchGroups(GROUPS, "PORT")), [["tickets.port"], []], "the key and the explanation both match");
  assert.deepEqual(keysOf(searchGroups(GROUPS, "routing")), [[], ["binDir"]], "the explanation alone matches");
  assert.deepEqual(keysOf(searchGroups(GROUPS, "BINDIR")), [[], ["binDir"]], "a key matches whatever its case");
  assert.equal(searchGroups(GROUPS, "nothing like this").length, GROUPS.length, "every group is still there");
  assert.deepEqual(keysOf(searchGroups(GROUPS, "nothing like this")), [[], []]);
});

test("a query is a plain substring, never a pattern: a typed bracket is a character, and matches nothing here", () => {
  assert.deepEqual(keysOf(searchGroups(GROUPS, "(")), [[], []]);
  assert.deepEqual(keysOf(searchGroups(GROUPS, ".*")), [[], []], "a dot and a star are not a wildcard");
});

test("the groups it is given are not changed", () => {
  const before = JSON.stringify(GROUPS);
  searchGroups(GROUPS, "port");
  assert.equal(JSON.stringify(GROUPS), before);
});

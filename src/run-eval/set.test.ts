// no-token: gh -- parses JSON text; nothing here reaches `gh`, `git` or a model
/** A11-431: an eval set is read from its JSON list and refused by name when it is malformed or holds more than ten tickets. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SET_SIZE, parseSet } from "./set.ts";

const SHA = "0d450e9".padEnd(40, "0");
const entry = (ticket: string, extra: Record<string, unknown> = {}) => ({ repo: "a11ign/agent-org", ticket, baseSha: SHA, mergedPr: 2000, ...extra });

test("a set is its list of repository, ticket, base sha and merged pull request, with an optional test command", () => {
  const set = parseSet(JSON.stringify([entry("A11-1"), entry("A11-2", { test: "npm test" })]));
  assert.deepEqual(set, [entry("A11-1"), entry("A11-2", { test: "npm test" })]);
});

test("a set holds at most ten tickets: an eleventh is refused, never cut", () => {
  assert.equal(MAX_SET_SIZE, 10);
  const ten = Array.from({ length: 10 }, (_, at) => entry(`A11-${at + 1}`));
  assert.equal(parseSet(JSON.stringify(ten)).length, 10);
  assert.throws(() => parseSet(JSON.stringify([...ten, entry("A11-11")])), /holds 11 tickets, and a set holds at most 10/);
});

test("a malformed set is refused naming the entry and the field", () => {
  assert.throws(() => parseSet("{"), /not JSON/);
  assert.throws(() => parseSet("{}"), /not a JSON list/);
  assert.throws(() => parseSet("[]"), /empty/);
  assert.throws(() => parseSet(JSON.stringify([entry("A11-1"), "x"])), /entry 2 is not an object/);
  assert.throws(() => parseSet(JSON.stringify([entry("A11-1", { repo: "agent-org" })])), /entry 1's repo is "agent-org", and wants owner\/name/);
  assert.throws(() => parseSet(JSON.stringify([entry("A11-1", { baseSha: "0d450e9" })])), /entry 1's baseSha .* full commit sha/, "git fetches a commit only by its full sha");
  assert.throws(() => parseSet(JSON.stringify([entry("A11-1", { mergedPr: 0 })])), /mergedPr is 0/);
  assert.throws(() => parseSet(JSON.stringify([entry("not a key")])), /ticket is "not a key"/);
  assert.throws(() => parseSet(JSON.stringify([entry("A11-1", { test: " " })])), /test is not a command/);
});

test("a ticket listed twice is refused: its two results would be one row", () => {
  assert.throws(() => parseSet(JSON.stringify([entry("A11-1"), entry("A11-1")])), /A11-1 is listed twice/);
});

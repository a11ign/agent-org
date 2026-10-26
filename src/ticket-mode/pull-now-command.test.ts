// no-token: none -- the command's answer is a pure function of the code host's read
// module: ticket:pull-now, the Stop hook's one read of a pull request (A11-290)
import { test } from "node:test";
import assert from "node:assert/strict";
import { pullNowOf } from "./pull-now-command.ts";

const URL = "https://github.com/a11ign/agent-org/pull/1933";

test("A11-290: a pull request the code host read prints its head and description as JSON", () => {
  assert.deepEqual(pullNowOf(URL, { head: "abc123", body: "Closes A11-270" }), { code: 0, out: JSON.stringify({ head: "abc123", body: "Closes A11-270" }) });
  assert.deepEqual(pullNowOf(URL, { head: "abc123" }), { code: 0, out: JSON.stringify({ head: "abc123", body: "" }) }, "a host that gives no description gives an empty one");
});

test("A11-290: a pull request that could not be read, or has no head, exits 1; what is no pull request address exits 2 and reads nothing", () => {
  assert.equal(pullNowOf(URL, null).code, 1);
  assert.equal(pullNowOf(URL, { head: null }).code, 1);
  assert.equal(pullNowOf("https://github.com/a11ign/agent-org/issues/9", { head: "x" }).code, 2);
});

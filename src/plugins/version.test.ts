// no-token: none -- pure: a version is text
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONCERNS } from "./concerns.ts";
import { CONTRACT_VERSION, majorOf, READ_MAJORS, readsConcernContract, readsMajor, unreadMajorRefusal } from "./version.ts";
import { READ_CONTRACT_MAJORS, readsContract } from "../ticket-mode/plugin-contract.ts";

test("a contract version is <major>.<minor>, and nothing else", () => {
  for (const version of ["1.0", "1.12", "10.3"]) assert.match(version, CONTRACT_VERSION, version);
  for (const version of ["1", "1.0.0", "v1.0", "1.x", "", "1."]) assert.doesNotMatch(version, CONTRACT_VERSION, JSON.stringify(version));
});

test("a minor only adds and a major breaks: major 1 is read at 1.0 and at 1.7, and major 2 is not read at 2.0", () => {
  assert.equal(majorOf("1.7"), 1);
  assert.equal(readsConcernContract("tracker", "1.0"), true);
  assert.equal(readsConcernContract("tracker", "1.7"), true);
  assert.equal(readsConcernContract("tracker", "2.0"), false);
  assert.equal(readsConcernContract("tracker", "0.9"), false, "major 0 is not major 1");
  assert.equal(readsMajor([1, 2], "2.0"), true, "a release that reads two majors reads both");
});

test("this agent-org reads major 1 of every concern's contract", () => {
  assert.deepEqual(Object.fromEntries(CONCERNS.map((concern) => [concern, READ_MAJORS[concern]])), { tracker: [1], codeHost: [1], publisher: [1], reviewer: [1], exposure: [1], messaging: [1] });
});

test("the refusal names the plugin, the concern, the version it declares, what is read and the fix", () => {
  assert.equal(unreadMajorRefusal("fake-tracker", "tracker", "2.0"), "plugin fake-tracker implements tracker contract 2.0; this agent-org reads tracker 1.x: update agent-org, or use a plugin of a major it reads");
  assert.match(unreadMajorRefusal("p", "codeHost", "3.1", [1, 2]), /reads codeHost 1\.x and 2\.x/);
});

test("the Claude plugin contract's rule is this one: its reader shares the parser", () => {
  assert.deepEqual(READ_CONTRACT_MAJORS, [1]);
  const contract = (version: string) => ({ contract: version, agentOrg: ">=0.1.0 <1.0.0", provides: {}, needs: { connectors: [], commands: [] } });
  assert.equal(readsContract(contract("1.4")), true);
  assert.equal(readsContract(contract("2.0")), false);
});

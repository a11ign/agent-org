// no-token: none -- pure functions over records in memory
// A11-361: a check this host cannot run is parked, routed to a runner that has what it needs, and its missing capability is filed once
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CheckRecord, ChecksFile } from "./checks.ts";
import { capabilityOf, capabilityRequest, CHECK_RUNNERS, missingCapabilities, parkCheck, recordCapabilityRequest, routeParked, runnerWith } from "./capability.ts";

const check = (id: string, over: Partial<CheckRecord> = {}): CheckRecord => ({
  id, key: id.split("#")[0], url: null, line: `The line of ${id}.`, owner: null, runner: "agent", listedAt: Number(id.split("-")[1].split("#")[0]), state: "open", verifier: { run: "c1", tries: 1 }, ...over,
});
const fileOf = (...checks: CheckRecord[]): ChecksFile => ({ checks: Object.fromEntries(checks.map((one) => [one.id, one])) });
const MAC: readonly (typeof CHECK_RUNNERS)[number][] = [{ name: "mac-runner", has: ["chairman-mac"] }];

test("A11-361: a capability is a short name in lower case words joined by hyphens", () => {
  assert.deepEqual(["Chairman Mac", "board_key", "x".repeat(41), "two things!", "", 5].map(capabilityOf), ["chairman-mac", "board-key", null, null, null, null]);
  assert.deepEqual(CHECK_RUNNERS, [], "no runner other than this host's verifier exists yet");
  assert.equal(runnerWith("chairman-mac", MAC), "mac-runner");
  assert.equal(runnerWith("board-key", MAC), null);
});

test("A11-361: a parked check stays open and carries what it lacks; it is not failed and has no result", () => {
  const parked = parkCheck(fileOf(check("A11-314#1")), "A11-314#1", "chairman-mac", "needs the Mac").checks["A11-314#1"];
  assert.deepEqual([parked.state, parked.result, parked.verifier, parked.needs], ["open", undefined, { run: null, tries: 1 }, { capability: "chairman-mac", why: "needs the Mac" }]);
  const closed = fileOf(check("A11-315#1", { state: "passed" }));
  assert.equal(parkCheck(closed, "A11-315#1", "chairman-mac", "x"), closed, "a closed check is not parked");
});

test("A11-361: the missing capabilities are listed once each, with every check parked on them, and none once a ticket is filed or a runner has it", () => {
  let file = fileOf(check("A11-314#1"), check("A11-320#1"), check("A11-325#1"));
  file = parkCheck(parkCheck(parkCheck(file, "A11-325#1", "board-key", "b"), "A11-320#1", "chairman-mac", "m2"), "A11-314#1", "chairman-mac", "m1");
  const missing = missingCapabilities(file);
  assert.deepEqual([...missing].map(([capability, checks]) => [capability, checks.map(({ id }) => id)]), [["chairman-mac", ["A11-314#1", "A11-320#1"]], ["board-key", ["A11-325#1"]]]);
  assert.deepEqual([...missingCapabilities(file, MAC).keys()], ["board-key"], "a runner that has it takes the checks: no ticket");
  const filed = recordCapabilityRequest(file, "chairman-mac", "f7");
  assert.deepEqual([...missingCapabilities(filed).keys()], ["board-key"]);
  assert.deepEqual(["A11-314#1", "A11-320#1", "A11-325#1"].map((id) => filed.checks[id].needs?.request), ["f7", "f7", undefined]);
  assert.equal(recordCapabilityRequest(filed, "chairman-mac", "f8"), filed, "recorded once");
});

test("A11-361: a check parked later on a capability whose ticket is filed carries that request and files none", () => {
  const filed = recordCapabilityRequest(parkCheck(fileOf(check("A11-314#1"), check("A11-329#1")), "A11-314#1", "chairman-mac", "m"), "chairman-mac", "f7");
  const later = parkCheck(filed, "A11-329#1", "chairman-mac", "m");
  assert.equal(later.checks["A11-329#1"].needs?.request, "f7");
  assert.equal(missingCapabilities(later).size, 0);
});

test("A11-361: a parked check is routed to a runner that has what it needs, and the mark leaves when none does", () => {
  const parked = parkCheck(fileOf(check("A11-314#1")), "A11-314#1", "chairman-mac", "m");
  const routed = routeParked(parked, MAC);
  assert.equal(routed.checks["A11-314#1"].needs?.routedTo, "mac-runner");
  assert.equal(routeParked(routed, MAC), routed, "once");
  assert.equal(routeParked(routed, []).checks["A11-314#1"].needs?.routedTo, undefined);
  assert.equal(parkCheck(fileOf(check("A11-314#1")), "A11-314#1", "chairman-mac", "m", MAC).checks["A11-314#1"].needs?.routedTo, "mac-runner");
});

test("A11-361: a capability's ticket names what is missing and each check that waits, and is not a failed check's follow-up", () => {
  const checks = [check("A11-314#1", { needs: { capability: "chairman-mac", why: "opens the app" } })];
  const text = capabilityRequest("chairman-mac", checks);
  assert.match(text, /^Runner needed: chairman-mac\./);
  assert.ok(text.includes("- A11-314#1: The line of A11-314#1.") && text.includes("opens the app"));
  assert.doesNotMatch(text, /Follow-up to/);
});

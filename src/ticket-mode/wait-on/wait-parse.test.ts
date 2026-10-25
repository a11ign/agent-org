// no-token: none -- the shape check is pure
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_WAITS, parseUntil, parseWaits } from "./wait-parse.ts";

const PULL = "https://github.com/a11ign/agent-org/pull/1872";

test("A11-245: each of the four kinds is read as the event it names", () => {
  assert.deepEqual(parseWaits([{ fleetJob: "fj-123" }, { ciRun: "a11ign/agent-org#9876" }, { pullRequest: PULL, until: "merged" }, { pullRequest: PULL, until: "reviewed" }, { ticket: "A11-243", until: "done" }]), [
    { kind: "fleetJob", id: "fj-123" }, { kind: "ciRun", repository: "a11ign/agent-org", runId: 9876 },
    { kind: "pullRequest", url: PULL, until: "merged" }, { kind: "pullRequest", url: PULL, until: "reviewed" }, { kind: "ticket", key: "A11-243", until: "done" },
  ]);
});

test("A11-245: a run ID is read exactly, never rounded to another run", () => {
  assert.deepEqual(parseWaits([{ ciRun: "o/r#123456789012345" }]), [{ kind: "ciRun", repository: "o/r", runId: 123_456_789_012_345 }]);
});

test("A11-245: a repeated item is dropped, and the order written is kept", () => {
  assert.deepEqual(parseWaits([{ fleetJob: "b" }, { fleetJob: "a" }, { fleetJob: "b" }]), [{ kind: "fleetJob", id: "b" }, { kind: "fleetJob", id: "a" }]);
});

test("A11-245: a pull request is one item per thing waited for, so merged and reviewed on the same address are two", () => {
  assert.equal((parseWaits([{ pullRequest: PULL, until: "merged" }, { pullRequest: PULL, until: "reviewed" }]) as unknown[]).length, 2);
});

test("A11-245: a list of 1 to 20 items is accepted, and nothing else is", () => {
  assert.equal(typeof parseWaits([]), "string");
  assert.match(parseWaits([]) as string, /at least one/);
  assert.equal(Array.isArray(parseWaits(Array.from({ length: MAX_WAITS }, (_, index) => ({ fleetJob: `j${index}` })))), true);
  assert.match(parseWaits(Array.from({ length: MAX_WAITS + 1 }, (_, index) => ({ fleetJob: `j${index}` }))) as string, /up to 20/);
  assert.match(parseWaits("two capture shells") as string, /needs a list of events.*you wrote "two capture shells"/);
  assert.match(parseWaits({ fleetJob: "a" }) as string, /you wrote an object/);
  assert.match(parseWaits(undefined) as string, /you wrote nothing/);
});

test("A11-245: an item with no subject, two subjects or a stranger's key is refused by name", () => {
  assert.match(parseWaits([{}]) as string, /waitingOn\[0\] needs exactly one of fleetJob, ciRun, pullRequest, ticket, you wrote no keys/);
  assert.match(parseWaits([{ fleetJob: "a", ciRun: "o/r#1" }]) as string, /you wrote fleetJob and ciRun/);
  assert.match(parseWaits([{ job: "a" }]) as string, /you wrote job/);
  assert.match(parseWaits([{ fleetJob: "ok" }, "fj-1"]) as string, /waitingOn\[1\] needs an object.*you wrote "fj-1"/);
  assert.match(parseWaits([{ fleetJob: "a", reason: "x" }]) as string, /waitingOn\[0\] \(fleetJob\) has reason, which it does not take/);
});

test("A11-245: until is required on a pull request and a ticket, and refused on the other two", () => {
  assert.match(parseWaits([{ pullRequest: PULL }]) as string, /pullRequest needs until: one of merged or reviewed, you wrote nothing/);
  assert.match(parseWaits([{ pullRequest: PULL, until: "closed" }]) as string, /you wrote "closed"/);
  assert.match(parseWaits([{ ticket: "A11-1" }]) as string, /ticket needs until: one of done, you wrote nothing/);
  assert.match(parseWaits([{ ticket: "A11-1", until: "merged" }]) as string, /ticket needs until: one of done/);
  assert.match(parseWaits([{ fleetJob: "a", until: "done" }]) as string, /has until, which it does not take; until goes only with pullRequest and ticket/);
  assert.match(parseWaits([{ ciRun: "o/r#1", until: "done" }]) as string, /has until, which it does not take/);
});

test("A11-245: a value of the wrong shape for its kind is refused by name", () => {
  for (const [item, pattern] of [
    [{ fleetJob: "" }, /fleetJob needs a job ID/], [{ fleetJob: "has space" }, /fleetJob needs a job ID/], [{ fleetJob: "-h" }, /fleetJob needs a job ID/], [{ fleetJob: "x".repeat(65) }, /fleetJob needs a job ID/], [{ fleetJob: 12 }, /fleetJob needs a string, you wrote a number/],
    [{ ciRun: "a11ign/agent-org" }, /ciRun needs <owner>\/<repo>#<run id>/], [{ ciRun: "9876" }, /ciRun needs/], [{ ciRun: "o/r#abc" }, /ciRun needs/], [{ ciRun: "o/r#1234567890123456" }, /ciRun needs/], [{ ciRun: "o/r#999999999999999999" }, /ciRun needs/], [{ ciRun: "o/r#0" }, /ciRun needs/],
    [{ pullRequest: "https://example.com/o/r/pull/1", until: "merged" }, /pullRequest needs a GitHub pull request address/], [{ pullRequest: "https://github.com/o/r/issues/1", until: "merged" }, /pullRequest needs a GitHub/],
    [{ ticket: "a11", until: "done" }, /ticket needs a ticket key/], [{ ticket: "A11-x", until: "done" }, /ticket needs a ticket key/],
  ] as const) assert.match(parseWaits([item]) as string, pattern, JSON.stringify(item));
});

test("A11-245: a long string a worker wrote is cut in the refusal that names it", () => {
  assert.ok((parseWaits([{ fleetJob: "x ".repeat(200) }]) as string).length < 300);
});

test("A11-245: until is an ISO time, read as UTC when it names no zone", () => {
  assert.equal(parseUntil("2026-10-25T12:00:00Z"), Date.UTC(2026, 9, 25, 12));
  assert.equal(parseUntil("2026-10-25T12:00:00"), Date.UTC(2026, 9, 25, 12));
  assert.equal(parseUntil("2026-10-25T12:00"), Date.UTC(2026, 9, 25, 12));
  assert.equal(parseUntil("2026-10-25T14:00:00+02:00"), Date.UTC(2026, 9, 25, 12));
  assert.equal(parseUntil("2026-10-25T12:00:00.500Z"), Date.UTC(2026, 9, 25, 12, 0, 0, 500));
});

test("A11-245: until that is not a time the board can read is refused by name", () => {
  for (const value of ["tomorrow", "2026-10-25", "in 3 hours", "", 1_800_000_000, null, undefined, "2026-13-45T25:61:00Z", "2026-02-31T10:00:00Z", "2026-04-31T10:00:00", ["2026-10-25T12:00:00Z"]]) {
    assert.match(parseUntil(value) as string, /^until needs an ISO time such as 2026-10-25T12:00:00Z, you wrote /, String(value));
  }
});

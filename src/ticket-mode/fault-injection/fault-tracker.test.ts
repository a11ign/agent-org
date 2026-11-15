// no-token: none -- the tracker is the contract's in-memory fake, wrapped; nothing reaches Linear
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTrackerConformance } from "../../plugins/conformance/tracker.ts";
import { createFakeTracker, FAKE_TRACKER_WRITING, fakeTicket } from "../../plugins/fakes/tracker.ts";
import { isTransient } from "../attach-retry.ts";
import { createCallLedger } from "../call-outcomes.ts";
import { FAULT_STATUS, faultyTracker } from "./fault-tracker.ts";

const PROBE = { known: "FAKE-1", missing: "FAKE-404", other: "FAKE-2" };
const seeded = () => createFakeTracker([fakeTicket("FAKE-1"), fakeTicket("FAKE-2")]);

test("with its fault off, the faulty tracker passes the tracker contract suite with exactly the checks the fake it wraps passes", async () => {
  const fake = await runTrackerConformance(seeded(), PROBE, FAKE_TRACKER_WRITING);
  const wrapped = await runTrackerConformance(faultyTracker(seeded(), { on: false }, createCallLedger()), PROBE, FAKE_TRACKER_WRITING);
  assert.deepEqual(wrapped.passed, fake.passed);
  assert.deepEqual(wrapped.skipped, [], "nothing is skipped: the wrapper keeps every optional operation and the keywords");
});

test("with its fault on, every operation rejects as Linear's 5xx does, with the status as data, which the board reads as transient", async () => {
  const fault = { on: true };
  const calls = createCallLedger();
  const tracker = faultyTracker(seeded(), fault, calls);
  for (const operation of [() => tracker.read("FAKE-1"), () => tracker.assigned(), () => tracker.comment!("FAKE-1", "hello")]) {
    await assert.rejects(operation(), (err: Error & { status?: number }) => err.message === `Linear answered ${FAULT_STATUS}` && err.status === FAULT_STATUS && isTransient(err));
  }
  assert.equal(calls.figures().linear.failures, 3, "each refused call is counted as a failed call to Linear, as the plugin counts it");
  assert.ok(calls.lastCalls("linear").failed !== undefined);
});

test("a fault turned off answers from the same tickets again, and the good call is counted", async () => {
  const fault = { on: true };
  const calls = createCallLedger();
  const tracker = faultyTracker(seeded(), fault, calls);
  await assert.rejects(tracker.read("FAKE-1"));
  fault.on = false;
  assert.equal((await tracker.read("FAKE-1"))?.key, "FAKE-1");
  assert.deepEqual(calls.figures().linear, { calls: 2, failures: 1, failuresPer100: 50 });
});

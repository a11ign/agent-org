// no-token: none -- the fake tracker holds tickets in memory, and the suite writes only into a scratch folder
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTrackerConformance } from "../conformance/tracker.ts";
import { ContractError } from "../conformance/suite.ts";
import type { TicketSource } from "../contracts/tracker.ts";
import { createFakeTracker, fakeTicket } from "./tracker.ts";

const seeded = () => createFakeTracker([fakeTicket("FAKE-1"), fakeTicket("FAKE-2")]);
const probe = { known: "FAKE-1", missing: "FAKE-404", other: "FAKE-2" };

test("the fake tracker passes the tracker contract suite, and the checks that ran are the ones asserted", async () => {
  const { passed, skipped } = await runTrackerConformance(seeded(), probe);
  assert.deepEqual(passed, [
    "shape", "assigned lists tickets", "read answers a ticket by its key", "read answers null for a key the tracker has none of", "download returns the paths it fetched",
    "viewer names the person whose key this is", "me names the person by id and name", "people counts who holds the open tickets", "scoped pages a scope's tickets",
    "stateTypes answers a Map of the keys it knows", "pullStates answers a Map by key", "blockers answers a Map, leaving out a key with no ticket",
    "projectSummaries answers a Map, leaving out a key with no project", "keywords name the words a pull request body is read by",
    "updateTicketText writes the fields it is given and no others", "addBlockers records a relation once, and again without error", "complete finishes a ticket once and leaves a finished one alone",
  ]);
  assert.deepEqual(skipped, [], "the fake has every optional operation, so nothing is skipped");
});

test("a tracker with only the three required operations passes, and each optional check is skipped with its reason, never counted as a pass", async () => {
  const fake = seeded();
  const minimal: TicketSource = { assigned: fake.assigned, read: fake.read, download: fake.download };
  const { passed, skipped } = await runTrackerConformance(minimal, probe);
  assert.equal(passed.length, 5, "shape and the four required checks");
  assert.ok(skipped.length > 0 && skipped.every(({ reason }) => reason.length > 0));
  assert.ok(skipped.some(({ check }) => check.startsWith("viewer")));
  assert.ok(!passed.some((check) => check.startsWith("viewer")));
});

test("a tracker that answers a guess for a key it has none of fails by name, and every failure is listed", async () => {
  const fake = seeded();
  const guessing: TicketSource = { ...fake, read: async (key) => fake.ticketOf(key) ?? fakeTicket(key), download: async () => "not a list" as unknown as string[] };
  await assert.rejects(runTrackerConformance(guessing, probe), (error: unknown) => error instanceof ContractError && error.concern === "tracker"
    && error.failures.map(({ check }) => check).join() === "read answers null for a key the tracker has none of,download returns the paths it fetched" && /tracker plugin failed its contract suite/.test(error.message));
});

test("a thing with no read is not a tracker, and nothing else is run", async () => {
  await assert.rejects(runTrackerConformance({ assigned: async () => [] } as unknown as TicketSource, probe), (error: unknown) => error instanceof ContractError && error.failures.length === 1 && error.failures[0].check === "shape");
});

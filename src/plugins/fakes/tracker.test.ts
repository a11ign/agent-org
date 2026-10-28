// no-token: none -- the fake tracker holds tickets in memory, and the suite writes only into a scratch folder
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { runTrackerConformance } from "../conformance/tracker.ts";
import { ContractError } from "../conformance/suite.ts";
import type { TicketSource } from "../contracts/tracker.ts";
import { createFakeTracker, FAKE_TRACKER_WRITING, fakeTicket } from "./tracker.ts";

const seeded = () => createFakeTracker([fakeTicket("FAKE-1"), fakeTicket("FAKE-2")]);
const probe = { known: "FAKE-1", missing: "FAKE-404", other: "FAKE-2" };

test("the fake tracker passes the tracker contract suite, and the checks that ran are the ones asserted", async () => {
  const { passed, skipped } = await runTrackerConformance(seeded(), probe, FAKE_TRACKER_WRITING);
  assert.deepEqual(passed, [
    "shape", "assigned lists tickets", "read answers a ticket by its key", "read answers null for a key the tracker has none of", "download returns the paths it fetched",
    "viewer names the person whose key this is", "me names the person by id and name", "people counts who holds the open tickets", "scoped pages a scope's tickets",
    "projects lists the open projects by id and name", "projectPage pages a project's tickets", "search of no words finds nothing",
    "stateTypes answers a Map of the keys it knows",
    "texts answers each key's description and updatedAt, as read gives the description, and leaves out a key with no ticket",
    "readComments answers each comment's author, ISO time and body, and is refused for a key the tracker has none of",
    "detachPlan of a title the ticket has no attachment under changes nothing and is no error", "pullStates answers a Map by key", "blockers answers a Map, leaving out a key with no ticket",
    "projectSummaries answers a Map, leaving out a key with no project", "keywords name the words a pull request body is read by",
    "undoAutomaticCompletion answers who completed the ticket, moves back only the integration's completion, and is refused for a key the tracker has none of",
    "updateTicketText writes the fields it is given and no others", "addBlockers records a relation once, and again without error",
    "a blocker's titles, when it gives any, are text for pull requests it links",
    "claim records the claimant, claims reads the latest one back, and a repeated claim changes nothing",
    "comment posts on a ticket in any state, and is refused for a key the tracker has none of", "complete finishes a ticket once and leaves a finished one alone",
    "writing grants the create and attach tools, and its filing pattern covers every one", "writing refuses a creation that names an id, which would update a ticket",
    "writing reads a created ticket's key back by the shape it declares", "writing numbers every priority, and none is 0",
  ]);
  assert.deepEqual(skipped, [], "the fake has every optional operation and declares its writing, so nothing is skipped");
});

test("without the writer tooling the four checks of it are skipped with their reason, never counted as a pass (contract 1.1)", async () => {
  const { passed, skipped } = await runTrackerConformance(seeded(), probe);
  assert.deepEqual(skipped.map(({ check }) => check), [
    "writing grants the create and attach tools, and its filing pattern covers every one", "writing refuses a creation that names an id, which would update a ticket",
    "writing reads a created ticket's key back by the shape it declares", "writing numbers every priority, and none is 0",
  ]);
  assert.ok(skipped.every(({ reason }) => /passed no writer tooling/.test(reason)));
  assert.ok(!passed.some((check) => check.startsWith("writing")));
});

test("a writing that does not hang together fails by name: a granted tool its filing pattern misses, an id that is not refused, a priority that is no whole number", async () => {
  const broken = {
    ...FAKE_TRACKER_WRITING, filingTools: "^mcp__fake__create_ticket$", refusedInputs: [], priorities: { ...FAKE_TRACKER_WRITING.priorities, none: 5, low: 4.5 },
  };
  await assert.rejects(runTrackerConformance(seeded(), probe, broken), (error: unknown) => error instanceof ContractError
    && error.failures.map(({ check }) => check).join("|") === ["writing grants the create and attach tools, and its filing pattern covers every one", "writing refuses a creation that names an id, which would update a ticket",
      "writing numbers every priority, and none is 0"].join("|")
    && /filingTools must cover the granted tool mcp__fake__prepare_upload/.test(error.message));
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

test("download writes the files a ticket holds, with their text, into the folder it is given, and a ticket the fake holds nothing of has none", async () => {
  const fake = seeded();
  fake.attach("FAKE-1", "attachment-1-FAKE-1-0001-plan-x.md", "## Paths\n\n- `a:b.ts`\n");
  const dir = mkdtempSync(join(tmpdir(), "fake-tracker-"));
  try {
    const paths = await fake.download(fakeTicket("FAKE-1"), dir);
    assert.deepEqual(paths, [join(dir, "attachment-1-FAKE-1-0001-plan-x.md")]);
    assert.equal(readFileSync(paths[0], "utf8"), "## Paths\n\n- `a:b.ts`\n");
    assert.deepEqual(await fake.download(fakeTicket("FAKE-404"), dir), [], "a ticket never seeded has no files, so a core test that queues any ticket and downloads for it works");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A11-173: comment posts one comment on a ticket in any state, moves nothing, and is refused for a ticket the tracker has none of", async () => {
  const fake = seeded();
  await fake.complete!("FAKE-1", "completed");
  await fake.comment!("FAKE-1", "After-merge checks for FAKE-1");
  assert.deepEqual(fake.comments, [{ key: "FAKE-1", text: "completed" }, { key: "FAKE-1", text: "After-merge checks for FAKE-1" }], "one call, one comment, on a ticket already completed");
  assert.equal(fake.ticketOf("FAKE-1")?.statusType, "completed", "and the ticket is where it was");
  await assert.rejects(fake.comment!("FAKE-404", "text"), /no ticket/);
});

test("A11-178: undoAutomaticCompletion moves back a completion by the integration with a comment, leaves a person's alone, and says nothing was completed otherwise", async () => {
  const fake = createFakeTracker([fakeTicket("FAKE-1", { status: "In Progress", statusType: "started" }), fakeTicket("FAKE-2", { status: "In Progress", statusType: "started" }), fakeTicket("FAKE-3")]);
  fake.completeAs("FAKE-1", "integration");
  fake.completeAs("FAKE-2", "person");
  assert.deepEqual(await fake.undoAutomaticCompletion!("FAKE-1", "put back"), { reopened: { from: "In Progress", to: "Done" }, by: "integration", note: null });
  assert.deepEqual([fake.ticketOf("FAKE-1")?.status, fake.ticketOf("FAKE-1")?.statusType, fake.comments], ["In Progress", "started", [{ key: "FAKE-1", text: "put back" }]], "moved back to the state it left, once, with the comment");
  assert.deepEqual(await fake.undoAutomaticCompletion!("FAKE-1", "again"), { reopened: null, by: "none", note: null }, "a ticket no longer completed is left alone, and gets no second comment");
  assert.deepEqual(await fake.undoAutomaticCompletion!("FAKE-2", "put back"), { reopened: null, by: "person", note: null });
  assert.deepEqual([fake.ticketOf("FAKE-2")?.status, fake.comments.length], ["Done", 1], "a person's completion stays, with no comment");
  assert.equal((await fake.undoAutomaticCompletion!("FAKE-3", "put back")).by, "none");
  await assert.rejects(fake.undoAutomaticCompletion!("FAKE-404", "put back"), /no ticket/);
});

test("A11-207: a blocker's titles are optional: the fake gives a pull request's title when it was linked with one, and none otherwise", async () => {
  const fake = createFakeTracker([fakeTicket("FAKE-1"), fakeTicket("FAKE-2"), fakeTicket("FAKE-3")]);
  await fake.addBlockers!("FAKE-1", ["FAKE-2", "FAKE-3"]);
  fake.linkPull("FAKE-2", "https://github.com/a11ign/x/pull/1", "merged", "feat: x");
  fake.linkPull("FAKE-2", "https://github.com/a11ign/x/pull/2", "open");
  fake.linkPull("FAKE-3", "https://github.com/a11ign/x/pull/3", "open");
  const [titled, untitled] = (await fake.blockers!(["FAKE-1"])).get("FAKE-1")!;
  assert.deepEqual(titled.titles, { "https://github.com/a11ign/x/pull/1": "feat: x" }, "only the pull request linked with a title has one");
  assert.deepEqual(Object.keys(titled.pulls), ["https://github.com/a11ign/x/pull/1", "https://github.com/a11ign/x/pull/2"]);
  assert.equal("titles" in untitled, false, "a blocker none of whose pull requests has a title carries no titles");
});

test("A11-207: a tracker whose blockers give a title for a pull request the blocker does not link, or a title that is no text, fails the contract suite by name", async () => {
  const fake = seeded();
  const lying: TicketSource = { ...fake, blockers: async (keys) => new Map(keys.map((key) => [key, [{ key: "FAKE-2", state: "unstarted", status: "Todo", pulls: {}, titles: { "https://github.com/a11ign/x/pull/9": "feat: x" } }]])) };
  await assert.rejects(runTrackerConformance(lying, probe, FAKE_TRACKER_WRITING), (error: unknown) => error instanceof ContractError
    && error.failures.some(({ check }) => check === "a blocker's titles, when it gives any, are text for pull requests it links"));
});

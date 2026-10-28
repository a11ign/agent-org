// no-token: gh -- herdr, the tracker and the clock are all injected; nothing is spawned
//
// A ticket's comments reach the run before it plans or works (tracker contract 1.8). A ticket's description floated one theory, a later comment gave the real cause and said it superseded the
// description, and the worker, briefed with the description alone, re-raised the theory the comment had ruled out. So the planner's and the worker's briefs carry every person's comment, oldest
// first, and the board's own bookkeeping is left out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { poolFixture } from "./pool-fixture.ts";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
import { batchPlanBriefText } from "./worker-files.ts";
import type { TicketSource } from "./source.ts";
import { ticketDir } from "./ticket-paths.ts";

const KEY = "ABC-7";
const THEORY = "Maybe the two services share one database.";
const CAUSE = "This supersedes the description: the cause is the cache key, and the fix is one line in `cache.ts`.";
const PLANNER = { plan: "-plan-[^/]*\\.md$", planner: { run: "Run the planner with: unattended: plan {key} into {dir}", state: "Planned" } };

/** A tracker holding ABC-7, whose description floats a theory and whose later comment gives the cause, beside one of the board's own After-merge comments. */
function discussed() {
  const fake = createFakeTracker([fakeTicket(KEY, { description: THEORY })]);
  fake.discuss(KEY, { author: "Sam Reviewer", createdAt: "2026-10-20T12:00:00.000Z", body: CAUSE });
  fake.discuss(KEY, { author: "Alex Author", createdAt: "2026-10-19T09:00:00.000Z", body: "Could it be the database?" });
  fake.discuss(KEY, { author: "Alex Author", createdAt: "2026-10-21T09:00:00.000Z", body: `After-merge checks for ${KEY}, now that acme/web#3 merged:\n- the page loads (ops)` });
  const source: TicketSource = { assigned: fake.assigned, read: fake.read, download: fake.download, keywords: fake.keywords, readComments: fake.readComments };
  return source;
}

/** The brief a first start of ABC-7 writes, as a worker or, with `tickets`, as a planner. */
async function briefOf(source: TicketSource, over: Partial<Parameters<typeof poolFixture>[0]> = {}): Promise<string> {
  const made = poolFixture({ keys: [KEY], max: 1, source, ...over });
  await made.pool.tick();
  return readFileSync(join(ticketDir(made.settings, KEY), "brief.md"), "utf8");
}

/** The comments in `brief`, oldest first, and the rest of what the section must say. */
function assertComments(brief: string, rule: RegExp): void {
  const earlier = brief.indexOf("**Alex Author, 2026-10-19T09:00:00.000Z:**");
  const later = brief.indexOf("**Sam Reviewer, 2026-10-20T12:00:00.000Z:**");
  assert.ok(earlier > brief.indexOf(THEORY) && later > earlier, "every comment follows the description, oldest first, with its author and date");
  assert.ok(brief.includes(`> ${CAUSE}`), "the comment's own words reach the run");
  assert.match(brief, /A later comment can correct or supersede the description/);
  assert.match(brief, rule);
  assert.equal(brief.includes("the page loads (ops)"), false, "the board's own bookkeeping is left out");
}

test("a worker's brief carries every comment a person wrote on its ticket, oldest first, and its pull request body names the ones it acted on", async () => {
  assertComments(await briefOf(discussed()), /Your pull request body carries a `Comments acted on` section/);
});

test("a planner's brief carries the same comments, and its plan names the ones it acted on", async () => {
  assertComments(await briefOf(discussed(), { planFirst: [KEY], tickets: PLANNER }), /Your plan carries a `## Comments acted on` section/);
});

test("a tracker that refuses the read of the comments, or cannot give them, is said in the brief, and the run still starts", async () => {
  const refusing: TicketSource = { ...discussed(), readComments: async () => { throw new Error("the tracker answered 503"); } };
  assert.match(await briefOf(refusing), /The board could not read this ticket's comments \(the tracker answered 503\)\./);
  const { readComments, ...without } = discussed();
  assert.ok(readComments !== undefined);
  assert.match(await briefOf(without), /The board could not read this ticket's comments \(this tracker does not give the board a ticket's comments\)\./);
});

test("a batch's planning brief carries each ticket's comments under that ticket", () => {
  const ticket = fakeTicket(KEY, { description: THEORY });
  const brief = batchPlanBriefText({ tickets: [{ ticket, attachments: [], parent: null, comments: { kind: "read", comments: [{ author: "Sam Reviewer", createdAt: "2026-10-20T12:00:00.000Z", body: CAUSE }], complete: true } }],
    runDir: "/d", planDir: "/d/plan", clones: { web: "/repos/web" }, run: "plan {keys} into {dir}" });
  assert.ok(brief.indexOf(`### Comments on ${KEY}`) > brief.indexOf(THEORY), "under the ticket's own section");
  assert.ok(brief.includes(`> ${CAUSE}`));
  assert.match(brief, /Your plan carries a `## Comments acted on` section/);
});

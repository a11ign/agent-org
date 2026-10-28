// no-token: gh -- the code host, the reviewer, herdr, the tracker and the clock are all injected fakes; nothing is spawned
// module: the planner's round for a stand-off (A11-290) -- it gets the review, the reply and the re-review, and it decides: it amends the plan's decision (and the reviewer re-reviews bound by the amendment), or it upholds it (and the worker acts)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { herdrName } from "./pool-herdr.ts";
import { clock, MINUTE, PLANNER, settled, standoffRun, trackerWith } from "./pool-standoff-fixture.ts";
import { logOf } from "./queue/run-log.ts";
import { ticketDir } from "./ticket-paths.ts";
import { STANDOFF_DECISION_FILE, STANDOFF_PLANNER_FILE } from "./standoff-files.ts";

const OLD_PLAN = "# Plan\n\n## Key decisions\n\n- The bundle stays under 200 KB.\n";
const NEW_PLAN = "# Plan\n\n## Key decisions\n\n- The bundle stays under 400 KB, the entry point's own size.\n\n## Decisions made without a person\n\n- Technical: the limit is 400 KB. Reason: the entry point is 300 KB.\n";

/** A stand-off the worker's reply sent to the planner, with the planner's round started and its files written, as a planner leaves them. */
async function plannerRound() {
  const tracker = trackerWith("Make the pages draw their last data at once.");
  const attached: { key: string; files: readonly string[] }[] = [];
  const attachPlan = tracker.attachPlan!.bind(tracker);
  tracker.attachPlan = async (key, files, state) => { attached.push({ key, files }); return attachPlan(key, files, state); };
  const run = await standoffRun({ tickets: PLANNER, tracker, plan: OLD_PLAN });
  const dir = ticketDir(run.fixture.settings, "NBF-1");
  await run.startRereview("Plan cannot be met: the plan's own 200 KB limit is below the entry point's 300 KB.");
  await run.refuseRereview();
  await run.pool.watchFeedback();
  clock.ms += MINUTE;
  await run.pool.tick();
  await settled();
  /** The planner ends its round with `decision`, having written `plan` into its plan folder when it amended. */
  const decide = async (decision: "amended" | "upheld", plan?: string) => {
    writeFileSync(join(dir, STANDOFF_DECISION_FILE), JSON.stringify({ decision, reason: decision === "amended" ? "The limit cannot be met by this entry point." : "The entry point can be split." }));
    if (plan !== undefined) writeFileSync(join(dir, "plan", "NBF-1-0001-plan-first.md"), plan);
    writeFileSync(join(dir, "outcome.json"), JSON.stringify({ kind: "reviewed" }));
    run.fixture.status.set(herdrName("NBF-1"), "idle");
    await run.pool.tick();
    await settled();
  };
  return { ...run, dir, attached, decide };
}

test("A11-290: the stand-off goes to the planner as a round of its own: a planner's brief with the review, the reply and the re-review, the marks that hold its Stop, and no code to change", async () => {
  const { dir, entry, fixture } = await plannerRound();
  assert.equal(entry().phase, "running");
  assert.equal(entry().standoff?.stage, "planner");
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.match(brief, /stand-off round \(planner\)/);
  for (const named of ["The bundle is over the plan's 200 KB limit.", "Plan cannot be met: the plan's own 200 KB limit", "340 KB", "NBF-1-0001-plan-first.md", "Decisions made without a person", STANDOFF_DECISION_FILE, "`contradicts`"]) {
    assert.ok(brief.includes(named), `the planner is told: ${named}`);
  }
  assert.ok(existsSync(join(dir, STANDOFF_PLANNER_FILE)), "its Stop is held to a decision");
  assert.ok(readFileSync(join(dir, "deny.json"), "utf8").includes("a planning run changes no repository"), "and it changes no repository");
  assert.ok(existsSync(join(dir, "plan")), "and a plan folder of its own, empty, for an amended plan");
  assert.ok(fixture.herdr.calls.some((call) => call.includes("create")), "a workspace was opened for it");
});

test("A11-290: the planner UPHOLDS the decision: no plan is attached, the decision is recorded with its reason, and the worker's round follows with what the planner decided", async () => {
  const { attached, decide, entry, pool, fixture } = await plannerRound();
  await decide("upheld");
  assert.equal(entry().phase, "finished");
  assert.deepEqual({ ...entry().standoff }.stage, "planned");
  assert.deepEqual(entry().standoff?.planner, { decision: "upheld", reason: "The entry point can be split." });
  assert.deepEqual(attached, [], "a decision that stands changes no plan");
  await pool.watchFeedback();
  assert.equal(entry().standoff?.stage, "worker", "the worker acts next");
  assert.match(entry().feedback ?? "", /The planner decided this stand-off: it upheld the decision\. Its reason:\n\n> The entry point can be split\./);
  const events = logOf(fixture.store.get(), "NBF-1").flatMap((event) => (event.kind === "standoff" ? [`${event.step}${event.detail === null ? "" : `: ${event.detail}`}`] : []));
  assert.deepEqual(events, ["planner", "decided: upheld: The entry point can be split.", "worker: the planner upheld the decision"]);
  await settled();
});

test("A11-290: the planner AMENDS the decision: the amended plan is attached, the decision is recorded, and the reviewer re-reviews the same head bound by the amendment", async () => {
  const { attached, decide, entry, pool, reviewer, host, dir } = await plannerRound();
  const started = reviewer.started.length;
  await decide("amended", NEW_PLAN);
  assert.equal(entry().phase, "finished");
  assert.equal(entry().standoff?.planner?.decision, "amended");
  assert.deepEqual(attached.map(({ key }) => key), ["NBF-1"], "the amended plan is attached to the ticket");
  assert.ok(readFileSync(join(dir, "paths", "NBF-1-0001-plan-first.md"), "utf8").includes("400 KB"), "and the reviewer's brief reads it");
  clock.ms += MINUTE;
  await pool.reviewNewHeads();
  assert.equal(reviewer.started.length, started + 1, "the reviewer re-reviews the same head");
  const brief = reviewer.briefs.at(-1);
  assert.ok(brief?.planDecisions?.includes("400 KB"), "bound by the amended decision");
  assert.deepEqual(brief?.rereview?.planDecisions?.filter(({ kind }) => kind === "added").map(({ text }) => text).some((text) => text.includes("400 KB")), true, "and told which lines of the plan's decisions changed");
  assert.equal(host.pullAt(entry().standoff!.url)!.head, entry().standoff!.head, "no commit was needed");
  await settled();
});

test("A11-290: a planner round that decides nothing, or whose amended plan the board refuses, is handed to a person with the reason, never lost", async () => {
  const none = await plannerRound();
  writeFileSync(join(none.dir, "outcome.json"), JSON.stringify({ kind: "reviewed" }));
  none.fixture.status.set(herdrName("NBF-1"), "idle");
  await none.pool.tick();
  await settled();
  assert.equal(none.entry().outcome?.kind, "needs-human");
  const outcome = none.entry().outcome;
  assert.match(outcome?.kind === "needs-human" ? outcome.reason : "", /the planner's round for a stand-off: the planner's round wrote no standoff-decision\.json/);
  const empty = await plannerRound();
  await empty.decide("amended");
  assert.equal(empty.entry().outcome?.kind, "needs-human", "an amended decision with no plan files is refused by the board's plan check");
  assert.deepEqual(empty.attached, []);
  await settled();
});

test("A11-290: a plan the board cannot read now, or that records no decision now, is not an amended plan, and summons no reviewer for a block nobody answered", async () => {
  const run = await standoffRun({ tickets: PLANNER, plan: OLD_PLAN });
  const started = run.reviewer.started.length;
  const paths = join(ticketDir(run.fixture.settings, "NBF-1"), "paths");
  rmSync(paths, { recursive: true, force: true });
  writeFileSync(paths, "not a folder\n");
  await run.pool.reviewNewHeads();
  rmSync(paths, { force: true });
  mkdirSync(paths, { recursive: true });
  await run.pool.reviewNewHeads();
  assert.equal(run.reviewer.started.length, started, "an unreadable plan and an empty one are no answer");
  writeFileSync(join(paths, "NBF-1-0001-plan-first.md"), NEW_PLAN);
  await run.pool.reviewNewHeads();
  assert.equal(run.reviewer.started.length, started + 1, "CONTROL: the amended decisions are");
  await settled();
});

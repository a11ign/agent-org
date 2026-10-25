// no-token: gh -- the code host, the reviewer, herdr and the clock are all injected fakes; nothing is spawned
// module: herdr's refusal to start a reviewer reaches the card, and the second identical refusal is a Needs you (A11-241)
//
// Built on `pool-fixture.ts`: a pool over the in-memory code host and a reviewer whose start herdr refuses. The finished run NBF-1 holds the pull request, so its card is the one a person reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDirForFile } from "../lib/tmp-fixture.ts";
import { herdrStartRefusalReason } from "../herdr-agents.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeReviewer } from "../plugins/fakes/reviewer.ts";
import { poolFixture } from "./pool-fixture.ts";
import type { Outcome } from "./queue/queue-entries-and-outcomes.ts";
import { logOf } from "./queue/run-log.ts";
import { loadReviewerGate, noReviewerMemory, readReviewerMemory, reviewedRepositoriesOf, reviewerMemoryPath, writeReviewerMemory } from "./reviewer-port.ts";
import { recordReviewerRefusal } from "./queue/queue-reviewer-refusal.ts";
import { runStatus } from "./board-view/pull-status-and-notes.ts";
import { reasonOf } from "./board-view/run-reason.ts";
import type { ViewEntry } from "./board-view/view-types-and-filters.ts";

const REPO = "a11ign/nbl-ui-netbox";
const NAME = "reviewer-nbl-ui-netbox-11";
const HERDR_SAYS = "invalid_agent_name: agent name must start with a lowercase letter and contain only lowercase letters, digits, '-' or '_' (1-32 characters)";
const OTHER_REASON = "agent_limit: too many agents";
const NOT_HERDRS = "another instance (`pool-b`) holds the review of the pull request";
/** What the reviewer plugin reports when herdr refuses the start: the workspace it opened is closed after, and its id differs every time. */
const refusedWith = (reason: string, workspace: string): string => `herdr refused to start "${NAME}" (${reason}) -- the workspace it opened (${workspace}) was closed`;

/** The finished run NBF-1 holding pull request 11 of `REPO`, over a code host whose reviewer is asked to start for it. */
async function refusedRun() {
  await loadReviewerGate();
  const fixture = poolFixture({ keys: ["NBF-1"], tickets: { reviewer: "atomic", drafts: false } });
  const host = createFakeCodeHost("worker-bot");
  const { url } = host.seedPull(REPO, 11, { head: "h1", body: "Closes NBF-1\n", settled: true, trust: "inside" });
  const reviewer = createFakeReviewer();
  await reviewer.load();
  const queue = fixture.store.get();
  const outcome = { kind: "ready-pr", prs: [{ repo: "nbl-ui-netbox", url }] } as Outcome;
  fixture.store.set({ ...queue, entries: [{ ...queue.entries[0], phase: "finished", finishedAt: 15, outcome }] });
  const pool = fixture.restart({ codeHost: host, reviewer });
  const entry = () => fixture.store.get().entries[0];
  const view = () => entry() as unknown as ViewEntry;
  const needsYouEvents = () => logOf(fixture.store.get(), "NBF-1").filter((event) => event.kind === "needs-you").length;
  const memory = () => readReviewerMemory(reviewerMemoryPath(fixture.settings.stateDir)).memory;
  return { fixture, host, reviewer, pool, url, entry, view, memory, needsYouEvents, pull: host.pullAt(url)! };
}

type Run = Pick<Awaited<ReturnType<typeof refusedRun>>, "reviewer" | "pool">;

let workspaces = 0;
/** One sweep over which herdr refuses the start for `reason`, and closes a workspace of its own, as it does each time. */
function sweepRefused({ reviewer, pool }: Run, reason: string = HERDR_SAYS): void {
  workspaces += 1;
  reviewer.refuseWith(refusedWith(reason, `w${workspaces}`));
  pool.reviewNewHeads();
}

/** Two sweeps in a row over which herdr refuses for the same reason: the run reads Needs you. */
function refusedTwice(run: Run & Pick<Awaited<ReturnType<typeof refusedRun>>, "view">): void {
  sweepRefused(run);
  sweepRefused(run);
  assert.equal(runStatus(run.view()), "needs-you");
}

/** One sweep over which the start is refused for a reason that is not herdr's. */
function sweepHeld({ reviewer, pool }: Run): void {
  reviewer.refuseWith(NOT_HERDRS);
  pool.reviewNewHeads();
}

test("A11-241: the first refusal is said on the pull request's line with herdr's reason, and the run does not ask anyone yet", async () => {
  const run = await refusedRun();
  sweepRefused(run);
  assert.match(run.pool.pullReviews()[run.url], /^not reviewed: herdr refused to start "reviewer-nbl-ui-netbox-11" \(invalid_agent_name: agent name must start/);
  assert.equal(runStatus(run.view()), "awaiting-review");
  assert.equal(run.entry().reviewerRefused, undefined);
});

test("A11-241: the second identical refusal is Needs you, and the card says herdr's reason; the closed workspace's id, which differs each time, does not make two refusals different", async () => {
  const run = await refusedRun();
  refusedTwice(run);
  const { line } = reasonOf(run.view());
  assert.match(line ?? "", /^a11ign\/nbl-ui-netbox #11: herdr refused to start "reviewer-nbl-ui-netbox-11" \(invalid_agent_name: agent name must start with a lowercase letter/);
  assert.doesNotMatch(line ?? "", /workspace it opened/, "the changing note about the closed workspace is not what the card says");
  assert.equal(run.needsYouEvents(), 1);
});

test("A11-241: a third refusal does not log Needs you again, and the retry on every sweep goes on", async () => {
  const run = await refusedRun();
  for (let sweep = 0; sweep < 4; sweep += 1) sweepRefused(run);
  assert.equal(run.needsYouEvents(), 1, "Needs you is logged for the run once");
  assert.equal(run.reviewer.started.length, 0);
  run.reviewer.refuseWith(null);
  run.pool.reviewNewHeads();
  assert.equal(run.reviewer.started.length, 1, "the board did not stop asking herdr: a fix made elsewhere is picked up with nobody pressing anything");
});

test("A11-241: a different reason starts the count again at 1, so the run stops asking until the new reason repeats", async () => {
  const run = await refusedRun();
  refusedTwice(run);
  sweepRefused(run, OTHER_REASON);
  assert.equal(runStatus(run.view()), "awaiting-review", "a reason herdr has not given twice is not yet a Needs you");
  assert.deepEqual([...run.memory().refusals], [[`${run.url}@h1`, { reason: `herdr refused to start "${NAME}" (${OTHER_REASON})`, count: 1 }]]);
  sweepRefused(run, OTHER_REASON);
  assert.equal(runStatus(run.view()), "needs-you");
});

test("A11-241: a start that works clears the refusal from the card and from the memory", async () => {
  const run = await refusedRun();
  refusedTwice(run);
  run.reviewer.refuseWith(null);
  run.pool.reviewNewHeads();
  assert.deepEqual([runStatus(run.view()), run.entry().reviewerRefused, run.memory().refusals.size], ["awaiting-review", undefined, 0]);
});

test("A11-241: the count survives a restart of the pool, so the second refusal after it is the one that asks", async () => {
  const run = await refusedRun();
  sweepRefused(run);
  assert.equal(run.memory().refusals.get(`${run.url}@h1`)?.count, 1, "on disk after the first refusal");
  // The fake reviewer reports what it refuses when a pool is made, as a reviewer whose gate does not load does; herdr's refusal comes at a start, so it is set after.
  run.reviewer.refuseWith(null);
  const restarted = run.fixture.restart({ codeHost: run.host, reviewer: run.reviewer });
  sweepRefused({ reviewer: run.reviewer, pool: restarted });
  assert.equal(runStatus(run.view()), "needs-you");
  assert.equal(run.memory().refusals.get(`${run.url}@h1`)?.count, 2);
});

test("A11-241: a refusal that is not herdr's (another instance holds the review) is never counted, and ends a run of herdr's", async () => {
  const run = await refusedRun();
  for (let sweep = 0; sweep < 3; sweep += 1) sweepHeld(run);
  assert.deepEqual([runStatus(run.view()), run.memory().refusals.size], ["awaiting-review", 0]);
  sweepRefused(run);
  sweepHeld(run);
  sweepRefused(run);
  assert.equal(runStatus(run.view()), "awaiting-review", "herdr's two refusals were not in a row");
});

test("A11-241: a new head is a new review, so the old head's refusals are forgotten", async () => {
  const run = await refusedRun();
  sweepRefused(run);
  run.pull.head = "h2";
  sweepRefused(run);
  assert.deepEqual([...run.memory().refusals].map(([key, { count }]) => [key, count]), [[`${run.url}@h2`, 1]]);
  assert.equal(runStatus(run.view()), "awaiting-review");
});

test("A11-241: a pull request that is no longer open takes its refusal, and the Needs you, with it", async () => {
  const run = await refusedRun();
  // Every repository the sweep lists has to be listable, or the sweep does not know which pull requests are gone.
  for (const repository of reviewedRepositoriesOf(run.fixture.settings.clones)) run.host.seedRepository(repository);
  sweepRefused(run);
  sweepRefused(run);
  assert.equal(run.entry().reviewerRefused !== undefined, true);
  run.pull.state = "closed";
  run.pool.reviewNewHeads();
  assert.deepEqual([run.entry().reviewerRefused, run.memory().refusals.size, runStatus(run.view())], [undefined, 0, "awaiting-review"]);
});

test("A11-241: herdr's part of a refusal is what it says without the closed workspace's id; a refusal that is not herdr refusing to start is none", () => {
  const closed = refusedWith(HERDR_SAYS, "w9");
  assert.equal(herdrStartRefusalReason(closed), `herdr refused to start "${NAME}" (${HERDR_SAYS})`);
  assert.equal(herdrStartRefusalReason(`herdr refused to start "r" (no) -- AND the workspace it opened (w2) could NOT be closed (x)`), 'herdr refused to start "r" (no)');
  assert.equal(herdrStartRefusalReason('herdr refused to start "r" (no)'), 'herdr refused to start "r" (no)', "a refusal with no workspace to close is whole");
  assert.equal(herdrStartRefusalReason(NOT_HERDRS), null);
  assert.equal(herdrStartRefusalReason("no reviewer for u: its checks at h1 have not settled green"), null);
});

test("A11-241: the refusals are kept on disk, written only when there are some; a file from before them reads with none, and a bad entry is left out without forgetting the started heads", () => {
  const path = join(tmpDirForFile("reviewer-refusals-"), "reviewers.json");
  const memory = { ...noReviewerMemory(), started: new Set(["u@h1"]), refusals: new Map([["u@h1", { reason: 'herdr refused to start "r" (no)', count: 2 }]]) };
  writeReviewerMemory(path, memory);
  assert.deepEqual(readReviewerMemory(path), { memory, unreadable: false });
  writeReviewerMemory(path, { ...memory, refusals: new Map() });
  assert.equal("refusals" in JSON.parse(readFileSync(path, "utf8")), false, "a pool whose starts herdr never refused writes the file it always wrote");
  writeFileSync(path, JSON.stringify({ heads: {}, started: ["u@h1"], resumed: [], refusals: { a: { reason: "why", count: 2 }, b: { reason: 3, count: 1 }, c: { reason: "x", count: 0 }, d: "no" } }));
  const lenient = readReviewerMemory(path);
  assert.equal(lenient.unreadable, false);
  assert.deepEqual([[...lenient.memory.started], [...lenient.memory.refusals]], [["u@h1"], [["a", { reason: "why", count: 2 }]]]);
});

test("A11-241: the note is written only over a run that waits on a review, and a run that failed keeps its own words", async () => {
  const run = await refusedRun();
  const queue = run.fixture.store.get();
  assert.equal(recordReviewerRefusal(queue, "NBF-1", "u: refused", 1).entries[0].reviewerRefused, "u: refused");
  const failed = { ...queue, entries: [{ ...queue.entries[0], outcome: { kind: "crashed", reason: "boom" } as Outcome }] };
  assert.equal(recordReviewerRefusal(failed, "NBF-1", "u: refused", 1), failed, "a crashed run reads Failed, and stays so");
  const noted = recordReviewerRefusal(queue, "NBF-1", "u: refused", 1);
  assert.equal(recordReviewerRefusal(noted, "NBF-1", "u: refused", 2), noted, "the same note again changes nothing");
  assert.equal(recordReviewerRefusal(noted, "NBF-1", null).entries[0].reviewerRefused, undefined, "and null takes it off");
  assert.equal(recordReviewerRefusal(queue, "NBF-1", null), queue, "a run with none has nothing to take off");
  const inRound = { ...noted, entries: [{ ...noted.entries[0], phase: "running" as const }] };
  assert.equal(recordReviewerRefusal(inRound, "NBF-1", null).entries[0].reviewerRefused, undefined, "a run in a round when its refusal went away does not read Needs you again when it finishes");
  assert.equal(recordReviewerRefusal({ ...queue, entries: [{ ...queue.entries[0], phase: "running" as const }] }, "NBF-1", "u: refused").entries[0].reviewerRefused, undefined, "and a note is not written over a run that is not finished");
});

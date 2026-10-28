// no-token: gh -- the code host, herdr, the tracker and the clock are all injected fakes; nothing is spawned
// module: a Decisions entry added to a ticket reaches its worker (A11-305) -- the board starts a round for it, the round's brief and Stop mark lead with it, the card waits, and Respond names it
//
// THE SHAPE OF 2026-10-26 (A11-291, a11ign/plugin#11): the chairman added a decision to a ticket whose pull request was approved, pressed Respond, and the round's brief said only "answer the feedback". Built on `pool-fixture.ts` as the stand-off
// tests are: a finished run NBF-1 holding pull request 1, briefed with `BEFORE`, whose ticket the tracker now says is `AFTER`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
import { ARM, FIRST_FLOW_NOTE, MINUTE as MIN, NO_FLOW } from "./board-view/not-merging.test.support.ts";
import { runStatus } from "./board-view/pull-status-and-notes.ts";
import { DECISIONS_CHANGED } from "./decisions-change.ts";
import { DECISIONS_ROUND_FILE } from "./decisions-files.ts";
import { poolFixture } from "./pool-fixture.ts";
import { settled } from "./pool-standoff-fixture.ts";

import { respond } from "./queue/queue-transitions.ts";
import { retry, type Entry, type Outcome } from "./queue/queue-entries-and-outcomes.ts";
import type { TicketSource } from "./source.ts";
import { ticketDir } from "./ticket-paths.ts";
import { ticketReadOf } from "./ticket-read.ts";

const REPO = "a11ign/nbl-ui-netbox";
const HEAD = "h1";
const BODY = "Closes NBF-1\n\n## Outside-Region\n\nnone\n";
const BEFORE = "Rework the merge flow.\n\n## Done-when\n\n- it merges\n\n## Decisions (the chairman, 2026-10-24)\n\n- Keep the ruleset.\n";
const NEW_LINE = "- Private repositories get a merge bot, not a ruleset.";
const AFTER = `${BEFORE}\n## Decisions (the chairman, 2026-10-26)\n\n${NEW_LINE}\n`;

const clock = { ms: 0 };

/** A tracker that holds NBF-1 as `text.description`, the way Linear gives its text, for one call and for many keys. */
function trackerOf(text: { description: string }): { tracker: TicketSource; asked: string[][] } {
  const fake = createFakeTracker([fakeTicket("NBF-1", { description: BEFORE })]);
  const asked: string[][] = [];
  const tracker: TicketSource = {
    ...fake,
    read: async (key) => { const held = await fake.read(key); return held === null ? null : { ...held, description: text.description }; },
    texts: async (keys) => { asked.push([...keys]); return new Map(keys.map((key) => [key, { description: text.description, updatedAt: "2026-10-26T21:30:34.076Z" }])); },
  };
  return { tracker, asked };
}

/** The pool's run NBF-1 made a finished one that ended on `outcome` and was briefed with `BEFORE`; `over` changes it. */
function endRun(fixture: ReturnType<typeof poolFixture>, outcome: Outcome, over: Partial<Entry> = {}): void {
  const queue = fixture.store.get();
  fixture.store.set({ ...queue, entries: [{ ...queue.entries[0], phase: "finished", finishedAt: 15 * MIN, outcome, briefedAgainst: ticketReadOf({ description: BEFORE }, 0), ...over }] });
}

/** A finished run NBF-1 holding pull request 1 and briefed with `BEFORE`, over a tracker whose ticket reads `text.description`. `over` changes the run. */
function finishedRun({ over = {}, description = AFTER }: { over?: Partial<Entry>; description?: string } = {}) {
  clock.ms = 30 * MIN;
  const text = { description };
  const { tracker, asked } = trackerOf(text);
  const fixture = poolFixture({ keys: ["NBF-1"], tickets: { drafts: false }, now: () => clock.ms, descriptions: { "NBF-1": BEFORE }, source: tracker });
  const host = createFakeCodeHost("worker-bot");
  const { url } = host.seedPull(REPO, 1, { head: HEAD, body: BODY, settled: true, trust: "inside" });
  endRun(fixture, { kind: "ready-pr", prs: [{ repo: "nbl-ui-netbox", url }] } as Outcome, { rounds: 1, ...over });
  const pool = fixture.restart({ codeHost: host });
  const entry = () => fixture.store.get().entries[0];
  return { fixture, host, pool, entry, url, text, asked, dir: ticketDir(fixture.settings, "NBF-1") };
}

/** A person presses Respond on the run, its round starts, and the brief the worker is given is read. */
async function respondAndRead({ fixture, pool, dir }: Pick<ReturnType<typeof finishedRun>, "fixture" | "pool" | "dir">): Promise<string> {
  fixture.store.set(respond(fixture.store.get(), "NBF-1", clock.ms));
  clock.ms += MIN;
  await pool.tick();
  await settled();
  return readFileSync(join(dir, "brief.md"), "utf8");
}

/** The first `## ` heading of a brief. */
const firstSection = (text: string): string => text.split("\n").find((line) => line.startsWith("## ")) ?? "";

test("A11-305: a Decisions entry added to a ticket with an open pull request starts a round, with no one pressing Respond, and the round's brief opens with it", async () => {
  const { fixture, pool, entry, url, dir, host } = finishedRun();
  await pool.refreshTracker();
  const round = entry();
  assert.equal(round.phase, "queued", "the board queued a round");
  assert.deepEqual(round.review?.map((pull) => pull.url), [url], "for the ticket's open pull request");
  assert.equal(round.decisions, true);
  assert.equal(round.asked, undefined, "nobody asked");
  assert.equal(round.rounds, 1, "it counts toward no cap: a person wrote the change");
  const logged = fixture.store.get().runLog?.["NBF-1"]?.filter((event) => event.kind === "round").at(-1);
  assert.ok(logged?.kind === "round" && logged.cause === "decisions" && logged.reason === "## Decisions (the chairman, 2026-10-26)");

  clock.ms += MIN;
  await pool.tick();
  await settled();
  assert.equal(entry().phase, "running", "and it starts like any round");
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  assert.equal(firstSection(brief), "## The ticket's Decisions changed", "its first section is the change");
  assert.ok(brief.includes(DECISIONS_CHANGED));
  assert.ok(brief.includes(`+ ${NEW_LINE}`));
  assert.match(brief, /decisions round/);
  const mark = JSON.parse(readFileSync(join(dir, DECISIONS_ROUND_FILE), "utf8")) as { added: string[]; heads: Record<string, string> };
  assert.deepEqual(mark, { added: ["## Decisions (the chairman, 2026-10-26)", NEW_LINE], heads: { [url]: HEAD } }, "the Stop hook is left the new lines and the head the pull request had");
  const asked = host.calls.filter((call) => call.endsWith(url));
  assert.ok(asked.indexOf(`refreshPull ${url}`) !== -1 && asked.indexOf(`refreshPull ${url}`) < asked.lastIndexOf(`readReviewState ${url}`), "A11-365: the head is read afresh, since the Stop hook compares it with the pull request later and a read shared with the sweep can be as old as the sweep");
  assert.ok(fixture.herdr.calls.some((call) => call.some((arg) => arg.includes("This ticket's Decisions changed."))), "and the agent starts on a prompt that says why");
});

test("A11-305: the round is started once: the run is briefed with the new text, so the same Decisions start nothing again", async () => {
  const { fixture, pool, entry } = finishedRun();
  await pool.refreshTracker();
  clock.ms += MIN;
  await pool.tick();
  await settled();
  fixture.store.set({ ...fixture.store.get(), entries: [{ ...entry(), phase: "finished", finishedAt: clock.ms }] });
  await pool.refreshTracker();
  assert.equal(entry().phase, "finished", "no second round");
  assert.equal(fixture.store.get().runLog?.["NBF-1"]?.filter((event) => event.kind === "round").length, 1);
});

test("A11-305: a change that adds no Decisions line starts no round: other text, a decision taken out, an unchanged ticket", async () => {
  for (const description of [BEFORE, `${BEFORE}\n## Notes\n\nmore prose\n`, "Rework the merge flow.\n\n## Done-when\n\n- it merges\n"]) {
    const { pool, entry, asked } = finishedRun({ description });
    await pool.refreshTracker();
    assert.equal(entry().phase, "finished", description);
    assert.deepEqual(asked.at(-1), ["NBF-1"], "the tracker was asked");
    assert.equal(entry().decisionsPending, undefined);
  }
});

test("A11-305: the tracker is asked only about runs it can tell a change for: one with a pull request open and a record of the text it was briefed with", async () => {
  const unrecorded = finishedRun({ over: { briefedAgainst: undefined } });
  await unrecorded.pool.refreshTracker();
  assert.deepEqual(unrecorded.asked, [], "no record of what it was briefed with");
  assert.equal(unrecorded.entry().phase, "finished");
  const merged = finishedRun({ over: { pullStates: { "https://github.com/a11ign/nbl-ui-netbox/pull/1": "merged" } } });
  await merged.pool.refreshTracker();
  assert.deepEqual(merged.asked, [], "its pull request merged");
  const settledTicket = finishedRun({ over: { trackerState: "completed" } });
  await settledTicket.pool.refreshTracker();
  assert.deepEqual(settledTicket.asked, [], "the tracker completed the ticket");
});

test("A11-305: a run the board cannot start a round for is marked instead, and the mark goes when the Decisions read as the run was briefed with", async () => {
  for (const [name, over] of [["a parked run", { workspace: "w1", pane: "w1:p1" }], ["drafts a person approves", { outcome: { kind: "draft-pr", prs: [{ repo: "nbl-ui-netbox", url: "https://github.com/a11ign/nbl-ui-netbox/pull/1" }] } as Outcome }]] as const) {
    const { pool, entry, text } = finishedRun({ over });
    await pool.refreshTracker();
    assert.equal(entry().phase, "finished", name);
    assert.equal(entry().decisionsPending?.added.at(-1), NEW_LINE, name);
    const written = JSON.stringify(entry());
    await pool.refreshTracker();
    assert.equal(JSON.stringify(entry()), written, `${name}: a later read finds the same state and rewrites nothing`);
    text.description = BEFORE;
    await pool.refreshTracker();
    assert.equal(entry().decisionsPending, undefined, `${name}: the mark goes with the change`);
  }
});

test("A11-305: Respond on a run whose Decisions changed leads its brief with the change, whatever else the round answers", async () => {
  // The board's own read of the tracker has not noticed: a person pressed Respond first, as the chairman did on A11-291.
  const run = finishedRun();
  const brief = await respondAndRead(run);
  assert.equal(run.entry().asked, true);
  assert.equal(run.entry().decisions, undefined);
  assert.equal(firstSection(brief), "## The ticket's Decisions changed");
  assert.ok(brief.includes(DECISIONS_CHANGED));
  assert.ok(brief.includes(`+ ${NEW_LINE}`), "with the same diff");
  assert.match(brief, /A person asked you to answer the current feedback/, "and it is still the round a person asked for");
  assert.ok(existsSync(join(run.dir, DECISIONS_ROUND_FILE)), "held to it at the Stop hook as well");
});

test("A11-305: a round that finds the Decisions as the last round read them has no such section and leaves the Stop hook no mark", async () => {
  const run = finishedRun({ description: BEFORE });
  const brief = await respondAndRead(run);
  assert.ok(!brief.includes("## The ticket's Decisions changed"));
  assert.ok(!existsSync(join(run.dir, DECISIONS_ROUND_FILE)));
});

/** A finished run whose approved pull request adds the repository's first merge flow, over a tracker whose ticket reads `AFTER`: the card of A11-291 for a pull request about to change. */
function firstFlowRun() {
  const text = { description: AFTER };
  const { tracker } = trackerOf(text);
  const host = createFakeCodeHost("worker-bot");
  const repo = "a11ign/plugin";
  const { url } = host.seedPull(repo, 10, { head: "91cfe96d0a1b2c3d4e5f", files: ["README.md", ARM], queue: { queued: false, removals: [] }, feedback: { reviewDecision: "approved", verdictAtHead: "approved", armed: false } });
  host.seedMergeFlow(repo, NO_FLOW);
  clock.ms = 30 * MIN;
  const fixture = poolFixture({ keys: ["NBF-1"], tickets: { drafts: false }, now: () => clock.ms, descriptions: { "NBF-1": BEFORE }, source: tracker });
  endRun(fixture, { kind: "ready-pr", prs: [{ repo: "plugin", url }] } as Outcome);
  return { fixture, pool: fixture.restart({ codeHost: host }), entry: () => fixture.store.get().entries[0], text };
}

test("A11-305: the first-merge-flow card is not raised for a pull request whose ticket has a round pending on a Decisions change", async () => {
  const run = firstFlowRun();
  // The board has read the change and queued the round before its watch reads the pull request: the watch finds a run in a round and writes no note.
  await run.pool.refreshTracker();
  assert.equal(run.entry().phase, "queued");
  run.pool.watchFeedback();
  assert.equal(run.entry().mergeNote, undefined, "no person is asked to merge a pull request that is about to change");
  assert.notEqual(runStatus(run.entry()), "needs-you");
});

test("A11-305: a note raised before the board read the change goes when the round is queued", async () => {
  const run = firstFlowRun();
  run.text.description = BEFORE;
  run.pool.watchFeedback();
  assert.equal(run.entry().mergeNote, FIRST_FLOW_NOTE, "before the change, the card is raised as A11-291 made it");
  assert.equal(runStatus(run.entry()), "needs-you");
  run.text.description = AFTER;
  await run.pool.refreshTracker();
  assert.equal(run.entry().phase, "queued");
  assert.equal(run.entry().mergeNote, undefined, "the round dropped the note, with the rest of what a finished run holds");
  assert.notEqual(runStatus(run.entry()), "needs-you");
});

test("A11-305: a run with no record of what it was briefed with is told of no change", async () => {
  const legacy = finishedRun({ over: { briefedAgainst: undefined } });
  const brief = await respondAndRead(legacy);
  assert.ok(!brief.includes("## The ticket's Decisions changed"), "nothing to compare with");
  assert.ok(!existsSync(join(legacy.dir, DECISIONS_ROUND_FILE)));
});

test("A11-305: a retried Decisions round is still a Decisions round, and the cause that started it is not lost", () => {
  const { fixture } = finishedRun();
  const queue = fixture.store.get();
  const pulls = queue.entries[0].outcome && "prs" in queue.entries[0].outcome ? queue.entries[0].outcome.prs : [];
  const crashed = { ...queue, entries: [{ ...queue.entries[0], review: pulls, decisions: true, outcome: { kind: "crashed", reason: "the agent exited" } as Outcome }] };
  const retried = retry(crashed, "NBF-1", clock.ms).entries[0];
  assert.equal(retried.phase, "queued");
  assert.equal(retried.decisions, true, "it is not retried as the round for approved drafts");
});

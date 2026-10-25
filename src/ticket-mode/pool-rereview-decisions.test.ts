// no-token: gh -- the code host, the reviewer, herdr, the tracker and the clock are all injected fakes; nothing is spawned
// module: a Decisions entry in the ticket answers a reviewer's block (A11-250) -- the sweep over a blocked head whose ticket's Decisions changed since its last look, and the claims of a decision that no entry supports
//
// Built on `pool-fixture.ts` as `pool-rereview.test.ts` is: a finished run NBF-1 that holds pull request 1, whose first review the reviewer blocked. What answers the block here is the ticket: the board wrote a person's
// answer into it (`recordAnswer`, what the answer route does to the run's copy), or a person edited its Decisions in the tracker. Nothing here pushes a commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeReviewer } from "../plugins/fakes/reviewer.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import { withAnswer } from "./answer-decision.ts";
import { poolFixture } from "./pool-fixture.ts";
import type { Outcome } from "./queue/queue-entries-and-outcomes.ts";
import { recordAnswer } from "./queue/queue-answer.ts";
import { MAX_FEEDBACK_ROUNDS } from "./queue/queue-transitions.ts";
import { loadReviewerGate, readReviewerMemory, REVIEWER_LOGIN, reviewerMemoryPath, writeReviewerMemory } from "./reviewer-port.ts";
import { decisionsOf } from "./ticket-decisions.ts";
import { ticketReadOf } from "./ticket-read.ts";
import type { TicketSource } from "./source.ts";

const REPO = "a11ign/nbl-ui-netbox";
const HEAD = "h1";
const MINUTE = 60_000;
const BODY = "Closes NBF-1\n";
const TICKET_URL = "https://linear.app/x/NBF-1";
const QUESTION = "Which wording should the round cap use: keep the current one, or the shorter one?";
const ANSWER = "Keep the current wording.";
const PLAIN = "Fix the toast.\n\n## Done-when\n\n- the toast reads right\n";
const ENTRY = "## Decisions (the chairman, 2026-10-25)";
/** The ticket as the board writes it once the chairman has answered the question. */
const ANSWERED = withAnswer(PLAIN, { question: QUESTION, answer: ANSWER, who: "the chairman", date: "2026-10-25" }).description;

const clock = { ms: 0 };

/** A finished run NBF-1 holding pull request 1, with the reviewer's first review of `HEAD` behind it: started with `described` as the ticket's description, ended, and blocked. */
async function blockedRun({ described = PLAIN, rounds = 0, tracker, held = true }: { described?: string; rounds?: number; tracker?: TicketSource; held?: boolean } = {}) {
  await loadReviewerGate();
  clock.ms = 10 * MINUTE;
  const fixture = poolFixture({ keys: ["NBF-1"], tickets: { reviewer: "atomic", drafts: false }, now: () => clock.ms, descriptions: { "NBF-1": described }, ...(tracker === undefined ? {} : { source: tracker }) });
  const host = createFakeCodeHost("worker-bot");
  const { url } = host.seedPull(REPO, 1, { head: HEAD, body: BODY, settled: true, trust: "inside" });
  const reviewer = createFakeReviewer();
  await reviewer.load();
  const queue = fixture.store.get();
  const outcome = { kind: "ready-pr", prs: [{ repo: "nbl-ui-netbox", url }] } as Outcome;
  fixture.store.set({ ...queue, entries: [{ ...queue.entries[0], phase: "finished", finishedAt: 15 * MINUTE, rounds, ...(held ? { outcome } : {}) }] });
  const pool = fixture.restart({ codeHost: host, reviewer });
  const pull = host.pullAt(url)!;
  const ref = { pr: url, head: HEAD };
  pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 1, "the first review of the head starts");
  reviewer.wrote(ref, null);
  clock.ms = 20 * MINUTE;
  pull.reviews = [{ author: REVIEWER_LOGIN, state: "CHANGES_REQUESTED", commit: HEAD, at: clock.ms }];
  pool.reviewNewHeads();
  assert.equal(reviewer.closed.length, 1, "and the reviewer closes once it has posted its block");
  clock.ms = 30 * MINUTE;
  const entry = () => fixture.store.get().entries[0];
  // The run's round that answers the block has ended, as in the finished run the board holds.
  fixture.store.set({ ...fixture.store.get(), entries: [{ ...entry(), finishedAt: clock.ms }] });
  /** The board writes a person's answer into the ticket and the run's copy of it moves on, as `answer` does. */
  const answered = (description = ANSWERED) => fixture.store.set(recordAnswer(fixture.store.get(), "NBF-1", ticketReadOf({ description }, clock.ms)));
  const reply = (text: string, minute: number) => { pull.replies = [...pull.replies, { author: "worker-bot", at: minute * MINUTE, url: `${url}#c${minute}`, text }]; };
  const settleRereview = () => { reviewer.wrote(ref, null); pool.reviewNewHeads(); };
  return { fixture, host, reviewer, pool, pull, url, ref, entry, answered, reply, settleRereview };
}

test("A11-250: a review after the answer is briefed with it: the answered entry reaches the reviewer's decisions, so the overruled finding is not repeated", async () => {
  const { reviewer, pool, answered } = await blockedRun();
  assert.equal(reviewer.briefs[0]?.decisions, undefined, "the first review was briefed with no decisions");
  answered();
  pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 2, "the answer re-reviews the same head");
  const decisions = reviewer.briefs[1]?.decisions;
  assert.equal(decisions, decisionsOf(ANSWERED));
  assert.ok(decisions?.includes(ENTRY) && decisions.includes(`* **Question:** ${QUESTION}`) && decisions.includes(`* **Answer:** ${ANSWER}`), "with the heading, the question and the answer, as the ticket words them");
});

test("A11-250: a change to the ticket's Decisions after a review re-reviews the same head once, tells the reviewer which lines changed, and counts as one round", async () => {
  const { fixture, host, reviewer, pool, url, entry, answered, settleRereview } = await blockedRun();
  pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 1, "a block nothing answered starts nothing");
  answered();
  pool.reviewNewHeads();
  assert.deepEqual(reviewer.started, [{ pr: url, head: HEAD }, { pr: url, head: HEAD }], "the second start is for the same head: no commit");
  const changed = reviewer.briefs[1]?.rereview?.decisions;
  assert.deepEqual(changed?.map(({ kind }) => kind), ["added", "added", "added"], "only lines the ticket gained");
  assert.deepEqual(changed?.map(({ text }) => text), [ENTRY, `* **Question:** ${QUESTION}`, `* **Answer:** ${ANSWER}`]);
  assert.deepEqual(reviewer.briefs[1]?.rereview?.replies, [], "no reply asked for it");
  assert.equal(reviewer.briefs[1]?.rereview?.body, undefined, "and the description of the pull request did not change");
  assert.equal(entry().rounds, 1, "counted in the round cap");
  settleRereview();
  for (let sweep = 0; sweep < 3; sweep += 1) {
    clock.ms += 10 * MINUTE;
    pool.reviewNewHeads();
  }
  fixture.restart({ codeHost: host, reviewer }).reviewNewHeads();
  assert.equal(reviewer.started.length, 2, "the same Decisions and the standing block start nothing more, before or after a restart");
  assert.equal(entry().rounds, 1);
});

test("A11-250: a second change to the Decisions re-reviews again, and tells only what changed since the last look", async () => {
  const { reviewer, pool, answered, settleRereview } = await blockedRun();
  answered();
  pool.reviewNewHeads();
  settleRereview();
  const second = withAnswer(ANSWERED, { question: "And the label?", answer: "Leave it.", who: "the chairman", date: "2026-10-25" }).description;
  clock.ms += 10 * MINUTE;
  answered(second);
  pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 3);
  assert.deepEqual(reviewer.briefs[2]?.rereview?.decisions?.map(({ text }) => text), ["* **Question:** And the label?", "* **Answer:** Leave it."]);
});

test("A11-250: a look that holds no decisions (written before they were kept) is not re-reviewed for them, and one that holds decisions is", async () => {
  const { fixture, host, reviewer, pool, url, answered } = await blockedRun();
  const path = reviewerMemoryPath(fixture.settings.stateDir);
  const { memory } = readReviewerMemory(path);
  const look = memory.looks.get(`${url}@${HEAD}`)!;
  assert.equal(look.decisions, "", "the look of the first review records that it was briefed with no decisions");
  const { decisions: _kept, ...older } = look;
  memory.looks.set(`${url}@${HEAD}`, older);
  writeReviewerMemory(path, memory);
  const restarted = fixture.restart({ codeHost: host, reviewer });
  answered();
  restarted.reviewNewHeads();
  assert.equal(reviewer.started.length, 1, "its decisions are unknown, so a change to them is not seen");
});

test("A11-250: a run with no round left is handed to a person when the Decisions change, and starts no reviewer", async () => {
  const { reviewer, pool, entry, answered } = await blockedRun({ rounds: MAX_FEEDBACK_ROUNDS });
  answered();
  pool.reviewNewHeads();
  pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 1);
  assert.equal(entry().rounds, MAX_FEEDBACK_ROUNDS);
  assert.match(entry().handedBack ?? "", /a11ign-reviewer's block on .*pull\/1 at h1 was answered by a change to the ticket's Decisions, and the board does not review it again/);
});

test("A11-250: a run that is still in its round is not re-reviewed for a Decisions change until the round has ended", async () => {
  const { fixture, reviewer, pool, entry, answered } = await blockedRun();
  fixture.store.set({ ...fixture.store.get(), entries: [{ ...entry(), phase: "running" }] });
  answered();
  pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 1);
  fixture.store.set({ ...fixture.store.get(), entries: [{ ...entry(), phase: "finished" }] });
  pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 2);
});

test("A11-250: a person's edit of the Decisions in the tracker reaches a finished run holding a blocked pull request, and re-reviews it once, changing nothing else of the run", async () => {
  const text = new Map([["NBF-1", { description: PLAIN, updatedAt: "2026-10-25T09:00:00.000Z" }]]);
  const tracker: TicketSource = { ...createFakeTracker(), texts: async (keys) => new Map(keys.flatMap((key) => (text.has(key) ? [[key, text.get(key)!] as const] : []))) };
  const { fixture, reviewer, pool, entry } = await blockedRun({ tracker });
  const before = entry();
  await pool.refreshTracker();
  assert.equal(entry().ticket.description, PLAIN, "a ticket that did not change moves nothing");
  text.set("NBF-1", { description: ANSWERED, updatedAt: "2026-10-25T10:00:00.000Z" });
  await pool.refreshTracker();
  assert.equal(entry().ticket.description, ANSWERED, "the run's copy of the text is the ticket's now");
  const { ticket: _was, ...rest } = before;
  const { ticket: _now, ...after } = entry();
  assert.deepEqual(after, rest, "and nothing else of the run changed: it is not briefed against the text, not marked stale, not told");
  pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 2);
  assert.equal(reviewer.briefs[1]?.rereview?.decisions?.length, 3);
  await pool.refreshTracker();
  pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 2, "and the same Decisions start nothing again");
  assert.equal(fixture.store.get().entries[0].rounds, 1);
});

test("A11-250: the tracker is not asked about a finished run whose pull request the reviewer has not blocked", async () => {
  const asked: string[][] = [];
  const tracker: TicketSource = { ...createFakeTracker(), texts: async (keys) => { asked.push([...keys]); return new Map(); } };
  const { pull, pool, fixture, entry } = await blockedRun({ tracker });
  await pool.refreshTracker();
  assert.deepEqual(asked.at(-1), ["NBF-1"], "a blocked pull request's run is asked about");
  asked.length = 0;
  pull.reviews = [{ author: REVIEWER_LOGIN, state: "APPROVED", commit: HEAD, at: clock.ms }];
  pool.reviewNewHeads();
  await pool.refreshTracker();
  assert.deepEqual(asked, [], "an approved one is not");
  assert.equal(fixture.store.get().entries[0], entry());
});

test("A11-250: a reply that says a person decided, with no entry in the ticket, reaches the reviewer as unsupported; the same reply linking a ticket that records the decision does not", async () => {
  const bare = "decided by the chairman, no change";
  const noEntry = await blockedRun();
  noEntry.reply(bare, 25);
  noEntry.pool.reviewNewHeads();
  assert.deepEqual(noEntry.reviewer.briefs[1]?.rereview?.unsupported, [bare], "the ticket has no Decisions: nothing supports it");
  assert.deepEqual(noEntry.reviewer.briefs[1]?.rereview?.replies.map(({ text }) => text), [bare], "and the reply is still quoted, for the reviewer to read");

  const linked = await blockedRun({ described: ANSWERED });
  linked.reply(`${bare}: ${TICKET_URL}`, 25);
  linked.pool.reviewNewHeads();
  assert.equal(linked.reviewer.started.length, 2);
  assert.equal(linked.reviewer.briefs[1]?.rereview?.unsupported, undefined, "the ticket records the decision and the reply links it");

  const unlinked = await blockedRun({ described: ANSWERED });
  unlinked.reply(bare, 25);
  unlinked.pool.reviewNewHeads();
  assert.deepEqual(unlinked.reviewer.briefs[1]?.rereview?.unsupported, [bare], "a ticket with the entry does not support a reply that does not link it");
});

test("A11-250: a claim added to the pull request body is unsupported too, and a body that claims nothing says nothing", async () => {
  const { reviewer, pool, pull } = await blockedRun();
  pull.body = `${BODY}The chairman said keep the wording.\nOutside-Region: none\n`;
  pool.reviewNewHeads();
  assert.deepEqual(reviewer.briefs[1]?.rereview?.unsupported, ["The chairman said keep the wording."]);
  const quiet = await blockedRun();
  quiet.pull.body = `${BODY}Outside-Region: none\n`;
  quiet.pool.reviewNewHeads();
  assert.equal(quiet.reviewer.briefs[1]?.rereview?.unsupported, undefined);
});

test("A11-250: a start that no run held records no decisions on its look, so a run that holds the pull request later is not re-reviewed for decisions it never compared", async () => {
  const { fixture, url, pool, reviewer, answered } = await blockedRun({ held: false });
  const { memory } = readReviewerMemory(reviewerMemoryPath(fixture.settings.stateDir));
  assert.equal(memory.looks.get(`${url}@${HEAD}`)?.decisions, undefined, "the brief carried no ticket: its decisions are unknown, not empty");
  answered();
  pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 1);
});

test("A11-250: a ticket that has only a Behaviour section records no Decisions: a reply linking it still claims a decision nothing supports", async () => {
  const { reviewer, pool, reply } = await blockedRun({ described: "Fix it.\n\n## Behaviour\n\n* It toasts.\n" });
  const claim = `decided by the chairman: ${TICKET_URL}`;
  reply(claim, 25);
  pool.reviewNewHeads();
  assert.deepEqual(reviewer.briefs[1]?.rereview?.unsupported, [claim]);
});

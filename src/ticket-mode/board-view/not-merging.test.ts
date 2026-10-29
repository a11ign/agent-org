// no-token: none -- pure functions over plain data; nothing is spawned
//
// A11-291: a pull request approved at its head, with green required checks, mergeable and not in the merge queue, is "Approved, not merging" on the card after 15 minutes (it was "Awaiting review"), reaches Needs you under the escalation list's access
// item after an hour, and a pull request that adds a repository's first merge flow reaches Needs you the day it is approved. a11ign/plugin#10 sat approved at 91cfe96d for a day in a repository with no merge flow. The watch over a pool is
// `not-merging-watch.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ARM, APPROVED, FIRST_FLOW_NOTE, FULL_FLOW, HEAD, HOUR_NOTE, LINE, MINUTE, NO_FLOW, NOW, PR, PRS, REPO, STUCK, flowOf, never, read, runWith } from "./not-merging.test.support.ts";
import { firstFlowNote, markedHeads, mergeNote, NOT_MERGING_MINUTES, NOT_MERGING_NEEDS_YOU_MINUTES, notMergingLine, stuckForAnHourNote, whyNotMerging } from "./not-merging.ts";
import { isWatched, runActions, runStatus, shownStatus, WAITS_ON_REVIEW, workStatus } from "./pull-status-and-notes.ts";
import { reasonOf } from "./run-reason.ts";
import { RUN_STATUSES, type PullHead, type ViewEntry } from "./view-types-and-filters.ts";
import type { PullFeedback } from "../../plugins/contracts/code-host.ts";

test("A11-291: the thresholds are 15 minutes for the card and 60 for Needs you, and the status has the words the ticket gives it", () => {
  assert.deepEqual([NOT_MERGING_MINUTES, NOT_MERGING_NEEDS_YOU_MINUTES], [15, 60]);
  assert.equal(RUN_STATUSES.find(({ status }) => status === "not-merging")?.label, "Approved, not merging");
  assert.equal(WAITS_ON_REVIEW.has("not-merging"), true, "a board note may turn such a run into Needs you");
});

test("A11-291: a head is stamped when it is first read approved, green, mergeable and out of the queue, kept at the same head, and dropped by anything else", async () => {
  const first = (await markedHeads({ [PR]: APPROVED }, { [PR]: read() }, undefined, 1000, never));
  assert.equal(first[PR].unmergedSince, 1000);
  assert.equal((await markedHeads({ [PR]: APPROVED }, { [PR]: read() }, first, 5000, never))[PR].unmergedSince, 1000, "a later read at the same head keeps the stamp, so the record does not change");
  assert.equal((await markedHeads({ [PR]: { ...APPROVED, head: "new" } }, { [PR]: read({ head: "new" }) }, first, 6000, never))[PR].unmergedSince, 6000, "a new head counts again");
  const dropped: [string, PullHead, Partial<PullFeedback>][] = [
    ["a review that is not an approval", { ...APPROVED, review: "none" }, {}],
    ["a red required check", { ...APPROVED, red: ["test"] }, {}],
    ["a required check still running", { ...APPROVED, pending: ["gate"] }, {}],
    ["a required check whose state was not read", { head: HEAD, approved: true, review: "approved" }, {}],
        ["a conflict", APPROVED, { conflicting: true }],
    ["a pull request in the merge queue", APPROVED, { queue: { queued: true, removals: [] } }],
    ["a host that does not say whether it is queued", APPROVED, { queue: undefined }],
    ["a merged pull request", APPROVED, { state: "merged" }],
  ];
  for (const [name, head, over] of dropped) {
    assert.equal("unmergedSince" in (await markedHeads({ [PR]: head }, { [PR]: read(over) }, first, 7000, never))[PR], false, name);
  }
  assert.equal("unmergedSince" in (await markedHeads({ [PR]: APPROVED }, {}, first, 8000, never))[PR], false, "a head the watch did not read carries no mark");
});

test("A11-291: the reason is asked for, and recorded, only once the pull request has been out of the queue for more than 15 minutes", async () => {
  const stamped = { [PR]: { ...APPROVED, unmergedSince: NOW } };
  const asked: string[] = [];
  const asking = async (repository: string) => { asked.push(repository); return NO_FLOW; };
  assert.equal("notMerging" in (await markedHeads({ [PR]: APPROVED }, { [PR]: read() }, stamped, NOW + 15 * MINUTE, asking))[PR], false, "exactly 15 minutes is not more");
  assert.deepEqual(asked, [], "and nothing is asked of the host before then");
  const late = (await markedHeads({ [PR]: APPROVED }, { [PR]: read() }, stamped, NOW + 16 * MINUTE, asking))[PR];
  assert.equal(late.unmergedSince, NOW);
  assert.equal(late.notMerging, "a11ign/plugin has no merge flow: auto-merge is not allowed, no .github/workflows/auto-arm.yml");
  assert.deepEqual(asked, [REPO]);
});

test("A11-291: the reason is the repository's missing flow when it can be read, else what the pull request itself says, else only that it is not in the queue", () => {
  assert.equal(whyNotMerging(REPO, read(), NO_FLOW), "a11ign/plugin has no merge flow: auto-merge is not allowed, no .github/workflows/auto-arm.yml");
  assert.equal(whyNotMerging(REPO, read(), flowOf({ autoMerge: false, armWorkflow: true })), "a11ign/plugin has no merge flow: auto-merge is not allowed");
  assert.equal(whyNotMerging(REPO, read(), flowOf({ autoMerge: true, armWorkflow: false })), "a11ign/plugin has no merge flow: no .github/workflows/auto-arm.yml");
  const flow = flowOf({ autoMerge: true, armWorkflow: true });
  assert.equal(whyNotMerging(REPO, read({ armed: false }), flow), "auto-merge is not on for it, and it is not in the merge queue");
  assert.equal(whyNotMerging(REPO, read({ armed: true }), flow), "auto-merge is on, but it is not in the merge queue");
  assert.equal(whyNotMerging(REPO, read(), flow), "it is not in the merge queue");
  assert.equal(whyNotMerging(REPO, read(), null), "it is not in the merge queue", "a repository the host could not read is not called flowless");
  assert.equal(whyNotMerging(REPO, read(), undefined), "it is not in the merge queue", "nor is a host that cannot be asked");
});

test("A11-291: a head that adds the arm workflow to a repository without one is marked as a first install the day it is approved, and no other head is", async () => {
  const adds = read({ files: ["README.md", ARM] });
  assert.equal((await markedHeads({ [PR]: APPROVED }, { [PR]: adds }, undefined, NOW, async () => NO_FLOW))[PR].firstFlow, true, "approved just now, no waiting");
  assert.equal("firstFlow" in (await markedHeads({ [PR]: APPROVED }, { [PR]: adds }, undefined, NOW, async () => (flowOf({ autoMerge: true, armWorkflow: true }))))[PR], false, "a repository that has the workflow: an edit of it is any change");
  assert.equal("firstFlow" in (await markedHeads({ [PR]: APPROVED }, { [PR]: adds }, undefined, NOW, async () => null))[PR], false, "a repository the host could not read is not called flowless");
  assert.equal("firstFlow" in (await markedHeads({ [PR]: { ...APPROVED, review: "none" } }, { [PR]: adds }, undefined, NOW, async () => NO_FLOW))[PR], false, "an unapproved head waits");
  assert.equal("firstFlow" in (await markedHeads({ [PR]: APPROVED }, { [PR]: read({ files: ["README.md"] }) }, undefined, NOW, never))[PR], false, "and nothing is asked of a pull request that touches no arm workflow");
  assert.equal("firstFlow" in (await markedHeads({ [PR]: APPROVED }, { [PR]: { ...adds, state: "merged" } }, undefined, NOW, async () => NO_FLOW))[PR], false, "a merged one is done");
});

test("A11-291: a run with a stuck pull request reads Approved, not merging, with the reason on its card; one that is not stuck still reads Awaiting review", () => {
  assert.equal(runStatus(runWith(APPROVED)), "awaiting-review", "approved and merging or young: waiting is waiting");
  assert.equal(runStatus(runWith(STUCK)), "not-merging");
  assert.equal(shownStatus(runWith(STUCK), undefined), "not-merging");
  assert.equal(notMergingLine(runWith(STUCK)), LINE);
  assert.equal(reasonOf(runWith(STUCK)).line, LINE, "the card's line");
  assert.equal(RUN_STATUSES.find(({ status }) => status === runStatus(runWith(STUCK)))?.label, "Approved, not merging", "and the words the card shows for the status");
  assert.equal(notMergingLine(runWith(APPROVED)), null);
});

test("A11-291: a needs-human run whose pull request was approved, and a reviewed run that is not ready, read it too; a draft and a Ready to merge run keep what they read", () => {
  const approvedAnswer = { outcome: { kind: "needs-human", reason: "q" }, review: PRS, outcomeHeads: { [PR]: HEAD } } as Partial<ViewEntry>;
  assert.equal(runStatus(runWith(APPROVED, approvedAnswer)), "awaiting-review", "POSITIVE CONTROL: the answer is read as approved, and the run awaits review");
  assert.equal(runStatus(runWith(STUCK, approvedAnswer)), "not-merging");
  assert.equal(runStatus(runWith(STUCK, { outcome: { kind: "draft-pr", prs: PRS } })), "awaiting-review", "a draft waits for its Approve, and is not meant to merge");
  assert.deepEqual(runActions(runWith(STUCK, { outcome: { kind: "draft-pr", prs: PRS } })).slice(0, 1), ["approve"], "which is still offered");
  const ready = runWith({ ...STUCK }, { outcome: { kind: "reviewed", prs: PRS } });
  assert.equal(runStatus(ready), "ready-to-merge", "Approve and Publish are offered from Ready to merge, so its status is left as it is");
  assert.equal(reasonOf(ready).line, LINE, "but its card says why nothing merges it");
});

test("A11-291: a run with a pull request not merging is still watched and still offers Respond, so it is read again until it merges", () => {
  const stuck = runWith(STUCK);
  assert.deepEqual(runActions(stuck), ["respond", "talk", "dismiss"]);
  assert.deepEqual(runActions(runWith(APPROVED)), runActions(stuck), "the same actions as when it is Awaiting review");
});

test("A11-291: after more than an hour the note is the escalation list's access item, naming the pull request, its head and the reason; before that, and for a parked or draft run, it is null", () => {
  const hours = (minutes: number, over: Partial<ViewEntry> = {}) => runWith({ ...STUCK, unmergedSince: NOW - minutes * MINUTE }, over);
  assert.equal(stuckForAnHourNote(hours(61), NOW), HOUR_NOTE);
  assert.equal(stuckForAnHourNote(hours(60), NOW), null, "more than 60, not 60");
  assert.equal(stuckForAnHourNote(hours(24 * 60), NOW), HOUR_NOTE, "the note does not count minutes, so it is the same on every watch");
  assert.equal(stuckForAnHourNote(hours(90, { workspace: "w1" }), NOW), null, "a parked run is already a person's");
  assert.equal(stuckForAnHourNote(hours(90, { phase: "running" }), NOW), null);
  assert.equal(stuckForAnHourNote(hours(90, { outcome: { kind: "draft-pr", prs: PRS } }), NOW), null);
  assert.equal(stuckForAnHourNote(hours(90, { pullStates: { [PR]: "merged" } }), NOW), null, "a merged pull request is not stuck");
});

test("A11-291: a first install of a merge flow is a note the day it is approved, first among the notes, and its sentence is recognised", () => {
  const installing = runWith({ ...APPROVED, firstFlow: true });
  assert.equal(firstFlowNote(installing), FIRST_FLOW_NOTE);
  assert.equal(firstFlowNote(runWith(APPROVED)), null);
  assert.equal(firstFlowNote(runWith({ ...APPROVED, firstFlow: true }, { workspace: "w1" })), null, "a parked run is a person's already");
  assert.equal(mergeNote(installing, NOW), FIRST_FLOW_NOTE, "and it comes before the hour's");
});

test("A11-291: a flicker in what GitHub knows of mergeable keeps the count, and a conflict ends it", async () => {
  const stamped = { [PR]: { ...APPROVED, unmergedSince: NOW } };
  const unknown = (await markedHeads({ [PR]: APPROVED }, { [PR]: read({ mergeable: false }) }, stamped, NOW + 5 * MINUTE, never));
  assert.equal(unknown[PR].unmergedSince, NOW, "UNKNOWN right after the base moved is not a change of the pull request");
  assert.equal("unmergedSince" in (await markedHeads({ [PR]: APPROVED }, { [PR]: read({ mergeable: false }) }, undefined, NOW, never))[PR], false, "but a count is not started from it");
  assert.equal("unmergedSince" in (await markedHeads({ [PR]: APPROVED }, { [PR]: read({ mergeable: false, conflicting: true }) }, stamped, NOW + 5 * MINUTE, never))[PR], false, "and a conflict ends it");
});

test("A11-291: a pull request into another branch than the default one (a stacked pull request) waits on its base and is not called stuck; the count still runs", async () => {
  const stamped = { [PR]: { ...APPROVED, unmergedSince: NOW } };
  const stacked = (await markedHeads({ [PR]: APPROVED }, { [PR]: read({ base: "a11-250-step-1" }) }, stamped, NOW + 90 * MINUTE, async () => FULL_FLOW))[PR];
  assert.equal("notMerging" in stacked, false);
  assert.equal(stacked.unmergedSince, NOW);
  assert.equal((await markedHeads({ [PR]: APPROVED }, { [PR]: read({ base: "main" }) }, stamped, NOW + 90 * MINUTE, async () => FULL_FLOW))[PR].notMerging, "it is not in the merge queue");
  assert.equal((await markedHeads({ [PR]: APPROVED }, { [PR]: read({ base: "a11-250-step-1" }) }, stamped, NOW + 90 * MINUTE, async () => null))[PR].notMerging, "it is not in the merge queue", "where the default branch is not known it is called stuck, as before");
});

test("A11-291: a run reads Approved, not merging only when every open pull request is stuck; one still waiting for its review keeps the run Awaiting review, and the stuck one is still named", () => {
  const other = "https://github.com/a11ign/agent-org/pull/9";
  const two = runWith(STUCK, { outcome: { kind: "ready-pr", prs: [...PRS, { repo: "agent-org", url: other }] }, pullHeads: { [PR]: STUCK, [other]: { head: "99998888", approved: false, review: "none", red: [], pending: [] } } });
  assert.equal(runStatus(two), "awaiting-review");
  assert.equal(notMergingLine(two), LINE, "but the card still says why the one is not merging");
  const both = runWith(STUCK, { outcome: { kind: "ready-pr", prs: [...PRS, { repo: "agent-org", url: other }] }, pullHeads: { [PR]: STUCK, [other]: { ...STUCK, head: "99998888" } } });
  assert.equal(runStatus(both), "not-merging");
});

test("A11-291: the note is a note on the run and not a hand-back: a Needs you run is still watched, offers Respond, and a Ready to merge one still offers Publish", () => {
  const noted = runWith(STUCK, { mergeNote: HOUR_NOTE });
  assert.equal(runStatus(noted), "needs-you");
  assert.equal(workStatus(noted), "not-merging", "its work is unchanged");
  assert.equal(isWatched(noted), true, "so the board goes on reading its feedback, its conflicts and its red checks");
  assert.deepEqual(runActions(noted), ["respond", "talk", "dismiss"]);
  const ready = runWith(STUCK, { mergeNote: HOUR_NOTE, outcome: { kind: "reviewed", prs: PRS } });
  assert.equal(runStatus(ready), "needs-you");
  assert.equal(workStatus(ready), "ready-to-merge", "and Approve and Publish are offered from it as before");
  assert.equal(shownStatus(runWith(STUCK, { mergeNote: HOUR_NOTE, published: { link: null, at: 1 }, outcome: { kind: "reviewed", prs: PRS } }), undefined), "needs-you");
  assert.equal(workStatus(runWith(STUCK, { mergeNote: HOUR_NOTE, published: { link: null, at: 1 }, outcome: { kind: "reviewed", prs: PRS } })), "published", "a run posted for a person to merge stays Published underneath");
});

test("A11-305: the first-install note waits while the run's ticket has Decisions no round has answered, and comes back once it has none", () => {
  const installing = { ...APPROVED, firstFlow: true as const };
  const pending = runWith(installing, { decisionsPending: { at: NOW } });
  assert.equal(firstFlowNote(pending), null, "the pull request is about to change: no person is asked to merge it");
  assert.equal(mergeNote(pending, NOW), null);
  assert.equal(firstFlowNote(runWith(installing)), FIRST_FLOW_NOTE, "the same run without the mark is the card of A11-291");
});

const PRIVATE = { private: true, autoMerge: false, armWorkflow: false } as const;

test("A11-291: the reason for a private repository is the merge bot's: its absence, else that it has not merged the pull request; a private repository with the ruleset flow is read as any other", () => {
  assert.equal(whyNotMerging(REPO, read(), flowOf({ ...PRIVATE, mergeBot: false })), "a11ign/plugin has no merge flow: no .github/workflows/merge-bot.yml (a private repository's flow is the merge bot)");
  assert.equal(whyNotMerging(REPO, read(), flowOf({ ...PRIVATE, mergeBot: true })), "the merge bot (.github/workflows/merge-bot.yml) has not merged it");
  assert.equal(whyNotMerging(REPO, read(), flowOf({ private: true, mergeBot: false })), "it is not in the merge queue", "auto-merge and the arm workflow both there: the ordinary reason");
  assert.equal(whyNotMerging(REPO, read(), flowOf({ autoMerge: false, armWorkflow: false, mergeBot: true })), "a11ign/plugin has no merge flow: auto-merge is not allowed, no .github/workflows/auto-arm.yml", "a public repository's merge bot is not its flow");
});

test("A11-291: a head that adds the merge bot to a repository with neither workflow is a first install; one that adds it where the bot or the arm workflow already is, is not", async () => {
  const bot = ".github/workflows/merge-bot.yml";
  const adds = read({ files: ["README.md", bot] });
  const first = async (flow: ReturnType<typeof flowOf>) => "firstFlow" in (await markedHeads({ [PR]: APPROVED }, { [PR]: adds }, undefined, NOW, async () => flow))[PR];
  assert.equal(await first(flowOf({ ...PRIVATE, mergeBot: false })), true);
  assert.equal(await first(flowOf({ ...PRIVATE, mergeBot: true })), false, "the repository has the bot already");
  assert.equal(await first(flowOf({ autoMerge: true, armWorkflow: true, mergeBot: false })), false, "the repository has the arm workflow already");
});

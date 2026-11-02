// no-token: gh -- `readPullFeedback` is handed fixture snapshots; nothing here spawns `gh` or needs a token.
// Contract 4.1: a review a CI workflow posts as a conversation comment is named at the head it reviewed, from the same query as the rest of the feedback, and is never an approval.
import { test } from "node:test";
import assert from "node:assert/strict";
import { corePolicy } from "../../src/plugins/policy.ts";
import type { ReviewCommentMatcher } from "../../src/plugins/contracts/review-comments.ts";
import { readPullFeedback } from "./pull-feedback.ts";
import { snapshotsHolding } from "./pull-snapshot-fixture.ts";

const REPOSITORY = "example/app";
const URL = `https://github.com/${REPOSITORY}/pull/806`;
const HEAD = "a".repeat(40);
const MATCHERS: readonly ReviewCommentMatcher[] = [{ author: "ci-bot", startsWith: "Review finished" }];
const at = (minute: number) => `2026-10-16T12:${String(minute).padStart(2, "0")}:00Z`;
const ms = (minute: number) => Date.parse(at(minute));

type Comment = { createdAt: string; lastEditedAt?: string | null; body: string; url?: string; author: { login: string } };

/** A pull request at {@link HEAD}, committed at `committed` (the commit is another when `commitOid` says so), with these conversation comments and force-pushes. */
const pullWith = ({ comments = [] as Comment[], committed = 10, commitOid = HEAD, forcePushes = [] as { minute: number; oid: string }[] } = {}) => ({
  state: "OPEN", headRefOid: HEAD, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", baseRefName: "main", reviewDecision: "REVIEW_REQUIRED", body: "",
  files: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }, reviews: { nodes: [] }, comments: { nodes: comments }, reviewThreads: { nodes: [] },
  timelineItems: { nodes: forcePushes.map(({ minute, oid }) => ({ __typename: "HeadRefForcePushedEvent", createdAt: at(minute), afterCommit: { oid } })) },
  commits: { nodes: [{ commit: { oid: commitOid, committedDate: at(committed), statusCheckRollup: { contexts: { nodes: [] } } } }] },
});

const comment = (minute: number, body = "Review finished in 2m", login = "ci-bot", lastEdited: number | null = null): Comment =>
  ({ createdAt: at(minute), lastEditedAt: lastEdited === null ? null : at(lastEdited), body, url: `${URL}#issuecomment-${minute}`, author: { login } });

const read = async (pull: ReturnType<typeof pullWith>, matchers: readonly ReviewCommentMatcher[] = MATCHERS) =>
  readPullFeedback(URL, "worker-bot", snapshotsHolding(pull, {}, REPOSITORY), corePolicy(), [], matchers);

test("a matching comment posted after the head arrived is the review comment at the head, the newest of them, and it approves nothing", async () => {
  const feedback = await read(pullWith({ comments: [comment(20), comment(30, "  Review finished, no issues")] }));
  assert.deepEqual(feedback?.commentReviewAtHead, { author: "ci-bot", at: ms(30), url: `${URL}#issuecomment-30` }, "the newest, and the body is trimmed before it is matched");
  assert.deepEqual([feedback?.approvedAtHead, feedback?.verdictAtHead], [false, null], "a comment is no review: the head is still unapproved");
});

test("a matching comment posted before the head arrived is not at the head: null", async () => {
  assert.equal((await read(pullWith({ comments: [comment(5)] })))?.commentReviewAtHead, null);
});

test("a comment edited after the head arrived counts from its edit; one created and edited before it does not", async () => {
  const placeholder = comment(5, "Review finished: all good", "ci-bot", 25);
  assert.deepEqual((await read(pullWith({ comments: [placeholder] })))?.commentReviewAtHead, { author: "ci-bot", at: ms(25), url: `${URL}#issuecomment-5` },
    "a CI review posts a placeholder and edits it in place when it finishes");
  assert.equal((await read(pullWith({ comments: [comment(3, "Review finished", "ci-bot", 8)] })))?.commentReviewAtHead, null, "both times are before the head");
});

test("another author, or a body that does not start with the text, is no review comment", async () => {
  assert.equal((await read(pullWith({ comments: [comment(20, "Review finished", "someone")] })))?.commentReviewAtHead, null, "another author");
  assert.equal((await read(pullWith({ comments: [comment(20, "Review is under way")] })))?.commentReviewAtHead, null, "another start");
  assert.equal((await read(pullWith({ comments: [comment(20, "Thanks. Review finished")] })))?.commentReviewAtHead, null, "the text elsewhere in the body");
});

test("a bot's login matches with or without its [bot] ending, either side", async () => {
  assert.equal((await read(pullWith({ comments: [comment(20, "Review finished", "ci-bot[bot]")] })))?.commentReviewAtHead?.author, "ci-bot[bot]");
  assert.equal((await read(pullWith({ comments: [comment(20)] }), [{ author: "ci-bot[bot]", startsWith: "Review finished" }]))?.commentReviewAtHead?.author, "ci-bot");
});

test("no matchers leaves the field out, which is today's answer", async () => {
  const feedback = await read(pullWith({ comments: [comment(20)] }), []);
  assert.equal(feedback !== null && "commentReviewAtHead" in feedback, false);
});

test("the head's arrival: the commit's time only when the commits connection is at the head, and a force-push to the head counts from the push", async () => {
  const lagging = await read(pullWith({ comments: [comment(20)], commitOid: "b".repeat(40) }));
  assert.equal(lagging !== null && "commentReviewAtHead" in lagging, false, "the connection is behind the branch and nothing else says when the head arrived: the host does not say");
  assert.deepEqual((await read(pullWith({ comments: [comment(20)], commitOid: "b".repeat(40), forcePushes: [{ minute: 15, oid: HEAD }] })))?.commentReviewAtHead?.at, ms(20), "the force-push says when it arrived");
  assert.equal((await read(pullWith({ comments: [comment(20)], forcePushes: [{ minute: 25, oid: HEAD }] })))?.commentReviewAtHead, null, "an older commit force-pushed after the comment");
  assert.deepEqual((await read(pullWith({ comments: [comment(20)], forcePushes: [{ minute: 25, oid: "c".repeat(40) }] })))?.commentReviewAtHead?.at, ms(20), "a force-push to another commit says nothing of this head");
});

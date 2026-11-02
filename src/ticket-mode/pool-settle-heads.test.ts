// no-token: none -- pure: a read of a pull request in, the head the board records out
//
// A11-340: what the board records of a head's review is what the reviews AT THAT HEAD say. GitHub's review decision follows the pull request, not the commit, and stays `changes-requested` after a push to a head nobody has reviewed.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PullFeedback } from "../plugins/contracts/code-host.ts";
import { pullHeadsOf } from "./pool-settle.ts";

const URL = "https://github.com/a11ign/announcement-emulator/pull/32";
const reviewOf = (over: Partial<PullFeedback>): unknown =>
  pullHeadsOf([{ url: URL, read: { head: "8b3d0ba9", approvedAtHead: false, failing: [], mergeable: true, state: "open", conflicting: false, base: "main", ...over } as PullFeedback }])[URL]?.review;

test("A11-340: a head with no review at that commit reads `none`, whatever GitHub's decision still says of an earlier one", () => {
  assert.equal(reviewOf({ reviewDecision: "changes-requested", verdictAtHead: null }), "none");
});

test("A11-340: the review at the head is what is recorded: changes requested there is changes requested, an approval there with a decision that asks for nothing more is approved", () => {
  assert.equal(reviewOf({ reviewDecision: "changes-requested", verdictAtHead: "changes-requested" }), "changes-requested");
  assert.equal(reviewOf({ reviewDecision: "review-required", verdictAtHead: "changes-requested" }), "changes-requested", "the verdict at the head counts whatever the decision says");
  assert.equal(reviewOf({ reviewDecision: "approved", verdictAtHead: "approved" }), "approved");
  assert.equal(reviewOf({ reviewDecision: null, verdictAtHead: "approved" }), "approved", "a branch that needs no review");
});

test("A11-340: an approval at the head that GitHub's decision does not yet count is not approved; a read that does not say is not read", () => {
  assert.equal(reviewOf({ reviewDecision: "review-required", verdictAtHead: "approved" }), "none");
  assert.equal(reviewOf({ reviewDecision: "changes-requested", verdictAtHead: "approved" }), "changes-requested", "an approval beside a request GitHub still holds is not approved, as before");
  assert.equal(reviewOf({ reviewDecision: "approved", verdictAtHead: null }), "none", "and an approval GitHub counts is no verdict at this head either");
  assert.equal(reviewOf({ verdictAtHead: undefined, reviewDecision: "changes-requested" }), undefined);
  assert.equal(reviewOf({ verdictAtHead: "changes-requested", reviewDecision: undefined }), undefined);
});

test("a review comment the code host named at the head (contract 4.1) is recorded beside the review, which it leaves as it was: none, never approved", () => {
  const headOf = (over: Partial<PullFeedback>) =>
    pullHeadsOf([{ url: URL, read: { head: "8b3d0ba9", approvedAtHead: false, failing: [], mergeable: true, state: "open", conflicting: false, base: "main", reviewDecision: "review-required", verdictAtHead: null, ...over } as PullFeedback }])[URL];
  const commented = headOf({ commentReviewAtHead: { author: "ci-bot", at: 5, url: `${URL}#issuecomment-1` } });
  assert.deepEqual([commented?.review, commented?.approved, commented?.commentReview], ["none", false, { author: "ci-bot", at: 5 }]);
  assert.equal(headOf({ commentReviewAtHead: null })?.commentReview, undefined, "none named");
  assert.equal(headOf({})?.commentReview, undefined, "the host did not say");
});

// @ts-check
// module: the review comments of the code host contract, version 4.1 -- a review a CI workflow posts as a conversation comment, which the board names and NEVER reads as an approval
//
// A TYPE FILE, beside `code-host.ts` (whose public surface is full): it imports nothing.

/** A comment that says a review was done (code host contract 4.1): its author's login, and the text its body starts with once trimmed. The host file's `tickets.reviewComments`. */
export type ReviewCommentMatcher = Readonly<{ author: string; startsWith: string }>;

/** The review comment `PullFeedback.commentReviewAtHead` names: who wrote it, when it was posted or last edited, whichever is later, and its address. */
export type CommentReview = Readonly<{ author: string; at: number; url: string }>;

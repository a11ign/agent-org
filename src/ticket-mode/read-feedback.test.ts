// no-token: none -- pure: a recording code host in, the arguments it was read with out
//
// Every read that reaches the board names the reviewer's accounts and the host file's review comments (code host contract 4.1): a read that left the comments out would lose the card's clause for them without a word.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolContext } from "./pool-context.ts";
import { readFeedbackOf } from "./read-feedback.ts";

test("readFeedbackOf reads with the accounts to ignore and the review comments the host file names", async () => {
  const calls: unknown[][] = [];
  const reviewComments = [{ author: "ci-bot", startsWith: "Review finished" }];
  const ctx = {
    codeHost: { readPullFeedback: async (...args: unknown[]) => { calls.push(args); return null; } },
    feedbackIgnores: ["reviewer-bot"],
    settings: { reviewComments },
  } as unknown as Pick<PoolContext, "codeHost" | "feedbackIgnores" | "settings">;
  assert.equal(await readFeedbackOf(ctx, "https://github.com/example/app/pull/1", "worker-bot"), null);
  assert.deepEqual(calls, [["https://github.com/example/app/pull/1", "worker-bot", ["reviewer-bot"], reviewComments]]);
});

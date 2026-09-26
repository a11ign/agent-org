// no-token: gh -- imports wake.mjs only to call `addressed`, a pure string builder; nothing here reaches `gh`, `herdr` or `git`
/**
 * #2590: A REVIEWER IS NOT BRIEFED TO STOP ON A REFUSED ROW CLAIM, BECAUSE A REVIEWER CLAIMS NO ROW.
 *
 * Measured 2026-09-26 on #2584: `reviewer-2584` ran `row-claim claim 2556`, was refused (`already claimed by
 * worker-2556`, the PR's own author) and ended its turn twice without a verdict. `addressed()` had appended
 * "If you cannot claim the row ... report it and stop" to every order that was not `spawned`.
 *
 * THE ENGINEER ORDER IS THE POSITIVE CONTROL: it must still carry the sentence, or the reviewer assertion
 * passes because the sentence was deleted for everyone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { addressed } from "./wake.mjs";

const CLAIM_SENTENCE = /cannot claim the row/;
const reviewerOrder = { session: "reviewer-2584", cause: "draft-awaiting-verdict", prompt: "x" };
const engineerOrder = { session: "engineers", cause: "ready-row-unclaimed", prompt: "x" };

test("#2590 a reviewer order does not carry the refused-claim sentence, and says it claims no row", () => {
  const text = addressed(reviewerOrder, "reviewer-2584");
  assert.doesNotMatch(text, CLAIM_SENTENCE);
  assert.match(text, /You claim no row, and the author's claim on it is not a blocker/);
});

test("#2590 POSITIVE CONTROL: a standing engineer order still carries the refused-claim sentence", () => {
  const text = addressed(engineerOrder, "worker-1");
  assert.match(text, CLAIM_SENTENCE);
  assert.doesNotMatch(text, /You claim no row/);
});

test("#2590 a reviewer cause addressed to a non-reviewer session is still an engineer order", () => {
  assert.match(addressed({ ...reviewerOrder, session: "engineers" }, "worker-1"), CLAIM_SENTENCE);
});

test("#2590 a non-reviewer cause addressed to a reviewer session keeps the sentence (isReviewerOrder decides, not the label)", () => {
  assert.match(addressed({ ...reviewerOrder, cause: "ready-row-unclaimed" }, "reviewer-2584"), CLAIM_SENTENCE);
});

test("#2590 a spawned order carries neither sentence", () => {
  const spawned = { row: 1, branch: "b", worktree: "/w", launchDir: "/w" };
  const text = addressed(engineerOrder, "worker-1", { spawned });
  assert.doesNotMatch(text, CLAIM_SENTENCE);
  assert.doesNotMatch(text, /You claim no row/);
});

// no-token: gh -- #3448. `decide` and `requiredWhenNeeded` are pure over the pull requests and the required list handed to them, and `performActions` is handed a `run` that records the call it would have made.
/**
 * #3448: A CONVINCED DRAFT WITH SETTLED GREEN REQUIRED CHECKS AT ITS HEAD IS MARKED READY BY THE GATE, WHATEVER ITS VERIFY STAMP SAYS.
 *
 * #3406 sat green, approved and a draft for hours: its stamp was RED ("no worktree ... is at head") because its author's worktree is not on the
 * host that stamps, so the gate ordered the author to run `verify` -- and the author's seat was busy. The stamp stays the rule for OPENING ready
 * (`pr-open-requires-verify-stamp.test.ts`, unchanged); over a pull request that is already a convinced draft, CI's own verdict on the required
 * checks stands in for it.
 *
 * Every negative differs from the positive control in exactly one field, so each "no flip" could have been a flip.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, performActions } from "../work-gate.ts";
import { requiredWhenNeeded } from "../work-gate/pr-orders.mjs";

const HEAD = "a".repeat(40);
const OLDER = "b".repeat(40);
const REQUIRED = ["gate"];
const GREEN = [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }];
const RED_STAMP = { state: "red", reasons: ["no worktree of a11ign is at head aaaaaaaaa, so there is no stamp for it"], project: "a11ign" };

type Pr = Record<string, unknown>;
type Order = { session: string, cause: string, prompt: string, action?: { kind: string, pr: number } };

const verdict = (head: string, by: string, word: string) => ({ body: `Review of #7 at \`${head.slice(0, 8)}\`, by \`${by}\`: ${word}.` });
/** The positive control: a convinced draft at HEAD, a RED stamp, and the one required check green at HEAD. */
const draft = (over: Pr = {}): Pr => ({
  number: 7, isDraft: true, headRefOid: HEAD, body: "b", headRefName: "agent/x",
  statusCheckRollup: GREEN, author: { login: "a11ign-ai-workers" }, labels: [{ name: "session:worker-1" }],
  comments: [verdict(HEAD, "reviewer-7", "convinced")], verifyStamp: RED_STAMP, ...over,
});

/** What the tick does with the pull request: the orders `decide` builds, and then what `performActions` runs and delivers. */
function tick(pr: Pr, required: string[] | null = REQUIRED) {
  const orders = decide({ prs: [pr], readyRows: [], required }) as Order[];
  const calls: string[][] = [];
  const { delivered } = performActions(orders, (args: string[]) => { calls.push(args); return ""; }, () => {});
  return { calls, delivered: delivered as Order[] };
}
const noFlip = (pr: Pr, required: string[] | null = REQUIRED) => tick(pr, required).calls;

test("#3448 (1): a convinced draft with a RED stamp and every required check green at its head is marked ready, and no session is woken", () => {
  const { calls, delivered } = tick(draft());
  assert.deepEqual(calls, [["pr", "ready", "7"]], "POSITIVE CONTROL: `gh pr ready` runs, in the existing call shape");
  assert.deepEqual(delivered, [], "and nothing is delivered to any session -- not the author, not product-manager");
});

test("#3448 (1): the same with NO stamp at all is marked ready, as it always was", () => {
  assert.deepEqual(tick(draft({ verifyStamp: undefined })).calls, [["pr", "ready", "7"]]);
});

test("#3448 (1): one field differing from the positive control withholds the flip", () => {
  const redRequired = draft({ statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "FAILURE" }] });
  const running = draft({ statusCheckRollup: [{ name: "gate", status: "IN_PROGRESS", conclusion: null }] });
  // The pull request moved on: its checks are for a head the verdict was not posted at. The rollup is the current head's, so the verdict names an OLDER one.
  const olderHead = draft({ comments: [verdict(OLDER, "reviewer-7", "convinced")] });
  const ownVerdict = draft({ comments: [verdict(HEAD, "a11ign-ai-workers", "convinced")] });
  const notConvinced = draft({ comments: [verdict(HEAD, "reviewer-7", "not convinced")] });
  for (const [why, pr] of Object.entries({ "a required check red": redRequired, "a required check still running": running,
    "the verdict is at an older head": olderHead, "the verdict is the author's own": ownVerdict, "the verdict is not convinced": notConvinced })) {
    assert.deepEqual(tick(pr).calls, [], `${why}: no \`gh pr ready\``);
  }
  // The author's own verdict still wakes product-manager (a human should look), and a running check wakes nobody: the positive control above is what shows these ticks could have flipped.
});

test("#3448 (1): the stamp stays the rule when CI's verdict on the required checks was not READ, or names no check on this head", () => {
  assert.deepEqual(noFlip(draft(), null), [], "required unread (`null`): every check would count, which is the fail-open reading -- the stamp withholds, as #3215 says");
  assert.deepEqual(noFlip(draft(), ["some-other-check"]), [], "a required list that names nothing on the head settles nothing");
  const [order] = tick(draft(), null).delivered;
  assert.equal(order.session, "worker-1", "and the order is the author's, told to run verify");
  assert.match(order.prompt, /WILL NOT mark it ready/);
});

test("#3448: the required list is read when a draft is green or anything is red, and never for a queue of ready pull requests", () => {
  const reads: string[] = [];
  const read = () => { reads.push("branches/main"); return REQUIRED; };
  assert.deepEqual(requiredWhenNeeded([draft()], read), REQUIRED, "a green draft asks");
  assert.deepEqual(requiredWhenNeeded([draft({ isDraft: false, statusCheckRollup: [{ name: "gate", status: "COMPLETED", conclusion: "FAILURE" }] })], read), REQUIRED, "a red check asks, draft or not");
  assert.equal(reads.length, 2, "CONTROL: the two asking cases each paid one read");
  assert.equal(requiredWhenNeeded([draft({ isDraft: false })], read), null, "a green READY pull request asks nothing");
  assert.equal(requiredWhenNeeded([draft({ statusCheckRollup: [{ name: "gate", status: "IN_PROGRESS", conclusion: null }] })], read), null, "a draft still running asks nothing");
  assert.equal(reads.length, 2, "and neither of those paid a read");
});

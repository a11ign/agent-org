// no-token: gh -- the pull requests are in memory; nothing here spawns `gh`
/**
 * a11ign/agent-org#958 (split from a11ign/a11ign#5036, part 4): A DRAFT PULL REQUEST REFUSED AT ITS CURRENT HEAD WAKES ITS HOLDER, AS AN UNDRAFTED ONE DOES.
 *
 * `reviewBlocked` read `mergeCandidates`, which drops every draft at the source, so a draft that a reviewer refused at its head was in no order at all:
 * control#53 sat refused for 45 minutes while the same cause fired for undrafted pull requests in the same window. The row's population change adds ONE
 * kind of draft -- refused at the head it has -- and keeps every other exclusion: red, held, conflicting, AWAITING_REVIEW and an older-head refusal.
 *
 * THE POPULATION IS CHECKED, NOT ASSUMED: each "no order" sits beside the same draft refused at its head, which is ordered, so an empty answer is
 * never the answer of a gate that sends nothing. The orders are the real ones: `reviewBlocked` reads the pull requests and the result goes through
 * `reviewBlockedOrders`, the entry `decide` calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewBlocked } from "./work-gate/causes/pr-reviews.ts";
import { reviewBlockedOrders } from "./work-gate/pr-orders/red-only-by-superseded-run.ts";

const GREEN = [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-10T16:00:00Z" }];
const RED = [{ name: "gate", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-10T16:00:00Z" }];
const OLD = "0ld0ld0ld0ld0ld0ld0ld0ld0ld0ld0ld0ld0ld0";
const HEAD = "4ead4ead4ead4ead4ead4ead4ead4ead4ead4ead";

type Pr = Record<string, unknown>;

/** A green, unheld DRAFT. `refusedAt: null` is the same draft with no refusal -- the positive control; `session` labels it to an owner. */
const draft = (number: number, { refusedAt = HEAD, session = null, over = {} }: { refusedAt?: string | null; session?: string | null; over?: Pr } = {}): Pr => ({
  number, headRefOid: HEAD, isDraft: true, statusCheckRollup: GREEN, updatedAt: "2026-10-10T16:59:00Z", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  headRefName: `agent/some-slug-${number}`, comments: [], closingIssuesReferences: [], author: { login: "worker-1" },
  reviewDecision: refusedAt === null ? "REVIEW_REQUIRED" : "CHANGES_REQUESTED",
  labels: session === null ? [] : [{ name: `session:${session}` }],
  reviews: refusedAt === null ? [] : [{ state: "CHANGES_REQUESTED", commit: { oid: refusedAt }, submittedAt: "2026-10-10T15:00:00Z" }],
  ...over,
});

/** The orders the gate would send for these pull requests, through the two readers `tick` calls for this cause. */
const blockedOrders = (prs: Pr[]) => reviewBlockedOrders(reviewBlocked(prs, null));

test("a draft refused at its current head produces one order, to its labelled holder", () => {
  const orders = blockedOrders([draft(8001, { session: "worker-8001" })]);
  assert.deepEqual(orders.map((o) => [o.session, o.cause, o.causeKey]),
    [["worker-8001", "pr-review-blocked", "worker-8001/pr-review-blocked/pr-8001/REFUSED"]],
    "directly to the session on its label, as an undrafted refusal is");
  assert.match(orders[0].prompt, /The refusal was posted AT the current head `4ead4ead`: it is live and the rework is yours\./);
});

test("positive control: the same draft with no refusal produces no order", () => {
  assert.deepEqual(reviewBlocked([draft(8002, { refusedAt: null, session: "worker-8002" })], null), []);
  assert.deepEqual(blockedOrders([draft(8002, { refusedAt: null, session: "worker-8002" })]), []);
});

test("an unlabelled refused draft goes to the manager's set order, as an unlabelled undrafted one does", () => {
  const orders = blockedOrders([draft(8003)]);
  assert.deepEqual(orders.map((o) => [o.session, o.causeKey]), [["product-manager", "product-manager/pr-review-blocked/8003:REFUSED"]]);
});

test("every other exclusion holds: a red, held, conflicting or older-head refused draft is not ordered, beside a refused draft that is", () => {
  const live = blockedOrders([draft(8004, { session: "worker-8004" })]);
  assert.equal(live.length, 1, "the control: a refused draft at its head is ordered");
  const excluded = [
    draft(8005, { session: "worker-8005", over: { statusCheckRollup: RED } }),
    draft(8006, { session: "worker-8006", over: { labels: [{ name: "session:worker-8006" }, { name: "hold:ceo" }] } }),
    draft(8007, { session: "worker-8007", over: { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" } }),
    draft(8008, { session: "worker-8008", refusedAt: OLD }),
  ];
  for (const pr of excluded) assert.deepEqual(blockedOrders([pr]), [], `#${pr.number} is outside this cause`);
});

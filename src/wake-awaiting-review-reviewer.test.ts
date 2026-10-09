// no-token: gh -- pure: the gate's PR orders over in-memory pull requests, and `deliver` against a recording herdr; nothing reaches `gh`, `git` or herdr
/**
 * a11ign#3592: AN `AWAITING_REVIEW` PULL REQUEST STARTS ITS REVIEWER, AND NO ORDER GOES TO ONE BUSY SEAT FOR IT.
 *
 * THE DEFECT (retro 2026-10-05): `reviewBlocked` reported every green, unheld pull request GitHub was holding for a review, so each one earned
 * a `pr-review-blocked` order to `product-manager` in the SAME TICK that `draftOrder` (#2176) had already ordered, and `wake.ts` had started,
 * `reviewer-<n>` for it. MEASURED 2026-10-05 by re-running the row's journal grep over its own window (2026-10-04T00:22Z to 2026-10-05T00:22Z):
 * 67 `DEFERRED product-manager/pr-review-blocked/` lines (the row quoted 54), of which 4 name a `REFUSED` arm and 63 do not. agent-org#188 is the pair
 * on one tick: `WOKE reviewer-agent-org-188 <- .../draft-awaiting-verdict/... (STARTED gpt-5.6-luna/medium)` and, the same second, `DEFERRED
 * product-manager/pr-review-blocked/agent-org#188:AWAITING_REVIEW`.
 *
 * THE POPULATION IS DERIVED, NOT NAMED: the cross product of the facts that vary (draft or ready; the primary or a keyed repository) is
 * filtered by `reviewStateOf` itself, so a pull request is in it because the gate READS it as `AWAITING_REVIEW`. `population` asserts it holds the
 * draft, the non-draft and the keyed case -- that is where this file's emptiness assertions are controlled -- and the `REFUSED` twin
 * proves the order the arm keeps is still sent, so "no order" is not a gate that sends nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { perPullRequestOrders, reviewBlockedOrders } from "./work-gate/pr-orders.ts";
import { reviewBlocked, reviewStateOf, REVIEW_STATE } from "./work-gate.ts";
import { deliver } from "./wake.ts";
import { startedPanes } from "./packaging/started-pane.ts";

type Order = { session: string, cause: string, causeKey: string };
type Pr = Record<string, unknown>;

const NOW = Date.parse("2026-10-05T00:00:00Z");
const GREEN = [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-04T23:00:00Z" }];
const HEAD = "41d131af00000000";
const KEYS = { primary: {}, "agent-org": { repoKey: "agent-org", repo: "a11ign/agent-org" }, "screenreader-worker": { repoKey: "screenreader-worker", repo: "a11ign/screenreader-worker" } };

const prOf = (number: number, over: Pr = {}): Pr => ({
  number, headRefOid: HEAD, isDraft: false, statusCheckRollup: GREEN, updatedAt: "2026-10-04T23:59:00Z", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  headRefName: `agent/some-slug-${number}`, labels: [], closingIssuesReferences: [], comments: [], reviews: [], author: { login: "worker-1" },
  reviewDecision: "REVIEW_REQUIRED", ...over,
});

/** Every order the gate raises for these pull requests: the per-PR ones, then `pr-review-blocked`, in the order `decide` pushes them. */
function gateOrders(prs: Pr[]): Order[] {
  return [...perPullRequestOrders(prs, null, null, NOW), ...reviewBlockedOrders(reviewBlocked(prs, null))] as Order[];
}

/** The cross product of what varies, kept when the gate's own reader says AWAITING_REVIEW. */
function population(): { name: string, pr: Pr, seat: string }[] {
  const seats = { primary: (n: number) => `reviewer-${n}`, "agent-org": (n: number) => `reviewer-agent-org-${n}`, "screenreader-worker": (n: number) => `reviewer-screenreader-worker-${n}` };
  const out = Object.entries(KEYS).flatMap(([key, keyed], i) => [false, true].map((isDraft) => {
    const number = 100 * (i + 1) + (isDraft ? 1 : 2);
    return { name: `${key} ${isDraft ? "draft" : "ready"} #${number}`, pr: prOf(number, { ...keyed, isDraft }), seat: seats[key as keyof typeof seats](number) };
  }));
  return out.filter(({ pr }) => reviewStateOf(pr).code === REVIEW_STATE.AWAITING_REVIEW);
}

test("population: the derived set holds the draft, the non-draft and a keyed-repository case -- the control every emptiness below is read against", () => {
  const found = population();
  assert.ok(found.some(({ pr }) => pr.isDraft === true), "a draft");
  assert.ok(found.some(({ pr }) => pr.isDraft === false && pr.repoKey === undefined), "a ready pull request of the primary");
  assert.ok(found.some(({ pr }) => pr.isDraft === false && pr.repoKey === "agent-org"), "a ready pull request of a keyed repository");
  assert.equal(found.length, 6, "every combination reads as AWAITING_REVIEW, so none was dropped by the filter");
});

test("every AWAITING_REVIEW pull request is ordered to its own reviewer and to nobody under `pr-review-blocked`", () => {
  for (const { name, pr, seat } of population()) {
    const orders = gateOrders([pr]);
    assert.deepEqual(orders.filter((o) => o.cause === "draft-awaiting-verdict").map((o) => o.session), [seat], `${name}: one reviewer order, to ${seat}`);
    assert.deepEqual(orders.filter((o) => o.cause === "pr-review-blocked"), [], `${name}: nothing goes to a busy seat for it`);
  }
});

test("the control: a REFUSED pull request still yields the `pr-review-blocked` order, labelled to its owner and unlabelled to product-manager", () => {
  const refused = prOf(7, { reviewDecision: "CHANGES_REQUESTED", labels: [{ name: "session:worker-7" }] });
  const unlabelled = prOf(8, { reviewDecision: "CHANGES_REQUESTED" });
  assert.deepEqual(gateOrders([refused]).filter((o) => o.cause === "pr-review-blocked").map((o) => o.session), ["worker-7"]);
  assert.deepEqual(gateOrders([unlabelled]).filter((o) => o.cause === "pr-review-blocked").map((o) => o.session), ["product-manager"]);
});

test("a mixed tick: the REFUSED one is ordered and the AWAITING_REVIEW ones are not, in one `pr-review-blocked` set", () => {
  const refused = prOf(9, { reviewDecision: "CHANGES_REQUESTED" });
  const blocked = gateOrders([refused, ...population().map(({ pr }) => pr)]).filter((o) => o.cause === "pr-review-blocked");
  assert.deepEqual(blocked.map((o) => o.causeKey), ["product-manager/pr-review-blocked/9:REFUSED"]);
});

test("#2416 is untouched: an awaiting-evidence pull request starts no reviewer and earns no pr-review-blocked order", () => {
  const waiting = prOf(11, { labels: [{ name: "awaiting-evidence" }] });
  assert.deepEqual(gateOrders([waiting]).map((o) => o.cause), []);
});

const agents = (spec: Record<string, string>) => Object.entries(spec).map(([label, status]) => ({ label, status }));
const checkout = { git: (_c: string, a: string[]) => (a.join(" ").includes("rev-parse") ? `${"d".repeat(40)}\n` : ""), link: () => null, exists: () => true, root: "/reviews-root", repoRoot: "/primary" };

test("the start is a reviewer start: delivered at load 98 on 16 cores (#3560's pause gates a NEW ENGINEER only) while the seat the old order went to is busy", () => {
  const [{ pr, seat }] = population().filter(({ pr }) => pr.isDraft === false && pr.repoKey === undefined);
  const orders = gateOrders([pr]);
  const pane = startedPanes();
  const calls: string[] = [];
  const run = (args: string[]) => {
    calls.push(args.join(" "));
    const answered = pane(args);
    if (answered !== null) return answered;
    return args.includes("workspace") && args.includes("create")
      ? JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } }) : "{}";
  };
  const got = deliver(orders as never, agents({ "product-manager": "working" }), [], { run, checkout, hostLoad: () => ({ load: 98, cores: 16 }) } as never);
  assert.deepEqual(got.refused, []);
  assert.equal(got.sent.length, 1);
  assert.match(got.sent[0], new RegExp(`^${seat} <- ${seat}/draft-awaiting-verdict/pr-${pr.number}/`));
  assert.equal(calls.filter((c) => c.includes("agent start")).length, 1, "one process, started for the reviewer");
});

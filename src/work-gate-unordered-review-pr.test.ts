// no-token: gh -- pure: `perPullRequestOrders` and `decide` over in-memory pull requests; nothing reaches `gh`, `git` or herdr
/**
 * #4002: A PULL REQUEST GITHUB HOLDS FOR REVIEW THAT THE GATE RAISED NO ORDER FOR IS TOLD TO NOBODY NO LONGER -- an order after `CHECKLESS_QUIET_MINUTES`.
 *
 * THE DEFECT, a11ign#3997, 2026-10-07: opened READY, armed, `REVIEW_REQUIRED`, 0 reviews; its `ci` runs ended `failure` with NO `gate` job, so
 * `required = ["gate"]` blocked on nothing, `checksSettledGreen([])` is `null` and the head read as `"running"` for 67 minutes with no reviewer.
 *
 * THE CONTROLS ARE THE ROW'S: (1) is the chairman's fixture, the non-empty case (2)'s emptiness is read against, and (2) differs from it in ONE
 * fact (`gate` absent). Every pull request in (3) differs from (2) in ONE fact too, and the test asserts (2) still yields its order beside them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { perPullRequestOrders, reviewBlockedOrders, CHECKLESS_QUIET_MINUTES } from "./work-gate/pr-orders.mjs";
import { decide, reviewBlocked } from "./work-gate.mjs";

type Order = { session: string, fallback?: string, fallbackPrompt?: string, cause: string, causeKey: string, discriminator: string, prompt: string };
type Pr = Record<string, unknown>;

const NOW = Date.parse("2026-10-07T16:00:00Z");
const MINUTE = 60_000;
const quietFor = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString();
const SETTLED = (name: string) => ({ name, status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-07T14:00:00Z", completedAt: "2026-10-07T14:05:00Z" });
/** #3997's rollup: the jobs `ci` runs, every one success, and `gate` nowhere. */
const WITHOUT_GATE = ["lint", "typecheck", "test", "deliberateRefusals"].map(SETTLED);
const WITH_GATE = [...WITHOUT_GATE, SETTLED("gate")];
const REQUIRED = ["gate"];
const HEAD = "ab698778cafe0000";

const prOf = (over: Pr = {}): Pr => ({
  number: 3997, headRefOid: HEAD, isDraft: false, statusCheckRollup: WITHOUT_GATE, updatedAt: quietFor(CHECKLESS_QUIET_MINUTES), mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED", headRefName: "agent/some-slug-3993", labels: [{ name: "session:worker-3993" }], closingIssuesReferences: [], comments: [], reviews: [],
  author: { login: "a11ign-ai-workers" }, reviewDecision: "REVIEW_REQUIRED", ...over,
});
const ordersOf = (pr: Pr, nowMs = NOW): Order[] => perPullRequestOrders([pr], REQUIRED, null, nowMs) as Order[];
const unordered = (pr: Pr, nowMs = NOW): Order[] => ordersOf(pr, nowMs).filter((o) => o.causeKey.includes("/unordered/"));

test("(1) the chairman's fixture: ready, REVIEW_REQUIRED, green, `gate` PRESENT -> `reviewer-<n>/draft-awaiting-verdict` on the first tick, and nothing else", () => {
  const orders = ordersOf(prOf({ statusCheckRollup: WITH_GATE, updatedAt: quietFor(1) }));
  assert.deepEqual(orders.map((o) => [o.session, o.cause]), [["reviewer-3997", "draft-awaiting-verdict"]]);
  assert.deepEqual(unordered(prOf({ statusCheckRollup: WITH_GATE })), [], "a pull request that WAS ordered is never also 'unordered', however quiet");
});

test("(2) #3997's shape: `gate` ABSENT from a settled rollup -> no reviewer order, and the `unordered` order at 30 quiet minutes and not one millisecond before", () => {
  const orders = ordersOf(prOf());
  assert.equal(orders.some((o) => o.cause === "draft-awaiting-verdict"), false, "a head whose required check has yet to appear is not asked");
  const [order, ...rest] = unordered(prOf());
  assert.ok(order, "the incident's shape must yield an order -- or every control below is vacuous");
  assert.equal(rest.length, 0);
  assert.equal(order.session, "worker-3993");
  assert.equal(order.cause, "pr-checks-failing");
  assert.equal(order.causeKey, "worker-3993/pr-checks-failing/pr-3997/unordered/ab698778");
  assert.equal(order.discriminator, "unordered-ab698778");

  const justBefore = NOW - 1; // the pull request went quiet exactly 30 minutes before NOW, so one millisecond earlier it has been quiet 30 minutes less 1ms
  assert.deepEqual(unordered(prOf(), justBefore), [], "29:59.999 is not old enough");
  assert.equal(unordered(prOf(), NOW).length, 1, "30:00.000 is");
  assert.deepEqual(unordered(prOf({ updatedAt: quietFor(5) })), [], "a recently touched pull request is not asked");
});

test("(2b) the order names the reading it could and could not make, and the remedy", () => {
  const [order] = unordered(prOf());
  assert.match(order.prompt, /#3997 at `ab698778` is held by GitHub for review/);
  assert.match(order.prompt, /required check\(s\) `gate` are ABSENT from its rollup, which carries 4 other check\(s\)/);
  assert.match(order.prompt, /gh pr close 3997 && gh pr reopen 3997/);
});

test("(2c) an unread required list: a settled-green rollup is offered to its reviewer, so the unordered order does not fire (the list is not read for this alone)", () => {
  const orders = perPullRequestOrders([prOf()], null, null, NOW) as Order[];
  assert.deepEqual(orders.map((o) => o.cause), ["draft-awaiting-verdict"]);
});

test("(2d) every required check present in a rollup that still raised no order says so, rather than naming a check that is not missing", () => {
  const running = prOf({ statusCheckRollup: [...WITHOUT_GATE, { ...SETTLED("gate"), status: "IN_PROGRESS", conclusion: "", startedAt: quietFor(CHECKLESS_QUIET_MINUTES), completedAt: "" }],
    updatedAt: quietFor(CHECKLESS_QUIET_MINUTES + 5) });
  assert.match(unordered(running)[0].prompt, /Every required check IS in the rollup/);
});

test("(2e) a check STARTED inside the window keeps the pull request quiet-not: a re-run from the Actions page moves no `updatedAt`", () => {
  const rerun = prOf({ updatedAt: quietFor(120), statusCheckRollup: [...WITHOUT_GATE, { ...SETTLED("gate"), status: "IN_PROGRESS", conclusion: "", startedAt: quietFor(2), completedAt: "" }] });
  assert.deepEqual(unordered(rerun), []);
  assert.equal(unordered(prOf({ updatedAt: quietFor(120) })).length, 1, "the same pull request with nothing started recently IS asked");
});

test("(3) controls: an awaiting-evidence, a conflicting, a held and a draft pull request raise none -- each is (2) with ONE fact changed", () => {
  assert.equal(unordered(prOf()).length, 1, "the positive control, beside which every emptiness is read");
  const awaiting = prOf({ labels: [{ name: "session:worker-3993" }, { name: "awaiting-evidence" }], awaitingSince: quietFor(5) });
  assert.deepEqual(unordered(awaiting), [], "awaiting-evidence");
  assert.deepEqual(unordered(prOf({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })), [], "conflicting");
  assert.deepEqual(unordered(prOf({ labels: [{ name: "session:worker-3993" }, { name: "hold:ceo" }] })), [], "held");
  assert.deepEqual(unordered(prOf({ isDraft: true })), [], "draft");
});

test("(3b) controls: a decision that is not REVIEW_REQUIRED, or was never read, is not this order's", () => {
  assert.deepEqual(unordered(prOf({ reviewDecision: "APPROVED" })), [], "approved");
  assert.deepEqual(unordered(prOf({ reviewDecision: null })), [], "no decision required");
  const unread = prOf(); delete unread.reviewDecision;
  assert.deepEqual(unordered(unread), [], "unreadable is not a statement about the pull request");
  assert.deepEqual(unordered(prOf({ updatedAt: "not a date" })), [], "an unreadable age is never an accusation");
  assert.deepEqual(unordered(prOf({ updatedAt: undefined })), []);
});

test("(3c) the REFUSED twin still raises `pr-review-blocked`, through `decide`, and is never 'unordered'", () => {
  const refused = prOf({ statusCheckRollup: WITH_GATE, reviewDecision: "CHANGES_REQUESTED" });
  const decided = decide({ prs: [refused], readyRows: [], required: REQUIRED, nowMs: NOW }) as Order[];
  assert.deepEqual(decided.filter((o) => o.cause === "pr-review-blocked").map((o) => o.session), ["worker-3993"]);
  assert.equal(decided.some((o) => o.causeKey.includes("/unordered/")), false);
  assert.deepEqual(reviewBlockedOrders(reviewBlocked([refused], REQUIRED)).map((o) => o.cause), ["pr-review-blocked"]);
});

test("(4) `decide` carries it: the gate itself emits the order, at its own clock", () => {
  const decided = decide({ prs: [prOf()], readyRows: [], required: REQUIRED, nowMs: NOW }) as Order[];
  assert.equal(decided.filter((o) => o.causeKey.includes("/unordered/")).length, 1);
  const early = decide({ prs: [prOf({ updatedAt: quietFor(5) })], readyRows: [], required: REQUIRED, nowMs: NOW }) as Order[];
  assert.equal(early.filter((o) => o.causeKey.includes("/unordered/")).length, 0);
});

test("(5) routing: a keyed repository's remedy aims at it, a gone owner falls back to product-manager, and nobody-named is product-manager, not ceo", () => {
  const [keyed] = unordered(prOf({ number: 7, repoKey: "agent-org", repo: "a11ign/agent-org" }));
  assert.equal(keyed.causeKey, "worker-3993/pr-checks-failing/pr-agent-org#7/unordered/ab698778");
  assert.match(keyed.prompt, /gh pr close 7 --repo a11ign\/agent-org && gh pr reopen 7 --repo a11ign\/agent-org/);
  const [owned] = unordered(prOf());
  assert.equal(owned.fallback, "product-manager");
  assert.match(String(owned.fallbackPrompt), /NO LONGER EXISTS/);
  const [nobody, ...rest] = unordered(prOf({ labels: [], headRefName: "feature/x" }));
  assert.equal(nobody.session, "product-manager");
  assert.equal(nobody.fallback, undefined, "product-manager has no further fallback");
  assert.equal(nobody.causeKey, "product-manager/pr-checks-failing/pr-3997/unordered/ab698778");
  assert.equal(rest.length, 0);
  assert.match(nobody.prompt, /NOBODY COULD BE NAMED/);
});

test("(6) one per head: a new head is a new key, the same head the same key; ascending by number", () => {
  const key = (head: string) => unordered(prOf({ headRefOid: head }))[0].causeKey;
  assert.equal(key("ab698778cafe0000"), key("ab698778deadbeef"));
  assert.notEqual(key("ab698778cafe0000"), key("fedc4321cafe0000"));
  const two = perPullRequestOrders([prOf({ number: 9 }), prOf({ number: 3 })], REQUIRED, null, NOW) as Order[];
  assert.deepEqual(two.filter((o) => o.causeKey.includes("/unordered/")).map((o) => o.causeKey.split("/")[2]), ["pr-3", "pr-9"]);
});

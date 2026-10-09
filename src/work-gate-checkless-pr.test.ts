// no-token: gh -- pure: `perPullRequestOrders` and `decide` over in-memory pull requests; nothing reaches `gh`, `git` or herdr
/**
 * #3092: A PULL REQUEST WITH NO CHECKS AT ALL IS TOLD SO, within a bounded time, instead of waiting for a reviewer the gate never asks.
 *
 * THE DEFECT, a11ign/agent-org#58, 2026-10-02/03: opened on #56's branch, so `ci.yml` (`pull_request` on `branches: [main]`) never ran;
 * #56 merged and GitHub retargeted it to `main` -- an `edited` event, not a default trigger -- so no run followed. `reviewableHead`
 * reads an empty rollup as `null` ("not knowable yet"), so `draftOrder` said nothing, and it sat REVIEW_REQUIRED with 0 checks.
 *
 * THE CONTROLS ARE THE ROW'S THREE: inside the threshold, one RUNNING check ("not knowable yet", unchanged), and a settled-green
 * check (offered to its reviewer exactly as before). Each also asserts the order the checkless one must NOT be, so none can pass vacuously.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { perPullRequestOrders, checklessPrOrders, CHECKLESS_QUIET_MINUTES } from "./work-gate/pr-orders.mjs";
import { decide } from "./work-gate.ts";

type Order = { session: string, fallback?: string, fallbackPrompt?: string, cause: string, causeKey: string, prompt: string };

const NOW = Date.parse("2026-10-03T12:00:00Z");
const MINUTE = 60_000;
const quietFor = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString();
const GREEN = [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-03T11:00:00Z" }];
const RUNNING = [{ name: "gate", status: "IN_PROGRESS", conclusion: "", startedAt: "2026-10-03T11:59:00Z" }];

const prOf = (over: Record<string, unknown> = {}) => ({
  number: 58, headRefOid: "0123abcd00000000", isDraft: true, statusCheckRollup: [], updatedAt: quietFor(CHECKLESS_QUIET_MINUTES + 1),
  headRefName: "agent/some-slug-3076", labels: [{ name: "session:worker-3076" }], closingIssuesReferences: [], comments: [], reviews: [], ...over,
});
const ordersOf = (pr: unknown): Order[] => perPullRequestOrders([pr as object], null, null, NOW) as Order[];
const checkless = (pr: unknown): Order[] => ordersOf(pr).filter((o) => o.causeKey.includes("/checkless/"));

test("an open PR with an EMPTY rollup, quiet past the threshold, yields an order naming it, its head and its remedy", () => {
  const [order, ...rest] = ordersOf(prOf());
  assert.ok(order, "the PR in the incident's shape must yield an order -- or every control below is vacuous");
  assert.equal(rest.length, 0);
  assert.equal(order.session, "worker-3076");
  assert.equal(order.cause, "pr-checks-failing");
  assert.equal(order.causeKey, "worker-3076/pr-checks-failing/pr-58/checkless/0123abcd");
  assert.match(order.prompt, /#58 at `0123abcd` has NO CHECKS AT ALL/);
  assert.match(order.prompt, /gh pr close 58 && gh pr reopen 58/, "the remedy is named, as a command");
  assert.match(order.prompt, /retarget/i);
  assert.match(order.prompt, /never offer it to a reviewer/i);
});

test("control: the SAME PR inside the threshold yields none -- CI may simply not have started", () => {
  assert.deepEqual(ordersOf(prOf({ updatedAt: quietFor(CHECKLESS_QUIET_MINUTES - 1) })), []);
  assert.equal(checkless(prOf({ updatedAt: quietFor(CHECKLESS_QUIET_MINUTES) })).length, 1, "the boundary itself is old enough");
});

test("control: a PR with ONE RUNNING check yields none -- 'not knowable yet' is unchanged", () => {
  assert.deepEqual(ordersOf(prOf({ statusCheckRollup: RUNNING })), []);
});

test("control: a PR with a settled-GREEN check is offered to its reviewer exactly as today, and gets no checkless order", () => {
  const orders = ordersOf(prOf({ statusCheckRollup: GREEN }));
  assert.deepEqual(orders.map((o) => [o.session, o.cause]), [["reviewer-58", "draft-awaiting-verdict"]]);
});

test("ABSENT IS NOT EMPTY: an unread rollup, no head, or an unreadable updatedAt is never an accusation", () => {
  assert.deepEqual(ordersOf(prOf({ statusCheckRollup: undefined })), []);
  assert.deepEqual(ordersOf(prOf({ statusCheckRollup: null })), []);
  assert.deepEqual(ordersOf(prOf({ headRefOid: "" })), []);
  assert.deepEqual(ordersOf(prOf({ updatedAt: undefined })), []);
  assert.deepEqual(ordersOf(prOf({ updatedAt: "not a date" })), []);
});

test("a CONFLICTING PR is left to `pr-merge-conflict`, whose rebase is also what starts CI", () => {
  assert.deepEqual(checkless(prOf({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })), []);
  assert.equal(checkless(prOf({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" })).length, 1, "the control: clean is not skipped");
});

test("done-when 2: a PR in a KEYED repository is ordered, keyed by its repository, and the remedy aims at it", () => {
  const [order] = checkless(prOf({ number: 7, repoKey: "agent-org", repo: "a11ign/agent-org" }));
  assert.ok(order, "a keyed PR must yield an order");
  assert.equal(order.causeKey, "worker-3076/pr-checks-failing/pr-agent-org#7/checkless/0123abcd");
  assert.match(order.prompt, /agent-org#7 at/);
  assert.match(order.prompt, /gh pr close 7 --repo a11ign\/agent-org && gh pr reopen 7 --repo a11ign\/agent-org/);
  assert.doesNotMatch(checkless(prOf())[0].prompt, /--repo/, "the home repository's remedy names no repo, as before");
});

test("an owner whose session is gone falls back to product-manager, with words that say the remedy is its own to apply", () => {
  const [order] = checkless(prOf());
  assert.equal(order.fallback, "product-manager");
  assert.match(String(order.fallbackPrompt), /NO LONGER EXISTS/);
  assert.match(String(order.fallbackPrompt), /gh pr close 58 && gh pr reopen 58/);
});

test("an unlabelled PR is ordered to `ceo`, the last rung, and says nobody could be named", () => {
  const [order] = checkless(prOf({ labels: [], headRefName: "feature/x" }));
  assert.equal(order.session, "ceo");
  assert.match(order.prompt, /NOBODY COULD BE NAMED/);
});

test("the order is ONE PER HEAD: a new head is a new key, the same head the same key", () => {
  const key = (head: string) => checkless(prOf({ headRefOid: head }))[0].causeKey;
  assert.equal(key("0123abcd00000000"), key("0123abcd99999999"));
  assert.notEqual(key("0123abcd00000000"), key("fedc4321"));
});

test("`decide` carries it: the gate itself emits the order, at its own clock", () => {
  const decided = decide({ prs: [prOf()], readyRows: [], nowMs: NOW }) as Order[];
  assert.equal(decided.filter((o) => o.causeKey.includes("/checkless/")).length, 1);
  const early = decide({ prs: [prOf({ updatedAt: quietFor(5) })], readyRows: [], nowMs: NOW }) as Order[];
  assert.equal(early.filter((o) => o.causeKey.includes("/checkless/")).length, 0);
});

test("checklessPrOrders is ascending by number and tolerates a null list", () => {
  assert.deepEqual(checklessPrOrders([prOf({ number: 9 }), prOf({ number: 3 })], NOW).map((o) => o.subject), ["pr-3", "pr-9"]);
  assert.deepEqual(checklessPrOrders(null as unknown as any[], NOW), []);
});

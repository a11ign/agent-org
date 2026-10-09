// no-token: gh -- pure: `perPullRequestOrders` over in-memory pull requests and `routeWithFallback` over an in-memory agent list; nothing reaches `gh`, `git` or herdr
/**
 * #3078: A `pr-checks-failing` ORDER WHOSE SESSION NO LONGER EXISTS HAS A WAY OUT.
 *
 * THE DEFECT, 2026-10-02: three red pull requests carried `session:worker-N` labels for sessions the gate had released, so `route`
 * refused each order with `no workspace labelled "worker-N"` on every tick for as long as the PR stayed red (30 ticks, about 63
 * minutes), and the org waited on PRs whose owner it had already let go. `trunk-red` carries a `fallback` (#2356); this order did not.
 *
 * THE FALLBACK IS FOR A SESSION THAT IS ABSENT, NOT ONE THAT IS BUSY. The positive controls say so in both directions: an owner that is
 * alive (idle OR working) is never bypassed, and an owner that is gone reaches `product-manager`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { perPullRequestOrders, DEAD_OWNER_FALLBACK } from "./work-gate/pr-orders.mjs";
import { routeWithFallback, deliver } from "./wake.ts";

type Agent = { label: string, status: string };
type Order = { session: string, fallback?: string, fallbackOnlyIfAbsent?: boolean, fallbackPrompt?: string, causeKey: string, prompt: string, cause: string };

const RED = [{ name: "gate", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-02T20:00:00Z" }];
const OWNER = "worker-3057";

const prOf = (over: Record<string, unknown> = {}) => ({
  number: 54, repoKey: "a11ign/agent-org", headRefOid: "24b0e94f00000000", isDraft: false, statusCheckRollup: RED,
  headRefName: "agent/some-slug-3057", labels: [{ name: `session:${OWNER}` }], closingIssuesReferences: [], ...over,
});
const redOrder = (over: Record<string, unknown> = {}): Order => {
  const [order] = perPullRequestOrders([prOf(over)], null, null) as Order[];
  assert.ok(order, "a red pull request must yield an order -- or every control below is vacuous");
  return order;
};
const POOL: Agent[] = [{ label: "product-manager", status: "idle" }, { label: "worker-3047", status: "working" }];
const route = (order: Order, agents: Agent[]) => routeWithFallback(order, agents, ["worker-3047"]);

test("positive control: a red PR whose owner session is gone is DELIVERED to product-manager, not refused (#3078)", () => {
  assert.deepEqual(route(redOrder(), POOL), { label: "product-manager" });
});

test("positive control: the same PR with its owner IDLE goes to the owner and never to the fallback", () => {
  assert.deepEqual(route(redOrder(), [...POOL, { label: OWNER, status: "idle" }]), { label: OWNER });
});

test("positive control: the same PR with its owner WORKING is not bypassed either -- the fallback is for an ABSENT session", () => {
  const routed = route(redOrder(), [...POOL, { label: OWNER, status: "working" }]);
  assert.deepEqual(routed, { refusal: `"${OWNER}" is working` });
});

test("with NO session able to take it, the refusal names both the session and the fallback", () => {
  const routed = route(redOrder(), [{ label: DEAD_OWNER_FALLBACK, status: "working" }]) as { refusal: string };
  assert.match(routed.refusal, new RegExp(`no workspace labelled "${OWNER}"`));
  assert.match(routed.refusal, new RegExp(`fallback "${DEAD_OWNER_FALLBACK}"`));
});

test("a PR that already belongs to the fallback is not given a fallback to itself", () => {
  const order = redOrder({ labels: [{ name: `session:${DEAD_OWNER_FALLBACK}` }] });
  assert.equal(order.fallback, undefined);
});

test("causeKey is byte for byte what it was: a live owner's key, and a red AND conflicting one's", () => {
  assert.equal(redOrder().causeKey, `${OWNER}/pr-checks-failing/pr-a11ign/agent-org#54/24b0e94f`);
  assert.equal(redOrder({ mergeable: "CONFLICTING" }).causeKey, `${OWNER}/pr-checks-failing/pr-a11ign/agent-org#54/24b0e94f/conflicting`);
});

/** `deliver`'s `run` seam, recording each `herdr agent prompt <label> <text>` it is asked to send. */
const delivered = (order: Order, agents: Agent[]) => {
  const prompts: { label: string, text: string }[] = [];
  const run = (args: string[]) => { if (args.includes("prompt") && args.at(-1) !== "/clear") prompts.push({ label: args[args.indexOf("prompt") + 1], text: args.at(-1) as string }); return ""; };
  const result = deliver([order], agents, [], { run, sleep: () => {} });
  return { prompts, result };
};

test("the fallback is TYPED words saying the owner is gone and what to do; the owner's own words are unchanged", () => {
  const order = redOrder();
  const sent = delivered(order, POOL);
  assert.deepEqual(sent.result.sent, [`product-manager <- ${order.causeKey}`]);
  assert.equal(sent.prompts.length, 1);
  assert.equal(sent.prompts[0].label, "product-manager");
  assert.match(sent.prompts[0].text, new RegExp(`\`${OWNER}\`, NO LONGER EXISTS`));
  assert.match(sent.prompts[0].text, /The fix is NOT yours/);
  assert.match(sent.prompts[0].text, /session:<name>/);
  assert.ok(!sent.prompts[0].text.includes("yours to fix"), "the owner's sentence must not reach the fallback");
  const owner = delivered(order, [...POOL, { label: OWNER, status: "idle" }]);
  assert.equal(owner.prompts[0].label, OWNER);
  assert.ok(owner.prompts[0].text.includes(order.prompt), "a live owner is typed the order's own prompt");
  assert.ok(!owner.prompts[0].text.includes("NO LONGER EXISTS"));
});

test("a red AND conflicting PR's fallback words say so", () => {
  const sent = delivered(redOrder({ mergeable: "CONFLICTING" }), POOL);
  assert.match(sent.prompts[0].text, /also CONFLICTS with `main`/);
});

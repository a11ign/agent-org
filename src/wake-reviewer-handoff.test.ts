// no-token: gh -- every `gh` and `herdr` here is a stub or an injected seam, and `git` is a fake: nothing imported reaches a real one
/**
 * `packages/agent-org/src/wake.ts`, #3031: A HANDOFF TO A LIVE REVIEWER INSTANCE IS DELIVERED, NOT REFUSED AS "ABOUT NO PULL REQUEST".
 *
 * `reviewerMismatch` read the pull request from the cause key, and a handoff's key (`handoff/<session>/<id>`) names none, so the
 * author's re-prompt (`prompt:session -- reviewer-<n>`), once queued because the seat was mid-turn, was refused on every tick until the
 * instance was torn down. THE CHOICE PINNED HERE: a handoff addressed TO the instance is judged as about the instance's own pull
 * request; a handoff to a different session, and any derived order about a different pull request, are refused exactly as before.
 *
 * No real git, no real pane, per the no-token contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deliver, deliverHandoffs, reviewerMismatch, handoffId } from "./wake.ts";

const agents = (spec: Record<string, string>) => Object.entries(spec).map(([label, status]) => ({ label, status }));

/** A `git` that accepts everything a re-point asks, so only the routing under test can refuse. NOTHING HERE MAY REACH A REAL TREE:
 *  `deliverHandoffs` forwards this seam to `repointedForReviewer`, and without it the delivery would make `/home/agent/reviews/<label>`. */
const fakeCheckout = () => {
  const trees = new Map<string, string>();
  const head = "d".repeat(40);
  const git = (_cmd: string, args: string[]) => {
    const line = args.join(" ");
    if (line.includes(" fetch ")) return "";
    if (line.includes("rev-parse --verify")) return `${head}\n`;
    if (line.includes("worktree add")) { trees.set(args[args.length - 2], args[args.length - 1]); return ""; }
    if (line.includes(" checkout ")) { trees.set(args[1], args[args.length - 1]); return ""; }
    if (line.endsWith("rev-parse HEAD")) return `${trees.get(args[1])}\n`;
    throw new Error(`unexpected git ${line}`);
  };
  return { trees, seams: { git, link: () => null, exists: (path: string) => trees.has(path), root: "/reviews-root", repoRoot: "/primary" } };
};

test("#3031 reviewerMismatch: a handoff addressed to the instance is not 'about no pull request'", () => {
  assert.equal(reviewerMismatch({ causeKey: handoffId("reviewer-3013", "Pushed a fix.") }, "reviewer-3013"), null);
  assert.equal(reviewerMismatch({ causeKey: "handoff/reviewer-3013/batch-of-3" }, "reviewer-3013"), null, "and a batch of them");
  assert.equal(reviewerMismatch({ causeKey: handoffId("reviewer-agent-org-7", "x") }, "reviewer-agent-org-7"), null, "and a keyed instance");
});

test("#3031 reviewerMismatch: POSITIVE CONTROL -- everything else about another pull request, or none, is still refused", () => {
  const refused = (causeKey: string, label: string) => String(reviewerMismatch({ causeKey }, label));
  assert.match(refused("reviewer-3013/draft-awaiting-verdict/pr-3014/abc", "reviewer-3013"), /this order is about PR #3014/);
  assert.match(refused("engineers/ready-row-unclaimed/7", "reviewer-3013"), /about no pull request/);
  assert.match(refused(handoffId("reviewer-3028", "x"), "reviewer-3013"), /about no pull request/, "a handoff to ANOTHER session");
  assert.match(refused("handoff/reviewer-30130/abc", "reviewer-3013"), /about no pull request/, "a prefix of the label is not the label");
  assert.match(refused("handoff/reviewer-other-3013/abc", "reviewer-3013"), /about no pull request/, "nor another repository's instance");
  assert.match(refused("x/handoff/reviewer-3013/abc", "reviewer-3013"), /about no pull request/, "the handoff prefix is anchored");
  assert.equal(reviewerMismatch({ causeKey: "handoff/worker-4/abc" }, "worker-4"), null, "a non-instance is still not judged");
});

test("#3031 deliverHandoffs: a handoff to an IDLE reviewer lands, re-points its tree and is retired", () => {
  const typed: string[] = [];
  const run = (args: string[]) => { typed.push(args[args.length - 1]); return "{}"; };
  const co = fakeCheckout();
  const handoffs = [{ id: handoffId("reviewer-3013", "Pushed a fix."), session: "reviewer-3013", prompt: "Pushed a fix.", queuedAt: Date.now() }];
  const out = deliverHandoffs(handoffs, agents({ "reviewer-3013": "idle" }), [], { run, sleep: () => {}, checkout: co.seams });
  assert.deepEqual(out.refused, [], `delivered: ${JSON.stringify(out)}`);
  assert.deepEqual(out.ids, [handoffs[0].id], "and it is retired from the queue");
  assert.ok(typed.some((t) => t.includes("Pushed a fix.")), "the author's words were typed");
  assert.deepEqual([...co.trees.keys()], ["/reviews-root/reviewer-3013"], "and exactly that instance's tree was made, in the FAKE root");
});

test("#3031 deliverHandoffs: POSITIVE CONTROL -- a handoff whose key is for ANOTHER reviewer is refused and touches no tree", () => {
  const co = fakeCheckout();
  const stray = { id: "h1", session: "reviewer-3013", prompt: "x", queuedAt: Date.now() };
  const out = deliver([{ session: "reviewer-3013", causeKey: handoffId("reviewer-3028", "x"), prompt: stray.prompt }],
    agents({ "reviewer-3013": "idle" }), [], { run: () => "{}", sleep: () => {}, checkout: co.seams });
  assert.match(out.refused.join(), /reviews PR #3013 and nothing else, and this order is about no pull request/);
  assert.deepEqual([...co.trees.keys()], []);
});

test("#3031 deliverHandoffs: a handoff to a reviewer that is MID-TURN still waits (the existing deferral), not refused as no-PR", () => {
  const handoffs = [{ id: handoffId("reviewer-3013", "x"), session: "reviewer-3013", prompt: "x", queuedAt: Date.now() }];
  const out = deliverHandoffs(handoffs, agents({ "reviewer-3013": "working" }), [], { run: () => "{}" });
  assert.deepEqual(out.ids, []);
  assert.doesNotMatch(out.refused.join(), /about no pull request/);
});

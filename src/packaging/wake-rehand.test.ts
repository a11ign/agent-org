// no-token: gh -- drives readLedger/undelivered/deliver with an injected `run`; `gh` is reached only through escalateStuck's default runner, which this file never imports
/**
 * #2280: does a delivery re-hand a session the same subject at the same commit? Its own file, and not a
 * block in `wake.test.ts`, because the acceptance job has no `gh` token and that file spawns `route`, which
 * reaches `gh`. This one drives only `readLedger` -> `undelivered` -> `deliver` through injected seams, so
 * the row's declared Acceptance is a command the job can RUN rather than refuse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { undelivered, readLedger, deliver as settlingDeliver, ledgerLine, WAKE_TTL_MS, JUDGMENT_TTL_MS }
  from "../wake.mjs";
/** #2546: a test that is not ABOUT the clear's five-second settle does not wait it; `wake-clear-settle.test.ts` pins the delay. */
const noSettle = () => {};
const deliver: typeof settlingDeliver = (orders, agents, roster, deps) => settlingDeliver(orders, agents, roster, { ...deps, sleep: noSettle });


const agents = (spec: Record<string, string>) =>
  Object.entries(spec).map(([label, status]) => ({ label, status }));
const ROSTER = ["worker-capture", "worker-judge", "worker-tooling"];

/**
 * #2280: THE COMPOSED PATH, `readLedger` -> `undelivered` -> `deliver`, AS `main` RUNS IT. Every piece has a
 * test above; what a report of "the same subject re-handed to the same session at the same commit" is
 * about is whether the three, wired together, hand a session the same key twice inside its window.
 * Re-measured at head (2026-09-24, see `WAKE_TTL_MS`): they do not. This pins that reading, with the two
 * re-hands the design WANTS as its positive controls -- a re-ask after the window and a NEW commit.
 */
function tickAt(now: number, ledger: string, orders: { session: string; causeKey: string; prompt: string }[]) {
  const prompts: string[] = [];
  const todo = undelivered(orders, readLedger("x", () => ledger, now, new Set(["ready-queue-empty"])));
  deliver(todo, agents({ "worker-capture": "idle", "product-manager": "idle" }), ROSTER,
    { run: (args: string[]) => { if (!args.includes("/clear") && args[3] === "prompt") prompts.push(args[4]); return ""; },
      record: () => {} });
  return prompts;
}
const FIRST = 1_000_000_000_000;
const verdict = (sha: string) => ({ session: "worker-capture", prompt: "pr 2253 was not convinced",
  causeKey: `worker-capture/verdict-not-convinced/pr-2253/${sha}` });

test("#2280: the same subject at the same commit is not handed twice inside the window", () => {
  const ledger = ledgerLine(FIRST, verdict("a308b8b6").causeKey);
  assert.deepEqual(tickAt(FIRST + 60_000, ledger, [verdict("a308b8b6")]), [], "one minute later");
  assert.deepEqual(tickAt(FIRST + WAKE_TTL_MS - 1, ledger, [verdict("a308b8b6")]), [], "the last ms of the window");
});

test("#2280 positive control: a re-hand AFTER the window is still delivered -- by design, not a defect", () => {
  const ledger = ledgerLine(FIRST, verdict("a308b8b6").causeKey);
  assert.deepEqual(tickAt(FIRST + WAKE_TTL_MS, ledger, [verdict("a308b8b6")]), ["worker-capture"]);
});

test("#2280 positive control: a NEW commit is a new subject and is delivered inside the window", () => {
  const ledger = ledgerLine(FIRST, verdict("a308b8b6").causeKey);
  assert.deepEqual(tickAt(FIRST + 60_000, ledger, [verdict("c0ffee11")]), ["worker-capture"]);
});

test("#2280: a JUDGMENT cause is held for its own longer window, then re-asked", () => {
  const order = { session: "product-manager", prompt: "the queue is empty", causeKey: "product-manager/ready-queue-empty/1" };
  const ledger = ledgerLine(FIRST, order.causeKey);
  assert.deepEqual(tickAt(FIRST + WAKE_TTL_MS * 3, ledger, [order]), [], "well past the action window");
  assert.deepEqual(tickAt(FIRST + JUDGMENT_TTL_MS - 1, ledger, [order]), []);
  assert.deepEqual(tickAt(FIRST + JUDGMENT_TTL_MS, ledger, [order]), ["product-manager"]);
});

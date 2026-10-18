// no-token: gh -- importing `work-gate.ts` reaches `defaultRun`, and this file never lets it run: `decide` is handed rows and a drift reading, and reads nothing itself.
/**
 * agent-org#1129 (follow-up to #907): THE `unclaimed-blocker-cleared` ORDER CARRIES THE `origin/main` HEAD THE GATE READ, AS A `Head: <sha>` LINE.
 * The class guards `promote` on that line (`HEAD_PATTERN`), and `promotionOrder` stated none, so the class held on every order.
 *
 * THE POSITIVE CONTROL is the same order built with no head available: it carries no `Head:` line (the class then holds, as before), so the line is
 * a reading of the head and not a constant of the prompt. The second half runs `decide`, because the head's source is `primaryDrift.originSha`
 * and the pass-through in `tick.ts` is the line that was missing; a builder test alone would stay green with that line deleted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { unclaimedBlockerClearedOrders } from "../work-gate/causes/rows-blocker-cleared.ts";
import { decide } from "../work-gate/tick/blocker-cleared-reading.ts";

const TODAY = "2026-10-12";
const SHA = "ce80fa55b1c2d3e4f5061728394a5b6c7d8e9f01";
const HEAD_LINE = /^Head: [0-9a-f]{7,40}$/m;

/** An unclaimed backlog row whose one declared blocker is closed. */
const clearedRow = {
  number: 1998, title: "a row whose blocker closed", labels: [{ name: "backlog" }, { name: "lane:any" }],
  blockedBy: { nodes: [{ number: 1993, state: "CLOSED" }] },
};
const promptOf = (orders: { prompt: string }[]) => {
  assert.equal(orders.length, 1, "one unclaimed row whose blockers all closed is one order");
  return orders[0].prompt;
};

test("the promotion order carries a `Head: <sha>` line when the gate read a head", () => {
  const prompt = promptOf(unclaimedBlockerClearedOrders([clearedRow], TODAY, { head: SHA }));
  assert.match(prompt, HEAD_LINE, "a line of its own, which is what the class's line-anchored pattern reads");
  assert.ok(prompt.split("\n").includes(`Head: ${SHA}`), "and it names the head that was read, whole");
});

test("POSITIVE CONTROL: no head available, no `Head:` line -- so the class holds, as today", () => {
  for (const head of [undefined, null, "", "unknown", "origin/main", "ZZZZZZZ", "abc123"] as const) {
    const prompt = promptOf(unclaimedBlockerClearedOrders([clearedRow], TODAY, head === undefined ? {} : { head }));
    assert.doesNotMatch(prompt, /^\s*Head:/im, `head ${JSON.stringify(head)} leaves no line`);
  }
});

test("the head is not in the causeKey: a moving main does not make one clearing a new question", () => {
  const [bare] = unclaimedBlockerClearedOrders([clearedRow], TODAY);
  const [headed] = unclaimedBlockerClearedOrders([clearedRow], TODAY, { head: SHA });
  assert.equal(headed.causeKey, bare.causeKey);
  assert.equal(headed.discriminator, bare.discriminator);
});

test("`decide` hands the order the head it read: `primaryDrift.originSha`, and none when the drift was unreadable", () => {
  const promotion = (primaryDrift: unknown) => decide({ prs: [], readyRows: [], openRows: [clearedRow], primaryDrift } as never)
    .filter((order: { cause: string }) => order.cause === "unclaimed-blocker-cleared");
  const drift = { sha: SHA, originSha: SHA, behind: 0, ahead: 0, dirty: [] };
  assert.match(promptOf(promotion(drift)), HEAD_LINE);
  assert.doesNotMatch(promptOf(promotion(null)), /^\s*Head:/im, "an unreadable drift is silence, never a head");
});

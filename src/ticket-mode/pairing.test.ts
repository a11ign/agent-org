// no-token: gh -- pure: the clock and the random picks are handed in
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPairing } from "./pairing.ts";

/** A pairing on a clock the test moves, whose codes are the alphabet read in order from `start`. */
function pairing(start = 0) {
  let at = 1_000;
  let next = start;
  const p = createPairing(() => at, (n) => next++ % n);
  return { ...p, wait: (ms: number) => { at += ms; } };
}

test("a code reads as two groups of four from letters a person cannot confuse, and works once, however it is typed", () => {
  const p = pairing();
  const code = p.mint();
  assert.equal(code, "2345-6789");
  assert.match(pairing(8).mint(), /^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(p.redeem(" 2345 6789 "), true);
  assert.equal(p.redeem("2345-6789"), false, "a used code is spent");
  const lower = pairing(8);
  assert.equal(lower.redeem(lower.mint().toLowerCase()), true);
});

test("a code is out of date after ten minutes", () => {
  const p = pairing();
  const code = p.mint();
  p.wait(10 * 60_000 + 1);
  assert.equal(p.redeem(code), false);
});

test("five wrong codes burn the live one, so it cannot be guessed", () => {
  const p = pairing();
  const code = p.mint();
  for (let i = 0; i < 4; i++) assert.equal(p.redeem("WRONG-CODE"), false);
  assert.equal(p.redeem(code), true, "four wrong tries leave it live");
  const q = pairing();
  const burned = q.mint();
  for (let i = 0; i < 5; i++) q.redeem("WRONG-CODE");
  assert.equal(q.redeem(burned), false);
});

test("a new code replaces the one before it, and nothing pairs before a code is made", () => {
  const p = pairing();
  assert.equal(p.redeem(""), false);
  assert.equal(p.redeem(undefined), false);
  const old = p.mint();
  const fresh = p.mint();
  assert.notEqual(old, fresh);
  assert.equal(p.redeem(old), false);
  assert.equal(p.redeem(fresh), true);
});

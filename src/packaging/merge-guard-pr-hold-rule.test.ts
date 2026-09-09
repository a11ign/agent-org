/**
 * RULE: IS SOMEBODY ELSE HOLDING THIS PR? -- #266/#258, #455's split into
 * `scripts/merge-guard/pr-hold-rule.mjs`. Reads `session:*` off the PR's own labels -- distinct from
 * `claimed-row-rule.mjs`, which reads the same label shape off a ROW this PR would CLOSE.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { prHoldReasons } from "../../../../scripts/merge-guard/pr-hold-rule.mjs";

const pr = { number: 258 };

test("an UNHELD PR is silent -- the common case must not gain a sentence", () => {
  assert.deepEqual(prHoldReasons(pr, ["ready", "backlog"], "worker-capture"), []);
});

test("THE #258 SHAPE: a PR held by another session is refused, and the holder is NAMED", () => {
  const reasons = prHoldReasons(pr, ["hold:dispatcher"], "worker-capture");
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /IS HELD by dispatcher/,
    "'held' and 'held by X' are different instructions -- one of them tells you who to ask");
  assert.match(reasons[0], /you are worker-capture/,
    "and who it thinks YOU are, or the reader cannot tell a real collision from a mis-set session");
  assert.match(reasons[0], /pr:hold/, "it must name the command that takes the hold, not just refuse");
});

test("a PR held by ME is not a collision -- resuming your own work must not refuse", () => {
  assert.deepEqual(prHoldReasons(pr, ["hold:worker-capture"], "worker-capture"), []);
});

test("with no session given, every holder is somebody else -- the safe default for an anonymous asker", () => {
  const reasons = prHoldReasons(pr, ["hold:dispatcher"], null);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /IS HELD by dispatcher/);
  assert.doesNotMatch(reasons[0], /you are/, "it must not claim an identity the caller never gave");
});

test("EVERY holder is named, not just the first -- two sessions is a collision worth seeing in full", () => {
  const reasons = prHoldReasons(pr, ["hold:dispatcher", "hold:worker-audit"], "worker-capture");
  assert.match(reasons[0], /IS HELD by dispatcher, worker-audit/);
});

/**
 * A SIGN-OFF THAT SAYS "I CHECKED" IS WORTH NOTHING AND MUST BE REFUSED — #356.
 *
 * `ceo`'s ruling, 2026-09-07, after CODEOWNERS was found unusable here and actively dangerous: every
 * session pushes as the same account, so `gh pr review --approve` answers *"Can not approve your own pull
 * request"*, and `main` carried `require_code_owner_reviews: true` with no CODEOWNERS file — armed, and
 * inert only because no path had an owner.
 *
 * **The real argument is not that a review was impossible. It is that a review would have caught none of
 * the failures these paths have actually had.** `browserVersion` memoised on `bootConstant` and stale for
 * five days; `refreshBrowseBuffer` guarded on a flag nothing ever assigned; the census stripped at export
 * so no rule reading it could fire. Each is a correct-looking remedy, correctly commented, at the right
 * call site. A human approval passes all three.
 *
 * So the check asks for FACTS AND THEIR STATES. Naming a fact without a state is the "I checked" the
 * ruling refuses by name, and the test below drives exactly that case — it is the one a parser written in
 * a hurry gets wrong, because a body mentioning every fact id looks complete.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { signoffVerdict, isOwned, loadFacts } from "../../../../scripts/owned-path-signoff.mjs";

const FACTS = {
  owned: ["packages/nvda-worker/", "packages/scorer/models/"],
  facts: [
    { id: "CAPTURE_PROTOCOL_VERSION", states: ["unchanged", "bumped"] },
    { id: "weights", states: ["unchanged", "changeset"] },
  ],
};

const SIGNED = "CAPTURE_PROTOCOL_VERSION: unchanged\nweights: unchanged\n";

test("a change to an owned path WITH a full sign-off is GREEN — the half that gets forgotten", () => {
  // Without this the check is a blanket refusal wearing a predicate's clothes, and the first thing anyone
  // does with a blanket refusal is route around it.
  const v = signoffVerdict({ changed: ["packages/nvda-worker/src/capture-core.mjs"], body: SIGNED, facts: FACTS });
  assert.equal(v.code, 0, `expected SIGNED, got: ${v.reasons.join(" | ")}`);
});

test("a change to an owned path with NO sign-off is refused, and it names each missing fact", () => {
  const v = signoffVerdict({
    changed: ["packages/nvda-worker/src/capture-core.mjs"], body: "Fixes a typo.", facts: FACTS,
  });
  assert.equal(v.code, 1);
  assert.match(v.reasons[0], /CAPTURE_PROTOCOL_VERSION/);
  assert.match(v.reasons[0], /weights/);
  assert.match(v.reasons[0], /say one of: unchanged, bumped/,
    "naming the fact is not enough -- it must say which states satisfy it, or the author cannot comply");
});

test("NAMING A FACT WITHOUT A STATE IS REFUSED — this is the 'I checked' case", () => {
  // The sharpest test here. A body that lists every fact id reads as complete and asserts nothing.
  const v = signoffVerdict({
    changed: ["packages/nvda-worker/src/capture-core.mjs"],
    body: "I checked CAPTURE_PROTOCOL_VERSION and weights.",
    facts: FACTS,
  });
  assert.equal(v.code, 1, "a body naming every fact with no state must not pass");
  assert.match(v.reasons[0], /CAPTURE_PROTOCOL_VERSION/);
});

test("a change touching NO owned path is green without a sign-off", () => {
  const v = signoffVerdict({ changed: ["docs/README.md", "scripts/row-claim.mjs"], body: "", facts: FACTS });
  assert.equal(v.code, 0, "the check must be silent on the ordinary case or it gets routed around");
});

test("a partial sign-off is refused, and names only what is missing", () => {
  const v = signoffVerdict({
    changed: ["packages/scorer/models/screenreader-scorer/weights.safetensors"],
    body: "CAPTURE_PROTOCOL_VERSION: unchanged\n", facts: FACTS,
  });
  assert.equal(v.code, 1);
  assert.match(v.reasons[0], /weights/);
  assert.doesNotMatch(v.reasons[0], /say one of: unchanged, bumped/,
    "a fact that IS stated must not be listed as missing -- a refusal that names satisfied work is noise");
});

test("a failed lookup is CANNOT_ASK, never a pass — `[]` and `null` differ", () => {
  for (const broken of [{ changed: null }, { body: null }, { facts: null }]) {
    const v = signoffVerdict({ changed: [], body: "", facts: FACTS, ...broken });
    assert.equal(v.code, 2, "a check that cannot ask must not report a pass");
    assert.match(v.reasons[0], /CANNOT SAY/);
  }
});

test("owned matching respects directory boundaries", () => {
  assert.equal(isOwned("packages/nvda-worker/src/x.mjs", ["packages/nvda-worker/"]), true);
  assert.equal(isOwned("packages/nvda-worker-notes/x.mjs", ["packages/nvda-worker/"]), false,
    "a prefix match without a boundary would own a directory nobody listed");
  assert.equal(isOwned("packages/lab/src/training/capture-cache.mjs",
    ["packages/lab/src/training/capture-cache.mjs"]), true, "a bare file path matches exactly");
});

test("THE REAL LIST LOADS, and it is the owner's rather than this file's", () => {
  // The mechanism must not carry its own copy: `ceo` ruled the list IS orchestrator's expression of
  // ownership, so a second spelling here would drift from the thing it represents.
  const real = loadFacts();
  assert.ok(real, "docs/owned-path-facts.json must load -- absent or malformed is CANNOT_ASK, not empty");
  assert.ok(real.owned.includes("packages/nvda-worker/"),
    "the capture path is the one these failures happened on and must be owned");
  assert.ok(real.facts.some((f: { id: string }) => f.id === "CAPTURE_PROTOCOL_VERSION"),
    "the cache key that forces a full recapture must be a stated fact");
});

// no-token: gh -- `sweepDecision` is pure. `auto-arm-sweep.mjs`'s `gh` helper is in the import closure because it is
// in the module, and nothing here calls it: no `main()`, no spawn, no `gh` on any path.
//
// #2195, in its OWN file rather than beside the #827 tests in `auto-arm-sweep.test.ts`: that file declares the same
// `no-token: gh` and is refused by the token-less acceptance job anyway ("declares `// no-token:` a function its own
// code DOES call or spawn"), so a row Acceptance naming it executes nothing. This file is the one that can run there.
import { test } from "node:test";
import assert from "node:assert/strict";

import { sweepDecision } from "../auto-arm-sweep.mjs";
import { PARITY, parityOwner } from "../review-attribution.mjs";

const pr = (over: Partial<{ labels: string[]; checkRunCount: number }> = {}) =>
  ({ labels: [], checkRunCount: 9, ...over });

// #2195: an off-parity approval must not queue the PR. #2079 (odd, so `reviewer`'s under the odd/even split) was
// armed on `reviewer-2`'s approval at 08:45:06Z and `reviewer`'s refusal arrived at 08:46:07Z, 61s after the queue
// entry. Since #2401 the owner is `reviewer-<n>`, so the owner is read from `parityOwner` and never typed here.
const PR_2079 = 2079;
const OFF_PARITY = { parity: PARITY.violation, parityOwner: parityOwner(PR_2079), reviewedBy: ["reviewer-2"] };

test("#2195 ACCEPTANCE: a parity VIOLATION is refused, and the reason names the parity owner AND the reviewing session", () => {
  const { arm, reason } = sweepDecision({ ...pr({ checkRunCount: 30 }), ...OFF_PARITY });
  assert.equal(arm, false);
  assert.match(reason, /`reviewer-2`/, "it must say who reviewed");
  assert.ok(reason.includes(`\`${parityOwner(PR_2079)}\``), "and who should have, or the author cannot re-prompt");
});

test("#2195 CONTROL: `correct`, ABSENT and `unobservable` parity all still ARM -- only a violation refuses", () => {
  for (const parity of [PARITY.correct, PARITY.unobservable, undefined]) {
    assert.equal(sweepDecision({ ...pr({ checkRunCount: 30 }), parity }).arm, true, `parity ${parity}`);
  }
  assert.equal(sweepDecision(pr({ checkRunCount: 30 })).arm, true, "no field at all: every existing caller");
});

test("#2195: a violation with no names still refuses, and says what rule was broken", () => {
  const { arm, reason } = sweepDecision({ ...pr(), parity: PARITY.violation });
  assert.equal(arm, false);
  assert.match(reason, /off parity/);
});

test("#2195: a violation does not disturb the refusals it sits beside -- `blocked`, a hold and no check runs keep their own reasons", () => {
  const off = { parity: PARITY.violation };
  assert.match(sweepDecision({ ...pr({ labels: ["blocked"] }), ...off }).reason, /blocked/);
  assert.match(sweepDecision({ ...pr({ labels: ["hold:worker-capture"] }), ...off }).reason, /worker-capture/);
  assert.match(sweepDecision({ ...pr({ checkRunCount: 0 }), parity: PARITY.correct }).reason, /STRANDED/);
});

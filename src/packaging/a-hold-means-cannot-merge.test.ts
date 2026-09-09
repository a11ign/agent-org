/**
 * #645: A HOLD MEANT "CANNOT BE ARMED", AND THE ACTOR TO STOP WAS "MERGING-ONCE-ARMED".
 *
 * On 2026-09-09 a ruling changed an open PR's required shape at 09:05Z; `auto-arm` merged the
 * pre-correction commit at 09:16Z. Nothing was wrong with the PR — green, armed, mutation-checked,
 * correct against the instruction its author held. The remedy proposed was `pr:hold`, on the stated
 * ground that the queue already refuses a held PR.
 *
 * **Demonstrating that rather than citing it is what found the hole**, and there were three:
 *
 *   1. `auto-arm-sweep.mjs` refuses to ARM a held PR — and was the only place that did.
 *   2. `auto-arm.yml`'s per-PR `arm` job gated on `draft == false && base.ref == 'main'` and nothing
 *      else, re-arming a held PR on its own next event.
 *   3. **Nothing disarmed.** `git grep "disable-auto"` over the tree was EMPTY, so an already-armed PR
 *      merged when its checks went green with no label consulted, by GitHub or by us.
 *
 * A hold taken at 09:05 on a PR armed at 09:00 changed a label and nothing else.
 *
 * ## What these tests hold to
 *
 * The three states a hold can be in are DIFFERENT and must not print the same word: **not held**,
 * **held and disarmed**, and **labelled but still armed** — the last being the most dangerous, because
 * it LOOKS held while merging on green.
 *
 * ## ASSERTING ON WIRING IS NOT ASSERTING ON BEHAVIOUR
 *
 * The first version of these tests checked that the workflow CALLS `arm-pr.mjs` and that `arm-pr.mjs`
 * MENTIONS the shared predicate. Both true, both passing, and `npm run mutate` reported
 * `THE GUARD DID NOT BITE` when the hold check inside that script was disabled — **the wiring was intact
 * and the predicate did nothing.**
 *
 * It is the same family as an empty positive control, and as a pin asserting the wrong half: in each,
 * the test observes something ADJACENT to the property and the adjacency holds while the property fails.
 * Found twice in one session in this author's own work — once here, once on #622's boundary pin — which
 * is why it is written down rather than merely fixed.
 *
 * The remedy is the same each time: **drive the decision, do not read the file that contains it.**
 * `armDecision` and `armabilityOf` are exported and called with real shapes below; the two remaining
 * text assertions are about the WORKFLOW, which cannot be imported, and they are deliberately paired
 * with behavioural ones rather than standing alone.
 *
 * And the ordinary case must be untouched. A hold that fires routinely is routed around; this
 * repository's own record of that is `A11Y_SKIP_VERIFY=1` reached for six times in one evening.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { armabilityOf, holdersOf, disarmVerdict } from "../../../../scripts/pr-hold-state.mjs";
import { sweepDecision } from "../../../../scripts/auto-arm-sweep.mjs";
import { armDecision } from "../../../../scripts/arm-pr.mjs";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string) => readFileSync(`${REPO}${path}`, "utf8");

test("THE ORDINARY CASE IS UNTOUCHED -- an unheld PR with check runs still arms, exactly as today. A "
  + "hold that fires routinely is one that gets routed around, which is what `A11Y_SKIP_VERIFY=1` "
  + "reached for six times in one evening already proved here", () => {
  assert.equal(armabilityOf({ labels: ["ready", "backlog"] }).arm, true);
  assert.equal(sweepDecision({ labels: [], checkRunCount: 3 }).arm, true);
  assert.equal(sweepDecision({ labels: ["ready"], checkRunCount: 1 }).arm, true);
});

test("a held PR is refused, and the refusal NAMES THE RULING rather than the state when one was "
  + "recorded -- `held` sends a reader to the label; the ruling sends them to the thing they must do", () => {
  const ruled = armabilityOf({ labels: ["session:ceo"], holdReason: "the guard keys on the field name, not the path" });
  assert.equal(ruled.arm, false);
  assert.match(ruled.reason, /the guard keys on the field name/);

  const bare = armabilityOf({ labels: ["session:ceo"] });
  assert.equal(bare.arm, false);
  assert.match(bare.reason, /no reason was recorded/,
    "a hold with no reason must SAY it has none -- the next person carrying this PR current drops it in "
    + "good faith, and 'held' does not tell them what they are dropping");
});

test("DISARM IS VERIFIED FROM THE STATE, NEVER THE EXIT CODE -- `gh pr merge --disable-auto` returns "
  + "success on a PR that is already merging, having changed nothing. That is a verification sharing a "
  + "failure mode with the action, the shape that made a broken `exec` read as a flaky tool", () => {
  assert.equal(disarmVerdict({ autoMergeRequest: null }).disarmed, true);

  const stillArmed = disarmVerdict({ autoMergeRequest: { enabledAt: "2026-09-09T09:00:00Z" } });
  assert.equal(stillArmed.disarmed, false);
  assert.match(stillArmed.reason, /LOOKS held/,
    "labelled-but-armed is the most dangerous of the three states and the message must say so: it "
    + "merges on green while every reader of the label believes it cannot");
});

test("ONE PREDICATE, TWO CALLERS -- the hole opened because `is this PR held` was written twice and only "
  + "one copy was correct. A second CORRECT copy would be the same shape with a longer fuse", () => {
  // Both readers agree by construction, because there is only one of them.
  assert.equal(sweepDecision({ labels: ["session:x"], checkRunCount: 9 }).arm,
    armabilityOf({ labels: ["session:x"] }).arm);
  assert.match(read("scripts/auto-arm-sweep.mjs"), /from "\.\/pr-hold-state\.mjs"/);
  assert.match(read("scripts/arm-pr.mjs"), /from "\.\/pr-hold-state\.mjs"/);
  assert.equal(/labels\.filter\(\(l\) => l\.startsWith\("session:"\)\)/.test(read("scripts/auto-arm-sweep.mjs")),
    false, "the sweep must not carry its own copy of the predicate any more");
});

test("THE PER-PR ARM PATH GOES THROUGH THE PREDICATE -- it is the path that merged #625, and it ran "
  + "`gh pr merge --auto` from three lines of bash that read nothing", () => {
  const workflow = read(".github/workflows/auto-arm.yml");
  assert.match(workflow, /node scripts\/arm-pr\.mjs/,
    "the `arm` job must call the script that reads the hold");
  assert.equal(/gh pr merge --auto --merge "\$\{\{ github\.event\.pull_request\.number/.test(workflow), false,
    "the unconditional bash arm must be gone, not merely accompanied");
  assert.match(workflow, /uses: actions\/checkout@v4[\s\S]*?arm-pr\.mjs/,
    "a job that runs a repository script needs a checkout -- this one did not have one before");
});

test("THE PER-PR PATH'S OWN DECISION, driven rather than read -- a held PR is refused and an unheld one "
  + "is armed. The first version of this test asserted that the workflow CALLS the script and that the "
  + "script MENTIONS the predicate, and `npm run mutate` reported THE GUARD DID NOT BITE when the check "
  + "was disabled: asserting on wiring is not asserting on behaviour", () => {
  assert.equal(armDecision(["ready"]).arm, true);
  assert.equal(armDecision(["session:ceo"]).arm, false);
  assert.equal(armDecision([]).arm, true, "the ordinary case still arms");
});

test("UNREADABLE IS NOT UNHELD -- arm-pr refuses when it cannot read the labels, because the whole "
  + "failure being fixed is a merge that happened when nothing looked", () => {
  const verdict = armDecision(null);
  assert.equal(verdict.arm, false);
  assert.match(verdict.reason, /Unreadable is not unheld/);
});

test("holdersOf reads the same `session:` field `merge-guard` and `row-claim` do, and no other label is "
  + "a hold -- `blocked` is a separate refusal with its own reason and must not be folded in", () => {
  assert.deepEqual(holdersOf(["session:a", "ready", "session:b", "blocked"]), ["session:a", "session:b"]);
  assert.deepEqual(holdersOf(["blocked", "ready"]), []);
  assert.equal(sweepDecision({ labels: ["blocked"], checkRunCount: 3 }).reason.includes("blocked"), true);
});

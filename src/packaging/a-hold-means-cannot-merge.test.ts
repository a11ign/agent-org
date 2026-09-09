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
// no-token: gh
//
// #827. Every function here is called with FIXTURES and returns a verdict: `armabilityOf`, `holdersOf`,
// `disarmVerdict`, `sweepDecision`, `armDecision`, and `mergeSafetyVerdict`, whose whole design is that
// the facts are looked up by its caller and passed in -- `ciGateFacts` does the `gh` calls, and nothing
// in this file invokes it. The closure walk reaches `gh` through `merge-guard.mjs`'s module graph rather
// than through anything these tests execute.
//
// The declaration is verified against the entry's own code, so if `mergeSafetyVerdict` ever starts doing
// its own lookups this refuses rather than trusting the comment -- which is the point of declaring it
// here rather than leaving the file permanently unrunnable in CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { armabilityOf, holdersOf, disarmVerdict, HOLD_PREFIX } from "../../../../scripts/pr-hold-state.mjs";
import { mergeSafetyVerdict } from "../../../../scripts/merge-guard.mjs";

/** A head sha that matches its branch tip -- the clean #294 case, so these tests isolate the hold. */
const HEAD = "1c81c2076c750203a1b49b152736e1fa57269b68";
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
  const ruled = armabilityOf({ labels: ["hold:ceo"], holdReason: "the guard keys on the field name, not the path" });
  assert.equal(ruled.arm, false);
  assert.match(ruled.reason, /the guard keys on the field name/);

  const bare = armabilityOf({ labels: ["hold:ceo"] });
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
  assert.equal(sweepDecision({ labels: ["hold:x"], checkRunCount: 9 }).arm,
    armabilityOf({ labels: ["hold:x"] }).arm);
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
  assert.equal(armDecision(["hold:ceo"]).arm, false);
  assert.equal(armDecision(["session:ceo"]).arm, true,
    "an OWNERSHIP label is not a hold -- the per-PR path must arm it, or #725 stops the org");
  assert.equal(armDecision([]).arm, true, "the ordinary case still arms");
});

test("UNREADABLE IS NOT UNHELD -- arm-pr refuses when it cannot read the labels, because the whole "
  + "failure being fixed is a merge that happened when nothing looked", () => {
  const verdict = armDecision(null);
  assert.equal(verdict.arm, false);
  assert.match(verdict.reason, /Unreadable is not unheld/);
});

/**
 * THE NAMESPACE SPLIT, 2026-09-09. `session:<name>` meant BOTH "this row/PR is mine" and "this PR is
 * held", and ceo's 12:2xZ ruling put an ownership label on every PR its author opened -- so on 2026-09-09
 * orchestrator hand-labelled twelve of their own PRs and every one of them was, to this predicate, HELD.
 * #725 was about to apply that label to every armed PR in the org. Holds moved to `hold:<name>`; rows
 * keep `session:`, and `row-claim.mjs` is deliberately unchanged.
 */
test("holdersOf reads `hold:` and NOT `session:` -- an ownership label is not a hold, which is the "
  + "collision this namespace exists to end", () => {
  assert.deepEqual(holdersOf(["hold:a", "ready", "hold:b", "blocked"]), ["hold:a", "hold:b"]);
  assert.deepEqual(holdersOf(["blocked", "ready"]), []);
  assert.deepEqual(holdersOf(["session:orchestrator", "ready"]), [],
    "twelve PRs carried exactly this on 2026-09-09 to mark ownership; reading it as a hold is the defect");
  assert.equal(armabilityOf({ labels: ["session:orchestrator"] }).arm, true,
    "and the consequence that matters: an owned PR must still be armable");
  assert.equal(sweepDecision({ labels: ["blocked"], checkRunCount: 3 }).reason.includes("blocked"), true);
});


/**
 * THE READ-BACK MUST SEE ITS OWN WRITE, and until the rename it could not have.
 *
 * `takeHold` wrote `session:${session}` and read the result back through `row-claim`'s
 * `claimStatus(...).sessions`. Both spellings were `session:`, so it worked by coincidence of vocabulary
 * rather than by design -- and the moment the hold moved to `hold:` the write and the read would have
 * been asking about different labels. That failure has a particularly bad shape: `takeHold` would print
 * THE WRITE DID NOT LAND AS INTENDED after a write that landed perfectly, on every hold, and the operator
 * would go looking at GitHub for a problem that was in the reader.
 *
 * So this asserts the round trip as CODE rather than as a claim: the label the writer builds is the label
 * the reader recognises, and the reader returns the session name the writer was given.
 */
test("the label pr-hold WRITES is the label pr-hold READS BACK, and it yields the session name again", () => {
  const written = `${HOLD_PREFIX}worker-capture`;
  assert.deepEqual(holdersOf([written, "ready"]), [written]);
  assert.deepEqual(holdersOf([written]).map((l) => l.slice(HOLD_PREFIX.length)), ["worker-capture"]);
});

test("MUTATION: the row vocabulary and the hold vocabulary do not overlap -- one prefix must not be a "
  + "prefix of the other, or every row claim reads as a hold again", () => {
  assert.ok(!HOLD_PREFIX.startsWith("session:") && !"session:".startsWith(HOLD_PREFIX),
    `HOLD_PREFIX is ${HOLD_PREFIX}; if either prefix contains the other the split is cosmetic`);
});

/**
 * THE SCOPE OF THE HOLD, AND IT MOVED. This test read the opposite until 2026-09-09: it asserted that
 * `mergeSafetyVerdict` -- the only required context on this repository -- consulted no label, and said in
 * its own message that if it ever failed, the heading was the thing to update rather than the assertion
 * to delete. That is what happened.
 *
 * Before: a hold was enforced at ARM time only. `pr-hold` disarmed and `armabilityOf` refused to re-arm,
 * so a hold TAKEN through the tool worked -- and a hold placed on a PR that was already armed stopped
 * nothing, because GitHub's auto-merge consults no label and `gate` read head-vs-tip. Eleven of the
 * twelve PRs one session labelled that day merged, labelled and armed.
 *
 * After: `gate` refuses a `hold:` label outright, so the label stops a merge rather than only stopping an
 * arming -- which is what everybody already believed it did.
 */
test("THE REQUIRED GATE REFUSES A HELD PR, and the refusal names the holder and the way out", () => {
  const v = mergeSafetyVerdict({
    pr: { number: 819, headRefOid: HEAD }, branchTip: HEAD, prLabels: ["hold:ceo", "ready"] });
  assert.equal(v.code, 1, `expected REFUSED, got ${v.code}: ${v.reasons.join(" | ")}`);
  assert.match(v.reasons[0], /IS HELD by ceo/);
  assert.match(v.reasons[0], /pr:release/, "a refusal a reader cannot act on is one they route around");
});

test("CONTROL: an OWNERSHIP label is not a hold, and the normal case is a PR with no label at all -- a "
  + "required job refusing the normal case is how a gate gets bypassed", () => {
  assert.equal(mergeSafetyVerdict({ pr: { number: 1, headRefOid: HEAD }, branchTip: HEAD,
    prLabels: ["session:orchestrator", "ready"] }).code, 0);
  assert.equal(mergeSafetyVerdict({ pr: { number: 1, headRefOid: HEAD }, branchTip: HEAD,
    prLabels: [] }).code, 0);
  assert.equal(mergeSafetyVerdict({ pr: { number: 1, headRefOid: HEAD }, branchTip: HEAD }).code, 0,
    "and an omitted prLabels defaults to unheld, so every existing caller keeps its meaning");
});

test("MUTATION: UNREADABLE LABELS ARE CANNOT_ASK, NOT UNHELD -- and the message must not say `held`, "
  + "because `nobody looked` and `somebody holds it` send a reader to different places", () => {
  const v = mergeSafetyVerdict({
    pr: { number: 819, headRefOid: HEAD }, branchTip: HEAD, prLabels: null });
  assert.equal(v.code, 2, `expected CANNOT_ASK, got ${v.code}`);
  assert.match(v.reasons[0], /labels could not be read/);
  assert.match(v.reasons[0], /INCONCLUSIVE, not unheld/);
  assert.doesNotMatch(v.reasons[0], /IS HELD by/);
});

/**
 * THE HALF THAT MAKES THE OTHER HALF TRUE. A hold is placed by adding a label, which changes no file and
 * moves no commit. Without `labeled`/`unlabeled` in `ci.yml`'s `pull_request` types, a hold placed on a
 * GREEN PR never re-runs the check that would refuse it, and auto-merge takes it -- so the refusal above
 * would protect only PRs that happen to be pushed to afterwards.
 *
 * `edited` is the precedent, one field along: it was added because `acceptance` reads the PR BODY and no
 * default type fires on a body edit, which deadlocked the queue for eight hours.
 */
test("ci.yml re-runs on `labeled` and `unlabeled`, or the gate's hold refusal never fires on a green PR", () => {
  const ci = read(".github/workflows/ci.yml");
  const types = /^\s*types: \[([^\]]*)\]/m.exec(ci)?.[1] ?? "";
  assert.ok(types.length > 0, "the pull_request types list must be findable, or this asserts nothing");
  for (const type of ["labeled", "unlabeled", "edited", "opened", "synchronize", "reopened"]) {
    assert.ok(types.includes(type), `\`${type}\` is missing from ci.yml's pull_request types: ${types}`);
  }
});

/**
 * #690's RULE, ONE FIELD FURTHER. `labeled`/`unlabeled` reach a CLOSED PR exactly as `edited` does, and
 * `gate` is deliberately ungated (`if: always()`), so a merged PR still carrying its `hold:` label would
 * go permanently red on its own head. That red blocks nothing, lands in the report of non-success checks
 * on merged heads, and trains people to skip the section — which is how one real red sat on seven merged
 * PRs for ninety minutes.
 */
test("A CLOSED PR IS NEVER REFUSED FOR A HOLD -- it cannot merge, so the refusal protects nothing and "
  + "the red would be permanent", () => {
  const held = { prLabels: ["hold:ceo"], branchTip: HEAD };
  assert.equal(mergeSafetyVerdict({ ...held, pr: { number: 1, headRefOid: HEAD, state: "open" } }).code, 1);
  assert.equal(mergeSafetyVerdict({ ...held, pr: { number: 1, headRefOid: HEAD, state: "closed" } }).code, 0,
    "a closed PR carrying a stale hold label must not be red for ever");
  assert.equal(mergeSafetyVerdict({ ...held, pr: { number: 1, headRefOid: HEAD } }).code, 1,
    "and an omitted state is treated as open -- the refusing direction, since an unknown state must not "
    + "become a way past the hold");
});

/**
 * TAKING A HOLD MUST NOT SUCCEED SILENTLY OVER SOMEBODY ELSE'S (#266).
 *
 * `gh pr edit --add-label` is idempotent, so taking a PR another session holds succeeds and prints the
 * same nothing as taking a free one. That is this repo's most-recorded shape — an operation whose
 * success says nothing about what it did — so the decision is a pure function with three distinct
 * outcomes, and the two that matter cannot be produced on demand against a live API.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { holdDecision } from "../../../../scripts/pr-hold.mjs";
import { armVerdict, disarmVerdict, REARM_LABEL } from "../../../../scripts/pr-hold-state.mjs";

test("an unheld PR is taken, and says it was unheld", () => {
  const d = holdDecision({ holders: [], session: "worker-capture", steal: false });
  assert.equal(d.act, true);
  assert.equal(d.code, 0);
  assert.match(d.message, /unheld/);
});

test("a PR you already hold is a NO-OP, not a second take", () => {
  // Re-running `pr:hold` on your own PR is what a loop does on every pass. It must be free and silent
  // rather than an error, or the command gets dropped from the loop that most needs it.
  const d = holdDecision({ holders: ["worker-capture"], session: "worker-capture", steal: false });
  assert.equal(d.act, false);
  assert.equal(d.code, 0, "already holding it is success, not refusal");
  assert.match(d.message, /already hold it/);
});

test("a PR somebody else holds is REFUSED, and the holder is named", () => {
  const d = holdDecision({ holders: ["dispatcher"], session: "worker-capture", steal: false });
  assert.equal(d.act, false);
  assert.equal(d.code, 1);
  assert.match(d.message, /dispatcher holds it/,
    "'refused' and 'refused, dispatcher holds it' are different instructions");
  assert.match(d.message, /--steal/, "and it must name the way through, or it reads as a dead end");
});

test("--steal acts, and SAYS WHOSE hold it took — the whole point of not being silent", () => {
  const d = holdDecision({ holders: ["dispatcher"], session: "worker-capture", steal: true });
  assert.equal(d.act, true);
  assert.match(d.message, /STEALING from dispatcher/,
    "a bypass that does not name who it displaced is a bypass nobody can audit");
});

test("a PR held by me AND somebody else is still a collision", () => {
  // The state after a botched hand-over. Reading it as 'I hold it' would be the reassuring answer and
  // the wrong one -- two holders is exactly the condition this row exists to make visible.
  const d = holdDecision({ holders: ["worker-capture", "dispatcher"], session: "worker-capture", steal: false });
  assert.equal(d.act, false);
  assert.equal(d.code, 1);
  assert.match(d.message, /dispatcher/);
});

/**
 * A STEAL THAT DOES NOT DISPLACE IS THE DEFECT THIS COMMAND EXISTS TO PREVENT, ONE LEVEL UP.
 *
 * Found by `dispatcher` running `--steal` against the real PR within a minute of it being pushed:
 *
 *     #268: STEALING from worker-capture — say why to them
 *     #268 is now held by dispatcher.
 *     $ gh pr view 268 --json labels  ->  session:worker-capture, session:dispatcher    BOTH
 *
 * So the thief was simultaneously a holder and REFUSED by `merge-guard`, and the refusal named somebody
 * who no longer thought they held it. `--steal` exists because `--add-label` is idempotent and therefore
 * says nothing about what happened; the fix said nothing about what happened either.
 *
 * The tests above could not have caught it — they exercise the DECISION and the defect was in the WRITE.
 * `displaces` is what makes the write checkable here; the command also reads the labels back afterwards,
 * because two writes can half-succeed and `gh pr edit` exiting 0 means the request was accepted.
 */
test("a steal NAMES who it displaces, so the caller can actually remove them", () => {
  const d = holdDecision({ holders: ["dispatcher"], session: "worker-capture", steal: true });
  assert.equal(d.act, true);
  assert.deepEqual(d.displaces, ["dispatcher"],
    "printing 'STEALING from X' while displacing nobody is how #268 left two holders on one PR");
});

test("a steal from SEVERAL holders displaces all of them", () => {
  const d = holdDecision({ holders: ["dispatcher", "worker-judge"], session: "worker-capture", steal: true });
  assert.deepEqual(d.displaces, ["dispatcher", "worker-judge"]);
});

test("taking an UNHELD PR displaces nobody — no spurious removals", () => {
  assert.deepEqual(holdDecision({ holders: [], session: "worker-capture", steal: false }).displaces, []);
});

test("a REFUSED take displaces nobody, however many hold it", () => {
  // The refusal path must not report work it is about to decline to do.
  const d = holdDecision({ holders: ["dispatcher"], session: "worker-capture", steal: false });
  assert.equal(d.act, false);
  assert.deepEqual(d.displaces, []);
});

test("your own label is never in `displaces` — re-stealing must not remove yourself", () => {
  const d = holdDecision({ holders: ["worker-capture", "dispatcher"], session: "worker-capture", steal: true });
  assert.deepEqual(d.displaces, ["dispatcher"],
    "removing your own label as part of taking the hold would end with the PR unheld");
});

// --- A RELEASE THAT LEAVES A PR UNARMED IS A HOLD THAT OUTLIVES ITS REASON ---
//
// Measured on #816 at 15:45Z 2026-09-09: `pr:hold` took the hold and disarmed correctly, read back null;
// `--release` removed the label and left `auto_merge` null. The PR was then free, green and unarmed,
// with nothing on it saying it was waiting — the state the README calls the most dangerous, because
// there is no longer anything to notice.

test("armVerdict reads the STATE, not the exit code — non-null autoMergeRequest is the only proof", () => {
  assert.equal(armVerdict({ autoMergeRequest: { mergeMethod: "MERGE" } }).armed, true);
});

test("MUTATION: a null autoMergeRequest after arming is NOT armed, however `gh pr merge` exited", () => {
  const v = armVerdict({ autoMergeRequest: null });
  assert.equal(v.armed, false);
  assert.match(v.reason, /STILL UNARMED/);
  assert.match(v.reason, /gh pr merge --auto --merge/, "the message must be followable");
});

test("MUTATION: an UNREADABLE PR is not armed either — unverified is not armed, the mirror of the disarm rule", () => {
  assert.equal(armVerdict(null).armed, false);
});

/**
 * The take disarms unconditionally, so by release time "was armed and I turned it off" and "was never
 * armed" have the same end state. Re-arming on the strength of the wrong one arms a PR nobody armed,
 * which is the failure pointed in the dangerous direction — so the take RECORDS what it found.
 */
test("the re-arm label is a real, distinct label — the take records what the release cannot recover", () => {
  assert.equal(REARM_LABEL, "rearm-on-release");
  assert.ok(!REARM_LABEL.startsWith("session:"),
    "it must not collide with the hold vocabulary `claimStatus` parses, or a hold marker becomes a holder");
});

test("armVerdict and disarmVerdict are OPPOSITE readings of the same field, not two spellings of one", () => {
  const armed = { autoMergeRequest: { mergeMethod: "MERGE" } };
  assert.equal(armVerdict(armed).armed, true);
  assert.equal(disarmVerdict(armed).disarmed, false);
  assert.equal(armVerdict({ autoMergeRequest: null }).armed, false);
  assert.equal(disarmVerdict({ autoMergeRequest: null }).disarmed, true);
});

/**
 * #1245: ONE PARSER FOR A REVIEW VERDICT, AND THE FIVE SPELLINGS IN ONE TEST.
 *
 * Before this, `git grep -ln convinced` returned six files and all six were prose — every session retyped
 * a matcher in its own prompt, and two disagreed. `ceo`'s heartbeat matched `(un)?convinced`; the clock
 * matched a bare `convinced`. **Both matched the same comment; one read a REFUSAL AS AN APPROVAL.**
 *
 * THE THREE POSITIVES ARE NOT OPTIONAL. A matcher returning false for everything satisfies every negative
 * case perfectly, which is the mistake this row's own evidence made before it was caught — so the
 * positives and the negatives live in ONE test and cannot be satisfied separately.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewVerdict } from "../../../../scripts/review-verdict.mjs";

test("#1245: all five spellings, in one test, positives and negatives together", () => {
  const cases: [string, string][] = [
    ["convinced", "convinced"],
    ["CONVINCED", "convinced"],
    ["Convinced.", "convinced"],
    ["not convinced yet", "not-convinced"],
    ["UNCONVINCED", "not-convinced"],
  ];
  for (const [body, expected] of cases) {
    assert.equal(reviewVerdict(body).verdict, expected,
      `"${body}" must read as ${expected}. A refusal read as an approval MERGES; an approval read as `
      + "absent stalls -- nothing happening is visible and the wrong thing happening silently is not");
  }
});

test("#1245: negation is a SEPARATE mechanism from the word boundary", () => {
  // `\bconvinced\b` is true for "not convinced yet" and correctly so -- the word IS present, and what
  // decides the verdict is which alternative matched. Fixing one by conflating it with the other is how
  // a parser starts answering a neighbouring question.
  assert.match("not convinced yet", /\bconvinced\b/,
    "the bare word is present in a refusal; the boundary alone cannot decide the verdict");
  assert.equal(reviewVerdict("not convinced yet").verdict, "not-convinced");
  assert.equal(reviewVerdict("UNCONVINCED").word, "UNCONVINCED",
    "and the word that decided it is returned, so a reader can see WHICH spelling was matched");
});

test("#1245: an unrecognised verdict shape is RETURNED, never silently dropped", () => {
  // The next spelling is already on its way -- `Review of`, `Re-read of` and `Re-read at` are all in use
  // as openers, and this is the fourth drift of this convention. A comment that opens like a verdict and
  // whose word matches nothing known is a DIFFERENT fact from a comment that is not a verdict at all,
  // and a parser answering null for both says the same thing about two different things.
  assert.equal(reviewVerdict("Review of #1 at abc123: mildly persuaded").verdict, "unrecognised");
  assert.equal(reviewVerdict("Re-read at abc123, by worker-capture: persuaded").verdict, "unrecognised");
  assert.equal(reviewVerdict("a comment about something else entirely").verdict, "none",
    "not-a-verdict and verdict-word-unrecognised must not collapse");
});

test("#1245: a real corrected comment carrying BOTH verdicts reads as the first word present", () => {
  // worker-judge's spelling correction on #1242 restates a superseded verdict beside the live one, so one
  // comment contains `not convinced` AND `convinced`. A counter would read two approvals. This parser is
  // deliberately FIRST-MATCH and says so: a caller wanting the live verdict must read the LAST comment,
  // not count words across one.
  const corrected = "At `84aa8c0f`: not convinced — neither case was caught.\nAt `b935b371`: convinced.";
  assert.equal(reviewVerdict(corrected).verdict, "not-convinced",
    "first match wins, stated rather than discovered -- this is a limit of the parser, not of the record");
});

test("#1245: the adverb BEFORE `convinced` negates too -- the gap worker-capture found on review", () => {
  // `not\s+convinced` required ADJACENCY. My own fixture put the adverb AFTER ("not convinced yet"),
  // which is the phrasing that survives it; the adverb BEFORE is the one that broke, and it turned a
  // refusal into an APPROVAL. Latent rather than live -- 0 occurrences across 64 recent comments --
  // which is exactly what was true of `UNCONVINCED` until the day it was written.
  for (const body of ["not yet convinced", "I am not entirely convinced", "not at all convinced"]) {
    assert.equal(reviewVerdict(body).verdict, "not-convinced", `"${body}" is a refusal`);
  }
  // AND THE BOUND IS A CHOICE. Unbounded, this would swing the other way and read a long sentence
  // mentioning `convinced` in passing as a refusal.
  assert.equal(reviewVerdict("this does not mean the reviewer was convinced").verdict, "convinced",
    "a distant `not` must not negate -- three words is the bound, and this is the case that sets it");
});

// --- #1259: the head and the author, which a clock needs as much as the word ---

// VERBATIM, the first three lines of worker-judge's two comments on #1244 (5652508877 at 09:42:49Z and
// 5652628448 at 10:10:04Z). The first stalled the PR: sha and word, no author. The second was the repost.
const REREAD_WITHOUT_AUTHOR = "Re-read of `94d6e948` — **convinced**.\n\n"
  + "My *not convinced* was that `stampWorktree` had no caller: an exported writer nothing invokes, so every";
const REREAD_IN_CONVENTION = "**Re-read of #1244 at `94d6e948`, by worker-judge: convinced.**\n\n"
  + "Reposting the verdict I left at 09:42Z in the convention. **The content is unchanged and the earlier "
  + "comment stands**;";

test("#1259: the real #1244 comment that STALLED yields its head and a RETURNED null author", () => {
  assert.deepEqual(reviewVerdict(REREAD_WITHOUT_AUTHOR),
    { verdict: "convinced", word: "convinced", head: "94d6e948", author: null },
    "a missing author is null, never a default -- a clock reading it as `someone else` would mark a PR "
    + "ready on its author's own comment");
});

test("#1259 POSITIVE CONTROL: the repost that worked yields all three -- a parser returning null for "
  + "every field passes the test above", () => {
  assert.deepEqual(reviewVerdict(REREAD_IN_CONVENTION),
    { verdict: "convinced", word: "convinced", head: "94d6e948", author: "worker-judge" });
  assert.deepEqual(
    reviewVerdict("**Review of #1301 at `057ff040`, by worker-judge: not convinced. One blocker.**"),
    { verdict: "not-convinced", word: "not convinced", head: "057ff040", author: "worker-judge" });
});

test("#1259: head and author come from the OPENER LINE only -- a sha or a `by` in the body is not the "
  + "verdict's", () => {
  const body = "Re-read of #9 at `1111111a` — convinced.\n\n"
    + "My earlier not-convinced at `84aa8c0f` was found by worker-capture, reviewed by `ceo`.";
  const { head, author } = reviewVerdict(body);
  assert.equal(head, "1111111a", "the body's `84aa8c0f` is a different head");
  assert.equal(author, null, "`by worker-capture` in the body is not who wrote this verdict");
});

test("#1259: a comment that is not a verdict carries no head or author, even when it names both", () => {
  assert.deepEqual(reviewVerdict("Pushed `abcdef12`, reviewed by worker-capture."),
    { verdict: "none", word: null, head: null, author: null });
});

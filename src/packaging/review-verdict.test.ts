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
import { reviewVerdict, verdictAtHead, verdictAmong } from "../review-verdict.ts";

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

// --- #1324: FIRST is pinned, and the author is the convention's `, by <name>:` ---

// VERBATIM, the opener line of the re-read on #1264 (comment 5652879452). It carries TWO shas and names the
// superseded one second, so a parser taking the LAST backticked hex returns `cf4f3345`: an older verdict's head.
const REREAD_1264 = "**Re-read of #1264 at `55c92b7f`, by worker-capture: CONVINCED.** Re-affirmed at the current "
  + "head; the verdict at `cf4f3345` is superseded by this one rather than carried over.";

test("#1324: the real #1264 opener line with two shas yields the FIRST head, not the superseded one", () => {
  const { head, author } = reviewVerdict(REREAD_1264);
  assert.equal(head, "55c92b7f", "`cf4f3345` is the verdict this one supersedes");
  assert.equal(author, "worker-capture");
});

test("#1324: a `by` before the convention's own is not the author -- `prompted by ceo` is not ceo's verdict",
  () => {
    // Fails OPEN if it slips: a clock asking whether a verdict comes from someone other than the PR's author
    // would see `ceo` on worker-x's own verdict. 0 of 47 real opener lines had this shape when #1324 was filed.
    const { head, author } = reviewVerdict("**Review of #1301 at `b2fa1fa6`, prompted by ceo, by worker-x: convinced.**");
    assert.equal(author, "worker-x", "the convention's `, by <name>:` names the reviewer; an earlier `by` does not");
    assert.equal(head, "b2fa1fa6");
  });

test("#1324: a backticked run id BEFORE the head is not the head -- the sha after `at` is", () => {
  assert.equal(reviewVerdict("**Review of #1301 (ci run `34764381448`) at `b2fa1fa6`, by worker-x: convinced.**").head,
    "b2fa1fa6", "a decimal run id is 11 hex-shaped digits; `at` is what says which backticked value is the head");
});

test("#1324 POSITIVE CONTROL: with no `, by <name>:` on the line, a bare `by` is still read, and no `by` is still "
  + "null -- an anchored-only author passes the tests above", () => {
  // Constructed, not quoted: the fallback's shape. #1244's real author-less line is the null case above.
  assert.equal(reviewVerdict("Re-read of `94d6e948` by worker-judge — convinced.").author, "worker-judge");
  assert.equal(reviewVerdict(REREAD_WITHOUT_AUTHOR).author, null);
});

test("#1324: the FIRST `, by <name>:` is the author when the opener line quotes a superseded verdict in the same "
  + "convention", () => {
  // Constructed: 0 of 168 real opener lines (the last 120 PRs, read 2026-09-13) carry two. The shape is #1264's
  // own -- a re-read naming the verdict it supersedes on the same line -- with the superseded one's author added.
  const line = "**Re-read of #1 at `55c92b7f`, by worker-capture: CONVINCED.** Supersedes the review at `cf4f3345`, "
    + "by worker-judge: not convinced.";
  assert.deepEqual(reviewVerdict(line),
    { verdict: "convinced", word: "CONVINCED", head: "55c92b7f", author: "worker-capture" },
    "the second `, by <name>:` belongs to the verdict this one supersedes");
});

// --- #3030: A VERDICT LIVES IN A REVIEW BODY AS WELL AS A COMMENT -------------------------------------
//
// The door posts the whole verdict as the review and no comment. `verdictAmong` used to read `pr.comments` alone, so a
// PR carrying its verdict in the review read as ABSENT and the gate re-summoned a reviewer who had answered.

const HEAD_3020 = "96f6958d0000000000000000000000000000abcd";
const BODY_3020 = "**Review of #3020 at `96f6958d`, by reviewer-3020: convinced.**\n\nAcceptance: pnpm test — 12/0\n";
const review = (state: string, submittedAt: string, body: string) => ({ id: `R-${submittedAt}`, state, submittedAt, body });
const comment = (createdAt: string, body: string) => ({ id: `C-${createdAt}`, createdAt, body });
const PR_AUTHOR = { login: "worker-1" };

test("#3030 POSITIVE CONTROL: #3020's real shape -- an APPROVED review with the whole body and NO comment -- "
  + "reads convinced now and ABSENT under the old comments-only reader", () => {
  const pr = { author: PR_AUTHOR, comments: [], reviews: [review("APPROVED", "2026-10-02T14:05:49Z", BODY_3020)] };
  const found = verdictAmong(pr, [HEAD_3020]);
  assert.equal(found.verdict, "convinced");
  assert.equal(found.by, "reviewer-3020");
  // The old reader: the same call over `comments` only. If this were not null the case above would prove nothing
  // about the new branch, which could then pass by never being reached.
  assert.equal(verdictAtHead({ comments: pr.comments, head: HEAD_3020 }).verdict, null,
    "the comments-only reader must see nothing here, or the review branch is not what answered");
});

test("#3030: a verdict in the review, the comment, or BOTH is ONE verdict at that head", () => {
  const r = review("APPROVED", "2026-10-02T14:05:49Z", BODY_3020);
  const c = comment("2026-10-02T14:06:28Z", BODY_3020);
  for (const [name, pr] of [
    ["review only", { author: PR_AUTHOR, comments: [], reviews: [r] }],
    ["comment only", { author: PR_AUTHOR, comments: [c], reviews: [] }],
    ["both", { author: PR_AUTHOR, comments: [c], reviews: [r] }],
  ] as const) {
    const found = verdictAmong(pr, [HEAD_3020]);
    assert.equal(found.verdict, "convinced", name);
    assert.equal(found.examined, pr.comments.length + pr.reviews.length, `${name}: examined counts what was read`);
  }
  assert.equal(verdictAmong({ author: PR_AUTHOR, comments: [c], reviews: [r] }, [HEAD_3020]).id, c.id,
    "both present: the newest is the one reported, once");
});

test("#3030: newest at the head wins ACROSS review bodies and comments, in both directions", () => {
  const no = "**Review of #9 at `aaaaaaaa`, by reviewer-9: not convinced — the blocker.**";
  const yes = "**Review of #9 at `aaaaaaaa`, by reviewer-9: convinced.**";
  const head = "aaaaaaaa0000000000000000000000000000abcd";
  const cases: [string, { reviews?: unknown[]; comments?: unknown[] }, string][] = [
    ["not convinced review, then convinced review", { reviews: [
      review("CHANGES_REQUESTED", "2026-10-02T10:00:00Z", no), review("APPROVED", "2026-10-02T11:00:00Z", yes)] }, "convinced"],
    ["convinced review, then not convinced review", { reviews: [
      review("APPROVED", "2026-10-02T10:00:00Z", yes), review("CHANGES_REQUESTED", "2026-10-02T11:00:00Z", no)] }, "not-convinced"],
    ["not convinced review, then convinced COMMENT", { reviews: [review("CHANGES_REQUESTED", "2026-10-02T10:00:00Z", no)],
      comments: [comment("2026-10-02T11:00:00Z", yes)] }, "convinced"],
    ["convinced COMMENT, then not convinced review", { comments: [comment("2026-10-02T10:00:00Z", yes)],
      reviews: [review("CHANGES_REQUESTED", "2026-10-02T11:00:00Z", no)] }, "not-convinced"],
  ];
  for (const [name, pr, expected] of cases) {
    assert.equal(verdictAmong({ author: PR_AUTHOR, comments: [], reviews: [], ...pr }, [head]).verdict, expected, name);
  }
});

test("#3030: the verdict is read AT ITS HEAD -- a review at an older head is not a verdict at the new one", () => {
  const pr = { author: PR_AUTHOR, comments: [], reviews: [review("APPROVED", "2026-10-02T14:05:49Z", BODY_3020)] };
  assert.equal(verdictAmong(pr, ["bbbbbbbb0000000000000000000000000000abcd"]).verdict, null);
});

test("#3030: a refusal is never read as an approval in a review body -- the parser's own cases, over reviews", () => {
  const head = "cccccccc0000000000000000000000000000abcd";
  for (const word of ["not convinced yet", "UNCONVINCED", "not yet convinced", "I am not entirely convinced"]) {
    const body = `**Review of #9 at \`cccccccc\`, by reviewer-9: ${word}.**`;
    const pr = { author: PR_AUTHOR, comments: [], reviews: [review("CHANGES_REQUESTED", "2026-10-02T10:00:00Z", body)] };
    assert.equal(verdictAmong(pr, [head]).verdict, "not-convinced", `"${word}" in a review body is a refusal`);
  }
});

test("#3030: a review with no body (a bare approval) is not a verdict, and a PR with no reviews field still reads", () => {
  const head = "cccccccc0000000000000000000000000000abcd";
  assert.equal(verdictAmong({ author: PR_AUTHOR, comments: [], reviews: [review("APPROVED", "2026-10-02T10:00:00Z", "")] },
    [head]).verdict, null);
  assert.equal(verdictAmong({ author: PR_AUTHOR, comments: [comment("2026-10-02T10:00:00Z",
    "**Review of #9 at `cccccccc`, by reviewer-9: convinced.**")] }, [head]).verdict, "convinced",
  "a pull request read without `reviews` keeps working off its comments");
});

// --- agent-org#586: A DISMISSED REVIEW IS A VERDICT SOMEBODY RULED OUT ---------------------------------
//
// agent-org#579's only review ("not convinced" at its head) was ruled wrong and dismissed, and the gate kept reading it as the
// standing verdict, so `settledVerdictOrder` kept sending the author `verdict-not-convinced` for rework that was not owed.

test("agent-org#586: a DISMISSED refusal at the head is no verdict, and the same review still standing IS one", () => {
  const head = "0715e664c0000000000000000000000000000abc";
  const body = "**Review of #579 at `0715e664`, by reviewer-579: not convinced — the blocker.**";
  const at = "2026-10-10T01:00:00Z";
  const dismissed = verdictAmong({ author: PR_AUTHOR, comments: [], reviews: [review("DISMISSED", at, body)] }, [head]);
  assert.equal(dismissed.verdict, null, "a dismissed refusal is not the standing verdict");
  assert.equal(dismissed.examined, 0, "and it is not counted among what was read");
  // The positive control: the identical review in the state a live refusal carries. Without it the null above could be an
  // empty reader rather than the dismissal being honoured.
  assert.equal(verdictAmong({ author: PR_AUTHOR, comments: [], reviews: [review("CHANGES_REQUESTED", at, body)] }, [head]).verdict,
    "not-convinced", "the same refusal, not dismissed, still reads not-convinced");
});

test("agent-org#586: a newer convinced review after a dismissed refusal is the verdict; a review with no state still counts", () => {
  const head = "0715e664c0000000000000000000000000000abc";
  const no = "**Review of #579 at `0715e664`, by reviewer-579: not convinced — the blocker.**";
  const yes = "**Review of #579 at `0715e664`, by reviewer-579: convinced.**";
  const after = { author: PR_AUTHOR, comments: [], reviews: [
    review("DISMISSED", "2026-10-10T01:00:00Z", no), review("APPROVED", "2026-10-10T05:00:00Z", yes)] };
  assert.equal(verdictAmong(after, [head]).verdict, "convinced");
  // The older callers' shape: no `state` at all. It must not be mistaken for a dismissal.
  const stateless = { id: "R-1", submittedAt: "2026-10-10T01:00:00Z", body: no };
  assert.equal(verdictAmong({ author: PR_AUTHOR, comments: [], reviews: [stateless] }, [head]).verdict, "not-convinced");
});

test("agent-org#586: a dismissed review does not hide a verdict comment, and the comment alone still settles the head", () => {
  const head = "0715e664c0000000000000000000000000000abc";
  const yes = "**Review of #579 at `0715e664`, by reviewer-579: convinced.**";
  const no = "**Review of #579 at `0715e664`, by reviewer-579: not convinced — the blocker.**";
  const pr = { author: PR_AUTHOR, comments: [comment("2026-10-10T05:00:00Z", yes)],
    reviews: [review("DISMISSED", "2026-10-10T06:00:00Z", no)] };
  const found = verdictAmong(pr, [head]);
  assert.equal(found.verdict, "convinced", "the dismissed refusal is newer than the comment and still does not outrank it");
  assert.equal(found.examined, 1, "only the comment was read");
});

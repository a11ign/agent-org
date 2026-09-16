// command: (not a command) the ONE parser for a review verdict comment; imported, never retyped.

/**
 * #1245: READ A REVIEW VERDICT, IN ONE PLACE.
 *
 * `git grep -ln convinced` returned six files before this one and all six were PROSE. Every session that
 * needed to know whether a PR carried a verdict retyped a matcher inside its own prompt, and **two of them
 * already disagreed**: `ceo`'s heartbeat matched `(un)?convinced`, the clock matched a bare `convinced`.
 * Both matched the same comment; one classified it correctly and one read a REFUSAL AS AN APPROVAL.
 *
 * THAT IS THE FAILURE DIRECTION THAT MATTERS. A refusal read as an approval merges; an approval read as
 * absent stalls. Nothing happening is visible and the wrong thing happening silently is not -- so the
 * boundary below is not tidiness, it is the difference between the two.
 *
 * AND IT HAS BITTEN IN BOTH DIRECTIONS IN ONE MORNING. `worker-judge` wrote `UNCONVINCED`, which a
 * case-insensitive substring read as an approval; their own `[Cc]onvinced` check then failed to see a
 * real `CONVINCED` and reported a verdict that had stood for thirty minutes as absent. One convention,
 * two ad-hoc readers, two opposite wrong answers.
 */

/**
 * Verdict words this parser knows, longest first so `unconvinced` is never read as `convinced`.
 *
 * THE ADVERB GAP, found by `worker-capture` on review: `not\s+convinced` requires ADJACENCY, so
 * "not yet convinced" and "I am not entirely convinced" matched the bare word and read as APPROVALS —
 * the exact direction this file exists to stop. My own fixture put the adverb AFTER ("not convinced
 * yet"), which is the phrasing that survives adjacency; the one that breaks it is the adverb BEFORE.
 *
 * LATENT RATHER THAN LIVE, measured: across the 40 most recent PRs and 64 comments, `not <word>
 * convinced` appears 0 times. **That is exactly what was true of `UNCONVINCED` until yesterday.**
 *
 * THE THREE-WORD BOUND IS A CHOICE, NOT AN OVERSIGHT. Unbounded `.*?` swings the failure the other way:
 * it would read "I am not going to pretend I am convinced by the first draft, but at this head:
 * convinced" as a refusal. Three words covers the adverbs people write and leaves "this does not mean
 * the reviewer was convinced" reading as `convinced`, which is right.
 */
const WORDS = /\b(un-?convinced|not\s+(?:\w+\s+){0,3}convinced|convinced)\b/i;

/** An opener that says a comment is a VERDICT at all. Three are in use; the fourth is already coming. */
const OPENER = /\b(?:Review|Re-read)\s+(?:of|at)\b/i;

/**
 * #1259: THE HEAD AND THE AUTHOR, READ FROM THE VERDICT'S OWN OPENER LINE AND NOWHERE ELSE.
 *
 * A clock does not ask "is there a verdict" but "is there a verdict AT THIS HEAD, FROM A REVIEWER WHO IS NOT
 * ME". The word had one parser (#1245); the other two fields were still retyped per session, and on #1244 a
 * genuine `Re-read of \`94d6e948\` — **convinced**.` stalled a PR for thirty minutes because it named no
 * author and a hand-typed matcher required one.
 *
 * ONLY THE OPENER LINE, because a verdict's body routinely quotes other shas and other people ("my first
 * not-convinced at `84aa8c0f`", "found by worker-capture"), and a field read from the body would be a
 * confident wrong answer where the absent one is at least visible.
 *
 * ABSENT IS `null`, AND IT IS RETURNED, NEVER DEFAULTED. A clock that read a missing author as "someone else"
 * would mark a PR ready on its author's own comment; `null` makes that caller decide.
 */
const HEAD = /`([0-9a-f]{7,40})`/i;
const AUTHOR = /\bby\s+`?([A-Za-z][\w-]*)`?/;

/**
 * #1324: EACH FIELD PREFERS THE CONVENTION'S OWN SPELLING, AND FALLS BACK TO THE FIRST MATCH ABOVE.
 *
 * `**Review of #1301 (ci run \`34764381448\`) at \`b2fa1fa6\`, prompted by ceo, by worker-x: convinced.**`
 * read as head `34764381448` and author `ceo`. The run id fails closed (no such head); the author fails OPEN,
 * because a clock asking "is this verdict from someone other than the PR's author" sees `ceo` on worker-x's
 * own verdict. So the head is the sha after `at`/`of`, and the author is the `by <name>` a colon closes.
 * The fallbacks keep a line written outside the convention readable, and absent still returns `null`.
 */
const HEAD_AFTER_AT = /\b(?:at|of)\s+`([0-9a-f]{7,40})`/i;
const AUTHOR_IN_CONVENTION = /,\s*by\s+`?([A-Za-z][\w-]*)`?:/;

/** @param {string} line @param {RegExp[]} patterns @returns {string | null} the first pattern's capture that matches */
function firstCapture(line, patterns) {
  for (const pattern of patterns) {
    const m = pattern.exec(line);
    if (m) return m[1];
  }
  return null;
}

/** @param {string} text @returns {string | null} the first line that opens like a verdict */
function openerLine(text) {
  return text.split("\n").find((line) => OPENER.test(line)) ?? null;
}

/**
 * The verdict a comment carries.
 *
 * `unrecognised` is a RETURNED VALUE, never a silent null: a comment that opens like a verdict and whose
 * word matches nothing known is the next drift arriving, and a parser that answers `null` for it says the
 * same thing it says for a comment that is not a verdict at all. Those are different facts.
 *
 * THIS ANSWERS "WHAT VERDICT DOES THIS COMMENT CARRY", NEVER "IS THIS COMMENT A VERDICT". `OPENER` is
 * consulted only when no word matched, so it can RESCUE an unknown word and can never REJECT a mention:
 * over the same 64-comment corpus the parser calls 4 non-verdicts `convinced`. Gating on the opener would
 * fail worse -- a verdict written without a header would go invisible -- so the limit is stated here
 * rather than closed.
 *
 * `head` and `author` come from the opener line only (#1259) and are `null` when that line does not carry them.
 *
 * @param {string} body
 * @returns {{ verdict: "convinced" | "not-convinced" | "unrecognised" | "none", word: string | null,
 *             head: string | null, author: string | null }}
 */
export function reviewVerdict(body) {
  const text = typeof body === "string" ? body : "";
  const opener = openerLine(text);
  const head = opener ? firstCapture(opener, [HEAD_AFTER_AT, HEAD]) : null;
  const author = opener ? firstCapture(opener, [AUTHOR_IN_CONVENTION, AUTHOR]) : null;
  const m = WORDS.exec(text);
  if (m) {
    const word = m[0].toLowerCase().replace(/\s+/g, " ");
    // NEGATION IS A SEPARATE MECHANISM FROM THE BOUNDARY, and conflating them is how one gets fixed by
    // breaking the other. `\bconvinced\b` is TRUE for "not convinced yet" and correctly so -- the word IS
    // present. What decides the verdict is which of the three alternatives above matched.
    return { verdict: word === "convinced" ? "convinced" : "not-convinced", word: m[0], head, author };
  }
  return OPENER.test(text)
    ? { verdict: "unrecognised", word: null, head, author }
    : { verdict: "none", word: null, head, author };
}

/**
 * #912: THE VERDICT AT ONE HEAD, AND WHO WROTE IT -- the question a wake gate actually asks.
 *
 * `reviewVerdict` answers "what verdict does THIS COMMENT carry". The clock's question is one level up and
 * this file has stated it since #1259 without anyone being able to call it: *"is there a verdict AT THIS
 * HEAD, FROM A REVIEWER WHO IS NOT ME"*. Every session that needed it walked the comment list in its own
 * prompt, which is the shape #1245 ended for the word and #1259 ended for the two fields -- one level out,
 * and still open.
 *
 * IT RETURNS FACTS AND DECIDES NOTHING, which is this file's existing rule ("`null` makes that caller
 * decide") carried up. In particular `byIsAuthor` is **`null` when the opener named nobody** -- never
 * `false`. A caller that read absent as "someone else" would settle a PR on its own author's comment; a
 * caller that read it as "the author" would re-wake a reviewer forever on a genuine author-less verdict,
 * which is precisely the `Re-read of \`94d6e948\` -- **convinced**.` that stalled #1244 for thirty minutes.
 * Both are wrong, they are wrong in opposite directions, and neither is this function's to choose.
 *
 * WHY THE TWO CALLERS WANT OPPOSITE DEFAULTS, stated here so the next one does not have to rediscover it:
 * an ARM gate must fail CLOSED on an unattributed verdict (merging on the author's own word is the
 * silent-wrong-thing direction this file opens by naming), while a WAKE gate should fail toward WAKING
 * (a needless wake costs one turn and is visible; a missed one stalls a draft and is not). The wake side
 * is safe to default that way only because its order ledger dedupes on the head sha, so "wake anyway"
 * costs one turn per head rather than one per tick.
 *
 * HEADS COMPARE BY PREFIX because the convention writes eight characters (`docs/roles/reviewer.md`: a
 * comment matching ``at `<head8>` ``) while the API returns forty, and `reviewVerdict` accepts 7-40. The
 * shorter being a prefix of the longer is the whole test; equality would find nothing.
 *
 * @param {{ comments: { body: string, id?: number | string }[], head: string, prAuthor?: string | null }} q
 * @returns {{ verdict: "convinced" | "not-convinced" | null, by: string | null,
 *             byIsAuthor: boolean | null, id: number | string | null, examined: number }}
 */
/** Whether this comment carries a real verdict at `head`. Extracted so `verdictAtHead` stays under the
 * complexity ceiling -- the loop was doing the finding and the judging in one function. */
function verdictHereAt(comment, head) {
  const parsed = reviewVerdict(comment?.body ?? "");
  if (parsed.verdict !== "convinced" && parsed.verdict !== "not-convinced") return null;
  return headMatches(parsed.head, head) ? parsed : null;
}

export function verdictAtHead({ comments, head, prAuthor = null }) {
  const examined = comments?.length ?? 0;
  const none = { verdict: /** @type {null} */ (null), by: null, byIsAuthor: /** @type {null} */ (null),
    id: null, examined };
  if (!head || examined === 0) return none;
  // NEWEST WINS. `reviewer.md` settles a re-review by the LAST verdict at the head ("a PR you reviewed
  // earlier whose head has moved since is not done"), and a reviewer who writes `not-convinced` and then
  // `convinced` at the same head has changed their mind, not written two verdicts.
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const c = comments[i];
    const parsed = verdictHereAt(c, head);
    if (!parsed) continue;
    return {
      verdict: parsed.verdict,
      by: parsed.author,
      // `null`, NOT `false`, when the opener named nobody -- see the header. This is the field callers get
      // wrong, so it is the one that refuses to guess.
      byIsAuthor: parsed.author === null || prAuthor === null ? null : parsed.author === prAuthor,
      id: c?.id ?? null,
      examined,
    };
  }
  return none;
}

/**
 * Whether a verdict's head names the PR's head. PREFIX, EITHER WAY ROUND -- see the header.
 * @param {string | null} stated @param {string} actual
 */
export function headMatches(stated, actual) {
  if (!stated || !actual) return false;
  const a = stated.toLowerCase();
  const b = actual.toLowerCase();
  return a.startsWith(b) || b.startsWith(a);
}

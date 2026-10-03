// command: (not a command) the ONE parser for a review verdict comment; imported, never retyped.
import { createHash } from "node:crypto";

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

/** Whether this comment carries a real verdict at `head`. Extracted so `verdictAtHead` stays under the
 * complexity ceiling -- the loop was doing the finding and the judging in one function. */
function verdictHereAt(comment, head) {
  const parsed = reviewVerdict(comment?.body ?? "");
  if (parsed.verdict !== "convinced" && parsed.verdict !== "not-convinced") return null;
  return headMatches(parsed.head, head) ? parsed : null;
}

/**
 * #3030: THE PLACES A VERDICT LIVES, as ONE list oldest first -- the PR's comments AND its review bodies.
 *
 * The door (`reviewer/pr-review-verdict.sh`) now posts the verdict file's whole text as the review body and
 * no comment, so a gate reading `comments` alone would call every such PR verdictless and re-summon a
 * reviewer who had answered. Comments stay in the list: every PR already open carries its verdict there,
 * and a PR carrying it in both places still reads as ONE verdict, because `verdictAtHead` returns the
 * newest match and never counts.
 *
 * ORDER IS BY TIME, NOT BY SOURCE: a `not convinced` review followed by a `convinced` comment (or the
 * reverse) is a reviewer changing their mind, and "newest wins" has to hold across the two. An item with
 * no readable time sorts OLDEST and keeps its place among its peers (the sort is stable), so a list with
 * no times at all reads in the order it was given, as `verdictAtHead` did before.
 *
 * @param {{ comments?: any[] | null, reviews?: any[] | null }} pr
 * @returns {{ body: string, id?: number | string }[]}
 */
export function verdictBearers(pr) {
  const timed = (/** @type {any} */ item, /** @type {string} */ field) =>
    ({ at: Date.parse(item?.[field] ?? ""), body: item?.body ?? "", id: item?.id });
  const items = [
    ...(pr?.comments ?? []).map((/** @type {any} */ c) => timed(c, "createdAt")),
    ...(pr?.reviews ?? []).map((/** @type {any} */ r) => timed(r, "submittedAt")),
  ];
  const key = (/** @type {{ at: number }} */ item) => (Number.isFinite(item.at) ? item.at : -Infinity);
  return items
    .sort((a, b) => (key(a) === key(b) ? 0 : key(a) < key(b) ? -1 : 1))
    .map(({ body, id }) => ({ body, id }));
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
 * is safe to default that way only because its order ledger dedupes on the PATCH id (#3045), so "wake anyway"
 * costs one turn per patch rather than one per tick.
 *
 * HEADS COMPARE BY PREFIX because the convention writes eight characters (`.agent-org/roles/reviewer.md`: a
 * comment matching ``at `<head8>` ``) while the API returns forty, and `reviewVerdict` accepts 7-40. The
 * shorter being a prefix of the longer is the whole test; equality would find nothing.
 *
 * @param {{ comments: { body: string, id?: number | string }[], head: string, prAuthor?: string | null }} q
 * @returns {{ verdict: "convinced" | "not-convinced" | null, by: string | null,
 *             byIsAuthor: boolean | null, id: number | string | null, examined: number }}
 */
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

/**
 * a11ign#3199: DOES A REFUSAL STILL APPLY -- the one decider the door (`reviewer/pr-review-verdict.sh`) and the gate (`verdictAmong`,
 * `refusedPrompt`) both ask, so they cannot disagree about whether a refusal stands.
 *
 * A VERDICT IS VALID FOR A PATCH ON A BASE, NOT FOR A PATCH ALONE. `patchIdOfDiff` hashes only what a pull request adds and removes, so
 * it cannot see that what a review refused lay somewhere else: a11ign#3154 was refused for `ts / run` failing on a defect in `main`, `main`
 * was fixed, Dependabot rebased, the patch was byte-for-byte the same, and both the door ("a second review at an equal patch") and the gate
 * ("the PATCH is unchanged ... the rework is yours") held the refusal in place for 18 minutes, until a human dismissed it.
 *
 * THE DISCRIMINATING FACT IS A CHECK RUN, NEVER THE REVIEW'S PROSE: a refusal is LIFTED when it is a refusal, at least one check run
 * concluded `failure` at the commit it was posted at, and none does at the current head. Nothing here reads comments, and a reviewer's
 * word "blocker" is not a field. The #3033 shape (a merge of `main`, every check green at both commits) stays refused, so does a head that
 * still fails, and so does an APPROVAL however red the older commit was: a second approval is exactly what #3050 exists to stop.
 *
 * AN UNREAD CHECK IS NOT A GREEN ONE. `null`/`undefined` (the read was refused, or never made) is never an empty list, so a lift needs both
 * lists READ: absence of a reading is not a reading of change.
 *
 * @param {{ refused: boolean, failingThen: readonly string[] | null | undefined, failingNow: readonly string[] | null | undefined }} q
 *   `failingThen`: the names of the check runs that concluded `failure` at the commit the refusal was posted at; `failingNow`: at the head.
 * @returns {boolean}
 */
export function refusalLifted({ refused, failingThen, failingNow }) {
  return refused === true
    && Array.isArray(failingThen) && failingThen.length > 0
    && Array.isArray(failingNow) && failingNow.length === 0;
}

/**
 * a11ign#3199: whether the refusal posted at `oid` is lifted at this pull request's current head, from `pr.failingChecks` (oid -> the names
 * of the check runs that concluded `failure` there, attached by `withFailingChecks` for the equal-patch refusals only). A commit nobody read
 * is absent from it, and absent is not green (`refusalLifted`).
 * @param {any} pr @param {string | null | undefined} oid @returns {boolean}
 */
export function refusalLiftedAt(pr, oid) {
  const checks = pr?.failingChecks ?? {};
  // BY PREFIX, as heads compare everywhere here: a verdict's `at <head8>` and a review's full oid are one commit, and the read was made at one of them.
  const at = (/** @type {string | null | undefined} */ sha) => {
    const key = sha ? Object.keys(checks).find((k) => headMatches(k, sha)) : undefined;
    return key === undefined ? null : checks[key];
  };
  return refusalLifted({ refused: true, failingThen: at(oid), failingNow: at(String(pr?.headRefOid ?? "")) });
}

/**
 * The verdict this pull request carries, looked for at EVERY head whose patch equals the current one's
 * (`equivalentHeads`, #3045). A reviewer who wrote `at <head8>` before an update-branch or a rebase wrote it at
 * THAT sha, so reading only the current one would re-summon a reviewer who had answered.
 *
 * A REFUSAL AT AN OLDER HEAD THAT `refusalLifted` says no longer applies IS NOT A VERDICT HERE (a11ign#3199): the pull request is then
 * as unreviewed as at a head nobody answered, so the reviewer is asked for a fresh look instead of the author being told the work is theirs.
 * @param {any} pr @param {string[]} heads
 */
export function verdictAmong(pr, heads) {
  // #3030: comments AND review bodies, since the door posts the verdict as a review alone.
  const bearers = verdictBearers(pr);
  const at = (/** @type {string} */ head) => verdictAtHead({ comments: bearers, head, prAuthor: pr.author?.login ?? null });
  let found = at(heads[0]);
  for (const head of heads.slice(1)) {
    if (found.verdict !== null) break;
    const here = at(head);
    if (here.verdict === "not-convinced" && refusalLiftedAt(pr, head)) continue;
    found = here;
  }
  return found;
}

/**
 * a11ign#3199: THE OLDER EQUAL-PATCH HEADS AT WHICH A REFUSAL STANDS -- the only commits whose check runs are worth a read, so the common
 * path (no refusal at an equal patch) makes no call. Newest verdict per head, as `verdictAmong` reads it.
 * @param {any} pr @returns {string[]}
 */
export function refusalHeads(pr) {
  const bearers = verdictBearers(pr);
  /** @type {string[]} */
  const found = [];
  for (const head of equivalentHeads(pr).slice(1)) {
    // ONE READ PER COMMIT: a review's full oid and a verdict's `at <head8>` are the same commit, and `evidenceHeads` keeps both spellings.
    if (found.some((seen) => headMatches(seen, head))) continue;
    if (verdictAtHead({ comments: bearers, head, prAuthor: pr.author?.login ?? null }).verdict === "not-convinced") found.push(head);
  }
  return found;
}

/** The lines of a file's header that say WHICH file and what happened to it -- the part of a diff outside a hunk that is content. */
const FILE_HEADER_LINE = /^(diff --git |rename |new file mode|deleted file mode|old mode|new mode|Binary files)/;

/**
 * #3045: THE PATCH ID of a unified diff -- what a pull request CHANGES, and nothing about where it sits.
 *
 * A VERDICT IS VALID FOR A PATCH, NOT FOR A HEAD SHA. A merge from `main`, a rebase and an amend each make a new head with the
 * same work, and a gate keyed on the sha ordered a reviewer again for each (a11ign#3033: four merges, six reviews, five of them
 * redundant). `git patch-id --stable` is the idea; the gate has no checkout, so this hashes the compare API's diff the same way.
 *
 * ONLY WHAT THE PATCH ADDS AND REMOVES IS HASHED, with the file it touches: no hunk header (its line numbers move whenever `main`
 * edits above the change), no `index` line (it names blobs), no context (a neighbour's edit is not this PR's work). A merge whose
 * conflict resolution rewrote a line of the PR's own therefore reads as a DIFFERENT patch, which is the case a headline regex
 * could not see. Inside a hunk every `+`/`-` line is content, including `--- x` and `+++ x`, which are headers only before the
 * first `@@` of a file.
 *
 * `null` for anything that is not text, which is "could not read", never "the empty patch": an empty string is a real diff
 * (head equal to base) and hashes to its own id.
 *
 * @param {unknown} diff @returns {string | null} 64 hex characters
 */
export function patchIdOfDiff(diff) {
  if (typeof diff !== "string") return null;
  const hash = createHash("sha256");
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (line.startsWith("diff --git ")) inHunk = false;
    if (inHunk ? /^[+-]/.test(line) : FILE_HEADER_LINE.test(line)) hash.update(`${line}\n`);
  }
  return hash.digest("hex");
}

/**
 * #3045: HOW MANY OLDER HEADS A PULL REQUEST'S PATCH IS COMPARED AGAINST. Each is one `gh api` call on the CORE pool, once per
 * tick, so a pull request with forty reviews must not cost forty. The newest verdict at an equal patch wins, so the newest
 * few are the ones that can matter; 6 is #3033's own worst case (six reviews, one authored commit).
 */
export const MAX_EVIDENCE_HEADS = 6;

/**
 * #3045: THE OLDER HEADS WHOSE PATCH IS WORTH READING, newest last, none of them the current head: where a review was posted
 * (`reviews[].commit.oid`, a full sha) and where a verdict says it was written (the opener's `at <head8>`, an abbreviation the
 * compare API resolves). A head nobody reviewed or answered at cannot carry a verdict, so reading it would be a call for nothing.
 *
 * @param {any} pr @returns {string[]}
 */
export function evidenceHeads(pr) {
  const head = String(pr?.headRefOid ?? "");
  const reviewed = (pr?.reviews ?? []).map((/** @type {any} */ r) => String(r?.commit?.oid ?? ""));
  const stated = verdictBearers(pr).map((b) => reviewVerdict(b.body).head ?? "");
  const older = [...new Set([...reviewed, ...stated])].filter((oid) => oid !== "" && !headMatches(oid, head));
  return older.slice(-MAX_EVIDENCE_HEADS);
}

/**
 * #3045: THE HEADS THAT ARE THE SAME WORK AS THE CURRENT ONE -- the current head first, then every other head whose patch id
 * (`pr.patchIds`, oid -> id, attached by `withPatchIds`) equals its own. A verdict at any of them STANDS.
 *
 * AN UNREAD PATCH IS NEVER AN EQUAL ONE: when the current head's id is missing the answer is the current head alone, which is what
 * a gate without this read did, and a head whose own id is missing is left out. Absence of a reading is not a reading of equality.
 *
 * @param {any} pr @returns {string[]}
 */
export function equivalentHeads(pr) {
  const head = String(pr?.headRefOid ?? "");
  const ids = pr?.patchIds ?? {};
  if (head === "") return [];
  if (typeof ids[head] !== "string") return [head];
  return [head, ...Object.keys(ids).filter((oid) => oid !== head && ids[oid] === ids[head])];
}

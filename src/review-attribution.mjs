// @ts-check
/**
 * #2127: WHICH SESSION POSTED A REVIEW, READ FROM SOMETHING THAT IS NOT PROSE.
 *
 * THE FINDING. Every review in this repository is posted by ONE GitHub account. Measured
 * 2026-09-23 on #2105's four reviews: `user.login` is `a11ign-bot` on all four, and two different
 * org sessions (`reviewer` and `reviewer-2`) wrote them. The reviewing session's name existed only
 * inside the review BODY -- `**Review of #2105 at \`b45c5730\`, by reviewer-2: not convinced ...**`.
 * So the parity rule stated in `.claude/rules/agent-practices.md` and applied by `parityOwner` below
 * (odd pull requests are `reviewer`'s, even are `reviewer-2`'s) could be BROKEN WITHOUT BEING
 * BREAKABLE-INTO-VIEW: #2105 is odd, `reviewer-2` reviewed it twice including the APPROVAL, and it
 * took a human reading four review bodies an hour later to notice.
 *
 * WHY NOT A PARSER OVER THE BODY. `review-verdict.mjs` already reads a `by <name>` out of the opener
 * line, and that is exactly as far as prose can be pushed: it returns `null` whenever the writer did
 * not say, so an UNATTRIBUTED review and a CORRECTLY attributed one are the same answer, and a wrong
 * name is indistinguishable from a right one. A rule whose only evidence is the sentence written by
 * the party it constrains is not observable. This repository has ruled against a regex standing in
 * for a decider twice (#1903, and the open-check-satisfied-by-prose family), and the second half of
 * #2127 is that ruling applied to the review object itself.
 *
 * WHAT GITHUB ACTUALLY OFFERS. A review object carries exactly these fields: `id`, `node_id`, `user`,
 * `body`, `state`, `html_url`, `pull_request_url`, `commit_id`, `submitted_at`, `author_association`,
 * `_links`. There is NO metadata field and no per-review identity beyond `user` -- so while two
 * sessions share one account, NOTHING ON THE REVIEW ITSELF CAN DISTINGUISH THEM. The record has to be
 * written beside the review, by the one door that posts it.
 *
 * THE CARRIER: A COMMIT STATUS. `POST /repos/{owner}/{repo}/statuses/{sha}` takes a `context` string
 * the poster chooses and a `target_url`. `pr-review-verdict.sh` writes one per review it posts:
 * context `review/<session>`, `target_url` the review's own `html_url`. Both are STRUCTURED fields of
 * a first-class GitHub object; neither is a sentence. `gh pr view --json statusCheckRollup` already
 * returns them in a call `work-gate.mjs` makes every tick, so reading them costs nothing new.
 *
 * ALWAYS `state: success`, WHATEVER THE VERDICT. This is an attribution record, not a gate: a
 * `failure` context turns the pull request's own checks summary red and would make a refusal look
 * like a broken build. The verdict is the REVIEW's `state`; this says only who.
 *
 * NEVER GUESSES. A commit can carry several reviews, so the join is on the review's own `html_url`
 * and nothing else. No matching status, or two statuses naming different sessions for one review,
 * both return `null` -- the same `null` this file exists to make rarer, but an HONEST one that a
 * caller can see, rather than a name inferred from the only status that happened to be there.
 */

/** A commit status whose context starts with this is a review attribution; nothing else is. */
export const ATTRIBUTION_CONTEXT_PREFIX = "review/";

/** The three answers `parityOfReview` can give. `unobservable` is a real answer, never a pass. */
export const PARITY = Object.freeze({
  correct: "correct",
  violation: "violation",
  unobservable: "unobservable",
});

/**
 * The context string the door must write for `session`. ONE SPELLING, EXPORTED, because the writer is
 * a shell script and the reader is this file: the only thing that can keep them in step is a test that
 * reads the script and compares it against this function (`review-attribution.test.ts`).
 * @param {string} session
 */
export function attributionContext(session) {
  return `${ATTRIBUTION_CONTEXT_PREFIX}${session}`;
}

/**
 * The reviewing session the parity rule gives a pull request: ODD is `reviewer`'s, EVEN is
 * `reviewer-2`'s (`.claude/rules/agent-practices.md`, "The author of a draft prompts its parity
 * reviewer").
 *
 * MOVED HERE FROM `work-gate.mjs`, which spelled it inline, so that the rule and the check on the rule
 * read the same arithmetic. A detector with its own copy of the parity would agree with a router that
 * had drifted.
 * @param {number | string} prNumber
 * @returns {string}
 */
export function parityOwner(prNumber) {
  return Number(prNumber) % 2 === 1 ? "reviewer" : "reviewer-2";
}

/**
 * REST spells it `target_url`, GraphQL `targetUrl`, and the same status arrives through both: the gate
 * reads `statusCheckRollup` (GraphQL) while a one-off check reads `commits/{sha}/statuses` (REST).
 * Accepting both here is the same choice `NO_VERDICT` made for its two cases in `work-gate.mjs`.
 * @param {any} status
 */
const targetUrlOf = (status) => String(status?.target_url ?? status?.targetUrl ?? "");

/** @param {any} review */
const reviewUrlOf = (review) => String(review?.html_url ?? review?.htmlUrl ?? "");

/**
 * The session a commit status attributes a review to, or `null` when it is not an attribution at all.
 *
 * AN UNKNOWN NAME IS STILL RETURNED, never filtered against a list of known sessions: a status naming
 * a session this file has not heard of is a fact about who reviewed, and a violation is "not the
 * parity owner" rather than "not on the roster". Filtering here would turn a new reviewer instance
 * into silence, which is the failure this whole file is about.
 * @param {any} status
 * @returns {string | null}
 */
export function attributedSession(status) {
  const context = String(status?.context ?? "");
  if (!context.startsWith(ATTRIBUTION_CONTEXT_PREFIX)) return null;
  const session = context.slice(ATTRIBUTION_CONTEXT_PREFIX.length);
  return session === "" ? null : session;
}

/**
 * The distinct sessions these statuses attribute, in first-seen order, with the non-attributions gone.
 * @param {any[]} statuses
 * @returns {string[]}
 */
function sessionsNamedBy(statuses) {
  /** @type {string[]} */
  const named = [];
  for (const status of statuses) {
    const session = attributedSession(status);
    if (session !== null && !named.includes(session)) named.push(session);
  }
  return named;
}

/**
 * WHICH SESSION POSTED THIS REVIEW -- or `null` when the commit's statuses do not say.
 *
 * `user.login` is never consulted, and could not help if it were: every review here carries the same
 * one. The join is the review's `html_url` against each attribution status's `target_url`.
 *
 * @param {any} review a review object (REST or GraphQL), needing only its html url
 * @param {any[] | null | undefined} statuses the commit statuses on that review's commit
 * @returns {string | null}
 */
export function reviewingSession(review, statuses) {
  const url = reviewUrlOf(review);
  if (url === "") return null;
  const named = sessionsNamedBy((statuses ?? []).filter((status) => targetUrlOf(status) === url));
  // TWO SESSIONS CLAIMING ONE REVIEW IS NOT A TIE TO BREAK. It means the record is wrong, and the
  // caller has to know that rather than be handed whichever came first.
  return named.length === 1 ? named[0] : null;
}

/**
 * Does this review obey the parity rule?
 *
 * `unobservable` IS THE THIRD ANSWER AND IT IS LOUD ON PURPOSE -- the same shape as the branch
 * protection reader's `CANNOT_TELL` (ceo's 2026-09-22 ruling): a check that cannot read the fact must
 * never report the pass. Today, before the door is installed and writing statuses, EVERY review
 * answers `unobservable`, and that is the honest reading of the state #2127 describes.
 *
 * @param {{prNumber: number | string, review: any, statuses: any[] | null | undefined}} args
 * @returns {string} one of `PARITY`
 */
export function parityOfReview({ prNumber, review, statuses }) {
  const session = reviewingSession(review, statuses);
  if (session === null) return PARITY.unobservable;
  return session === parityOwner(prNumber) ? PARITY.correct : PARITY.violation;
}

/**
 * Every session attributed on a commit that the parity rule does NOT give this pull request.
 *
 * THE QUESTION A REPORT ASKS, as distinct from the one above: `parityOfReview` answers about one
 * review, and a counter of violations wants the whole commit at once. It needs no review objects,
 * because a status naming the wrong session is already the violation.
 *
 * @param {{prNumber: number | string, statuses: any[] | null | undefined}} args
 * @returns {string[]} the offending session names, distinct, in first-seen order
 */
export function parityViolationsOnCommit({ prNumber, statuses }) {
  const owner = parityOwner(prNumber);
  return sessionsNamedBy(statuses ?? []).filter((session) => session !== owner);
}

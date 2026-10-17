/**
 * agent-org#1667: A SAME-REPOSITORY PULL REQUEST WITH A `session:` LABEL IS NOT AN OUTSIDE ONE, AND THE GATE MUST SAY SO.
 *
 * `reviewTrustOf` classes a pull request OUTSIDE unless GitHub says it is from the repository AND its author is a declared identity. A
 * session's own pull request whose author is not declared (a worker opened it under an account the host does not list) is therefore OUTSIDE,
 * and `prs.ownerRouting` withholds every follow-up it has but the review's. Its not-convinced verdict then wakes nobody, though the session
 * carries the label and the rework is its own.
 *
 * Two readers, both read only while `reviews.outsideSessionPr` is ON (`SESSION_PR_OUTSIDE_FLAG`), OFF is every order and signal as it was:
 *   - `sessionPrVerdictWakes`: the pull requests whose verdict at the current head is a not-convinced one whose ONLY finding is that no CI
 *     Acceptance run is available. `withholdOutsideFollowUps` keeps that one order, addressed to the reader (`ownerOfPr`).
 *   - `sessionPrOutsideNow`: the numbers of the classed-OUTSIDE pull requests, for `session-pr-classed-outside`, which counts each one that has
 *     been so classed for `SESSION_PR_OUTSIDE_MINUTES` (the clock is kept in the canary's memo, as `conflicting-pr-worker-idle`'s is).
 *
 * Pure: nothing here reads the host's state directory or reaches `gh`. The flag is read by the caller (`outsideSessionPrFlagOn`, in `tick.ts`).
 */
import { OUTSIDE, reviewTrustOf, type DeclaredIdentities } from "../review-trust.ts";
import { verdictAmong, verdictBearers } from "../review-verdict.ts";
import { subjectRef } from "../review-attribution.ts";
import { sessionOf } from "./vocabulary.ts";

/** agent-org#1667: the machinery flag behind both readers. Its switch is `machinery:flag`; OFF (absent, unreadable or malformed) is every order and signal as it was. */
export const SESSION_PR_OUTSIDE_FLAG = "reviews.outsideSessionPr";

/** The finding the wake rule reads: the one a reviewer writes when no CI Acceptance run was there to read. Matched case-insensitively. */
const NO_ACCEPTANCE_RUN = /no CI Acceptance run is available/i;
/** A finding is a bullet or a numbered item in the verdict body; the review's header and prose are not findings. */
const FINDING = /^\s*(?:[-*•]|\d+[.)])\s+/;

/**
 * Whether a verdict body's ONLY findings are that no CI Acceptance run is available. Every finding (bullet or numbered line) must carry the
 * phrase, and there must be at least one: a body whose only mention is in prose is NOT said to have no other findings, so it is not woken on.
 * @param body the verdict's review text, as the reviewer wrote it
 */
export function onlyNoAcceptanceRun(body: string): boolean {
  const findings = body.split("\n").filter((line) => FINDING.test(line));
  return findings.length > 0 && findings.every((line) => NO_ACCEPTANCE_RUN.test(line));
}

/**
 * The open, same-repository pull requests that carry a `session:` label and that `reviewTrustOf` classes OUTSIDE. A fork is not one (its head is
 * not in the repository), a pull request whose author is a declared identity is INSIDE, and an unlabelled one is nobody's session's.
 * @param prs the pull requests the gate reads, which are the open ones; a `state` that is not `OPEN` is dropped all the same
 * @param declared the identities the host declares
 */
export function classedOutsideSessionPrs(prs: any[], declared: DeclaredIdentities): any[] {
  return prs.filter((pr) => (pr?.state === undefined || pr.state === "OPEN")
    && pr?.isCrossRepository === false
    && sessionOf(pr) !== null
    && reviewTrustOf(pr, declared) === OUTSIDE);
}

/** The pull request's verdict body, found by the id the verdict was read from. `""` when the id is not one of its bearers (a verdict with no id reads as bodiless). */
function verdictBodyOf(pr: any, id: number | string | null): string {
  if (id === null) return "";
  return verdictBearers(pr).find((bearer) => bearer.id !== undefined && String(bearer.id) === String(id))?.body ?? "";
}

/**
 * agent-org#1667, the wake rule: the subjects (`pr-<ref>`) whose current-head verdict is NOT CONVINCED and whose only finding is that no CI
 * Acceptance run is available, on a same-repository pull request with a `session:` label that is classed OUTSIDE. Empty with the flag OFF,
 * because the caller passes nothing in. It reads the verdict at the head the pull request carries NOW, so a verdict written at an older
 * equal-patch head is not counted here; the order it would have wakes is withheld, as before.
 * @param prs the pull requests the gate reads
 * @param declared the identities the host declares
 */
export function sessionPrVerdictWakes(prs: any[], declared: DeclaredIdentities): Set<string> {
  const wakes = new Set<string>();
  for (const pr of classedOutsideSessionPrs(prs, declared)) {
    const head = String(pr.headRefOid ?? "");
    if (head === "") continue;
    const found = verdictAmong(pr, [head]);
    if (found.verdict === "not-convinced" && onlyNoAcceptanceRun(verdictBodyOf(pr, found.id))) wakes.add(`pr-${subjectRef(pr.repoKey, pr.number)}`);
  }
  return wakes;
}

/**
 * agent-org#1667, the signal's reader: the numbers of the pull requests `classedOutsideSessionPrs` names, READ ONLY WHILE THE FLAG IS ON. `null`
 * when it is OFF or the pull requests are unread, so the canary keeps its clocks and trips nothing (as `conflictingIdleNow` does).
 * @param on the flag's reading
 * @param prs the pull requests the gate reads, or `null` when they are unread
 * @param declared the identities the host declares
 */
export function sessionPrOutsideNow({ on, prs, declared }: { on: boolean; prs: any[] | null; declared: DeclaredIdentities; }): number[] | null {
  if (!on || prs === null) return null;
  return classedOutsideSessionPrs(prs, declared).map((pr) => pr.number);
}

#!/usr/bin/env node
// @ts-check
// RULE: WHEN MAY `--blocked-by=#N` RELEASE B2? -- #741.
//
// B2 (`own-pr-health-rule.mjs`) refuses a new claim while the claiming session's own open PR is still
// open -- right for a worker abandoning a broken PR, wrong for a PR that cannot go green until somebody
// ELSE's row lands (worker-capture's #722, red only on three assertions from #718's merge, none in its
// own diff). ceo ruled B2 does not hold in that case, but the tool had no path to express the ruling.
//
// THE COMMENT REQUIREMENT IS THE WHOLE DESIGN. A flag alone is an override; a flag that will not fire
// without evidence attached is a claim about the world that somebody had to measure first -- the same
// shape as `A11Y_SKIP_VERIFY_REASON`/`A11Y_RESOLVE_REASON` (the override exists, and it prints its reason
// into the log). So this checks that a qualifying comment EXISTS on the claimant's own open PR; it never
// judges whether the assertions it names really lie outside the diff -- that is a human/session's own
// measurement, and a tool that tried to re-derive it would be re-implementing the failing test's own
// semantics, wrong the first time a check failed for two reasons at once.
//
// FAILS CLOSED, THE OPPOSITE OF `own-pr-health-rule.mjs`'s OWN "fail open on a lookup failure" convention
// -- deliberately. That file's fail-open protects a session's ability to claim ANYTHING when `gh` is down;
// this is the override path itself, and an override that can be reached by a failed lookup is an override
// that fires on assertion alone, which is exactly what this row exists to prevent.
import { REPO } from "../../../../scripts/repo-identity.mjs";
import { lookup } from "../merge-guard/lookups.mjs";

/** The literal header a measurement comment must start its claim with -- a marker, not a sentence this
 * code parses for meaning, so the check stays "does the shape exist" rather than "is the claim true". */
export const MEASUREMENT_MARKER = "Blocked-by measurement:";

/**
 * Pure: `"#731"` or `"731"` -> `731`; anything else -> `null`.
 * @param {string | undefined} value
 * @returns {number | null}
 */
export function parseBlockedByFlag(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^#?(\d+)$/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Pure: does ANY of `comments` look like the measurement #741 requires -- the marker, a claim that the
 * listed assertions sit outside the diff, and at least one bulleted line naming one of them (deduplicated
 * per check name is a property of HOW the comment was written, not something this shape-check can see;
 * that is exactly the part the tool does not judge). Returns the FIRST qualifying body, or `null`.
 * @param {readonly string[]} comments
 * @returns {string | null}
 */
export function findMeasurementComment(comments) {
  for (const body of comments) {
    if (typeof body !== "string") continue;
    if (!body.includes(MEASUREMENT_MARKER)) continue;
    const lower = body.toLowerCase();
    if (!lower.includes("outside") || !lower.includes("diff")) continue;
    const hasListedAssertion = body.split("\n").some((line) => /^\s*-\s+\S/.test(line));
    if (!hasListedAssertion) continue;
    return body;
  }
  return null;
}

/**
 * @param {number} prNumber
 * @param {{ run: (args: string[]) => string }} deps
 * @returns {string[] | null}
 */
export function lookupOwnPrComments(prNumber, { run }) {
  return lookup(() => {
    const raw = run(["pr", "view", String(prNumber), "--repo", REPO, "--json", "comments"]);
    /** @type {{ comments: { body: string }[] }} */
    const parsed = JSON.parse(raw);
    return parsed.comments.map((c) => c.body);
  });
}

/**
 * @param {number} issueNumber
 * @param {{ run: (args: string[]) => string }} deps
 * @returns {string | null}
 */
export function lookupIssueOpenState(issueNumber, { run }) {
  return lookup(() => {
    const raw = run(["issue", "view", String(issueNumber), "--repo", REPO, "--json", "state"]);
    /** @type {{ state: string }} */
    const parsed = JSON.parse(raw);
    return parsed.state;
  });
}

/**
 * THE VERDICT: given the claimant's own (unhealthy, per `ownPrHealthReason`) open PR and the raw
 * `--blocked-by=` flag value, may B2 be released for this claim? Every refusal names exactly what is
 * missing, per #741's own acceptance ("refuses ... naming what the comment must contain").
 * @param {{ number: number, state: "OPEN" | "MERGED" | "CLOSED", reasons: string[] } | null} ownPr
 * @param {string} blockedByFlagValue
 * @param {{ run: (args: string[]) => string }} deps
 * @returns {{ ok: true, blockedByIssueNumber: number, ownPrNumber: number, measurementComment: string }
 *   | { ok: false, reason: string }}
 */
export function resolveBlockedByOverride(ownPr, blockedByFlagValue, { run }) {
  const blockedByIssueNumber = parseBlockedByFlag(blockedByFlagValue);
  if (blockedByIssueNumber === null) {
    return { ok: false,
      reason: `--blocked-by=${blockedByFlagValue} is not a valid issue reference -- use --blocked-by=#N` };
  }
  if (ownPr === null) {
    // #989: THE ONLY REFUSAL B2 STILL MAKES IS A ROW IN BUILD, WHICH HAS NO PR BY DEFINITION -- that is
    // what "in build" means. So this branch is now the common case rather than an edge, and naming the
    // missing PR alone would be a refusal nobody can follow: there is no PR to write the comment on, and
    // none is coming. It names the door that exists instead, which is the same one B2's own refusal names.
    return { ok: false,
      reason: "there is no PR of this session's own to attach a measurement comment to -- a row IN BUILD "
        + "has none, which is what puts it in build. `--blocked-by` cannot excuse it: finish that row, or "
        + "`row-claim.mjs decline <n> --session=<name>` to give it back, then claim" };
  }
  const comments = lookupOwnPrComments(ownPr.number, { run });
  if (comments === null) {
    return { ok: false,
      reason: `could not read #${ownPr.number}'s comments -- refusing to override B2 without proof` };
  }
  const measurementComment = findMeasurementComment(comments);
  if (!measurementComment) {
    return { ok: false,
      reason: `#${ownPr.number} carries no measurement comment -- --blocked-by needs one on that PR `
        + `starting with "${MEASUREMENT_MARKER}", naming every failing assertion (deduplicated across `
        + "jobs, read from the newest run per check name) and stating it lies outside the PR's diff" };
  }
  const blockerState = lookupIssueOpenState(blockedByIssueNumber, { run });
  if (blockerState === null) {
    return { ok: false,
      reason: `could not confirm #${blockedByIssueNumber}'s state -- refusing to override B2 on an `
        + "unverified blocker" };
  }
  if (blockerState !== "OPEN") {
    return { ok: false,
      reason: `#${blockedByIssueNumber} is ${blockerState.toLowerCase()}, not open -- a landed blocker `
        + "is not a blocker; finish the PR instead of overriding B2" };
  }
  return { ok: true, blockedByIssueNumber, ownPrNumber: ownPr.number, measurementComment };
}

/**
 * The exception text `writeRowLabels` posts as an issue comment on the ROW being claimed, once
 * `resolveBlockedByOverride` has accepted it -- #741's own acceptance: "writes the exception into the
 * claim comment ... and names #N".
 * @param {{ blockedByIssueNumber: number, ownPrNumber: number }} accepted
 * @returns {string}
 */
export function blockedByExceptionNote({ blockedByIssueNumber, ownPrNumber }) {
  return `--blocked-by=#${blockedByIssueNumber} accepted: #${ownPrNumber} (this session's own open PR) `
    + "carries a measurement comment showing every failing assertion, deduplicated per check from the "
    + `newest run, outside its diff -- and #${blockedByIssueNumber} is confirmed open. B2 (one PR in `
    + "flight per session) is released for this claim on that basis.";
}

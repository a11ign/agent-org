// agent-org#1501: `mergeSafetyVerdict`, and the tests-first reads it composes, moved out of `merge-guard.ts` unchanged. `arm-pr` and `auto-arm-sweep` ask this
// verdict now (a11ign's `deliberateRefusals` job asked it through `--ci-gate`), and `merge-guard.ts` reaches `claim-stall.ts`, which reaches `arm-pr.ts`: importing the
// whole entry point from the arming door made a cycle that failed at load. This file imports only the rule leaves; `merge-guard.ts` re-exports every name below.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "../project-identity.ts";
import { HOME_CHECKOUT, PROJECT_DECLARATION_PATH } from "../project-config.ts";
import { SESSION_PREFIX } from "../project-vocabulary.ts";
import { testsFirstReadsOf, type TestsFirstFacts } from "../ticket-port/tests-first-reads.ts";
import { lookup } from "./lookups.ts";
import { headTipMismatchReason } from "./head-tip-rule.ts";
import { approvalHeadReasons, type ApprovalFacts } from "./approval-head-rule.ts";
import { holdersOf, HOLD_PREFIX } from "../pr-hold-state.ts";

export const EXIT = { READY: 0, REFUSED: 1, CANNOT_ASK: 2 };

// --- ROWS ARE HAIKU-READY (a11ign#5109): THE TESTS A ROW NAMES ARE THE ROW'S, NOT THE WORKER'S ----------------------------------------
//
// A row that says `Tests-first: <test file>` has its acceptance tests written BEFORE the worker starts. The claim checks the line
// names a test file (`row-claim.ts`'s `testsFirstClaimReason`); THIS is the other half: the worker's first commit lands those tests
// unchanged, and a PR that moves them afterwards is refused unless a reviewer who is not its author approves the change in so many
// words. A worker that may edit its own oracle has no oracle (Haiku 3/12 one-shot, 11/12 with a suite it could not move).
//
// BEHIND `rows.testsFirst` in `.agent-org/project.json`, ABSENT MEANING OFF, so a project that never declared it makes exactly the
// calls it always made. The facts come from REST only -- the required gate answers through a GraphQL outage (see `ciGateFacts`) -- so
// the rows a PR closes are read from its own `Closes` line, which `pr:open` and CI already refuse a PR for omitting.

/** The review-body line that lets a PR move its named tests. Explicit on purpose: an ordinary approval says nothing about the tests. */
const TESTS_FIRST_APPROVAL = /^\s*Tests-first:\s*changes?\s+approved\b/im;
const TESTS_FIRST_INLINE = /^\s*(?:\*\*|__)?Tests-first:(?:\*\*|__)?\s*(.*)$/i;
const TESTS_FIRST_HEADING = /^\s*#{1,6}\s*Tests-first\b(?::\s*(.*))?.*$/i;
const MARKDOWN_HEADING = /^\s*#{1,6}\s/;
const PATH_SHAPE = /^[\w@.+~-]+(?:\/[\w@.+~-]+)*\.\w+$/;
const TEST_NAMED = /(^|[._-])(test|tests|spec)([._-]|$)/i;
const TEST_DIRECTORY = /(^|\/)(tests?|__tests__)\//;
const CLOSING_LIST = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+((?:[\w.-]+\/[\w.-]+)?#\d+(?:\s*,\s*(?:[\w.-]+\/[\w.-]+)?#\d+)*)/gi;

export type { TestsFirstFacts };

function testFilePath(token: string): string | null {
  const bare = token.replace(/^[-*>\s`'"(]+|[`'",;.)]+$/g, "").replace(/^[a-z0-9][\w-]*:(?=[^/])/i, "");
  if (!PATH_SHAPE.test(bare)) return null;
  const base = bare.slice(bare.lastIndexOf("/") + 1);
  return TEST_NAMED.test(base) || TEST_DIRECTORY.test(bare) ? bare : null;
}

function testsFirstValue(body: string): string | null {
  const lines = body.split(/\r\n|\r|\n/);
  for (const [index, line] of lines.entries()) {
    const found = TESTS_FIRST_HEADING.exec(line) ?? TESTS_FIRST_INLINE.exec(line);
    if (!found) continue;
    const inline = (found[1] ?? "").trim();
    if (inline.length > 0) return inline;
    const rest: string[] = [];
    for (const later of lines.slice(index + 1)) {
      if (MARKDOWN_HEADING.test(later)) break;
      rest.push(later);
    }
    return rest.join("\n");
  }
  return null;
}

/**
 * What a row's body says about `Tests-first:`. `marked` is whether it says it at all -- an UNMARKED row (decomposition,
 * investigation, fleet) is exempt by saying nothing -- and `paths` the test files it names, `[]` for a mark that names none.
 */
export function testsFirstOf(body: string): { marked: boolean; paths: string[]; } {
  const value = testsFirstValue(body);
  if (value === null) return { marked: false, paths: [] };
  const paths = value.split(/[\s,;]+/).map(testFilePath).filter((path): path is string => path !== null);
  return { marked: true, paths: [...new Set(paths)] };
}

/** `rows.testsFirst` of a project declaration's TEXT: on only when exactly `true`, so absent, unreadable and mistyped are all OFF. */
export function testsFirstFlagOf(declarationText: string): boolean {
  try {
    return JSON.parse(declarationText)?.rows?.testsFirst === true;
  } catch (cause) {
    void cause; // not JSON is not a declaration that turned the flag on; the declaration reader refuses it where it matters
    return false;
  }
}

/** The flag as this checkout's declaration says it. A checkout with no declaration is a project that never declared it: OFF. */
export function readTestsFirstFlag(checkout: string = HOME_CHECKOUT): boolean {
  try {
    return testsFirstFlagOf(readFileSync(join(checkout, PROJECT_DECLARATION_PATH), "utf8"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

/** The rows a PR body closes by its `Closes` line, each with the repository it is in (a bare `#n` is `repo`'s own). */
export function closedRowsOf(prBody: string, repo: string = REPO): { number: number; repo: string; }[] {
  const seen = new Map<string, { number: number; repo: string; }>();
  for (const [, list] of prBody.matchAll(CLOSING_LIST)) {
    for (const [, named, number] of list.matchAll(/([\w.-]+\/[\w.-]+)?#(\d+)/g)) {
      seen.set(`${named ?? repo}#${number}`, { number: Number(number), repo: named ?? repo });
    }
  }
  return [...seen.values()];
}

/**
 * THE VERDICT, PURE: reasons a PR moves the tests its rows name. An approval by a reviewer who read the head silences both, because
 * what a reviewer approves is the change; a first commit that lacks the tests is the other fault and is named first.
 */
export function testsFirstEditReasons(number: number | string, facts: TestsFirstFacts): string[] {
  if (facts.approvedBy.length > 0) return [];
  const absent = facts.paths.filter((path) => !facts.firstCommitFiles.includes(path));
  const moved = facts.paths.filter((path) => !absent.includes(path) && facts.changedSinceFirst.includes(path));
  const way = "A reviewer who agrees posts an approving review whose body carries the line `Tests-first: change approved`.";
  return [
    ...absent.length > 0 ? [`TESTS-FIRST: the FIRST commit of #${number} does not carry ${absent.join(", ")}.\n`
      + "  The row named these tests so the worker starts from them, failing; they land in the first commit, unchanged.\n  " + way] : [],
    ...moved.length > 0 ? [`TESTS-FIRST: #${number} changes ${moved.join(", ")} after its first commit.\n`
      + "  The row's tests are its acceptance, and the worker may not move them.\n  " + way] : [],
  ];
}

/**
 * The facts for PR `number`, or `undefined` when there is nothing to ask (flag off, no closed row names a test) -- never `[]` for
 * that -- or `null` when a read failed, which is INCONCLUSIVE and never "the tests are where they were".
 * `repo` is the PR's own repository; each closed row is read in the repository it is in.
 */
export function lookupTestsFirstFacts(
  pr: { number: number; head: string; author: string | null; body: string | null; },
  { run, enabled = readTestsFirstFlag(), repo = REPO }: { run?: (args: string[]) => string; enabled?: boolean; repo?: string; } = {},
): TestsFirstFacts | null | undefined {
  if (!enabled) return undefined;
  const rows = closedRowsOf(pr.body ?? "", repo);
  if (rows.length === 0) return undefined;
  return lookup(() => testsFirstReadsOf({
    repo, number: pr.number, head: pr.head, author: pr.author, rows,
    pathsOf: (rowBody) => testsFirstOf(rowBody).paths, isApproval: (reviewBody) => TESTS_FIRST_APPROVAL.test(reviewBody),
  }, run));
}

/**
 * THE SUBSET OF `mergeReadiness` THAT NEVER ASKS ABOUT THIS RUN'S OWN SIBLING CHECKS — #298 (unit 1).
 *
 * `mergeReadiness`'s `checkReasons`/`stalenessReason` inspect check-run CONCLUSIONS, which is exactly
 * what makes it unsafe to run as a REQUIRED job inside the very workflow run whose own sibling jobs are
 * still in flight: a job asking "did every required context conclude" about a commit it is itself
 * currently testing reads STILL_RUNNING on every ordinary push, forever, and would block every merge
 * permanently rather than only the unsafe ones. `gate` already answers "did CI pass" by construction
 * (branch protection requires it, and it is `if: always()` over every sibling's `result`) — this answers
 * the one question `strict=false` (#277) left nobody answering that does not depend on whether CI has
 * finished: does this head match what the platform thinks it is (`head-tip-rule.ts`, #294).
 *
 * TWO RULES ARE DELIBERATELY NOT COMPOSED HERE, and both cost a live near-miss to find before they
 * shipped — `dispatcher` drove this function against the real, moving queue and measured both refusing
 * the NORMAL case. See `ancestry-rule.ts` and `claimed-row-rule.ts` for the full account of each; in
 * short, ancestry refuses almost every open PR under `strict=false`'s normal throughput, and the claimed-
 * row rule needs a `session` identity a CI job does not have and would otherwise refuse its own PR's
 * merge as "closing a stranger's row".
 *
 * **What must NOT happen is a required job refusing the normal case** — `dispatcher`'s own words — because
 * the response to an unmergeable-by-default queue is to bypass the gate, and this repository's record on
 * that is `A11Y_SKIP_VERIFY` used six times in one evening.
 *
 * A HOLD IS NOW ENFORCED HERE, AND UNTIL 2026-09-09 IT WAS ENFORCED NOWHERE THAT COULD STOP A MERGE.
 *
 * `pr-hold` disarms auto-merge when it takes a hold, and `armabilityOf` stops anything re-arming — so the
 * hold worked, at ARM time. A hold placed on a PR that was ALREADY ARMED stopped nothing: GitHub's
 * auto-merge consults no label, and `gate` — the only required context — read head-vs-tip and nothing
 * else. Measured: eleven of the twelve PRs one session labelled on 2026-09-09 merged, labelled, armed.
 * #645 called that "a label that stops nothing"; it was the observed behaviour rather than a hypothesis.
 *
 * This is deliberately NOT the two rules below it. Ancestry and the claimed-row rule were both measured
 * refusing the NORMAL case from CI. A hold cannot: the normal case is a PR with no `hold:` label, and the
 * refusal is only ever the state somebody asked for by hand.
 *
 * @param {{pr: {headRefOid: string, number?: number, state?: string}, branchTip: string | null,
 *   prLabels?: string[] | null}} facts
 * @returns {{code: number, reasons: string[]}}
 */
export function mergeSafetyVerdict({ pr, branchTip, prLabels = [], approvals, testsFirst }: {
        pr: { headRefOid: string; number?: number; state?: string; }; branchTip: string | null;
        prLabels?: string[] | null; approvals?: ApprovalFacts | null; testsFirst?: TestsFirstFacts | null;
    }): { code: number; reasons: string[]; } {
  if (branchTip === null) {
    return { code: EXIT.CANNOT_ASK, reasons: [
      `CANNOT SAY whether #${pr.headRefOid.slice(0, 10)} is safe to auto-arm: could not read the branch's `
      + "real tip (`git ls-remote`, #294).\n  This is INCONCLUSIVE, not clear.",
    ] };
  }
  // UNREADABLE REFUSES, AND SAYS SO IN ITS OWN WORDS. "Could not read the labels" and "this PR is held"
  // are different facts needing different actions -- one sends a reader to the API, the other to the
  // holder -- and printing the same sentence for both is how a reader learns to ignore it.
  if (prLabels === null) {
    return { code: EXIT.CANNOT_ASK, reasons: [
      `CANNOT SAY whether #${pr.number ?? "?"} is held: its labels could not be read.\n`
      + "  This is INCONCLUSIVE, not unheld. Nobody looked, and a merge that happens when nothing looked "
      + "is what this tool exists to prevent.",
    ] };
  }
  // ONLY WHILE THE PR IS OPEN, and this is #690's rule reaching one field further. `labeled`/`unlabeled`
  // fire on a CLOSED PR too -- anything that strips a label after a merge re-triggers this workflow --
  // and `gate` is deliberately ungated (`if: always()`), so without this a merged PR that still carries
  // its `hold:` label would go permanently red on its own head. That red blocks nothing, lands in the
  // report of non-success checks on merged heads, and trains people to skip the section: exactly the
  // failure #690 was written to stop, and exactly how one real red sat on seven merged PRs for ninety
  // minutes. A closed PR cannot merge, so refusing it protects nothing.
  const holders = pr.state === "closed"
    ? []
    : holdersOf(prLabels).map((label) => label.slice(HOLD_PREFIX.length));
  if (holders.length > 0) {
    return { code: EXIT.REFUSED, reasons: [
      `#${pr.number ?? "?"} IS HELD by ${holders.join(", ")}, so it must not merge.\n`
      + "  A hold is a decision somebody made by hand; releasing it is `pnpm run pr:release <n> "
      + `--session=<name>\`, which puts auto-merge back.\n  The label is \`${HOLD_PREFIX}<session>\`; a `
      + `\`${SESSION_PREFIX}<name>\` label is OWNERSHIP and is deliberately not read here.`,
    ] };
  }
  // `undefined` is "the caller did not ask" (the pre-#5038 callers); `null` is "asked and could not read",
  // which is INCONCLUSIVE, never "covered".
  if (approvals === null) {
    return { code: EXIT.CANNOT_ASK, reasons: [
      `CANNOT SAY whether an approval covers #${pr.number ?? "?"}'s head: its reviews or commits could not be read.\n`
      + "  This is INCONCLUSIVE, not covered.",
    ] };
  }
  // #5109: the same convention -- `undefined` is "nothing to ask" (flag off, or no closed row names a test), `null` is "asked and could not read".
  if (testsFirst === null) {
    return { code: EXIT.CANNOT_ASK, reasons: [
      `CANNOT SAY whether #${pr.number ?? "?"} leaves its rows' named tests alone: the rows, the first commit or the reviews could not be read.\n`
      + "  This is INCONCLUSIVE, not clear.",
    ] };
  }
  const reasons = [...headTipMismatchReason(pr, branchTip),
    ...(approvals === undefined || pr.state === "closed" ? [] : approvalHeadReasons(pr.headRefOid, approvals)),
    ...(testsFirst === undefined || pr.state === "closed" ? [] : testsFirstEditReasons(pr.number ?? "?", testsFirst))];
  return { code: reasons.length > 0 ? EXIT.REFUSED : EXIT.READY, reasons };
}

// @ts-check
// module: the words of a red check (A11-300) -- the test or step a failing job's log names, and whether a worker's reply says the failure is not its change's

import type { ReadCheck } from "./pool-checks.ts";

/** The most characters of the name of a test or step in the flake log. */
const TEST_CHARS = 160;

/** The line of a failing test's log that names the test: a TAP `not ok N - name`, or a runner's `FAIL <file> > <name>`. */
const FAILED_TEST_LINE = /^(?:not ok\s+\d+\s+-\s+(.+)|(?:FAIL|\u2716|\u2717|\u00d7)\s+(.+))$/;

/** A test file's path in a log line. */
const TEST_FILE = /[\w@./-]+\.(?:test|spec)\.[cm]?[jt]sx?/;

/**
 * The test or step a failing check's log names (A11-300), for the flake log: the first failing test the log names, else the first test file it names, else the check itself, which is the step that failed. A test is named as the runner
 * names it, so the same test flaking twice is the same line. PURE.
 */
export function failedTestOf(check: ReadCheck): string {
  const named = check.lines.map((line) => FAILED_TEST_LINE.exec(line)).find((found) => found !== null);
  const test = named?.[1] ?? named?.[2] ?? check.lines.map((line) => TEST_FILE.exec(line)?.[0]).find((file) => file !== undefined) ?? check.name;
  return test.trim().slice(0, TEST_CHARS);
}

/**
 * The words of a worker's reply that say the failure is not its change's (A11-300): unrelated, not caused by or related to its change, a flake, the runner's, the infrastructure's, or already there. A reply that does not match is the worker's
 * word that the failure is its own, or no word at all; a reply that matches wrongly costs one rerun, which is made once.
 */
const UNRELATED = /\bunrelated\b|\bnot (?:caused by|related to|due to|from|a fault in|my change|mine|ours)\b|\bisn'?t (?:caused by|related to|mine|ours)\b|\bflak(?:e|y|iness)\b|\brunner'?s\b|\binfrastructure\b|\bpre-?existing\b|\balready (?:fails|failing|red|broken)\b/i;

/** A denial of those words: "not a flake", "not unrelated", "isn't the runner's". */
const DENIED = /\b(?:not|isn'?t|aren'?t|wasn'?t|n't) (?:an? |the |really |just )?(?:unrelated|flak(?:e|y|iness)|runner'?s|infrastructure|pre-?existing)\b/i;

/** Whether a worker's reply says the failure is not its change's. PURE. */
export const saysUnrelated = (text: string): boolean => UNRELATED.test(text) && !DENIED.test(text);

/** The words of a ticket's Decision that call a failure another change's, not this pull request's to fix (A11-343): "does not fix", "is not fixed by". */
const NOT_FIXED_HERE = /\bdo(?:es)?(?:n'?t| not) fix\b|\bnot fixed by\b|\bwill not be fixed\b|\bis fixed (?:by|in) (?!this)/i;

/** Whether a line of the ticket's Decisions calls the check `name` unrelated to the change (A11-343): it names the check, and says so in the words of {@link saysUnrelated} or "does not fix". PURE. */
export function callsUnrelated(line: string, name: string): boolean {
  const named = new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
  return named.test(line) && (saysUnrelated(line) || NOT_FIXED_HERE.test(line));
}

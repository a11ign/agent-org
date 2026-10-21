// A11-154: WHAT A RED JOB'S LOG SAYS, read without the project. The lines that name a failure, the text of a lost runner, a rate limit or a network error, and the colour codes and
// timestamps a log carries, moved out of `ci-failure-class.ts` unchanged (it re-exports each name it exported), because that file reads the project's declaration when it is
// imported (`project-identity.ts`, `board-snapshot-scope.ts`), and ticket mode's pool must answer a red check on a host that declares none (`serve-ticket-only-host.test.ts`).
// A LEAF: it imports nothing.

// The escape character is what an ANSI control sequence starts with; this is ECMA-48's whole CSI form (colour `ESC[31;1m`, and `ESC[?25l` too)
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/** The last lines of a job log that name its failure which a read keeps: a job's summary is at its end. */
export const LOG_LINES_KEPT = 200;

/** A line of a job log worth quoting: an error, a failed assertion or test. The log's own noise (the checkout, the cache, `##[group]`) is not. */
// No word boundaries: `AssertionError` and `TypeError` are the lines that matter, and a boundary after `error` would skip both.
export const ERROR_LINE = /error|errno|fail|assert|not ok|exception|timed? ?out|rate limit|cancell?ed|\u2716|\u2717/i;

/** Lines that match {@link ERROR_LINE} and are not the failure: a package manager's warning, a command echoed by the runner, and the exit code every failed step ends on. */
export const NOT_THE_FAILURE = /^(?:WARN\b|warn(?:ing)?\b|##\[(?:group|endgroup|command|warning)\]|##\[error\]Process completed with exit code)/i;

export const LOG_TIMESTAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z\s*/;

/** A job log without its colour codes, which `gh api` only returns when told to allow them. PURE. */
export const withoutColour = (log: string): string => log.replace(ANSI, "");

/**
 * A11-154: THE LINES OF A RED JOB'S LOG THAT NAME ITS FAILURE, as the board briefs a worker with them: colour codes and the runner's timestamps removed, the
 * lines of {@link ERROR_LINE} that are not {@link NOT_THE_FAILURE}, and the last {@link LOG_LINES_KEPT} of them, since a job's summary is at its end. PURE.
 */
export function errorLinesOfLog(log: string): string[] {
  return withoutColour(log).split("\n").map((line) => line.replace(LOG_TIMESTAMP, "").trim()).filter((line) => ERROR_LINE.test(line) && !NOT_THE_FAILURE.test(line)).slice(-LOG_LINES_KEPT);
}

const RATE_LIMIT_OR_RUNNER_LOST = /rate limit|runner has received a shutdown signal|lost communication with the server|hosted runner .* lost|runner .* (?:was|has been) (?:lost|terminated)/i;
// #1166: the lines that say a TEST failed. `##[error]` is deliberately not one: the runner's own lost-runner message is an `##[error]` line.
export const FAILING_ASSERTION = /AssertionError|^\s*(?:not ok\b|FAIL\b|\u2716|\u2717)/;

/**
 * #1166 (a11ign#928, chairman): `assertionsOnly` reads the rate-limit and lost-runner text from the FAILING ASSERTION lines when a failing assertion is named, so a passing test that prints
 * "rate limit" beside a real failure is the test's output and not the cause. Shipped ON (a11ign#5216, the switch row filed beside #1166); the explicit OFF, passed as the `flags` argument of
 * `readCiFailure` (`ci-failure-class.ts`), is today's classifier, which reads the whole log.
 */
export const CI_CLASS: { readonly assertionsOnly: boolean } = Object.freeze({ assertionsOnly: true });

/** A network failure by its signature: also what `work-gate/causes/pr-ejected.ts` reads an install step's log by (agent-org#1647). */
export const READS_OUTSIDE = /\b(ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ECONNREFUSED)\b|getaddrinfo|could not resolve host|unable to access '?https?:/i;

/**
 * IS THE RATE-LIMIT OR LOST-RUNNER TEXT THE CAUSE OF THIS RED CHECK (#1166). With `assertionsOnly` and a failing assertion named, only those lines are read: the text a passing test
 * prints is not the runner's. With none named the whole log is read, as today, which is the runner that was lost before any assertion ran.
 */
export function rateLimitOrLostRunner(log: string, { assertionsOnly }: { assertionsOnly: boolean }): boolean {
  const asserted = log.split("\n").filter((line) => FAILING_ASSERTION.test(line));
  return RATE_LIMIT_OR_RUNNER_LOST.test(assertionsOnly && asserted.length > 0 ? asserted.join("\n") : log);
}

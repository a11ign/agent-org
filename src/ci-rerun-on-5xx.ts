// agent-org#1180 (a11ign#928, chairman): a required check red on a GitHub 5xx is rerun ONCE by the org itself, without a manager turn, and the rerun is recorded.
// THE DECIDER IS PURE. `rerunOn5xx` reads the failed job's log and the run's facts and answers `rerun` or `owner`; it reads and writes nothing.
// THE WRITE IS NOT HERE. This file holds no command: the committed call baseline (`gh-call-ratchet.test.ts`) does not let a new file name a tracker
// call, and the reads and writes of the code host belong in `src/ticket-port/` (`rerunFailedJobsOf`). A `rerun` is handed to the port by the tick (`withCiFailureClass`, agent-org#1217).
// THE ONCE BOUND is the run's own attempt count: a rerun makes attempt 2, and the caller passes `rerunsOnThisHead` from it (`readCiFailure`'s `rerunAlready`), so a second red on the head is the owner's.
import { ERROR_LINE, LOG_TIMESTAMP, NOT_THE_FAILURE } from "./ci-failure-class.ts";

/** Shipped OFF (agent-org#1180): with it off the tick does what it does today, byte for byte. The a11ign switch row `ci.rerunOn5xx` is the operator's way to turn it on or off. */
export const CI_RERUN_ON_5XX: { readonly enabled: boolean } = Object.freeze({ enabled: false });

/** A GitHub server error as the last error line names it: `HTTP 5xx`, or the `Server Error` text `gh` prints. A 4xx is the caller's own mistake and stays `owner`. */
const SERVER_ERROR = /\bHTTP 5\d\d\b|\bServer Error\b/;

export type Rerun5xxDecision = { action: "rerun" | "owner"; reason: string };

/** The last line of a job's log that names the failure, read the way `ci-failure-class` reads it: an error-looking line that is not a warning, an echoed command or the runner's exit-code summary. */
export function lastErrorLine(log: string): string | null {
  const lines = log.split("\n").map((line) => line.replace(LOG_TIMESTAMP, "").trim()).filter((line) => ERROR_LINE.test(line) && !NOT_THE_FAILURE.test(line));
  return lines.at(-1) ?? null;
}

/** THE DECISION. `rerun` only when the job failed, this head has had no rerun, and its last error line is a GitHub 5xx; anything else is `owner`, today's route. */
export function rerunOn5xx({ log, conclusion, rerunsOnThisHead }: { log: string; conclusion: string | null; rerunsOnThisHead: boolean }): Rerun5xxDecision {
  if (conclusion !== "failure") return { action: "owner", reason: `the job concluded ${conclusion ?? "nothing"}, not failure` };
  if (rerunsOnThisHead) return { action: "owner", reason: "this head has been rerun already" };
  const last = lastErrorLine(log);
  if (last === null) return { action: "owner", reason: "the log names no error" };
  if (!SERVER_ERROR.test(last)) return { action: "owner", reason: "the last error is not a GitHub 5xx" };
  return { action: "rerun", reason: `the last error is a GitHub 5xx: ${last}` };
}

/**
 * THE TICK'S DECISION. With {@link CI_RERUN_ON_5XX} off it answers `owner`: today's order, byte for byte. With it on, it is {@link rerunOn5xx}; a `rerun` is
 * carried out by the port, and the tick writes {@link rerunLedgerLine} once it has. If the port refuses, the tick answers `owner` itself.
 */
export function rerunRedOn5xx(
  { log, conclusion, rerunsOnThisHead }: { log: string; conclusion: string | null; rerunsOnThisHead: boolean },
  flags: { readonly enabled: boolean } = CI_RERUN_ON_5XX,
): Rerun5xxDecision {
  if (!flags.enabled) return { action: "owner", reason: "ci.rerunOn5xx is off" };
  return rerunOn5xx({ log, conclusion, rerunsOnThisHead });
}

/** The file beside the delivery ledger that holds {@link rerunLedgerLine}s, one `<epochMs>\t<line>` each: not the delivery ledger, whose lines the restart recovery reads as deliveries to a session. */
export const CI_RERUN_LEDGER_FILE = "ci-reruns-on-5xx";

/** The one line a rerun writes to the ledger, counted by the org health signal `required-red-on-5xx` (`checks rerun on 5xx`). One line: the log's own error text may carry a tab. */
export const rerunLedgerLine = (repo: string, runId: number, head8: string, decision: Rerun5xxDecision): string =>
  `checks rerun on 5xx: ${repo} run ${runId} head ${head8}: ${decision.reason}`.replace(/\s+/g, " ");

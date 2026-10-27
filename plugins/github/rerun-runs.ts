// module: the rerun of whole workflow runs (A11-342, code host contract 1.28)
//
// A cancelled run has no failed job, so `rerunFailedChecks` (`gh run rerun <id> --failed`) leaves it alone; the board reruns it whole, asked for by the address a check reports (`FailingCheck.detailsUrl`) as `rerunFailedChecks` is.
import type { Gh } from "./gh.ts";
import { runsOf } from "./check-runs.ts";

/**
 * Reruns the WHOLE runs `detailsUrls` name (contract 1.28), `gh run rerun <id>` without `--failed`: a cancelled run has no failed job to rerun, and the cancelled job is the one that has to run again. Answers why GitHub refused (the first line it gave), or null once
 * they are rerun.
 */
export function rerunRuns(detailsUrls: readonly string[], gh: Gh): string | null {
  try {
    for (const { repo, runId } of runsOf(detailsUrls)) gh(["run", "rerun", String(runId), "-R", repo]);
    return null;
  } catch (err) {
    return String((err as Error)?.message ?? err).split("\n")[0];
  }
}

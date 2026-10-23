// module: what the board does about a red check -- the log of the job behind it, and the rerun of the jobs that failed (A11-160)
//
// Moved out of `ticket-port/ci-reads.ts` (`jobOfDetails`, `jobLogOf`; `rerunFailedJobsOf` is copied), asked for by the address a check reports (`FailingCheck.detailsUrl`), so core no longer parses a GitHub
// Actions address. An address that names no job (a commit status reports none) is one the host cannot read: `readCheckLog` answers null for it, as for a log GitHub refuses, and `rerunFailedChecks`
// leaves it out. `rerunFailedJobsOf` stays in core's `ticket-port/ci-reads.ts` while wake still calls it; it goes with that caller.
import type { Gh } from "./gh.ts";

/** The Actions job a check's details address names: its repository (`owner/name`), workflow run and job. `null` for any other address, a commit status's included. */
export function jobOfDetails(detailsUrl: string): { repo: string; runId: number; jobId: number } | null {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(detailsUrl);
  return match === null ? null : { repo: match[1], runId: Number(match[2]), jobId: Number(match[3]) };
}

/**
 * The log of the job `detailsUrl` names, its colour codes included: `gh api` exits 1 on a terminal escape sequence unless told to allow it (#767), so the caller strips them. Null when the address
 * names no job or the log could not be read, and the reason is logged.
 */
export function readCheckLog(detailsUrl: string, gh: Gh, log: (line: string) => void): string | null {
  const job = jobOfDetails(detailsUrl);
  if (job === null) return null;
  try {
    return gh(["api", `repos/${job.repo}/actions/jobs/${job.jobId}/logs`, "--allow-escape-sequences"]);
  } catch (err) {
    // The whole message: the command on its first line and GitHub's reason after it.
    log(`the log of the job at ${detailsUrl} could not be read: ${String((err as Error)?.message ?? err).split("\n").map((line) => line.trim()).filter((line) => line !== "").join(" ")}`);
    return null;
  }
}

/** The workflow runs `detailsUrls` name, each once, as (repository, run id) pairs: a run's failed jobs are rerun together. */
function runsOf(detailsUrls: readonly string[]): { repo: string; runId: number }[] {
  const seen = new Map<string, { repo: string; runId: number }>();
  for (const url of detailsUrls) {
    const job = jobOfDetails(url);
    if (job !== null) seen.set(`${job.repo}#${job.runId}`, { repo: job.repo, runId: job.runId });
  }
  return [...seen.values()];
}

/** Reruns the failed jobs of the runs `detailsUrls` name. Answers why GitHub refused (the first line it gave), or null once they are rerun. */
export function rerunFailedChecks(detailsUrls: readonly string[], gh: Gh): string | null {
  try {
    for (const { repo, runId } of runsOf(detailsUrls)) gh(["run", "rerun", String(runId), "--failed", "-R", repo]);
    return null;
  } catch (err) {
    return String((err as Error)?.message ?? err).split("\n")[0];
  }
}

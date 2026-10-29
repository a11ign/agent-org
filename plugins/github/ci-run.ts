// module: a workflow run as the board reads it -- whether it has finished, how it concluded and how many of its jobs have (contract 1.17, A11-245)
//
// Read with `gh run view <id> --repo <repo> --json status,conclusion,url,name,jobs` through the plugin's own `gh`, so this stays the one place a call to GitHub is made on ticket mode's behalf. Null is "could not ask": a refused `gh`, an answer that does not
// parse and a status this does not know are all null, never "not finished".
import type { CiRun } from "../../src/plugins/contracts/code-host.ts";
import type { AsyncGh, Gh } from "./gh.ts";

/** The fields asked of `gh run view`. */
export const CI_RUN_FIELDS = "status,conclusion,url,name,jobs";

/** The statuses GitHub reports for a run that has not started: all are read as `queued`, the board's one word for "not running yet". A status this does not know is not guessed at. */
const NOT_STARTED: readonly string[] = ["queued", "requested", "waiting", "pending"];

/** The jobs a run lists, counted: those that have completed of all of them. Null when the answer lists none yet. */
function jobsOf(jobs: unknown): CiRun["jobs"] {
  if (!Array.isArray(jobs) || jobs.length === 0) return null;
  return { done: jobs.filter((job) => job?.status === "completed").length, total: jobs.length };
}

/** The `gh` arguments that read run `runId` of `repository`. */
const runArgs = (repository: string, runId: number): string[] => ["run", "view", String(runId), "--repo", repository, "--json", CI_RUN_FIELDS];

/** The run in the text `gh` printed, or null for one this cannot judge: a status it does not know, no address or name, and a conclusion that does not agree with the status. */
function runIn(text: string): CiRun | null {
  const answer = JSON.parse(text);
  const { status, conclusion, url, name } = answer;
  const known = NOT_STARTED.includes(status) ? "queued" : status;
  if (!["queued", "in_progress", "completed"].includes(known) || typeof url !== "string" || typeof name !== "string") return null;
  const concluded = typeof conclusion === "string" && conclusion !== "" ? conclusion : null;
  if ((known === "completed") !== (concluded !== null)) return null;
  return { status: known, conclusion: concluded, url, name, jobs: jobsOf(answer.jobs) };
}

/**
 * Run `runId` of `repository` (`owner/name`), or null for "could not ask". GitHub reports an empty `conclusion` for a run that has not finished, which is read as none; a run that has completed with none is not a run this can judge, and is null.
 */
export function readCiRun(repository: string, runId: number, gh: Gh): CiRun | null {
  try {
    return runIn(gh(runArgs(repository, runId)));
  } catch (error) {
    void error; // a run the host will not say anything of is "could not ask", and the board asks again on its next poll
    return null;
  }
}

/** {@link readCiRun} without holding the process still (A11-395). */
export async function readCiRunAsync(repository: string, runId: number, gh: AsyncGh): Promise<CiRun | null> {
  try {
    return runIn(await gh(runArgs(repository, runId)));
  } catch (error) {
    void error; // a run the host will not say anything of is "could not ask", and the board asks again on its next poll
    return null;
  }
}

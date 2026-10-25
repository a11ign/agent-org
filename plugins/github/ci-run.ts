// module: a workflow run as the board reads it -- whether it has finished, how it concluded and how many of its jobs have (contract 1.17, A11-245)
//
// Read with `gh run view <id> --repo <repo> --json status,conclusion,url,name,jobs` through the plugin's own `gh`, so this stays the one place a call to GitHub is made on ticket mode's behalf. Null is "could not ask": a refused `gh`, an answer that does not
// parse and a status that is not one of the three GitHub reports are all null, never "not finished".
import type { CiRun } from "../../src/plugins/contracts/code-host.ts";
import type { Gh } from "./gh.ts";

/** The fields asked of `gh run view`. */
export const CI_RUN_FIELDS = "status,conclusion,url,name,jobs";

const STATUSES: readonly string[] = ["queued", "in_progress", "completed"];

/** The jobs a run lists, counted: those that have completed of all of them. Null when the answer lists none yet. */
function jobsOf(jobs: unknown): CiRun["jobs"] {
  if (!Array.isArray(jobs) || jobs.length === 0) return null;
  return { done: jobs.filter((job) => job?.status === "completed").length, total: jobs.length };
}

/**
 * Run `runId` of `repository` (`owner/name`), or null for "could not ask". GitHub reports an empty `conclusion` for a run that has not finished, which is read as none; a run that has completed with none is not a run this can judge, and is null.
 */
export function readCiRun(repository: string, runId: number, gh: Gh): CiRun | null {
  try {
    const answer = JSON.parse(gh(["run", "view", String(runId), "--repo", repository, "--json", CI_RUN_FIELDS]));
    const { status, conclusion, url, name } = answer;
    if (!STATUSES.includes(status) || typeof url !== "string" || typeof name !== "string") return null;
    const concluded = typeof conclusion === "string" && conclusion !== "" ? conclusion : null;
    if ((status === "completed") !== (concluded !== null)) return null;
    return { status, conclusion: concluded, url, name, jobs: jobsOf(answer.jobs) };
  } catch (error) {
    void error; // a run the host will not say anything of is "could not ask", and the board asks again on its next poll
    return null;
  }
}

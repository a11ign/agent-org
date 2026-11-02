// module: the rerun of whole workflow runs (A11-342, code host contract 1.28)
//
// A cancelled run has no failed job, so `rerunFailedChecks` (`gh run rerun <id> --failed`) leaves it alone; the board reruns it whole, asked for by the address a check reports (`FailingCheck.detailsUrl`) as `rerunFailedChecks` is.
import type { AsyncGh, Gh } from "./gh.ts";
import { refusalLine, runsOf } from "./check-runs.ts";

/**
 * Reruns the WHOLE runs `detailsUrls` name (contract 1.28), `gh run rerun <id>` without `--failed`: a cancelled run has no failed job to rerun, and the cancelled job is the one that has to run again. Answers why GitHub refused (the first line it gave), or null once
 * they are rerun.
 */
export function rerunRuns(detailsUrls: readonly string[], gh: Gh): string | null {
  try {
    for (const { repo, runId } of runsOf(detailsUrls)) gh(["run", "rerun", String(runId), "-R", repo]);
    return null;
  } catch (err) {
    return refusalLine(err);
  }
}

/** {@link rerunRuns} without holding the process still (A11-395): the runs are rerun one at a time, in order, and the first refusal stops the rest. */
export async function rerunRunsAsync(detailsUrls: readonly string[], gh: AsyncGh): Promise<string | null> {
  try {
    for (const { repo, runId } of runsOf(detailsUrls)) await gh(["run", "rerun", String(runId), "-R", repo]);
    return null;
  } catch (err) {
    return refusalLine(err);
  }
}

/** How many runs of one head one read of the run list holds: a head with more is not read past this, and a cancelled run it does not list reads as "cannot tell". */
const RUNS_PER_PAGE = 100;

/** The `gh` arguments that list the runs at `head` of `repo`, each as its id, workflow and status. */
const headRunsArgs = (repo: string, head: string): string[] => ["api", `repos/${repo}/actions/runs?head_sha=${encodeURIComponent(head)}&per_page=${RUNS_PER_PAGE}`, "--jq", "[.workflow_runs[] | {id, workflow_id, status}]"];

/** A run of the list `headRunsArgs` reads. */
type ListedRun = Readonly<{ id: number; workflow_id: number; status: string }>;

/** Whether `value` is a list of runs that each name an id, a workflow and a status. */
const isRunList = (value: unknown): value is readonly ListedRun[] =>
  Array.isArray(value) && value.every((run) => Number.isInteger(run?.id) && Number.isInteger(run?.workflow_id) && typeof run?.status === "string");

/** The runs listed at `head`, or null when the answer is not a list of runs. */
function parseRuns(text: string): readonly ListedRun[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRunList(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Whether a run of the workflow of any cancelled run `detailsUrls` name has not completed at `head` (contract 4.1): its status is anything but `completed`, so a run that is queued with no job yet counts, and a `gate` that `needs` other jobs and has no check run
 * until they finish is still seen. Only runs of the same workflow count. Null when a list cannot be read, or does not hold a run the address names, since the workflow of that run is then unknown, and when no address names a run.
 */
export async function runsInProgressAsync(detailsUrls: readonly string[], head: string, gh: AsyncGh): Promise<boolean | null> {
  const wanted = new Map<string, number[]>();
  for (const { repo, runId } of runsOf(detailsUrls)) wanted.set(repo, [...(wanted.get(repo) ?? []), runId]);
  if (wanted.size === 0) return null;
  let running = false;
  for (const [repo, cancelled] of wanted) {
    let listed: readonly ListedRun[] | null;
    try {
      listed = parseRuns(await gh(headRunsArgs(repo, head)));
    } catch {
      return null;
    }
    if (listed === null) return null;
    const workflows = new Set<number>();
    for (const runId of cancelled) {
      const found = listed.find(({ id }) => id === runId);
      if (found === undefined) return null;
      workflows.add(found.workflow_id);
    }
    if (listed.some(({ workflow_id, status }) => workflows.has(workflow_id) && status !== "completed")) running = true;
  }
  return running;
}

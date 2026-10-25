// module: the workflow runs on a branch and the billable facts of their jobs, as the board reads them to add up what a ticket's pushes cost in CI (contract 1.22, A11-261)
//
// Read with `gh api repos/<repository>/actions/runs?branch=<branch>` and, for each run the caller does not hold as settled, `gh api repos/<repository>/actions/runs/<id>/jobs?filter=all` through the plugin's own `gh`, so this stays
// the one place a call to GitHub is made on ticket mode's behalf. `filter=all` is the point of the jobs read: the default, `latest`, leaves out the attempts a re-run replaced, and those ran (and were billed) too.
// Null is "could not ask", as `readCiRun` has it: a refused `gh`, an answer that does not parse, and a list cut short at the page cap are all null, never "no runs".
import type { BranchCiRun } from "../../src/plugins/contracts/code-host.ts";
import type { Gh } from "./gh.ts";

/** The runs or jobs GitHub is asked for in one page: its largest. */
const PAGE_SIZE = 100;

/** The most pages read of the runs of a branch, and of the jobs of a run. A list that goes on past them is cut short, so it is no reading. */
export const MAX_PAGES = 5;

/** The statuses GitHub reports for a run that has not started: all are read as `queued`, as `readCiRun` reads them. */
const NOT_STARTED: readonly string[] = ["queued", "requested", "waiting", "pending"];

/** Every item of a paged answer, or null when a page is refused or unreadable or the list goes on past {@link MAX_PAGES} pages. `itemsOf` picks the page's items and the total the host says exist from the parsed answer. */
function readPages(gh: Gh, path: string, itemsOf: (page: any) => { items: unknown; total: unknown }): any[] | null {
  const found: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { items, total } = itemsOf(JSON.parse(gh(["api", `${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE_SIZE}&page=${page}`])));
    if (!Array.isArray(items) || !Number.isInteger(total)) return null;
    found.push(...items);
    if (found.length >= (total as number)) return found;
    // The host says more exist and gave none: a list that cannot be completed.
    if (items.length === 0) return null;
  }
  return null;
}

/** A job's time as the board reads it: null for one not yet set, undefined for one that is no time. */
const timeOrNull = (value: unknown): string | null | undefined => (value === null || value === undefined ? null : isTime(value) ? value : undefined);

/** Whether `labels` is a list of runner labels. */
const areLabels = (labels: unknown): labels is string[] => Array.isArray(labels) && labels.every((label) => typeof label === "string");

/** One job as the board bills it: its runner's labels and its times, or null for a job whose shape this does not know. */
function jobOf(job: any): BranchCiRun["jobs"][number] | null {
  const startedAt = timeOrNull(job?.started_at);
  const completedAt = timeOrNull(job?.completed_at);
  return areLabels(job?.labels) && startedAt !== undefined && completedAt !== undefined ? { labels: job.labels, startedAt, completedAt } : null;
}

/** The jobs of run `id`, every attempt included, or null when they could not be read. */
function jobsOfRun(repository: string, id: number, gh: Gh): BranchCiRun["jobs"] | null {
  const read = readPages(gh, `repos/${repository}/actions/runs/${id}/jobs?filter=all`, (page) => ({ items: page?.jobs, total: page?.total_count }));
  const jobs = read?.map(jobOf);
  return jobs === undefined || jobs.some((job) => job === null) ? null : (jobs as BranchCiRun["jobs"]);
}

/** Whether `value` is a string that reads as a time. */
const isTime = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));

/** One run of the list, without its jobs, or null for a run whose shape this does not know. */
function runOf(run: any): Omit<BranchCiRun, "jobs"> | null {
  const status = NOT_STARTED.includes(run?.status) ? "queued" : run?.status;
  const known = typeof run?.id === "number" && typeof run?.head_sha === "string" && isTime(run?.created_at);
  return known && ["queued", "in_progress", "completed"].includes(status) ? { id: run.id, headSha: run.head_sha, createdAt: run.created_at, status } : null;
}

/**
 * The workflow runs of `repository` (`owner/name`) on `branch`, newest first, each with its jobs, or null for "could not ask". Only runs whose `head_branch` is `branch` are kept: the query's filter also matches a fork's branch of that name.
 * A run in `settled` is answered with no jobs, and its jobs are not asked for.
 */
export function readBranchCi(repository: string, branch: string, settled: ReadonlySet<number>, gh: Gh): readonly BranchCiRun[] | null {
  try {
    const listed = readPages(gh, `repos/${repository}/actions/runs?branch=${encodeURIComponent(branch)}`, (page) => ({ items: page?.workflow_runs, total: page?.total_count }));
    if (listed === null) return null;
    const runs: BranchCiRun[] = [];
    for (const each of listed.filter((run) => run?.head_branch === branch)) {
      const run = runOf(each);
      if (run === null) return null;
      const jobs = settled.has(run.id) ? [] : jobsOfRun(repository, run.id, gh);
      if (jobs === null) return null;
      runs.push({ ...run, jobs });
    }
    return runs;
  } catch (error) {
    void error; // a branch the host will not say anything of is "could not ask", and the board asks again on its next sweep
    return null;
  }
}

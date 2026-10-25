// module: the merge queue's side of a pull request (contract 1.21, A11-264) -- the failing `merge_group` run behind a removal from the queue, and the label that holds a pull request from the arm bot
//
// THE REMOVALS THEMSELVES ARE READ IN `pull-feedback.ts`, in the one query the watch already makes for each pull request. These two are separate operations because they are made only when the board is about to answer a removal or a
// hold: the failure takes two REST reads, and the hold writes.
import type { QueueFailure, QueueFailureJob } from "../../src/plugins/contracts/code-host.ts";
import type { Gh } from "./gh.ts";
import { pullOf } from "./pull-feedback.ts";

/** The label the board puts on a pull request it holds back from the arm bot: every arm bot in the org skips a pull request with a label that starts `hold:` (core's `HOLD_PREFIX`). */
export const HOLD_LABEL = "hold:board";

const HOLD_DESCRIPTION = "The board put this on after the merge queue removed the pull request three times on one head; it lifts it on the next push";
const HOLD_COLOR = "d93f0b";

/** The conclusions of a run, a job and a step that are a failure: a timeout is one, and a cancelled or skipped job is not. */
const FAILED: ReadonlySet<unknown> = new Set(["failure", "timed_out"]);

/** What GitHub's REST answer for a label that is not there says. */
const NOT_THERE = /HTTP 404|Not Found|does not exist/i;

/** The most runs and jobs one read takes: a merge group runs a handful of workflows. */
const PER_PAGE = 100;

/** The first line `gh` printed that says something, with the command `execFileSync`-style messages begin with left out. */
function firstLine(err: unknown): string {
  const { stderr } = err as { stderr?: unknown };
  const text = typeof stderr === "string" && stderr.trim() !== "" ? stderr : String((err as Error)?.message ?? err);
  return text.split("\n").map((line) => line.trim()).find((line) => line !== "" && !line.startsWith("Command failed:")) ?? "GitHub refused the request";
}

/** The jobs of `run` that failed, with the first step of each that failed. */
function failedJobs(repo: string, run: { id: number }, gh: Gh): QueueFailureJob[] {
  const jobs: unknown = JSON.parse(gh(["api", `repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=${PER_PAGE}`])).jobs;
  if (!Array.isArray(jobs)) throw new Error("the jobs of a run did not answer");
  return jobs.filter((job) => FAILED.has(job?.conclusion) && typeof job.name === "string" && Number.isInteger(job.id)).map((job) => {
    const steps: { name?: unknown; conclusion?: unknown; number?: unknown }[] = Array.isArray(job.steps) ? job.steps : [];
    const failing = steps.filter((step) => FAILED.has(step.conclusion) && typeof step.name === "string").sort((a, b) => Number(a.number) - Number(b.number))[0];
    return { name: job.name, step: failing === undefined ? null : String(failing.name), detailsUrl: `https://github.com/${repo}/actions/runs/${run.id}/job/${job.id}` };
  });
}

/** Whether `runs` is a list of at least one run that names its id and its page. */
const isRunList = (runs: unknown): runs is { id: number; html_url: string; conclusion?: unknown }[] =>
  Array.isArray(runs) && runs.length > 0 && runs.every((run) => Number.isInteger(run?.id) && typeof run.html_url === "string");

/**
 * The failing `merge_group` run behind the removal of the pull request at `url` from the merge group at `groupCommit`: the commit is the `head_sha` of that group's runs (measured on a11ign/announcement-emulator#18, where each removal's commit was one run's), so the
 * run is found exactly and not by time. Every run of the group that failed is read, and the failing jobs of them all are listed under the first. Null for "could not ask": an address that is no pull request, a commit that is no commit, no run for it, a refused read and an answer of another shape.
 */
export function readQueueFailure(url: string, groupCommit: string, gh: Gh): QueueFailure | null {
  const pull = pullOf(url);
  if (pull === null || !/^[0-9a-f]{40}$/i.test(groupCommit)) return null;
  const repo = `${pull.owner}/${pull.repo}`;
  try {
    const runs: unknown = JSON.parse(gh(["api", `repos/${repo}/actions/runs?event=merge_group&head_sha=${groupCommit}&per_page=${PER_PAGE}`])).workflow_runs;
    if (!isRunList(runs)) return null;
    const failed = runs.filter((run) => FAILED.has(run.conclusion));
    const first = failed[0] ?? runs[0];
    return { runId: first.id, runUrl: first.html_url, jobs: failed.flatMap((run) => failedJobs(repo, run, gh)) };
  } catch {
    return null;
  }
}

/** The names of the labels on pull request `number` of `repo`. THROWS when the read is refused or the answer is not a list. */
function labelsOf(repo: string, number: number, gh: Gh): string[] {
  const labels: unknown = JSON.parse(gh(["api", `repos/${repo}/issues/${number}/labels?per_page=${PER_PAGE}`]));
  if (!Array.isArray(labels)) throw new Error("the labels of the pull request did not answer");
  return labels.map((label) => String(label?.name));
}

/** Takes the hold label off, or finds it already gone: a label GitHub says is not there is a label that is off. */
function liftHold(repo: string, number: number, gh: Gh): void {
  try {
    gh(["api", "-X", "DELETE", `repos/${repo}/issues/${number}/labels/${encodeURIComponent(HOLD_LABEL)}`]);
  } catch (err) {
    const { stderr } = err as { stderr?: unknown };
    if (!NOT_THERE.test(`${typeof stderr === "string" ? stderr : ""}\n${String((err as Error)?.message ?? err)}`)) throw err;
  }
}

/** Puts the hold label on, making the label first when the repository has none: `--force` leaves one that is there as it is but for its description. */
function placeHold(repo: string, number: number, gh: Gh): void {
  gh(["label", "create", HOLD_LABEL, "--force", "--description", HOLD_DESCRIPTION, "--color", HOLD_COLOR, "-R", repo]);
  gh(["api", "-X", "POST", `repos/${repo}/issues/${number}/labels`, "-f", `labels[]=${HOLD_LABEL}`]);
}

/** The repository (`owner/name`) and number of the pull request at `url`. THROWS for an address that is no pull request. */
function changeOf(url: string): { repo: string; number: number } {
  const pull = pullOf(url);
  if (pull === null) throw new Error(`${url} is not a GitHub pull request address`);
  return { repo: `${pull.owner}/${pull.repo}`, number: pull.number };
}

/** Runs `change` on the labels of the pull request at `url`, then reads them back: true when `asked` says they are as the change meant. THROWS, in GitHub's own first line, for a call GitHub refuses. */
function changedHold(url: string, change: (repo: string, number: number) => void, asked: (labels: readonly string[]) => boolean, gh: Gh): boolean {
  const { repo, number } = changeOf(url);
  try {
    change(repo, number);
    return asked(labelsOf(repo, number, gh));
  } catch (err) {
    throw new Error(firstLine(err));
  }
}

/** Puts {@link HOLD_LABEL} on the pull request at `url` and reads the labels back: true when it is on. THROWS, in GitHub's own first line, for an address that is no pull request and for a call GitHub refuses. */
export const holdPullRequest = (url: string, gh: Gh): boolean => changedHold(url, (repo, number) => placeHold(repo, number, gh), (labels) => labels.includes(HOLD_LABEL), gh);

/** Takes {@link HOLD_LABEL} off the pull request at `url` and reads the labels back: true when it is off, and when it was never on. THROWS as {@link holdPullRequest} does. */
export const releasePullRequest = (url: string, gh: Gh): boolean => changedHold(url, (repo, number) => liftHold(repo, number, gh), (labels) => !labels.includes(HOLD_LABEL), gh);

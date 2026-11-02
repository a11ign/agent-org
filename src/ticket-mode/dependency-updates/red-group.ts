// @ts-check
// module: a Dependabot group whose checks are red -- rerun once for a head, asked for when the same head is red again (A11-255)
import { errorLinesOfLog } from "../../ci-log-lines.ts";
import type { DependencyPull } from "../../plugins/contracts/code-host.ts";
import { redGroupKey } from "./classify.ts";
import { due, sayOnce, type SweepContext } from "./context.ts";
import type { TicketRequest } from "./request.ts";
import { MAX_JOBS, redGroupRequest, type FailingJob } from "./ticket-request.ts";

/** The group pull request to read: its repository, the pull request, its group, and the account the board acts as (whose feedback is not read). */
export type GroupPull = Readonly<{ repository: string; pull: DependencyPull; group: string; self: string }>;

/** Each failing check, and for the first few the lines of its log that name the failure; a log that cannot be read leaves the job named with no lines. */
async function failingJobsOf({ deps }: SweepContext, failures: readonly Readonly<{ name: string; detailsUrl: string | null }>[]): Promise<FailingJob[]> {
  const jobs: FailingJob[] = [];
  for (const [at, { name, detailsUrl }] of failures.entries()) {
    const text = at < MAX_JOBS && detailsUrl !== null ? await deps.codeHost.readCheckLog(detailsUrl) : null;
    jobs.push({ name, detailsUrl, lines: text === null ? [] : errorLinesOfLog(text) });
  }
  return jobs;
}

/**
 * A group pull request: green clears its record, red for the first time at a head is rerun once, and red again at that head is asked for (`ask`). A read that fails, or a head with a required check still pending, changes
 * nothing: "red" is a failing check with nothing required pending, so a rerun in progress is not a second red.
 */
export async function watchGroup(ctx: SweepContext, ask: (request: TicketRequest) => Promise<void>, { repository, pull, group, self }: GroupPull): Promise<void> {
  const { deps, state, commit } = ctx;
  // Read with no review comments: a dependency group is judged by its checks, and the read never reaches a card.
  const read = await deps.codeHost.readPullFeedback(pull.url, self);
  if (read === null) {
    sayOnce(ctx, `dependency updates: ${pull.url}'s checks could not be read, so the next sweep asks again`);
    return;
  }
  const pending = (read.pendingRequired ?? []).length > 0;
  const recorded = `${repository}#${pull.number}`;
  if (read.failing.length === 0) {
    if (!pending && state.reruns[recorded] !== undefined) { delete state.reruns[recorded]; commit(); }
    return;
  }
  if (pending) return;
  const head = read.head ?? pull.headSha;
  const key = redGroupKey(repository, pull.number, head);
  if (!due(state.tickets[key], deps.now())) return;
  if (state.reruns[recorded] !== head) return rerunOnce(ctx, { recorded, head, url: pull.url, failures: read.failures });
  await ask({ key, repository, request: async (team) => redGroupRequest({ team, repository, url: pull.url, headRefName: pull.headRefName, group, head, jobs: await failingJobsOf(ctx, read.failures) }) });
}

/** Rerun the failed checks of a head and record the head. A rerun the host refuses is no reason to wait for ever: the head is recorded as rerun, so the next sweep asks for the ticket, and the refusal is said. */
async function rerunOnce({ deps, state, commit }: SweepContext, { recorded, head, url, failures }: Readonly<{ recorded: string; head: string; url: string; failures: readonly Readonly<{ detailsUrl: string | null }>[] }>): Promise<void> {
  const jobs = failures.flatMap(({ detailsUrl }) => (detailsUrl === null ? [] : [detailsUrl]));
  const refused = jobs.length === 0 ? "no failed check names a job to rerun" : await deps.codeHost.rerunFailedChecks(jobs);
  if (refused !== null) deps.log(`dependency updates: the failed checks of ${url} could not be rerun (${refused}), so a second red is read as the first`);
  state.reruns[recorded] = head;
  commit();
}

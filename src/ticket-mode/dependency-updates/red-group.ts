// @ts-check
// module: a Dependabot group whose checks are red -- rerun once for a head, asked for when the same head is red again (A11-255)
import { errorLinesOfLog } from "../../ci-log-lines.ts";
import type { DependencyPull } from "../../plugins/contracts/code-host.ts";
import { redGroupKey } from "./classify.ts";
import { due, sayOnce, type AskingContext, type SweepContext } from "./context.ts";
import type { TicketRequest } from "./request.ts";
import { MAX_JOBS, redGroupRequest, type FailingJob } from "./ticket-request.ts";

/** The group pull request to read: its repository, the pull request, its group, and the account the board acts as (whose feedback is not read). */
export type GroupPull = Readonly<{ repository: string; pull: DependencyPull; group: string; self: string }>;

/** Each failing check, and for the first few the lines of its log that name the failure; a log that cannot be read leaves the job named with no lines. */
function failingJobsOf({ deps }: SweepContext, failures: readonly Readonly<{ name: string; detailsUrl: string | null }>[]): FailingJob[] {
  return failures.map(({ name, detailsUrl }, at) => {
    const text = at < MAX_JOBS && detailsUrl !== null ? deps.codeHost.readCheckLog(detailsUrl) : null;
    return { name, detailsUrl, lines: text === null ? [] : errorLinesOfLog(text) };
  });
}

/**
 * A group pull request: green clears its record, red for the first time at a head is rerun once, and red again at that head is asked for (`ask`). A read that fails, or a head with a required check still pending, changes
 * nothing: "red" is a failing check with nothing required pending, so a rerun in progress is not a second red.
 */
export function watchGroup(ctx: AskingContext, ask: (request: TicketRequest) => void, { repository, pull, group, self }: GroupPull): void {
  const { deps, state, commit } = ctx;
  const read = deps.codeHost.readPullFeedback(pull.url, self);
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
  ask({ key, repository, request: redGroupRequest({ team: ctx.team, repository, url: pull.url, headRefName: pull.headRefName, group, head, jobs: failingJobsOf(ctx, read.failures) }) });
}

/** Rerun the failed checks of a head and record the head. A rerun the host refuses is no reason to wait for ever: the head is recorded as rerun, so the next sweep asks for the ticket, and the refusal is said. */
function rerunOnce({ deps, state, commit }: SweepContext, { recorded, head, url, failures }: Readonly<{ recorded: string; head: string; url: string; failures: readonly Readonly<{ detailsUrl: string | null }>[] }>): void {
  const jobs = failures.flatMap(({ detailsUrl }) => (detailsUrl === null ? [] : [detailsUrl]));
  const refused = jobs.length === 0 ? "no failed check names a job to rerun" : deps.codeHost.rerunFailedChecks(jobs);
  if (refused !== null) deps.log(`dependency updates: the failed checks of ${url} could not be rerun (${refused}), so a second red is read as the first`);
  state.reruns[recorded] = head;
  commit();
}

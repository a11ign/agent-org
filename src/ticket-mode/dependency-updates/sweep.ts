// @ts-check
// module: the board's sweep that turns a Dependabot major, or a group that stays red, into a ticket by the writer path (A11-255)
//
// EACH TICK, for each repository the board serves, it reads the open pull requests the dependency bot opened (`openDependencyPulls`, which filters by author) and sorts each (`classifyDependencyPull`):
//  - a MAJOR is asked for once, keyed by repository, package and major (`majorKey`);
//  - a GROUP is read for its checks (`red-group.ts`). Red with nothing required pending, the first time at a head, its failed jobs are rerun once and the head is recorded; red again at that head, a ticket is asked for, keyed by
//    pull request and head (`redGroupKey`), naming each failing job and its error lines; green clears the record.
// A request is `queueWriter`, the entry point `POST /api/writer` uses: a quick writer run, so the ticket is made by the writer path and never by a worker (`request.ts`). The key is recorded `requested` BEFORE the run is queued,
// so two ticks never ask twice, and when the run ends with exactly one ticket the sweep queues that ticket as `POST /api/queue` does (`settle.ts`). A tick never overlaps another. The file is `filed.ts`'s.
import type { DependencyPull } from "../../plugins/contracts/code-host.ts";
import { classifyDependencyPull, majorKey, type MajorUpdate } from "./classify.ts";
import { due, firstLine, sayOnce, type DependencySweepDeps, type SweepContext } from "./context.ts";
import { loadState, saveState } from "./filed.ts";
import { watchGroup } from "./red-group.ts";
import { requestTicket, type TicketRequest } from "./request.ts";
import { settleRequests } from "./settle.ts";
import { DEPENDENCY_EPIC, majorRequest } from "./ticket-request.ts";

export { MAX_ATTEMPTS, RETRY_MS, type DependencySweepDeps } from "./context.ts";

/** The sweep: call it on the feedback cadence. It never throws for a read that failed; it says why and tries again next tick. */
export function dependencyUpdateSweep(deps: DependencySweepDeps): () => Promise<void> {
  const memory = { said: new Set<string>(), sequence: 0 };
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await sweepOnce(deps, memory);
    } finally {
      running = false;
    }
  };
}

async function sweepOnce(deps: DependencySweepDeps, memory: SweepContext["memory"]): Promise<void> {
  let ctx: SweepContext;
  try {
    const state = loadState(deps.statePath);
    ctx = { deps, state, commit: () => saveState(deps.statePath, state), memory };
  } catch (err) {
    sayOnce({ deps, memory }, `dependency updates: ${deps.statePath} cannot be read (${firstLine(err)}), so no ticket is asked for: fix or delete it`);
    return;
  }
  await settleRequests(ctx);
  if (deps.codeHost.openDependencyPulls === undefined) {
    sayOnce(ctx, "dependency updates: the code host cannot list the dependency bot's pull requests, so none becomes a ticket");
    return;
  }
  // Everything but asking goes on while the team is unknown: reruns, the forgetting of closed pull requests and the logs are not the team's.
  const team = await requestTeamOf(ctx);
  let full = false;
  const ask = (request: TicketRequest): void => {
    if (full || team === null) return;
    // A writer run waits for no Pause (a person just asked for it), but the sweep's has no person: while the board is paused it asks for nothing.
    if (deps.store.get().paused) sayOnce(ctx, "dependency updates: the queue is paused, so no dependency ticket is asked for until it is resumed");
    full = deps.store.get().paused || !requestTicket(ctx, request, team);
  };
  const self = (await deps.codeHost.readOwnLogin()) ?? "";
  const repositories = repositoriesOf(ctx);
  for (const repository of repositories) {
    const pulls = await deps.codeHost.openDependencyPulls(repository);
    if (pulls === null) sayOnce(ctx, `dependency updates: ${repository}'s pull requests could not be listed, so the next sweep asks again`);
    else await sweepRepository(ctx, ask, { repository, pulls, self });
  }
}

/**
 * The key of the team every request of this sweep is filed in: the team of {@link DEPENDENCY_EPIC}, the epic each dependency ticket relates to, read from the tracker once per sweep so a rename or a move follows the epic. The writer is
 * never left to infer a team (A11-267), so while the epic cannot be read, or has no team, nothing is asked for (the rest of the sweep goes on): the reason is said once, and the next sweep reads it again. Null in that case.
 */
async function requestTeamOf(ctx: SweepContext): Promise<string | null> {
  const noTeam = (why: string): null => {
    sayOnce(ctx, `dependency updates: the team of ${DEPENDENCY_EPIC} is not known (${why}), so no dependency ticket is asked for until it is`);
    return null;
  };
  try {
    const epic = await ctx.deps.source.read(DEPENDENCY_EPIC);
    if (epic === null) return noTeam(`the tracker has no such ticket`);
    return typeof epic.team === "string" && epic.team !== "" ? epic.team : noTeam("it names no team");
  } catch (err) {
    return noTeam(firstLine(err));
  }
}

/** The repositories to watch. A host that cannot name them (the reviewer gate is not loaded) is said once, and watches none. */
function repositoriesOf(ctx: SweepContext): readonly string[] {
  try {
    return ctx.deps.repositories();
  } catch (err) {
    sayOnce(ctx, `dependency updates: the repositories to watch cannot be named (${firstLine(err)}), so no dependency ticket is asked for`);
    return [];
  }
}

/** One repository's open pull requests: each is skipped, asked for as a major, or watched as a group. */
async function sweepRepository(ctx: SweepContext, ask: (request: TicketRequest) => void, { repository, pulls, self }: Readonly<{ repository: string; pulls: readonly DependencyPull[]; self: string }>): Promise<void> {
  forgetClosed(ctx, repository, pulls);
  for (const pull of pulls) {
    const update = classifyDependencyPull(pull);
    if (update.kind === "skip") sayOnce(ctx, `dependency updates: ${pull.url} is left alone: ${update.reason}`);
    else if (update.kind === "major") askMajor(ctx, ask, { repository, pull, update });
    else await watchGroup(ctx, ask, { repository, pull, group: update.group, self });
  }
}

/** The key of a major that has no entry yet, or whose failed entry is due again, is asked for. */
function askMajor({ deps, state }: SweepContext, ask: (request: TicketRequest) => void, { repository, pull, update }: Readonly<{ repository: string; pull: DependencyPull; update: MajorUpdate }>): void {
  const key = majorKey(repository, update);
  if (due(state.tickets[key], deps.now())) ask({ key, repository, request: (team) => majorRequest({ team, repository, url: pull.url, headRefName: pull.headRefName, body: pull.body, update }) });
}

/** A pull request that is no longer open forgets the head it was rerun at, so a pull request number never carries a record into another life. */
function forgetClosed({ state, commit }: SweepContext, repository: string, open: readonly DependencyPull[]): void {
  const live = new Set(open.map(({ number }) => `${repository}#${number}`));
  const gone = Object.keys(state.reruns).filter((recorded) => recorded.startsWith(`${repository}#`) && !live.has(recorded));
  for (const recorded of gone) delete state.reruns[recorded];
  if (gone.length > 0) commit();
}

// @ts-check
// module: the pool's use of the organisation's repositories -- a clone made on demand, a `wrong-repo` that names one, and the sweep that clones what the machine lacks (A11-355)
//
// A REPOSITORY OF THE ORGANISATION IS NEVER A PERSON'S CARD. A plan or a worker that names one the host has not cloned used to end on a person (`wrong-repo`, or the plan refused for a repository that is no clone). Now the board clones it
// (`org-repos.ts`), records it in the host file's `clones`, and goes on: the plan keeps its repository, and a run that ended `wrong-repo` naming one is moved there and queued again. A name outside the organisation, an archived repository, and a
// list the code host could not give are not the organisation's: the run still reads Needs you, with the worker's own words.
//
// A MOVE IS BOUNDED. A worker that names a repository, and is then sent back by the next worker, would go round for ever, one run each time, so the board moves a run at most {@link REROUTE_LIMIT} times; the next `wrong-repo` is a person's, and the log says so.
import type { HostRepository } from "../plugins/contracts/code-host.ts";
import { type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { logOf } from "./queue/run-log.ts";
import { isCapPlanner } from "./queue/queue-cap.ts";
import { repoOf } from "./board-view/pull-status-and-notes.ts";
import { type PoolContext } from "./pool-context.ts";
import { hostFilePath } from "./settings.ts";
import { isPlanning, log, messageOf } from "./pool-state.ts";
import { cloneKeyOf, ensureCloned, namedIn, readOrganisation, unclonedOf, type OrgReading } from "./org-repos.ts";

/** How much of a worker's `where` the log quotes. */
const LOGGED_WHERE_CHARS = 80;

/** The most times the board moves one run to the repository its worker named. */
export const REROUTE_LIMIT = 2;

/** The organisation's live repositories as the code host lists them now, or why it could not. Never throws. */
export function organisationOf(ctx: PoolContext): OrgReading {
  try {
    return readOrganisation(ctx.settings.clones, ctx.codeHost);
  } catch (err) {
    return { unreadable: messageOf(err).split("\n")[0] };
  }
}

/**
 * The key the host file holds `repository` under, cloned first when it holds none: one clone at a time for each repository, so a plan and a worker that name it together wait on the same clone. THROWS with the reason when it cannot be cloned. The
 * clones record is the settings' own (`settings.clones`), which this is the one writer of: every reader of the settings sees the new clone at once.
 */
export function cloneOnDemand(ctx: PoolContext, repository: HostRepository): Promise<string> {
  const { cloning, codeHost, git, settings } = ctx;
  const under = cloneKeyOf(repository, settings.clones, codeHost);
  if (under !== null) return Promise.resolve(under);
  const running = cloning.get(repository.fullName);
  if (running !== undefined) return running;
  // The host file the settings were read from: the one the pool was told, else the environment's, else the default place (`hostFilePath`).
  const made = ensureCloned(repository, { clones: settings.clones as Record<string, string>, hostFile: ctx.hostFile ?? hostFilePath(), codeHost, git })
    .then((key) => { log(`cloned ${repository.fullName} to ${settings.clones[key]}, and recorded it in the host file's clones as ${key}`); return key; })
    .finally(() => { cloning.delete(repository.fullName); });
  cloning.set(repository.fullName, made);
  return made;
}

/** How many times the board has moved the run of `entry` already: the `rerouted` events of its ticket's log. */
const movesOf = (ctx: PoolContext, entry: Entry): number => logOf(ctx.store.get(), entry.ticket.key).filter((event) => event.kind === "requeued" && event.why === "rerouted").length;

/**
 * Whether the board may move a run that ended `wrong-repo`: a worker's own work run that is still running (a finished run whose unreadable outcome was corrected has no worker to end), not a review round, a talk session or a
 * planner's.
 */
const movable = (ctx: PoolContext, entry: Entry): boolean =>
  entry.phase === "running" && entry.review === undefined && entry.talk !== true && !isPlanning(ctx, entry) && !isCapPlanner(entry) && entry.standoff?.stage !== "planner";

/**
 * The live repository of the organisation a `wrong-repo` outcome's `where` names, or null: it names none, the repository is archived or outside the organisation, or the organisation cannot be listed (said in the log). `where` is a worker's
 * sentence (`acme/corpus: the code lives there`), read by its first word. Synchronous: nothing is cloned.
 */
export function organisationRepoNamed(ctx: PoolContext, where: string): HostRepository | null {
  const organisation = organisationOf(ctx);
  if ("unreadable" in organisation) {
    log(`a wrong-repo naming ${JSON.stringify(where.slice(0, LOGGED_WHERE_CHARS))} was not moved: ${organisation.unreadable}`);
    return null;
  }
  return namedIn(where, organisation.repositories, ctx.settings.clones, ctx.codeHost);
}

/**
 * The repository the board moves `entry` to for its `wrong-repo`, or null when the run stays a person's: the run is not one {@link movable} allows, `where` names no repository of the organisation, or it names the one the run is placed in
 * already (a worker sent back where it started would go round for ever). Synchronous, so a `wrong-repo` the board will not move ends in the same pass as any other outcome.
 */
export function wrongRepoTarget(ctx: PoolContext, entry: Entry, where: string): HostRepository | null {
  if (!movable(ctx, entry)) return null;
  const named = organisationRepoNamed(ctx, where);
  if (named === null) return null;
  const held = cloneKeyOf(named, ctx.settings.clones, ctx.codeHost);
  if (held !== null && held === repoOf(entry)) return null;
  if (movesOf(ctx, entry) >= REROUTE_LIMIT) {
    log(`${entry.ticket.key} ended wrong-repo naming ${named.fullName}, but the board has moved it ${REROUTE_LIMIT} times already, so it is a person's`);
    return null;
  }
  return named;
}

/** The key of the clone of `repository`, cloned first when there is none; null, with the reason in the log, when it cannot be cloned. */
export async function cloneOrNull(ctx: PoolContext, repository: HostRepository): Promise<string | null> {
  try {
    return await cloneOnDemand(ctx, repository);
  } catch (err) {
    log(`${repository.fullName} is in the organisation but could not be cloned: ${messageOf(err).split("\n")[0]}`);
    return null;
  }
}

/**
 * How long the clone sweep believes the organisation's list (A11-377). Listing it is a `gh repo list` for each owner, synchronous as the code host's reads are, and the sweep runs every few minutes, so each sweep held the
 * board's loop for a second or more. A repository made since is cloned within this long; a plan or a worker that names one reads the list fresh.
 */
export const ORGANISATION_SWEEP_MS = 15 * 60_000;

const swept = new WeakMap<PoolContext, Readonly<{ at: number; repositories: readonly HostRepository[] }>>();

/** The organisation's list for the clone sweep: the one read within {@link ORGANISATION_SWEEP_MS}, else read now. A list that could not be read is not kept, so the next sweep asks again. */
function sweptOrganisation(ctx: PoolContext): OrgReading {
  const held = swept.get(ctx);
  if (held !== undefined && ctx.now() - held.at < ORGANISATION_SWEEP_MS) return { repositories: held.repositories };
  const read = organisationOf(ctx);
  if ("repositories" in read) swept.set(ctx, { at: ctx.now(), repositories: read.repositories });
  return read;
}

/** Clones every live repository of the organisation this machine has no clone of, one at a time, and not while another sweep is cloning. A failure is said and the rest are still tried. Resolves with how many were cloned; never rejects. */
export async function cloneMissing(ctx: PoolContext): Promise<number> {
  if (ctx.cloneSweep.busy) return 0;
  ctx.cloneSweep.busy = true;
  try {
    const organisation = sweptOrganisation(ctx);
    if ("unreadable" in organisation) {
      log(`the organisation's repositories were not cloned: ${organisation.unreadable}`);
      return 0;
    }
    let cloned = 0;
    for (const repository of unclonedOf(organisation.repositories, ctx.settings.clones, ctx.codeHost)) {
      try {
        await cloneOnDemand(ctx, repository);
        cloned++;
      } catch (err) {
        log(`${repository.fullName} could not be cloned: ${messageOf(err).split("\n")[0]}`);
      }
    }
    return cloned;
  } finally {
    ctx.cloneSweep.busy = false;
  }
}

/** The names of the organisation's live repositories this machine holds no clone of, for a planner's brief; none when the organisation cannot be listed (the brief then offers the clones alone). */
export function unclonedNames(ctx: PoolContext): readonly string[] {
  const organisation = organisationOf(ctx);
  return "unreadable" in organisation ? [] : unclonedOf(organisation.repositories, ctx.settings.clones, ctx.codeHost).map(({ name }) => name);
}

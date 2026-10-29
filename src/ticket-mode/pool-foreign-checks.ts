// @ts-check
// module: the pool's red checks that are not the run's (A11-179) -- which failing checks of a finished run's pull request fail just as much where the run's files are not: on the default branch, or on another run's pull request
//
// A RED CHECK THE RUN CANNOT MEND GETS NO FIX ROUND. A check that is red on the head of the repository's default branch, or on another open pull request of the repository whose files touch none of this run's plan
// paths, is red for a reason no diff of the run's changes (A11-127's `refusalOwners`, an old-org check outside A11-177's region, was handed to its worker round after round). "Fails identically" is read as the
// same check name failing: it is decided again on every watch, from fresh reads, so a check main has since fixed goes back to the run, or, when main reports it passing, its pull request is brought up to date with main (A11-215).
import { stackBlockersOf } from "./board-view/waits-on.ts";
import { pathsOverlap } from "./board-view/overlap-hold.ts";
import { openPulls } from "./board-view/view-types-and-filters.ts";
import { type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { log, messageOf } from "./pool-state.ts";
import { type PoolContext } from "./pool-context.ts";
import type { PullFeedback } from "../plugins/contracts/code-host.ts";

/** One finished run of a watch pass, and what the pass read of its open pull requests. */
export type PassRead = Readonly<{ entry: Entry; open: readonly Readonly<{ url: string; read: PullFeedback }>[] }>;

/**
 * What a pass knows of the checks that fail where the run cannot mend them, for the open pull request at a URL of an entry (A11-215): `names` are the checks failing on the default branch's head or on other runs' pull requests,
 * `onMain` the ones failing on the default branch's head alone, and `mainPassing` the ones that branch's head reports as passing. A check that is not failing there is not thereby passing,
 * because a pending check, a missing one and a failed read all look like that: `mainPassing` is empty when the default branch could not be read, and null when the host cannot say which checks pass (it reads no default branch, or
 * its reading has no `passing`, as a host of 1.14's has none), which is no evidence that any does.
 */
export type ForeignRedsRead = Readonly<{
  names: ReadonlySet<string>; onMain: ReadonlySet<string>; mainPassing: ReadonlySet<string> | null;
  /** The checks whose newest run on the default branch's head has not concluded, or null when the host does not say or main could not be read: a check in neither list is then taken to be running. */
  mainPending: ReadonlySet<string> | null;
  /** The default branch, or null when main was not read. */
  mainBranch: string | null;
}>;

/** The checks failing where the run cannot mend them, for the open pull request at a URL of an entry. */
export type ForeignReds = (entry: Entry, url: string) => Promise<ForeignRedsRead>;

const NOTHING: ForeignRedsRead = { names: new Set(), onMain: new Set(), mainPassing: null, mainPending: null, mainBranch: null };

/** No check is red elsewhere: what a caller that asked nothing says. */
export const NO_FOREIGN_REDS: ForeignReds = async () => NOTHING;

/** The `owner/name` a pull request's address is in, or null for any other address. PURE. */
const repositoryOf = (url: string): string | null => /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url)?.[1] ?? null;

/** What a pass read of the head of a repository's default branch: the checks failing there, and the ones it reports as passing (A11-215). */
type MainRead = Readonly<{ failing: ReadonlySet<string>; passing: ReadonlySet<string> | null; pending: ReadonlySet<string> | null; branch: string | null }>;

/**
 * The checks failing on the head of `repository`'s default branch and the ones passing there, or none of either when the code host cannot say: a host without the read, one that could not ask, and one that threw are all
 * "main is not known to be red", so the run's checks are answered as before, and none is known to be green either (A11-215): a read that failed leaves `passing` empty, a host that cannot say leaves it null. Said in the log once for the pass when the host could not ask.
 */
async function readMain(ctx: PoolContext, repository: string): Promise<MainRead> {
  const unread: MainRead = { failing: new Set(), passing: new Set(), pending: null, branch: null };
  try {
    const red = await ctx.codeHost.readDefaultBranchRed?.(repository);
    if (red === undefined) return { failing: new Set(), passing: null, pending: null, branch: null };
    if (red === null) {
      log(`the checks failing on ${repository}'s default branch could not be read, so a check there is neither known to be red nor to be green`);
      return unread;
    }
    return { failing: new Set(red.failing), passing: red.passing === undefined ? null : new Set(red.passing), pending: red.pending === undefined ? null : new Set(red.pending), branch: red.branch };
  } catch (err) {
    log(`the checks failing on ${repository}'s default branch could not be read, so a check there is neither known to be red nor to be green (${messageOf(err)})`);
    return unread;
  }
}

/** Whether a pull request in `repo` changes none of `paths`: its list of files is whole, and no file in it is under a path. A list cut short may touch one. PURE. */
const touchesNone = (read: PullFeedback, repo: string, paths: readonly string[]): boolean =>
  read.filesComplete && !read.files.some((file) => paths.some((path) => pathsOverlap(path, `${repo}:${file}`)));

/**
 * Whether two runs are sequenced on purpose, one the other's blocker: the one stacked on the other runs its checks over the other's code, so a failure of one is the other's code speaking and says nothing
 * of the first (`exempt` in `pull-status-and-notes.ts` keeps them from holding each other for the same reason). PURE.
 */
const isSequenced = (entry: Entry, other: Entry): boolean =>
  stackBlockersOf(entry).some(({ key }) => key === other.ticket.key) || stackBlockersOf(other).some(({ key }) => key === entry.ticket.key);

/**
 * The checks failing on the other open pull requests of `url`'s repository that the pass read, belonging to other runs on the board that are not its blocker or its dependent and changing none of the run's plan paths. A run whose plan declares no
 * paths has no region to compare with, and a pull request whose list of files was cut short may touch it: neither counts. PURE.
 */
function failingElsewhere(pass: readonly PassRead[], entry: Entry, url: string): ReadonlySet<string> {
  const paths = entry.paths ?? [];
  const repository = repositoryOf(url);
  if (paths.length === 0 || repository === null) return new Set();
  const names = pass.filter((other) => other.entry.ticket.key !== entry.ticket.key && !isSequenced(entry, other.entry)).flatMap((other) => other.open.flatMap(({ url: otherUrl, read }) => {
    const repo = openPulls(other.entry).find((pr) => pr.url === otherUrl)?.repo;
    return repo !== undefined && repositoryOf(otherUrl) === repository && touchesNone(read, repo, paths) ? read.failures.map(({ name }) => name) : [];
  }));
  return new Set(names);
}

/**
 * What a watch pass knows of checks that fail where a run cannot mend them: the default branch's red checks, read once for each repository in the pass, and the red checks of the other runs' pull requests
 * the pass read. {@link ForeignReds} answers for one open pull request of a run.
 */
export function foreignRedsOf(ctx: PoolContext, pass: readonly PassRead[]): ForeignReds {
  const main = new Map<string, MainRead>();
  return async (entry, url) => {
    const repository = repositoryOf(url);
    if (repository === null) return NOTHING;
    if (!main.has(repository)) main.set(repository, await readMain(ctx, repository));
    const { failing, passing, pending, branch } = main.get(repository)!;
    return { names: new Set([...failing, ...failingElsewhere(pass, entry, url)]), onMain: failing, mainPassing: passing, mainPending: pending, mainBranch: branch };
  };
}

// @ts-check
// module: the pool's red checks that are not the run's (A11-179) -- which failing checks of a finished run's pull request fail just as much where the run's files are not: on the default branch, or on another run's pull request
//
// A RED CHECK THE RUN CANNOT MEND GETS NO FIX ROUND. A check that is red on the head of the repository's default branch, or on another open pull request of the repository whose files touch none of this run's plan
// paths, is red for a reason no diff of the run's changes (A11-127's `refusalOwners`, an old-org check outside A11-177's region, was handed to its worker round after round). "Fails identically" is read as the
// same check name failing: it is decided again on every watch, from fresh reads, so a check main has since fixed goes back to the run.
import { pathsOverlap } from "./board-view/overlap-hold.ts";
import { openPulls } from "./board-view/view-types-and-filters.ts";
import { type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { log, messageOf } from "./pool-state.ts";
import { type PoolContext } from "./pool-context.ts";
import type { PullFeedback } from "../plugins/contracts/code-host.ts";

/** One finished run of a watch pass, and what the pass read of its open pull requests. */
export type PassRead = Readonly<{ entry: Entry; open: readonly Readonly<{ url: string; read: PullFeedback }>[] }>;

/** The checks failing where the run cannot mend them, for the open pull request at a URL of an entry: by name. */
export type ForeignReds = (entry: Entry, url: string) => ReadonlySet<string>;

/** No check is red elsewhere: what a caller that asked nothing says. */
export const NO_FOREIGN_REDS: ForeignReds = () => new Set();

/** The `owner/name` a pull request's address is in, or null for any other address. PURE. */
const repositoryOf = (url: string): string | null => /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url)?.[1] ?? null;

/**
 * The checks failing on the head of `repository`'s default branch, or none when the code host cannot say: a host without the read, one that could not ask, and one that threw are all "main is not known to
 * be red", so the run's checks are answered as before. Said in the log once for the pass when the host could not ask.
 */
function failingOnMain(ctx: PoolContext, repository: string): ReadonlySet<string> {
  try {
    const red = ctx.codeHost.readDefaultBranchRed?.(repository);
    if (red === undefined) return new Set();
    if (red === null) log(`the checks failing on ${repository}'s default branch could not be read, so a red check there is answered as the run's own`);
    return new Set(red?.failing ?? []);
  } catch (err) {
    log(`the checks failing on ${repository}'s default branch could not be read, so a red check there is answered as the run's own (${messageOf(err)})`);
    return new Set();
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
  (entry.blockers ?? []).some(({ key }) => key === other.ticket.key) || (other.blockers ?? []).some(({ key }) => key === entry.ticket.key);

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
  const onMain = new Map<string, ReadonlySet<string>>();
  return (entry, url) => {
    const repository = repositoryOf(url);
    if (repository === null) return new Set();
    if (!onMain.has(repository)) onMain.set(repository, failingOnMain(ctx, repository));
    return new Set([...onMain.get(repository)!, ...failingElsewhere(pass, entry, url)]);
  };
}

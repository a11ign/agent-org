// @ts-check
// module: the in-memory code host's operations for the org-health sweep readings and the retro (A11-160, step 8)
//
// THEY ACT ON THE WORLD A TEST SEEDS (`FakeRowsWorld`) and ignore the `run` their caller hands them. The rows and pull requests of the world's own repository are the world's; those of another repository a reading names
// (the declared code repositories, the teams' repositories) are `world.reports.health`, seeded as the facts they are. A repository the world holds nothing for is a refused read, never an empty one: "could not ask" is not
// "nothing is open". A refused read is also `world.failures` naming the operation, which `createFakeRows` applies to every operation.
import type { CodeHostRows, SinceRead } from "../contracts/code-host-rows.ts";
import { WindowCutShort } from "../../ticket-port/window-cut-short.ts";
import type { FakeRow, FakeRowPull, FakeRowsWorld } from "./code-host-rows.ts";

/** A job of a release run as the health reading reads it: its conclusion, and the names of its steps that failed. */
export type FakeReleaseJob = { id: number; name: string; conclusion: string | null; failedSteps?: string[] };

/** A release run of `release.yml` on `main`, as the health reading reads it. */
export type FakeReleaseRun = { id: number; event: string; status: string; conclusion: string | null; sha: string; createdAt: string; updatedAt: string; url: string };

/** A pull request of a repository other than the world's own, as the retro's merged reads read it: a pull request, the time it was last updated (absent: when it merged, else when it was created) and the commit it merged at. `files` are the paths it changes. */
export type FakeForeignPull = FakeRowPull & { updatedAt?: string; mergeCommit?: string };

/** What the health, retro and DORA readings read beyond the world's own rows and pull requests. */
export type FakeHealth = {
  /** The pull requests of repositories other than the world's own, by `owner/name`. A repository with an entry here (even an empty one) is a repository the world HOLDS; the rows of another repository are `world.foreignRows` (`holdRepository`). */
  foreignPulls: Map<string, FakeForeignPull[]>;
  /** The repositories a team reaches, by `org/team`: each repository and the level the team holds on it (`admin`, `maintain`, `push`, `triage`, `pull`, `none`). */
  teamRepositories: Map<string, { repo: string; level: string }[]>;
  /** The release workflow's runs by repository, newest first; the jobs of a run by `repo#runId`; the files of `.changeset/` by repository. */
  releaseRuns: Map<string, FakeReleaseRun[]>;
  releaseJobs: Map<string, FakeReleaseJob[]>;
  changesets: Map<string, string[]>;
};

export const emptyHealth = (): FakeHealth => ({ foreignPulls: new Map(), teamRepositories: new Map(), releaseRuns: new Map(), releaseJobs: new Map(), changesets: new Map() });

const isHome = (world: FakeRowsWorld, repo: string): boolean => ["", "{owner}/{repo}", world.repo].includes(repo);

const foreignRowsOf = (world: FakeRowsWorld, repo: string): FakeRow[] => [...world.foreignRows].filter(([key]) => key.startsWith(`${repo}#`)).map(([, row]) => row);

/** Does the world hold `repo`: is it the world's own, or has a test seeded its pull requests or rows (`holdRepository`)? A repository it holds nothing of cannot be asked about. */
const holds = (world: FakeRowsWorld, repo: string): boolean => isHome(world, repo) || world.reports.health.foreignPulls.has(repo) || foreignRowsOf(world, repo).length > 0;

/** Say the world holds `repo`, with these rows and pull requests (both may be empty: a repository with nothing open is not a repository that cannot be read). */
export function holdRepository(world: FakeRowsWorld, repo: string, { rows = [], pulls = [] }: { rows?: FakeRow[]; pulls?: FakeForeignPull[] } = {}): void {
  world.reports.health.foreignPulls.set(repo, pulls);
  for (const row of rows) world.foreignRows.set(`${repo}#${row.number}`, row);
}

/** A read refused: the error `world.failures` names for the operation, or for the operation on this repository alone (`<operation> <owner/name>`). */
function refusal(world: FakeRowsWorld, operation: string, repo: string): void {
  const refused = world.failures.get(`${operation} ${repo}`) ?? world.failures.get(operation);
  if (refused !== undefined) throw refused;
}

/** The pull requests of `repo`: the world's own, or those a test seeded for another repository. A repository the world holds nothing for is a refused read. */
function pullsOf(world: FakeRowsWorld, repo: string): FakeForeignPull[] {
  if (isHome(world, repo)) return [...world.pulls.values()];
  const held = world.reports.health.foreignPulls.get(repo);
  if (held === undefined) throw new Error(`the fake holds no pull requests of ${repo}`);
  return held;
}

/** The rows of `repo`: the world's own, or the foreign rows of that repository. A repository the world holds nothing for is a refused read. */
function rowsOf(world: FakeRowsWorld, repo: string): FakeRow[] {
  if (isHome(world, repo)) return [...world.rows.values()];
  if (!holds(world, repo)) throw new Error(`the fake holds no rows of ${repo}`);
  return foreignRowsOf(world, repo);
}

const seeded = <T>(held: T | undefined, what: string): T => {
  if (held === undefined) throw new Error(`the fake holds no ${what}`);
  return held;
};

const LEVELS = ["admin", "maintain", "push", "triage", "pull"];

type Operations = Pick<CodeHostRows, "teamRepositoriesTextOf" | "lastMergeTextOf" | "releaseRunsOf" | "releaseJobsOf" | "changesetNamesOf" | "openRowLabelsOf" | "openPullsNamingRowsOf">;

export function healthOperations(world: FakeRowsWorld): Operations {
  const health = world.reports.health;
  return {
    teamRepositoriesTextOf: ({ org, team }) => seeded(health.teamRepositories.get(`${org}/${team}`), `team ${org}/${team}`)
      .map(({ repo, level }) => [repo, ...LEVELS.map((name, at) => String(level !== "none" && at >= LEVELS.indexOf(level)))].join("\t")).map((line) => `${line}\n`).join(""),
    lastMergeTextOf: ({ repo }) => {
      const merged = pullsOf(world, repo).flatMap((pull) => (pull.merged && pull.mergedAt !== null ? [pull.mergedAt] : [])).sort();
      return `${merged.at(-1) ?? "null"}\n`;
    },
    releaseRunsOf: ({ repo }) => structuredClone(seeded(health.releaseRuns.get(repo), `release runs of ${repo}`)),
    releaseJobsOf: ({ repo, runId, shape }) => {
      const jobs = seeded(health.releaseJobs.get(`${repo}#${runId}`), `jobs of run ${repo}#${runId}`);
      return shape === "named" ? jobs.map(({ name, conclusion }) => ({ name, conclusion })) : jobs.filter((job) => job.conclusion === "failure").map(({ id, name, failedSteps }) => ({ id, name, steps: failedSteps ?? [] }));
    },
    changesetNamesOf: ({ repo }) => [...seeded(health.changesets.get(repo), `.changeset/ of ${repo}`)],
    openRowLabelsOf: ({ repo, limit }) => (refusal(world, "openRowLabelsOf", repo), rowsOf(world, repo)).filter((row) => row.state === "OPEN").sort((a, b) => b.number - a.number).slice(0, limit).map((row) => ({ number: row.number, labels: row.labels.map((name) => ({ name })) })),
    openPullsNamingRowsOf: ({ repo, limit }) => (refusal(world, "openPullsNamingRowsOf", repo), pullsOf(world, repo)).filter((pull) => !pull.merged && pull.closedAt == null).sort((a, b) => b.number - a.number).slice(0, limit)
      .map((pull) => ({ number: pull.number, body: pull.body, headRefName: pull.headRefName, labels: pull.labels.map((name) => ({ name })) })),
  };
}

// --- the reads of other repositories the retro makes through operations that belong to the rows' list reads (A11-160, step 8) -----------------------------------------------------------------------------------

/**
 * ASK THE WORLD FOR WHAT THE RETRO READS OF EVERY DECLARED REPOSITORY. `readRowsByLabel`, `readRowsSince` and `readMergedPullRequests` live with the rows' list reads (`code-host-rows.ts`) and answer the world's OWN rows and pull
 * requests whatever repository they are asked of. The retro asks them of several repositories (every declared tracker and code repository), so a test of it wraps the fake once with this: a read of the world's own repository is
 * answered as before; a read of another repository is answered from what `holdRepository` gave it (its rows with their comments, its pull requests with the time they were updated, their files and their merge commit), or
 * refused when the world holds nothing of it. A refusal is `world.failures` naming the operation, or the operation and the repository (`readRowsSince o/other`). A window read follows the real one's pages: more than
 * `maxPages` (ten) pages of a hundred rows, none of them older than `since`, is a window cut short.
 */
export function withRepositoryReads<H extends { rows?: CodeHostRows; rowsWorld: FakeRowsWorld }>(host: H): H {
  const world = host.rowsWorld;
  const rows = host.rows!;
  const [byLabel, since, merged] = [rows.readRowsByLabel, rows.readRowsSince, rows.readMergedPullRequests];
  const PAGE = rows.sincePageSize;
  const DEFAULT_PAGES = 10;
  const labelsOf = (names: string[]) => ({ nodes: names.map((name) => ({ name })) });
  const rowNode = (row: FakeRow) => ({ number: row.number, title: row.title, body: row.body, state: row.state, createdAt: row.createdAt, updatedAt: row.updatedAt ?? row.closedAt ?? row.createdAt, closedAt: row.closedAt,
    labels: labelsOf(row.labels), blockedBy: { nodes: row.blockedBy.map((number) => ({ number })) }, comments: { nodes: row.comments.map((c) => ({ body: c.body, createdAt: c.createdAt, ...(c.author === undefined ? {} : { author: { login: c.author } }) })) } });
  const pullNode = (pull: FakeForeignPull) => ({ number: pull.number, title: pull.title ?? "", body: pull.body, headRefName: pull.headRefName, baseRefName: pull.baseRefName ?? "main", isDraft: pull.isDraft, labels: labelsOf(pull.labels),
    state: pull.merged ? "MERGED" : pull.closedAt != null ? "CLOSED" : "OPEN", createdAt: pull.createdAt, updatedAt: pull.updatedAt ?? pull.mergedAt ?? pull.closedAt ?? pull.createdAt, mergedAt: pull.mergedAt,
    mergeCommit: pull.mergeCommit === undefined ? null : { oid: pull.mergeCommit }, files: { nodes: (pull.files ?? []).map((path) => ({ path })) } });

  rows.readRowsByLabel = (ask) => {
    const repo = ask.repo ?? "";
    if (isHome(world, repo)) return byLabel(ask);
    refusal(world, "readRowsByLabel", repo);
    if (!holds(world, repo)) throw new Error(`the fake holds no rows of ${repo}`);
    const found = foreignRowsOf(world, repo).filter((row) => row.state === ask.state && row.labels.includes(ask.label)).sort((a, b) => b.number - a.number);
    return (ask.newest === undefined ? found : found.slice(0, ask.newest)).map(rowNode);
  };
  const window = (ask: SinceRead): any[] => {
    const field = ask.orderBy === "CREATED_AT" ? "createdAt" : "updatedAt";
    const nodes: any[] = ask.kind === "issues" ? foreignRowsOf(world, ask.repo).filter((row) => ask.states.includes(row.state)).map(rowNode)
      : pullsOf(world, ask.repo).filter((pull) => ask.states.includes(pull.merged ? "MERGED" : pull.closedAt != null ? "CLOSED" : "OPEN")).map(pullNode);
    const newestFirst = nodes.sort((a, b) => Date.parse(b[field]) - Date.parse(a[field]));
    if (ask.newest !== undefined) return newestFirst.slice(0, ask.newest);
    const from = Date.parse(String(ask.since));
    const limit = (ask.maxPages ?? DEFAULT_PAGES) * PAGE;
    if (newestFirst.length > limit && newestFirst.slice(0, limit).every((node) => Date.parse(node[field]) >= from)) {
      throw new WindowCutShort(`the ${ask.kind} of ${ask.repo} since ${ask.since}: more than ${limit} rows, so the window may be cut short`);
    }
    return newestFirst.filter((node) => Date.parse(node[field]) >= from);
  };
  rows.readRowsSince = (request) => {
    const { repo } = request.ask;
    if (isHome(world, repo)) return since(request);
    refusal(world, "readRowsSince", repo);
    return window(request.ask);
  };
  rows.readMergedPullRequests = (request) => {
    if (isHome(world, request.repo)) return merged(request);
    refusal(world, "readMergedPullRequests", request.repo);
    const states = ["MERGED"] as const;
    const base = (node: any) => request.base === undefined || node.baseRefName === request.base;
    const flat = (node: any) => Object.fromEntries(Object.entries(node).map(([key, value]) => [key, Array.isArray((value as { nodes?: unknown })?.nodes) ? (value as { nodes: unknown[] }).nodes : value]));
    if ("newest" in request.window) return window({ kind: "pullRequests", states, orderBy: "CREATED_AT", repo: request.repo, select: request.select, newest: request.window.newest }).filter(base).map(flat);
    const from = Date.parse(request.window.since);
    return window({ kind: "pullRequests", states, orderBy: "UPDATED_AT", repo: request.repo, select: request.select, since: request.window.since, maxPages: request.window.maxPages })
      .filter((node) => Date.parse(node.mergedAt) >= from && base(node)).map(flat);
  };
  return host;
}

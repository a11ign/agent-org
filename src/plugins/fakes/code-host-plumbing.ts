// @ts-check
// module: the in-memory code host's operations for the plumbing section (A11-160, step 9)
//
// THEY ACT ON THE WORLD A TEST SEEDS (`FakeRowsWorld`) and ignore the `run` their caller hands them. A row's labels, title and body are the world's rows; what the tool-version agreement reads of GitHub's releases and
// workflow runs, and what the review eval reads of a pull request, is `world.tail.plumbing`. A read the world holds nothing for is REFUSED (it throws, naming what it was asked), as GitHub refuses a release or a run
// that does not exist. The runner that never throws starts a program, and the fake has none: the runner it hands out throws when it is run, and a test of it runs against the GitHub plugin.
import type { CiRunRead, EvalPullRead, RowsPlumbing } from "../contracts/code-host-rows-plumbing.ts";
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { FakeRow, FakeRowsWorld } from "./code-host-rows.ts";

/** What a test seeds for this section beyond the world's rows and pull requests. */
export type FakePlumbing = {
  /** When a release was published (epoch ms; `null` is a release that carries no date), by `repo@tag`; an `Error` is the read GitHub refuses. */
  releases: Map<string, number | null | Error>;
  /** The newest completed `ci.yml` run that gates `main`, by repository; `null` is a repository with none, an `Error` the read GitHub refuses. */
  ciRuns: Map<string, CiRunRead | null | Error>;
  /** A workflow run's log by run id; `""` is a run GitHub says has none (expired, or never kept), an `Error` the read GitHub refuses. */
  runLogs: Map<number, string | Error>;
  /** A pull request as the review eval reads it, by `repo#number`. */
  evalPulls: Map<string, EvalPullRead>;
};

export const emptyPlumbing = (): FakePlumbing => ({ releases: new Map(), ciRuns: new Map(), runLogs: new Map(), evalPulls: new Map() });

/** The probe the fake's callers send to read the GraphQL pool: nothing runs it, so it only has to be told from the core pool's. */
const FAKE_GRAPHQL_POOL_PROBE: readonly string[] = Object.freeze(["fake", "graphql-pool"]);

const noProgram = (what: string) => (): never => {
  throw new Error(`the fake code host has no gh: ${what} runs against the GitHub plugin`);
};

const rowOf = (world: FakeRowsWorld, repo: string, number: number): FakeRow => {
  const row = repo === world.repo ? world.rows.get(number) : world.foreignRows.get(`${repo}#${number}`);
  if (row === undefined) throw new Error(`the fake holds no row ${repo}#${number}`);
  return row;
};

/** The seeded answer, or the refusal a seeded `Error` is, or the refusal of a read the world holds nothing for. */
function seeded<Value>(kind: string, held: Value | Error | undefined, name: string): Value {
  if (held instanceof Error) throw held;
  if (held === undefined) throw new Error(`the fake holds no ${kind} for ${name}`);
  return held;
}

/** Records the read in the world's calls, then makes it. */
const noted = <T>(world: FakeRowsWorld, line: string, read: () => T): T => {
  world.calls.push(line);
  return read();
};

export function plumbingOperations(world: FakeRowsWorld): Pick<CodeHostRows, keyof RowsPlumbing> {
  const held = () => world.tail.plumbing;
  return {
    releasePublishedAtOf: ({ repo, tag }) => noted(world, `releasePublishedAtOf ${repo}@${tag}`, () => seeded("release", held().releases.get(`${repo}@${tag}`), `${repo}@${tag}`)),
    gatingCiRunOf: ({ repo }) => noted(world, `gatingCiRunOf ${repo}`, () => seeded("workflow runs", held().ciRuns.get(repo), repo)),
    ciRunLogOf: ({ repo, id }) => noted(world, `ciRunLogOf ${repo} ${id}`, () => seeded("run log", held().runLogs.get(id), `run ${id}`)),
    restLabelNamesOf: ({ repo, number }) => noted(world, `restLabelNamesOf ${repo}#${number}`, () => [...rowOf(world, repo, number).labels]),
    graphqlPoolProbeArgs: () => FAKE_GRAPHQL_POOL_PROBE,
    answeringRunnerWith: () => noProgram("a runner of the code host's program that never throws"),
    pullForReviewEvalOf: ({ repo, number }) => noted(world, `pullForReviewEvalOf ${repo}#${number}`, () => ({ ...seeded("pull request", held().evalPulls.get(`${repo}#${number}`), `${repo}#${number}`) })),
    rowForReviewEvalOf: ({ repo, number }) => noted(world, `rowForReviewEvalOf ${repo}#${number}`, () => {
      const { title, body } = rowOf(world, repo, number);
      return { title, body };
    }),
  };
}

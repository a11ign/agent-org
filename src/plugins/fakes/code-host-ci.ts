// @ts-check
// module: the in-memory code host's reads of a change's CI and of a row's state (A11-160, step 5)
//
// WHAT THE CROSS-REPO-RED VERDICT ASKS, modelled over the world a test seeds: the check runs of a head commit, the runs of a workflow on `main` for an event filter, the jobs and the failed log of a run,
// and the state of a row. Each read is a map the test fills; an entry that is an `Error` is a read that throws it (a refused read of just that one thing), an absent run, log or check list answers
// the empty one and an absent job list or row throws (GitHub's own "not found"). The shapes are the contract's (`CiJob`), not GitHub's JSON.
import type { BranchCiRun, CodeHost } from "../contracts/code-host.ts";
import type { CiJob, CodeHostRows } from "../contracts/code-host-rows.ts";
import type { FakeRowsWorld } from "./code-host-rows.ts";

/** The CI facts of the world. */
export type FakeCi = {
  /** The check runs of a head commit, and how many exist (`total`, more than `checks.length` when a page was not read). */
  checks: Map<string, { checks: CiJob[]; total?: number } | Error>;
  /** The runs of a workflow on `main`, by `<workflow>|<event filter>` (`ci.yml|event=push`), newest first. */
  runs: Map<string, any[] | Error>;
  /** The jobs of a workflow run, and its failed log, by run id. */
  jobs: Map<string, CiJob[] | Error>;
  logs: Map<string, string | Error>;
  /** The state of a row (`OPEN` or `CLOSED`) by `<owner/name>#<number>`: a row neither here nor in the world does not exist. */
  rowStates: Map<string, string | Error>;
};

export const emptyCi = (): FakeCi => ({ checks: new Map(), runs: new Map(), jobs: new Map(), logs: new Map(), rowStates: new Map() });

const answer = <T>(found: T | Error): T => {
  if (found instanceof Error) throw found;
  return found;
};

/** The reads of CI and of a row's state, over the world. */
export function ciOperations(world: FakeRowsWorld): Pick<CodeHostRows, "headOfChange" | "checkRunsOfHead" | "workflowRunsOf" | "jobsOfRun" | "failedLogOfRun" | "stateOfRow"> {
  const { ci } = world;
  return {
    headOfChange: (_repo, number) => {
      const pull = world.pulls.get(Number(number));
      if (pull === undefined) throw new Error(`the fake holds no pull request #${number}`);
      return pull.headRefOid ?? `head-${pull.number}`;
    },
    checkRunsOfHead: (_repo, head) => {
      const found = ci.checks.get(head);
      if (found === undefined) return { checks: [], total: 0 };
      const { checks, total } = answer(found);
      return { checks: [...checks], total: total ?? checks.length };
    },
    workflowRunsOf: (_repo, workflow, eventFilter) => [...answer(ci.runs.get(`${workflow}|${eventFilter}`) ?? [])],
    jobsOfRun: (_repo, runId) => {
      const found = ci.jobs.get(String(runId));
      if (found === undefined) throw new Error(`the API returned no job list for run ${runId}`);
      return [...answer(found)];
    },
    failedLogOfRun: (_repo, runId) => answer(ci.logs.get(String(runId)) ?? ""),
    stateOfRow: (repo, number) => {
      const key = `${repo}#${number}`;
      const found = ci.rowStates.get(key);
      if (found !== undefined) return String(answer(found)).toUpperCase();
      const row = repo === world.repo ? world.rows.get(Number(number)) : world.foreignRows.get(key);
      if (row === undefined) throw new Error(`GraphQL: Could not resolve to an issue or pull request with the number of ${number}. (repository.issue)`);
      return row.state;
    },
  };
}

/**
 * What the fake holds of the workflow runs on a branch (contract 1.22), and what a test sets: the runs of a branch by `<owner/name>@<branch>`, newest first. A branch the fake was given none for cannot be asked about, and is null. `asked` lists each read,
 * with the runs it was told were settled, in order.
 */
export type FakeBranchCi = { runs: Map<string, readonly BranchCiRun[]>; asked: { repository: string; branch: string; settled: number[] }[] };

/** The key a branch's runs are seeded under. */
export const branchCiKey = (repository: string, branch: string): string => `${repository}@${branch}`;

/** The read of a branch's workflow runs over what a test seeded: a run the caller holds as settled comes back with no jobs, as the contract says. */
export function branchCiOf(state: FakeBranchCi, calls: string[]): Pick<CodeHost, "readBranchCi"> {
  return {
    async readBranchCi(repository, branch, settled) {
      calls.push(`readBranchCi ${repository} ${branch}`);
      state.asked.push({ repository, branch, settled: [...settled] });
      const runs = state.runs.get(branchCiKey(repository, branch));
      return runs === undefined ? null : runs.map((run) => (settled.has(run.id) ? { ...run, jobs: [] } : run));
    },
  };
}

// @ts-check
// module: the in-memory code host's operations for the queue section (A11-160, step 9)
//
// THEY ACT ON THE WORLD A TEST SEEDS (`FakeRowsWorld`) and ignore the `run` their caller hands them. The open pull requests, the merge queue's entries and the trunk workflow's runs on `main` are the world's own; what the
// queue table, the trunk sweep and the red-trunk reading read beyond them (the tip of `main` and its check runs, the runs of a workflow by event, the jobs' annotations, the pull request a commit came from, the API budget) is
// `world.tail.queue`. A seeded `Error` is a read that throws it (a refused read of just that one thing); a read the world was never seeded for answers what a repository with nothing to report answers, except the runs of a
// workflow, which answer GitHub's own 404 (a workflow the world was never told about does not exist). A test that wants an operation refused names it in `world.failures`.
import type { CodeHostRows, GuardCheckRun } from "../contracts/code-host-rows.ts";
import type { ApiBudgetReading, CheckRunBrief, OriginPull, RowsQueue } from "../contracts/code-host-rows-queue.ts";
import { mergeOperations } from "./code-host-merge.ts";
import type { FakeRowPull, FakeRowsWorld } from "./code-host-rows.ts";

/** What a test seeds for this section beyond the world's rows and pull requests. */
export type FakeQueue = {
  /** The sha of the tip of `main` (the sweep and the table read it); `null` is a tip that cannot be read. */
  mainSha: string | null | Error;
  /** How many check runs a commit carries, by sha (the sweep's question); a sha not here carries none. */
  checkRunTotals: Map<string, number | Error>;
  /** The check runs of a commit, by sha; a sha not here has those of the pull request whose head it is, else none. */
  checks: Map<string, readonly CheckRunBrief[] | Error>;
  /** The runs of a workflow on `main` for an event filter, by `<repo> <workflow> <event filter, or empty>`, newest first; `null` is an answer that carries no list. */
  trunkRuns: Map<string, any[] | null | Error>;
  /** The annotations of a check run, by id; one not here has none. */
  annotations: Map<string, any[] | null | Error>;
  /** The pull request GitHub associates with a commit, by sha; one not here has none. */
  originPulls: Map<string, OriginPull | null | Error>;
  /** The runs the table's trunk line lists in the checkout's repository, by workflow; one not here has no runs. */
  checkoutRuns: Map<string, any[] | null | Error>;
  /** The runs of a workflow other than `trunk.yml` on `main` (the org watch reads), by workflow; `trunk.yml` is the world's `trunkRuns`. */
  runsOnMain: Map<string, any[] | Error>;
  /** The API budget the table reads, or `null` for a pool pair that cannot be read. */
  budget: ApiBudgetReading | null;
  /** The workflows dispatched, in order; and why a dispatch is refused (or `null`), and a hook called as one is made, before it is refused or recorded. */
  dispatched: string[];
  dispatchRefusal: string | null;
  onDispatch: ((workflow: string) => void) | null;
};

export const emptyQueue = (): FakeQueue => ({ mainSha: null, checkRunTotals: new Map(), checks: new Map(), trunkRuns: new Map(), annotations: new Map(), originPulls: new Map(), checkoutRuns: new Map(), runsOnMain: new Map(),
  budget: null, dispatched: [], dispatchRefusal: null, onDispatch: null });

/** The key a workflow's runs are seeded under in {@link FakeQueue.trunkRuns}. */
export const trunkRunsKey = (repo: string, workflow: string, eventFilter: string | null): string => `${repo} ${workflow} ${eventFilter ?? ""}`;

/** What `gh` throws for a call GitHub answers 404 to, in the words `gh` prints them: the status is in the message and in `stderr`. */
export const notFound = (what: string): Error & { status: number; stderr: string } => Object.assign(new Error(`Command failed: gh api ${what}\ngh: Not Found (HTTP 404)\n`), { status: 1, stderr: "gh: Not Found (HTTP 404)\n" });

const answer = <T>(found: T | Error): T => {
  if (found instanceof Error) throw found;
  return found;
};

const isOpen = (pull: FakeRowPull): boolean => !pull.merged && pull.closedAt == null;

const openPulls = (world: FakeRowsWorld): FakeRowPull[] => [...world.pulls.values()].filter(isOpen);

/** When auto-merge was requested, as the listings carry it. */
const ENABLED_AT = "2026-01-01T00:00:00Z";

const queueEntryOf = (world: FakeRowsWorld, number: number) => {
  if (world.queue.entries instanceof Error) throw world.queue.entries;
  return world.queue.entries.find((entry) => entry.pull === number);
};

const briefOf = (run: GuardCheckRun): CheckRunBrief => ({ name: run.name, conclusion: run.conclusion, completedAt: run.completedAt });

/** The operations of the trunk, the commits and the sweep. */
function trunkOperations(world: FakeRowsWorld): Pick<CodeHostRows, "mainShaOf" | "checkRunTotalOf" | "dispatchWorkflow" | "checkoutWorkflowRunsOf" | "workflowRunsOnMain"> {
  const { queue } = world.tail;
  return {
    mainShaOf: () => {
      const sha = answer(queue.mainSha);
      if (sha === null) throw new Error("the fake holds no tip of main: seed world.tail.queue.mainSha");
      return sha;
    },
    checkRunTotalOf: ({ sha }) => answer(queue.checkRunTotals.get(sha) ?? 0),
    dispatchWorkflow: ({ repo, workflow }) => {
      world.calls.push(`dispatchWorkflow ${repo} ${workflow}`);
      queue.onDispatch?.(workflow);
      if (queue.dispatchRefusal !== null) throw new Error(queue.dispatchRefusal);
      queue.dispatched.push(workflow);
    },
    checkoutWorkflowRunsOf: ({ workflow }) => {
      const runs = answer(queue.checkoutRuns.get(workflow) ?? []);
      return runs === null ? null : [...runs];
    },
    workflowRunsOnMain: ({ workflow, perPage }) => {
      const runs = workflow === "trunk.yml" ? world.trunkRuns : answer(queue.runsOnMain.get(workflow) ?? []);
      return runs.slice(0, perPage);
    },
  };
}

/** The reads of the red-trunk reading: the runs by event, the annotations of a check run and the pull request a commit came from. */
function redTrunkOperations(world: FakeRowsWorld): Pick<CodeHostRows, "trunkRunsOf" | "annotationsOfCheckRun" | "originPullOfCommit"> {
  const { queue } = world.tail;
  return {
    trunkRunsOf: ({ repo, workflow, eventFilter }) => {
      world.calls.push(`trunkRunsOf ${repo} ${workflow} ${eventFilter ?? ""}`.trimEnd());
      const found = queue.trunkRuns.get(trunkRunsKey(repo, workflow, eventFilter));
      if (found === undefined) throw notFound(`--method GET repos/${repo}/actions/workflows/${workflow}/runs`);
      const runs = answer(found);
      return runs === null ? null : [...runs];
    },
    annotationsOfCheckRun: ({ repo, checkRunId }) => {
      world.calls.push(`annotationsOfCheckRun ${repo} ${checkRunId}`);
      const annotations = answer(queue.annotations.get(String(checkRunId)) ?? []);
      return annotations === null ? null : [...annotations];
    },
    originPullOfCommit: ({ repo, sha }) => {
      world.calls.push(`originPullOfCommit ${repo} ${sha}`);
      return answer(queue.originPulls.get(sha) ?? null);
    },
  };
}

/** The reads of the queue table: the open pull requests, their queue seats and a commit's check runs, and the budget. */
function tableOperations(world: FakeRowsWorld): Pick<CodeHostRows, "openMainPullRollupsOf" | "openPullRowsOf" | "pullQueueStatesOf" | "checkRunBriefsOf" | "apiBudgetOf"> {
  const { queue } = world.tail;
  return {
    // The pull request as the merge queue's dispatcher reads it (its number, draft flag and the rollup a test seeded) with the head and the auto-merge request the report adds.
    openMainPullRollupsOf: () => {
      const queued = new Map(mergeOperations(world).openPullsForQueue({}).map((read) => [read.number, read]));
      return openPulls(world).filter((pull) => (pull.baseRefName ?? "main") === "main").slice(0, 100).map((pull) => ({ ...queued.get(pull.number), headRefOid: pull.headRefOid ?? `head-${pull.number}`,
        autoMergeRequest: pull.armed ? { enabledAt: ENABLED_AT } : null }));
    },
    openPullRowsOf: () => {
      world.calls.push("openPullRowsOf");
      return openPulls(world).slice(0, 100).map((pull) => ({ number: pull.number, headRefName: pull.headRefName, headRefOid: pull.headRefOid ?? `head-${pull.number}`, updatedAt: pull.updatedAt ?? pull.createdAt,
        draft: pull.isDraft, labels: [...pull.labels], auto_merge: pull.armed ? { merge_method: "merge" } : null }));
    },
    pullQueueStatesOf: () => {
      world.calls.push("pullQueueStatesOf");
      return openPulls(world).slice(0, 100).map((pull) => {
        const entry = queueEntryOf(world, pull.number);
        return { number: pull.number, autoMergeRequest: pull.armed ? { enabledAt: ENABLED_AT } : null, mergeQueueEntry: entry === undefined ? null : { state: entry.state, position: entry.position } };
      });
    },
    checkRunBriefsOf: ({ sha }) => {
      world.calls.push(`checkRunBriefsOf ${sha}`);
      const seeded = queue.checks.get(sha);
      if (seeded !== undefined) return [...answer(seeded)];
      return [...world.pulls.values()].find((pull) => pull.headRefOid === sha)?.checkRuns?.map(briefOf) ?? [];
    },
    apiBudgetOf: () => queue.budget,
  };
}

export function queueOperations(world: FakeRowsWorld): Pick<CodeHostRows, keyof RowsQueue> {
  return { ...trunkOperations(world), ...redTrunkOperations(world), ...tableOperations(world) };
}

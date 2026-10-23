// @ts-check
// module: the in-memory code host's operations for arming, the merge guard and the merge queue's dispatcher (A11-160, step 5)
//
// THEY ACT ON THE WORLD A TEST SEEDS (`FakeRowsWorld`), and ignore the `run` their caller hands them. A pull request there has the fields arming and the guard read (an author, a head, a base, check runs, a
// review decision, an ejection, the rows it closes, how far behind `main` it is), and the merge queue is the world's `queue`. Arming a pull request sets `armed` unless the pull request says its arm is
// refused or does not take; merging one marks it merged. A test that wants a read to fail names the operation in `world.failures`: it throws that error when called (`createFakeRows` wraps every operation).
//
// Everything that is a rule rather than a read (`armedFromApi`, `armedReason`, `queueEjectionOf`, `openBlockersOf`, `settledReason`) is the rule the code host holds, written again here and held to it by the
// contract suite, since core may not import the plugin that holds the original. What GitHub's own text carries (a command, a query) is a stand-in line that names the operation.
import type { ArmedNode, BranchPull, CodeHostRows, GuardPullRead, OpenPullNode, QueueEntry, QueuePull, QueueSeat } from "../contracts/code-host-rows.ts";
import type { FakeRow, FakeRowPull, FakeRowsWorld } from "./code-host-rows.ts";

const stateOf = (pull: FakeRowPull): "OPEN" | "MERGED" | "CLOSED" => (pull.merged ? "MERGED" : pull.closedAt != null ? "CLOSED" : "OPEN");

const pullOf = (world: FakeRowsWorld, number: number | string): FakeRowPull => {
  const pull = world.pulls.get(Number(number));
  if (pull === undefined) throw new Error(`the fake holds no pull request #${number}`);
  return pull;
};

const pullByHead = (world: FakeRowsWorld, head: string): FakeRowPull | undefined => [...world.pulls.values()].find((pull) => pull.headRefOid === head);

const entriesOf = (world: FakeRowsWorld): readonly QueueEntry[] => {
  if (world.queue.entries instanceof Error) throw world.queue.entries;
  return world.queue.entries;
};

const entryOf = (world: FakeRowsWorld, number: number): QueueEntry | undefined => (world.queue.entries instanceof Error ? undefined : world.queue.entries.find((entry) => entry.pull === number));

/** The armed rule's node for a pull request: merged, auto-merge requested, or sitting in the queue. */
function armedNodeOf(world: FakeRowsWorld, number: number | string): NonNullable<ArmedNode> & { number: number; isDraft: boolean } {
  const pull = pullOf(world, number);
  const entry = entryOf(world, pull.number);
  return { number: pull.number, isDraft: pull.isDraft, merged: pull.merged, autoMergeRequest: pull.armed ? { enabledAt: "2026-01-01T00:00:00Z" } : null, mergeQueueEntry: entry === undefined ? null : { state: entry.state } };
}

// --- the rules, as the code host holds them --------------------------------------------------------------------------------------------------

const armedFromApi = (node: ArmedNode): boolean => (node ? node.merged === true || node.autoMergeRequest != null || node.mergeQueueEntry != null : false);

const armedReason = (node: ArmedNode): string | null => {
  if (!armedFromApi(node)) return null;
  if (node?.merged === true) return "it is already merged";
  if (node?.mergeQueueEntry != null) return "it is already queued to merge";
  return "auto-merge is already enabled on it";
};

const QUEUE_EVENTS = ["AddedToMergeQueueEvent", "RemovedFromMergeQueueEvent"];

const queueEjectionOf = (pr: { mergeQueueEntry?: unknown; timelineItems?: { nodes?: unknown } } | null) => {
  const nodes: any = pr?.timelineItems?.nodes;
  if (!Array.isArray(nodes)) return null;
  const notEjected = { ejected: false, removedAt: null };
  if (pr?.mergeQueueEntry != null) return notEjected;
  const lastQueueAt = nodes.map((n) => QUEUE_EVENTS.includes(n?.__typename)).lastIndexOf(true);
  const last = nodes[lastQueueAt];
  if (last?.__typename !== "RemovedFromMergeQueueEvent" || last.reason !== "failed_checks") return notEjected;
  return lastQueueAt < nodes.length - 1 ? notEjected : { ejected: true, removedAt: String(last.createdAt ?? "") || null };
};

const openBlockersOf = (row: { blockedBy?: { nodes?: unknown; totalCount?: unknown } } | null): number[] | null => {
  const nodes = row?.blockedBy?.nodes;
  if (!Array.isArray(nodes)) return null;
  const open = nodes.filter((node) => String(node?.state ?? "OPEN").toUpperCase() === "OPEN").map((node) => Number(node?.number));
  const total = row?.blockedBy?.totalCount;
  if (open.length === 0 && typeof total === "number" && total > nodes.length) return null;
  return open;
};

const settledReason = (state: string | null): string | null => (state === "MERGED" || state === "CLOSED" ? `it is already ${state.toLowerCase()}` : null);

// --- the world's reads ------------------------------------------------------------------------------------------------------------------------

/** A row of `repo`: the world's own, or another repository's by `owner/name#number`. */
function rowOf(world: FakeRowsWorld, repo: string, number: number): FakeRow {
  const row = repo === world.repo ? world.rows.get(number) : world.foreignRows.get(`${repo}#${number}`);
  if (row === undefined) throw new Error(`the fake holds no row ${repo}#${number}`);
  return row;
}

/** The pull request as the guard's readiness check reads it, with its state spelled by `spell`: GraphQL's `OPEN`, or the REST pull's `open`. */
function guardRead(world: FakeRowsWorld, number: number, spell: (state: string) => string): GuardPullRead {
  const pull = pullOf(world, number);
  return { pr: { number: pull.number, state: spell(stateOf(pull)), baseRefName: pull.baseRefName ?? "main", headRefOid: pull.headRefOid ?? `head-${pull.number}`, headRefName: pull.headRefName },
    prLabels: [...pull.labels], body: pull.body, author: pull.author ?? null };
}

const queuePullOf = (pull: FakeRowPull): QueuePull => ({ number: pull.number, title: pull.title ?? `Pull ${pull.number}`, headRefName: pull.headRefName, mergeable: pull.mergeable ?? "MERGEABLE",
  mergeStateStatus: pull.mergeStateStatus ?? "CLEAN", isDraft: pull.isDraft, statusCheckRollup: pull.rollup ?? [] });

const openPulls = (world: FakeRowsWorld): FakeRowPull[] => [...world.pulls.values()].filter((pull) => stateOf(pull) === "OPEN");

type Armed = Pick<CodeHostRows, "ownRun" | "armedQueryArgs" | "armedFromApi" | "armedReason" | "armedNodeOf" | "armedReasonOf" | "ejectionQueryArgs" | "queueEjectionOf" | "readQueueEjection"
  | "openBlockersOf" | "openBlockersOfRow" | "labelsOfRow" | "readPullComments" | "commentOnPull" | "addLabelsToPull" | "readPullForArming" | "pullStateOf" | "armPullAuto" | "settledReason" | "armMergeOf"
  | "trunkRunsPage" | "readQueueSeat" | "jumpToFront" | "dequeueByHandCommand" | "graphqlPoolOf">;
type Sweep = Pick<CodeHostRows, "openPullRequestsQueryArgs" | "readOpenPullNodes" | "isMergedPull" | "isArmedPull" | "readSweepFacts" | "isCrossRepositoryPull" | "readOutsideArmListed">;
type Guard = Pick<CodeHostRows, "requiredContextsOf" | "checkRunsOfCommit" | "mainTipDateOf" | "behindByOf" | "closingIssuesOf" | "recentClosesPrsOf" | "pullForGuard" | "pullForCiGate" | "pullOutcomeOf"
  | "openPullsOfBranch">;
type Dispatcher = Pick<CodeHostRows, "openPullsForQueue" | "mergeQueuedPull" | "compareWithMain" | "deleteBranchOf">;

/** The operations of arming, the merge guard and the merge queue's dispatcher, over the world. */
export function mergeOperations(world: FakeRowsWorld): Armed & Sweep & Guard & Dispatcher {
  return { ...armingOperations(world), ...sweepOperations(world), ...guardOperations(world), ...dispatcherOperations(world) };
}

const callOf = (world: FakeRowsWorld) => (line: string): void => { world.calls.push(line); };

/** The write that requests auto-merge: refused when the pull request says so, refused for a pull request that is not open, and a no-op when the pull request says it does not take. */
function armPullAutoOf(world: FakeRowsWorld): CodeHostRows["armPullAuto"] {
  return ({ repo, number }) => {
    callOf(world)(`armPullAuto ${repo}#${number}`);
    const pull = pullOf(world, number);
    if (pull.armRefusal != null) throw new Error(pull.armRefusal);
    if (stateOf(pull) !== "OPEN") throw new Error(`GraphQL: Pull request is ${stateOf(pull).toLowerCase()}`);
    if (pull.armTakes !== false) pull.armed = true;
  };
}

/** The comments and labels of a pull request, which the arming path reads and writes. */
function pullThreadOperations(world: FakeRowsWorld): Pick<CodeHostRows, "readPullComments" | "commentOnPull" | "addLabelsToPull"> {
  const call = callOf(world);
  return {
    readPullComments: ({ number }) => pullOf(world, number).comments.map((body) => ({ body })),
    commentOnPull: ({ repo, number, body }) => { call(`commentOnPull ${repo}#${number}`); pullOf(world, number).comments.push(body); },
    addLabelsToPull: ({ repo, number, labels }) => {
      call(`addLabelsToPull ${repo}#${number} ${labels.join(",")}`);
      const pull = pullOf(world, number);
      for (const label of labels) if (!pull.labels.includes(label)) pull.labels.push(label);
    },
  };
}

/** What arming a pull request asks: its labels, the blockers of the rows it closes, the arm and its read-back, the queue's seat and the jump, and the pool a refused read names. */
function armingOperations(world: FakeRowsWorld): Armed {
  const call = callOf(world);
  const armPullAuto = armPullAutoOf(world);
  return {
    ...pullThreadOperations(world),
    ownRun: () => { throw new Error("the fake code host has no gh: a test of code that reaches GitHub through the code host's own runner runs against the GitHub plugin"); },
    armedQueryArgs: ({ number, repo }) => ["fake-armed-query", repo, String(number)],
    armedFromApi,
    armedReason,
    armedNodeOf: ({ number }) => armedNodeOf(world, number),
    armedReasonOf: ({ repo, number }) => { call(`armedReasonOf ${repo}#${number}`); return armedReason(armedNodeOf(world, number)); },
    ejectionQueryArgs: ({ number, repo }) => ["fake-ejection-query", repo, String(number)],
    queueEjectionOf,
    readQueueEjection: ({ repo, number }) => {
      call(`readQueueEjection ${repo}#${number}`);
      const pull = pullOf(world, number);
      if (pull.ejectionUnread === true) return null;
      if (entryOf(world, pull.number) !== undefined || pull.ejectedAt == null) return { ejected: false, removedAt: null };
      return { ejected: true, removedAt: pull.ejectedAt };
    },
    openBlockersOf,
    openBlockersOfRow: ({ repo, number }) => {
      call(`openBlockersOfRow ${repo}#${number}`);
      const row = rowOf(world, repo, number);
      if (row.blockedByUnread === true) return null;
      return row.blockedBy.filter((blocker) => (world.rows.get(blocker)?.state ?? "OPEN") === "OPEN");
    },
    labelsOfRow: ({ repo, number }) => { call(`labelsOfRow ${repo}#${number}`); return [...rowOf(world, repo, number).labels]; },
    readPullForArming: ({ number }) => {
      const pull = pullOf(world, number);
      return { labels: [...pull.labels], body: pull.body, state: stateOf(pull), author: pull.author ?? null };
    },
    pullStateOf: ({ number }) => stateOf(pullOf(world, number)),
    armPullAuto,
    settledReason,
    armMergeOf: ({ repo, number }) => {
      try {
        armPullAuto({ repo, number });
        return { armed: true, reason: "auto-merge enabled" };
      } catch (cause) {
        const settled = settledReason(stateOf(pullOf(world, number)));
        if (settled !== null) return { armed: false, reason: `${settled} -- nothing was left to arm` };
        const armed = armedReason(armedNodeOf(world, number));
        if (armed !== null) return { armed: false, reason: `${armed} -- nothing was left to arm` };
        throw cause;
      }
    },
    trunkRunsPage: ({ page, perPage }) => world.trunkRuns.slice((page - 1) * perPage, page * perPage),
    readQueueSeat: ({ number }) => {
      const pull = pullOf(world, number);
      const entry = entryOf(world, pull.number);
      return { id: `PR_fake_${pull.number}`, headRefOid: pull.headRefOid ?? `head-${pull.number}`, mergeStateStatus: pull.mergeStateStatus ?? "CLEAN",
        mergeQueueEntry: entry === undefined ? null : { position: entry.position, state: entry.state } } satisfies QueueSeat;
    },
    jumpToFront: ({ id, headOid }) => {
      call(`jumpToFront ${id} ${headOid}`);
      if (world.jumpRefusal !== null) throw new Error(world.jumpRefusal);
      const pull = [...world.pulls.values()].find((candidate) => `PR_fake_${candidate.number}` === id);
      if (pull === undefined || pull.headRefOid !== headOid && pull.headRefOid !== undefined) throw new Error("the head moved: the jump was refused");
      const entries = entriesOf(world);
      world.queue.entries = [{ state: "QUEUED", enqueuedAt: "2026-01-01T00:00:00Z", position: 1, headSha: headOid, pull: pull.number, pullId: id },
        ...entries.map((entry) => ({ ...entry, position: entry.position + 1 }))];
    },
    dequeueByHandCommand: (id) => `fake: dequeue ${id} by hand`,
    graphqlPoolOf: () => { call("graphqlPoolOf"); return world.pool; },
  };
}

/** What the sweep asks: the open pull requests as nodes of the armed rule, the facts of a candidate, whether it merged or is armed, and the outside home's list. */
function sweepOperations(world: FakeRowsWorld): Sweep {
  const call = callOf(world);
  return {
    openPullRequestsQueryArgs: (repo) => ["fake-open-pull-nodes", repo],
    readOpenPullNodes: () => openPulls(world).filter((pull) => (pull.baseRefName ?? "main") === "main").map((pull): OpenPullNode => armedNodeOf(world, pull.number)),
    isMergedPull: ({ number }) => pullOf(world, number).merged,
    isArmedPull: ({ number }) => armedFromApi(armedNodeOf(world, number)),
    readSweepFacts: ({ repo, number }) => {
      call(`readSweepFacts ${repo}#${number}`);
      const pull = pullOf(world, number);
      return { labels: [...pull.labels], author: pull.author ?? "", prBody: pull.body, head: pull.headRefOid ?? `head-${pull.number}`, checkRunCount: pull.checkRuns?.length ?? 0 };
    },
    isCrossRepositoryPull: ({ number }) => pullOf(world, number).isCrossRepository ?? false,
    readOutsideArmListed: () => openPulls(world).map((pull) => ({ number: pull.number, state: "OPEN", isDraft: pull.isDraft, baseRefName: pull.baseRefName ?? "main", isCrossRepository: pull.isCrossRepository ?? false,
      reviewDecision: pull.reviewDecision ?? "", labels: pull.labels.map((name) => ({ name })) })),
  };
}

/** What the merge guard asks: branch protection, a commit's check runs, the tip of `main`, how far behind it a head is, the rows a pull request closes, the pull request itself, its outcome and a branch's pull request. */
function guardOperations(world: FakeRowsWorld): Guard {
  return {
    requiredContextsOf: () => world.requiredContexts,
    checkRunsOfCommit: ({ sha }) => [...(pullByHead(world, sha)?.checkRuns ?? [])],
    mainTipDateOf: () => world.mainTip,
    behindByOf: ({ head }) => pullByHead(world, head)?.behindBy ?? 0,
    closingIssuesOf: ({ number }) => [...(pullOf(world, number).closes ?? [])],
    recentClosesPrsOf: () => [...world.pulls.values()].filter((pull) => stateOf(pull) !== "CLOSED").sort((a, b) => b.number - a.number).slice(0, 30)
      .map((pull) => ({ number: pull.number, body: pull.body, resolved: (pull.closes ?? []).map((issue) => issue.number) })),
    pullForGuard: ({ number }) => guardRead(world, number, (state) => state),
    pullForCiGate: ({ number }) => guardRead(world, number, (state) => state.toLowerCase()),
    pullOutcomeOf: ({ number }) => {
      const pull = pullOf(world, number);
      return { state: stateOf(pull), mergedAt: pull.mergedAt, closedAt: pull.closedAt ?? null };
    },
    openPullsOfBranch: ({ branch }) => openPulls(world).filter((pull) => pull.headRefName === branch)
      .map((pull): BranchPull => ({ number: pull.number, armed: pull.armed, headRefOid: pull.headRefOid ?? `head-${pull.number}`, reviewDecision: pull.reviewDecision === undefined ? null : (pull.reviewDecision ?? "") })),
  };
}

/** What the merge queue's dispatcher asks: the open pull requests, the merge, the comparison with `main` and the deletion of a branch. */
function dispatcherOperations(world: FakeRowsWorld): Dispatcher {
  return {
    openPullsForQueue: () => openPulls(world).map(queuePullOf),
    mergeQueuedPull: ({ number }) => {
      callOf(world)(`mergeQueuedPull #${number}`);
      const pull = pullOf(world, number);
      pull.merged = true;
      pull.mergedAt = new Date(world.now()).toISOString();
      pull.armed = false;
      return `merged #${number}\n`;
    },
    compareWithMain: ({ branch }) => {
      const answer = world.compare.get(branch) ?? { ahead_by: 0, commits: [] };
      if (answer instanceof Error) throw answer;
      return answer;
    },
    deleteBranchOf: ({ branch }) => { callOf(world)(`deleteBranchOf ${branch}`); world.deletedBranches.push(branch); },
  };
}

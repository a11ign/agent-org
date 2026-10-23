// @ts-check
// module: the in-memory code host's operations for the work gate (A11-160, step 6)
//
// THEY ACT ON THE WORLD A TEST SEEDS (`FakeRowsWorld`), and ignore the `run` the gate hands them. What the gate asks of a row beyond what the world already holds is its HISTORY: which labels were applied and
// removed, by whom and when (`gate.events`), who wrote each comment (`FakeRow.comments[].author`), and the pull requests that cross-reference it. The rest is the pull requests and checks the gate reads. A read
// that is refused is an `Error` where the world holds the answer (the events of one row, the jobs of one run), or is named in `world.failures`, which `createFakeRows` applies to every operation.
//
// An operation whose answer is GitHub's own text (the arguments the gate runs through its own executor) answers a stand-in line, and `gateRun` and `runTogether` have no `gh` to start, so they throw.
import type { ActionsJob, CodeHostRows } from "../contracts/code-host-rows.ts";
import type { FakeRow, FakeRowsWorld } from "./code-host-rows.ts";

/** One event of a row's history. */
export type FakeRowEvent = { event: "labeled" | "unlabeled"; label: string; actor: string | null; at: string };

/** A job of a workflow run as the gate reads it. */
export type FakeJob = ActionsJob;

/** What the gate reads of the world beyond its rows and pull requests. */
export type FakeGate = {
  /** The labels applied to and taken off each row, oldest first; an `Error` is a refused read of that row's history. */
  events: Map<number, FakeRowEvent[] | Error>;
  /** Rows whose comments cannot be read (a refused read of just that row). */
  commentsRefused: Set<number>;
  /** The pull requests each row's timeline cross-references. */
  crossReferences: Map<number, { number: number; headRefName: string; title: string }[]>;
  /** The tags that exist. */
  tags: Set<string>;
  /** The tracker's issue events and its closed pull requests, newest first, as the milestone clock reads them; an `Error` is a refused read. */
  issueEvents: any[] | Error;
  closedPulls: any[] | Error;
  /** The closed pull requests of a repository, where a test gives each its own (a repository with none here answers `closedPulls`). */
  closedPullsByRepo?: Map<string, any[] | Error>;
  /** `main`'s tip commit, or null when the answer is not JSON. */
  mainTip: { sha: string; date: string } | null;
  /** The diff `base...head` compares, by `<base>...<head>`; an absent one is refused. */
  diffs: Map<string, string | Error>;
  /** The check runs of a commit with their summaries, by commit. */
  checkSummaries: Map<string, { id: number; name: string; summary: unknown }[] | Error>;
  /** The names of the check runs that failed at a commit, by commit. */
  failingChecks: Map<string, string[] | Error>;
  /** The newest merge-group runs, the jobs of each by run id, and the Actions jobs by job id. */
  mergeGroupRuns: { id: number; head_branch: string; conclusion?: string | null; created_at: string }[] | Error;
  mergeGroupJobs: Map<number, FakeJob[] | Error>;
  actionsJobs: Map<string, FakeJob | Error>;
  /** The contexts rulesets require of `main`, or null when no source gives any. */
  requiredChecks: string[] | null;
  /** The answer-label list that is not a list, and the kinds of closed-rows read whose answer is not whole: the code host answers `null` for them, never an empty answer. */
  labelListNotAList: boolean;
  closedRowsNotWhole: Set<"issues" | "pullRequests">;
  /** The closed-rows read hands back every closed row, whether it carries the label or not (GitHub's own filter switched off), so a caller's LOCAL filter is tested apart from the server's. */
  closedRowsUnfiltered: boolean;
  /** The nodes of the recently-closed connection exactly as a test wants them answered (unsorted, a field missing, unreadable), `null` for an answer that carries none, or an `Error` for a refused read. Absent: derived from the closed rows. */
  recentlyClosed?: readonly object[] | null | Error;
};

export const emptyGate = (): FakeGate => ({ events: new Map(), commentsRefused: new Set(), crossReferences: new Map(), tags: new Set(), issueEvents: [], closedPulls: [], mainTip: null, diffs: new Map(),
  checkSummaries: new Map(), failingChecks: new Map(), mergeGroupRuns: [], mergeGroupJobs: new Map(), actionsJobs: new Map(), requiredChecks: null,
  labelListNotAList: false, closedRowsNotWhole: new Set(), closedRowsUnfiltered: false });

const answer = <T>(found: T | Error): T => {
  if (found instanceof Error) throw found;
  return found;
};

const noGh = (what: string) => (): never => {
  throw new Error(`the fake code host has no gh to start for ${what}: a core test of a gate read seeds the world, and a test of the process is the GitHub plugin's`);
};

const rowOf = (world: FakeRowsWorld, number: number | string): FakeRow => {
  const row = world.rows.get(Number(number));
  if (row === undefined) throw new Error(`the fake holds no row #${number}`);
  return row;
};

const iso = (world: FakeRowsWorld): string => new Date(world.now()).toISOString();

const eventsOf = (world: FakeRowsWorld, number: number): FakeRowEvent[] => (answer(world.gate.events.get(number) ?? []));

/** Whether `repo` names the world's own repository: by name, by `gh`'s own placeholder, or by naming none. */
const isHome = (world: FakeRowsWorld, repo: string | undefined): boolean => [undefined, "", "{owner}/{repo}", world.repo].includes(repo);

/** The row `repo#number` is, in this repository's world or among the foreign rows. */
function rowIn(world: FakeRowsWorld, repo: string | undefined, number: number): FakeRow {
  if (isHome(world, repo)) return rowOf(world, number);
  const foreign = world.foreignRows.get(`${repo}#${number}`);
  if (foreign === undefined) throw new Error(`the fake holds no row ${repo}#${number}`);
  return foreign;
}

/** Records the read in the world's calls, then makes it. */
const noted = <T>(world: FakeRowsWorld, line: string, read: () => T): T => {
  world.calls.push(line);
  return read();
};

const commentOf = (world: FakeRowsWorld, row: FakeRow, body: string): void => {
  row.comments.push({ id: world.nextCommentId++, body, createdAt: iso(world) });
};

/** An item's state as a wait reads it: a row, or a pull request (which carries `merged_at`). */
function waitRefOf(world: FakeRowsWorld, repo: string, number: number): ReturnType<CodeHostRows["waitRefOf"]> {
  const pull = repo === world.repo ? world.pulls.get(number) : world.rules.otherRepos.get(repo)?.get(number); // A11-160, step 7: another repository's pull request is among the rules' `otherRepos`
  if (pull !== undefined) {
    return { state: pull.merged || pull.closedAt != null ? "closed" : "open", closed_at: pull.mergedAt ?? pull.closedAt ?? null, updated_at: pull.mergedAt ?? pull.createdAt, merged_at: pull.mergedAt, labels: [...pull.labels] };
  }
  const row = rowIn(world, repo, number);
  return { state: row.state === "OPEN" ? "open" : "closed", closed_at: row.closedAt, updated_at: row.closedAt ?? row.createdAt, merged_at: null, labels: [...row.labels] };
}

/** The reads of rows the gate makes: their history, their comments and the facts a wait or a promotion reads. */
function rowReads(world: FakeRowsWorld): Pick<CodeHostRows, "unlabeledEventsOf" | "labeledEventTimesOf" | "newestLabellerOf" | "commentActivityOf" | "rowTimelineOf" | "waitRefOf" | "incidentItemOf" | "rowBodyOf"
  | "rowStateAndNewestComment" | "rowForPromotion" | "issueEventsPage" | "closedPullsPage" | "tagExistsOn" | "newestCommentsOf" | "recentlyClosedRowsOf" | "commentBodiesOfRow" | "openRowsOf" | "labelNamesWithPrefix"
  | "closedClaimedRowsOf" | "closedRowsCarryingLabels"> {
  const commentsOf = (number: number) => {
    if (world.gate.commentsRefused.has(number)) throw new Error(`the fake refuses the comments of #${number}`);
    return rowOf(world, number).comments;
  };
  return {
    unlabeledEventsOf: ({ number }) => eventsOf(world, number).filter((e) => e.event === "unlabeled").map((e) => ({ name: e.label, at: e.at })),
    labeledEventTimesOf: ({ number, label }) => noted(world, `labeledEventTimesOf #${number}`, () => eventsOf(world, number).filter((e) => e.event === "labeled" && e.label === label).map((e) => e.at)),
    newestLabellerOf: ({ number, label }) => eventsOf(world, number).filter((e) => e.event === "labeled" && e.label === label).at(-1)?.actor ?? null,
    commentActivityOf: ({ number }) => commentsOf(number).map((c) => ({ author: c.author ?? "", at: c.createdAt, body: c.body.slice(0, 200) })),
    rowTimelineOf: ({ number }) => [
      ...eventsOf(world, number).map((e) => ({ event: e.event as string, label: { name: e.label }, ...(e.actor === null ? {} : { actor: e.actor }), created_at: e.at })),
      ...commentsOf(number).map((c) => ({ event: "commented", ...(c.author === undefined ? {} : { actor: c.author }), id: c.id, created_at: c.createdAt })),
    ].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    waitRefOf: ({ repo, number }) => {
      world.calls.push(`waitRefOf ${repo}#${number}`);
      return waitRefOf(world, repo, number);
    },
    incidentItemOf: ({ ref }) => {
      const [repo, number] = ref.split("#");
      const row = rowIn(world, repo, Number(number));
      return { open: row.state === "OPEN", labels: [...row.labels], body: row.body };
    },
    rowBodyOf: ({ number }) => rowOf(world, number).body,
    rowStateAndNewestComment: ({ number }) => {
      const row = world.rows.get(number);
      if (row === undefined) return null;
      const last = row.comments.at(-1);
      return { state: row.state.toLowerCase(), lastComment: last === undefined ? null : { body: last.body, createdAt: last.createdAt } };
    },
    rowForPromotion: ({ number }) => {
      const row = rowOf(world, number);
      return { labels: [...row.labels], state: row.state, body: row.body, blockedBy: { nodes: row.blockedBy.map((blocker) => ({ number: blocker, state: world.rows.get(blocker)?.state ?? "OPEN" })) } };
    },
    issueEventsPage: ({ page, pageSize }) => answer(world.gate.issueEvents).slice((page - 1) * pageSize, page * pageSize),
    closedPullsPage: ({ repo, page, pageSize }) => {
      world.calls.push(`closedPullsPage ${repo}`);
      return answer(world.gate.closedPullsByRepo?.get(repo) ?? world.gate.closedPulls).slice((page - 1) * pageSize, page * pageSize);
    },
    tagExistsOn: ({ tag }) => world.gate.tags.has(tag),
    newestCommentsOf: ({ numbers, last }) => new Map(numbers.filter((n) => world.rows.has(n)).map((n) => [n, rowOf(world, n).comments.slice(-last)
      .map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt, author: { login: c.author ?? "" } }))])),
    recentlyClosedRowsOf: ({ limit }) => world.gate.recentlyClosed !== undefined ? answer(world.gate.recentlyClosed) as ReturnType<CodeHostRows["recentlyClosedRowsOf"]> : [...world.rows.values()].filter((row) => row.state === "CLOSED" && row.closedAt !== null)
      .sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt))).slice(0, limit).map((row) => ({ number: row.number, closedAt: row.closedAt, updatedAt: row.closedAt })),
    commentBodiesOfRow: ({ number }) => rowOf(world, number).comments.map((c) => c.body),
    openRowsOf: ({ limit }) => [...world.rows.values()].filter((row) => row.state === "OPEN").sort((a, b) => b.number - a.number).slice(0, limit).map((row) => ({ number: row.number, title: row.title, body: row.body,
      labels: row.labels.map((name) => ({ name })), blockedBy: { nodes: row.blockedBy.map((number) => ({ number })) }, milestone: null, updatedAt: row.createdAt, createdAt: row.createdAt })),
    labelNamesWithPrefix: ({ prefix }) => (world.gate.labelListNotAList ? null : [...new Set([...world.labelsCreated, ...[...world.rows.values()].flatMap((row) => row.labels)])].filter((name) => name.startsWith(prefix))),
    closedClaimedRowsOf: ({ numbers, claimLabel }) => numbers.flatMap((number) => {
      const row = world.rows.get(number);
      if (row === undefined || row.state !== "CLOSED" || !row.labels.includes(claimLabel)) return [];
      return [{ number, labels: row.labels.map((name) => ({ name })), comments: row.comments.map((c) => ({ body: c.body, createdAt: c.createdAt, author: { login: c.author } })),
        closedByPullRequestsReferences: (world.gate.crossReferences.get(number) ?? []).slice(0, 5) }];
    }),
    closedRowsCarryingLabels: ({ names, kind }) => {
      // A read of one kind refused: `failures` names the operation, and `closedRowsCarryingLabels <kind>` names it for that kind alone.
      const refusal = world.failures.get(`closedRowsCarryingLabels ${kind}`);
      if (refusal !== undefined) throw refusal;
      if (world.gate.closedRowsNotWhole.has(kind)) return null;
      const carrying = (labels: string[]) => world.gate.closedRowsUnfiltered || names.some((name) => labels.includes(name));
      if (kind === "issues") {
        return [...world.rows.values()].filter((row) => row.state === "CLOSED" && carrying(row.labels)).map((row) => ({ number: row.number, title: row.title, state: row.state, labels: row.labels.map((name) => ({ name })) }));
      }
      return [...world.pulls.values()].filter((pull) => (pull.merged || pull.closedAt != null) && carrying(pull.labels))
        .map((pull) => ({ number: pull.number, title: pull.title ?? `Pull ${pull.number}`, state: pull.merged ? "MERGED" : "CLOSED", isDraft: pull.isDraft, labels: pull.labels.map((name) => ({ name })) }));
    },
  };
}

/** The writes to rows, pull requests and the board the gate makes. */
function rowWrites(world: FakeRowsWorld): Pick<CodeHostRows, "commentOnRow" | "addLabelToRow" | "removeLabelFromRow" | "setRowBody" | "ensureLabel" | "fileLabelledRow" | "addLabelToRowByApi" | "markPullReady" | "addRowToProject" | "setProjectStatus"> {
  const labelRow = (number: number | string, label: string): void => {
    const row = rowOf(world, number);
    if (!row.labels.includes(label)) row.labels.push(label);
  };
  return {
    commentOnRow: ({ number, body }) => commentOf(world, rowOf(world, number), body),
    addLabelToRow: ({ number, label }) => labelRow(number, label),
    removeLabelFromRow: ({ number, label }) => {
      const row = rowOf(world, number);
      row.labels = row.labels.filter((existing) => existing !== label);
    },
    setRowBody: ({ number, body }) => { rowOf(world, number).body = body; },
    ensureLabel: ({ name }) => { if (!world.labelsCreated.includes(name)) world.labelsCreated.push(name); },
    fileLabelledRow: ({ title, label, body }) => {
      const number = world.nextNumber++;
      world.rows.set(number, { number, title, body, state: "OPEN", labels: [label], createdAt: iso(world), closedAt: null, comments: [], blockedBy: [], onBoard: false, boardStatus: null });
      return `https://github.com/${world.repo}/issues/${number}\n`;
    },
    addLabelToRowByApi: ({ number, label }) => labelRow(number, label),
    markPullReady: ({ number, repo }) => {
      const pull = world.pulls.get(Number(number));
      if (pull === undefined) throw new Error(`the fake holds no pull request #${number}`);
      world.calls.push(`markPullReady ${repo ?? ""}#${number}`);
      pull.isDraft = false;
    },
    addRowToProject: ({ url }) => { rowOf(world, Number(/(\d+)$/.exec(url)?.[1])).onBoard = true; },
    setProjectStatus: ({ url, status }) => {
      const row = rowOf(world, Number(/(\d+)$/.exec(url)?.[1]));
      if (!row.onBoard) throw new Error(`the fake refuses a Status for #${row.number}: it is not an item of the project`);
      row.boardStatus = status;
    },
  };
}

/** The reads of pull requests, commits, checks and runs the gate makes, and the executor's process, which a fake has none of. */
function pullOperations(world: FakeRowsWorld): Pick<CodeHostRows, "gateRun" | "runTogether" | "readRequiredContexts" | "mainTipOf" | "pullsOfBranch" | "newestMergedPulls" | "openPullListArgs" | "pullFileNamesOf" | "commitShasOf"
  | "compareDiffOf" | "failingCheckNamesAt" | "checkRunSummariesAt" | "mergeGroupRunsOf" | "jobsOfMergeGroupRun" | "actionsJobOf"> {
  return {
    gateRun: noGh("the gate's executor"),
    runTogether: noGh("a batch of calls"),
    readRequiredContexts: () => (world.gate.requiredChecks !== null && world.gate.requiredChecks.length > 0
      ? { contexts: [...world.gate.requiredChecks] }
      : { contexts: null, diagnosis: "the fake code host's world lists no required checks." }),
    mainTipOf: () => world.gate.mainTip,
    pullsOfBranch: ({ branch, limit }) => [...world.pulls.values()].filter((pull) => pull.headRefName === branch).slice(0, limit)
      .map((pull) => ({ number: pull.number, state: pull.merged ? "MERGED" : pull.closedAt != null ? "CLOSED" : "OPEN" })),
    newestMergedPulls: () => [...world.pulls.values()].filter((pull) => pull.merged && pull.mergedAt !== null).sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt))).slice(0, 100)
      .map((pull) => ({ number: pull.number, headRefName: pull.headRefName, mergedAt: String(pull.mergedAt), title: pull.title ?? `Pull ${pull.number}`, labels: pull.labels.map((name) => ({ name })) })),
    openPullListArgs: (limit, fields) => ["fake-open-pull-list", String(limit), fields],
    pullFileNamesOf: ({ number }) => {
      const pull = world.pulls.get(number);
      if (pull === undefined) throw new Error(`the fake holds no pull request #${number}`);
      return [...(pull.files ?? [])];
    },
    commitShasOf: ({ number }) => {
      const pull = world.pulls.get(number);
      if (pull === undefined) throw new Error(`the fake holds no pull request #${number}`);
      return [...(pull.commits ?? [])];
    },
    compareDiffOf: ({ base, head }) => {
      world.calls.push(`compareDiffOf ${base}...${head}`);
      const found = world.gate.diffs.get(`${base}...${head}`);
      if (found === undefined) throw new Error(`the fake holds no diff ${base}...${head}`);
      return answer(found);
    },
    failingCheckNamesAt: ({ commit }) => {
      world.calls.push(`failingCheckNamesAt ${commit}`);
      return [...answer(world.gate.failingChecks.get(commit) ?? [])];
    },
    checkRunSummariesAt: ({ commit }) => [...answer(world.gate.checkSummaries.get(commit) ?? [])],
    mergeGroupRunsOf: ({ withConclusion }) => answer(world.gate.mergeGroupRuns).map(({ conclusion, ...run }) => (withConclusion ? { ...run, conclusion } : run)),
    jobsOfMergeGroupRun: ({ runId }) => {
      const found = world.gate.mergeGroupJobs.get(runId);
      if (found === undefined) throw new Error(`the fake holds no jobs of run ${runId}`);
      return [...answer(found)];
    },
    actionsJobOf: ({ jobId }) => {
      world.calls.push(`actionsJobOf ${jobId}`);
      const found = world.gate.actionsJobs.get(jobId);
      if (found === undefined) throw new Error(`the fake holds no job ${jobId}`);
      return answer(found);
    },
  };
}

/** The operations of the work gate over the world. */
export function gateOperations(world: FakeRowsWorld): ReturnType<typeof rowReads> & ReturnType<typeof rowWrites> & ReturnType<typeof pullOperations> {
  return { ...rowReads(world), ...rowWrites(world), ...pullOperations(world) };
}

/**
 * Seeds who applied `label` to row `number`: `actors` is a login per line, oldest first (`null` for an event whose actor is gone), or an `Error` for a history the code host cannot read. A test that holds the history of
 * several rows calls it once per row. The times are one minute apart and end `endingAt` (default: now).
 */
export function seedLabelHistory(world: FakeRowsWorld, { number, label, actors, endingAt = world.now() }: { number: number; label: string; actors: string | Error; endingAt?: number }): void {
  if (actors instanceof Error) {
    world.gate.events.set(number, actors);
    return;
  }
  const logins = actors.split("\n").filter((line) => line !== "");
  const kept = world.gate.events.get(number);
  const events = kept === undefined || kept instanceof Error ? [] : kept;
  logins.forEach((login, at) => events.push({ event: "labeled", label, actor: login === "null" ? null : login, at: new Date(endingAt - (logins.length - at) * 60_000).toISOString() }));
  world.gate.events.set(number, events);
}

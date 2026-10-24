// @ts-check
// module: the in-memory code host's operations for the audit section (A11-160, step 9)
//
// THEY ACT ON THE WORLD A TEST SEEDS (`FakeRowsWorld`) and ignore the `run` their caller hands them. The rows of the world's own repository are `world.rows` and its pull requests `world.pulls`; those of another repository the
// audit reads (a second declared tracker) are the foreign rows and pull requests a test seeds with `holdRepository` (`code-host-health.ts`), and a repository the world holds nothing for is a refused read, never an empty one:
// "could not ask" is not "nothing is open". A row's label history is the gate's (`world.gate.events`). What the audit reads beyond them (what the search index reports open, when a row was reopened, a repository's milestones,
// when a blocker edge was added) and what the tick writes (the heartbeat) is `world.tail.audit`. A refused read is `world.failures` naming the operation, or the operation on one repository (`<operation> <owner/name>`).
import type { ClosingReference, ListedIssue, ListedIssueField, ListedPull, ListedPullField, RowsAudit } from "../contracts/code-host-rows-audit.ts";
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { FakeRow, FakeRowPull, FakeRowsWorld } from "./code-host-rows.ts";

/** What a test seeds for this section beyond the world's rows and pull requests, and what the tick wrote. */
export type FakeAudit = {
  /** The numbers GitHub's search index reports open, by repository; absent is the open rows the world holds (the two agree). */
  reportedOpen: Map<string, number[]>;
  /** When a row was last reopened (ISO), by `owner/name#number`; absent is a row that never was. */
  reopenedAt: Map<string, string>;
  /** The milestones of a repository: their titles and descriptions, by `owner/name`; absent is a repository with none. */
  milestones: Map<string, { title: string; description: string | null }[]>;
  /** When a blocker edge was added (ISO), by `owner/name#holder->blocker`; absent is an edge with no event. */
  blockedByAdded: Map<string, string>;
  /** The repository variables the tick set, by `owner/name/VARIABLE`. (The comments it replaced the body of are `editComment`s of the world's rows.) */
  variables: Map<string, string>;
};

export const emptyAudit = (): FakeAudit => ({ reportedOpen: new Map(), reopenedAt: new Map(), milestones: new Map(), blockedByAdded: new Map(), variables: new Map() });

type Operations = Pick<CodeHostRows, keyof RowsAudit>;

const isHome = (world: FakeRowsWorld, repo: string): boolean => ["", "{owner}/{repo}", world.repo].includes(repo);

const foreignRowsOf = (world: FakeRowsWorld, repo: string): FakeRow[] => [...world.foreignRows].filter(([key]) => key.startsWith(`${repo}#`)).map(([, row]) => row);

/** Records the call (the operation and what it is about), then refuses it with the error the world holds for the operation, for all repositories or for `repo` alone. */
function asked(world: FakeRowsWorld, operation: string, repo: string, number?: number): void {
  world.calls.push(`${operation} ${repo}${number === undefined ? "" : `#${number}`}`);
  const refused = world.failures.get(`${operation} ${repo}`) ?? world.failures.get(operation);
  if (refused !== undefined) throw refused;
}

/** The rows of `repo`: the world's own, or those a test seeded for another repository (`holdRepository`). A repository the world holds nothing for is a refused read. */
function rowsOf(world: FakeRowsWorld, repo: string): FakeRow[] {
  if (isHome(world, repo)) return [...world.rows.values()];
  const foreign = foreignRowsOf(world, repo);
  if (foreign.length === 0 && !world.reports.health.foreignPulls.has(repo)) throw new Error(`the fake holds no rows of ${repo}`);
  return foreign;
}

function pullsOf(world: FakeRowsWorld, repo: string): FakeRowPull[] {
  if (isHome(world, repo)) return [...world.pulls.values()];
  const held = world.reports.health.foreignPulls.get(repo);
  if (held === undefined) throw new Error(`the fake holds no pull requests of ${repo}`);
  return held;
}

const rowNamed = (world: FakeRowsWorld, repo: string, number: number): FakeRow => {
  const row = rowsOf(world, repo).find((candidate) => candidate.number === number);
  if (row === undefined) throw new Error(`the fake holds no row ${repo}#${number}`);
  return row;
};

const stateOfPull = (pull: FakeRowPull): "OPEN" | "MERGED" | "CLOSED" => (pull.merged ? "MERGED" : pull.closedAt != null ? "CLOSED" : "OPEN");

/** The pull requests that resolve as closing `number` of `repo`. */
const closingPullsOf = (world: FakeRowsWorld, repo: string, number: number): FakeRowPull[] =>
  pullsOf(world, repo).filter((pull) => (pull.closes ?? []).some((closed) => closed.number === number && (closed.repo ?? repo) === repo));

/** The fields asked for of a row, projected from what the fake holds. */
function listedIssue(world: FakeRowsWorld, row: FakeRow, fields: readonly ListedIssueField[]): ListedIssue {
  const blockers = row.blockedBy.map((number) => ({ number, state: world.rows.get(number)?.state ?? "OPEN" }));
  const all: ListedIssue = { number: row.number, title: row.title, body: row.body, labels: [...row.labels], state: row.state, closedAt: row.closedAt, stateReason: world.misc.stateReasons.get(row.number) ?? null,
    ...(row.blockedByUnread === true ? {} : { blockedBy: { totalCount: blockers.length, nodes: blockers } }) };
  return Object.fromEntries(fields.filter((field) => field in all).map((field) => [field, all[field]]));
}

function listedPull(pull: FakeRowPull, fields: readonly ListedPullField[]): ListedPull {
  const all: ListedPull = { number: pull.number, body: pull.body, headRefName: pull.headRefName, mergedAt: pull.mergedAt };
  return Object.fromEntries(fields.map((field) => [field, all[field]]));
}

/** A row's `state` as GitHub's listing words it for `--state`: every row for `all`. */
const inState = (row: FakeRow, state: "open" | "closed" | "all"): boolean => state === "all" || row.state === state.toUpperCase();

/** Pull requests by `--state` as `gh pr list` has it: a closed pull request is one that closed without merging. */
const pullInState = (pull: FakeRowPull, state: "open" | "closed"): boolean => (state === "open" ? stateOfPull(pull) === "OPEN" : stateOfPull(pull) === "CLOSED");

/** What `references` reads for each number from the pull requests of `repo` that close it, or the first number the world holds no row for. */
function closingReferences(world: FakeRowsWorld, repo: string, numbers: number[]): { references: Map<number, ClosingReference[]> } | { unreadable: string } {
  const references = new Map<number, ClosingReference[]>();
  for (const number of numbers) {
    if (!rowsOf(world, repo).some((row) => row.number === number)) return { unreadable: `issue #${number} is missing from the closing-references response -- refusing to guess. Got: null` };
    references.set(number, closingPullsOf(world, repo, number).map((pull) => ({ number: pull.number, state: stateOfPull(pull), mergedAt: pull.mergedAt })));
  }
  return { references };
}

type Listings = Pick<Operations, "reportedOpenIssueNumbersOf" | "issueListingOf" | "pullListingOf" | "closingReferencesOf" | "latestReopenedAtOf" | "closingIssueReferencesOf">;
type Facts = Pick<Operations, "newestLabeledAtOf" | "newestCommentAtOf" | "milestoneDescriptionOf" | "blockedByAddedAtOf" | "stockTimelineEventsOf" | "rowLabelsAndStateOf" | "mergedClosersOf" | "closedAtOf">;
type Heartbeat = Pick<Operations, "writeHeartbeatVariable">;

/** The listings the audit walks and the reads of what closes what. */
function listings(world: FakeRowsWorld): Listings {
  const audit = world.tail.audit;
  return {
    reportedOpenIssueNumbersOf: ({ repo }) => {
      asked(world, "reportedOpenIssueNumbersOf", repo);
      return { numbers: audit.reportedOpen.get(repo) ?? rowsOf(world, repo).filter((row) => row.state === "OPEN").map((row) => row.number) };
    },
    issueListingOf: ({ repo, state, limit, fields, milestone }) => {
      asked(world, "issueListingOf", repo);
      const held = rowsOf(world, repo).filter((row) => inState(row, state) && (milestone === undefined || row.milestone?.title === milestone));
      return { rows: held.slice(0, limit).map((row) => listedIssue(world, row, fields)) };
    },
    pullListingOf: ({ repo, state, limit, fields }) => {
      asked(world, "pullListingOf", repo);
      return { rows: pullsOf(world, repo).filter((pull) => pullInState(pull, state)).slice(0, limit).map((pull) => listedPull(pull, fields)) };
    },
    closingReferencesOf: ({ repo, numbers }) => {
      asked(world, "closingReferencesOf", repo);
      return closingReferences(world, repo, numbers);
    },
    latestReopenedAtOf: ({ repo, numbers }) => {
      asked(world, "latestReopenedAtOf", repo);
      const missing = numbers.find((number) => !rowsOf(world, repo).some((row) => row.number === number));
      if (missing !== undefined) return { unreadable: `issue #${missing} is missing from the reopen-history response -- refusing to guess. Got: null` };
      return { reopenedAt: new Map(numbers.map((number) => [number, audit.reopenedAt.get(`${repo}#${number}`) ?? null])) };
    },
    closingIssueReferencesOf: ({ repo, numbers }) => {
      asked(world, "closingIssueReferencesOf", repo);
      const pulls = pullsOf(world, repo);
      const missing = numbers.find((number) => !pulls.some((pull) => pull.number === number));
      if (missing !== undefined) return { unreadable: `PR #${missing} is missing from the closing-issue-references response -- refusing to guess. Got: null` };
      return { references: new Map(numbers.map((number) => [number, (pulls.find((pull) => pull.number === number)?.closes ?? []).map((closed) => closed.number)])) };
    },
  };
}

/** The reads of one row, one milestone or one edge. */
function facts(world: FakeRowsWorld): Facts {
  const audit = world.tail.audit;
  return {
    newestLabeledAtOf: ({ repo, number, label }) => {
      asked(world, "newestLabeledAtOf", repo, number);
      const events = world.gate.events.get(number) ?? [];
      if (events instanceof Error) throw events;
      return events.filter((event) => event.event === "labeled" && event.label === label).at(-1)?.at ?? null;
    },
    newestCommentAtOf: ({ repo, number }) => {
      asked(world, "newestCommentAtOf", repo, number);
      return rowNamed(world, repo, number).comments.at(-1)?.createdAt ?? null;
    },
    milestoneDescriptionOf: ({ repo, title }) => {
      asked(world, "milestoneDescriptionOf", repo);
      return audit.milestones.get(repo)?.find((milestone) => milestone.title === title)?.description ?? null;
    },
    blockedByAddedAtOf: ({ repo, holder, blocker }) => {
      asked(world, "blockedByAddedAtOf", repo, holder);
      return audit.blockedByAdded.get(`${repo}#${holder}->${blocker}`) ?? null;
    },
    stockTimelineEventsOf: ({ repo, number }) => {
      asked(world, "stockTimelineEventsOf", repo, number);
      rowNamed(world, repo, number);
      const events = world.gate.events.get(number) ?? [];
      if (events instanceof Error) throw events;
      return events.map((event) => ({ event: event.event, created_at: event.at, label: { name: event.label } }));
    },
    rowLabelsAndStateOf: ({ repo, number }) => {
      asked(world, "rowLabelsAndStateOf", repo, number);
      const row = rowNamed(world, repo, number);
      return { labels: [...row.labels], state: row.state };
    },
    mergedClosersOf: ({ repo, number }) => {
      asked(world, "mergedClosersOf", repo, number);
      rowNamed(world, repo, number);
      return closingPullsOf(world, repo, number).filter((pull) => pull.merged && pull.mergedAt != null).map((pull) => ({ number: pull.number, mergedAt: pull.mergedAt as string }));
    },
    closedAtOf: ({ repo, number }) => {
      asked(world, "closedAtOf", repo, number);
      const at = Date.parse(String(rowNamed(world, repo, number).closedAt));
      return Number.isFinite(at) ? at : null;
    },
  };
}

/** The tick's heartbeat: what it wrote is `world.tail.audit`. */
function heartbeat(world: FakeRowsWorld): Heartbeat {
  const audit = world.tail.audit;
  return {
    writeHeartbeatVariable: ({ repo, variable, value }) => {
      asked(world, "writeHeartbeatVariable", repo);
      audit.variables.set(`${repo}/${variable}`, value);
    },
  };
}

export function auditOperations(world: FakeRowsWorld): Operations {
  return { ...listings(world), ...facts(world), ...heartbeat(world) };
}

// @ts-check
// module: the code host contract's optional `rows` group, version 1.8 -- row mode's GitHub operations (A11-160, steps 4 and 5)
//
// A TYPE FILE: it imports nothing at run time. ROW MODE USES GITHUB AS ITS TRACKER (rows are issues, `TicketPort` is implemented over them), its queue (project items and labels) and its code host, and a plugin
// serves one concern, so row mode's operations are an OPTIONAL member group of the code host contract rather than a second plugin (`docs/adr/0002-row-mode-github-is-an-optional-part-of-the-code-host-contract.md`).
// A code host without `rows` serves ticket mode only, and a row-mode entry refuses to start without it, by name (`src/plugins/rows.ts`).
//
// THE OPERATIONS ARE THE ONES `src/ticket-port/` HELD, MOVED UNCHANGED. Every one is made of GitHub's command language, and every one takes the `run` its caller hands it: the caller's own executor, which carries
// the policy the gate and wake keep for their reads (a timeout, the tick's memo and metering, a repository aim, the call census). Those callers move into this plugin in later steps of A11-160, and `run` is then
// dropped from the operations they were its last user of; until then the plugin owns what is asked of GitHub and how its answer is read, and core owns how a command is run. A read that failed THROWS, or answers
// `null` where its name says so: none returns an empty list for "could not ask".
//
// 1.8 (step 5): the callers that arm, guard and queue a merge moved (`arm-pr`, `auto-arm-sweep`, `merge-guard`, `merge-queue`, `pr-armed-state`), and what they asked of GitHub is a named operation now. `run` is OPTIONAL on
// them and on the arming operations of 1.7 they use: a caller that has not moved hands its own, and one that has hands none, so the code host runs `gh` itself (`ownRun` is the plugin's, for the callers still to move).
import type { Pool as PoolReading } from "../../api-pool.ts";
import type { ApiBudget, BlockerWriter, OpenItemsReader, PortEvent, TicketPort } from "../../ticket-port/port.ts";

/** One `gh` command line in, its text out, throwing as the command fails. The caller's: see the head of this file. */
export type RowsRun = (args: string[]) => string;

// --- the board, the labels and the helpers core hands the plugin ----------------------------------------------------------------------

/** The project's board, as the tracker block of its declaration names it. */
export type RowsTracker = Readonly<{ repo: string; board: Readonly<{ number: number; owner: string }> }>;

/**
 * What the plugin takes of core to build row mode's GitHub operations, since it imports core's types only (ADR 0001). It is asked when an operation needs it (`PluginDeps.rows` is a function), in two
 * parts: what any row read needs (how GitHub's rate-limit answers are read, the claim label, the error a window read throws), and what needs the project's declaration (its vocabulary and board, how a
 * row's body is read for the waits it declares). A host with no project declaration builds a code host that is never asked for the second.
 */
export type RowsHelpers = RowsReadHelpers & RowsProjectHelpers;

/** The part of {@link RowsHelpers} that reads nothing of the project. */
export type RowsReadHelpers = Readonly<{
  claimLabel: string;
  pool: Readonly<{
    /** The GraphQL pool's probe, as arguments. */
    probe: readonly string[];
    fromResponse(raw: string | null): PoolReading | null;
    rawResponse(args: readonly string[], run: RowsRun): string | null;
    fromRateLimitField(data: any): ApiBudget | null;
  }>;
  /** The error `readRowsSince` throws when a window is longer than the pages it may read: core's callers test for it with `instanceof`. */
  WindowCutShort: new (message: string) => Error;
}>;

/** The part of {@link RowsHelpers} that reads the project's declaration. */
export type RowsProjectHelpers = Readonly<{
  labels: Readonly<{ claim: string; ready: string; backlog: string; outOfRelease: string; answerPrefix: string; lanePrefix: string }>;
  board: Readonly<{ number: number; owner: string }>;
  homeTracker(): RowsTracker;
  waits: Readonly<{ parse(body: string | null | undefined): readonly Readonly<{ text: string }>[]; notBeforeDate(body: string | null | undefined): string | null }>;
}>;

// --- the ticket port's adapter -------------------------------------------------------------------------------------------------------

export type GithubAdapterOptions = {
  /** `gh`, as the gate runs it: one argument list in, stdout out, throwing on a refusal. */
  run: RowsRun;
  /** The repository the items are in, `owner/name`. */
  scope: string;
  /** The logins whose `priority:chairman` counts (decision 2): that rule lives in the adapter, not in a consumer. */
  chairmanLogins?: readonly string[];
  /** The board Status write. Defaults to the one call `row-claim.ts`'s `moveProjectStatus` makes; #490's cutover passes `moveProjectStatus` itself to keep its snapshot guard (#1275). */
  moveStatus?: (id: number, statusName: string) => void;
};

export type GithubTicketAdapter = TicketPort & OpenItemsReader & BlockerWriter & { publish(event: PortEvent): void };

// --- the reads and writes, by what they are about --------------------------------------------------------------------------------------

/** What the merge guard's approval rule reads off a pull request. */
export type ApprovalFacts = {
  /** Commits of the PR itself: in `head` and not in `main`. */
  ownShas: string[];
  /** Latest opinion of each reviewer, approvals only, each with the commit it was submitted on. */
  approvals: { reviewer: string; commitId: string;
    /** Commits in `commitId...head` (parents included), or null when `commitId` is not an ancestor of the head. */
    sinceApproval: { sha: string; parents: string[]; }[] | null; }[];
};

/** One review as the approval rule reads it. */
export type ApprovalReview = { reviewer: string; state: string; commitId: string; submittedAt: string; };

/** A comment of a tracker row as the key-bearing reads return it. */
export type KeyedComment = { id: number; body: string };
/** A review as GitHub's REST list returns it: `submitted_at`, not `submittedAt`. */
export type RestReview = { state?: string; submitted_at?: string | null };

/** The pull request's node id, whether it has merged, whether auto-merge is requested, and whether it sits in the merge queue. */
export type DisarmSeat = { id: string; merged: boolean; armed: boolean; queued: boolean };

/** A check run or a job as the REST bodies carry it: only what is read. */
export type CiJob = { name: string; conclusion: string | null; details_url?: string };

/** The workflow run behind a red check of a change's head, and that check's own conclusion. */
export type RedRun = { runId: number; conclusion: string | null };

/** The comment fields a reader of stops needs, as GitHub returns them. */
export type CommentRead = { body: string; created_at: string; issue_url: string };

/** An open incident issue as the consumer reads it: its number, title, creation time as ISO, and its body, which names the incident's kind. */
export type OpenIncidentRead = { number: number; title: string; createdAt: string; body: string; };

/** A closed incident issue as the consumer reads it: its number and its body, which carries the line the consumer finds it by. */
export type ClosedIncidentRead = { number: number; body: string; };

/** An open pull request as the prune's hold reads it: its number, its URL, its head branch, and the names of its labels. */
export type OpenPullHead = { number: number, url: string, headRefName: string, labels: string[] };
/** `read: false` carries the reason: a failed read is never an empty list, because "could not read" is not "nothing is open". */
export type OpenPullHeads = { read: true, pulls: OpenPullHead[] } | { read: false, reason: string };

/** An open pull request as the consumer reads it: its number in its repository, and its body, which names the rows it closes. */
export type OpenPullRead = { number: number; body: string; };

/** One merge-queue entry. `headSha` is the group's head commit and `pull`/`pullId` the pull request: each `null` where GitHub gave none (a deleted pull request, a group not yet built). */
export type QueueEntry = { state: string; enqueuedAt: string; position: number; headSha: string | null; pull: number | null; pullId: string | null };

/** Runs the tracker's CLI with these arguments and returns its stdout. The caller supplies the spawn. */
export type ReadGh = (args: string[]) => string;

/** The facts the merge guard needs about a PR that closes a Tests-first row, every list of repository-relative paths. */
export type TestsFirstFacts = {
  /** The test files the closed rows name. */
  paths: string[];
  /** Files the PR's FIRST commit touches. */
  firstCommitFiles: string[];
  /** Files that differ between the first commit and the head. */
  changedSinceFirst: string[];
  /** Reviewers, other than the author, who approved with the line AND read what will merge. */
  approvedBy: string[];
};

export type LabelledRead = {
  label: string;
  state: "OPEN" | "CLOSED";
  /** The GraphQL selection of each issue node, e.g. `number body`. */
  select: string;
  run: RowsRun;
  /** `owner/name`; absent reads the repository the working directory belongs to (`gh` fills `{owner}` and `{repo}`). */
  repo?: string;
  /** At most this many NEWEST rows, and no refusal when there are more; absent reads them all and refuses a population it cannot hold. */
  newest?: number;
  log?: (line: string) => void;
};

export type ClaimedRow = { number: number; body: string; labels: { name: string; }[]; blockedBy: { nodes: { number: number; }[]; }; };

export type SinceRead = {
  kind: "issues" | "pullRequests";
  states: readonly ("OPEN" | "CLOSED" | "MERGED")[];
  /** Only the rows carrying this label (`labels:[$label]`), which is how a by-label list is asked of an asynchronous `run` (`messaging/watch.ts`). */
  label?: string;
  /** The field the connection is ordered by, newest first, and the one `since` is compared with. */
  orderBy: "CREATED_AT" | "UPDATED_AT";
  /** `owner/name`. */
  repo: string;
  /** The GraphQL selection of each node, e.g. `number mergedAt`. The order field is added to it. */
  select: string;
  /** Keep the rows whose order field is at or after this time (ISO date or date-time) and refuse a window of more than the default pages. */
  since?: string;
  /** Or: at most this many NEWEST rows, and no refusal when there are more (`gh ... --limit N`'s own meaning). One of `since` and `newest` is required. */
  newest?: number;
  /** Pages beyond the default, for a window the caller has measured to be long (a ledger of a month of merges). */
  maxPages?: number;
};

export type Page = { nodes: any[]; hasNextPage: boolean; endCursor: string | null; };

// --- merging and arming (A11-160, step 5) ----------------------------------------------------------------------------------------------

/** A request about one pull request or row of `repo`. `run` is the caller's own executor while the caller has not moved, or absent: the code host runs `gh` itself. */
export type At<Request> = Request & { run?: RowsRun };

/** A pull request node as the armed rule reads it: merged, auto-merge requested, or sitting in the merge queue. */
export type ArmedNode = { merged?: boolean; autoMergeRequest?: unknown; mergeQueueEntry?: unknown } | null;

/** An open pull request as the sweep reads it: what the armed rule decides on, and whether it is a draft. */
export type OpenPullNode = { number: number | string; isDraft?: boolean } & NonNullable<ArmedNode>;

/** Whether a pull request was ejected from the merge queue for a failed queue run with its head unmoved since, and when. */
export type QueueEjection = { ejected: boolean; removedAt: string | null };

/** What `arm-pr` reads of a pull request before it arms it. */
export type ArmingPullRead = { labels: string[]; body: string | null; state: string | null; author: string | null };

/** A pull request's seat in the merge queue. */
export type QueueSeat = { id: string; headRefOid: string; mergeStateStatus: string; mergeQueueEntry: { position: number; state: string } | null };

/** What the sweep reads of one candidate pull request. */
export type SweepFacts = { labels: string[]; author: string; prBody: string; head: string; checkRunCount: number };

/** A check run as the merge guard reads it. */
export type GuardCheckRun = { id: number; name: string; status: string; conclusion: string | null; completedAt: string | null };

/** A row a pull request would close, with its labels. */
export type ClosingIssue = { number: number; repo?: string; title?: string; labels: string[] };

/** A recent pull request with its body and the rows GitHub resolves it as closing. */
export type RecentClosesPull = { number: number; body: string; resolved: number[] };

/** A pull request as the merge guard's readiness check reads it. `state` is GitHub's own word for it. */
export type GuardPullRead = {
  pr: { number: number; state: string; baseRefName: string; headRefOid: string; headRefName: string };
  /** `null` when the answer carries no list of labels. */
  prLabels: string[] | null;
  body: string;
  author: string | null;
};

/** A pull request's state and when it merged and closed. */
export type OutcomeRead = { state: string; mergedAt: string | null; closedAt: string | null };

/** The open pull request of a branch. `reviewDecision` is `null` when the answer carries no such field. */
export type BranchPull = { number: number; armed: boolean; headRefOid: string; reviewDecision: string | null };

/** An open pull request as the merge queue's dispatcher reads readiness off it. */
export type QueuePull = {
  number: number; title?: string; headRefName: string; mergeable: string; mergeStateStatus: string; isDraft: boolean;
  statusCheckRollup?: { conclusion?: string; name?: string }[] | null;
};

/** The seams of the arm: the sleep between reads of a pull request that may have settled, how many reads, how far apart, and where a read that failed is said. */
export type ArmMergeSeams = { sleep?: (ms: number) => unknown; attempts?: number; intervalMs?: number; error?: (line: string) => void };

// --- the group ----------------------------------------------------------------------------------------------------------------------

/**
 * Row mode's GitHub operations (contract 1.7). Each is the function `src/ticket-port/<file>.ts` held, with its file named in its comment; `src/ticket-port/` keeps a delegating copy of each so a caller's import
 * does not change, and the delegates call the activated code host's `rows`.
 */
export interface CodeHostRows {
  /**
   * How the operations act. `through-run`: on the `run` their caller hands them, which carries the caller's policy (the GitHub plugin's, until the callers move into it). `on-its-own-state`: on
   * the host's own state, ignoring `run`, which is what a fake does. The contract suite asks a refused `run` of the first and has nothing to refuse in the second.
   */
  readonly acts: "through-run" | "on-its-own-state";
  /** The kind of tracker the adapter's items belong to: `ItemRef.tracker`. */
  readonly tracker: string;
  /** How many rows a connection page holds, which a caller sizing a window by pages needs. */
  readonly sincePageSize: number;
  /** How many project items a page of an issue's board membership holds. */
  readonly projectItemsPage: number;
  /** The query the adapter's open-items read sends, for a test that holds it to GitHub's GraphQL pool. */
  readonly openItemsQuery: string;
  /** The core pool's probe, as arguments: `gh api user -i`. */
  readonly corePoolProbe: readonly string[];

  /** The GitHub adapter of the ticket port (`github-adapter.ts`): the four operations ADR 0046 rules, the bulk open-items read and the blocker edge. */
  ticketAdapter(options: GithubAdapterOptions): GithubTicketAdapter;

  latestApprovals(reviews: ApprovalReview[]): ApprovalReview[];
  /** What `approvalHeadReasons` needs for pull request `number` of `repo`, or `null` for "could not ask": never "covered", never "no approvals". */
  approvalFactsOf(pull: { repo: string; number: number; head: string }, run?: RowsRun): ApprovalFacts | null;

  /** The comments of row `row` made since `since` whose body starts with `marker`: one paginated REST read. */
  keyedCommentsOf(request: { repo: string; row: number; marker: string; since: string; run: RowsRun }): KeyedComment[];
  postRowComment(request: { repo: string; row: number; body: string; run: RowsRun }): void;
  /** Files a new row in `repo` with `labels` and answers its number; a create that prints no row URL is thrown. */
  createRow(request: { repo: string; title: string; labels: string[]; body: string; run: RowsRun }): number;
  editComment(request: { repo: string; id: number; body: string; run: RowsRun }): void;
  reviewsOf(request: { repo: string; number: number; run: RowsRun }): RestReview[];
  /** The most recently updated `window` merged pull requests of `repo`, each with its approving reviews and merge-queue entries, in one GraphQL read. */
  mergedWindowOf(request: { repo: string; window: number; run: RowsRun }): unknown;
  /** The open pull requests of `repo` with the JSON fields `fields` names (`approved-unqueued-reads.ts`'s `openPullsOf`). */
  openPullFieldsOf(request: { repo: string; fields: string; run: RowsRun }): unknown;

  readDisarmSeat(request: At<{ number: string; repo: string }>): DisarmSeat;
  disableAutoMergeOf(request: At<{ number: string; repo: string }>): void;

  /** Boards a filed row: the card (only when the issue is not on the board at all), its Status, then its labels last. */
  boardFiledRow(request: { repo: string; number: number; owner: string; projectNumber: number; status: string; labels: string[]; run: RowsRun }): void;

  briefChairmanOnPull(request: { repo: string; number: number; label: string; body: string; run: RowsRun }): void;

  headOfChange(repo: string, number: string | number, run: RowsRun): string;
  checkRunsOfHead(repo: string, head: string, run: RowsRun): { checks: CiJob[]; total: number };
  workflowRunsOf(repo: string, workflow: string, eventFilter: string, run: RowsRun): any[];
  jobsOfRun(repo: string, runId: string | number, run: RowsRun): CiJob[];
  failedLogOfRun(repo: string, runId: string | number, run: RowsRun): string;
  /** `OPEN` or `CLOSED` (upper-cased), or `""` for an answer that carries no state. */
  stateOfRow(repo: string, number: string | number, run: RowsRun): string;
  redRunOfHead(repo: string, number: string | number, head8: string, run: RowsRun): RedRun | null;
  rerunFailedJobsOf(repo: string, runId: string | number, run: RowsRun): void;

  closeRowWithComment(request: { row: number; repo: string; comment: string; run: RowsRun }): void;

  /** Every comment of `repo` made at or after `since`, or `null` for "could not ask". `run` returns what `gh api --paginate --slurp` printed, parsed. */
  commentsSince(request: { repo: string; since: number; run: (args: string[]) => unknown[] | null }): CommentRead[] | null;

  /** One GET of a REST `path`, with its headers and the status line, as the gate's conditional reads send it. */
  conditionalGetArgs(path: string, etag: string | null): string[];
  /** One pull request's detail, asking the fields `fields` names. */
  pullViewArgs(number: number, fields: string): string[];

  pullTextOf(repo: string, number: number | string, run: RowsRun): string;
  branchRefTextOf(repo: string, branch: string, run: RowsRun): string;
  addedFilesTextOf(repo: string, number: number | string, run: RowsRun): string;
  fileAtTextOf(repo: string, path: string, ref: string, run: RowsRun): string;
  defaultBranchFileTextOf(repo: string, path: string, run: RowsRun): string;

  commentOnIssue(request: { repo: string; issue: number; body: string; run: RowsRun }): void;

  openIncidentsOf(repo: string, run: RowsRun): OpenIncidentRead[] | null;

  readOpenPullHeads(repo: string, run: RowsRun, limit: number): OpenPullHeads;

  /** The open pull requests of `repo` with their bodies, or `null` for "could not ask" (`open-pulls.ts`'s `openPullsOf`). */
  openPullBodiesOf(repo: string, run: RowsRun): OpenPullRead[] | null;

  outsideArmListArgs(repo: string, limit: number): string[];
  readyPullRequest(request: At<{ number: number; repo: string; undo?: boolean }>): void;

  ensureTriageLabel(request: { repo: string; label: string; description: string; run: RowsRun }): void;

  isIssueOnBoard(issueNumber: number, options: { read: ReadGh; tracker?: RowsTracker }): boolean;
  boardItemOf(issueNumber: number, read: ReadGh, tracker: RowsTracker): any | undefined;

  pullRequestFieldsOf(request: { repo: string; number: number; fields: string; run: RowsRun }): Record<string, any> | null;

  queueEntriesOf(request: { repo: string; branch: string; run: RowsRun }): QueueEntry[];
  mergeGroupRunCountOf(request: { repo: string; sha: string; run: RowsRun }): number;
  dequeuePullRequestOf(request: At<{ pullId: string }>): void;

  jobLogOf(repo: string, jobId: number, run: RowsRun): string;
  closedIncidentsOf(repo: string, run: RowsRun): ClosedIncidentRead[] | null;
  createIncident(tracker: string, incident: { title: string; body: string }, run: RowsRun): void;
  closeIncident(tracker: string, number: number, comment: string, run: RowsRun): void;

  /** For a test: a fresh process, which asks again what a limit refused. */
  forgetRefusedReads(): void;
  isRowsByLabelRead(args: readonly string[]): boolean;
  /** Any GraphQL list read of the tick, under the one refusal memory: a refusal for a limit stops the rest of the tick's asking and names the resource. */
  readUnlessRefused<T>(request: { what: string; run: RowsRun; log?: (line: string) => void; read: () => T }): T;
  /** The rows of one tracker in `state` that carry `label`, each as the `select` asked, or a THROW when they could not be read whole. */
  readRowsByLabel(ask: LabelledRead): any[];
  /** Every open row that is `in-progress`, with body, labels and `blockedBy` edges. Throws when the list could not be read whole. */
  readClaimedRows(request: { run: RowsRun; repo?: string; log?: (line: string) => void }): ClaimedRow[];

  /** The `gh` arguments of one page of a window read. */
  sincePageArgs(ask: SinceRead, after: string | null): string[];
  isSinceRead(args: readonly string[]): boolean;
  /** One page, parsed. A payload that is not a connection THROWS: "could not read" is never an empty page. */
  parsePage(raw: string, ask: SinceRead): Page;
  /** Folds one page into the rows so far; `next` is the cursor of the page still to read, or `null` when the read is whole. Throws the helpers' `WindowCutShort` when the window is too long. */
  foldPage(request: { ask: SinceRead; rows: any[]; page: Page; pagesRead: number }): { rows: any[]; next: string | null };
  readRowsSince(request: { ask: SinceRead; run: RowsRun; log?: (line: string) => void }): any[];
  /** A node in the shape `gh <kind> list --json` gave: a connection property (`{ nodes: [...] }`) is its array. */
  asListJson(node: Record<string, unknown>): Record<string, unknown>;
  /** The pull requests merged, with the fields asked, in `gh pr list --json` shape. */
  readMergedPullRequests(request: { repo: string; select: string; run: RowsRun; window: { since: string; maxPages?: number } | { newest: number }; base?: string }): Record<string, unknown>[];

  /** The facts for PR `number` of `repo` closing `rows`, or `undefined` when no row names a test file. Throws when a read is refused or an answer does not parse. */
  testsFirstReadsOf(request: {
    repo: string; number: number; head: string; author: string | null; rows: { repo: string; number: number }[];
    pathsOf: (rowBody: string) => string[]; isApproval: (reviewBody: string) => boolean;
  }, run?: RowsRun): TestsFirstFacts | undefined;

  // --- merging and arming (contract 1.8, A11-160 step 5). The operations of the files that arm a pull request, guard its merge and run the queue. ---

  /**
   * THE PLUGIN'S OWN `gh`, for the callers of the rows that have not moved yet and hold no `run` of their own (the merge guard's `lookups.gh`, which row claims and sweeps import, and the verdicts the arming
   * path hands one). TRANSITIONAL: it goes with the last of them, in the last step of A11-160. A fake has no `gh`, and its `ownRun` throws.
   */
  readonly ownRun: RowsRun;

  /** The `gh` arguments that ask whether one pull request is armed (`approved-unqueued.ts` runs them through its own `run`). */
  armedQueryArgs(pr: { number: string | number; repo: string }): string[];
  /** PURE. Is the pull request armed, given the armed query's node: merged, auto-merging, or sitting in the merge queue? */
  armedFromApi(node: ArmedNode): boolean;
  /** PURE. Which of the three armed states it is in, or `null` when nobody has armed it. */
  armedReason(node: ArmedNode): string | null;
  /** The armed query's node for one pull request. Throws when the read is refused. */
  armedNodeOf(request: At<{ number: string | number; repo: string }>): ArmedNode;
  /** Why the pull request needs no arm, or `null` when nobody has armed it. Throws when the read is refused. */
  armedReasonOf(request: At<{ number: string; repo: string }>): string | null;
  /** The `gh` arguments that ask for a pull request's merge-queue history. */
  ejectionQueryArgs(pr: { number: string | number; repo: string }): string[];
  /** PURE. Was the pull request ejected from the queue for failed checks with its head unmoved since? `null` is "the answer carried no history", never "not ejected". */
  queueEjectionOf(pr: { mergeQueueEntry?: unknown; timelineItems?: { nodes?: unknown } } | null): QueueEjection | null;
  /** The merge queue's history of one pull request: `null` when the answer carries none. Throws when the read is refused. */
  readQueueEjection(request: At<{ number: string | number; repo: string }>): QueueEjection | null;

  /** PURE. The numbers of a row's open blockers from its blocked-by edges, or `null` for a list that cannot be trusted whole. */
  openBlockersOf(row: { blockedBy?: { nodes?: unknown; totalCount?: unknown } } | null): number[] | null;
  /** The open blockers of one row, or `null` for a list that cannot be trusted whole. Throws when the read is refused. */
  openBlockersOfRow(request: At<{ repo: string; number: number }>): number[] | null;
  /** The labels of one row. Throws when the read is refused. */
  labelsOfRow(request: At<{ repo: string; number: number }>): string[];
  /** The bodies of the comments already on a pull request. Throws when the read is refused or the answer carries no list. */
  readPullComments(request: At<{ repo: string; number: string | number }>): { body: string }[];
  commentOnPull(request: At<{ repo: string; number: string | number; body: string }>): void;
  addLabelsToPull(request: At<{ repo: string; number: string; labels: readonly string[] }>): void;
  /** The labels, body, state and author `arm-pr` decides on. Throws when the read is refused. */
  readPullForArming(request: At<{ repo: string; number: string }>): ArmingPullRead;
  /** The state of a pull request (`OPEN`, `MERGED`, `CLOSED`), or `null` for an answer that carries none. Throws when the read is refused. */
  pullStateOf(request: At<{ repo: string; number: string }>): string | null;
  /** The write: requests auto-merge (merge commit). Its success is not the evidence that it took. Throws when refused. */
  armPullAuto(request: At<{ repo: string; number: string | number }>): void;
  /** Why a pull request in `state` has nothing left to arm, or `null` when it is open or its state is unknown. */
  settledReason(state: string | null): string | null;
  /**
   * Arms the merge, and when GitHub refuses, asks whether the pull request settled or was armed meanwhile before believing the refusal. `armed: false` carries why nothing was left to arm. Throws a refusal
   * that nothing explains. This is the procedure `CodeHost.armMerge` is built on.
   */
  armMergeOf(request: At<{ number: string; repo: string }>, seams?: ArmMergeSeams): { armed: boolean; reason: string };
  /** One page of the trunk workflow's runs on `main`, newest first. Throws when the read is refused. */
  trunkRunsPage(request: At<{ repo: string; workflow: string; page: number; perPage: number }>): any[];
  readQueueSeat(request: At<{ repo: string; number: string }>): QueueSeat;
  /** The write: enqueues the pull request with node id `id` at the front of the merge queue, expecting its head to be `headOid`. */
  jumpToFront(request: At<{ id: string; headOid: string }>): void;
  /** The command a person runs to take a pull request out of the merge queue by hand. */
  dequeueByHandCommand(id: string): string;
  /** The GraphQL pool as the arming credential reads it, or `null` when the answer carries no headers. Never throws. */
  graphqlPoolOf(run?: RowsRun): PoolReading | null;

  /** The `gh` arguments that list the open pull requests against `main` with the armed rule's fields. */
  openPullRequestsQueryArgs(repo: string): string[];
  /** Those pull requests as nodes. Throws when the read is refused. */
  readOpenPullNodes(request: At<{ repo: string }>): OpenPullNode[];
  isMergedPull(request: At<{ repo: string; number: string }>): boolean;
  isArmedPull(request: At<{ repo: string; number: string }>): boolean;
  readSweepFacts(request: At<{ repo: string; number: string }>): SweepFacts;
  /** Whether the head is in a fork, or `null` when that could not be read. */
  isCrossRepositoryPull(request: At<{ repo: string; number: string }>): boolean | null;
  /** The open pull requests with the fields the outside home of arming decides on. Throws when the read is refused. */
  readOutsideArmListed(request: At<{ repo: string; limit: number }>): unknown;

  requiredContextsOf(request: At<{ repo: string }>): string[] | null;
  checkRunsOfCommit(request: At<{ repo: string; sha: string }>): GuardCheckRun[];
  mainTipDateOf(request: At<{ repo: string }>): string | null;
  behindByOf(request: At<{ repo: string; head: string }>): number | null;
  closingIssuesOf(request: At<{ repo: string; number: number }>): ClosingIssue[];
  recentClosesPrsOf(request: At<{ repo: string }>): RecentClosesPull[];
  pullForGuard(request: At<{ repo: string; number: number }>): GuardPullRead;
  pullForCiGate(request: At<{ repo: string; number: number }>): GuardPullRead;
  pullOutcomeOf(request: At<{ repo: string; number: number }>): OutcomeRead;
  openPullsOfBranch(request: At<{ repo: string; branch: string }>): BranchPull[];

  openPullsForQueue(request?: { run?: RowsRun }): QueuePull[];
  mergeQueuedPull(request: At<{ number: number }>): string;
  compareWithMain(request: At<{ repo: string; branch: string }>): { ahead_by?: number; commits?: { sha: string; commit?: { message?: string } }[] };
  deleteBranchOf(request: At<{ repo: string; branch: string }>): void;
}

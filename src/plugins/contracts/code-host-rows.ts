// @ts-check
// module: the code host contract's optional `rows` group, version 1.12 -- row mode's GitHub operations (A11-160, steps 4 to 9)
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
//
// 1.12 (step 9): the last callers moved, in seven sections of their own files (`code-host-rows-pullwork.ts`, `-audit`, `-closing`, `-classes`, `-queue`, `-readouts`, `-plumbing`), which `CodeHostRows` extends.
//
// 1.11 (step 8): the board's reads and posts, the health and retro readings, the DORA reader, the trace's reads and the chairman's watch and answers moved (see the sections at the end of the group). A caller that RUNS `gh` itself and keeps
// its own policy (a bound, a buffer, a directory, a refusal of some argument lists) asks the code host for a runner with that policy (`runnerWith`, `asyncRunnerWith`): the process is the code host's.
//
// 1.10 (step 7): wake, the claim and the filing of rows moved (see the three sections at the end of the group), and what they asked of GitHub is a named operation now, on the `run` each caller hands it where it has one.
//
// 1.9 (step 6): the work gate moved (`src/work-gate/`), and what it asked of GitHub is a named operation now, on the `run` the gate hands each: the gate's EXECUTOR (the tick's memo, its budget, the bound on a call, the
// repository a call is aimed at) stays core's, and the process it starts is the plugin's (`gateRun`, `runTogether`).
import type { Pool as PoolReading } from "../../api-pool.ts";
import type { AnsweringRun, AsyncRowsRun, BlockerRead, BranchedPullState, ClosingPullRead, CommandRun, CrossReferencingPull, LabelEvent, LabelEventRead, MarkedComment, MilestoneRead, OpenPullFiles, OpenPullReview, PullCommit, PullState, RestCommentsRead, RestRow, RestRowRead, RoadmapFieldRead, RoadmapItemRead, RowFacts, RowShapeFacts, RunAnswer, RunnerRequest, TierFacts } from "./code-host-rows-facts.ts";
import type { ApiBudget, BlockerWriter, OpenItemsReader, PortEvent, TicketPort } from "../../ticket-port/port.ts";
import type { RowsPullwork } from "./code-host-rows-pullwork.ts";
import type { RowsAudit } from "./code-host-rows-audit.ts";
import type { RowsClosing } from "./code-host-rows-closing.ts";
import type { RowsClasses } from "./code-host-rows-classes.ts";
import type { RowsQueue } from "./code-host-rows-queue.ts";
import type { RowsReadouts } from "./code-host-rows-readouts.ts";
import type { RowsPlumbing } from "./code-host-rows-plumbing.ts";

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

// --- the work gate (A11-160, step 6) ---------------------------------------------------------------------------------------------------

/** The gate's executor: one `gh` command line in, stdout out, throwing as the command fails, and aimed at `repo` (`GH_REPO`) when it names one. */
export type AimedRun = (args: string[], repo?: string) => string;

/** What the gate's `gh` is made with: the bound on a call, and whether its stderr is CAPTURED on the error (a read whose refusal is an answer the caller handles) and not let through to the process's own. */
export type GateRunOptions = { timeoutMs: number; capture: boolean };

/** One call of a batch: its arguments and the repository it is aimed at (`undefined` is the executor's own). */
export type BatchCall = { args: string[]; repo: string | undefined };

/** One call's answer in a batch: its output, or the refusal as `execFileSync` would have thrown it (`code: "ETIMEDOUT"` for a call cut at its bound). */
export type BatchAnswer = { stdout: string } | { failed: true; stdout: string; stderr: string; status: number | null; code?: string };

/** What the gate reads to know which checks can block a merge on `main`: the contexts, or `null` and the report of why no source gave any. */
export type RequiredContexts = { contexts: string[]; diagnosis?: undefined } | { contexts: null; diagnosis: string };

/** An Actions job as the gate reads whether it ever got a runner: its conclusion, the runner it ran on and how many steps it ran. */
export type ActionsJob = { conclusion: string | null; runner_name: string; steps: number };


/** A closed row or pull request that carries an answer label, in the shape `gh` gave (`labels` an array). */
export type ClosedLabelledRow = { number: number; title: string; state: string; isDraft?: boolean; labels: { name: string }[] };

// --- the group ----------------------------------------------------------------------------------------------------------------------

/**
 * Row mode's GitHub operations (contract 1.7). Each is the function `src/ticket-port/<file>.ts` held, with its file named in its comment; `src/ticket-port/` keeps a delegating copy of each so a caller's import
 * does not change, and the delegates call the activated code host's `rows`.
 */
export interface CodeHostRows extends RowsPullwork, RowsAudit, RowsClosing, RowsClasses, RowsQueue, RowsReadouts, RowsPlumbing {
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
  /** Replaces the body of comment `id` of `repo` (any comment of a row) with `body`. THROWS when the write is refused. From `approved-unqueued.ts` (the day's reading), `work-tick.ts` (the tick's record and its standing heartbeat comment) and `tracker-comment.ts` (a tracker comment's replacement). */
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

  commentOnIssue(request: { repo: string; issue: number | string; body: string; run: RowsRun }): void;

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
  /** {@link CodeHostRows.readRowsSince} for a caller that holds an ASYNC `run` (the chairman's watch, contract 1.11): every page through that run, the rows in the shape `gh <kind> list --json` gave. REJECTS as the run does, and as the window is cut short. */
  readRowsSinceAsync(request: { ask: SinceRead; run: AsyncRowsRun }): Promise<any[]>;
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
  // --- the work gate (contract 1.9, A11-160 step 6). Every one takes the `run` the gate hands it, builds the argument list the gate built, and THROWS when the read is refused unless it says `null`. ---

  /**
   * THE GATE'S EXECUTOR'S PROCESS: `gh`, run to completion or cut at the bound (a call that hits it throws with `code: "ETIMEDOUT"`), aimed at the repository the call names. The gate wraps it in its memo and its budget; the
   * plugin starts the process. A fake has no `gh`, and its `gateRun` throws.
   */
  gateRun(options: GateRunOptions): AimedRun;
  /** Several calls started at once, so they wait together: one answer per call, in order. THROWS when the batch did not finish (the caller then runs its calls one by one). A fake has no `gh`, and its `runTogether` throws. */
  runTogether(request: { calls: BatchCall[]; env: NodeJS.ProcessEnv; callMs: number; graceMs: number; maxBuffer: number }): BatchAnswer[];

  /** The `unlabeled` events of a row: which label, and when. */
  unlabeledEventsOf(request: { repo: string; number: number; run: RowsRun }): { name: string; at: string }[];
  /** When `label` was applied to a row (ISO times, oldest first); `repo` absent is the repository the call is aimed at. */
  labeledEventTimesOf(request: { repo?: string; number: number; label: string; run: RowsRun }): string[];
  /** The login that applied `label` LAST, or `null` when no event shows one. */
  newestLabellerOf(request: { number: number; label: string; run: RowsRun }): string | null;
  /** A row's comments as the chairman's check reads them: author, time, and the first 200 characters. */
  commentActivityOf(request: { number: number; run: RowsRun }): { author: string; at: string; body: string }[];
  /** A row's `labeled`, `unlabeled` and `commented` events, projected to what the answer checks read. */
  rowTimelineOf(request: { repo: string; number: number; run: RowsRun }): { event: string; label?: { name: string }; actor?: string; id?: number; created_at: string }[];
  /** An item a wait names, as GitHub states it for the fields a wait reads. */
  waitRefOf(request: { repo: string; number: number; run: RowsRun }): { state?: string; closed_at?: string | null; updated_at?: string | null; merged_at?: string | null; labels?: string[] };
  /** The incident item `ref` (`#889` or `owner/repo#889`) names. */
  incidentItemOf(request: { ref: string; run: RowsRun }): { open: boolean; labels: string[]; body: string };
  rowBodyOf(request: { number: number; run: RowsRun }): string;
  /** A row's state and its NEWEST comment, or `null` when the row could not be read whole. Never throws. */
  rowStateAndNewestComment(request: { repo: string; number: number; run: RowsRun }): { state: string; lastComment: { body: string; createdAt: string } | null } | null;
  /** The facts a `Ready-when-unblocked` promotion decides on. */
  rowForPromotion(request: { repo: string; number: number; run: RowsRun }): { labels: string[]; state: string; body: string; blockedBy: { nodes?: { number?: number; state?: string }[] } };
  /** One page of the tracker's issue events, newest first, as the milestone clock reads them (GitHub's parse: the gate refuses what is not a list). */
  issueEventsPage(request: { repo: string; page: number; pageSize: number; run: RowsRun }): unknown;
  /** One page of `repo`'s closed pull requests, most recently updated first, as the milestone clock reads them. */
  closedPullsPage(request: { repo: string; page: number; pageSize: number; run: RowsRun }): unknown;
  /** Whether a tag exists on `repo`, or `null` when the read failed. Never throws. */
  tagExistsOn(request: { repo: string; tag: string; run: RowsRun }): boolean | null;
  /** The last `last` comments of each named row in ONE call, or `null` when the call was refused or its answer is not whole. Never throws. */
  newestCommentsOf(request: { repo: string; numbers: number[]; last: number; run: RowsRun }): Map<number, any[]> | null;
  /** The `limit` most recently updated closed rows, under the tick's refusal memory, or `null` when the answer carries none. */
  recentlyClosedRowsOf(request: { limit: number; run: AimedRun }): { number: number; closedAt: string | null; updatedAt: string | null }[] | null;

  /** Comments on row `number`. */
  commentOnRow(request: { number: number | string; body: string; aim?: string; run: AimedRun }): void;
  /** The bodies of the comments already on row `number`. */
  commentBodiesOfRow(request: { number: number | string; run: RowsRun }): string[];
  addLabelToRow(request: { number: number | string; label: string; run: RowsRun }): void;
  removeLabelFromRow(request: { number: number | string; label: string; run: RowsRun }): void;
  setRowBody(request: { number: number | string; body: string; run: RowsRun }): void;
  ensureLabel(request: { name: string; description: string; run: RowsRun }): void;
  /** Files a row with one label and answers what `gh` printed (the new row's URL). */
  fileLabelledRow(request: { title: string; label: string; body: string; run: RowsRun }): string;
  /** Adds a label through the labels endpoint, which creates a label that does not exist yet. */
  addLabelToRowByApi(request: { repo: string; number: number; label: string; run: RowsRun }): void;
  markPullReady(request: { number: number | string; repo?: string; run: RowsRun }): void;
  addRowToProject(request: { owner: string; projectNumber: number; url: string; run: RowsRun }): void;
  setProjectStatus(request: { owner: string; projectNumber: number; url: string; status: string; run: RowsRun }): void;

  /** Which checks can block a merge on `main`: the rulesets first, branch protection when they give nothing. Never throws. */
  readRequiredContexts(request: { run: RowsRun; repo?: string }): RequiredContexts;
  /** `main`'s tip commit and committer date as GitHub states them, or `null` for an answer that is not JSON. */
  mainTipOf(request: { run: RowsRun }): { sha?: unknown; date?: unknown } | null;
  /** Every pull request opened from `branch` in any state, or `null` when the answer is not a list. */
  pullsOfBranch(request: { branch: string; limit: number; run: RowsRun }): { number: number; state: string }[] | null;
  /** The newest 100 merged pull requests, or `null` when the answer is not a list. */
  newestMergedPulls(request: { run: RowsRun }): { number: number; headRefName: string; mergedAt: string; title: string; labels: { name: string }[] }[] | null;
  /** The arguments that list the open pull requests with the JSON fields named: the gate runs them through its own executor. */
  openPullListArgs(limit: number, fields: string): string[];
  pullFileNamesOf(request: { number: number; run: RowsRun }): string[];
  commitShasOf(request: { repo: string; number: number; run: RowsRun }): string[];
  compareDiffOf(request: { repo: string; base: string; head: string; run: RowsRun }): string;
  failingCheckNamesAt(request: { repo: string; commit: string; run: RowsRun }): string[];
  checkRunSummariesAt(request: { repo: string; commit: string; run: RowsRun }): { id: number; name: string; summary: unknown }[];
  mergeGroupRunsOf(request: { repo: string; withConclusion: boolean; run: RowsRun }): { id: number; head_branch: string; conclusion?: string | null; created_at: string }[];
  jobsOfMergeGroupRun(request: { repo: string; runId: number; run: RowsRun }): ActionsJob[];
  actionsJobOf(request: { repo: string; jobId: string; run: RowsRun }): ActionsJob;
  /** The open rows, newest `limit`, with the JSON fields named. THROWS when the answer parses but is not a list. */
  openRowsOf(request: { limit: number; fields: string; run: RowsRun }): any[];
  /** The repository's labels that start with `prefix`, or `null` when the answer is not a list. */
  labelNamesWithPrefix(request: { prefix: string; run: RowsRun }): string[] | null;
  /** The rows among `numbers` that are closed and still carry the claim, with their comments and the pull requests that cross-reference them. */
  closedClaimedRowsOf(request: { repo: string; aim?: string; numbers: number[]; claimLabel: string; run: AimedRun }): { number: number; labels: { name: string }[]; comments: { body: string; createdAt: string; author: { login: string | undefined } }[]; closedByPullRequestsReferences: { number: number; headRefName: string; title: string }[] }[];
  /** The closed rows or pull requests carrying any of the named labels, in ONE aliased read under the tick's refusal memory, or `null` when the answer is not whole. */
  closedRowsCarryingLabels(request: { names: string[]; kind: "issues" | "pullRequests"; run: RowsRun }): ClosedLabelledRow[] | null;

  // --- wake (contract 1.10, A11-160 step 7) ---
  /** The title and the comments of row `number` of `repo` (a missing list is an empty one). THROWS when the read is refused or is not JSON. */
  titleAndCommentsOf(request: { repo: string; number: number; run: RowsRun }): { title: string; comments: any[] };
  /** The names of the labels on row `number` of `repo`, or `null` when the answer carries no list of labels. THROWS when the read is refused. */
  labelNamesOfRow(request: { repo: string; number: number; run: RowsRun }): string[] | null;
  /** GitHub's word for the state of row `number` (`OPEN`, `CLOSED`) in `repo`, or in the repository the call is aimed at when `repo` is absent. THROWS when the read is refused. */
  rowStateOf(request: { number: number; repo?: string; run: RowsRun }): string;
  /** The labels, body and title of row `number` of `repo`. THROWS when the read is refused or the answer carries no list of labels. */
  labelsBodyTitleOf(request: { repo: string; number: number; run: RowsRun }): TierFacts;
  /** Closes row `number` of the repository the call is aimed at, with `comment`. */
  closeHomeRowWithComment(request: { number: number; comment: string; run: RowsRun }): void;
  /** Files a row with every one of `labels` and answers what `gh` printed (the new row's URL). */
  fileRowWithLabels(request: { title: string; body: string; labels: readonly string[]; run: RowsRun }): string;
  /** The last event that put `label` on row `number` or took it off, or `null` when it never had one. THROWS when the read is refused. */
  lastLabelEventOf(request: { number: number; label: string; run: RowsRun }): LabelEvent | null;
  /** Every comment on row `number`, each with whether its body carries `marker`. THROWS when the read is refused. */
  markedCommentsOf(request: { number: number; marker: string; run: RowsRun }): MarkedComment[];
  /** Whether pull request `number` of `repo` sits in the merge queue. THROWS when the read is refused. */
  isPullQueued(request: { repo: string; number: number; run: RowsRun }): boolean;
  /** `open` or `closed` (a merged pull request is closed) for pull request `number` of `repo`, or `null` for any other word. THROWS when the read is refused. */
  pullStateWordOf(request: { repo: string; number: number; run: RowsRun }): "open" | "closed" | null;
  /** Whether issue or pull request `number` of `repo` is open, and its labels; `null` for a reference that does not exist (GitHub's 404). THROWS when the read is refused otherwise. */
  issueStateAndLabelsOf(request: { repo: string; number: number; run: RowsRun }): { open: boolean; labels: string[] } | null;
  /** When the first comment of row `number` of `repo` whose body starts with `prefix` was made (the text GitHub gives), or `null` when none does. THROWS when the read is refused. */
  firstCommentTimeStartingWith(request: { repo: string; number: number; prefix: string; pageSize: number; run: RowsRun }): string | null;
  /**
   * `gh`, as the process's own account, cut at `timeoutMs`: for a caller that hands the runner on to a reader that has not moved (the trace's, step 8), and for the claim, whose writes must not be cut by the plugin's own
   * bound. `withoutGitEnv` takes the variables a hook sets (`GIT_DIR`, ...) off each call's environment, as the claim's spawn helper always did. A fake has no `gh`, and its runner throws.
   */
  ownRunWithin(timeoutMs: number, options?: { withoutGitEnv?: boolean }): RowsRun;
  /** TRANSITIONAL, with the trace's reader (step 8): the answer of `gh api <args>`, parsed as JSON, on the `run` the caller hands over. THROWS when the read is refused or is not JSON. */
  readRestJson(request: { args: string[]; run: RowsRun }): any;

  // --- the claim (contract 1.10, A11-160 step 7) ---
  /** The arguments that create the label `label` in `repo`, or update it (`--force`): the claim runs them one at a time or hands them to its executor to wait together. */
  ensureLabelArgs(label: string, repo: string): string[];
  /** A row as REST states it. THROWS when `gh` fails; `{ unreadable }` for an answer that is not a row. */
  readRestRow(request: { repo: string; number: number; run: RowsRun }): RestRowRead;
  /** A row's last 100 comments (bodies, oldest first) as REST states them. THROWS when `gh` fails; `{ unreadable }` for an answer that is not a list of pages. */
  readRestComments(request: { repo: string; number: number; run: RowsRun }): RestCommentsRead;
  /** Sets a row's labels to exactly `labels`, in ONE request: a row never holds half of it. THROWS when refused. */
  setRowLabels(request: { repo: string; number: number; labels: readonly string[]; run: RowsRun }): void;
  /** Takes `remove` off a row of `repo` and puts `add` on, in one edit. THROWS when refused. */
  editRowLabels(request: { repo: string; number: number; remove: readonly string[]; add: readonly string[]; run: RowsRun }): void;

  // --- the filing of rows and the top-level claim and row files (contract 1.10, A11-160 step 7) ---
  /** The arguments-only runner of this code host's program, made of one that takes the program and its arguments. The operations take the runner of their caller; a caller that holds a {@link CommandRun} makes it here and names no program. */
  argumentsRunOf(run: CommandRun): RowsRun;
  /** A blocker's state and body, or `null` when it cannot be read: an unreadable blocker is an unknown, never an umbrella. Never throws. */
  blockerRowOf(request: { number: number; repo: string; run: RowsRun }): BlockerRead | null;
  /** The newest `limit` open rows of `repo` as a JSON list of `{ number, title }`, as text. THROWS when the read is refused. */
  newestOpenRowsText(request: { repo: string; limit: number; run: RowsRun }): string;
  /** Sets the single-select option `optionId` of the field `fieldId` of project `projectId` on the board item `itemId`. */
  setBoardItemOption(request: { itemId: string; projectId: string; fieldId: string; optionId: string; run: RowsRun }): void;
  /** Files a row from the arguments of the code host's own create command, unchanged, and answers its address, trimmed. THROWS when the code host refuses. */
  fileRowFromArguments(request: { argv: string[]; run: RowsRun }): string;
  /** The milestones of `repo`. THROWS when the read is refused or the answer is not a list. */
  milestonesOf(request: { repo: string; run: RowsRun }): MilestoneRead[];
  /** The titles of the milestones of `repo`, without the blank ones. THROWS when the read is refused. */
  milestoneTitlesOf(request: { repo: string; run: RowsRun }): string[];
  /** Puts every label of `labels` on row `number` of `repo`, in one edit. */
  addLabelsToRowIn(request: { repo: string; number: number; labels: string[]; run: RowsRun }): void;
  /** The body of row `number` of `repo`, as the code host prints it. THROWS when the read is refused. */
  bodyTextOfRowIn(request: { repo: string; number: number; run: RowsRun }): string;
  /** The title of the milestone of row `number` of `repo`, as the code host prints it (empty for a row with none). THROWS when the read is refused. */
  milestoneTitleOfRow(request: { repo: string; number: number; run: RowsRun }): string;
  /** Every project item of row `number` of `repo` with its value of the single-select field `field`. THROWS on a refused read or an answer of an unexpected shape. */
  roadmapItemsOf(request: { repo: string; number: number; field: string; run: RowsRun }): RoadmapItemRead[];
  /** The single-select field `field` of board `boardNumber` of `owner`; `null` when the board has none. THROWS when the board cannot be read. */
  roadmapFieldOf(request: { owner: string; boardNumber: number; field: string; run: RowsRun }): RoadmapFieldRead | null;

  // --- the claim's rules (contract 1.10, A11-160 step 7) ---
  /** The `blockedBy` edge of row `number` of `repo`, as GitHub answers it. THROWS when the read is refused or is not JSON. */
  blockedByOf(request: { repo: string; number: number; run: RowsRun }): { blockedBy?: { nodes?: { number?: number; state?: string }[] } };
  /** The body and labels of row `number` of `repo`: the argument list the claim's batched read sends. THROWS when the read is refused or is not JSON. */
  bodyAndLabelsOf(request: { repo: string; number: number; run: RowsRun }): { body?: string; labels?: unknown[] };
  /** A held row as B2 reads it: body, labels and `blockedBy` in one call, then the count of its sub-issues in a second. THROWS when either is refused. */
  rowShapeFactsOf(request: { repo: string; number: number; run: RowsRun }): RowShapeFacts;
  /** Whether row `number` of `repo` carries `label`. THROWS when the read is refused: never "not labelled". */
  rowCarriesLabel(request: { repo: string; number: number; label: string; run: RowsRun }): boolean;
  /** The newest `limit` open pull requests of `repo` with their reviews, in one call. THROWS when the read is refused. */
  openPullReviewsOf(request: { repo: string; limit: number; run: RowsRun }): OpenPullReview[];
  /** The commits of pull request `number` of `repo`; none where the answer carries no list. THROWS when the read is refused. */
  commitsOfPull(request: { repo: string; number: number; run: RowsRun }): PullCommit[];
  /** The pull requests GitHub resolves as closing row `number` of `repo`, oldest first. THROWS when the read is refused or the answer is not that shape. */
  closingPullsOf(request: { repo: string; number: number; run: RowsRun }): ClosingPullRead[];
  /** Every item that cross-references row `number` of `repo`, read to the end of the timeline. THROWS when a read is refused, a page has no end marker, or the timeline does not end. */
  crossReferencingPullsOf(request: { repo: string; number: number; run: RowsRun }): CrossReferencingPull[];
  /** Every path pull request `number` of `repo` changes, read to the end of its file list. THROWS as {@link CodeHostRows.crossReferencingPullsOf} does. */
  changedPathsOfPull(request: { repo: string; number: number; run: RowsRun }): string[];
  /** Every open pull request of `repo` with the files it changes, its body, labels and branch, in one call. THROWS when the read is refused. */
  openPullsWithFilesOf(request: { repo: string; run: RowsRun }): OpenPullFiles[];
  /** Every file pull request `number` of `repo` changes, through REST's pages. THROWS when the read is refused. */
  pullFilePathsOf(request: { repo: string; number: number; run: RowsRun }): string[];
  /** Creates the label `name` in `repo`; creating one that exists is harmless. A refused write THROWS. */
  ensureLabelIn(request: { repo: string; name: string; run: RowsRun }): void;
  /** Puts `label` on row `number` of `repo`. A refused write THROWS. */
  addLabelToRowIn(request: { repo: string; number: number; label: string; run: RowsRun }): void;
  /** What changed in `repo` between commit `sha` and its `main`, or `null` when GitHub cannot say (offline, no token, an unknown commit): never "nothing changed". */
  compareShaWithMain(request: { repo: string; sha: string; run: RowsRun }): { status: string; files: string[] } | null;

  // --- the other claim and row files (contract 1.10, A11-160 step 7) ---
  /** A row's `labeled` and `unlabeled` events, every page, oldest first. THROWS when the read is refused or a line is not JSON: a history that could not be read is never an empty one. `run` absent: the code host runs `gh` itself. */
  labelEventsOf(request: { repo: string; row: number; run?: RowsRun }): LabelEventRead[];
  /** Takes every label in `labels` off row `number` of `repo` in ONE edit. THROWS when `gh` refuses. */
  removeLabelsFromRow(request: { repo: string; number: number; labels: readonly string[]; run?: RowsRun }): void;
  /** The GraphQL answer, as text, naming the pull request that closed row `number` of `repo` (the last of its closing events). THROWS when the read is refused. */
  closingTimelineTextOf(request: { repo: string; number: number; run?: RowsRun }): string;
  /** The `limit` most recently closed rows of `repo`, as the text of a JSON list of `{ number, title, closedAt, stateReason }`. THROWS when the read is refused. */
  closedRowListingTextOf(request: { repo: string; limit: number; run?: RowsRun }): string;
  /** Every `labeled` and `unlabeled` event of the repository, every page, as one JSON object per line `{ number, event, label, at }`. THROWS when the read is refused. */
  labelEventLogTextOf(request: { repo: string; run?: RowsRun }): string;
  /** The `limit` newest pull requests of `repo` in any state, with the branch each was opened from. THROWS when the read is refused or is not JSON. */
  pullStatesOf(request: { repo: string; limit: number; run?: RowsRun }): BranchedPullState[];
  /** Every pull request of `repo` opened from `branch`, in any state: an answer that is not a list is the empty list. THROWS when the read is refused or is not JSON. */
  pullStatesOfBranchIn(request: { repo: string; branch: string; run?: RowsRun }): PullState[];
  /** A row's body, labels, state and close time as GitHub states them. THROWS when the read is refused or is not JSON. */
  rowFactsIn(request: { repo: string; number: number; run?: RowsRun }): RowFacts;
  /** The open rows (`issues`, pull requests dropped) or pull requests of `repo` over REST, every page. THROWS when a page is not a list or the listing runs past its pages. */
  openRestListingOf(request: { repo: string; kind: "issues" | "pulls"; run?: RowsRun }): object[];
  /** A row's body in `repo`. THROWS when the read is refused or is not JSON. */
  rowBodyIn(request: { repo: string; number: number; run?: RowsRun }): string;

  // --- runners for a caller that keeps its own policy (contract 1.11, A11-160 step 8) ---
  /** The program the code host starts, as the name core's leak guard judges argument lists under (`assertNoLeakInArgv`). */
  readonly command: string;
  /** `gh`, as the process's own account, with the policy `request` names; the text it printed, THROWING as the program fails. A fake has no program, and its runner throws. */
  runnerWith(request?: RunnerRequest): RowsRun;
  /** {@link CodeHostRows.runnerWith}, answered as a promise. A fake's runner rejects. */
  asyncRunnerWith(request?: RunnerRequest): AsyncRowsRun;

  // --- the trace (contract 1.11, A11-160 step 8) ---
  /** Comments on row `number` of `repo` with `body`, handed over on standard input and not in an argument list. The code host starts the program itself, cut at `timeoutMs`. THROWS when the program fails, with what it printed. */
  commentOnRowByInput(request: { repo: string; number: string | number; body: string; timeoutMs: number }): void;
  /** A row's number, state, title, body and labels as a read-only script reads it. THROWS when the read is refused or is not JSON. */
  rowSnapshotOf(request: { repo: string; number: number; run: RowsRun }): { number: number; state: string; title: string; body: string; labels: { name: string }[] };
  /** The text of `gh api <args>`: the arguments after the verb, built by the caller (a path and its parameters). THROWS as the run does. */
  apiTextOf(request: { args: readonly string[]; run: RowsRun }): string;
  /** One GET of REST `path`, with its response headers, conditional on `etag` when one is given. Never throws: how the call ended, for a caller that reads the status line itself. */
  conditionalGetOf(request: { path: string; etag: string | null; maxBuffer: number }): RunAnswer;

  // --- the chairman's watch and answers (contract 1.11, A11-160 step 8). Each takes the ASYNC `run` the watcher holds. ---
  /** A row as the chairman's answers read it: its state, its labels and every comment (body, time, the commenter's association). A row that is not `owner/name` and a positive number is a TypeError. REJECTS as the run does. */
  readRowAsync(request: { repo: string; number: number; run: AsyncRowsRun }): Promise<{ state: string; labels: string[]; comments: { body: string; createdAt: string; authorAssociation: string }[] }>;
  commentOnRowAsync(request: { repo: string; number: number; body: string; run: AsyncRowsRun }): Promise<void>;
  /** Takes `label` off a row; a label that is already absent is done (GitHub's `Label does not exist`), and any other refusal rejects. */
  removeLabelAsync(request: { repo: string; number: number; label: string; run: AsyncRowsRun }): Promise<void>;
  addLabelAsync(request: { repo: string; number: number; label: string; run: AsyncRowsRun }): Promise<void>;
  /** Every comment of row `number` of `repo` (the list returns the oldest hundred), as a list; none where the answer carries no list. */
  issueCommentsAsync(request: { repo: string; number: number; run: AsyncRowsRun }): Promise<any[]>;
  /** The newest `limit` open pull requests of `repo` with their labels and check rollup. */
  openPullChecksAsync(request: { repo: string; limit: number; run: AsyncRowsRun }): Promise<any[]>;
  /** One GET of REST `path`, parsed. */
  restGetAsync(request: { path: string; run: AsyncRowsRun }): Promise<any>;
  /** A pull request's review decision (`""` where the base requires none), or `null` for an answer that carries none. */
  pullReviewDecisionAsync(request: { repo: string; number: number; run: AsyncRowsRun }): Promise<string | null>;

  // --- the org-health sweep readings and the retro (contract 1.11, A11-160 step 8). Each takes the `run` its caller hands it and THROWS when the read is refused or is not JSON where JSON is read. ---
  /** The repositories a team reaches, one per line: `<owner/name>` and the five permission flags (admin, maintain, push, triage, pull), tab-separated; every page. */
  teamRepositoriesTextOf(request: { org: string; team: string; run: RowsRun }): string;
  /** The latest `merged_at` among the newest-updated `window` closed pull requests of `repo`, printed raw (`null` for none). */
  lastMergeTextOf(request: { repo: string; window: number; run: RowsRun }): string;
  /** The newest `window` runs of the release workflow on `main`: `{ id, event, status, conclusion, sha, createdAt, updatedAt, url }` of each. */
  releaseRunsOf(request: { repo: string; window: number; run: RowsRun }): any;
  /** The jobs of a run of the release workflow: `named` is `{ name, conclusion }` of each, `failed` the failed jobs with the names of their failed steps. */
  releaseJobsOf(request: { repo: string; runId: number; window: number; shape: "named" | "failed"; run: RowsRun }): any;
  /** The names of the files in `.changeset/` on `main`. */
  changesetNamesOf(request: { repo: string; run: RowsRun }): any;
  /** The newest `limit` open rows of `repo` with their number and labels. */
  openRowLabelsOf(request: { repo: string; limit: number; run: RowsRun }): any[];
  /** The newest `limit` open pull requests of `repo` with number, body, branch and labels. */
  openPullsNamingRowsOf(request: { repo: string; limit: number; run: RowsRun }): any[];

  // --- the DORA reader (contract 1.11, A11-160 step 8). Each takes the `run` the reader hands it (which carries its read budget) and THROWS when the read is refused or is not JSON. ---
  /** The commit a tag or sha names, as `<sha> <parent shas, comma-joined>`. */
  commitAndParentsTextOf(request: { repo: string; ref: string; run: RowsRun }): string;
  /** Every release of `repo`, drafts included, out of the pages. */
  releasesOf(request: { repo: string; run: RowsRun }): any[];
  /** Whether `repo` has issues enabled. */
  hasIssuesEnabled(request: { repo: string; run: RowsRun }): boolean;
  /** The pages of the comparison `base...head`: the status once, and the commits of `head` that `base` lacks. */
  compareRangeOf(request: { repo: string; base: string; head: string; run: RowsRun }): any[];
  /** The merge commit of pull request `number` of `repo`, and when it merged. */
  pullMergeOf(request: { repo: string; number: number; run: RowsRun }): { mergeCommit?: { oid?: string } | null; mergedAt?: string | null };

  // --- the board's reads and posts (contract 1.11, A11-160 step 8). Each takes the `run` the board hands it (behind the leak guard and the buffer it has always had) and THROWS when the read is refused or is not JSON. ---
  /** One page of the repository's issues, from the cursor `after` or the first: GraphQL's response, whose shape is the caller's to check. */
  issuePageOf(request: { repo: string; after: string | null; run: RowsRun }): any;
  /** Every milestone of `repo`, open and closed. */
  allMilestonesOf(request: { repo: string; run: RowsRun }): any[];
  /** The repository's id and its Discussion categories (id and slug of each): the response's `data`. */
  discussionCategoriesOf(request: { owner: string; name: string; run: RowsRun }): any;
  /** The newest hundred Discussions of a category (id, title, url of each): the response's `data`. */
  discussionEditionsOf(request: { owner: string; name: string; categoryId: string; run: RowsRun }): any;
  /** Creates a Discussion: the response's `data` (`createDiscussion.discussion.url`). */
  createDiscussion(request: { repositoryId: string; categoryId: string; title: string; body: string; run: RowsRun }): any;
  /** Replaces the body of a Discussion: the response's `data`. */
  updateDiscussion(request: { discussionId: string; body: string; run: RowsRun }): any;
  /** Whether `tag` has a release and whether it is a draft; `null` when there is none or it cannot be read. */
  draftReleaseOf(request: { repo: string; tag: string; run: RowsRun }): { isDraft: boolean } | null;
  /** Creates a DRAFT release for `tag` with `file` attached. */
  createDraftRelease(request: { repo: string; tag: string; file: string; title: string; notes: string; run: RowsRun }): void;
  /** Uploads `file` to the release of `tag`, replacing an asset of the same name. */
  uploadReleaseAsset(request: { repo: string; tag: string; file: string; run: RowsRun }): void;
  /** The newest `limit` rows of `repo` in `state` with the JSON fields `fields` names. */
  rowsListedIn(request: { repo: string; state: "open" | "closed"; limit: number; fields: string; run: RowsRun }): any[];
  /** The newest `limit` pull requests of `repo` in `state` with the JSON fields `fields` names. */
  pullsListedIn(request: { repo: string; state: "open" | "merged"; limit: number; fields: string; run: RowsRun }): any[];
  /** Every row of `repo` (pull requests left out) updated since `since`, one JSON object per line: `{ number, state, createdAt, closedAt, labels }`; paged, not capped. */
  windowRowsTextOf(request: { repo: string; since: string; run: RowsRun }): string;
  /** How many comments of row `issue` since `since` open with `title`, summed over the pages. */
  editionCommentCountOf(request: { repo: string; issue: string; since: string; title: string; run: RowsRun }): number;
  /** The bodies of the comments on row `number` of `repo`. */
  commentBodiesOfIssue(request: { repo: string; number: string | number; run: RowsRun }): string[];
  /** The newest `limit` runs of a workflow with the JSON fields `fields` names. */
  workflowRunListOf(request: { repo: string; workflow: string; fields: string; limit: number; run: RowsRun }): any[];
  /** When a workflow was first registered, or `null` when GitHub gave none. */
  workflowCreatedAtOf(request: { repo: string; workflow: string; run: RowsRun }): string | null;
  /** One page of the project's items, from the cursor or the first, as the text GitHub answered. The failed process's stdout carries GraphQL's own error. */
  boardItemsPageOf(request: { owner: string; number: number; cursor: string | null; run: RowsRun }): string;
  /** One issue's item on the project, and the project itself, as the text GitHub answered. */
  touchedItemTextOf(request: { owner: string; repo: string; project: number; issue: number; run: RowsRun }): string;
  /** The `Roadmap` facts of the rows `numbers`, ONE aliased request: the response's `data.repository`, an object keyed `r<number>`. THROWS also when it has no repository. */
  roadmapFactsOf(request: { repo: string; numbers: readonly number[]; run: RowsRun }): Record<string, any>;
  /** The login that posted comment `id` of `repo`. */
  commentAuthorOf(request: { repo: string; id: string; run: RowsRun }): string;
  /** The ids of the comments of row `row` since `since` that open with `heading`, one per line. */
  headedCommentIdsText(request: { repo: string; row: string; since: string; heading: string; run: RowsRun }): string;
  /** Every comment of `repo` since `since` by a login that starts with `loginPrefix`: `{ number, author: { login }, body, createdAt, url }`. */
  orgCommentsSinceOf(request: { repo: string; since: string; loginPrefix: string; run: RowsRun }): any[];
  /** Every issue of `repo` (pull requests left out) updated since `since`: `{ number, state, author, createdAt, text }`, the text being the title and the body. */
  issuesSinceOf(request: { repo: string; since: string; run: RowsRun }): any[];
  /** The `labeled` events of row `number`: `{ number, label, actor, createdAt }`. */
  labeledEventsOfRow(request: { repo: string; number: number; run: RowsRun }): any[];
}

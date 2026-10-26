// @ts-check
// module: the code host contract, version 1.27 -- what ticket mode asks of the place pull requests live (A11-158)
//
// A TYPE FILE: it imports nothing at run time. It is SYNCHRONOUS, because every reader of it is: the ticket port's gate (`ticket-port/port.ts`) and ticket
// mode's injected `gh: (args) => string` (`pool-context.ts`). It is written from the GitHub operations ticket mode makes today, and carries `CodeHostPort`'s four
// operations, which stay declared in `port.ts` (its source test holds that file to no import at all, a re-export included) and are named here by a type-only import. It
// imports nothing else of core: `ReviewState` is declared here, and `ticket-mode/reviewer-port.ts` re-exports it.
// An operation joins this contract only when a sibling ticket moves a call that needs it (A11-160 moves the gate's).
//
// ROW MODE'S GITHUB OPERATIONS are an optional `rows` group of this contract, not a second plugin (`docs/adr/0002-row-mode-github-is-an-optional-part-of-the-code-host-contract.md`); the group is declared in `code-host-rows.ts`.
//
// 1.27 (A11-291): `MergeFlow.private` and `MergeFlow.mergeBot`, both required of a host that implements `readMergeFlow` (1.25): whether the repository is private, and whether its default branch holds the merge bot, `.github/workflows/merge-bot.yml`, which merges a pull request approved at its head with a green `gate` where the plan offers a private repository no ruleset or merge queue. A repository has a merge flow when it allows auto-merge and holds the arm workflow, or is private and holds the merge bot. A plugin of 1.26 or earlier says neither, and the board and doctor then read every repository by the first rule.
// 1.26 (A11-290): `commentOnPull`, OPTIONAL: post a comment on a pull request as the workers' account, which is how the board records the result of a re-review that the verdict door refused (an equal patch) on the pull request itself. A plugin of 1.24 is read as one that cannot, and the board then keeps the result in the run's log alone and says so once.
// 1.25 (A11-291): `PullFeedback.armed`, OPTIONAL: whether auto-merge is on for the pull request (GitHub's `autoMergeRequest`), and `readMergeFlow`, OPTIONAL: whether a repository allows auto-merge and has an arm workflow (`.github/workflows/auto-arm.yml`) on its default branch, and which branch that is, which the board reads to say why an approved pull request with green checks is not merging, and which doctor reads for every repository of the host. A plugin of 1.24 is read as one that says nothing of either, and the board then says only that the pull request is not in the merge queue.
// 1.24 (A11-286): `PullFeedback.behind`, OPTIONAL: whether the host says the pull request's branch is behind its base (GitHub's `mergeStateStatus: BEHIND`, which it reports only where the base requires branches to be up to date), which the board brings up to date with the host's `updateBranch` before the merge queue takes it. A plugin of 1.23 is read as one that says nothing of `behind`, and the board then updates only the pull requests that conflict.
// 1.23 (A11-248): `closePull`, OPTIONAL: close a pull request with a comment, as the workers' account, which is how the board closes a member of a stack left with no changes of its own once everything it held merged below it. A plugin of 1.22 is read as one that cannot close, and the board then says on the card that the pull request is empty and is to be closed.
// 1.22 (A11-261): `readBranchCi`, OPTIONAL: the workflow runs on one branch of a repository with each job's runner labels and times, which the board adds up into the CI minutes a ticket's pushes cost (weighted as GitHub bills them) and warns and holds a run on when a ticket passes its budget. A plugin of 1.21 is read as one that reads no branch's CI, and the board then shows and holds nothing.
// 1.21 (A11-264): `PullFeedback.queue`, OPTIONAL: what the merge queue did to a pull request since its head last moved (is it queued, and each removal with its reason, actor and the merge group's commit), read in the same query as the rest of the feedback; `readQueueFailure`, OPTIONAL: the failing `merge_group` run behind one removal, its failing jobs and their first failing step; and `holdFromQueue`, OPTIONAL: put the `hold:board` label on a pull request, or take it off, which every arm bot in the org already honours. A plugin of 1.20 is read as one that reads no queue, and the board then behaves as it did.
// 1.20 (A11-249): `readClosedWork`, OPTIONAL: what a pull request closed without merging still held, the commits on its head that are not on its base and the files they change, as the host's compare reads them, which the board lists on the ticket so the work is never lost with the pull request. A plugin of 1.19 is read as one that cannot be asked, and the board then lists nothing.
// 1.19 (A11-255): `openDependencyPulls`, OPTIONAL: the open pull requests of a repository that the host's dependency bot (`DEPENDENCY_PULL_AUTHOR`) opened, with their title, branch, head, author and body, which the board reads to turn a major update, or a grouped update that stays red, into a ticket. The host filters by author, so a pull request anyone else opens with a bot-like title is never returned. A plugin of 1.18 is read as one that cannot be asked, and the board then files no dependency ticket.
// 1.18 (A11-240): `pullsNaming`, OPTIONAL: the pull requests of some repositories whose title or body names a ticket's key, with their state, which a run that is queued again is told of and which Respond finds a pull request to answer by when the board never recorded one. A plugin of 1.17 is read as one that cannot be asked, and everything is then as it was: the board's own record is all there is.
// 1.17 (A11-245): `readCiRun`, OPTIONAL: what a workflow run is (whether it has finished, how it concluded, how many of its jobs have), which the board reads for a worker that declared it waits on one. A plugin of 1.16 is read as one that has no CI-run read, and a wait on a run is then shown as unreadable.
// 1.16 (A11-238): `stackMergeFactsOf` and `requestStackMerge`, both OPTIONAL: what the board reads of a pull request that may be in a stack (is it, where its base is, whether the stack merge is settled or was refused and why), and the hand-back of an approved, green stacked pull request to the arm bot, which alone merges it. A plugin of 1.15 is read as one with neither,
// and the board then asks the arm bot for nothing, as before.
// 1.15 (A11-215): `DefaultBranchRed` gains OPTIONAL `passing` and `pending`, the checks whose newest run on the default branch's head concluded green and those whose newest run has not concluded, and the base contract gains `updateBranch`, OPTIONAL: bring a pull request's branch up to date with its base, which is how the board
// mends a pull request it held as red on main once main is green again. A plugin of 1.14 is read as one with neither, and the board then keeps a held pull request as A11-179 holds it.
// 1.14 (A11-186): `repositories`, an OPTIONAL group: the accounts and organisations a person can pick repositories from, the repositories of each, the repository a git remote names, and the clone of one, which `onboard` offers at a terminal. A code host without it keeps onboard's typed
// prompt. A plugin of 1.13 is read as one that has none.
// 1.13 (A11-179): `PullFeedback` gains four OPTIONAL fields, `reviewDecision`, `verdictAtHead`, `pendingRequired` and `body`, which the board reads to say whether a pull request is ready to merge (approved at its head, its required checks green there)
// and who owns a red check, and the base contract gains `readDefaultBranchRed`, OPTIONAL: the checks failing on the head of a repository's default branch. A plugin of 1.12 is read as one that says none of them, and the board then reads its pull requests as not proven ready.
// 1.12 (A11-160, step 9): `rows` gains the operations of the last callers of `gh` in `src/`, `scripts/` and `host/`, in seven sections (`code-host-rows-{pullwork,audit,closing,classes,queue,readouts,plumbing}.ts`): opening, holding and sweeping pull requests, the label audit, the closing of rows, the CI failure class and the ledgers, the queue and trunk readings, the read-only reporters, and the tool-version agreement, the ledger's retry and the host's scripts. After it no file outside `plugins/github` calls `gh`. A plugin of 1.11 is read as one whose `rows` lack them, which a 1.11 plugin would have to be updated for; while plugins are in-repo that is the same pull request.
// 1.11 (A11-160, step 8): `rows` gains the operations of the board's reads and posts (`src/board-*`), the health and retro readings (`src/org-health/sweep-readings.ts`, `src/org-retro/`), the DORA reader (`src/dora.ts`), the trace (`src/trace/`) and the
// chairman's watch and answers (`src/messaging/`), and the runners a caller that keeps its own policy asks for (`runnerWith`, `asyncRunnerWith`): see `code-host-rows.ts`. A plugin of 1.10 is read as one whose `rows` lack them,
// which a 1.10 plugin would have to be updated for; while plugins are in-repo that is the same pull request.
// 1.10 (A11-160, step 7): `rows` gains the operations of wake, the claim and the filing of rows (`src/wake*`, `src/row-claim*`, `src/row-file/`, `src/claim-stall/` and the claim and row files at the top of `src/`): see `code-host-rows.ts`. A plugin of 1.9
// is read as one whose `rows` lack them, which a 1.9 plugin would have to be updated for; while plugins are in-repo that is the same pull request.
// 1.9 (A11-160, step 6): `rows` gains the operations of the work gate (`src/work-gate/`): a row's label events, comments and timeline, the pull requests, commits, checks and runs it reads, the writes it makes to rows and the board, and the executor's
// process (`gateRun`, `runTogether`). A plugin of 1.8 is read as one whose `rows` lack them, which a 1.8 plugin would have to be updated for; while plugins are in-repo that is the same pull request.
// 1.8 (A11-160, step 5): `armMerge` is real (the arm, then the read of whether the pull request settled or was armed meanwhile), and `rows` gains the operations of the files that arm, guard and queue a merge: see `code-host-rows.ts`.
// A plugin of 1.7 is read as one whose `rows` lack them, which a 1.7 plugin would have to be updated for; while plugins are in-repo that is the same pull request.
// 1.7 (A11-160, step 4): `repoViewArgs` and `repoCloneArgs`, required (the arguments onboard and the conventions install run to read and clone a repository, which are not row mode's), and `rows`, an OPTIONAL group: row mode's GitHub operations, which `src/ticket-port/` held (the GitHub adapter of the ticket port and the reads and writes of rows, pull requests, checks, the merge queue and the
// board). A code host without `rows` serves ticket mode only; a row-mode entry refuses to start without it, by name. A plugin of 1.6 is read as one that has none.
// 1.6 (A11-175): `ReviewState.unrequiredRed`, OPTIONAL: the checks that failed and that the branch does not require. `settled` counts only the required checks, so a head with one of these red is settled, and the
// reviewer is told which they are. A plugin of 1.5 is read as one that names none.
// 1.5 (A11-160, step 3): `readCheckLog` and `rerunFailedChecks` (what the board does about a red check), `readReviewClaims` and `writeReviewClaim` (the commit status that says which instance is reviewing a head), and `verdictDoor`,
// an OPTIONAL group: the program a reviewer posts its verdict with, as an owned file of the host. A plugin of 1.4 is read as one that implements none of the four operations, which a 1.4 plugin
// would have to be updated for; while plugins are in-repo that is the same pull request (Decision 8 of A11-157).
// 1.4 (A11-167): `readMergedFindings`, OPTIONAL: what a merged pull request found (its title, its body and the markdown sections its diff added), which the planner of a ticket that waited on it is given. A plugin of 1.3 is read as one
// that has none, and a dependent is then planned without its blockers' findings.
// 1.3 (A11-160, step 2): `wrapper`, an OPTIONAL group: the routing wrapper every `gh` process of an org host runs through (which account or App a role acts as), as an owned file of the host. Core asks the plugin
// for the wrapper's text and its install target and for the rules about writing it, and the plugin's own `doctorChecks` and `onboardSteps` say the rest (wrapper roles, App tokens, the App's key). A code host
// with no `wrapper` installs none. A plugin of 1.2 is read as one that has none.
// 1.2 (A11-156): `readReplies` reads what a trusted account said on a pull request since a time, which is how the pool finds a reply to a review that asked for changes.
// 1.1 (A11-160): `readPullFeedback` takes the accounts whose feedback is not the worker's to answer besides its own (the reviewer's), which ticket mode filtered out of GitHub's
// answer before the read moved into the plugin. A plugin of 1.0 is read as one that is given none.
import type { ChangeFacts, ChangeRef, CodeHostEvent, CodeHostEventKind, CodeHostPort } from "../../ticket-port/port.ts";
import type { CodeHostRows } from "./code-host-rows.ts";

export type { ChangeFacts, ChangeRef, CodeHostEvent, CodeHostEventKind, CodeHostPort, CodeHostRows };

/** The code host contract's version, `<major>.<minor>`: a minor only adds, and a major breaks (`src/plugins/version.ts`). */
export const CODE_HOST_CONTRACT_VERSION = "1.27";

/** The account the host's dependency bot opens its pull requests as (contract 1.19): the only author {@link CodeHost.openDependencyPulls} returns. */
export const DEPENDENCY_PULL_AUTHOR = "dependabot[bot]";

/** An open pull request the dependency bot opened (contract 1.19). `body` is OUTSIDE INPUT: the bot copies a package's release notes into it. */
export type DependencyPull = Readonly<{ url: string; number: number; title: string; headRefName: string; headSha: string; author: typeof DEPENDENCY_PULL_AUTHOR; body: string }>;

/** A check failing on a pull request's head: its name and the address of the page its run reports (an Actions job's, which names the log to read), or null. */
export type FailingCheck = Readonly<{ name: string; detailsUrl: string | null }>;

/** GitHub's decision on a pull request's reviews: null is a branch that requires none. */
export type ReviewDecision = "approved" | "changes-requested" | "review-required" | null;

/**
 * The checks failing on the head of a repository's default branch (contract 1.13): the branch, its head commit, and the names of the checks failing there, check runs and commit statuses both,
 * the newest of each name as the red-check decider reads it. `passing` (contract 1.15) is the positive side: the names whose newest run concluded green there, and `pending` the names whose newest run has not
 * concluded (running, queued, cancelled or stale). A check that is pending, missing or not read is in neither of `failing` and `passing`, so "not failing" is not "passing"; a name in none of the three is a check the head reports no run of.
 * Both are absent for a host of 1.14, which is read as one that names none.
 */
export type DefaultBranchRed = Readonly<{ branch: string; head: string; failing: readonly string[]; passing?: readonly string[]; pending?: readonly string[] }>;

/**
 * What {@link CodeHost.updateBranch} did (contract 1.15): the branch was brought up to date (`updated`), it conflicts with its base and was left as it was (`conflict`), it already has its base (`up-to-date`), or the host
 * refused for another reason, in its own first line (`refused`), such as a head that moved since it was read.
 */
export type UpdateBranchResult = Readonly<{ kind: "updated" }> | Readonly<{ kind: "conflict" }> | Readonly<{ kind: "up-to-date" }> | Readonly<{ kind: "refused"; reason: string }>;

/**
 * One time the merge queue removed a pull request (contract 1.21): when (`at`, epoch milliseconds), the host's own `reason` (`failed_checks` for a failed `merge_group` run, and others such as a merge conflict or a manual removal), who removed it (`actor`, or null
 * when the host does not say) and the commit of the merge group it was removed from (`groupCommit`, or null), which is the `head_sha` of that group's `merge_group` run.
 */
export type QueueRemoval = Readonly<{ at: number; reason: string; actor: string | null; groupCommit: string | null }>;

/**
 * What the merge queue did to a pull request since its head last moved (contract 1.21): `queued` is whether it is in the queue now, and `removals` are the times the queue removed it after the newest commit or force-push the host read, oldest first. A pull request pushed to since has none.
 */
export type PullQueue = Readonly<{ queued: boolean; removals: readonly QueueRemoval[] }>;

/** One job of a failed `merge_group` run (contract 1.21): its name, its first failing step (null when the host names none) and the address of its page, which names the log to read as a check's does. */
export type QueueFailureJob = Readonly<{ name: string; step: string | null; detailsUrl: string }>;

/** The failing `merge_group` run behind one removal (contract 1.21): its id and address, and every job of it that failed or timed out. */
export type QueueFailure = Readonly<{ runId: number; runUrl: string; jobs: readonly QueueFailureJob[] }>;

/**
 * Whether a repository can merge a pull request by itself (contract 1.25): `autoMerge` is whether the repository allows auto-merge, and `armWorkflow` whether its default branch (`defaultBranch`) holds the arm workflow, `.github/workflows/auto-arm.yml`, that turns it on for a pull request. A repository that
 * lacks either has no merge flow: an approved pull request in it waits for a person. Only a pull request into the default branch goes through the merge queue, so the board calls no other stuck.
 * A PRIVATE repository on a plan with no rulesets has no merge queue either (contract 1.27): its flow is the merge bot, `mergeBot` being whether its default branch holds `.github/workflows/merge-bot.yml` (A11-291).
 */
export type MergeFlow = Readonly<{ autoMerge: boolean; armWorkflow: boolean; defaultBranch: string; private: boolean; mergeBot: boolean }>;

/** The path of the arm workflow a repository's merge flow holds (contract 1.25), which a pull request adds when it installs the flow. */
export const ARM_WORKFLOW_PATH = ".github/workflows/auto-arm.yml";

/** The path of the merge bot a private repository's merge flow holds (contract 1.27), which a pull request adds when it installs the flow. */
export const MERGE_BOT_WORKFLOW_PATH = ".github/workflows/merge-bot.yml";

/** What the board reads of one pull request. Times are epoch milliseconds, or null when there is none. */
export type PullFeedback = Readonly<{
  state: "open" | "merged" | "closed";
  /** The newest review (commented or changes requested), conversation comment or inline comment by someone other than the board's account. */
  feedbackAt: number | null;
  /** Who left feedback, each once, the author of the newest first. */
  authors: readonly string[];
  /** The checks failing on the head commit, by name: its required ones, or every one where none is required. */
  failing: readonly string[];
  /**
   * Every check failing on the head commit, counted or not, with the address of its job's page (`detailsUrl`), or null for a check that has none, such as a commit status: where its
   * log is read (A11-154). `failing` is the ones the board answers; this also lists a job behind a required roll-up that failed.
   */
  failures: readonly FailingCheck[];
  /** When the newest of those failing checks finished. */
  failedAt: number | null;
  /** Whether it conflicts with its base: GitHub says `CONFLICTING` or `DIRTY`. `UNKNOWN` (still being computed) is not a conflict. */
  conflicting: boolean;
  /** Whether the host says the branch is behind its base and may not merge until it is brought up to date (contract 1.24): GitHub's `BEHIND`. Absent when the host does not say, which is not the same as false. */
  behind?: boolean;
  /** Whether auto-merge is on for the pull request (contract 1.25): GitHub's `autoMergeRequest` is set. Absent when the host does not say, which is not the same as false. */
  armed?: boolean;
  /** Whether GitHub says it merges cleanly: `MERGEABLE`. `UNKNOWN` (still being computed) is not mergeable, as it is not a conflict either. */
  mergeable: boolean;
  /** The commit its branch is at, or null when GitHub does not say. */
  head: string | null;
  /** Whether the newest approving or changes-requesting review on the head commit, by someone other than the board's account, approves. */
  approvedAtHead: boolean;
  /** The branch it merges into, or null when GitHub does not say. */
  base: string | null;
  /**
   * GitHub's own review decision on the pull request (contract 1.13): `approved`, `changes-requested`, `review-required`, or null when its branch requires no review. Absent when the host does not say, which is
   * not the same as null.
   */
  reviewDecision?: ReviewDecision;
  /**
   * What the newest review on the head commit that approves or requests changes says (contract 1.13), by every account but `self`, the reviewer's included (`approvedAtHead` leaves the accounts in `alsoIgnore` out):
   * `approved`, `changes-requested`, or null when no review takes a side on the head. Absent when the host does not say.
   */
  verdictAtHead?: "approved" | "changes-requested" | null;
  /** The required checks on the head commit that have not concluded, by name (contract 1.13). Empty when every required check has; absent when the host does not say. */
  pendingRequired?: readonly string[];
  /** The pull request's body (contract 1.13), where a `Blocked-by:` line names the ticket that owns what it is waiting on. Absent when the host does not say. */
  body?: string;
  /** What the merge queue did to it since its head last moved (contract 1.21). Absent when the host does not say, which is not the same as no removals. */
  queue?: PullQueue;
  /** The files it changes, by path within its repository. */
  files: readonly string[];
  /** Whether `files` is all of them. Read a page of 100 at a time, up to {@link MAX_FILE_PAGES}: a list cut off there is not complete. */
  filesComplete: boolean;
}>;

/** One commit of a closed pull request's unique work: its full SHA and the first line of its message. */
export type ClosedCommit = Readonly<{ sha: string; subject: string }>;

/**
 * What a pull request closed without merging still held (A11-249), as the host's compare of its base with its head COMMIT reads it at the moment it is read: the commits on the head that are not on the base, oldest first, and the files they change. The compare is
 * against the head's SHA and not its branch, so the read still works when someone deleted the branch. No commits means everything the pull request held is on its base. `filesComplete` is false when the host's compare stopped at its cap of files, so `files` is then a part.
 */
export type ClosedWork = Readonly<{ number: number; url: string; base: string; branch: string; head: string; commits: readonly ClosedCommit[]; files: readonly string[]; filesComplete: boolean }>;

/** One markdown section a pull request added: the file it is in, its heading line as written (`### Scripted replay`), and the lines the pull request added under it. */
export type FindingsSection = Readonly<{ file: string; heading: string; text: string }>;

/** What a merged pull request found (A11-167): its title and number, its body, and the markdown sections it added outside `.acceptance/`, `.changeset/` and `CHANGELOG.md`. */
export type MergedFindings = Readonly<{ title: string; number: number; body: string; sections: readonly FindingsSection[] }>;

/** One status under the review claim's context on a head: its id (the host's order between two of the same second), its description, and when the host wrote it, in epoch milliseconds. */
export type ReviewClaimEntry = Readonly<{ id: number; description: string; created: number }>;

/** What reading a head's claim entries came to: the entries (none is an empty list), or why they could not be read, in the host's own words (`unreadable`), never an empty list for "could not ask". */
export type ReviewClaimRead = Readonly<{ entries: readonly ReviewClaimEntry[] }> | Readonly<{ unreadable: string }>;

/**
 * One claim to write on `head` of `repository`: a status with `description`, written as the reviewer role, whose environment (`reviewerEnvironment`, the account folder and token the reviewer acts
 * with) is `environment`.
 */
export type ReviewClaimWrite = Readonly<{ repository: string; head: string; description: string; environment: Readonly<Record<string, string>> }>;

/** The program a reviewer posts its verdict with, and the program that installs it where it runs: absolute paths of files the plugin ships. */
export type VerdictDoor = Readonly<{ source: string; installer: string }>;

/** A reply on a pull request: a conversation comment, a review in the commented state, or a comment in a review thread. `at` is epoch milliseconds, and `url` is where it can be read. */
export type Reply = Readonly<{ author: string; at: number; url: string; text: string }>;

/** Which replies to read: those posted after `since` (epoch milliseconds, exclusive) by an account in `authors`, named exactly. */
export type RepliesRequest = Readonly<{ since: number; authors: readonly string[] }>;

/** Whether a pull request's author is the org's own (`inside`) or not, which decides how much its reviewer trusts it (`review-trust.ts`). */
export type ReviewTrust = "inside" | "outside";

/**
 * What the pool reads of a pull request's reviewer: its head, whether the org's own, the reviews on it, whether its required checks have settled green, and
 * the pull request as the gate's verdict prompt reads it (`view`). `unrequiredRed` (contract 1.6) names the checks that failed and are not required: they did not hold the review, and the
 * reviewer is told they are red. Absent when none, or when the host does not say.
 */
export type ReviewState = Readonly<{ head: string; trust: ReviewTrust; reviews: readonly Review[]; settled: boolean; unrequiredRed?: readonly string[]; view: Readonly<Record<string, any>> }>;
export type Review = Readonly<{ author: string; state: string; commit: string; at: number }>;

/** What a stack retarget sweep reads and moves: the open pull requests of a run, the bases it stacked on, and the default branch of each repository. */
export type RetargetRequest = Readonly<{
  urls: readonly string[];
  previous: Readonly<Record<string, string>>;
  /** The branches the run's blockers' pull requests are on: the only bases this run was stacked on, so the only ones a retarget may move. */
  stacked: ReadonlySet<string>;
  /** The default branch of each repository, read once for the sweep (by `owner/repo`). */
  defaults: Map<string, string>;
  log: (line: string) => void;
}>;

/**
 * What the board reads of a pull request that may be in a stack (contract 1.16). `stacked` is whether GitHub puts it in one; `base` and `defaultBranch` are where it merges into and the repository's default branch, so a base that is the default branch
 * is the bottom open member; `head` is its commit. `settled` is `merged` once it has, `queued` once it is in the merge queue or has auto-merge on, and null otherwise. `refusal` is the newest refusal of the stack merge the arm bot left on the pull request, with the head it was given at and
 * GitHub's reason, or null when it left none.
 */
export type StackMergeFacts = Readonly<{
  stacked: boolean; base: string; defaultBranch: string; head: string;
  settled: "merged" | "queued" | null;
  refusal: Readonly<{ head: string; reason: string }> | null;
}>;

/**
 * A workflow run as the code host says it is (contract 1.17). `status` is where it is, and `conclusion` is how it ended, which is null until it has; GitHub's own words are kept (`success`, `failure`, `cancelled`, `skipped`, `neutral`, ...), because what
 * counts as a pass is the caller's. `url` is the run's page and `name` the workflow's. `jobs` counts the jobs that have completed of all the run lists, or is null when the run lists none yet.
 */
export type CiRun = Readonly<{ status: "queued" | "in_progress" | "completed"; conclusion: string | null; url: string; name: string; jobs: Readonly<{ done: number; total: number }> | null }>;

/**
 * One workflow run on a branch, with its jobs' billable facts (contract 1.22): `headSha` is the commit it ran on and `createdAt` when the host created it (ISO time). Each job carries the labels of the runner it ran on and when it started
 * and completed (ISO times, null until it has), which is all a caller needs to bill it. A run read as settled comes back with `jobs: []`.
 */
export type BranchCiRun = Readonly<{
  id: number; headSha: string; createdAt: string; status: "queued" | "in_progress" | "completed";
  jobs: readonly Readonly<{ labels: readonly string[]; startedAt: string | null; completedAt: string | null }>[];
}>;

/** A pull request that names a ticket's key (contract 1.18): where it is, its repository (`owner/name`), its state as the host says it, and its body, which is where a `Closes`, `Refs` or `Partial:` line says what it does for the ticket. */
export type NamingPull = Readonly<{ url: string; repo: string; state: "open" | "merged" | "closed"; body: string }>;

/** The pull request to hand to the arm bot (contract 1.16): its repository, `owner/name`, and its number. */
export type StackMergeRequest = Readonly<{ repo: string; number: number }>;

/** How a role authenticates: as the person's account, or as an installation token of a GitHub App named by id, key file and, when it has several, the installation (`slug` is the login the App's writes carry, without `[bot]`). */
export type RoleIdentity = Readonly<{ mode: "user-accounts" }> | Readonly<{ mode: "github-apps"; appId: string; keyPath: string; installationId?: string; slug?: string }>;

/**
 * Where this machine keeps what a code host's routing is rendered from: the host file's own facts, which are not the plugin's settings and which a plugin cannot import the reader of. `stateEntry(name)` is
 * where the host keeps one named entry of its state directory.
 */
export type HostPlace = Readonly<{
  /** Where the host puts the programs it ships on PATH. */
  binDir: string;
  /** The installed tool's checkout, or undefined on a host that runs the primary project's own `packages/agent-org`. */
  tool: string | undefined;
  /** The primary project's checkout, where the tool's programs are found when `tool` is undefined. */
  checkout: string;
  stateEntry(name: string): string;
}>;

/** What the wrapper is rendered from: the place, the folders of the workers' and the leads' accounts, and each role's identity as the host file declares it (every role is present). */
export type WrapperInputs = Readonly<{ place: HostPlace; accounts: Readonly<{ workers: string; leads: string }>; identity: Readonly<Record<string, RoleIdentity>> }>;

/** The wrapper as an owned file: where it is installed, its mode and the text it must hold, which is null when the plugin's shipped copy cannot be read (never the empty string). */
export type WrapperFile = Readonly<{ target: string; mode: number; expected: string | null }>;

/**
 * One write of the wrapper that is about to happen: `text` over what `installed` holds at `target` (null: nothing there). `allowNoApps` is the host's say-so that it really dropped its Apps.
 * `under` and `realBin` are for a test run: `under` says the process is one, and `realBin` is the real home's bin directory, which a test run may never write.
 */
export type WrapperWrite = Readonly<{ inputs: WrapperInputs; target: string; text: string; installed: string | null; allowNoApps: boolean; under?: boolean; realBin?: string }>;

/**
 * The routing wrapper (contract 1.3). Every operation is synchronous and answers about the inputs it is given; none writes: core writes the file, after asking {@link CodeHostWrapper.refusal}.
 */
export interface CodeHostWrapper {
  /** The wrapper as an owned file. THROWS, naming it, when the shipped text cannot be rendered from the inputs. */
  file(inputs: WrapperInputs): WrapperFile;
  /** The roles the inputs declare as Apps, in the order the wrapper lists them. */
  appRoles(inputs: WrapperInputs): readonly string[];
  /**
   * Why `write.text` must not be written, or null when it may be. A wrapper that names no App while the inputs declare one is refused, and so is one that would drop the Apps the installed copy names unless
   * `allowNoApps`, one that runs its minter from a temporary directory, and, in a test run, any write into the real home's bin directory.
   */
  refusal(write: WrapperWrite): string | null;
  /** What is wrong with the wrapper installed at `target`, said as a reason, or null when it is the one the inputs declare. `installed` is null when there is no file there. */
  divergence(inputs: WrapperInputs, current: Readonly<{ target: string; installed: string | null }>): string | null;
  /** Whether the installed wrapper's identity block is not the one the inputs declare, which is the one drift a tick mends itself. */
  identityStale(inputs: WrapperInputs, installed: string): boolean;
  /** Why `role`'s token cannot be minted with the App the inputs declare for it, or null when it can mint or the role has no App. */
  mintFailure(inputs: WrapperInputs, role: string): string | null;
}

/** An account or organisation whose repositories a person can pick (contract 1.14). The signed-in account is `kind: "account"`. */
export type RepositoryOwner = Readonly<{ login: string; kind: "account" | "organisation" }>;

/** A repository on the code host (contract 1.14): its name, which is the clone's name in the host file, and `owner/name`. */
export type HostRepository = Readonly<{ name: string; fullName: string }>;

/**
 * The repositories a person can pick at onboard (contract 1.14). Every operation is synchronous and acts as the person who runs onboard: their own login, with no role environment, as `repoViewArgs` and `repoCloneArgs` do.
 * A read answers `null` for "could not ask", never for "there is none".
 */
export interface CodeHostRepositories {
  /** The signed-in account first, then the organisations it belongs to, by login. Null: could not ask. */
  readOwners(): readonly RepositoryOwner[] | null;
  /** The owner's repositories the account can reach, archived ones left out, by name. Null: could not ask, or a list cut off at its limit. */
  readRepositories(owner: RepositoryOwner): readonly HostRepository[] | null;
  /** The repository a git remote URL names on this host, or null for another host's URL. Pure: it reads nothing. */
  repositoryOfRemote(url: string): HostRepository | null;
  /** The command {@link CodeHostRepositories.cloneRepository} runs, as a person would type it, for onboard to show before it runs. */
  cloneCommand(fullName: string, path: string): string;
  /** Clones `fullName` to `path` as the signed-in account. Answers null once cloned, else the host's own first line of why not. */
  cloneRepository(fullName: string, path: string): string | null;
}

/**
 * A code host plugin. Every read answers `null` for "could not ask", never for "there is none": a caller that acts on `null` acts on a guess.
 */
export interface CodeHost extends CodeHostPort {
  /** The arguments that ask the host whether the account it acts as can read `repo` (contract 1.7: onboard and the conventions install run them as the person's own login). Not row mode's: every code host has them. */
  repoViewArgs(repo: string): string[];
  /** The arguments that clone `remote` to `path` (contract 1.7; see {@link CodeHost.repoViewArgs}). */
  repoCloneArgs(remote: string, path: string): string[];
  /** The login of the account this host acts as, which is the board's workers' own, or null when it cannot be read. */
  readOwnLogin(): string | null;
  /**
   * The feedback on the pull request at `url`, leaving out what `self` wrote and what `alsoIgnore` wrote (the reviewer's, which a worker does not answer and which must never
   * move `feedbackAt`), or null for "could not ask".
   */
  readPullFeedback(url: string, self: string, alsoIgnore?: readonly string[]): PullFeedback | null;
  /**
   * The checks failing on the head of `repository`'s default branch (contract 1.13), or null for "could not ask": a repository the host cannot read, a branch with no head, and an answer of another shape are all
   * null. Null is never "nothing is red". A host without it is read as one that names none, and no red check is called main's.
   */
  readDefaultBranchRed?(repository: string): DefaultBranchRed | null;
  /**
   * Whether `repository` (`owner/name`) allows auto-merge and has the arm workflow on its default branch (contract 1.25), or null for "could not ask": a repository the host cannot read and an answer it cannot read are both null. Null is never "it has no merge flow".
   * A host without it is read as one that cannot be asked: the board then gives the reason it can read from the pull request alone, and doctor says the repository could not be read.
   */
  readMergeFlow?(repository: string): MergeFlow | null;
  /**
   * Brings the branch of the pull request at `url` up to date with its base (contract 1.15), as the workers' account, provided its head is still `expectedHead`: a head that moved since the caller read it is `refused`, not raced. Never throws: a host that cannot say
   * answers `refused` with a reason, and an address that is no pull request of the host is `refused`. A host without it cannot update a branch, and the board then holds a pull request as it did before.
   */
  updateBranch?(url: string, expectedHead: string): UpdateBranchResult;
  /**
   * Closes the pull request at `url` with `comment` posted on it (contract 1.23), as the workers' account: the board closes a member of a stack that holds nothing of its own, and never a person's pull request. THROWS, with the host's own first line, when the pull request cannot be
   * closed, and for an address that is no pull request of the host; it answers nothing, so a caller never reads a refusal as a close. A pull request that is already closed is not an error. A host without it cannot close, and the board then says on the card that the pull request is to be closed.
   */
  closePull?(url: string, comment: string): void;
  /**
   * Posts `comment` on the pull request at `url` as the workers' account (contract 1.26): the board records the result of a re-review the verdict door refused on the pull request itself. THROWS, with the host's own first line, when the comment
   * cannot be posted (an address that is no pull request of the host included), so no caller reads a refusal as a post.
   */
  commentOnPull?(url: string, comment: string): void;
  /**
   * What the pull request at `url` is, as the stack merge sees it (contract 1.16), or null for "could not ask": an address that is no pull request of the host, and a pull request the host will not say are both null. Null is never "it is not in a stack".
   * A host without it is read as one the board asks the arm bot for nothing on.
   */
  stackMergeFactsOf?(url: string): StackMergeFacts | null;
  /**
   * Asks the arm bot to merge the pull request (contract 1.16): the board never merges itself, so this starts the arm bot's own job, which re-reads everything with its own identity and trusts nothing the request says. THROWS, with the host's own first line, when the request is refused. It is also how the board puts a pull request back in the merge queue after a removal that was not the change's (A11-295): the job arms a plain pull request with auto-merge, and does nothing for one that is not approved or is held.
   */
  requestStackMerge?(request: StackMergeRequest): void;
  /**
   * The workflow run `runId` of `repository` (`owner/name`), or null for "could not ask": a run the host does not have, a refused read and an answer it cannot read are all null. Null is never "it has not finished". A host without it is read as one that cannot be asked
   * about a run (contract 1.17).
   */
  readCiRun?(repository: string, runId: number): CiRun | null;
  /**
   * The workflow runs of `repository` (`owner/name`) on `branch`, newest first, each with its jobs (contract 1.22), or null for "could not ask": a repository the host cannot read, an answer it cannot read and a list cut short at the host's page limit are all
   * null. Null is never "no runs". A run whose id is in `settled` (the caller holds its jobs and it has completed) is answered with no jobs, so the host reads each completed run's jobs once. A host without it is read as one that cannot be asked.
   */
  readBranchCi?(repository: string, branch: string, settled: ReadonlySet<number>): readonly BranchCiRun[] | null;
  /**
   * Every pull request of `repositories` (`owner/name`) whose title or body names `key`, in any state, or null for "could not ask": a repository the host cannot read, an answer it cannot read, and a list cut short at the host's limit are all null.
   * Null is never "none names it". The host answers what it finds and judges nothing: a pull request that only mentions the key in passing is listed too, and the caller decides which of them are the ticket's. A host without it is read as one that
   * cannot be asked (contract 1.18).
   */
  pullsNaming?(key: string, repositories: readonly string[]): readonly NamingPull[] | null;
  /**
   * The open pull requests of `repository` (`owner/name`) that the dependency bot ({@link DEPENDENCY_PULL_AUTHOR}) opened, or null for "could not ask": a repository the host cannot read, an answer it cannot read and a list cut short at the host's limit are
   * all null. Null is never "there are none". The host filters by AUTHOR, never by title (and without a search-backed flag such as `gh pr list --author`, whose allowance is small): this is the trust boundary of the board's dependency tickets. A host without it is read as one that cannot be asked (contract 1.19).
   */
  openDependencyPulls?(repository: string): readonly DependencyPull[] | null;
  /**
   * The failing `merge_group` run behind the removal from the merge group at commit `groupCommit` of the pull request at `url` (contract 1.21), or null for "could not ask": an address that is no pull request of the host, no run for that commit and a refused read are all null. Null is never "no job failed".
   * A host without it is read as one that cannot be asked, and the board then names the removal without the run's errors.
   */
  readQueueFailure?(url: string, groupCommit: string): QueueFailure | null;
  /**
   * Puts the `hold:board` label on the pull request at `url` (`on`), or takes it off (contract 1.21), and answers whether the label is now as asked. THROWS, with the host's own first line, when it could not ask or was refused. Taking off a label that is not there is done. A host without it cannot hold a pull request
   * from the arm bot, and the board then names the removals alone.
   */
  holdFromQueue?(url: string, on: boolean): boolean;
  /** The pull request's state as the reviewer sees it, or null when the host does not say. Throws the reviewer's refusal when its gate does not load. */
  readReviewState(url: string): ReviewState | null;
  /**
   * The replies on the pull request at `url` that `request` names, oldest first, or null for "could not ask". A reply with no text is left out, and so is one by an account `request`
   * does not name: its text goes into a reviewer's prompt, so the host never returns a stranger's. Null is never "no replies".
   */
  readReplies(url: string, request: RepliesRequest): readonly Reply[] | null;
  /** The pull request's state, `OPEN`, `MERGED` or `CLOSED`, or null when the host does not say. */
  readPullState(url: string): string | null;
  /** The URLs of a repository's open pull requests, or null for "could not ask" (a list at its limit is also null). */
  openPullUrlsOf(repository: string): string[] | null;
  /**
   * The note each open pull request of the sweep needs, by URL, after the retargets that are due are made: a merged base is moved to the default branch, and a
   * base whose branch is gone is said. A pull request that cannot be read keeps the note it had, and its head is never touched.
   */
  sweepRetargets(sweep: RetargetRequest): Record<string, string>;
  /**
   * What the merged pull request at `url` found (contract 1.4), or null for "could not ask": a pull request that has not merged is null too, since its findings are not final. Null is never "it
   * found nothing". A host without it passes no findings on.
   */
  readMergedFindings?(url: string): MergedFindings | null;
  /**
   * What the pull request at `url` still held when it closed (contract 1.20), or null for "could not ask": a pull request that is open or merged, an address that is no pull request of the host, a refused read, an answer it cannot read and a compare cut short
   * of its commits are all null. Null is never "it held nothing": a pull request whose commits are all on its base answers a {@link ClosedWork} with no commits. A host without it is read as one that cannot be asked.
   */
  readClosedWork?(url: string): ClosedWork | null;
  /**
   * The log of the job behind a failing check, given the address its run reports (`FailingCheck.detailsUrl`), as text, or null for "could not ask": an address that names no job (a commit status
   * reports none) and a log the host would not give are both null. Null is never "the log is empty" (contract 1.5).
   */
  readCheckLog(detailsUrl: string): string | null;
  /**
   * Reruns the failed jobs of the runs the addresses name (`FailingCheck.detailsUrl`), each run once however many of its jobs are named, and answers why the host refused (its own first line), or null
   * once they are rerun. An address that names no run is left out (contract 1.5).
   */
  rerunFailedChecks(detailsUrls: readonly string[]): string | null;
  /** The claim entries on `head` of `repository`, read fresh (never from a cache another account's write would not have dropped), or why they could not be read (contract 1.5). */
  readReviewClaims(repository: string, head: string): ReviewClaimRead;
  /** Writes a claim as the reviewer role, and answers why the host refused (its own first line), or null once it is written (contract 1.5). */
  writeReviewClaim(write: ReviewClaimWrite): string | null;
  /** The verdict door a reviewer posts with (contract 1.5), or absent for a code host that ships none. */
  readonly verdictDoor?: VerdictDoor;
  /** The routing wrapper of an org host (contract 1.3), or absent for a code host that installs none. */
  readonly wrapper?: CodeHostWrapper;
  /** Row mode's GitHub operations (contract 1.7), or absent for a code host that serves ticket mode only. */
  readonly rows?: CodeHostRows;
  /** The accounts, organisations and repositories a person can pick at onboard, and the clone of one (contract 1.14), or absent for a code host that lists none. */
  readonly repositories?: CodeHostRepositories;
}

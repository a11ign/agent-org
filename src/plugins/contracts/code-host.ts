// @ts-check
// module: the code host contract, version 1.15 -- what ticket mode asks of the place pull requests live (A11-158)
//
// A TYPE FILE: it imports nothing at run time. It is SYNCHRONOUS, because every reader of it is: the ticket port's gate (`ticket-port/port.ts`) and ticket
// mode's injected `gh: (args) => string` (`pool-context.ts`). It is written from the GitHub operations ticket mode makes today, and carries `CodeHostPort`'s four
// operations, which stay declared in `port.ts` (its source test holds that file to no import at all, a re-export included) and are named here by a type-only import. It
// imports nothing else of core: `ReviewState` is declared here, and `ticket-mode/reviewer-port.ts` re-exports it.
// An operation joins this contract only when a sibling ticket moves a call that needs it (A11-160 moves the gate's).
//
// ROW MODE'S GITHUB OPERATIONS are an optional `rows` group of this contract, not a second plugin (`docs/adr/0002-row-mode-github-is-an-optional-part-of-the-code-host-contract.md`); the group is declared in `code-host-rows.ts`.
//
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
export const CODE_HOST_CONTRACT_VERSION = "1.15";

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
  /** The files it changes, by path within its repository. */
  files: readonly string[];
  /** Whether `files` is all of them. Read a page of 100 at a time, up to {@link MAX_FILE_PAGES}: a list cut off there is not complete. */
  filesComplete: boolean;
}>;

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
   * Brings the branch of the pull request at `url` up to date with its base (contract 1.15), as the workers' account, provided its head is still `expectedHead`: a head that moved since the caller read it is `refused`, not raced. Never throws: a host that cannot say
   * answers `refused` with a reason, and an address that is no pull request of the host is `refused`. A host without it cannot update a branch, and the board then holds a pull request as it did before.
   */
  updateBranch?(url: string, expectedHead: string): UpdateBranchResult;
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

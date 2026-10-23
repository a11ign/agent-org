// @ts-check
// module: the code host contract's suite (A11-158; A11-167 adds `readMergedFindings`; A11-160 adds the checks, the review claim, the verdict door and the optional `rows`) -- `runCodeHostConformance(host, probe)` is the only definition of "a code host"
//
// EVERY READ ANSWERS `null` FOR "COULD NOT ASK", NEVER FOR "THERE IS NONE": that is the property a caller relies on, so the suite asks about a pull request the host
// does not have and requires `null`. The caller seeds what the probe names: an open pull request the host holds (`pull`) with the repository it is in
// (`repository`), a pull request address it holds nothing for (`missing`), and the login the host acts as (`self`). A code host is synchronous, as every reader of it is.
import type { ChangeRef, CodeHost, WrapperInputs } from "../contracts/code-host.ts";
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import { type Conditional, type ConformanceResult, expect, hasFunctions, isObject, isString, runChecks } from "./suite.ts";

/**
 * What the caller has seeded: an open pull request, its repository, one the host has none of, the account the host acts as, and optionally a change for the port's reads, the inputs a wrapper is asked about
 * (a host that installs no wrapper is not asked) and a merged pull request that has findings (`merged`, A11-167).
 */
export type CodeHostProbe = Readonly<{
  pull: string; repository: string; missing: string; self: string; change?: ChangeRef; wrapper?: WrapperInputs; merged?: string;
  /** A failing check's address whose log the host holds (`log`), and the text that log has to contain. */
  check?: Readonly<{ detailsUrl: string; log: string }>;
  /** A head a claim may be written on: the repository, the head, and the environment the claim is written with. Writing one is not undone, so a caller seeds a head it can discard. */
  claim?: Readonly<{ repository: string; head: string; environment: Readonly<Record<string, string>> }>;
}>;
type Subject = Readonly<{ host: CodeHost; probe: CodeHostProbe }>;

/** The operations of the optional `rows` group (contract 1.11), as a function each; the other members are values. */
const ROWS_OPERATIONS = ["ticketAdapter", "latestApprovals", "approvalFactsOf", "keyedCommentsOf", "postRowComment", "createRow", "editComment", "reviewsOf", "mergedWindowOf", "openPullFieldsOf", "readDisarmSeat", "disableAutoMergeOf",
  "boardFiledRow", "briefChairmanOnPull", "headOfChange", "checkRunsOfHead", "workflowRunsOf", "jobsOfRun", "failedLogOfRun", "stateOfRow", "redRunOfHead", "rerunFailedJobsOf", "closeRowWithComment", "commentsSince", "conditionalGetArgs",
  "pullViewArgs", "pullTextOf", "branchRefTextOf", "addedFilesTextOf", "fileAtTextOf", "defaultBranchFileTextOf", "commentOnIssue", "openIncidentsOf", "readOpenPullHeads", "openPullBodiesOf", "outsideArmListArgs", "readyPullRequest",
  "ensureTriageLabel", "isIssueOnBoard", "boardItemOf", "pullRequestFieldsOf", "queueEntriesOf", "mergeGroupRunCountOf", "dequeuePullRequestOf", "jobLogOf", "closedIncidentsOf", "createIncident", "closeIncident",
  "forgetRefusedReads", "isRowsByLabelRead", "readUnlessRefused", "readRowsByLabel", "readClaimedRows", "sincePageArgs", "isSinceRead", "parsePage", "foldPage", "readRowsSince", "readRowsSinceAsync", "asListJson", "readMergedPullRequests",
  "testsFirstReadsOf", "ownRun", "armedQueryArgs", "armedFromApi", "armedReason", "armedNodeOf", "armedReasonOf", "ejectionQueryArgs", "queueEjectionOf", "readQueueEjection", "openBlockersOf", "openBlockersOfRow",
  "labelsOfRow", "readPullComments", "commentOnPull", "addLabelsToPull", "readPullForArming", "pullStateOf", "armPullAuto", "settledReason", "armMergeOf", "trunkRunsPage", "readQueueSeat", "jumpToFront",
  "dequeueByHandCommand", "graphqlPoolOf", "openPullRequestsQueryArgs", "readOpenPullNodes", "isMergedPull", "isArmedPull", "readSweepFacts", "isCrossRepositoryPull", "readOutsideArmListed", "requiredContextsOf",
  "checkRunsOfCommit", "mainTipDateOf", "behindByOf", "closingIssuesOf", "recentClosesPrsOf", "pullForGuard", "pullForCiGate", "pullOutcomeOf", "openPullsOfBranch", "openPullsForQueue", "mergeQueuedPull",
  "compareWithMain", "deleteBranchOf", "gateRun", "runTogether", "unlabeledEventsOf", "labeledEventTimesOf", "newestLabellerOf", "commentActivityOf", "rowTimelineOf", "waitRefOf", "incidentItemOf", "rowBodyOf",
  "rowStateAndNewestComment", "rowForPromotion", "issueEventsPage", "closedPullsPage", "tagExistsOn", "newestCommentsOf", "recentlyClosedRowsOf", "commentOnRow", "commentBodiesOfRow", "addLabelToRow", "removeLabelFromRow",
  "setRowBody", "ensureLabel", "fileLabelledRow", "addLabelToRowByApi", "markPullReady", "addRowToProject", "setProjectStatus", "readRequiredContexts", "mainTipOf", "pullsOfBranch", "newestMergedPulls", "openPullListArgs",
  "pullFileNamesOf", "commitShasOf", "compareDiffOf", "failingCheckNamesAt", "checkRunSummariesAt", "mergeGroupRunsOf", "jobsOfMergeGroupRun", "actionsJobOf", "openRowsOf", "labelNamesWithPrefix", "closedClaimedRowsOf",
  "closedRowsCarryingLabels",
  "titleAndCommentsOf", "labelNamesOfRow", "rowStateOf", "labelsBodyTitleOf", "closeHomeRowWithComment", "fileRowWithLabels", "lastLabelEventOf", "markedCommentsOf", "isPullQueued", "pullStateWordOf", "issueStateAndLabelsOf",
  "firstCommentTimeStartingWith", "ownRunWithin", "readRestJson",
  "ensureLabelArgs", "readRestRow", "readRestComments", "setRowLabels", "editRowLabels",
  "argumentsRunOf", "blockerRowOf", "newestOpenRowsText", "setBoardItemOption", "fileRowFromArguments", "milestonesOf", "milestoneTitlesOf", "addLabelsToRowIn", "bodyTextOfRowIn", "milestoneTitleOfRow",
  "roadmapItemsOf", "roadmapFieldOf",
  "blockedByOf", "bodyAndLabelsOf", "rowShapeFactsOf", "rowCarriesLabel", "openPullReviewsOf", "commitsOfPull", "closingPullsOf", "crossReferencingPullsOf", "changedPathsOfPull", "openPullsWithFilesOf", "pullFilePathsOf",
  "ensureLabelIn", "addLabelToRowIn", "compareShaWithMain",
  "labelEventsOf", "removeLabelsFromRow", "closingTimelineTextOf", "closedRowListingTextOf", "labelEventLogTextOf", "pullStatesOf", "pullStatesOfBranchIn", "rowFactsIn", "openRestListingOf", "rowBodyIn",
  "runnerWith", "asyncRunnerWith", "commentOnRowByInput", "rowSnapshotOf", "apiTextOf", "conditionalGetOf",
  "readRowAsync", "commentOnRowAsync", "removeLabelAsync", "addLabelAsync", "issueCommentsAsync", "openPullChecksAsync", "restGetAsync", "pullReviewDecisionAsync",
  "teamRepositoriesTextOf", "lastMergeTextOf", "releaseRunsOf", "releaseJobsOf", "changesetNamesOf", "openRowLabelsOf", "openPullsNamingRowsOf",
  "commitAndParentsTextOf", "releasesOf", "hasIssuesEnabled", "compareRangeOf", "pullMergeOf",
  "issuePageOf", "allMilestonesOf", "discussionCategoriesOf", "discussionEditionsOf", "createDiscussion", "updateDiscussion", "draftReleaseOf", "createDraftRelease", "uploadReleaseAsset", "rowsListedIn", "pullsListedIn",
  "windowRowsTextOf", "editionCommentCountOf", "commentBodiesOfIssue", "workflowRunListOf", "workflowCreatedAtOf", "boardItemsPageOf", "touchedItemTextOf", "roadmapFactsOf", "commentAuthorOf", "headedCommentIdsText",
  "orgCommentsSinceOf", "issuesSinceOf", "labeledEventsOfRow",
] as const satisfies readonly (keyof CodeHostRows)[];

const OPERATIONS = ["repoViewArgs", "repoCloneArgs", "readOwnLogin", "readPullFeedback", "readReplies", "readReviewState", "readPullState", "openPullUrlsOf", "sweepRetargets", "readCheckLog", "rerunFailedChecks", "readReviewClaims", "writeReviewClaim", "readChange", "requestReview", "armMerge", "subscribe"] as const;
const PULL_STATES = ["OPEN", "MERGED", "CLOSED"];

const ALWAYS: Readonly<Record<string, (subject: Subject) => unknown>> = {
  "readOwnLogin names the account or answers null": ({ host }) => {
    const login = host.readOwnLogin();
    expect(login === null || (isString(login) && login !== ""), "readOwnLogin() must be a login, or null when it cannot be read");
  },
  "repoViewArgs and repoCloneArgs name the repository they are asked about": ({ host }) => {
    const view = host.repoViewArgs("owner/repo");
    const clone = host.repoCloneArgs("owner/repo", "/work/repo");
    expect(Array.isArray(view) && view.every(isString) && view.includes("owner/repo"), "repoViewArgs must be a list of arguments that names the repository");
    expect(Array.isArray(clone) && clone.every(isString) && clone.includes("owner/repo") && clone.includes("/work/repo"), "repoCloneArgs must be a list of arguments that names the remote and the path");
  },
  "readPullFeedback reads a pull request": ({ host, probe }) => {
    const feedback = host.readPullFeedback(probe.pull, probe.self);
    expect(isObject(feedback), `readPullFeedback(${probe.pull}) must read the pull request the host holds`);
    expect(["open", "merged", "closed"].includes(String(feedback.state)), "feedback.state must be open, merged or closed");
    expect(Array.isArray(feedback.failing) && Array.isArray(feedback.failures) && Array.isArray(feedback.authors) && Array.isArray(feedback.files), "feedback.failing, failures, authors and files must be lists");
    expect(typeof feedback.conflicting === "boolean" && typeof feedback.filesComplete === "boolean", "feedback.conflicting and filesComplete must be true or false");
    expect(typeof feedback.mergeable === "boolean" && typeof feedback.approvedAtHead === "boolean" && (feedback.head === null || isString(feedback.head)), "feedback.mergeable and approvedAtHead must be true or false, and head a commit or null");
  },
  "readPullFeedback answers null for a pull request it cannot read": ({ host, probe }) => {
    expect(host.readPullFeedback(probe.missing, probe.self) === null, "readPullFeedback must answer null for what it cannot read: null is never 'no feedback'");
  },
  "readReplies answers a list of replies, and null for a pull request it cannot read": ({ host, probe }) => {
    const replies = host.readReplies(probe.pull, { since: 0, authors: [probe.self] });
    expect(Array.isArray(replies) && replies.every((reply) => isString(reply.author) && isString(reply.url) && isString(reply.text) && Number.isFinite(reply.at)), `readReplies(${probe.pull}) must be a list of { author, at, url, text }`);
    expect(replies.every((reply) => reply.author === probe.self), "readReplies must return only the accounts it is asked for");
    expect(host.readReplies(probe.pull, { since: 0, authors: [] })?.length === 0, "readReplies of no accounts must be an empty list, never a reply of a stranger's");
    expect(host.readReplies(probe.missing, { since: 0, authors: [probe.self] }) === null, "readReplies must answer null for what it cannot read: null is never 'no replies'");
  },
  "readPullState names the state or answers null": ({ host, probe }) => {
    expect(PULL_STATES.includes(String(host.readPullState(probe.pull))), `readPullState(${probe.pull}) must be OPEN, MERGED or CLOSED`);
    expect(host.readPullState(probe.missing) === null, "readPullState must answer null for a pull request it cannot read");
  },
  "readReviewState reads the head, the reviews and whether the checks settled": ({ host, probe }) => {
    const state = host.readReviewState(probe.pull);
    expect(isObject(state) && isString(state.head) && Array.isArray(state.reviews) && typeof state.settled === "boolean", `readReviewState(${probe.pull}) must read { head, reviews, settled }`);
    expect(!isObject(state) || state.unrequiredRed === undefined || (Array.isArray(state.unrequiredRed) && state.unrequiredRed.every(isString)), `readReviewState(${probe.pull}) must name unrequiredRed, when it has any, as a list of check names`);
    expect(host.readReviewState(probe.missing) === null, "readReviewState must answer null for a pull request it cannot read");
  },
  "openPullUrlsOf lists a repository's open pull requests": ({ host, probe }) => {
    const urls = host.openPullUrlsOf(probe.repository);
    expect(Array.isArray(urls) && urls.every(isString), `openPullUrlsOf(${probe.repository}) must be a list of addresses`);
    expect(urls.includes(probe.pull), `openPullUrlsOf(${probe.repository}) must list the open pull request ${probe.pull}`);
  },
  "sweepRetargets keeps the note of a pull request it cannot read": ({ host, probe }) => {
    const note = "Needs retarget: kept from the last sweep";
    const notes = host.sweepRetargets({ urls: [probe.missing], previous: { [probe.missing]: note }, stacked: new Set(["feature/base"]), defaults: new Map(), log: () => undefined });
    expect(notes[probe.missing] === note, "sweepRetargets must keep the note a pull request had when it cannot be read, and ask again on the next sweep");
  },
  "sweepRetargets with no pull requests has no notes": ({ host }) => {
    const notes = host.sweepRetargets({ urls: [], previous: {}, stacked: new Set(), defaults: new Map(), log: () => undefined });
    expect(isObject(notes) && Object.keys(notes).length === 0, "sweepRetargets of no pull requests must have no notes");
  },
  "readCheckLog answers null for an address that names no job": ({ host }) => {
    expect(host.readCheckLog("https://example.invalid/checks/not-a-job") === null, "readCheckLog must answer null for an address that names no job: null is never 'the log is empty'");
  },
  "rerunFailedChecks of no checks reruns nothing and says so": ({ host }) => {
    expect(host.rerunFailedChecks([]) === null, "rerunFailedChecks of no addresses must answer null: there is nothing to refuse");
    expect(host.rerunFailedChecks(["https://example.invalid/checks/not-a-job"]) === null, "rerunFailedChecks must leave out an address that names no run");
  },
  "readReviewClaims answers the entries of a head, or why it could not": ({ host, probe }) => {
    const read = host.readReviewClaims(probe.repository, "0".repeat(40));
    const entries = "entries" in read ? read.entries : undefined;
    expect(isObject(read) && (Array.isArray(entries) !== isString("unreadable" in read ? read.unreadable : undefined)), "readReviewClaims must answer { entries } or { unreadable }, and never both or neither");
    expect(entries === undefined || entries.every((entry) => Number.isFinite(entry.id) && isString(entry.description) && Number.isFinite(entry.created)), "each claim entry must be { id, description, created }");
    expect(!("unreadable" in read) || read.unreadable !== "", "the reason a claim could not be read must say something");
  },
  "subscribe returns the function that cancels it": ({ host }) => {
    let received = 0;
    const cancel = host.subscribe({}, () => { received += 1; });
    expect(typeof cancel === "function", "subscribe() must return the function that cancels it");
    cancel();
    expect(received === 0, "a subscription must not be called with an event that never happened");
  },
};

const withChange = (reason: string, run: (subject: Subject & { change: ChangeRef }) => unknown): Conditional<Subject> => ({
  applies: ({ probe }) => probe.change !== undefined, reason: `the probe names no change, so ${reason}`, run: (subject) => run({ ...subject, change: subject.probe.change! }),
});

const withWrapper = (reason: string, run: (subject: Subject & { inputs: WrapperInputs }) => unknown): Conditional<Subject> => ({
  applies: ({ host, probe }) => host.wrapper !== undefined && probe.wrapper !== undefined, reason: `the code host has no wrapper or the probe names no inputs for one, so ${reason}`, run: (subject) => run({ ...subject, inputs: subject.probe.wrapper! }),
});

const withCheck = (reason: string, run: (subject: Subject & { check: NonNullable<CodeHostProbe["check"]> }) => unknown): Conditional<Subject> => ({
  applies: ({ probe }) => probe.check !== undefined, reason: `the probe names no check, so ${reason}`, run: (subject) => run({ ...subject, check: subject.probe.check! }),
});

const withClaim = (reason: string, run: (subject: Subject & { claim: NonNullable<CodeHostProbe["claim"]> }) => unknown): Conditional<Subject> => ({
  applies: ({ probe }) => probe.claim !== undefined, reason: `the probe names no head to claim, so ${reason}`, run: (subject) => run({ ...subject, claim: subject.probe.claim! }),
});

/** A `run` the host refuses: every call throws, as `gh` does for a call it cannot make. */
const refused = (): string => {
  throw new Error("HTTP 502: the host refused the call");
};

/** Whether `call` throws: a read that could not be made must not answer an empty list, and a write that could not be made must not read as done. */
function throws(call: () => unknown): boolean {
  try {
    call();
    return false;
  } catch {
    return true;
  }
}

/** Rows whose operations act on the `run` their caller hands them (`acts: "through-run"`): only those have a refused `run` to answer. */
const withRunRows = (reason: string, run: (subject: Subject & { rows: CodeHostRows }) => unknown): Conditional<Subject> => ({
  applies: ({ host }) => host.rows?.acts === "through-run", reason: `the code host has no rows that act through the caller's run (contract 1.10), so ${reason}`, run: (subject) => run({ ...subject, rows: subject.host.rows! }),
});

const withRows = (reason: string, run: (subject: Subject & { rows: CodeHostRows }) => unknown): Conditional<Subject> => ({
  applies: ({ host }) => host.rows !== undefined, reason: `the code host has no rows, which are optional (contract 1.10), so ${reason}`, run: (subject) => run({ ...subject, rows: subject.host.rows! }),
});

const CONDITIONAL: Readonly<Record<string, Conditional<Subject>>> = {
  "the rows are the operations row mode asks of the code host": withRows("row mode's operations are not asked", ({ rows }) => {
    expect(hasFunctions(rows, ROWS_OPERATIONS), `rows is an object with ${ROWS_OPERATIONS.join(", ")} functions`);
    expect(rows.acts === "through-run" || rows.acts === "on-its-own-state", "rows.acts must be through-run or on-its-own-state");
    expect(isString(rows.tracker) && rows.tracker !== "" && isString(rows.openItemsQuery) && rows.openItemsQuery !== "", "rows.tracker and rows.openItemsQuery must be text");
    expect(Number.isInteger(rows.sincePageSize) && rows.sincePageSize > 0 && Number.isInteger(rows.projectItemsPage) && rows.projectItemsPage > 0, "rows.sincePageSize and rows.projectItemsPage must be whole numbers above 0");
    expect(Array.isArray(rows.corePoolProbe) && rows.corePoolProbe.every(isString), "rows.corePoolProbe must be a list of arguments");
    expect(isString(rows.command) && rows.command !== "", "rows.command must be the name of the program the code host starts");
  }),
  "a read the rows could not make answers null or throws, never an empty answer": withRunRows("no refused read is asked", ({ rows, probe }) => {
    const { repository } = probe;
    expect(rows.openIncidentsOf(repository, refused) === null && rows.closedIncidentsOf(repository, refused) === null && rows.openPullBodiesOf(repository, refused) === null, "a list of incidents or pull requests that could not be read must be null: null is never 'none'");
    expect(rows.commentsSince({ repo: repository, since: 0, run: () => null }) === null, "comments that could not be read must be null: null is never 'no comment'");
    expect(rows.approvalFactsOf({ repo: repository, number: 1, head: "a".repeat(40) }, refused) === null && rows.pullRequestFieldsOf({ repo: repository, number: 1, fields: "number", run: refused }) === null, "approval facts and a pull request's fields that could not be read must be null");
    const heads = rows.readOpenPullHeads(repository, refused, 100);
    expect(!heads.read && isString(heads.reason) && heads.reason !== "", "open pull request heads that could not be read must say why, and never be an empty list");
    const adapter = rows.ticketAdapter({ run: refused, scope: repository });
    expect(adapter.readItem({ tracker: rows.tracker, scope: repository, id: 1 }) === null && adapter.readOpenItems() === null, "an item or the open items that could not be read must be null: null is never an empty board");
    expect(throws(() => rows.readRowsByLabel({ label: "x", state: "OPEN", select: "number", run: refused })) && throws(() => rows.readClaimedRows({ run: refused })), "rows by label that could not be read must throw: never nobody holds a row");
    expect(throws(() => rows.readRowsSince({ ask: { kind: "issues", states: ["OPEN"], orderBy: "CREATED_AT", repo: repository, select: "number", newest: 1 }, run: refused })), "a window of rows that could not be read must throw: never an empty window");
    expect(throws(() => rows.queueEntriesOf({ repo: repository, branch: "main", run: refused })) && throws(() => rows.checkRunsOfHead(repository, "a".repeat(40), refused)), "queue entries and check runs that could not be read must throw");
  }),
  "a write the rows could not make throws, so no caller reads it as done": withRunRows("no refused write is asked", ({ rows, probe }) => {
    const { repository } = probe;
    expect(throws(() => rows.closeRowWithComment({ row: 1, repo: repository, comment: "done", run: refused })) && throws(() => rows.postRowComment({ repo: repository, row: 1, body: "b", run: refused }))
      && throws(() => rows.commentOnIssue({ repo: repository, issue: 1, body: "b", run: refused })) && throws(() => rows.editComment({ repo: repository, id: 1, body: "b", run: refused })), "a comment or a close that was refused must throw");
    expect(throws(() => rows.disableAutoMergeOf({ number: "1", repo: repository, run: refused })) && throws(() => rows.readyPullRequest({ number: 1, repo: repository, run: refused })) && throws(() => rows.dequeuePullRequestOf({ pullId: "x", run: refused })), "a merge or a readiness change that was refused must throw");
    expect(throws(() => rows.createRow({ repo: repository, title: "t", labels: [], body: "b", run: () => "created, and no address printed" })), "a row filed that printed no address must throw: a row filed and not numbered would be filed again");
  }),
  "the rows' pure helpers answer as the callers that sweep approvals and fold pages expect": withRows("no helper is asked", ({ rows }) => {
    const reviews = [
      { reviewer: "a", state: "APPROVED", commitId: "1", submittedAt: "2026-10-01T00:00:00Z" }, { reviewer: "a", state: "CHANGES_REQUESTED", commitId: "2", submittedAt: "2026-10-02T00:00:00Z" },
      { reviewer: "b", state: "COMMENTED", commitId: "3", submittedAt: "2026-10-03T00:00:00Z" }, { reviewer: "b", state: "APPROVED", commitId: "4", submittedAt: "2026-10-04T00:00:00Z" },
    ];
    expect(JSON.stringify(rows.latestApprovals(reviews).map(({ reviewer }) => reviewer)) === '["b"]', "an approval stands only until its reviewer's newest opinion changes it: a is not an approver after asking for changes");
    const ask = { kind: "pullRequests", states: ["MERGED"], orderBy: "UPDATED_AT", repo: "o/r", select: "number", newest: 1 } as const;
    expect(rows.isSinceRead(rows.sincePageArgs(ask, null)) && !rows.isRowsByLabelRead(rows.sincePageArgs(ask, null)), "a window page is recognised as a window page, and not as a read by label");
    const listed = rows.asListJson({ labels: { nodes: [{ name: "x" }] }, number: 1 });
    expect(Array.isArray(listed.labels) && listed.number === 1, "asListJson must turn a connection into its list and leave a scalar alone");
    expect(throws(() => rows.parsePage("{}", ask)), "a page that is not a connection must throw: 'could not read' is never an empty page");
  }),
  "a read the rows could not make for arming, the merge guard and the queue throws, never an empty answer": withRunRows("no refused read is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const reads: Record<string, () => unknown> = {
      armedNodeOf: () => rows.armedNodeOf({ number: 1, repo, run: refused }), armedReasonOf: () => rows.armedReasonOf({ repo, number: "1", run: refused }), readQueueEjection: () => rows.readQueueEjection({ number: 1, repo, run: refused }),
      openBlockersOfRow: () => rows.openBlockersOfRow({ repo, number: 1, run: refused }), labelsOfRow: () => rows.labelsOfRow({ repo, number: 1, run: refused }), readPullComments: () => rows.readPullComments({ repo, number: 1, run: refused }),
      readPullForArming: () => rows.readPullForArming({ repo, number: "1", run: refused }), pullStateOf: () => rows.pullStateOf({ repo, number: "1", run: refused }), trunkRunsPage: () => rows.trunkRunsPage({ repo, workflow: "ci.yml", page: 1, perPage: 10, run: refused }),
      readQueueSeat: () => rows.readQueueSeat({ repo, number: "1", run: refused }), readOpenPullNodes: () => rows.readOpenPullNodes({ repo, run: refused }), isMergedPull: () => rows.isMergedPull({ repo, number: "1", run: refused }),
      isArmedPull: () => rows.isArmedPull({ repo, number: "1", run: refused }), readSweepFacts: () => rows.readSweepFacts({ repo, number: "1", run: refused }), readOutsideArmListed: () => rows.readOutsideArmListed({ repo, limit: 10, run: refused }),
      requiredContextsOf: () => rows.requiredContextsOf({ repo, run: refused }), checkRunsOfCommit: () => rows.checkRunsOfCommit({ repo, sha: "a".repeat(40), run: refused }), mainTipDateOf: () => rows.mainTipDateOf({ repo, run: refused }),
      behindByOf: () => rows.behindByOf({ repo, head: "a".repeat(40), run: refused }), closingIssuesOf: () => rows.closingIssuesOf({ repo, number: 1, run: refused }), recentClosesPrsOf: () => rows.recentClosesPrsOf({ repo, run: refused }),
      pullForGuard: () => rows.pullForGuard({ repo, number: 1, run: refused }), pullForCiGate: () => rows.pullForCiGate({ repo, number: 1, run: refused }), pullOutcomeOf: () => rows.pullOutcomeOf({ repo, number: 1, run: refused }),
      openPullsOfBranch: () => rows.openPullsOfBranch({ repo, branch: "b", run: refused }), openPullsForQueue: () => rows.openPullsForQueue({ run: refused }), compareWithMain: () => rows.compareWithMain({ repo, branch: "b", run: refused }),
    };
    for (const [name, read] of Object.entries(reads)) expect(throws(read), `${name} must throw when the read is refused: a read that could not be made is never an empty answer`);
  }),
  "a write the rows could not make for arming, the merge and the queue throws, so no caller reads it as done": withRunRows("no refused write is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const writes: Record<string, () => unknown> = {
      commentOnPull: () => rows.commentOnPull({ repo, number: 1, body: "b", run: refused }), addLabelsToPull: () => rows.addLabelsToPull({ repo, number: "1", labels: ["x"], run: refused }),
      armPullAuto: () => rows.armPullAuto({ repo, number: 1, run: refused }), jumpToFront: () => rows.jumpToFront({ id: "x", headOid: "a".repeat(40), run: refused }), mergeQueuedPull: () => rows.mergeQueuedPull({ number: 1, run: refused }),
      deleteBranchOf: () => rows.deleteBranchOf({ repo, branch: "b", run: refused }), armMergeOf: () => rows.armMergeOf({ repo, number: "1", run: refused }, { sleep: () => undefined, attempts: 1, error: () => undefined }),
    };
    for (const [name, write] of Object.entries(writes)) expect(throws(write), `${name} must throw when the write is refused${name === "armMergeOf" ? " and nothing explains the refusal (not settled, not armed meanwhile)" : ""}`);
  }),
  "a read the rows could not make for the work gate throws or answers null, never an empty answer": withRunRows("no refused read is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const reads: Record<string, () => unknown> = {
      unlabeledEventsOf: () => rows.unlabeledEventsOf({ repo, number: 1, run: refused }), labeledEventTimesOf: () => rows.labeledEventTimesOf({ number: 1, label: "x", run: refused }),
      newestLabellerOf: () => rows.newestLabellerOf({ number: 1, label: "x", run: refused }), commentActivityOf: () => rows.commentActivityOf({ number: 1, run: refused }),
      rowTimelineOf: () => rows.rowTimelineOf({ repo, number: 1, run: refused }), waitRefOf: () => rows.waitRefOf({ repo, number: 1, run: refused }), incidentItemOf: () => rows.incidentItemOf({ ref: `${repo}#1`, run: refused }),
      rowBodyOf: () => rows.rowBodyOf({ number: 1, run: refused }), rowForPromotion: () => rows.rowForPromotion({ repo, number: 1, run: refused }), issueEventsPage: () => rows.issueEventsPage({ repo, page: 1, pageSize: 10, run: refused }),
      closedPullsPage: () => rows.closedPullsPage({ repo, page: 1, pageSize: 10, run: refused }), mainTipOf: () => rows.mainTipOf({ run: refused }), pullsOfBranch: () => rows.pullsOfBranch({ branch: "b", limit: 10, run: refused }),
      newestMergedPulls: () => rows.newestMergedPulls({ run: refused }), pullFileNamesOf: () => rows.pullFileNamesOf({ number: 1, run: refused }), commitShasOf: () => rows.commitShasOf({ repo, number: 1, run: refused }),
      compareDiffOf: () => rows.compareDiffOf({ repo, base: "main", head: "a".repeat(40), run: refused }), failingCheckNamesAt: () => rows.failingCheckNamesAt({ repo, commit: "a".repeat(40), run: refused }),
      checkRunSummariesAt: () => rows.checkRunSummariesAt({ repo, commit: "a".repeat(40), run: refused }), mergeGroupRunsOf: () => rows.mergeGroupRunsOf({ repo, withConclusion: true, run: refused }),
      jobsOfMergeGroupRun: () => rows.jobsOfMergeGroupRun({ repo, runId: 1, run: refused }), actionsJobOf: () => rows.actionsJobOf({ repo, jobId: "1", run: refused }), openRowsOf: () => rows.openRowsOf({ limit: 10, fields: "number", run: refused }),
      labelNamesWithPrefix: () => rows.labelNamesWithPrefix({ prefix: "x:", run: refused }), closedClaimedRowsOf: () => rows.closedClaimedRowsOf({ repo, numbers: [1], claimLabel: "x", run: refused }),
      commentBodiesOfRow: () => rows.commentBodiesOfRow({ number: 1, run: refused }), recentlyClosedRowsOf: () => rows.recentlyClosedRowsOf({ limit: 10, run: refused }),
      closedRowsCarryingLabels: () => rows.closedRowsCarryingLabels({ names: ["x"], kind: "issues", run: refused }),
    };
    for (const [name, read] of Object.entries(reads)) expect(throws(read), `${name} must throw when the read is refused: a read that could not be made is never an empty answer`);
    expect(rows.rowStateAndNewestComment({ repo, number: 1, run: refused }) === null && rows.tagExistsOn({ repo, tag: "v1", run: refused }) === null && rows.newestCommentsOf({ repo, numbers: [1], last: 1, run: refused }) === null,
      "a row's state and newest comment, a tag and a list of newest comments that could not be read are null: null is never 'no comment' or 'no tag'");
    const contexts = rows.readRequiredContexts({ run: refused });
    expect(contexts.contexts === null && isString(contexts.diagnosis) && contexts.diagnosis !== "", "the required checks that could not be read are null with the report of why: null is never 'nothing blocks'");
  }),
  "a write the rows could not make for the work gate throws, so no caller reads it as done": withRunRows("no refused write is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const writes: Record<string, () => unknown> = {
      commentOnRow: () => rows.commentOnRow({ number: 1, body: "b", run: refused }), addLabelToRow: () => rows.addLabelToRow({ number: 1, label: "x", run: refused }),
      removeLabelFromRow: () => rows.removeLabelFromRow({ number: 1, label: "x", run: refused }), setRowBody: () => rows.setRowBody({ number: 1, body: "b", run: refused }),
      ensureLabel: () => rows.ensureLabel({ name: "x", description: "d", run: refused }), fileLabelledRow: () => rows.fileLabelledRow({ title: "t", label: "x", body: "b", run: refused }),
      addLabelToRowByApi: () => rows.addLabelToRowByApi({ repo, number: 1, label: "x", run: refused }), markPullReady: () => rows.markPullReady({ number: 1, run: refused }),
      addRowToProject: () => rows.addRowToProject({ owner: "o", projectNumber: 1, url: "https://github.com/o/r/issues/1", run: refused }),
      setProjectStatus: () => rows.setProjectStatus({ owner: "o", projectNumber: 1, url: "https://github.com/o/r/issues/1", status: "Ready", run: refused }),
    };
    for (const [name, write] of Object.entries(writes)) expect(throws(write), `${name} must throw when the write is refused`);
  }),
  "a read the rows could not make for wake throws or answers null, never an empty answer": withRunRows("no refused read is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const reads: Record<string, () => unknown> = {
      titleAndCommentsOf: () => rows.titleAndCommentsOf({ repo, number: 1, run: refused }), labelNamesOfRow: () => rows.labelNamesOfRow({ repo, number: 1, run: refused }),
      rowStateOf: () => rows.rowStateOf({ number: 1, repo, run: refused }), labelsBodyTitleOf: () => rows.labelsBodyTitleOf({ repo, number: 1, run: refused }),
      lastLabelEventOf: () => rows.lastLabelEventOf({ number: 1, label: "x", run: refused }), markedCommentsOf: () => rows.markedCommentsOf({ number: 1, marker: "m", run: refused }),
      isPullQueued: () => rows.isPullQueued({ repo, number: 1, run: refused }), pullStateWordOf: () => rows.pullStateWordOf({ repo, number: 1, run: refused }),
      issueStateAndLabelsOf: () => rows.issueStateAndLabelsOf({ repo, number: 1, run: refused }),
      firstCommentTimeStartingWith: () => rows.firstCommentTimeStartingWith({ repo, number: 1, prefix: "p", pageSize: 10, run: refused }), readRestJson: () => rows.readRestJson({ args: ["x"], run: refused }),
    };
    for (const [name, read] of Object.entries(reads)) expect(throws(read), `${name} must throw when the read is refused: a read that could not be made is never an empty answer`);
    void repo;
  }),
  "a write the rows could not make for wake throws, so no caller reads it as done": withRunRows("no refused write is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const writes: Record<string, () => unknown> = {
      closeHomeRowWithComment: () => rows.closeHomeRowWithComment({ number: 1, comment: "c", run: refused }), fileRowWithLabels: () => rows.fileRowWithLabels({ title: "t", body: "b", labels: ["x"], run: refused }),
    };
    for (const [name, write] of Object.entries(writes)) expect(throws(write), `${name} must throw when the write is refused`);
    void repo;
  }),
  "a read the rows could not make for the claim throws or answers null, never an empty answer": withRunRows("no refused read is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const reads: Record<string, () => unknown> = {
      readRestRow: () => rows.readRestRow({ repo, number: 1, run: refused }), readRestComments: () => rows.readRestComments({ repo, number: 1, run: refused }),
    };
    for (const [name, read] of Object.entries(reads)) expect(throws(read), `${name} must throw when the read is refused: a read that could not be made is never an empty answer`);
    void repo;
  }),
  "a write the rows could not make for the claim throws, so no caller reads it as done": withRunRows("no refused write is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const writes: Record<string, () => unknown> = {
      setRowLabels: () => rows.setRowLabels({ repo, number: 1, labels: ["x"], run: refused }),
      editRowLabels: () => rows.editRowLabels({ repo, number: 1, remove: ["x"], add: [], run: refused }),
    };
    for (const [name, write] of Object.entries(writes)) expect(throws(write), `${name} must throw when the write is refused`);
    void repo;
  }),
  "a read the rows could not make for the filing of rows throws or answers null, never an empty answer": withRunRows("no refused read is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const reads: Record<string, () => unknown> = {
      newestOpenRowsText: () => rows.newestOpenRowsText({ repo, limit: 10, run: refused }), milestonesOf: () => rows.milestonesOf({ repo, run: refused }), milestoneTitlesOf: () => rows.milestoneTitlesOf({ repo, run: refused }),
      bodyTextOfRowIn: () => rows.bodyTextOfRowIn({ repo, number: 1, run: refused }), milestoneTitleOfRow: () => rows.milestoneTitleOfRow({ repo, number: 1, run: refused }),
      roadmapItemsOf: () => rows.roadmapItemsOf({ repo, number: 1, field: "Roadmap", run: refused }), roadmapFieldOf: () => rows.roadmapFieldOf({ owner: "o", boardNumber: 1, field: "Roadmap", run: refused }),
    };
    for (const [name, read] of Object.entries(reads)) expect(throws(read), `${name} must throw when the read is refused: a read that could not be made is never an empty answer`);
    expect(rows.blockerRowOf({ number: 1, repo, run: refused }) === null, "a blocker that could not be read is null: an unreadable blocker is an unknown, never an umbrella");
    let seen = undefined as [string, string[]] | undefined;
    const answer = rows.argumentsRunOf((program, args) => { seen = [program, args]; return "ok"; })(["x", "y"]);
    expect(answer === "ok" && seen !== undefined && isString(seen[0]) && seen[0] !== "" && JSON.stringify(seen[1]) === '["x","y"]', "the runner made of a program runner must hand it the code host's program and the arguments, unchanged");
  }),
  "a write the rows could not make for the filing of rows throws, so no caller reads it as done": withRunRows("no refused write is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const writes: Record<string, () => unknown> = {
      setBoardItemOption: () => rows.setBoardItemOption({ itemId: "i", projectId: "p", fieldId: "f", optionId: "o", run: refused }), fileRowFromArguments: () => rows.fileRowFromArguments({ argv: ["--title", "t"], run: refused }),
      addLabelsToRowIn: () => rows.addLabelsToRowIn({ repo, number: 1, labels: ["x"], run: refused }),
    };
    for (const [name, write] of Object.entries(writes)) expect(throws(write), `${name} must throw when the write is refused`);
    void repo;
  }),
  "a read the rows could not make for the claim's rules throws or answers null, never an empty answer": withRunRows("no refused read is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const reads: Record<string, () => unknown> = {
      blockedByOf: () => rows.blockedByOf({ repo, number: 1, run: refused }), bodyAndLabelsOf: () => rows.bodyAndLabelsOf({ repo, number: 1, run: refused }), rowShapeFactsOf: () => rows.rowShapeFactsOf({ repo, number: 1, run: refused }),
      rowCarriesLabel: () => rows.rowCarriesLabel({ repo, number: 1, label: "x", run: refused }), openPullReviewsOf: () => rows.openPullReviewsOf({ repo, limit: 10, run: refused }),
      commitsOfPull: () => rows.commitsOfPull({ repo, number: 1, run: refused }), closingPullsOf: () => rows.closingPullsOf({ repo, number: 1, run: refused }),
      crossReferencingPullsOf: () => rows.crossReferencingPullsOf({ repo, number: 1, run: refused }), changedPathsOfPull: () => rows.changedPathsOfPull({ repo, number: 1, run: refused }),
      openPullsWithFilesOf: () => rows.openPullsWithFilesOf({ repo, run: refused }), pullFilePathsOf: () => rows.pullFilePathsOf({ repo, number: 1, run: refused }),
    };
    for (const [name, read] of Object.entries(reads)) expect(throws(read), `${name} must throw when the read is refused: a read that could not be made is never an empty answer`);
    expect(rows.compareShaWithMain({ repo, sha: "a".repeat(40), run: refused }) === null, "a compare that could not be made is null: null is never 'nothing changed'");
  }),
  "a write the rows could not make for the claim's rules throws, so no caller reads it as done": withRunRows("no refused write is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const writes: Record<string, () => unknown> = {
      ensureLabelIn: () => rows.ensureLabelIn({ repo, name: "x", run: refused }), addLabelToRowIn: () => rows.addLabelToRowIn({ repo, number: 1, label: "x", run: refused }),
    };
    for (const [name, write] of Object.entries(writes)) expect(throws(write), `${name} must throw when the write is refused`);
  }),
  "a read the rows could not make for the other claim and row files throws or answers null, never an empty answer": withRunRows("no refused read is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const reads: Record<string, () => unknown> = {
      labelEventsOf: () => rows.labelEventsOf({ repo, row: 1, run: refused }), closingTimelineTextOf: () => rows.closingTimelineTextOf({ repo, number: 1, run: refused }),
      closedRowListingTextOf: () => rows.closedRowListingTextOf({ repo, limit: 10, run: refused }), labelEventLogTextOf: () => rows.labelEventLogTextOf({ repo, run: refused }),
      pullStatesOf: () => rows.pullStatesOf({ repo, limit: 10, run: refused }), pullStatesOfBranchIn: () => rows.pullStatesOfBranchIn({ repo, branch: "b", run: refused }),
      rowFactsIn: () => rows.rowFactsIn({ repo, number: 1, run: refused }), openRestListingOf: () => rows.openRestListingOf({ repo, kind: "issues", run: refused }), rowBodyIn: () => rows.rowBodyIn({ repo, number: 1, run: refused }),
    };
    for (const [name, read] of Object.entries(reads)) expect(throws(read), `${name} must throw when the read is refused: a read that could not be made is never an empty answer`);
  }),
  "a write the rows could not make for the other claim and row files throws, so no caller reads it as done": withRunRows("no refused write is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const writes: Record<string, () => unknown> = {
      removeLabelsFromRow: () => rows.removeLabelsFromRow({ repo, number: 1, labels: ["x"], run: refused }),
    };
    for (const [name, write] of Object.entries(writes)) expect(throws(write), `${name} must throw when the write is refused`);
  }),
  "a read the rows could not make for the board, the health and retro readings, the DORA reader and the trace throws, never an empty answer": withRunRows("no refused read is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const reads: Record<string, () => unknown> = {
      teamRepositoriesTextOf: () => rows.teamRepositoriesTextOf({ org: "o", team: "t", run: refused }), lastMergeTextOf: () => rows.lastMergeTextOf({ repo, window: 10, run: refused }),
      releaseRunsOf: () => rows.releaseRunsOf({ repo, window: 10, run: refused }), releaseJobsOf: () => rows.releaseJobsOf({ repo, runId: 1, window: 10, shape: "named", run: refused }),
      changesetNamesOf: () => rows.changesetNamesOf({ repo, run: refused }), openRowLabelsOf: () => rows.openRowLabelsOf({ repo, limit: 10, run: refused }), openPullsNamingRowsOf: () => rows.openPullsNamingRowsOf({ repo, limit: 10, run: refused }),
      commitAndParentsTextOf: () => rows.commitAndParentsTextOf({ repo, ref: "v1", run: refused }), releasesOf: () => rows.releasesOf({ repo, run: refused }), hasIssuesEnabled: () => rows.hasIssuesEnabled({ repo, run: refused }),
      compareRangeOf: () => rows.compareRangeOf({ repo, base: "a", head: "b", run: refused }), pullMergeOf: () => rows.pullMergeOf({ repo, number: 1, run: refused }),
      issuePageOf: () => rows.issuePageOf({ repo, after: null, run: refused }), allMilestonesOf: () => rows.allMilestonesOf({ repo, run: refused }), discussionCategoriesOf: () => rows.discussionCategoriesOf({ owner: "o", name: "n", run: refused }),
      discussionEditionsOf: () => rows.discussionEditionsOf({ owner: "o", name: "n", categoryId: "c", run: refused }), rowsListedIn: () => rows.rowsListedIn({ repo, state: "open", limit: 10, fields: "number", run: refused }),
      pullsListedIn: () => rows.pullsListedIn({ repo, state: "open", limit: 10, fields: "number", run: refused }), windowRowsTextOf: () => rows.windowRowsTextOf({ repo, since: "2026-01-01T00:00:00Z", run: refused }),
      editionCommentCountOf: () => rows.editionCommentCountOf({ repo, issue: "1", since: "2026-01-01T00:00:00Z", title: "t", run: refused }), commentBodiesOfIssue: () => rows.commentBodiesOfIssue({ repo, number: 1, run: refused }),
      workflowRunListOf: () => rows.workflowRunListOf({ repo, workflow: "w.yml", fields: "event", limit: 10, run: refused }), workflowCreatedAtOf: () => rows.workflowCreatedAtOf({ repo, workflow: "w.yml", run: refused }),
      boardItemsPageOf: () => rows.boardItemsPageOf({ owner: "o", number: 1, cursor: null, run: refused }), touchedItemTextOf: () => rows.touchedItemTextOf({ owner: "o", repo, project: 1, issue: 1, run: refused }),
      roadmapFactsOf: () => rows.roadmapFactsOf({ repo, numbers: [1], run: refused }), commentAuthorOf: () => rows.commentAuthorOf({ repo, id: "1", run: refused }),
      headedCommentIdsText: () => rows.headedCommentIdsText({ repo, row: "1", since: "2026-01-01T00:00:00Z", heading: "h", run: refused }), orgCommentsSinceOf: () => rows.orgCommentsSinceOf({ repo, since: "2026-01-01T00:00:00Z", loginPrefix: "x-", run: refused }),
      issuesSinceOf: () => rows.issuesSinceOf({ repo, since: "2026-01-01T00:00:00Z", run: refused }), labeledEventsOfRow: () => rows.labeledEventsOfRow({ repo, number: 1, run: refused }),
      rowSnapshotOf: () => rows.rowSnapshotOf({ repo, number: 1, run: refused }), apiTextOf: () => rows.apiTextOf({ args: ["x"], run: refused }),
    };
    for (const [name, read] of Object.entries(reads)) expect(throws(read), `${name} must throw when the read is refused: a read that could not be made is never an empty answer`);
    expect(rows.draftReleaseOf({ repo, tag: "t", run: refused }) === null, "a release that could not be read is null: null is never 'a draft'");
  }),
  "a write the rows could not make for the board throws, so no caller reads it as done": withRunRows("no refused write is asked", ({ rows, probe }) => {
    const { repository: repo } = probe;
    const writes: Record<string, () => unknown> = {
      createDiscussion: () => rows.createDiscussion({ repositoryId: "r", categoryId: "c", title: "t", body: "b", run: refused }), updateDiscussion: () => rows.updateDiscussion({ discussionId: "d", body: "b", run: refused }),
      createDraftRelease: () => rows.createDraftRelease({ repo, tag: "t", file: "f.pdf", title: "t", notes: "n", run: refused }), uploadReleaseAsset: () => rows.uploadReleaseAsset({ repo, tag: "t", file: "f.pdf", run: refused }),
    };
    for (const [name, write] of Object.entries(writes)) expect(throws(write), `${name} must throw when the write is refused`);
  }),
  "an async read or write the rows could not make rejects, so no caller reads it as done": withRunRows("no refused run is asked", async ({ rows, probe }) => {
    const { repository: repo } = probe;
    const refusedAsync = (): Promise<string> => Promise.reject(new Error("refused"));
    const asks: Record<string, () => Promise<unknown>> = {
      readRowAsync: () => rows.readRowAsync({ repo, number: 1, run: refusedAsync }), commentOnRowAsync: () => rows.commentOnRowAsync({ repo, number: 1, body: "b", run: refusedAsync }),
      removeLabelAsync: () => rows.removeLabelAsync({ repo, number: 1, label: "x", run: refusedAsync }), addLabelAsync: () => rows.addLabelAsync({ repo, number: 1, label: "x", run: refusedAsync }),
      issueCommentsAsync: () => rows.issueCommentsAsync({ repo, number: 1, run: refusedAsync }), openPullChecksAsync: () => rows.openPullChecksAsync({ repo, limit: 10, run: refusedAsync }),
      restGetAsync: () => rows.restGetAsync({ path: `repos/${repo}/issues/1`, run: refusedAsync }), pullReviewDecisionAsync: () => rows.pullReviewDecisionAsync({ repo, number: 1, run: refusedAsync }),
      readRowsSinceAsync: () => rows.readRowsSinceAsync({ ask: { kind: "issues", states: ["OPEN"], orderBy: "CREATED_AT", repo, select: "number", newest: 1 }, run: refusedAsync }),
    };
    for (const [name, ask] of Object.entries(asks)) {
      const rejected = await ask().then(() => false, () => true);
      expect(rejected, `${name} must reject when the run is refused: a call that could not be made is never done`);
    }
    const ruined = await rows.removeLabelAsync({ repo, number: 1, label: "x", run: () => Promise.reject(Object.assign(new Error("Command failed"), { stderr: "gh: Label does not exist (HTTP 404)" })) }).then(() => true, () => false);
    expect(ruined, "removeLabelAsync must resolve when the label is already absent, and only then");
  }),
  "the rows' rules for arming answer as the callers that arm and guard expect": withRows("no rule is asked", ({ rows }) => {
    expect(!rows.armedFromApi(null) && !rows.armedFromApi({}) && rows.armedFromApi({ merged: true }) && rows.armedFromApi({ autoMergeRequest: { enabledAt: "t" } }) && rows.armedFromApi({ mergeQueueEntry: { state: "QUEUED" } }),
      "a pull request is armed when it merged, auto-merges or sits in the merge queue, and nobody has armed one that is none of those");
    expect(rows.armedReason({ merged: true, mergeQueueEntry: {} }) === "it is already merged" && rows.armedReason({ mergeQueueEntry: {} }) === "it is already queued to merge"
      && rows.armedReason({ autoMergeRequest: {} }) === "auto-merge is already enabled on it" && rows.armedReason({}) === null, "the most advanced armed state is named, and an unarmed one has no reason");
    expect(rows.settledReason("MERGED") === "it is already merged" && rows.settledReason("CLOSED") === "it is already closed" && rows.settledReason("OPEN") === null && rows.settledReason(null) === null,
      "only merged and closed leave nothing to arm; an unread state is not one");
    const node = (state: string) => ({ number: 4, state });
    expect(JSON.stringify(rows.openBlockersOf({ blockedBy: { nodes: [node("OPEN"), { number: 5, state: "CLOSED" }, { number: 6 }] } })) === "[4,6]", "a blocker is open unless it is known closed");
    expect(rows.openBlockersOf({}) === null && rows.openBlockersOf({ blockedBy: { nodes: [{ number: 5, state: "CLOSED" }], totalCount: 3 } }) === null, "a list that cannot be trusted whole is null, never 'no blockers'");
    const queued = (reason: string) => ({ timelineItems: { nodes: [{ __typename: "AddedToMergeQueueEvent", createdAt: "t1" }, { __typename: "RemovedFromMergeQueueEvent", createdAt: "t2", reason }] } });
    expect(rows.queueEjectionOf(queued("failed_checks"))?.ejected === true && rows.queueEjectionOf(queued("manual"))?.ejected === false, "only a removal for failed checks is an ejection");
    expect(rows.queueEjectionOf({ ...queued("failed_checks"), mergeQueueEntry: { state: "QUEUED" } })?.ejected === false, "a pull request in the queue now is not ejected, whatever the history says");
    expect(rows.queueEjectionOf({}) === null && rows.queueEjectionOf(null) === null, "an answer with no history is null, never 'not ejected'");
  }),
  "readCheckLog reads the log behind a failing check": withCheck("no check's log is read", ({ host, check }) => {
    const log = host.readCheckLog(check.detailsUrl);
    expect(isString(log) && log.includes(check.log), `readCheckLog(${check.detailsUrl}) must read the log the host holds`);
  }),
  "a claim written on a head is read back from it": withClaim("no claim is written", ({ host, claim }) => {
    const description = `claimed by conformance at ${new Date(0).toISOString()}, lease 60 min`;
    const before = host.readReviewClaims(claim.repository, claim.head);
    expect("entries" in before, `readReviewClaims(${claim.repository}, ${claim.head}) must read the head the probe names`);
    expect(host.writeReviewClaim({ repository: claim.repository, head: claim.head, description, environment: claim.environment }) === null, "writeReviewClaim must answer null once the claim is written");
    const after = host.readReviewClaims(claim.repository, claim.head);
    expect("entries" in after && after.entries.length === before.entries.length + 1 && after.entries.some((entry) => entry.description === description), "the claim written must be read back among the head's entries");
  }),
  "the verdict door is a file the plugin ships, with the program that installs it": {
    applies: ({ host }) => host.verdictDoor !== undefined,
    reason: "the code host ships no verdict door, which is optional (contract 1.5)",
    run: ({ host }) => {
      const door = host.verdictDoor!;
      expect(isString(door.source) && door.source.startsWith("/") && isString(door.installer) && door.installer.startsWith("/"), "verdictDoor must be { source, installer }, each an absolute path");
    },
  },
  "readMergedFindings reads what a merged pull request found, and answers null for one it cannot read or that has not merged": {
    applies: ({ host }) => typeof host.readMergedFindings === "function",
    reason: "the code host has no readMergedFindings, which is optional (contract 1.4)",
    run: ({ host, probe }) => {
      expect(host.readMergedFindings!(probe.missing) === null, "readMergedFindings must answer null for what it cannot read: null is never 'it found nothing'");
      expect(host.readMergedFindings!(probe.pull) === null, "readMergedFindings must answer null for a pull request that has not merged, whose findings are not final");
      if (probe.merged === undefined) return;
      const found = host.readMergedFindings!(probe.merged);
      expect(isObject(found) && isString(found.title) && Number.isInteger(found.number) && isString(found.body) && Array.isArray(found.sections), `readMergedFindings(${probe.merged}) must read { title, number, body, sections }`);
      expect(found.sections.every((section) => isString(section.file) && isString(section.heading) && isString(section.text)), "each section must be { file, heading, text }");
    },
  },
  "readChange reads a change, and answers null for one it cannot": withChange("the port's reads are not asked", ({ host, change }) => {
    const facts = host.readChange(change);
    expect(isObject(facts) && isString(facts.head) && Array.isArray(facts.checks) && Array.isArray(facts.reviews) && isObject(facts.merge), "readChange must read { ref, head, checks, reviews, merge }");
    expect(host.readChange({ host: change.host, id: "no-such-change" }) === null, "readChange must answer null for a change it cannot read");
  }),
  "armMerge arms the merge and says it is armed": withChange("the merge is not armed", ({ host, change }) => {
    expect(host.armMerge(change) === true, "armMerge must answer true once the merge is armed");
  }),
  "the wrapper is an owned file its own text agrees with": withWrapper("the wrapper is not asked", ({ host, inputs }) => {
    const wrapper = host.wrapper!;
    expect(hasFunctions(wrapper, ["file", "appRoles", "refusal", "divergence", "identityStale", "mintFailure"]), "a wrapper has file, appRoles, refusal, divergence, identityStale and mintFailure functions");
    const { target, mode, expected } = wrapper.file(inputs);
    expect(isString(target) && target !== "" && Number.isInteger(mode) && (expected === null || (isString(expected) && expected !== "")), "wrapper.file() must be { target, mode, expected }: expected is the text, or null when it cannot be read, never ''");
    expect(wrapper.divergence(inputs, { target, installed: expected }) === null, "the wrapper is not diverged from its own text");
    expect(isString(wrapper.divergence(inputs, { target, installed: null })), "wrapper.divergence() must say there is no wrapper where nothing is installed");
    expect(Array.isArray(wrapper.appRoles(inputs)) && wrapper.appRoles(inputs).every(isString), "wrapper.appRoles() must be a list of roles");
  }),
  "the wrapper keeps its own text, and writes it": withWrapper("the wrapper is not asked", ({ host, inputs }) => {
    const wrapper = host.wrapper!;
    const { target, expected } = wrapper.file(inputs);
    expect(expected !== null, "the probe's wrapper must have a text to write");
    expect(wrapper.identityStale(inputs, expected!) === false, "the wrapper's own text is not stale");
    expect(wrapper.refusal({ inputs, target, text: expected!, installed: expected, allowNoApps: false, under: false, realBin: "/nonexistent/real-bin" }) === null, "the wrapper must not refuse to write its own text over itself");
  }),
  "the wrapper answers whether each declared role mints": withWrapper("the wrapper is not asked", ({ host, inputs }) => {
    const wrapper = host.wrapper!;
    for (const role of wrapper.appRoles(inputs)) {
      const failure = wrapper.mintFailure(inputs, role);
      expect(failure === null || (isString(failure) && failure !== ""), `wrapper.mintFailure(${role}) must be the reason it cannot mint, or null`);
    }
    expect(wrapper.mintFailure(inputs, "no-such-role") === null, "a role with no App has nothing to fail to mint");
  }),
};

/**
 * Runs every check against `host`, so one run reports EVERY way a code host is wrong.
 * @throws ContractError listing each failed check
 */
export function runCodeHostConformance(host: CodeHost, probe: CodeHostProbe): Promise<ConformanceResult> {
  return runChecks("codeHost", { host, probe }, {
    shape: ({ host: candidate }) => expect(hasFunctions(candidate, OPERATIONS), `a code host is an object with ${OPERATIONS.join(", ")} functions`),
    always: ALWAYS,
    conditional: CONDITIONAL,
  });
}

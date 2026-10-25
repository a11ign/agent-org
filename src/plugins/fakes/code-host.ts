// @ts-check
// module: the in-memory code host (A11-158) -- the reference that passes `runCodeHostConformance`, and what core's tests use in place of GitHub
//
// IT HOLDS PULL REQUESTS, AND ROW MODE'S ROWS (`code-host-rows.ts`), and answers `null` for one it was never given, as a host does that cannot read it. A test seeds a pull request (`seedPull`),
// moves its head or its checks, and reads what the board asked of it (`calls`) and did to it (`armed`, `reviewRequests`, `retargets`). Every read is synchronous, as the contract's are.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { branchCiOf, type FakeBranchCi } from "./code-host-ci.ts";
import { createFakeRows, emptyRowsWorld } from "./code-host-rows.ts";
import { DEPENDENCY_PULL_AUTHOR, type ChangeFacts, type ChangeRef, type CiRun, type ClosedCommit, type CodeHost, type CodeHostEvent, type CodeHostEventKind, type CodeHostRepositories, type CodeHostWrapper, type DefaultBranchRed, type HostRepository, type MergedFindings, type RepositoryOwner, type PullFeedback, type PullQueue, type QueueFailure, type Reply, type RetargetRequest, type ReviewClaimEntry, type ReviewState, type StackMergeFacts, type StackMergeRequest, type UpdateBranchResult, type VerdictDoor, type WrapperInputs } from "../contracts/code-host.ts";

/** A pull request as the fake holds it. */
export type FakePull = {
  repository: string; number: number; state: "open" | "merged" | "closed"; base: string; head: string; files: string[];
  /** What the pull request found, once it has merged (A11-167). */
  findings?: MergedFindings;
  /** What the pull request still holds that is not on its base (contract 1.20): its branch's name, its commits and the files they change. One that is given none holds nothing: everything it held is on its base. */
  closedWork?: { branch?: string; commits: readonly ClosedCommit[]; files: readonly string[]; filesComplete?: boolean };
  /** A pull request a bot opened (contract 1.19): its title, its branch and who authored it. `openDependencyPulls` returns only those the dependency bot authored. */
  dependency?: { title: string; headRefName: string; author: string };
  /** What the merge queue did to the pull request (contract 1.21). A pull request given none is one the fake does not say anything of: `PullFeedback.queue` is then absent, which is not "no removals". */
  queue?: PullQueue;
  feedback: Partial<PullFeedback>; replies: readonly Reply[]; body?: string; reviews: ReviewState["reviews"]; settled: boolean; unrequiredRed?: ReviewState["unrequiredRed"]; trust: ReviewState["trust"]; merge: { armed: boolean; mergeable: boolean | null };
};

const HOST = "fake";

/** The fake's verdict door and its installer: files that post nothing, beside this one. */
const FAKE_DOOR: VerdictDoor = {
  source: fileURLToPath(new URL("./verdict-door/pr-review-verdict.sh", import.meta.url)),
  installer: fileURLToPath(new URL("./verdict-door/install-reviewer-bin.sh", import.meta.url)),
};

/** The address of a pull request the fake holds. */
export const fakePullUrl = (repository: string, number: number): string => `https://github.com/${repository}/pull/${number}`;

type Pulls = Map<string, FakePull>;
type Subscriber = { filter: Readonly<{ kinds?: readonly CodeHostEventKind[]; ref?: ChangeRef }>; handler: (event: CodeHostEvent) => void };

/** The reads of pull requests: `null` for one the fake was never given, as a host does that cannot read it. */
function readsOf(pulls: Pulls, repositories: Set<string>, defaultBranches: Map<string, DefaultBranchRed>, login: string | null, calls: string[]):
  Pick<CodeHost, "readOwnLogin" | "readPullFeedback" | "readDefaultBranchRed" | "readReplies" | "readReviewState" | "readPullState" | "readMergedFindings" | "openPullUrlsOf" | "pullsNaming" | "openDependencyPulls" | "readChange"> {
  return {
    readOwnLogin() {
      calls.push("readOwnLogin");
      return login;
    },
    readPullFeedback(url, self, alsoIgnore = []) {
      calls.push(`readPullFeedback ${url}`);
      const pull = pulls.get(url);
      if (pull === undefined) return null;
      // What `self` wrote, and what the accounts it is told to ignore wrote, is not feedback: it is left out, as the contract says.
      const ignored = (author: string): boolean => author === self || alsoIgnore.includes(author);
      const authors = (pull.feedback.authors ?? []).filter((author) => !ignored(author));
      const approvedAtHead = pull.reviews.some((review) => review.commit === pull.head && review.state === "APPROVED" && !ignored(review.author));
      return { state: pull.state, feedbackAt: null, failing: [], failures: [], failedAt: null, conflicting: false, mergeable: pull.merge.mergeable === true, head: pull.head, approvedAtHead,
        base: pull.base, files: pull.files, filesComplete: true, reviewDecision: null, verdictAtHead: verdictAtHead(pull, self), pendingRequired: [], body: pull.body ?? "", ...(pull.queue === undefined ? {} : { queue: pull.queue }), ...pull.feedback, authors };
    },
    readDefaultBranchRed(repository) {
      calls.push(`readDefaultBranchRed ${repository}`);
      return defaultBranches.get(repository) ?? null;
    },
    readReplies(url, { since, authors }) {
      calls.push(`readReplies ${url}`);
      const pull = pulls.get(url);
      // Only the accounts the caller names, and only what was posted after the time: the contract's own filter, so a test seeds every reply and the fake keeps the right ones.
      return pull === undefined ? null : pull.replies.filter((reply) => reply.at > since && authors.includes(reply.author)).sort((a, b) => a.at - b.at);
    },
    readReviewState(url) {
      calls.push(`readReviewState ${url}`);
      const pull = pulls.get(url);
      return pull === undefined ? null : { head: pull.head, trust: pull.trust, reviews: pull.reviews, settled: pull.settled, ...(pull.unrequiredRed === undefined ? {} : { unrequiredRed: pull.unrequiredRed }), view: { number: pull.number, ...(pull.body === undefined ? {} : { body: pull.body }) } };
    },
    readPullState(url) {
      calls.push(`readPullState ${url}`);
      return pulls.get(url)?.state.toUpperCase() ?? null;
    },
    readMergedFindings(url) {
      calls.push(`readMergedFindings ${url}`);
      const pull = pulls.get(url);
      return pull?.state === "merged" ? pull.findings ?? { title: `Pull request ${pull.number}`, number: pull.number, body: "", sections: [] } : null;
    },
    openPullUrlsOf(repository) {
      calls.push(`openPullUrlsOf ${repository}`);
      const inRepository = [...pulls.entries()].filter(([, pull]) => pull.repository === repository);
      // A repository the fake was given neither a pull request nor a `seedRepository` of is one it cannot ask about: null, never "none are open".
      return inRepository.length === 0 && !repositories.has(repository) ? null : inRepository.filter(([, pull]) => pull.state === "open").map(([url]) => url);
    },
    openDependencyPulls(repository) {
      calls.push(`openDependencyPulls ${repository}`);
      const inRepository = [...pulls.entries()].filter(([, pull]) => pull.repository === repository);
      if (inRepository.length === 0 && !repositories.has(repository)) return null;
      // The trust boundary: only a pull request the dependency bot authored, whatever its title says.
      return inRepository.flatMap(([url, pull]) => (pull.state === "open" && pull.dependency?.author === DEPENDENCY_PULL_AUTHOR
        ? [{ url, number: pull.number, title: pull.dependency.title, headRefName: pull.dependency.headRefName, headSha: pull.head, author: DEPENDENCY_PULL_AUTHOR, body: pull.body ?? "" }] : []));
    },
    pullsNaming(key, repos) {
      calls.push(`pullsNaming ${key} ${repos.join(",")}`);
      // A repository the fake was given neither a pull request nor a `seedRepository` of is one it cannot ask about, as in `openPullUrlsOf`.
      if (repos.some((repo) => ![...pulls.values()].some((pull) => pull.repository === repo) && !repositories.has(repo))) return null;
      const names = new RegExp(`(?<![A-Za-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i");
      return [...pulls.entries()].filter(([, pull]) => repos.includes(pull.repository) && names.test(pull.body ?? "")).map(([url, pull]) => ({ url, repo: pull.repository, state: pull.state, body: pull.body ?? "" }));
    },
    readChange(ref) {
      const pull = pulls.get(ref.id);
      if (ref.host !== HOST || pull === undefined) return null;
      return { ref, head: pull.head, checks: [], reviews: [], merge: { state: pull.state, armed: pull.merge.armed, mergeable: pull.merge.mergeable } };
    },
  };
}

/** The read of what a closed pull request still held (contract 1.20) over what a test seeded: null for a pull request that is open, merged or never given, as the contract says. */
function closedWorkOf(pulls: Pulls, calls: string[]): Pick<CodeHost, "readClosedWork"> {
  return {
    readClosedWork(url) {
      calls.push(`readClosedWork ${url}`);
      const pull = pulls.get(url);
      // An open or a merged pull request is not read: its work is not final, or it is on its base.
      if (pull?.state !== "closed") return null;
      const { branch = `branch-${pull.number}`, commits = [], files = [], filesComplete = true } = pull.closedWork ?? {};
      return { number: pull.number, url, base: pull.base, branch, head: pull.head, commits, files, filesComplete };
    },
  };
}

/** What the newest review on the pull request's head that approves or requests changes says, by anyone but `self`: the reviewer's too. */
function verdictAtHead(pull: FakePull, self: string): "approved" | "changes-requested" | null {
  const rulings = pull.reviews.filter((review) => review.commit === pull.head && review.author !== self && (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED"));
  const newest = rulings.reduce<ReviewState["reviews"][number] | null>((latest, review) => (latest === null || review.at >= latest.at ? review : latest), null);
  return newest === null ? null : newest.state === "APPROVED" ? "approved" : "changes-requested";
}

/**
 * What the fake holds of checks and claims (contract 1.5), and what a test sets: the log behind a check's address (`logs`; an address with none is one the host cannot read), the runs `rerunFailedChecks`
 * was asked to rerun, why it refuses (`rerunRefusal`), the claim entries by `repository@head` (`claims`), the clock a claim is written at, why a claim cannot be read or written, and the claims written.
 */
export type FakeChecksAndClaims = {
  logs: Map<string, string>;
  reruns: string[][];
  rerunRefusal: string | null;
  claims: Map<string, ReviewClaimEntry[]>;
  now: () => number;
  claimReadRefusal: string | null;
  claimWriteRefusal: string | null;
  claimWrites: { repository: string; head: string; description: string; environment: Readonly<Record<string, string>> }[];
};

/** The reads and writes of checks and review claims over what a test seeded. */
function checksAndClaimsOf(state: FakeChecksAndClaims, calls: string[]): Pick<CodeHost, "readCheckLog" | "rerunFailedChecks" | "readReviewClaims" | "writeReviewClaim"> {
  const keyOf = (repository: string, head: string): string => `${repository}@${head}`;
  return {
    readCheckLog(detailsUrl) {
      calls.push(`readCheckLog ${detailsUrl}`);
      return state.logs.get(detailsUrl) ?? null;
    },
    rerunFailedChecks(detailsUrls) {
      calls.push("rerunFailedChecks");
      if (state.rerunRefusal !== null) return state.rerunRefusal;
      state.reruns.push([...detailsUrls]);
      return null;
    },
    readReviewClaims(repository, head) {
      calls.push(`readReviewClaims ${repository} ${head}`);
      return state.claimReadRefusal === null ? { entries: [...(state.claims.get(keyOf(repository, head)) ?? [])] } : { unreadable: state.claimReadRefusal };
    },
    writeReviewClaim({ repository, head, description, environment }) {
      calls.push(`writeReviewClaim ${repository} ${head}`);
      if (state.claimWriteRefusal !== null) return state.claimWriteRefusal;
      state.claimWrites.push({ repository, head, description, environment });
      const entries = state.claims.get(keyOf(repository, head)) ?? [];
      entries.push({ id: entries.length + 1, description, created: state.now() });
      state.claims.set(keyOf(repository, head), entries);
      return null;
    },
  };
}

/**
 * What the fake does when asked to update a pull request's branch (contract 1.15), and what a test sets: the answer for each pull request (`answers`, by address; one it holds and was given none for is `updated`), and each update asked
 * for, in order (`asked`). A pull request the fake does not hold is refused, as a host refuses an address that is no pull request of its own.
 */
export type FakeBranchUpdates = { answers: Map<string, UpdateBranchResult>; asked: { url: string; expectedHead: string }[] };

/** The update of a pull request's branch over what a test seeded. */
function branchUpdatesOf(state: FakeBranchUpdates, pulls: Pulls, calls: string[]): Pick<CodeHost, "updateBranch"> {
  return {
    updateBranch(url, expectedHead) {
      calls.push(`updateBranch ${url} ${expectedHead}`);
      state.asked.push({ url, expectedHead });
      if (!pulls.has(url)) return { kind: "refused", reason: `fake code host: no pull request ${url}` };
      return state.answers.get(url) ?? { kind: "updated" };
    },
  };
}

/**
 * What the fake does when asked to close a pull request (contract 1.23), and what a test sets: why it refuses a pull request (`refusals`, by address), and each close, in order (`closed`). A close sets the pull request's state to closed, so it reads `CLOSED`; a pull request
 * that is closed already is not an error, and its comment is not posted again. A pull request the fake does not hold throws, as a host does for an address that is no pull request of its own.
 */
export type FakeCloses = { refusals: Map<string, string>; closed: { url: string; comment: string }[] };

/** The close of a pull request over what a test seeded. */
function closesOf(state: FakeCloses, pulls: Pulls, calls: string[]): Pick<CodeHost, "closePull"> {
  return {
    closePull(url, comment) {
      calls.push(`closePull ${url}`);
      const pull = pulls.get(url);
      if (pull === undefined) throw new Error(`fake code host: no pull request ${url}`);
      const refusal = state.refusals.get(url);
      if (refusal !== undefined) throw new Error(refusal);
      if (pull.state === "closed") return;
      pull.state = "closed";
      state.closed.push({ url, comment });
    },
  };
}

/**
 * What the fake holds of the stack merge (contract 1.16), and what a test sets: what a pull request is said to be in a stack (`facts`, by address; a pull request the fake holds and was given none for is not in a stack, based where it is, at its head, and `merged` once it has merged),
 * why the arm bot cannot be asked (`requestRefusal`), and each pull request the arm bot was asked for, in order (`requests`).
 */
export type FakeStackMerges = { facts: Map<string, Partial<StackMergeFacts>>; requestRefusal: string | null; requests: StackMergeRequest[] };

/** The stack merge's reads and its request over what a test seeded. A pull request the fake does not hold cannot be read, and is null. */
function stackMergesOf(state: FakeStackMerges, pulls: Pulls, calls: string[]): Pick<CodeHost, "stackMergeFactsOf" | "requestStackMerge"> {
  return {
    stackMergeFactsOf(url) {
      calls.push(`stackMergeFactsOf ${url}`);
      const pull = pulls.get(url);
      if (pull === undefined) return null;
      return { stacked: false, base: pull.base, defaultBranch: "main", head: pull.head, settled: pull.state === "merged" ? "merged" : null, refusal: null, ...state.facts.get(url) };
    },
    requestStackMerge(request) {
      calls.push(`requestStackMerge ${request.repo}#${request.number}`);
      if (state.requestRefusal !== null) throw new Error(state.requestRefusal);
      state.requests.push(request);
    },
  };
}

/**
 * What the fake holds of workflow runs (contract 1.17), and what a test sets: each run by `owner/name#runId`. A run the fake was given none for cannot be asked about, and is null. `asked` lists each run it was asked about, in order.
 */
export type FakeCiRuns = { runs: Map<string, CiRun>; asked: string[] };

/** The read of a workflow run over what a test seeded. */
function ciRunsOf(state: FakeCiRuns, calls: string[]): Pick<CodeHost, "readCiRun"> {
  return {
    readCiRun(repository, runId) {
      const key = `${repository}#${runId}`;
      calls.push(`readCiRun ${key}`);
      state.asked.push(key);
      return state.runs.get(key) ?? null;
    },
  };
}

/**
 * What the fake holds of the merge queue's reads and the hold (contract 1.21), and what a test sets: the failing run behind a removal (`failures`, by `<url>@<groupCommit>`; one it was given none for cannot be found, and is null), why a hold is refused (`holdRefusal`),
 * which pull requests carry the hold label now (`held`), and each hold or lift asked for, in order (`holds`). A pull request the fake does not hold cannot be held: the call throws, as the contract says.
 */
export type FakeQueues = { failures: Map<string, QueueFailure>; holdRefusal: string | null; held: Set<string>; holds: { url: string; on: boolean }[] };

/** The key a removal's failing run is seeded under. */
export const queueFailureKey = (url: string, groupCommit: string): string => `${url}@${groupCommit}`;

/** The merge queue's failure read and the hold over what a test seeded. */
function queuesOf(state: FakeQueues, pulls: Pulls, calls: string[]): Pick<CodeHost, "readQueueFailure" | "holdFromQueue"> {
  return {
    readQueueFailure(url, groupCommit) {
      calls.push(`readQueueFailure ${url} ${groupCommit}`);
      return pulls.has(url) ? state.failures.get(queueFailureKey(url, groupCommit)) ?? null : null;
    },
    holdFromQueue(url, on) {
      calls.push(`holdFromQueue ${url} ${on}`);
      if (!pulls.has(url)) throw new Error(`fake code host: no pull request ${url}`);
      if (state.holdRefusal !== null) throw new Error(state.holdRefusal);
      state.holds.push({ url, on });
      if (on) state.held.add(url);
      else state.held.delete(url);
      return state.held.has(url) === on;
    },
  };
}

/** Whether a merged pull request of the repository was the head of `base`: the base the run stacked on has landed. */
const baseMerged = (pulls: Pulls, pull: FakePull): boolean => [...pulls.values()].some((other) => other.repository === pull.repository && other.head === pull.base && other.state === "merged");

/** The stack retarget sweep: a stacked pull request whose base merged is moved to the default branch, and a pull request it cannot read keeps its note. */
function sweepOf(pulls: Pulls, retargets: { url: string; base: string }[]): CodeHost["sweepRetargets"] {
  return ({ urls, previous, stacked, defaults, log }: RetargetRequest) => {
    const notes: Record<string, string> = {};
    for (const url of urls) {
      const pull = pulls.get(url);
      if (pull === undefined) {
        if (previous[url] !== undefined) notes[url] = previous[url];
      } else if (pull.state === "open" && stacked.has(pull.base) && baseMerged(pulls, pull)) {
        const fallback = defaults.get(pull.repository) ?? "main";
        defaults.set(pull.repository, fallback);
        pull.base = fallback;
        retargets.push({ url, base: fallback });
        log(`retargeted ${url} to ${fallback}`);
      }
    }
    return notes;
  };
}

/** The port's writes and its subscription. */
function actionsOf(pulls: Pulls, subscribers: Subscriber[], record: { armed: string[]; reviewRequests: { ref: ChangeRef; reviewer: string }[] }): Pick<CodeHost, "requestReview" | "armMerge" | "subscribe"> {
  const pullOf = (ref: ChangeRef): FakePull => {
    const pull = pulls.get(ref.id);
    if (pull === undefined) throw new RangeError(`fake code host: no change ${ref.id}`);
    return pull;
  };
  return {
    requestReview(ref, reviewer) {
      pullOf(ref);
      record.reviewRequests.push({ ref, reviewer });
    },
    armMerge(ref) {
      pullOf(ref).merge.armed = true;
      record.armed.push(ref.id);
      return true;
    },
    subscribe(filter, handler) {
      const entry = { filter, handler };
      subscribers.push(entry);
      return () => {
        const at = subscribers.indexOf(entry);
        if (at !== -1) subscribers.splice(at, 1);
      };
    },
  };
}

/** What the fake's wrapper says of a role: the text carries the roles that are Apps, so a role that moves changes the text, and a test sets what the wrapper refuses and what cannot mint. */
export type FakeWrapperState = { refusal: string | null; mintFailures: Record<string, string> };

/** The fake's wrapper text for inputs: one line, naming the Apps the inputs declare. */
const fakeWrapperText = (inputs: WrapperInputs): string => `#!/bin/sh\n# the fake code host's wrapper\nAPP_ROLES=${appRolesOf(inputs).join(" ")}\n`;

const appRolesOf = (inputs: WrapperInputs): string[] => Object.entries(inputs.identity).filter(([, identity]) => identity.mode === "github-apps").map(([role]) => role);

/**
 * The fake's routing wrapper (contract 1.3): the file is `<binDir>/gh` holding {@link fakeWrapperText}, it is stale when the installed text is not that text, and what it refuses and which App cannot
 * mint are the test's to say (`state`). Core's tests of installing, comparing and re-writing the wrapper run on it, so none renders GitHub's.
 */
function wrapperOf(state: FakeWrapperState): CodeHostWrapper {
  return {
    file: (inputs) => ({ target: join(inputs.place.binDir, "gh"), mode: 0o755, expected: fakeWrapperText(inputs) }),
    appRoles: appRolesOf,
    refusal: () => state.refusal,
    divergence: (inputs, { target, installed }) => installed === null ? `there is no gh wrapper at ${target}` : installed === fakeWrapperText(inputs) ? null : `${target} is not the fake's wrapper`,
    identityStale: (inputs, installed) => installed !== fakeWrapperText(inputs),
    mintFailure: (inputs, role) => (appRolesOf(inputs).includes(role) ? state.mintFailures[role] ?? null : null),
  };
}

/**
 * What the fake holds of the repositories a person can pick (contract 1.14), and what a test sets: the owners (null: the host cannot be asked), the repositories of each owner by login (an owner with none seeded cannot be
 * asked about), why a clone of `fullName` fails, and the clones made, in order.
 */
export type FakeRepositories = {
  owners: readonly RepositoryOwner[] | null;
  byOwner: Map<string, readonly HostRepository[]>;
  cloneFailures: Map<string, string>;
  cloned: { fullName: string; path: string }[];
};

const GITHUB_REMOTE = /^(?:(?:git\+)?(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|(?:[^@/\s]+@)?github\.com:)([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i;

/** The fake's checkout: a directory whose `.git/config` names `fullName`'s GitHub address, which is all the scan of a folder reads. */
function makeCheckout(fullName: string, path: string): void {
  mkdirSync(join(path, ".git"), { recursive: true });
  writeFileSync(join(path, ".git", "config"), `[remote "origin"]\n\turl = https://github.com/${fullName}.git\n`);
}

/** The group over what a test seeded. A clone makes the destination, so the folder it clones into holds a checkout the scan finds; it fails as the test says, and where the destination holds something already. */
function repositoriesOf(state: FakeRepositories, calls: string[]): CodeHostRepositories {
  return {
    readOwners() {
      calls.push("readOwners");
      return state.owners;
    },
    readRepositories(owner) {
      calls.push(`readRepositories ${owner.login}`);
      return state.byOwner.get(owner.login) ?? null;
    },
    repositoryOfRemote(url) {
      const match = GITHUB_REMOTE.exec(url.trim());
      return match === null ? null : { name: match[2], fullName: `${match[1]}/${match[2]}` };
    },
    cloneCommand: (fullName, path) => `gh repo clone ${fullName} ${path}`,
    cloneRepository(fullName, path) {
      calls.push(`cloneRepository ${fullName} ${path}`);
      const failure = state.cloneFailures.get(fullName);
      if (failure !== undefined) return failure;
      try {
        if (readdirSync(path).length > 0) return `destination path '${path}' already exists and is not an empty directory.`;
      } catch (error) {
        void error; // no such directory: the clone makes it
      }
      mkdirSync(dirname(path), { recursive: true });
      makeCheckout(fullName, path);
      state.cloned.push({ fullName, path });
      return null;
    },
  };
}

/** Whether an event is one the subscriber's filter names. */
const wants = ({ filter }: Subscriber, event: CodeHostEvent): boolean => (filter.kinds?.includes(event.kind) ?? true) && (filter.ref === undefined || filter.ref.id === event.ref.id);

export function createFakeCodeHost(login: string | null = "fake-worker") {
  const rowsWorld = emptyRowsWorld();
  const pulls: Pulls = new Map();
  const repositories = new Set<string>();
  const defaultBranches = new Map<string, DefaultBranchRed>();
  const subscribers: Subscriber[] = [];
  const calls: string[] = [];
  const armed: string[] = [];
  const reviewRequests: { ref: ChangeRef; reviewer: string }[] = [];
  const retargets: { url: string; base: string }[] = [];
  const wrapperState: FakeWrapperState = { refusal: null, mintFailures: {} };
  const repositoriesWorld: FakeRepositories = { owners: login === null ? null : [{ login, kind: "account" }], byOwner: new Map(), cloneFailures: new Map(), cloned: [] };
  const checksAndClaims: FakeChecksAndClaims = { logs: new Map(), reruns: [], rerunRefusal: null, claims: new Map(), now: Date.now, claimReadRefusal: null, claimWriteRefusal: null, claimWrites: [] };
  const branchUpdates: FakeBranchUpdates = { answers: new Map(), asked: [] };
  const closes: FakeCloses = { refusals: new Map(), closed: [] };
  const stackMerges: FakeStackMerges = { facts: new Map(), requestRefusal: null, requests: [] };
  const ciRuns: FakeCiRuns = { runs: new Map(), asked: [] };
  const branchCi: FakeBranchCi = { runs: new Map(), asked: [] };
  const queues: FakeQueues = { failures: new Map(), holdRefusal: null, held: new Set(), holds: [] };
  const host: CodeHost = {
    ...readsOf(pulls, repositories, defaultBranches, login, calls), ...actionsOf(pulls, subscribers, { armed, reviewRequests }), ...checksAndClaimsOf(checksAndClaims, calls), ...branchUpdatesOf(branchUpdates, pulls, calls), ...closesOf(closes, pulls, calls), ...stackMergesOf(stackMerges, pulls, calls), ...ciRunsOf(ciRuns, calls), ...branchCiOf(branchCi, calls), ...closedWorkOf(pulls, calls), ...queuesOf(queues, pulls, calls),
    sweepRetargets: sweepOf(pulls, retargets), wrapper: wrapperOf(wrapperState), verdictDoor: FAKE_DOOR, rows: createFakeRows(rowsWorld), repositories: repositoriesOf(repositoriesWorld, calls),
    repoViewArgs: (repo) => ["fake-repo-view", repo], repoCloneArgs: (remote, path) => ["fake-repo-clone", remote, path],
  };
  return Object.assign(host, {
    /** The rows, pull requests and merge queue the fake's `rows` act on, for a test to seed and read (see {@link FakeRowsWorld}). */
    rowsWorld,
    /** The checks' logs and reruns and the review claims the fake holds, for a test to seed and read (see {@link FakeChecksAndClaims}). */
    checksAndClaims,
    /** The updates of branches the fake was asked for, and the answer it gives each pull request, for a test to seed and read (see {@link FakeBranchUpdates}). */
    branchUpdates,
    /** The pull requests the fake was asked to close, with the comment each was closed with, and why it refuses one, for a test to seed and read (see {@link FakeCloses}). */
    closes,
    /** What the fake says of each pull request's stack, and the requests it was given to hand to the arm bot, for a test to seed and read (see {@link FakeStackMerges}). */
    stackMerges,
    /** The workflow runs the fake says it holds, by `owner/name#runId`, and the runs it was asked about, for a test to seed and read (see {@link FakeCiRuns}). */
    ciRuns,
    /** The workflow runs on a branch the fake says it holds, by `<owner/name>@<branch>`, and the reads it was asked for, for a test to seed and read (see {@link FakeBranchCi}). */
    branchCi,
    /** The failing runs behind removals from the merge queue the fake can find, and the holds it was asked for, for a test to seed and read (see {@link FakeQueues}). */
    queues,
    /** The owners, repositories and clones the fake's `repositories` group holds, for a test to seed and read (see {@link FakeRepositories}). */
    repositoriesWorld,
    /** Say which owners the fake lists (the account first, as the contract says), or null for a host that cannot be asked. */
    seedOwners(owners: readonly RepositoryOwner[] | null) {
      repositoriesWorld.owners = owners;
    },
    /** Say which repositories an owner holds, by name (`owner/name`): until it does, the fake cannot be asked about that owner and answers null. */
    seedRepositories(login: string, fullNames: readonly string[]) {
      repositoriesWorld.byOwner.set(login, fullNames.map((fullName): HostRepository => ({ name: fullName.slice(fullName.indexOf("/") + 1), fullName })));
    },
    /** What the fake's wrapper refuses to write (null: nothing) and the reason a role's App cannot mint, by role. */
    wrapperState,
    /** Hold a pull request, open at head `head-<number>` on `main` unless a test says otherwise. Returns its address and its change ref. */
    seedPull(repository: string, number: number, over: Partial<FakePull> = {}) {
      const url = fakePullUrl(repository, number);
      pulls.set(url, { repository, number, state: "open", base: "main", head: `head-${number}`, files: [], feedback: {}, replies: [], reviews: [], settled: true, trust: "inside", merge: { armed: false, mergeable: true }, ...over });
      return { url, ref: { host: HOST, id: url } };
    },
    pullAt: (url: string): FakePull | undefined => pulls.get(url),
    /** Say a repository can be asked about though it holds no pull request: its list of open ones is then empty, and not "could not ask". */
    seedRepository(repository: string) {
      repositories.add(repository);
    },
    /** Say what fails on the head of `repository`'s default branch (`main` at head `main-head`, unless a test says otherwise; `over` may add `passing`, contract 1.15, which the fake leaves out otherwise, as a host of 1.14 does): until it does, the fake cannot be asked and answers null. */
    seedDefaultBranch(repository: string, failing: readonly string[], over: Partial<DefaultBranchRed> = {}) {
      defaultBranches.set(repository, { branch: "main", head: "main-head", failing, ...over });
    },
    /** Deliver an event to every subscriber whose filter it matches. */
    emit(event: CodeHostEvent) {
      for (const subscriber of [...subscribers].filter((entry) => wants(entry, event))) subscriber.handler(event);
    },
    calls,
    armed,
    reviewRequests,
    retargets,
  });
}

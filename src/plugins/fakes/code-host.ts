// @ts-check
// module: the in-memory code host (A11-158) -- the reference that passes `runCodeHostConformance`, and what core's tests use in place of GitHub
//
// IT HOLDS PULL REQUESTS, AND ROW MODE'S ROWS (`code-host-rows.ts`), and answers `null` for one it was never given, as a host does that cannot read it. A test seeds a pull request (`seedPull`),
// moves its head or its checks, and reads what the board asked of it (`calls`) and did to it (`armed`, `reviewRequests`, `retargets`). Every read is synchronous, as the contract's are.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeRows, emptyRowsWorld } from "./code-host-rows.ts";
import type { ChangeFacts, ChangeRef, CodeHost, CodeHostEvent, CodeHostEventKind, CodeHostWrapper, DefaultBranchRed, MergedFindings, PullFeedback, Reply, RetargetRequest, ReviewClaimEntry, ReviewState, VerdictDoor, WrapperInputs } from "../contracts/code-host.ts";

/** A pull request as the fake holds it. */
export type FakePull = {
  repository: string; number: number; state: "open" | "merged" | "closed"; base: string; head: string; files: string[];
  /** What the pull request found, once it has merged (A11-167). */
  findings?: MergedFindings;
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
  Pick<CodeHost, "readOwnLogin" | "readPullFeedback" | "readDefaultBranchRed" | "readReplies" | "readReviewState" | "readPullState" | "readMergedFindings" | "openPullUrlsOf" | "readChange"> {
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
        base: pull.base, files: pull.files, filesComplete: true, reviewDecision: null, verdictAtHead: verdictAtHead(pull, self), pendingRequired: [], body: pull.body ?? "", ...pull.feedback, authors };
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
    readChange(ref) {
      const pull = pulls.get(ref.id);
      if (ref.host !== HOST || pull === undefined) return null;
      return { ref, head: pull.head, checks: [], reviews: [], merge: { state: pull.state, armed: pull.merge.armed, mergeable: pull.merge.mergeable } };
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
  const checksAndClaims: FakeChecksAndClaims = { logs: new Map(), reruns: [], rerunRefusal: null, claims: new Map(), now: Date.now, claimReadRefusal: null, claimWriteRefusal: null, claimWrites: [] };
  const host: CodeHost = {
    ...readsOf(pulls, repositories, defaultBranches, login, calls), ...actionsOf(pulls, subscribers, { armed, reviewRequests }), ...checksAndClaimsOf(checksAndClaims, calls),
    sweepRetargets: sweepOf(pulls, retargets), wrapper: wrapperOf(wrapperState), verdictDoor: FAKE_DOOR, rows: createFakeRows(rowsWorld),
    repoViewArgs: (repo) => ["fake-repo-view", repo], repoCloneArgs: (remote, path) => ["fake-repo-clone", remote, path],
  };
  return Object.assign(host, {
    /** The rows, pull requests and merge queue the fake's `rows` act on, for a test to seed and read (see {@link FakeRowsWorld}). */
    rowsWorld,
    /** The checks' logs and reruns and the review claims the fake holds, for a test to seed and read (see {@link FakeChecksAndClaims}). */
    checksAndClaims,
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
    /** Say what fails on the head of `repository`'s default branch (`main` at head `main-head`, unless a test says otherwise): until it does, the fake cannot be asked and answers null. */
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

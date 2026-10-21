// @ts-check
// module: the in-memory code host (A11-158) -- the reference that passes `runCodeHostConformance`, and what core's tests use in place of GitHub
//
// IT HOLDS PULL REQUESTS AND NOTHING ELSE, and answers `null` for one it was never given, as a host does that cannot read it. A test seeds a pull request (`seedPull`),
// moves its head or its checks, and reads what the board asked of it (`calls`) and did to it (`armed`, `reviewRequests`, `retargets`). Every read is synchronous, as the contract's are.
import type { ChangeFacts, ChangeRef, CodeHost, CodeHostEvent, CodeHostEventKind, PullFeedback, RetargetRequest, ReviewState } from "../contracts/code-host.ts";

/** A pull request as the fake holds it. */
export type FakePull = {
  repository: string; number: number; state: "open" | "merged" | "closed"; base: string; head: string; files: string[];
  feedback: Partial<PullFeedback>; reviews: ReviewState["reviews"]; settled: boolean; merge: { armed: boolean; mergeable: boolean | null };
};

const HOST = "fake";

/** The address of a pull request the fake holds. */
export const fakePullUrl = (repository: string, number: number): string => `https://github.com/${repository}/pull/${number}`;

type Pulls = Map<string, FakePull>;
type Subscriber = { filter: Readonly<{ kinds?: readonly CodeHostEventKind[]; ref?: ChangeRef }>; handler: (event: CodeHostEvent) => void };

/** The reads of pull requests: `null` for one the fake was never given, as a host does that cannot read it. */
function readsOf(pulls: Pulls, login: string | null, calls: string[]): Pick<CodeHost, "readOwnLogin" | "readPullFeedback" | "readReviewState" | "readPullState" | "openPullUrlsOf" | "readChange"> {
  return {
    readOwnLogin() {
      calls.push("readOwnLogin");
      return login;
    },
    readPullFeedback(url, self) {
      calls.push(`readPullFeedback ${url}`);
      const pull = pulls.get(url);
      if (pull === undefined) return null;
      // What `self` wrote is not feedback: it is left out, as the contract says.
      const authors = (pull.feedback.authors ?? []).filter((author) => author !== self);
      return { state: pull.state, feedbackAt: null, failing: [], failedAt: null, conflicting: false, base: pull.base, files: pull.files, filesComplete: true, ...pull.feedback, authors };
    },
    readReviewState(url) {
      const pull = pulls.get(url);
      return pull === undefined ? null : { head: pull.head, trust: "inside", reviews: pull.reviews, settled: pull.settled, view: { number: pull.number } };
    },
    readPullState: (url) => pulls.get(url)?.state.toUpperCase() ?? null,
    openPullUrlsOf(repository) {
      const inRepository = [...pulls.entries()].filter(([, pull]) => pull.repository === repository);
      // A repository the fake was given no pull request of is one it cannot ask about: null, never "none are open".
      return inRepository.length === 0 ? null : inRepository.filter(([, pull]) => pull.state === "open").map(([url]) => url);
    },
    readChange(ref) {
      const pull = pulls.get(ref.id);
      if (ref.host !== HOST || pull === undefined) return null;
      return { ref, head: pull.head, checks: [], reviews: [], merge: { state: pull.state, armed: pull.merge.armed, mergeable: pull.merge.mergeable } };
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

/** Whether an event is one the subscriber's filter names. */
const wants = ({ filter }: Subscriber, event: CodeHostEvent): boolean => (filter.kinds?.includes(event.kind) ?? true) && (filter.ref === undefined || filter.ref.id === event.ref.id);

export function createFakeCodeHost(login: string | null = "fake-worker") {
  const pulls: Pulls = new Map();
  const subscribers: Subscriber[] = [];
  const calls: string[] = [];
  const armed: string[] = [];
  const reviewRequests: { ref: ChangeRef; reviewer: string }[] = [];
  const retargets: { url: string; base: string }[] = [];
  const host: CodeHost = { ...readsOf(pulls, login, calls), ...actionsOf(pulls, subscribers, { armed, reviewRequests }), sweepRetargets: sweepOf(pulls, retargets) };
  return Object.assign(host, {
    /** Hold a pull request, open at head `head-<number>` on `main` unless a test says otherwise. Returns its address and its change ref. */
    seedPull(repository: string, number: number, over: Partial<FakePull> = {}) {
      const url = fakePullUrl(repository, number);
      pulls.set(url, { repository, number, state: "open", base: "main", head: `head-${number}`, files: [], feedback: {}, reviews: [], settled: true, merge: { armed: false, mergeable: true }, ...over });
      return { url, ref: { host: HOST, id: url } };
    },
    pullAt: (url: string): FakePull | undefined => pulls.get(url),
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

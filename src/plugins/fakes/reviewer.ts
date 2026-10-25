// @ts-check
// module: the in-memory reviewer (A11-158) -- the reference that passes `runReviewerConformance`, and what core's tests use in place of the atomic reviewer
//
// IT STARTS NOTHING: a reviewer is a record of a head. A test sets the verdict file a reviewer wrote and how its turn stands (`wrote`, `turn`), what its pane shows (`showing`), makes the host refuse
// (`refuseWith`), and reads what the pool did (`started`, `closed`, `retired`, `reposted`, `reprompted`).
import type { ReviewBrief, Reviewer, ReviewerDialog, ReviewerPort, ReviewerRef, ReviewerSettled } from "../contracts/reviewer.ts";

const key = ({ pr, head }: ReviewerRef): string => `${pr}@${head}`;

/** What each reviewer's pane shows, by `url@head` (A11-221): the answer `unblock` gives (null for a reviewer that is not live), set by a test, and every ref it was asked about. */
function fakePanes(isLive: (ref: ReviewerRef) => boolean) {
  const dialogs = new Map<string, ReviewerDialog>();
  const unblocked: ReviewerRef[] = [];
  return {
    unblocked,
    unblock: (ref: ReviewerRef): ReviewerDialog | null => {
      unblocked.push(ref);
      return isLive(ref) ? (dialogs.get(key(ref)) ?? null) : null;
    },
    showing: (ref: ReviewerRef, dialog: ReviewerDialog | null): void => {
      if (dialog === null) dialogs.delete(key(ref));
      else dialogs.set(key(ref), dialog);
    },
  };
}

export function createFakeReviewer(refusalOfHost: string | null = null) {
  let refusal = refusalOfHost;
  let loaded = false;
  const live = new Map<string, { label: string; turn: ReviewerSettled; file: string | null }>();
  const started: ReviewerRef[] = [];
  /** The brief each start and each reprompt was given, in order (A11-156): what the pool told the reviewer of the ticket and of the replies. */
  const briefs: (ReviewBrief | undefined)[] = [];
  const closed: ReviewerRef[] = [];
  const retired: string[] = [];
  const reposted: { ref: ReviewerRef; file: string }[] = [];
  const reprompted: ReviewerRef[] = [];
  const panes = fakePanes((ref) => entryOf(ref) !== undefined);
  const entryOf = (ref: ReviewerRef) => live.get(key(ref));

  const reviewer: Reviewer = {
    async load() {
      loaded = true;
    },
    refusal() {
      if (!loaded) throw new Error("the reviewer is not loaded: load() runs before a pool with reviewers is made");
      return refusal;
    },
    start(ref, brief) {
      if (refusal !== null) return { refusal };
      started.push(ref);
      briefs.push(brief);
      live.set(key(ref), { label: `fake-reviewer-${started.length}`, turn: "working", file: null });
      return { label: entryOf(ref)!.label };
    },
    live: (ref) => live.has(key(ref)),
    close(ref) {
      const entry = entryOf(ref);
      if (entry === undefined) return { state: "gone" };
      if (entry.turn === "working") return { state: "busy" };
      live.delete(key(ref));
      closed.push(ref);
      return { state: "closed" };
    },
    retire(pr) {
      for (const [held] of live) if (held.startsWith(`${pr}@`)) live.delete(held);
      retired.push(pr);
      return { retired: true, report: null };
    },
    listedPulls: () => [...new Set([...live.keys()].map((held) => held.slice(0, held.lastIndexOf("@"))))],
    settled: (ref) => entryOf(ref)?.turn ?? "gone",
    verdictFileOf: (ref) => entryOf(ref)?.file ?? null,
    repostVerdict(ref, file) {
      reposted.push({ ref, file });
      return entryOf(ref) === undefined ? { refusal: `no reviewer for ${ref.pr}`, final: false } : { posted: true };
    },
    reprompt(ref, brief) {
      reprompted.push(ref);
      briefs.push(brief);
      return entryOf(ref) === undefined ? { refusal: `no reviewer for ${ref.pr}` } : { prompted: true };
    },
    unblock: panes.unblock,
  };

  return Object.assign(reviewer, {
    /** Make the host refuse (or stop refusing) to start a reviewer, as `refusal()` says. */
    refuseWith(reason: string | null) {
      refusal = reason;
    },
    /** The reviewer for `ref` ended its turn, having written `file` (or none). */
    wrote(ref: ReviewerRef, file: string | null) {
      const entry = entryOf(ref);
      if (entry === undefined) throw new RangeError(`fake reviewer: none is live for ${key(ref)}`);
      entry.turn = "ended";
      entry.file = file;
    },
    /** The reviewer for `ref` is blocked on a dialog (`showing`), which `unblock` answers or leaves stuck, or on none (null). */
    showing: panes.showing,
    started, briefs, closed, retired, reposted, reprompted, unblocked: panes.unblocked,
  });
}

/**
 * A port a test wrote by hand, as a loaded reviewer that can start here (or, with `refusal`, one that cannot): a pool is given a `Reviewer`, and a test of one pool behaviour needs only the
 * port's answers, not the fake's record of what it did.
 */
export function reviewerOver(port: ReviewerPort, refusal: string | null = null): Reviewer {
  return { ...port, load: async () => undefined, refusal: () => refusal };
}

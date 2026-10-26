// no-token: none -- a pool over fakes with an injected clock; nothing is spawned
// module: the fixtures of the tests of an approved pull request that is not merging (A11-291): the reads, the heads, the notes' sentences, and a pool whose watch reads one approved pull request
import type { MergeFlow, PullFeedback } from "../../plugins/contracts/code-host.ts";
import { createFakeCodeHost } from "../../plugins/fakes/code-host.ts";
import { poolFixture } from "../pool-fixture.ts";
import { finish } from "../queue/queue-transitions.ts";
import type { Entry } from "../queue/queue-entries-and-outcomes.ts";
import type { PullHead, ViewEntry } from "./view-types-and-filters.ts";

export const MINUTE = 60_000;
export const NOW = 10_000_000_000;
export const REPO = "a11ign/plugin";
export const PR = `https://github.com/${REPO}/pull/10`;
export const PRS = [{ repo: "plugin", url: PR }];
export const HEAD = "91cfe96d0a1b2c3d4e5f";
export const ARM = ".github/workflows/auto-arm.yml";
/** A repository's merge flow as the host reads it, into `main` unless said. */
export const flowOf = (over: Partial<MergeFlow>): MergeFlow => ({ autoMerge: true, armWorkflow: true, defaultBranch: "main", ...over });
export const NO_FLOW = flowOf({ autoMerge: false, armWorkflow: false });
export const FULL_FLOW = flowOf({ autoMerge: true, armWorkflow: true });

/** The head the watch records for an approved pull request whose required checks are all green. */
export const APPROVED: PullHead = { head: HEAD, approved: true, review: "approved", red: [], pending: [] };

/** What the host says of an approved, green, mergeable pull request that is not in the merge queue. */
export const read = (over: Partial<PullFeedback> = {}): PullFeedback => ({ state: "open", feedbackAt: null, authors: [], failing: [], failures: [], failedAt: null, conflicting: false, mergeable: true, head: HEAD, approvedAtHead: true,
  base: "main", files: ["README.md"], filesComplete: true, queue: { queued: false, removals: [] }, ...over });

export const never = (): never => { throw new Error("the merge flow was asked for, and nothing needed it"); };

/** A finished run whose one pull request carries `head`, with the run's outcome `kind`. */
export const runWith = (head: PullHead, over: Partial<ViewEntry> = {}): ViewEntry =>
  ({ ticket: { key: "A11-257" }, phase: "finished", outcome: { kind: "ready-pr", prs: PRS }, pullHeads: { [PR]: head }, ...over });
export const STUCK: PullHead = { ...APPROVED, unmergedSince: NOW - 20 * MINUTE, notMerging: "a11ign/plugin has no merge flow: auto-merge is not allowed, no .github/workflows/auto-arm.yml" };
export const LINE = "Approved, not merging: a11ign/plugin #10 at 91cfe96d, a11ign/plugin has no merge flow: auto-merge is not allowed, no .github/workflows/auto-arm.yml";

export const HOUR_NOTE = "money, access or security — a11ign/plugin #10 has been approved at `91cfe96d` with green checks for more than 60 minutes and is not merging (a11ign/plugin has no merge flow: auto-merge is not allowed, no .github/workflows/auto-arm.yml): a person decides";

export const FIRST_FLOW_NOTE = "money, access or security — a11ign/plugin #10 adds a11ign/plugin's first merge flow (.github/workflows/auto-arm.yml), so nothing can arm it: a person merges it";

// The pool: its watch reads the pull request, stamps it from its own clock, records the reason, and sets the run's mergeNote.
export function approvedPool({ files = ["README.md"], flow = NO_FLOW as MergeFlow | null, kind = "ready-pr" as "ready-pr" | "draft-pr" } = {}) {
  const clock = { now: NOW };
  const host = createFakeCodeHost("worker-bot");
  host.seedPull(REPO, 10, { head: HEAD, files, queue: { queued: false, removals: [] }, feedback: { reviewDecision: "approved", verdictAtHead: "approved", armed: false } });
  if (flow !== null) host.seedMergeFlow(REPO, flow);
  const fixture = poolFixture({ keys: ["A11-257"], now: () => clock.now });
  fixture.store.set(finish(fixture.store.get(), "A11-257", { kind, prs: PRS }, NOW - 5 * MINUTE));
  const pool = fixture.restart({ codeHost: host });
  const entry = () => fixture.entry("A11-257") as Entry & ViewEntry;
  return { clock, host, pool, entry, store: fixture.store };
}

/** The pool's watch, read `minutes` after the first read. */
export const watchAt = ({ clock, pool }: Readonly<{ clock: { now: number }; pool: { watchFeedback(): void } }>, minutes: number): void => {
  clock.now = NOW + minutes * MINUTE;
  pool.watchFeedback();
};

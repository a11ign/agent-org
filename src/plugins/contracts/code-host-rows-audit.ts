// @ts-check
// module: the code host contract's optional `rows` group, the audit section -- row mode's GitHub operations that the last callers of `src/` ask (contract 1.12, A11-160 step 9)
//
// A TYPE FILE: it imports nothing at run time. Each member is a named operation of what a caller asks, never a `gh` command line; it takes the `run` its caller hands it where the caller keeps its own executor, and
// THROWS (or answers `null` where its name says so) when the read is refused: none returns an empty list for "could not ask".
//
// The callers of this section: the ready-label audit (`ready-label-audit.ts`, the nightly `ready:audit`), the retro's two stock counts (`unwaited-stock-rows.ts`), the tick's un-park of satisfied rows (`unpark-satisfied.ts`)
// and the tick's heartbeat (`work-tick.ts`). The audit walks its lists (it asks for more until a page is short): a listing here is ONE page, and a page whose answer is not one is `{ unreadable }` with the words the
// caller refuses in (it is neither a refusal, which throws, nor a list).
import type { RowsRun } from "./code-host-rows.ts";

/** The words a caller refuses in, for an answer that is not the shape the operation reads. */
export type AuditUnreadable = { unreadable: string };

/** The fields of a row a listing may be asked for. */
export type ListedIssueField = "number" | "title" | "body" | "labels" | "state" | "closedAt" | "stateReason" | "blockedBy";

/**
 * A row of a listing, with the fields asked for and no others, each as the listing gave it; a field the listing left out is absent (`blockedBy` absent is "the edges were not read", which is not "none"). `labels` are the
 * names of the row's labels.
 */
export type ListedIssue = {
  number?: number; title?: string; body?: string; labels?: string[]; state?: string; closedAt?: string | null; stateReason?: string | null;
  blockedBy?: { totalCount?: number; nodes?: { number?: number; state?: string }[] } | null;
};

/** The fields of a pull request a listing may be asked for. */
export type ListedPullField = "number" | "body" | "headRefName" | "mergedAt";

/** A pull request of a listing, with the fields asked for and no others, each as the listing gave it. */
export type ListedPull = { number?: number; body?: string | null; headRefName?: string; mergedAt?: string | null };

/** One page of a listing: its rows, or the reason the answer is not a list. */
export type ListedPage<Row> = { rows: Row[] } | AuditUnreadable;

/** A pull request that GitHub resolves as closing a row, as the audit reads it. */
export type ClosingReference = { number: number; state: string; mergedAt: string | null };

/** One event of a row's timeline as the unwaited-stock count reads it: what happened, when, and the label it names (`null` when it names none). */
export type StockTimelineEvent = { event?: string; created_at?: string; label?: { name?: string } | null };

/** A merged pull request that names a row as the one it closes. */
export type MergedCloser = { number: number; mergedAt: string };

export interface RowsAudit {
  /**
   * The numbers of the open issues of `repo` that GitHub's own search index reports (not pull requests), in the order it lists them: the second reading `fetchOpenIssuesChecked` compares its listing with. THROWS when the
   * read is refused; `{ unreadable }` when a line of the answer is not a number. From `ready-label-audit.ts`.
   */
  reportedOpenIssueNumbersOf(request: { repo: string; run: RowsRun }): { numbers: number[] } | AuditUnreadable;

  /**
   * One page of the issues of `repo` in `state`, the newest `limit`, with `fields` of each (`milestone` keeps the rows of that milestone). THROWS when the read is refused; `{ unreadable }` (worded with `what`, the
   * population asked for) when the answer is not a list, and when a label of a row has no name. From `ready-label-audit.ts` (its walk asks for more until a page is short) and `unwaited-stock-rows.ts`.
   */
  issueListingOf(request: { repo: string; state: "open" | "closed" | "all"; limit: number; fields: readonly ListedIssueField[]; milestone?: string; what: string; run: RowsRun }): ListedPage<ListedIssue>;

  /** {@link RowsAudit.issueListingOf} for the pull requests of `repo`, in `state`. From `ready-label-audit.ts`. */
  pullListingOf(request: { repo: string; state: "open" | "closed"; limit: number; fields: readonly ListedPullField[]; what: string; run: RowsRun }): ListedPage<ListedPull>;

  /**
   * For each of `numbers` (issues of `repo`), the pull requests GitHub resolves as closing it (the issue's own `closedByPullRequestsReferences`), in one round trip; no number makes no call. THROWS when the read is
   * refused; `{ unreadable }` when the answer is not JSON, has no repository, or lacks the row. From `ready-label-audit.ts`.
   */
  closingReferencesOf(request: { repo: string; numbers: number[]; run: RowsRun }): { references: Map<number, ClosingReference[]> } | AuditUnreadable;

  /** For each of `numbers` (issues of `repo`), when it was last reopened (ISO), or `null` when it never was, in one round trip; no number makes no call. Throws and answers `{ unreadable }` as {@link RowsAudit.closingReferencesOf}. From `ready-label-audit.ts`. */
  latestReopenedAtOf(request: { repo: string; numbers: number[]; run: RowsRun }): { reopenedAt: Map<number, string | null> } | AuditUnreadable;

  /** For each of `numbers` (pull requests of `repo`), the issues it declares it closes (the pull request's own `closingIssuesReferences`), in one round trip; no number makes no call. Throws and answers `{ unreadable }` as {@link RowsAudit.closingReferencesOf}. From `ready-label-audit.ts`. */
  closingIssueReferencesOf(request: { repo: string; numbers: number[]; run: RowsRun }): { references: Map<number, number[]> } | AuditUnreadable;

  /** When `label` was last put on row `number` of `repo` (ISO), or `null` when the timeline holds no such event. THROWS when the read is refused. From `ready-label-audit.ts` (the dead-claim check's clock). */
  newestLabeledAtOf(request: { repo: string; number: number; label: string; run: RowsRun }): string | null;

  /** When the newest comment of row `number` of `repo` was made (ISO), or `null` when it has none. THROWS when the read is refused. From `ready-label-audit.ts`. */
  newestCommentAtOf(request: { repo: string; number: number; run: RowsRun }): string | null;

  /** The description of the milestone titled `title` in `repo`, or `null` when there is none or it has no description. THROWS when the read is refused or the answer is not JSON. From `ready-label-audit.ts`. */
  milestoneDescriptionOf(request: { repo: string; title: string; run: RowsRun }): string | null;

  /** When the newest `blocked_by_added` event of row `holder` that names `blocker` happened (ISO), or `null` when its timeline holds none. THROWS when the read is refused. From `ready-label-audit.ts`. */
  blockedByAddedAtOf(request: { repo: string; holder: number; blocker: number; run: RowsRun }): string | null;

  /** The events of row `number` of `repo`, every page, each projected to its name, its time and the label it names. THROWS when the read is refused or a line of the answer is not JSON. From `unwaited-stock-rows.ts`. */
  stockTimelineEventsOf(request: { repo: string; number: number; run: RowsRun }): StockTimelineEvent[];

  /** The names of the labels of row `number` of `repo` and its state (GitHub's word: `OPEN`, `CLOSED`). THROWS when the read is refused or the answer is not JSON. From `unpark-satisfied.ts`. */
  rowLabelsAndStateOf(request: { repo: string; number: number; run: RowsRun }): { labels: string[]; state: string };

  /** The merged pull requests GitHub resolves as closing row `number` of `repo`. THROWS when the read is refused or the answer carries no list of them: an empty answer read off a refusal would say "nothing merged". From `unpark-satisfied.ts`. */
  mergedClosersOf(request: { repo: string; number: number; run: RowsRun }): MergedCloser[];

  /** When row `number` of `repo` closed (epoch ms), or `null` when it has not or the time is not one. THROWS when the read is refused. From `unpark-satisfied.ts`. */
  closedAtOf(request: { repo: string; number: number; run: RowsRun }): number | null;

  /** Sets the repository variable `variable` of `repo` to `value`. THROWS when the write is refused. From `work-tick.ts` (the tick's heartbeat). */
  writeHeartbeatVariable(request: { repo: string; variable: string; value: string; run: RowsRun }): void;
}

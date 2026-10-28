// module: the snapshots a test hands a reader (A11-365) -- pull requests answered from a table, so a test of what a reader makes of a pull request names the pull request and nothing of the query that read it
//
// FOR TESTS ONLY. The real snapshots are `pull-snapshot.ts`'s, and are tested there against a recorded `gh`.
import type { PullNode, PullSnapshots, RepoFlow, RepoSnapshot } from "./pull-snapshot.ts";

/** A repository that is not private, so it has no merge flow. */
export const PUBLIC_REPOSITORY: RepoFlow = { private: false, mergeBot: false };

/** What a fixture was asked, in order. */
export type SnapshotReads = { pulls: [string, number][]; invalidated: string[]; heads: string[]; files: string[] };

export type FixtureOptions = Readonly<{
  flow?: RepoFlow;
  /** The pages of changed files after a cursor: by cursor, or asked of a function. */
  files?: Readonly<Record<string, unknown>> | ((cursor: string) => unknown);
  /** Whether a head holds the merge bot (`headHoldsMergeBot`), by `<number>@<head>`. */
  headBots?: Readonly<Record<string, boolean>>;
  /** Whether the open list is cut short. */
  complete?: boolean;
}>;

/** Snapshots that answer `pulls` (by repository `owner/name`), and `null` for any repository or pull request they do not hold. */
export function snapshotsOf(pulls: Readonly<Record<string, readonly PullNode[]>>, options: FixtureOptions = {}): PullSnapshots & Readonly<{ reads: SnapshotReads }> {
  const flow = options.flow ?? PUBLIC_REPOSITORY;
  const reads: SnapshotReads = { pulls: [], invalidated: [], heads: [], files: [] };
  const snapshot = (repository: string): RepoSnapshot | null => {
    const held = pulls[repository];
    return held === undefined ? null : { repository, at: 0, complete: options.complete ?? true, flow, pulls: new Map(held.map((node) => [node.number as number, node])) };
  };
  return {
    reads,
    snapshot,
    pull(repository, number) {
      reads.pulls.push([repository, number]);
      const node = snapshot(repository)?.pulls.get(number);
      return node === undefined ? null : { node, flow };
    },
    invalidate: (repository) => { reads.invalidated.push(repository); },
    headHoldsMergeBot(_repository, number, head) {
      reads.heads.push(`${number}@${head}`);
      return options.headBots?.[`${number}@${head}`] === true;
    },
    moreFiles(_repository, _number, cursor) {
      reads.files.push(cursor);
      const page = typeof options.files === "function" ? options.files(cursor) : options.files?.[cursor];
      if (page === undefined) throw new Error(`no page after ${cursor}`);
      return page;
    },
  };
}

/** Snapshots that hold the one pull request `pull`, as number 806 of `netboxlabs/nbl-ui-netbox` unless `pull` names its own `number`. */
export function snapshotsHolding(pull: PullNode, options: FixtureOptions = {}, repository = "netboxlabs/nbl-ui-netbox"): PullSnapshots & Readonly<{ reads: SnapshotReads }> {
  return snapshotsOf({ [repository]: [{ number: 806, ...pull }] }, options);
}

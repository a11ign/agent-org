// module: a repository's open pull requests, as the code host reads them (A11-160, A11-365)
//
// Read from the repository's snapshot (`pull-snapshot.ts`): the list is the one query every reader of the repository shares, so this file asks GitHub for nothing. Row mode's own reader of the same list
// (`src/ticket-port/open-pulls.ts`, which also takes each body) stays in core until row mode's calls move into this plugin, so the two are written apart on purpose: this one is the ticket-mode read only.
import type { PullSnapshots } from "./pull-snapshot.ts";

/**
 * THE ADDRESSES OF THE OPEN PULL REQUESTS OF `repo`, or `null` for "could not ask": a repository that cannot be read, and a list the snapshot read in part (more were open than its pages held).
 * `null` is never "nothing is open" (#1286): a caller that refuses on an open pull request must not read a failed read as an empty list.
 */
export function openPullUrlsOf(repo: string, snapshots: PullSnapshots): string[] | null {
  const snapshot = snapshots.snapshot(repo);
  if (snapshot === null || !snapshot.complete) return null;
  return [...snapshot.pulls.keys()].map((number) => `https://github.com/${repo}/pull/${number}`);
}

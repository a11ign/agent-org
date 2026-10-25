// module: the board's record of what a pull request closed without merging still held, and the comment that lists it on the ticket (A11-249)
//
// A PULL REQUEST CLOSED WITHOUT MERGING CAN HOLD WORK NO OTHER BRANCH HAS (announcement-emulator#14, A11-229: two commits that were not on main, parts of them reusable). The board lists that work against the pull
// request's base the moment it notices the close, keeps it in the ticket's folder, where the next run's brief will read it (step 2 of A11-249), and posts it on the ticket. PURE: the reading is `pool-closed-work.ts`, and the code host's compare is
// `ClosedWork` of the code host contract. Nothing here, and nothing in ticket mode, deletes a branch: a closed pull request's branch is kept, and `refs/pull/<n>/head` keeps its commits fetchable even when a person deletes it.
import type { ClosedCommit, ClosedWork } from "../plugins/contracts/code-host.ts";

/** The folder under a ticket's own, `closed-pulls`, that holds one `.md` (the list a person and the brief read) and one `.json` (the record) for each closed pull request. */
export const CLOSED_PULLS_DIR = "closed-pulls";

/** The most files the comment lists: the record's `.md` holds them all. */
export const COMMENT_FILES = 300;

/** What the board kept of a closed pull request: its unique work, or that it had none. `posted` is true once the comment is on the ticket. */
export type ClosedWorkRecord =
  | Readonly<{ kind: "unique"; posted?: boolean } & ClosedWork>
  | Readonly<{ kind: "none"; posted?: boolean; number: number; url: string; base: string; branch: string; head: string }>;

/** The record of a pull request's closed work: unique when its compare found a commit ahead of its base, and none when everything it held is on the base. PURE. */
export const recordOf = (work: ClosedWork): ClosedWorkRecord => (work.commits.length > 0 ? { kind: "unique", ...work }
  : { kind: "none", number: work.number, url: work.url, base: work.base, branch: work.branch, head: work.head });

/** The name a pull request's record files share, safe in a path: `<owner>-<repo>-<number>`. PURE. */
export const recordName = (url: string): string => {
  const named = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  return (named === null ? url : `${named[1]}-${named[2]}-${named[3]}`).replace(/[^A-Za-z0-9._-]+/g, "-");
};

/** `owner/repo` of a pull request's address, or null when it is not one. PURE. */
const repositoryOf = (url: string): string | null => /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1] ?? null;

/** The line that fetches a pull request's commits even when its branch is gone: GitHub keeps `refs/pull/<n>/head` for every pull request. PURE. */
const fetchLine = ({ number, url }: Pick<ClosedWork, "number" | "url">): string => {
  const repository = repositoryOf(url);
  return `git fetch origin pull/${number}/head${repository === null ? "" : ` (in a clone of ${repository})`}`;
};

const commitLine = ({ sha, subject }: ClosedCommit): string => `- \`${sha}\` ${subject}`;

/** The files, as a list. PURE. */
const fileLines = (files: readonly string[], limit: number): string[] => [...files.slice(0, limit).map((file) => `- \`${file}\``), ...(files.length > limit ? [`- and ${files.length - limit} more`] : [])];

/** The words that say a list of files is a part, or an empty string for a complete one. PURE. */
const partial = (work: ClosedWork): string => (work.filesComplete ? "" : "\n\nThe code host's compare stopped at its file cap, so this list of files is a part of what the pull request changed.");

/** The title of the comment, which is also the heading of the `.md` record. PURE. */
export const closedWorkTitle = (work: Pick<ClosedWork, "number" | "base">): string => `Closed pull request #${work.number}: work not on ${work.base}`;

/** The identity of the pull request in the comment and the record: its address, its branch and its head. PURE. */
const identity = (work: ClosedWork): string => `${work.url}\n\nBranch: \`${work.branch}\` (kept: the board never deletes it)\nHead: \`${work.head}\`\nTo fetch the commits even if the branch is deleted: \`${fetchLine(work)}\``;

/** The comment that lists a closed pull request's unique work on its ticket: every commit by its full SHA, then the files, at most {@link COMMENT_FILES}. PURE. */
export function closedWorkComment(work: ClosedWork): string {
  return `${closedWorkTitle(work)}\n\n${identity(work)}\n\n### Commits not on ${work.base} (${work.commits.length})\n\n${work.commits.map(commitLine).join("\n")}\n\n### Files they change (${work.files.length})\n\n${fileLines(work.files, COMMENT_FILES).join("\n")}${partial(work)}\n`;
}

/** The comment for a closed pull request whose compare finds nothing ahead of its base. PURE. */
export const noUniqueWorkComment = (work: ClosedWork): string => `Closed pull request #${work.number}: no unique work, everything it held is on ${work.base}\n\n${work.url}\n\nBranch: \`${work.branch}\` (kept)\nHead: \`${work.head}\`\n`;

/** The comment a record is posted as. PURE. */
export const commentOf = (record: ClosedWorkRecord): string => (record.kind === "unique" ? closedWorkComment(record)
  : noUniqueWorkComment({ ...record, commits: [], files: [], filesComplete: true }));

/** The record's `.md`: what a person and the next run's brief read, with every file, whatever the comment cut. PURE. */
export function closedWorkMarkdown(record: ClosedWorkRecord): string {
  if (record.kind === "none") return commentOf(record);
  return `# ${closedWorkTitle(record)}\n\n${identity(record)}\n\n## Commits not on ${record.base} (${record.commits.length})\n\n${record.commits.map(commitLine).join("\n")}\n\n## Files they change (${record.files.length})\n\n${fileLines(record.files, record.files.length).join("\n")}${partial(record)}\n`;
}

// @ts-check
// module: the review of a worker's local diff, as the run sees it (A11-440) -- the mark and the record beside the outcome file, the brief's step that asks for it, and `pr:open`'s check of it. A leaf: node built-ins only
//
// `ticket:review-local` runs the reviewer on a worker's committed diff before its pull request opens and records, per worktree, the commit it reviewed and the verdict, beside the run's
// outcome file. On a machine with `tickets.localReview: true`, `pr:open` reads that record and refuses a create until a review ran at the tree's current commit, so a blocking finding is
// fixed before the pull request opens rather than in one of its feedback rounds. A verdict other than `convinced` does not refuse on its own: the worker may judge a finding wrong, or the
// reviewer may not have run, and the body says so under `## Local review`. The board's own review of each new head still runs after the pull request opens.
import { readFileSync, writeFileSync } from "node:fs";

/**
 * Present beside the outcome file of a run that opens pull requests on a machine with `tickets.localReview: true`, written by the pool before the worker starts (A11-440). It has `pr:open` refuse
 * a create until the reviewer ran on the worker's local diff at its current commit. Absent, `pr:open` asks for no such review. The board's to write, so a worker cannot lift the check.
 */
export const LOCAL_REVIEW_FILE = "local-review-on";
/**
 * The record of the last review of a worker's local diff, beside the outcome file (A11-440): the commit it reviewed, the base, the verdict and where the review's text is. Only
 * `ticket:review-local` writes it, and `pr:open` reads it. A worker may not write it, nor name it in a command.
 */
export const LOCAL_REVIEW_RECORD_FILE = "local-review.json";

/**
 * Step 5b of the brief on a machine with `tickets.localReview: true`, before step 6 opens the pull request (A11-440): the reviewer runs on the worker's committed diff, and each blocking
 * finding is fixed before the pull request opens, rather than costing one of its feedback rounds. `pr:open` refuses a create until a review ran at the current commit, so a fix is reviewed again.
 */
export function localReviewStep(command: string): string {
  return `5b. Before you open a pull request, have the reviewer review your local diff: in each worktree you changed, after your last commit, run \`${command}\`, with \`--base <branch>\` when your pull request will be stacked on a branch other than the default one. It runs the board's reviewer, read-only, on \`git diff <base>...HEAD\` against this ticket, prints its findings and ends with its verdict: exit 0 is convinced, 1 is not convinced, 2 is no verdict. Fix each blocking finding with a test that fails without the fix, re-run the repository's checks, commit, and run it again. \`pr:open\` refuses to open the pull request until a review ran at your current commit, so run it again after every commit. When you judge a finding that is still raised to be wrong, say so with your reason under \`## Local review\` in the pull request body; the board's own review still runs once the pull request is open. When it exits 2 because the reviewer could not run, say so in the body and go on.`;
}

/** The reviewer's verdict on a local diff: `convinced`, `not convinced`, or null when it gave none (it could not run, or its reply had no verdict line). */
export type LocalVerdict = "convinced" | "not convinced" | null;

/** One review of one worktree's local diff: the commit and base it was of, the verdict, when it ran, where its text is, and why there is no verdict when there is none. */
export type LocalReviewRecord = Readonly<{ head: string; base: string; verdict: LocalVerdict; at: string; review: string | null; problem?: string }>;

/** The records beside the outcome file, by the worktree's top folder: a run that changes two repositories reviews each. */
export type LocalReviewRecords = Readonly<Record<string, LocalReviewRecord>>;

/** The records in `path`, or none when the file is missing or unreadable: a record that cannot be read is no review, and the check asks for one. */
export function readLocalReviews(path: string, read: (path: string) => string = (p) => readFileSync(p, "utf8")): LocalReviewRecords {
  try {
    const parsed: unknown = JSON.parse(read(path));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as LocalReviewRecords : {};
  } catch {
    return {};
  }
}

/** Write `record` for `tree` into `path`, keeping every other tree's. */
export function writeLocalReview(path: string, tree: string, record: LocalReviewRecord): void {
  writeFileSync(path, `${JSON.stringify({ ...readLocalReviews(path), [tree]: record }, null, 2)}\n`);
}

/** A `## Local review` heading in a pull request body, where a worker says why a finding still raised stands, or that the reviewer could not run. */
const LOCAL_REVIEW_SECTION = /^#{2,3}\s+Local review\s*$/m;

/** What the check says about one create: the refusal that stops it, or the line it prints. */
export type LocalReviewVerdict = Readonly<{ refusal: string | null; note: string | null }>;

/** A commit as the command and the check name it: its first 8 characters. */
export const short = (sha: string): string => sha.slice(0, 8);

/**
 * THE CHECK (PURE), made only on a run the pool marked with the local review on: a create needs a review of this tree at `head`, its current commit. A convinced one passes. Any other
 * passes only when the body has a `## Local review` section that answers it.
 * @param {{ record: LocalReviewRecord | null, head: string | null, body: string, key: string }} facts
 * @returns {LocalReviewVerdict}
 */
export function localReviewCheck({ record, head, body, key }: { record: LocalReviewRecord | null; head: string | null; body: string; key: string }): LocalReviewVerdict {
  const how = "Run `agent-org ticket:review-local` in this worktree after your last commit (with `--base <branch>` for a stacked pull request), fix each blocking finding, commit, and run it again";
  if (head === null) return { refusal: `pr-open: REFUSED -- this tree's commit could not be read, so ${key}'s local review cannot be checked against it. Nothing was sent to GitHub (A11-440).`, note: null };
  if (record === null) {
    return { refusal: `pr-open: REFUSED -- this machine has the reviewer review a worker's local diff before its pull request opens (\`tickets.localReview\`), and no review of this tree ran for ${key}. `
      + `${how}. Nothing was sent to GitHub (A11-440).`, note: null };
  }
  if (record.head !== head) {
    return { refusal: `pr-open: REFUSED -- the last local review of this tree was at ${short(record.head)}, and it is now at ${short(head)}: a commit since then has not been reviewed. `
      + `${how}. Nothing was sent to GitHub (A11-440).`, note: null };
  }
  if (record.verdict === "convinced") return { refusal: null, note: `LOCAL-REVIEW: convinced at ${short(head)}` };
  const said = record.verdict === null ? `gave no verdict${record.problem === undefined ? "" : ` (${record.problem})`}` : "was not convinced";
  if (!LOCAL_REVIEW_SECTION.test(body)) {
    return { refusal: `pr-open: REFUSED -- the local review at ${short(head)} ${said}, and the body has no \`## Local review\` section. Fix the blocking findings and review again, or say there `
      + `why each one still raised stands${record.verdict === null ? ", or that the reviewer could not run" : ""}. Nothing was sent to GitHub (A11-440).`, note: null };
  }
  return { refusal: null, note: `LOCAL-REVIEW: ${record.verdict ?? "no verdict"} at ${short(head)}; the body's \`## Local review\` section answers it` };
}

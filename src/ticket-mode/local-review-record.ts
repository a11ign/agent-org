// @ts-check
// module: the review of a worker's local diff, as the run sees it (A11-440) -- the mark and the record beside the outcome file, the brief's step that asks for it, and `pr:open`'s check of it. A leaf: node built-ins only
//
// `ticket:review-local` runs the reviewer on a worker's committed diff before its pull request opens and records, per worktree, the commit it reviewed and the verdict, beside the run's
// outcome file. On a machine with `tickets.localReview: true`, `pr:open` reads that record and refuses a create until a review ran at the tree's current commit, so a blocking finding is
// fixed before the pull request opens rather than in one of its feedback rounds. A `not convinced` review refuses: the worker fixes its blocking findings and reviews again. Only a review with
// no verdict (the reviewer could not run, or its reply had no verdict line) lets the create go on, when the body says so under `## Local review`, so a host whose reviewer is down does not
// hold every worker. The board's own review of each new head still runs after the pull request opens.
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
  return `5b. Before you open a pull request, have the reviewer review your local diff: in each worktree you changed, after your last commit, run \`${command}\`, with \`--base <branch>\` when your pull request will be stacked on a branch other than the default one. It runs the board's reviewer, read-only, on \`git diff <base>...HEAD\` against this ticket, prints its findings and ends with its verdict: exit 0 is convinced, 1 is not convinced, 2 is no verdict. Fix each blocking finding with a test that fails without the fix, re-run the repository's checks, commit, and run it again. \`pr:open\` refuses to open the pull request until a review of your current commit is convinced, so run it again after every commit; the board's own review still runs once the pull request is open. When it exits 2 because the reviewer could not run, run it once more, and if it still cannot, say so under \`## Local review\` in the pull request body and go on.`;
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
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, record]) => isRecord(record)));
  } catch {
    return {};
  }
}

const VERDICTS: readonly unknown[] = ["convinced", "not convinced", null];

/** Whether `value` has a record's shape: a commit and a base, and a verdict the check knows. A record of another shape is no review, so the check asks for one rather than crashing on it. */
function isRecord(value: unknown): value is LocalReviewRecord {
  if (value === null || typeof value !== "object") return false;
  const { head, base, verdict } = value as Record<string, unknown>;
  return typeof head === "string" && head !== "" && typeof base === "string" && VERDICTS.includes(verdict);
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
 * THE CHECK (PURE), made only on a run the pool marked with the local review on: a create needs a review of this tree at `head`, its current commit. A convinced one passes, and a not convinced
 * one refuses: its blocking findings are fixed before the pull request opens. One with no verdict passes only when the body has a `## Local review` section that says the reviewer could not run.
 * The review must also be of the diff the create is checked against: a review against another base read another diff.
 * @param {{ record: LocalReviewRecord | null, head: string | null, base: string, body: string, key: string }} facts
 * @returns {LocalReviewVerdict}
 */
export function localReviewCheck({ record, head, base, body, key }: { record: LocalReviewRecord | null; head: string | null; base: string; body: string; key: string }): LocalReviewVerdict {
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
  if (record.base !== base) {
    return { refusal: `pr-open: REFUSED -- the local review at ${short(head)} read the diff against ${record.base}, and this pull request's diff is against ${base}. `
      + `${how}, with the same \`--base\` you give pr:open. Nothing was sent to GitHub (A11-440).`, note: null };
  }
  if (record.verdict === "convinced") return { refusal: null, note: `LOCAL-REVIEW: convinced at ${short(head)}` };
  if (record.verdict === "not convinced") {
    return { refusal: `pr-open: REFUSED -- the local review at ${short(head)} was not convinced${record.review === null ? "" : ` (its findings: ${record.review})`}. Fix each blocking finding with a test, `
      + `commit, and run \`agent-org ticket:review-local\` again: the pull request opens once a review of the current commit is convinced. Nothing was sent to GitHub (A11-440).`, note: null };
  }
  const why = record.problem === undefined ? "" : ` (${record.problem})`;
  if (!LOCAL_REVIEW_SECTION.test(body)) {
    return { refusal: `pr-open: REFUSED -- the local review at ${short(head)} gave no verdict${why}, and the body has no \`## Local review\` section. Run it again, or say there that the reviewer `
      + "could not run. Nothing was sent to GitHub (A11-440).", note: null };
  }
  return { refusal: null, note: `LOCAL-REVIEW: no verdict at ${short(head)}${why}; the body's \`## Local review\` section says so` };
}

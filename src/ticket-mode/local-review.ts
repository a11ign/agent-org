// @ts-check
// module: `ticket:review-local`'s logic -- the reviewer runs on a worker's committed diff before its pull request opens, and its verdict is recorded for `pr:open` (A11-440)
//
// THE REVIEWER IS THE ONE THE M2 EVAL ASKS (`run-eval/codex-reviewer.ts`, A11-431): `codex exec` in a READ-ONLY sandbox with no network, the reviewer's model and effort, and the `row-review`
// skill as the repository ships it, with the ticket as the spec. Nothing here posts, and the sandbox can change nothing in the worker's tree. The atomic reviewer plugin's port reviews a pull
// request at a head (a herdr workspace, a claim on the head, the verdict door), none of which a diff with no pull request has; its skill and its model are what carry over.
//
// THE REVIEW IS OF A COMMIT: a tree with uncommitted changes to tracked files is refused, so the record's commit is exactly what was reviewed, and `pr:open` can tell a later commit from it.
// The diff is `<base>...HEAD`, three dots, as the board's reviewer reads a pull request: a stacked pull request names its base with `--base`, so the work below it is not reviewed again.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseFrom, ORIGIN_HEAD_ARGS } from "../pr-open.ts";
import { BRIEF_FILE } from "./worker-files.ts";
import { LOCAL_REVIEW_RECORD_FILE, type LocalVerdict, short, writeLocalReview } from "./local-review-record.ts";

/** Where the ticket's run keeps each review's diff and reply, beside its outcome file. */
export const LOCAL_REVIEW_DIR = "local-reviews";

/** What `runLocalReview` needs, each a seam a test replaces. */
export type LocalReviewDeps = Readonly<{
  /** `git` in the worktree the command runs in. Asynchronous: no synchronous spawn is allowed in ticket mode (A11-433). */
  git: (args: string[]) => Promise<string>;
  /** Ask the reviewer, working in `cwd`, and return its last message (`codexReview`). */
  review: (opts: { cwd: string; prompt: string; model: string; effort: string }) => Promise<string>;
  /** Read the verdict line of the reviewer's reply (`review-eval.ts`'s `verdictOf`). */
  verdictOf: (reply: string) => LocalVerdict;
  /** The reviewer's model and effort, as the eval runs it. */
  model: string;
  effort: string;
  /** The `row-review` skill's `SKILL.md`, as the repository ships it. */
  skill: string;
  /** The run's folder beside its outcome file, where the brief is and the record goes. */
  ticketDir: string;
  /** The branch `--base` names, or null for the repository's default one. */
  baseBranch: string | null;
  now: () => number;
}>;

/** What the command says, and how it exits: 0 convinced, 1 not convinced, 2 no verdict or nothing reviewed. */
export type LocalReviewResult = Readonly<{ code: 0 | 1 | 2; out: string }>;

/**
 * The reviewer's prompt for a local diff (PURE): the review method, the ticket as the spec, the diff and the tree, and the verdict line it ends with. It states no expected verdict.
 * @param {{ skill: string, brief: string, diff: string, base: string, head: string }} files
 * @returns {string}
 */
export function localReviewPrompt({ skill, brief, diff, base, head }: { skill: string; brief: string; diff: string; base: string; head: string }): string {
  return [
    `Review a worker's change before its pull request is opened, by the review method in ${skill} (the \`row-review\` skill). No pull request exists yet: post nothing, run no \`gh\` command and change nothing.`,
    `- The ticket it is for: the \`## The ticket\` section of ${brief}, with the acceptance criteria and Decisions it states, and the plan files that file lists, are the spec. The rest of that file is the worker's own instructions, not the spec.`,
    `- The diff, ${base} to the worker's commit ${head}: ${diff}`,
    "- The worker's tree is the current directory, read-only: search it with `git grep` or `grep -rn`.",
    "No check was run for you; read the tests the change adds or relies on.",
    "Number each finding and say whether it blocks the pull request. The worker fixes each blocking finding before it opens the pull request.",
    "Finish with one last line, exactly `VERDICT: convinced` or `VERDICT: not convinced`, and nothing after it.",
  ].join("\n");
}

const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0];

/** The exit code a verdict is: 0 convinced, 1 not convinced, 2 none. */
const codeOf = (verdict: LocalVerdict): 0 | 1 | 2 => (verdict === "convinced" ? 0 : verdict === "not convinced" ? 1 : 2);

/**
 * The `origin/<branch>` the diff is read against, by `pr:open`'s own rule (`baseFrom`), so the review is of the diff `pr:open` checks. `diffBaseOf` reads `git` synchronously, which ticket mode
 * may not, so `origin/HEAD` is read here through the asynchronous `git`.
 */
export async function localBaseOf(git: LocalReviewDeps["git"], named: string | null): Promise<string> {
  if (named !== null) return baseFrom(named, null);
  try {
    return baseFrom(null, await git(ORIGIN_HEAD_ARGS));
  } catch {
    return baseFrom(null, null);  // no `origin/HEAD` to read: `main`, as pr:open reads it
  }
}

/** Why the tree cannot be reviewed as it is (uncommitted changes, or nothing to review), or null when it can. */
async function unreviewable(git: LocalReviewDeps["git"], base: string, diff: string): Promise<string | null> {
  if ((await git(["status", "--porcelain", "--untracked-files=no"])).trim() !== "") {
    return "this worktree has uncommitted changes to tracked files. Commit them first: the review is recorded against a commit, and pr:open checks that commit";
  }
  return diff.trim() === "" ? `nothing to review: ${base}...HEAD is empty` : null;
}

/**
 * THE REVIEW: the worktree's committed diff against `base` is written beside the run's outcome file, the reviewer is asked about it, and its reply and verdict are recorded for this tree at
 * this commit, whatever the verdict. A reviewer that cannot run is recorded with no verdict and the reason, so `pr:open` can let the worker say so rather than hold it forever.
 * @param {LocalReviewDeps} deps
 * @returns {Promise<LocalReviewResult>}
 */
export async function runLocalReview(deps: LocalReviewDeps): Promise<LocalReviewResult> {
  const { git, ticketDir } = deps;
  const base = await localBaseOf(git, deps.baseBranch);
  const tree = (await git(["rev-parse", "--show-toplevel"])).trim();
  const head = (await git(["rev-parse", "HEAD"])).trim();
  const diff = await git(["diff", `${base}...HEAD`]);
  const why = await unreviewable(git, base, diff);
  if (why !== null) return { code: 2, out: `ticket:review-local: nothing was reviewed: ${why}.\n` };
  const dir = join(ticketDir, LOCAL_REVIEW_DIR);
  mkdirSync(dir, { recursive: true });
  const diffFile = join(dir, `${head}.diff`);
  writeFileSync(diffFile, diff);
  const prompt = localReviewPrompt({ skill: deps.skill, brief: join(ticketDir, BRIEF_FILE), diff: diffFile, base, head });
  const record = { head, base, at: new Date(deps.now()).toISOString() };
  const reply = await askReviewer(deps, { cwd: tree, prompt });
  if ("problem" in reply) {
    writeLocalReview(join(ticketDir, LOCAL_REVIEW_RECORD_FILE), tree, { ...record, verdict: null, review: null, problem: reply.problem });
    return { code: 2, out: `ticket:review-local: no verdict at ${short(head)}: ${reply.problem}. Say so under \`## Local review\` in the pull request body.\n` };
  }
  return recordReply(deps, { tree, dir, record, reply: reply.text });
}

/** The reviewer's reply, or why it could not run: a failure is a record of its own, not a crash of the command. */
async function askReviewer(deps: LocalReviewDeps, { cwd, prompt }: { cwd: string; prompt: string }): Promise<{ text: string } | { problem: string }> {
  try {
    return { text: await deps.review({ cwd, prompt, model: deps.model, effort: deps.effort }) };
  } catch (error) {
    return { problem: `the reviewer could not run: ${firstLine(error)}` };
  }
}

/** The reply kept beside the outcome file, its verdict recorded for this tree at this commit, and what the command says. */
function recordReply(deps: LocalReviewDeps, { tree, dir, record, reply }: { tree: string; dir: string; record: { head: string; base: string; at: string }; reply: string }): LocalReviewResult {
  const { head, base } = record;
  const replyFile = join(dir, `${head}.md`);
  writeFileSync(replyFile, reply);
  const verdict = deps.verdictOf(reply);
  writeLocalReview(join(deps.ticketDir, LOCAL_REVIEW_RECORD_FILE), tree, { ...record, verdict, review: replyFile, ...(verdict === null ? { problem: "the reply has no verdict line" } : {}) });
  return { code: codeOf(verdict), out: `${reply.trimEnd()}\n\nticket:review-local: ${verdict ?? "no verdict"} at ${short(head)} (${base}...HEAD); the review is kept at ${replyFile}.\n` };
}

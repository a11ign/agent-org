#!/usr/bin/env node
// A11-440: the pre-PR review inside a worker eval. The eval's `eval-review-local` stand-in (`src/run-eval/sandbox.ts`) runs this where a board's worker runs `agent-org ticket:review-local`.
//
// `node scripts/eval-review-local.ts --ticket-dir <dir> --record <dir> [--base <branch>]`, in the worker's worktree. It is `ticket:review-local`'s own logic (`runLocalReview`): the same prompt,
// the same reviewer (`codex exec`, read-only, no network, the `row-review` skill), the same record beside the brief and the same exit codes, 0 convinced, 1 not convinced, 2 no verdict. Two
// things differ: the ticket's folder is the eval's, named by `--ticket-dir` rather than read from the board's host file, which the eval's worker has none of; and each review's Codex tokens are
// appended to the eval's record (`--record`), so the eval can cost the review (`src/run-eval/local-review.ts`). Nothing is posted and nothing leaves the machine but the reviewer's own call.
import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import { sandboxGitEnv } from "../src/lib/git-env.ts";
import { REVIEWER_EFFORT, REVIEWER_MODEL, SKILL_SOURCE, verdictOf } from "../src/review-eval.ts";
import { codexReviewCounted } from "../src/run-eval/codex-reviewer.ts";
import { countingReview } from "../src/run-eval/local-review.ts";
import { runLocalReview } from "../src/ticket-mode/local-review.ts";

const BIG_BUFFER = 256 * 1024 * 1024;
const runAsync = promisify(execFile);

/** Say why the call is refused, and exit 2, the code `ticket:review-local` gives when nothing was reviewed. */
function refuse(why: string): never {
  process.stderr.write(`eval-review-local: ${why}\n`);
  process.exit(2);
}

/** The ticket's folder and the record the stand-in names, and the `--base` the worker may give. */
function argsOf(): { ticketDir: string; record: string; base: string | null } {
  let values: { "ticket-dir"?: string; record?: string; base?: string };
  try {
    ({ values } = parseArgs({ options: { "ticket-dir": { type: "string" }, record: { type: "string" }, base: { type: "string" } }, strict: true }));
  } catch (error) {
    return refuse(`${(error as Error).message}\nusage: eval-review-local [--base <branch>]`);
  }
  const { "ticket-dir": ticketDir, record, base } = values;
  if (ticketDir === undefined || record === undefined) return refuse("the eval's stand-in names --ticket-dir and --record; run it as eval-review-local [--base <branch>]");
  return { ticketDir, record, base: base ?? null };
}

const { ticketDir, record, base } = argsOf();
const git = async (args: string[]): Promise<string> => (await runAsync("git", args, { env: sandboxGitEnv(), encoding: "utf8", maxBuffer: BIG_BUFFER })).stdout;
const { code, out } = await runLocalReview({
  git, review: countingReview(record, codexReviewCounted), verdictOf, model: REVIEWER_MODEL, effort: REVIEWER_EFFORT, skill: `${SKILL_SOURCE}SKILL.md`,
  ticketDir, baseBranch: base, now: Date.now,
});
(code === 0 ? process.stdout : process.stderr).write(out);
process.exit(code);

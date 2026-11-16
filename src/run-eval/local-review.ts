// @ts-check
// module: the pre-PR review inside a worker eval (A11-440, step 2 of 2) -- the stand-in that runs `ticket:review-local`'s own logic offline, and the tokens each review spent
//
// WITH `tickets.localReview` ON, the eval's brief asks the worker to run `eval-review-local` (`sandbox.ts`) where a board's brief names `agent-org ticket:review-local`. The stand-in runs
// `runLocalReview` itself, the same prompt, reviewer, record and exit codes, against the eval's ticket folder, so the worker reads what a real one would. Only the reviewer's tokens are added:
// each review appends one line to the record's `local-review-tokens.log`, its tokens or `?` when the reviewer's output did not say or it could not run, so the cost of the pre-PR review can be
// set against the feedback rounds it saves (`pre-review-bar.ts`).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_ENV } from "../project-config.ts";
import { type CountedReview, type ReviewAsk } from "./codex-reviewer.ts";

/** The program the stand-in runs: `scripts/eval-review-local.ts`. */
export const EVAL_REVIEW_LOCAL_SCRIPT = fileURLToPath(new URL("../../scripts/eval-review-local.ts", import.meta.url));

/**
 * The stand-in's program and its first arguments: the eval's own script under `node`, given `hostFile`, the eval's host file. agent-org's modules read the host file as they load
 * (`HOME_CHECKOUT`), and the worker's environment names one that does not exist, so without it the script cannot start. It is the eval's code, not the worker's: the worker can only start
 * it, with `--base`, and the worker's own environment still names no host file. PURE.
 */
export const reviewerProgram = (hostFile: string, node: string = process.execPath): string[] => ["/usr/bin/env", `${HOST_ENV}=${hostFile}`, node, EVAL_REVIEW_LOCAL_SCRIPT];

/** One line per pre-PR review the worker ran, in the eval's record: the reviewer's tokens, or `?`. */
export const LOCAL_REVIEW_TOKENS_FILE = "local-review-tokens.log";

const UNKNOWN = "?";

/** The reviewer `runLocalReview` is handed: `review`, with each call's tokens appended to the record, `?` when unknown or when it threw (which it still throws). */
export function countingReview(record: string, review: (ask: ReviewAsk) => Promise<CountedReview>): (ask: ReviewAsk) => Promise<string> {
  const log = join(record, LOCAL_REVIEW_TOKENS_FILE);
  return async (ask) => {
    let counted: CountedReview;
    try {
      counted = await review(ask);
    } catch (error) {
      appendFileSync(log, `${UNKNOWN}\n`);
      throw error;
    }
    appendFileSync(log, `${counted.tokens ?? UNKNOWN}\n`);
    return counted.text;
  };
}

/** The pre-PR reviews of one ticket: how many ran, and their tokens added up, null when any one's is unknown. */
export type LocalReviews = Readonly<{ count: number; tokens: number | null }>;

/** The pre-PR reviews the record holds: none when the worker ran none (or the key was off). */
export function localReviewsOf(record: string): LocalReviews {
  const log = join(record, LOCAL_REVIEW_TOKENS_FILE);
  const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line.trim() !== "") : [];
  const known = lines.map(Number).filter((tokens) => Number.isFinite(tokens));
  return { count: lines.length, tokens: known.length === lines.length ? known.reduce((total, tokens) => total + tokens, 0) : null };
}

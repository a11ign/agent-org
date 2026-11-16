// @ts-check
// module: the offline reviewer both evals ask (A11-431, from `scripts/review-eval.ts`) -- `codex exec` in a READ-ONLY sandbox, its prompt as an argument and its last message read back
//
// One copy, so the worker eval's verdict and the reviewer eval's come from the same reviewer started the same way. Nothing here posts: the sandbox is read-only and has no network.
//
// ITS TOKENS, when counted (A11-440), are read from `--json`'s `turn.completed` events, so the pre-PR review the worker eval measures can be costed: Codex's `input_tokens` includes the
// cached part and `output_tokens` the reasoning (`trace/codex-turns.ts` says how this was checked), so a turn's tokens are the two added. A reply with no such event, or one whose usage
// lacks either number, has unknown tokens, never 0. Only the counted call passes `--json`: the other callers' `codex` runs as it always has.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const TWENTY_MINUTES = 1_200_000;
const BIG_BUFFER = 256 * 1024 * 1024;
const runAsync = promisify(execFile);

/** What the reviewer is asked: its prompt, the tree it reads, and its model and effort. */
export type ReviewAsk = Readonly<{ cwd: string; prompt: string; model: string; effort: string }>;

/** The reviewer's last message, and the tokens it spent, or null when its output did not say. */
export type CountedReview = Readonly<{ text: string; tokens: number | null }>;

/** The tokens of every `turn.completed` event in `codex exec --json`'s output, or null when it has none. Lines that are not JSON are skipped. PURE. */
export function codexTokensOf(stdout: string): number | null {
  let tokens: number | null = null;
  for (const line of stdout.split("\n")) {
    let event: { type?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } | null };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "turn.completed") continue;
    const { input_tokens: input, output_tokens: output } = event.usage ?? {};
    if (typeof input !== "number" || typeof output !== "number") return null;
    tokens = (tokens ?? 0) + input + output;
  }
  return tokens;
}

/** Run `codex exec` with `options` before the prompt and return its last message and what it printed. Throws when `codex` fails or runs past twenty minutes. */
async function runCodex({ cwd, prompt, model, effort }: ReviewAsk, options: readonly string[]): Promise<{ text: string; stdout: string }> {
  const last = join(mkdtempSync(join(tmpdir(), "review-eval-reply-")), "last-message.md");
  const running = runAsync("codex", ["exec", "--model", model, "-c", `model_reasoning_effort="${effort}"`, "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", ...options,
    "--cd", cwd, "--output-last-message", last, prompt], { timeout: TWENTY_MINUTES, maxBuffer: BIG_BUFFER });
  // `codex exec` given a prompt AND an open stdin waits for stdin to end and appends it: the first probe sat there for its whole 20 minutes. Close it.
  running.child.stdin?.end();
  const { stdout } = await running;
  return { text: readFileSync(last, "utf8"), stdout };
}

/** Ask the reviewer, working in `cwd`, and return its last message. Throws when `codex` fails or runs past twenty minutes. */
export async function codexReview(ask: ReviewAsk): Promise<string> {
  return (await runCodex(ask, [])).text;
}

/** Ask the reviewer, working in `cwd`, and return its last message and the tokens it spent (A11-440). Throws when `codex` fails or runs past twenty minutes. */
export async function codexReviewCounted(ask: ReviewAsk): Promise<CountedReview> {
  const { text, stdout } = await runCodex(ask, ["--json"]);
  return { text, tokens: codexTokensOf(stdout) };
}

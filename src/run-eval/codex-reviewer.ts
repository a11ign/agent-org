// @ts-check
// module: the offline reviewer both evals ask (A11-431, from `scripts/review-eval.ts`) -- `codex exec` in a READ-ONLY sandbox, its prompt as an argument and its last message read back
//
// One copy, so the worker eval's verdict and the reviewer eval's come from the same reviewer started the same way. Nothing here posts: the sandbox is read-only and has no network.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const TWENTY_MINUTES = 1_200_000;
const BIG_BUFFER = 256 * 1024 * 1024;
const runAsync = promisify(execFile);

/** Ask the reviewer, working in `cwd`, and return its last message. Throws when `codex` fails or runs past twenty minutes. */
export async function codexReview({ cwd, prompt, model, effort }: { cwd: string; prompt: string; model: string; effort: string }): Promise<string> {
  const last = join(mkdtempSync(join(tmpdir(), "review-eval-reply-")), "last-message.md");
  const running = runAsync("codex", ["exec", "--model", model, "-c", `model_reasoning_effort="${effort}"`, "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral",
    "--cd", cwd, "--output-last-message", last, prompt], { timeout: TWENTY_MINUTES, maxBuffer: BIG_BUFFER });
  // `codex exec` given a prompt AND an open stdin waits for stdin to end and appends it: the first probe sat there for its whole 20 minutes. Close it.
  running.child.stdin?.end();
  await running;
  return readFileSync(last, "utf8");
}

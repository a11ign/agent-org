// no-token: gh -- a fake reviewer and files in a temporary directory, and the stand-in's program refusing before any review; nothing here reaches codex, GitHub or the tracker
/** A11-440, step 2 of 2: each pre-PR review a worker runs inside an eval is counted with its reviewer's tokens, and an unknown is never read as 0. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { codexTokensOf } from "./codex-reviewer.ts";
import { hostFilePath } from "../ticket-mode/settings.ts";
import { countingReview, LOCAL_REVIEW_TOKENS_FILE, localReviewsOf, reviewerProgram } from "./local-review.ts";
import { offlineEnv } from "./sandbox.ts";

const ASK = { cwd: "/tree", prompt: "review", model: "m", effort: "e" };

test("each review's tokens are appended to the record and its reply handed back; unknown tokens, and a reviewer that threw, are `?`", async () => {
  const record = tmpDir("eval-local-review-");
  assert.equal(await countingReview(record, async () => ({ text: "VERDICT: convinced\n", tokens: 1500 }))(ASK), "VERDICT: convinced\n");
  await countingReview(record, async () => ({ text: "no usage\n", tokens: null }))(ASK);
  await assert.rejects(countingReview(record, async () => {
    throw new Error("codex: not logged in");
  })(ASK), /not logged in/, "a reviewer that could not run still fails the review, as ticket:review-local records it");
  assert.equal(readFileSync(join(record, LOCAL_REVIEW_TOKENS_FILE), "utf8"), "1500\n?\n?\n");
});

test("a ticket's reviews are counted and their tokens added up; one unknown makes the total unknown; none is 0 reviews of 0 tokens", async () => {
  const known = tmpDir("eval-local-review-");
  for (const tokens of [1500, 2500]) await countingReview(known, async () => ({ text: "", tokens }))(ASK);
  assert.deepEqual(localReviewsOf(known), { count: 2, tokens: 4000 });
  const unknown = tmpDir("eval-local-review-");
  for (const tokens of [1500, null]) await countingReview(unknown, async () => ({ text: "", tokens }))(ASK);
  assert.deepEqual(localReviewsOf(unknown), { count: 2, tokens: null });
  assert.deepEqual(localReviewsOf(tmpDir("eval-local-review-")), { count: 0, tokens: 0 });
});

test("codex's tokens are every completed turn's input (cached included) and output (reasoning included), and unknown when no turn completed", () => {
  const turn = (input: number, output: number) => JSON.stringify({ type: "turn.completed", usage: { input_tokens: input, cached_input_tokens: input - 1, output_tokens: output, reasoning_output_tokens: 1 } });
  assert.equal(codexTokensOf([JSON.stringify({ type: "thread.started" }), turn(11890, 5), "Reading additional input from stdin...", turn(100, 20), ""].join("\n")), 12015);
  assert.equal(codexTokensOf(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } })), null);
  assert.equal(codexTokensOf(""), null);
});

test("the stand-in's program starts in the worker's offline environment, whose host file does not exist, and refuses a call that names no ticket folder", () => {
  const record = tmpDir("eval-local-review-");
  const env = offlineEnv({ ...process.env }, { standIns: join(record, "bin"), ghConfig: join(record, "gh"), noHost: join(record, "no-host.json") });
  const [program, ...args] = reviewerProgram(hostFilePath(process.env));
  const ran = spawnSync(program, args, { cwd: record, env, encoding: "utf8" });
  assert.equal(ran.stderr, "eval-review-local: the eval's stand-in names --ticket-dir and --record; run it as eval-review-local [--base <branch>]\n",
    "it loaded agent-org's modules, which read the host file as they load, and reached its own refusal");
  assert.equal(ran.status, 2);
  assert.equal(spawnSync(program, [...args, "--ticket-dir", record, "--record", record, "--repo", "x"], { cwd: record, env, encoding: "utf8" }).status, 2, "an unknown flag is refused");
});

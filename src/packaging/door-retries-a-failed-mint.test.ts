/**
 * A11-83 (from the 2026-10-17 incident on agent-org#1738): THE DOOR RETRIES ONE FAILED TOKEN MINT, AND NAMES A FAILURE IT DOES NOT RETRY.
 *
 * `reviewer-agent-org-1738` posted its verdict through the door and the post failed with HTTP 401: the reviewer App token had never been minted,
 * and the wrapper refused the call (`app_refuse` in host/gh). The door now posts once more when that is the cause, after the failed-mint memo is
 * cleared so the second post is a mint and not the memo's refusal; a second failure exits 6 and names the cause.
 *
 * NO CAPABILITY DECLARATION: nothing here reaches the network. `gh` is a shell stub first on `PATH`. Its `pr review` answers from a list of
 * failures, one per call in order (a call past the list succeeds), and logs whether the failed-mint memo was on disk when it was called.
 *
 * THE CONTROLS ARE THE POINT. A door that always retries passes every retry case, and one that never retries passes every failure case, so the
 * retry cases sit beside a failure the door must not retry: the same call, the same stub, a different cause.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DOOR = fileURLToPath(new URL("../reviewer/pr-review-verdict.sh", import.meta.url));
const HEAD = "f3879426aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REFUSED = "gh: refused: the reviewer call is NOT sent as the account. app-token reviewer failed for App a11ign-reviewer: no key file at /keys/reviewer.pem (exit 1)";
const UNAUTHORIZED = "HTTP 401: Bad credentials (https://api.github.com/repos/a11ign/agent-org/pulls/7/reviews)";
const EXIT_NOT_POSTED = 6;

interface Run { status: number | null; stderr: string; reviewCalls: number; memoAtCall: string[] }

/** Runs the door once. `failures` is what each `pr review` call says on stderr before it exits 1, in call order; a call past the list posts. */
function runDoor(failures: string[], { memo = true }: { memo?: boolean } = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), "door-mint-"));
  try {
    const tokens = join(dir, "tokens");
    mkdirSync(tokens);
    if (memo) writeFileSync(join(tokens, "reviewer.failed"), `${Math.floor(Date.now() / 1000)}\n`);
    const verdict = join(dir, "verdict.md");
    writeFileSync(verdict, `**Review of #7 at \`${HEAD.slice(0, 8)}\`, by reviewer-7: convinced (CI run 41)**\n\nbody\n`);
    writeFileSync(join(dir, "pr.json"), JSON.stringify({ head: { sha: HEAD }, base: { ref: "main" } }));
    writeFileSync(join(dir, "user.json"), JSON.stringify({ login: "a11ign-bot" }));
    writeFileSync(join(dir, "reviews.json"), "[]");
    writeFileSync(join(dir, "failures"), failures.map((line) => `${line}\n`).join(""));
    // ONE LOG LINE PER CALL. `pr review` records the memo's state and its own count; the reads answer from the JSON above, through the door's own `--jq`.
    writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash
D="${dir}"
a="$*"; printf '%s\\n' "$a" >> "$D/log"
jq_arg=""; prev=""
for x in "$@"; do [[ "$prev" == --jq ]] && jq_arg="$x"; prev="$x"; done
case "$a" in
  "pr review"*)
    if [ -f "$D/tokens/reviewer.failed" ]; then echo memo-present >> "$D/memo"; else echo memo-absent >> "$D/memo"; fi
    n=$(( $(cat "$D/calls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$D/calls"
    line=$(sed -n "\${n}p" "$D/failures")
    if [ -n "$line" ]; then printf '%s\\n' "$line" >&2; exit 1; fi
    exit 0 ;;
  "api user"*) jq -r "$jq_arg" "$D/user.json" ;;
  *"--method POST"*) exit 0 ;;
  *"/pulls/7 "*) jq -r "$jq_arg" "$D/pr.json" ;;
  *"/pulls/7/reviews?"*) jq -r "$jq_arg" "$D/reviews.json" ;;
esac
`, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}:${process.env.PATH}`, A11Y_REVIEWER_SESSION: "reviewer-7", A11Y_APP_TOKEN_DIR: tokens, GH_REPO: "a11ign/agent-org" };
    const run = spawnSync("bash", [DOOR, "7", "convinced", verdict], { env, encoding: "utf8" });
    const calls = join(dir, "calls");
    const memoLog = join(dir, "memo");
    return {
      status: run.status,
      stderr: run.stderr,
      reviewCalls: existsSync(calls) ? Number(readFileSync(calls, "utf8").trim()) : 0,
      memoAtCall: existsSync(memoLog) ? readFileSync(memoLog, "utf8").split("\n").filter(Boolean) : [],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a post refused for its token is retried once: the memo is cleared first, and the second post is made", () => {
  const run = runDoor([REFUSED]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.reviewCalls, 2, "two posts: the refused one and its retry");
  assert.deepEqual(run.memoAtCall, ["memo-present", "memo-absent"], "the memo was on disk for the first post, and gone for the retry");
  assert.match(run.stderr, /posted on the second mint of the reviewer token/);
});

test("a post rejected with HTTP 401 is retried once as well", () => {
  const run = runDoor([UNAUTHORIZED]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.reviewCalls, 2);
});

test("a post that fails for its token twice exits 6 and names the cause the wrapper gave", () => {
  const run = runDoor([REFUSED, REFUSED]);
  assert.equal(run.status, EXIT_NOT_POSTED, run.stderr);
  assert.equal(run.reviewCalls, 2, "the retry is made once, and no more");
  assert.match(run.stderr, /NOT POSTED\. the reviewer App token could not be minted: no key file at \/keys\/reviewer\.pem \(exit 1\)/);
});

test("a post rejected with HTTP 401 twice exits 6 and says the token was rejected", () => {
  const run = runDoor([UNAUTHORIZED, UNAUTHORIZED]);
  assert.equal(run.status, EXIT_NOT_POSTED, run.stderr);
  assert.equal(run.reviewCalls, 2);
  assert.match(run.stderr, /NOT POSTED\. the reviewer token was rejected \(HTTP 401\)/);
});

test("a post that succeeds the first time is made once, and is not retried", () => {
  const first = runDoor([]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.reviewCalls, 1, "a post that succeeds is not retried");
  assert.doesNotMatch(first.stderr, /second mint/);
});

test("a failure that is neither a mint nor a 401 is not retried: the door exits with the post's own status", () => {
  const run = runDoor(["GraphQL: Can not request changes on your own pull request (addPullRequestReview)"]);
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.reviewCalls, 1, "the control: nothing that is not a token is posted a second time");
  assert.doesNotMatch(run.stderr, /NOT POSTED/);
});

/**
 * A11-149: THE DOOR SETS THE HEAD'S CLAIM TO THE VERDICT WHEN THE REVIEW POSTS.
 *
 * Every instance reads a head's claim (`agent-org/review`) before it starts a reviewer. Once the review is posted, the door writes the verdict and the
 * instance that posted it over that claim, so the head reads as finished. A door run with no instance named writes none, and a failed write is said
 * and does not fail the post: the posted review is the authority every reader checks first.
 *
 * NO CAPABILITY DECLARATION: nothing here reaches the network. `gh` is a shell stub first on `PATH`, answering from files in a temporary directory and
 * logging its argv, so the door's own `gh` calls never reach the real client. THE CONTROLS ARE THE POINT: each case that writes the claim has the same case
 * with the one fact that stops it (no instance, a failed write), so a door that never writes passes nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DOOR = fileURLToPath(new URL("../../plugins/github/reviewer/pr-review-verdict.sh", import.meta.url));
const HEAD = "f3879426aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REPO = "a11ign/agent-org";

interface Run { status: number | null; calls: string[]; stderr: string }

/** The door's `gh` calls that write a claim: a status POST under the claim's context. */
const claimWrites = (calls: string[]): string[] => calls.filter((call) => call.includes("--method POST") && call.includes("context=agent-org/review"));

function runDoor({ verdict, instance, failClaim = false }: { verdict: "convinced" | "not-convinced"; instance?: string; failClaim?: boolean }): Run {
  const dir = mkdtempSync(join(tmpdir(), "door-claim-"));
  try {
    writeFileSync(join(dir, "verdict.md"), `**Review of #7 at \`${HEAD.slice(0, 8)}\`, by reviewer-7: ${verdict} (CI run 41)**\n\nbody\n`);
    writeFileSync(join(dir, "pr.json"), JSON.stringify({ head: { sha: HEAD }, base: { ref: "main" } }));
    writeFileSync(join(dir, "user.json"), JSON.stringify({ login: "a11ign-bot" }));
    writeFileSync(join(dir, "reviews.json"), "[]");
    writeFileSync(join(dir, "checks.json"), JSON.stringify({ check_runs: [{ name: "lint", conclusion: "success" }] }));
    if (failClaim) writeFileSync(join(dir, "fail-claim"), "");
    // ONE LOG LINE PER CALL, argv joined. A read answers by running the door's own `--jq` over the API-shaped JSON in the directory, as `gh` does.
    writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash
D="${dir}"
a="$*"; printf '%s\\n' "\${a//$'\\n'/ }" >> "$D/log"
jq_arg=""; prev=""
for x in "$@"; do [[ "$prev" == --jq ]] && jq_arg="$x"; prev="$x"; done
case "$a" in
  *"context=agent-org/review"*) [[ ! -f "$D/fail-claim" ]] || exit 1; exit 0 ;;
  "pr review"*|*"--method POST"*) exit 0 ;;
  "api user"*) jq -r "$jq_arg" "$D/user.json" ;;
  *"/check-runs"*) jq -r "$jq_arg" "$D/checks.json" ;;
  *"/pulls/7/reviews?"*) jq -r "$jq_arg" "$D/reviews.json" ;;
  *"/pulls/7 "*) jq -r "$jq_arg" "$D/pr.json" ;;
esac
`, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}:${process.env.PATH}`, A11Y_REVIEWER_SESSION: "reviewer-7", GH_REPO: REPO };
    delete env.AGENT_ORG_INSTANCE;
    if (instance !== undefined) env.AGENT_ORG_INSTANCE = instance;
    const run = spawnSync("bash", [DOOR, "7", verdict, join(dir, "verdict.md")], { env, encoding: "utf8" });
    const log = join(dir, "log");
    return { status: run.status, calls: existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [], stderr: run.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("A11-149: a posted approval sets the head's claim to `convinced by` the instance that posted it, at the head", () => {
  const run = runDoor({ verdict: "convinced", instance: "work" });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.calls.some((call) => call.startsWith("pr review 7")), "the review posted");
  const writes = claimWrites(run.calls);
  assert.equal(writes.length, 1, "one claim is written");
  assert.match(writes[0], new RegExp(`--method POST repos/${REPO}/statuses/${HEAD} --silent -f state=success -f context=agent-org/review -f description=convinced by work at \\S+`));
});

test("A11-149: a posted request for changes sets the claim to `not-convinced by` the instance, and the post is unchanged", () => {
  const run = runDoor({ verdict: "not-convinced", instance: "laptop" });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.calls.some((call) => call.startsWith("pr review 7") && call.includes("--request-changes")), "the request for changes posted");
  assert.equal(claimWrites(run.calls).length, 1);
  assert.match(claimWrites(run.calls)[0], /description=not-convinced by laptop at /);
});

test("A11-149: a door run with no instance named writes no claim, and posts as before", () => {
  const run = runDoor({ verdict: "convinced" });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.calls.some((call) => call.startsWith("pr review 7")), "the review posted");
  assert.deepEqual(claimWrites(run.calls), [], "no claim is written");
});

test("A11-149: a claim write that fails is said, and the review still posted and the door exits 0", () => {
  const run = runDoor({ verdict: "convinced", instance: "work", failClaim: true });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.calls.some((call) => call.startsWith("pr review 7")), "the review posted");
  assert.equal(claimWrites(run.calls).length, 1, "the write was tried");
  assert.match(run.stderr, /could not set the claim on #7's head to the verdict; the review is posted, and the claim expires/);
});

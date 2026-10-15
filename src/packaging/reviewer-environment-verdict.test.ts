/**
 * agent-org#1398 (chairman class 3, a11ign/a11ign#928 comment 6154377194): THE REVIEWER'S HAND-OFF MUST BE ONE ITS APP CAN PERFORM, AND AN
 * ACCEPTANCE THAT FAILS AS WRITTEN IS `not convinced`.
 *
 * The door used to refuse `not convinced (environment)` with "hand the row to orchestrator", and the reviewer App has no Issues write, so
 * nothing reached anyone: agent-org#1378's reviewer tried twice and got `Resource not accessible by integration`. The verdict file is the
 * hand-off the reviewer CAN perform, so the refusal now sends the verdict back to be written with its command quoted, and the skill says a
 * failing Acceptance is `not convinced` with the command quoted, `(environment)` being for a failure that disappears outside the sandbox.
 *
 * NO CAPABILITY DECLARATION: nothing here reaches the network. `gh` is a shell stub first on `PATH` that answers from a temporary directory
 * and logs its first two arguments, so the door's own `gh` calls never reach the real client. The head is a fixed sha, so the door reads
 * no compare and no check run.
 *
 * THE CONTROLS ARE THE POINT: the quoted-command verdict posts, and a `convinced` that only uses the word is not refused. A door that
 * refuses everything passes the refusal case alone; these cases are what show it still lets a real verdict through.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DOOR = fileURLToPath(new URL("../reviewer/pr-review-verdict.sh", import.meta.url));
const SKILL = fileURLToPath(new URL("../skills/row-review/SKILL.md", import.meta.url));

const HEAD = "61389c15aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EXIT_MALFORMED = 2;

/** An `(environment)` verdict naming the head, as a reviewer whose checkout could not run the Acceptance would write it. */
const ENVIRONMENT_OPENER = `**Review of #7 at \`${HEAD.slice(0, 8)}\`, by reviewer-7: not convinced (environment) — the Acceptance did not run.**`;
const NO_COMMAND = "The checkout's dependencies are incomplete.\n";
const QUOTED_COMMAND = "The Acceptance fails as written:\n\n```\n$ `node --test src/x.test.ts`\nnot ok 1 - x\n```\n\nIt quotes `node --test src/x.test.ts`.\n";

interface Run { status: number | null; posted: string[]; stderr: string }

/** Runs the door on a verdict file of `opener` and `body`, against a stub `gh` that reads the head from a file and posts nothing. */
function runDoor(verdict: string, opener: string, body: string): Run {
  const dir = mkdtempSync(join(tmpdir(), "env-verdict-"));
  try {
    const file = join(dir, "verdict.md");
    writeFileSync(file, `${opener}\n\n${body}`);
    writeFileSync(join(dir, "pr.json"), JSON.stringify({ head: { sha: HEAD }, base: { ref: "main" } }));
    writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash
D="${dir}"
printf '%s %s\\n' "$1" "$2" >> "$D/log"
case "$1 $2" in
  "pr review") exit 0 ;;
  "api repos/a11ign/a11ign/pulls/7") jq -r '[.head.sha, .base.ref] | @tsv' "$D/pr.json" ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}:${process.env.PATH}`, A11Y_REVIEWER_SESSION: "reviewer-7" };
    delete env.GH_REPO;
    const run = spawnSync("bash", [DOOR, "7", verdict, file], { env, encoding: "utf8" });
    const log = join(dir, "log");
    const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    return { status: run.status, posted: calls.filter((c) => c === "pr review"), stderr: run.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#1398 POSITIVE CONTROL: an (environment) verdict that quotes its command is posted", () => {
  const { status, posted, stderr } = runDoor("not-convinced", ENVIRONMENT_OPENER, QUOTED_COMMAND);
  assert.equal(status, 0, stderr);
  assert.equal(posted.length, 1, "the review posted");
});

test("#1398 REFUSED: an (environment) verdict with no quoted command exits 2, posts nothing, and names the hand-off the reviewer can perform", () => {
  const { status, posted, stderr } = runDoor("not-convinced", ENVIRONMENT_OPENER, NO_COMMAND);
  assert.equal(status, EXIT_MALFORMED, stderr);
  assert.deepEqual(posted, [], "nothing was posted");
  assert.match(stderr, /quotes the command/, "it says why");
  assert.match(stderr, /verdict file/, "it names the verdict file, which the gate reads and the reviewer can write");
  assert.doesNotMatch(stderr, /orchestrator/, "it no longer names a row label the reviewer App cannot write");
});

test("#1398 REFUSED: a bare tag in backticks is not a quoted command", () => {
  const { status, posted } = runDoor("not-convinced", ENVIRONMENT_OPENER, "The command was `pnpm`.\n");
  assert.equal(status, EXIT_MALFORMED);
  assert.deepEqual(posted, []);
});

test("#1398 CONTROL: a convinced verdict that only uses the word (environment) is not refused", () => {
  const opener = `**Review of #7 at \`${HEAD.slice(0, 8)}\`, by reviewer-7: convinced (environment is fine, CI run 41).**`;
  const { status, posted, stderr } = runDoor("convinced", opener, NO_COMMAND);
  assert.equal(status, 0, stderr);
  assert.equal(posted.length, 1);
});

test("#1398 the skill says a failing Acceptance is not convinced, and (environment) is only for a failure that disappears outside", () => {
  const skill = readFileSync(SKILL, "utf8");
  assert.ok(skill.includes("fails as written is `not convinced`"), "the sentence the verdict rests on");
  assert.match(skill, /\(environment\)` is only for a failure that disappears outside/, "where (environment) is allowed");
});

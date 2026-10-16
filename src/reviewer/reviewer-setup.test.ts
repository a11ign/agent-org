/**
 * The reviewer's verdict door (#2952): `pr-review-verdict.sh` names one repository on every `gh` call.
 *
 * The tests that read a11ign's reviewer recipe and `docs/known-gaps.md` are in `./reviewer-recipe.test.ts`. They assert on
 * a11ign's own project text, so they are not part of the fixture run (agent-org#1601).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---- The verdict door's repository (#2952) ----------------------------------------------------------------

const DOOR = fileURLToPath(new URL("./pr-review-verdict.sh", import.meta.url));
const DEFAULT_REPO = "a11ign/a11ign";
const OTHER_REPO = "a11ign/agent-org";
/** Pull request read, reviews read, the review, the read-back, the attribution status. */
const DOOR_CALLS = 5;
/** Names the head the stub reports, in the spelling the gate reads (a backticked sha of 7 or more): the door refuses a verdict that names no commit (a11ign/agent-org#3640). */
const HEAD = "abc1234";
const VERDICT_LINE = `**Review of #7 at \`${HEAD}\`: convinced**`;

/**
 * Runs the door with a `gh` stub first on PATH that appends one line of argv per call to a log. The stub answers the
 * review read-back with the body the door just sent, so the attribution `statuses` POST is reached: all FIVE calls
 * (the two reads before posting, `pr review`, `reviews` read, `statuses` POST) happen, and each can be checked for the repository it names. Since a11ign#3050 the door
 * also reads the pull request and its reviews BEFORE posting, so the stub answers those too: a pull request nobody has reviewed yet.
 */
function runDoor(ghRepo: string | undefined): { status: number | null; calls: string[]; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "door-"));
  try {
    const log = join(dir, "gh.log");
    const verdictFile = join(dir, "verdict.md");
    writeFileSync(verdictFile, `${VERDICT_LINE}\n\nbody\n`);
    writeFileSync(
      join(dir, "gh"),
      // The review body is the WHOLE verdict file since #3030: one call stays one log line (newlines logged as spaces), and the
      // read-back answers as `gh --jq @tsv` does, with the body's newlines spelled `\n`.
      `#!/usr/bin/env bash\na="$*"; printf '%s\\n' "\${a//$'\\n'/ }" >> "${log}"\n` +
        `[[ "$*" == *"/pulls/7 "* ]] && printf '${HEAD}\\tmain\\n'\n` +
        `[[ "$*" == *"select("* ]] && exit 0\n` +
        `[[ "$*" == *"/reviews?"* ]] && printf 'https://example/review/1\\tdeadbeef\\t%s\\n' '${VERDICT_LINE}\\n\\nbody'\nexit 0\n`,
      { mode: 0o755 },
    );
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}:${process.env.PATH}`, A11Y_REVIEWER_SESSION: "reviewer-7" };
    delete env.GH_REPO;
    if (ghRepo !== undefined) env.GH_REPO = ghRepo;
    const run = spawnSync("bash", [DOOR, "7", "convinced", verdictFile], { env, encoding: "utf8" });
    const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    return { status: run.status, calls, stderr: run.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The repository each of the door's three `gh` calls names, in the order they ran. */
function reposNamed(calls: string[]): string[] {
  return calls.map((c) => c.match(/--repo (\S+)|repos\/([^/]+\/[^/]+)\//)?.slice(1).find(Boolean) ?? "(none)");
}

test("unset GH_REPO: every gh call names a11ign/a11ign (the default is unchanged, and the control for the next test)", () => {
  const { status, calls } = runDoor(undefined);
  assert.equal(status, 0);
  assert.equal(calls.length, DOOR_CALLS, calls.join("\n"));
  assert.deepEqual(reposNamed(calls), Array(DOOR_CALLS).fill(DEFAULT_REPO));
});

test("GH_REPO=a11ign/agent-org: every gh call names that repository and none names the default", () => {
  const { status, calls } = runDoor(OTHER_REPO);
  assert.equal(status, 0);
  assert.equal(calls.length, DOOR_CALLS, calls.join("\n"));
  assert.deepEqual(reposNamed(calls), Array(DOOR_CALLS).fill(OTHER_REPO));
  assert.ok(calls.every((c) => !c.includes(DEFAULT_REPO)), calls.join("\n"));
});

test("a GH_REPO that is not owner/name is refused with exit 2 before any gh call", () => {
  for (const bad of ["agent-org", "a11ign/", "/agent-org", "a11ign/agent-org/extra", "a11ign/agent org", "a11ign/a;b", "https://github.com/a11ign/agent-org"]) {
    const { status, calls, stderr } = runDoor(bad);
    assert.equal(status, 2, bad);
    assert.deepEqual(calls, [], `${bad} reached gh`);
    assert.match(stderr, /GH_REPO must be owner\/name/, bad);
  }
});

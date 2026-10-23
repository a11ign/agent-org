// no-token: gh -- the `gh` here is a stub first on PATH of a spawned sweep; nothing reaches GitHub
/**
 * agent-org#992, AS A REAL PROCESS: THE SWEEP OVER ONE OPEN LAB PULL REQUEST WHOSE CROSS-REPO LEG FAILS on a test file the newest trunk run passed, with a stub `gh` answering from its arguments.
 *
 * Moved from `src/packaging/cross-repo-red-refusal.test.ts` (A11-160, step 5). The sweep's DECISIONS are core's and its tests run on the fake code host; what a process shows is that the real program
 * reaches `gh` THROUGH THE GITHUB PLUGIN: it reads the head's check runs, the leg's failed log and the trunk's runs and jobs as the plugin reads them, and posts or does not post the once-only comment.
 * It is the plugin's end-to-end test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crossRepoRedMarker } from "../../../src/cross-repo-red.ts";
import { BODY, FILES, LAB, LAB81_LEG_LOG, LEG, PR_HEAD, PR_RUN, TRUNK_RUN } from "../../../src/packaging/cross-repo-red-world.test.support.ts";

const SWEEP = fileURLToPath(new URL("../../../src/auto-arm-sweep.ts", import.meta.url));

/** The real sweep over ONE open lab PR (#81), a fake `gh` answering from its arguments. */
function driveSweep({ body = BODY, existingComment = "" }: { body?: string; existingComment?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "cross-repo-red-sweep-"));
  try {
    mkdirSync(join(dir, "bin"));
    const put = (name: string, text: string) => writeFileSync(join(dir, name), text);
    put("body.txt", body);
    put("comments.json", JSON.stringify({ comments: [{ body: existingComment }] }));
    put("pr.log", LAB81_LEG_LOG);
    put("trunk.log", "");
    put("checks.json", JSON.stringify({ total_count: 2, check_runs: [{ name: "gate", conclusion: "success" },
      { name: LEG, conclusion: "failure", details_url: `https://github.com/${LAB}/actions/runs/${PR_RUN}/job/114504845032` }] }));
    put("push.json", JSON.stringify({ workflow_runs: [{ id: TRUNK_RUN, head_sha: "77283f6e", status: "completed", conclusion: "success",
      html_url: `https://github.com/${LAB}/actions/runs/${TRUNK_RUN}`, created_at: "2026-10-11T15:35:54Z", event: "push" }] }));
    put("schedule.json", JSON.stringify({ workflow_runs: [] }));
    put("jobs.json", JSON.stringify({ jobs: [{ name: "gate", conclusion: "success" }, { name: LEG, conclusion: "success" }] }));
    writeFileSync(join(dir, "bin", "gh"), `#!/bin/bash
echo "$*" >> "${dir}/calls"
case "$*" in
  *"issue view 5078 "*) echo '{"blockedBy":{"nodes":[],"totalCount":0}}' ;;
  *"issue view 5080 "*) echo '{"state":"OPEN"}' ;;
  *"issue view"*) echo 'HTTP 404' >&2; exit 1 ;;
  *timelineItems*) echo '{"mergeQueueEntry":null,"timelineItems":{"nodes":[]}}' ;;
  *"api graphql"*) echo '[{"number":81,"isDraft":false,"merged":false,"autoMergeRequest":null,"mergeQueueEntry":null}]' ;;
  *"--json comments"*) cat "${dir}/comments.json" ;;
  *"--json body"*) cat "${dir}/body.txt" ;;
  *"--json labels"*) echo '[]' ;;
  *"--json author"*) echo 'worker-1' ;;
  *"--json headRefOid"*) echo ${PR_HEAD} ;;
  *"check-runs?per_page=100"*) cat "${dir}/checks.json" ;;
  *"check-runs"*) echo 2 ;;
  *"event=push"*) cat "${dir}/push.json" ;;
  *"event=schedule"*) cat "${dir}/schedule.json" ;;
  *"actions/runs/${TRUNK_RUN}/jobs"*) cat "${dir}/jobs.json" ;;
  *"run view ${PR_RUN} "*) cat "${dir}/pr.log" ;;
  *"run view ${TRUNK_RUN} "*) cat "${dir}/trunk.log" ;;
esac
`);
    chmodSync(join(dir, "bin", "gh"), 0o755);
    const proc = spawnSync(process.execPath, [SWEEP], { encoding: "utf8", env: { ...process.env,
      GITHUB_REPOSITORY: LAB, PATH: `${join(dir, "bin")}:${process.env.PATH}` } });
    const calls = readFileSync(join(dir, "calls"), "utf8").split("\n").filter(Boolean);
    return { said: proc.stdout + proc.stderr, status: proc.status, merged: calls.some((c) => c.startsWith("pr merge")),
      commented: calls.filter((c) => c.startsWith("pr comment")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#992 (5) sweep, as a process: lab#81's reading is SKIPPED naming the files, nothing is merged, one comment is posted", () => {
  const out = driveSweep({});
  assert.equal(out.merged, false, out.said);
  assert.match(out.said, /SWEEP: #81 SKIPPED -- the cross-repo leg of #81 fails on 2 test files/);
  assert.equal(out.status, 0, "a PR waiting on a declaration is not an arming failure, as a hold is not");
  assert.equal(out.commented.length, 1, out.said);
  assert.match(out.commented[0], /arm-refused: cross-repo-red /);
});

test("#992 (5) sweep, as a process: a tick that finds the marker already on the PR posts nothing more, and a changed file set is said afresh", () => {
  const once = driveSweep({ existingComment: `${crossRepoRedMarker(FILES)}\nNot armed` });
  assert.equal(once.merged, false, once.said);
  assert.equal(once.commented.length, 0, once.said);
  const changed = driveSweep({ existingComment: crossRepoRedMarker([FILES[0]]) });
  assert.equal(changed.commented.length, 1, changed.said);
});

// no-token: gh -- the `gh` here is a stub first on PATH of a spawned sweep; nothing reaches GitHub
/**
 * #3487, AS A REAL PROCESS: THE SWEEP OVER ONE OPEN PULL REQUEST THE MERGE QUEUE EJECTED FOR `failed_checks`, with a stub `gh` answering from its arguments.
 *
 * Moved from `src/packaging/arm-refuses-an-ejected-pr.test.ts` (A11-160, step 5). The sweep's DECISION is core's and its tests run on the fake code host; what a process shows is that
 * the real program reaches `gh` THROUGH THE GITHUB PLUGIN and reads the queue's timeline as the plugin reads it. It is the plugin's end-to-end test.
 *
 * THE FIXTURE IS #3460's REAL TIMELINE: the last ten nodes of its `EJECTION_QUERY` window, as the Open-check on the row read them. The controls change ONE thing each.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SWEEP_WAIT_ENV } from "../../../src/auto-arm-sweep.ts";

const COMMIT = { __typename: "PullRequestCommit" };
const added = (createdAt: string) => ({ __typename: "AddedToMergeQueueEvent", createdAt });
const removed = (createdAt: string, reason = "failed_checks") => ({ __typename: "RemovedFromMergeQueueEvent", createdAt, reason });

/** #3460's timeline, oldest first: two commits, then four ADDED / REMOVED `failed_checks` pairs. Last removal 14:48:06Z. */
const TIMELINE_3460 = [COMMIT, COMMIT,
  added("2026-10-04T14:08:56Z"), removed("2026-10-04T14:20:02Z"),
  added("2026-10-04T14:20:19Z"), removed("2026-10-04T14:27:45Z"),
  added("2026-10-04T14:28:56Z"), removed("2026-10-04T14:36:27Z"),
  added("2026-10-04T14:40:24Z"), removed("2026-10-04T14:48:06Z")];
const LAST_REMOVAL = "2026-10-04T14:48:06Z";

const pullRequest = (nodes: unknown[]) => ({ mergeQueueEntry: null, timelineItems: { nodes } });
const EJECTED_3460 = pullRequest(TIMELINE_3460);

/** Each control is #3460's fixture with ONE thing changed. */
const CONTROLS: Record<string, unknown> = {
  "(2) a PullRequestCommit AFTER the last removal": pullRequest([...TIMELINE_3460, COMMIT]),
  "(2) the queue events deleted": pullRequest([COMMIT, COMMIT]),
  "(3) the last removal is a person's dequeue, not failed_checks": pullRequest([...TIMELINE_3460.slice(0, -1), removed(LAST_REMOVAL, "manual")]),
  "it is IN the queue now, whatever the history says": { ...EJECTED_3460, mergeQueueEntry: { state: "QUEUED" } },
};

const REPO = "a11ign/a11ign";

const SWEEP = fileURLToPath(new URL("../../../src/auto-arm-sweep.ts", import.meta.url));

/** The real sweep over ONE open PR (#3460), a fake `gh` answering from its arguments; `ejection` is the queue read, or "fail". */
function driveSweep(ejection: unknown | "fail") {
  const dir = mkdtempSync(join(tmpdir(), "arm-refuses-ejected-"));
  try {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "ejection.json"), JSON.stringify(ejection));
    writeFileSync(join(dir, "bin", "gh"), `#!/bin/bash
echo "$*" >> "${dir}/calls"
case "$*" in
  *timelineItems*) ${ejection === "fail" ? "echo 'HTTP 502' >&2; exit 1" : `cat "${dir}/ejection.json"`} ;;
  *"api graphql"*) echo '[{"number":3460,"isDraft":false,"merged":false,"autoMergeRequest":null,"mergeQueueEntry":null}]' ;;
  *"--json labels"*) echo '[]' ;;
  *"--json author"*) echo 'worker-1' ;;
  *"--json headRefOid"*) echo 11aa53a ;;
  *"check-runs"*) echo 9 ;;
esac
`);
    chmodSync(join(dir, "bin", "gh"), 0o755);
    const run = spawnSync(process.execPath, [SWEEP], { encoding: "utf8", env: { ...process.env,
      GITHUB_REPOSITORY: REPO, [SWEEP_WAIT_ENV]: "0", PATH: `${join(dir, "bin")}:${process.env.PATH}` } });
    const calls = readFileSync(join(dir, "calls"), "utf8").split("\n").filter(Boolean);
    return { said: run.stdout + run.stderr, status: run.status, merged: calls.some((c) => c.startsWith("pr merge")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#3487 (1) sweep, as a process: #3460's timeline is SKIPPED with the ejection time and nothing is merged", () => {
  const out = driveSweep(EJECTED_3460);
  assert.equal(out.merged, false, out.said);
  assert.match(out.said, /SWEEP: #3460 SKIPPED -- the merge queue EJECTED it/);
  assert.ok(out.said.includes(LAST_REMOVAL), out.said);
  assert.equal(out.status, 0, "a PR waiting for a push is not an arming failure, as a hold is not");
});

test("#3487 (2)(3) sweep CONTROLS, as a process: every changed fixture IS armed", () => {
  for (const [name, fixture] of Object.entries(CONTROLS)) {
    const out = driveSweep(fixture);
    assert.equal(out.merged, true, `${name}: ${out.said}`);
    assert.match(out.said, /SWEEP: #3460 /);
  }
});

test("#3487 (4) sweep, as a process: a refused queue read arms nothing and is reported as a lookup that failed", () => {
  const out = driveSweep("fail");
  assert.equal(out.merged, false, out.said);
  assert.match(out.said, /SWEEP: #3460 SKIPPED -- could not read #3460's merge-queue history/);
  assert.equal(out.status, 1, "the sweep's existing `could not arm` code: inconclusive, never fine");
});

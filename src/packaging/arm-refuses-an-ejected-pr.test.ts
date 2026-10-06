// no-token: gh
//
// Every `gh` call in this file is a fixture: `runArmPr` and `refusalBeforeArming` take an injected `run`, and the sweep is
// driven as a real process with a fake `gh` first on PATH. True of the IMPORT (`arm-pr.mjs` and `auto-arm-sweep.mjs`
// spawn `gh`) and false of every CALL.
/**
 * #3487: A PULL REQUEST THE MERGE QUEUE EJECTED FOR `failed_checks` IS NOT ARMED AGAIN WHILE ITS HEAD IS UNMOVED.
 *
 * Measured 2026-10-04 on `a11ign/a11ign#3460` (approved, CLEAN, head `11aa53a` throughout): `a11ign-ci` armed it four times
 * and the queue ejected it four times, each pass about seven minutes of CI on a run that could only fail the same way. The
 * reader (`queueEjectionOf`) existed and was tested; its only caller was the gate, which REPORTS. The two doors that ARM
 * did not ask it, which is #2046's one-place-decides rule again. Both now reach it through `ejectionVerdict`.
 *
 * THE FIXTURE IS #3460's REAL TIMELINE, `EJECTED_3460`: the last ten nodes of its `EJECTION_QUERY` window, as the
 * Open-check on the row read them. The controls change ONE thing each, so the refusal cannot pass by never being reached.
 *
 * THE MUTANT is the tree before this row (`v0.14.0`, or `origin/main` at the branch point): every refusal case here arms
 * the ejected PR there, so this file goes red there. The run is pasted on the row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runArmPr, EXIT } from "../arm-pr.mjs";
import { refusalBeforeArming, SWEEP_WAIT_ENV } from "../auto-arm-sweep.mjs";
import { ejectionVerdict, queueEjectionOf } from "../pr-armed-state.mjs";

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

const REPO = "a11ign/a11ign";

// --- the shared decision ---

test("#3487 (1): #3460's real timeline reads EJECTED, and the reason carries the ejection time and the remedy", () => {
  assert.deepEqual(queueEjectionOf(EJECTED_3460), { ejected: true, removedAt: LAST_REMOVAL });
  const verdict = ejectionVerdict({ number: 3460, repo: REPO, run: () => JSON.stringify(EJECTED_3460) });
  assert.equal(verdict.kind, "ejected");
  assert.ok("why" in verdict && verdict.why.includes(LAST_REMOVAL), "the ejection time");
  assert.match("why" in verdict ? verdict.why : "", /without a push[^.]*fails the same way/);
  assert.match("why" in verdict ? verdict.why : "", /a push to the head/);
});

/** Each control is #3460's fixture with ONE thing changed. */
const CONTROLS: Record<string, unknown> = {
  "(2) a PullRequestCommit AFTER the last removal": pullRequest([...TIMELINE_3460, COMMIT]),
  "(2) the queue events deleted": pullRequest([COMMIT, COMMIT]),
  "(3) the last removal is a person's dequeue, not failed_checks": pullRequest([...TIMELINE_3460.slice(0, -1), removed(LAST_REMOVAL, "manual")]),
  "it is IN the queue now, whatever the history says": { ...EJECTED_3460, mergeQueueEntry: { state: "QUEUED" } },
};

test("#3487 (2)(3) CONTROLS: a push since, no queue history, another reason and a live queue entry are all CLEAR", () => {
  assert.ok(Object.keys(CONTROLS).length >= 4, "the controls exist, so the loop below cannot pass by being empty");
  for (const [name, fixture] of Object.entries(CONTROLS)) {
    assert.deepEqual(ejectionVerdict({ number: 3460, repo: REPO, run: () => JSON.stringify(fixture) }), { kind: "clear" }, name);
  }
});

test("#3487 (4): a refused read is `cannot-ask` -- not clear, and not ejected -- for a throw, a `null` answer and a bodiless one", () => {
  const refusals = [
    () => { throw new Error("HTTP 502"); },
    () => "null",
    () => JSON.stringify({ mergeQueueEntry: null }),
    () => "not json",
  ];
  for (const run of refusals) {
    const verdict = ejectionVerdict({ number: 3460, repo: REPO, run });
    assert.equal(verdict.kind, "cannot-ask");
    assert.match("why" in verdict ? verdict.why : "", /#3460/);
  }
});

// --- door one: the per-PR `arm` job ---

function driveArm(ejection: unknown | Error) {
  const calls: string[][] = [];
  const said: string[] = [];
  const run = (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") {
      return JSON.stringify({ labels: [], body: "Closes #1", state: "OPEN", author: { login: "worker-1" } });
    }
    if (args.some((a) => a.includes("timelineItems"))) {
      if (ejection instanceof Error) throw ejection;
      return JSON.stringify(ejection);
    }
    if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ labels: [], blockedBy: { nodes: [], totalCount: 0 } });
    return "";
  };
  const code = runArmPr({ argv: ["--pr=3460", `--repo=${REPO}`], env: {}, run: run as never, sleep: () => "ok" as const,
    log: (l: string) => said.push(l), error: (l: string) => said.push(l), lanes: { lanes: [] } });
  return { code, said: said.join("\n"), merged: calls.some((a) => a[0] === "pr" && a[1] === "merge") };
}

test("#3487 (1) arm-pr: #3460's timeline is NOT armed -- no merge call, exit DONE, the line carries the ejection time", () => {
  const out = driveArm(EJECTED_3460);
  assert.equal(out.merged, false, out.said);
  assert.equal(out.code, EXIT.DONE, "waiting for a push is not a failure, as a hold is not");
  assert.match(out.said, /NOT arming #3460/);
  assert.ok(out.said.includes(LAST_REMOVAL), out.said);
});

test("#3487 (2)(3) arm-pr CONTROLS: every changed fixture ARMS, so the refusal above was reached and decided", () => {
  for (const [name, fixture] of Object.entries(CONTROLS)) {
    assert.equal(driveArm(fixture).merged, true, name);
  }
});

test("#3487 (4) arm-pr: a refused read does not arm and exits CANNOT_ASK, the code an unreadable label list already gets", () => {
  for (const refused of [new Error("HTTP 502"), null]) {
    const out = driveArm(refused);
    assert.equal(out.merged, false, out.said);
    assert.equal(out.code, EXIT.CANNOT_ASK);
  }
});

// --- door two: the sweep, whose caller is driven both directly and as the real process ---

test("#3487 sweep: `refusalBeforeArming` -- ejected is refused, a push since is clear, a refused read is `cannot-ask`", () => {
  const ask = (run: (a: string[]) => string) => refusalBeforeArming({ number: "3460", repo: REPO, author: "worker-1", prBody: "Closes: none — a fixture", run });
  const forFixture = (fixture: unknown) => (args: string[]) => {
    assert.ok(args.some((a) => a.includes("timelineItems")), "the only read for a non-lane author is the queue history");
    return JSON.stringify(fixture);
  };
  const ejected = ask(forFixture(EJECTED_3460));
  assert.equal(ejected.kind, "ejected");
  assert.ok("why" in ejected && ejected.why.includes(LAST_REMOVAL));
  assert.equal(ask(forFixture(CONTROLS["(2) a PullRequestCommit AFTER the last removal"])).kind, "clear");
  assert.equal(ask(() => { throw new Error("HTTP 502"); }).kind, "cannot-ask");
});

const SWEEP = fileURLToPath(new URL("../auto-arm-sweep.mjs", import.meta.url));

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

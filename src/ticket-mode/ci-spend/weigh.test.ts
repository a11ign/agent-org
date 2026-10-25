// no-token: none -- pure arithmetic over runs a test writes out
// A11-261: what a ticket's pushes cost in CI. Minutes are a job's time rounded UP to a whole minute; a macOS minute counts ten, a Windows minute two, any other hosted minute one, and a self-hosted runner none but still counts as a job.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BranchCiRun } from "../../plugins/contracts/code-host.ts";
import { minutesOf, osOf, runsSince, spendByHead, totalsOf, weightOf } from "./weigh.ts";

const T = "2026-10-25T10:00:00Z";
/** A job that started at 10:00:00 and ran for `seconds` on a runner with `labels`; null for one still going. */
const job = (labels: string[], seconds: number | null) => ({ labels, startedAt: T, completedAt: seconds === null ? null : new Date(Date.parse(T) + seconds * 1000).toISOString() });
const run = (id: number, headSha: string, jobs: BranchCiRun["jobs"], over: Partial<BranchCiRun> = {}): BranchCiRun => ({ id, headSha, createdAt: T, status: "completed", jobs, ...over });

test("A11-261: a job's weight comes from its runner's labels: macOS ten, Windows two, other hosted one, self-hosted none", () => {
  assert.deepEqual([["macos-14"], ["macos-latest"], ["macOS-13-xlarge"]].map(weightOf), [10, 10, 10]);
  assert.deepEqual([["windows-latest"], ["windows-2022"], ["Windows-2019"]].map(weightOf), [2, 2, 2]);
  assert.deepEqual([["ubuntu-latest"], ["ubuntu-24.04-arm"], ["some-larger-runner"], []].map(weightOf), [1, 1, 1, 1]);
  assert.deepEqual([["self-hosted"], ["self-hosted", "linux", "x64"], ["self-hosted", "macOS"], ["Self-Hosted", "windows"]].map(weightOf), [0, 0, 0, 0], "a self-hosted runner is not billed, whatever else its labels say");
  assert.deepEqual([["macos-14"], ["windows-latest"], ["ubuntu-latest"], ["self-hosted"]].map(osOf), ["macos", "windows", "linux", "self-hosted"]);
});

test("A11-261: a job's minutes are the time it ran rounded up to a whole minute, as GitHub bills", () => {
  assert.deepEqual([1, 59, 60, 61, 119, 120, 121, 3600].map((seconds) => minutesOf(job(["ubuntu-latest"], seconds))), [1, 1, 1, 2, 2, 2, 3, 60]);
});

test("A11-261: a job that has not completed, never ran, or cannot be read costs nothing yet", () => {
  assert.equal(minutesOf(job(["ubuntu-latest"], null)), 0, "still going");
  assert.equal(minutesOf(job(["ubuntu-latest"], 0)), 0, "a skipped job starts and completes at the same moment");
  assert.equal(minutesOf({ labels: [], startedAt: null, completedAt: null }), 0, "queued");
  assert.equal(minutesOf({ labels: [], startedAt: T, completedAt: "2026-10-25T09:00:00Z" }), 0, "times that run backwards");
  assert.equal(minutesOf({ labels: [], startedAt: "never", completedAt: T }), 0, "a time that is no time");
});

test("A11-261: the minutes of a head are summed per runner OS and weighted by it", () => {
  // One push: a macOS job of 2 min 10 s (3 min billed, ×10), a Windows job of 90 s (2 min, ×2), two Linux jobs of 61 s and 30 s (2 and 1 min), and a self-hosted job of 10 min (weighs nothing).
  const [head] = spendByHead([run(1, "aaa", [job(["macos-14"], 130), job(["windows-latest"], 90), job(["ubuntu-latest"], 61), job(["ubuntu-latest"], 30), job(["self-hosted", "linux"], 600)])]);
  assert.deepEqual(head, {
    head: "aaa", jobs: 5, minutes: 3 + 2 + 2 + 1 + 10, weighted: 30 + 4 + 2 + 1 + 0,
    byOs: { linux: { jobs: 2, minutes: 3, weighted: 3 }, windows: { jobs: 1, minutes: 2, weighted: 4 }, macos: { jobs: 1, minutes: 3, weighted: 30 }, "self-hosted": { jobs: 1, minutes: 10, weighted: 0 } },
  });
});

test("A11-261: several runs on one head (two workflows, or a re-run) are one head, and their jobs add up", () => {
  const heads = spendByHead([run(1, "aaa", [job(["ubuntu-latest"], 60)]), run(2, "bbb", [job(["macos-14"], 60)]), run(3, "aaa", [job(["ubuntu-latest"], 120), job(["macos-14"], 60)])]);
  assert.deepEqual(heads.map(({ head, jobs, minutes, weighted }) => [head, jobs, minutes, weighted]), [["aaa", 3, 4, 13], ["bbb", 1, 1, 10]], "in the order the heads first appear");
});

test("A11-261: a push is a distinct head, and the totals count each head once and add the heads' work", () => {
  const runs = [run(1, "aaa", [job(["ubuntu-latest"], 60), job(["ubuntu-latest"], 60)]), run(2, "aaa", [job(["ubuntu-latest"], 60)]), run(3, "bbb", [job(["macos-14"], 600)]), run(4, "ccc", [])];
  assert.deepEqual(totalsOf(runs), {
    pushes: 3, jobs: 4, minutes: 13, weighted: 103,
    byOs: { linux: { jobs: 3, minutes: 3, weighted: 3 }, windows: { jobs: 0, minutes: 0, weighted: 0 }, macos: { jobs: 1, minutes: 10, weighted: 100 }, "self-hosted": { jobs: 0, minutes: 0, weighted: 0 } },
  });
  assert.deepEqual(totalsOf([]), { pushes: 0, jobs: 0, minutes: 0, weighted: 0, byOs: { linux: { jobs: 0, minutes: 0, weighted: 0 }, windows: { jobs: 0, minutes: 0, weighted: 0 }, macos: { jobs: 0, minutes: 0, weighted: 0 }, "self-hosted": { jobs: 0, minutes: 0, weighted: 0 } } });
});

test("A11-261: the run's figures count the workflow runs created at or after its first start, and the ticket's count them all", () => {
  const runs = [run(1, "aaa", [job(["macos-14"], 60)], { createdAt: "2026-10-25T09:00:00Z" }), run(2, "bbb", [job(["ubuntu-latest"], 60)], { createdAt: "2026-10-25T10:00:00Z" }), run(3, "ccc", [job(["ubuntu-latest"], 60)], { createdAt: "2026-10-25T11:00:00Z" })];
  const since = Date.parse("2026-10-25T10:00:00Z");
  assert.deepEqual(runsSince(runs, since).map(({ id }) => id), [2, 3], "a run created at the first start counts");
  assert.equal(totalsOf(runsSince(runs, since)).weighted, 2);
  assert.equal(totalsOf(runs).weighted, 12);
  assert.deepEqual(runsSince([run(9, "zzz", [], { createdAt: "yesterday" })], 0), [], "a creation time that cannot be read is left out");
});

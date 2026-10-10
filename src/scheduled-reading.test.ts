// A fixed measurement is a scheduled script that posts its number on the row (#4639). Fixtures only: rows, comments, the clock and the
// command runner are literals, so nothing here reaches the network or `corpus`. One test spawns real `git` in a throwaway directory, and
// it is the positive control for the default runner the others replace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxGitEnv } from "./lib/git-env.ts";
import { readingsPosted } from "./reading-schedule.ts";
import { ALLOWED_COMMANDS, judgeExpectation, takeDueReading, type RunCommand, type ScheduledRow } from "./scheduled-reading.ts";

const SCRIPT = "git worktree list | wc -l";
const R1 = "2026-10-10T19:00:00Z";
const R2 = "2026-10-11T19:00:00Z";
const AFTER_R1 = Date.parse("2026-10-10T19:00:07Z");
const BEFORE_R1 = Date.parse("2026-10-10T18:59:59Z");
const ROOT = "/repos";

const body = (...lines: string[]) => ["## What it is", "", ...lines].join("\n");
const SCHEDULED = body(`Reading-script: ${SCRIPT}`, "Reading-checkout: a11y-witness", `Reading: 1 at ${R1}`, `Reading: 2 at ${R2}`);
const row = (b: string, comments: string[] = []): ScheduledRow => ({ number: 3870, body: b, comments: comments.map((c) => ({ body: c })) });

/** A runner that records every spawn and answers with `stdout`. */
function fakeRun(stdout: string) {
  const spawned: { file: string; args: readonly string[]; cwd: string }[] = [];
  const run: RunCommand = async (file, args, cwd) => {
    spawned.push({ file, args, cwd });
    return stdout;
  };
  return { run, spawned };
}

function recorder() {
  const posted: { row: number; comment: string }[] = [];
  return { posted, post: async (rowNumber: number, comment: string) => void posted.push({ row: rowNumber, comment }) };
}

test("a due reading runs the declared script in the named checkout and posts the number, counted as `wc -l` counts", async () => {
  const { run, spawned } = fakeRun("/repos/a11y-witness  abc [main]\n/repos/wt-1  def [x]\n/repos/wt-2  012 [y]\n");
  const { post, posted } = recorder();
  const result = await takeDueReading(row(SCHEDULED), { now: AFTER_R1, run, post, reposRoot: ROOT });
  assert.equal(result.kind, "posted");
  assert.deepEqual(spawned, [{ file: "git", args: ["-C", "/repos/a11y-witness", "worktree", "list"], cwd: "/repos/a11y-witness" }]);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].row, 3870);
  assert.match(posted[0].comment, /^Reading 1: 3 \(git worktree list \| wc -l, 2026-10-10T19:00:07Z\)$/m);
});

test("the comment it posts IS the receipt the schedule reads, so the row advances to reading 2 and then to none", async () => {
  const { run } = fakeRun("a\nb\n");
  const { post, posted } = recorder();
  await takeDueReading(row(SCHEDULED), { now: AFTER_R1, run, post, reposRoot: ROOT });
  assert.deepEqual([...readingsPosted([{ body: posted[0].comment }])], [1]);

  const second = await takeDueReading(row(SCHEDULED, [posted[0].comment]), { now: AFTER_R1, run, post, reposRoot: ROOT });
  assert.deepEqual(second, { kind: "not-due", n: 2, at: R2 });
  const lastDay = Date.parse("2026-10-11T19:00:01Z");
  const third = await takeDueReading(row(SCHEDULED, [posted[0].comment]), { now: lastDay, run, post, reposRoot: ROOT });
  assert.equal(third.kind, "posted");
  const done = await takeDueReading(row(SCHEDULED, [posted[0].comment, posted[1].comment]), { now: lastDay, run, post, reposRoot: ROOT });
  assert.deepEqual(done, { kind: "none" });
});

test("a reading that is not yet due runs nothing and posts nothing", async () => {
  const { run, spawned } = fakeRun("a\n");
  const { post, posted } = recorder();
  const result = await takeDueReading(row(SCHEDULED), { now: BEFORE_R1, run, post, reposRoot: ROOT });
  assert.deepEqual(result, { kind: "not-due", n: 1, at: R1 });
  assert.equal(spawned.length, 0);
  assert.equal(posted.length, 0);
});

test("ONE reading per row per pass: two readings both overdue post reading 1 only, not two numbers stamped with one instant", async () => {
  const { run } = fakeRun("a\n");
  const { post, posted } = recorder();
  const late = Date.parse("2026-10-12T00:00:00Z");
  await takeDueReading(row(SCHEDULED), { now: late, run, post, reposRoot: ROOT });
  assert.equal(posted.length, 1);
  assert.match(posted[0].comment, /^Reading 1 posted$/m);
});

test("the allowlist is one entry to start, and a script outside it is refused with the reason and NEVER run, even when due", async () => {
  assert.deepEqual(ALLOWED_COMMANDS, [SCRIPT]);
  const outsiders = ["git worktree prune", "git worktree list | wc -l; id", "rm -rf ~", "git worktree list", "git worktree list | wc -c", "git   worktree list|wc -l"];
  for (const script of outsiders) {
    const { run, spawned } = fakeRun("a\n");
    const { post, posted } = recorder();
    const b = body(`Reading-script: ${script}`, "Reading-checkout: a11y-witness", `Reading: 1 at ${R1}`);
    const result = await takeDueReading(row(b), { now: AFTER_R1, run, post, reposRoot: ROOT });
    assert.equal(result.kind, "refused", script);
    assert.match((result as { reason: string }).reason, /not on the allowlist/, script);
    assert.match((result as { reason: string }).reason, /nothing was run/, script);
    assert.equal(spawned.length, 0, script);
    assert.equal(posted.length, 0, script);
  }
});

test("the allowlist matches the declared command with whitespace folded and one wrapping pair of backticks removed (a row is markdown)", async () => {
  for (const written of [`\`${SCRIPT}\``, "git  worktree list  |  wc -l", `\t${SCRIPT}  `]) {
    const { run, spawned } = fakeRun("a\n");
    const { post } = recorder();
    const b = body(`Reading-script: ${written}`, "Reading-checkout: a11y-witness", `Reading: 1 at ${R1}`);
    const result = await takeDueReading(row(b), { now: AFTER_R1, run, post, reposRoot: ROOT });
    assert.equal(result.kind, "posted", written);
    assert.equal(spawned.length, 1, written);
  }
});

test("a checkout that is missing, or is a path rather than a name, is refused before anything runs", async () => {
  const bad = [null, "../etc", "a/b", "/abs/path", ".hidden", "..", "has space"];
  for (const name of bad) {
    const { run, spawned } = fakeRun("a\n");
    const { post, posted } = recorder();
    const lines = [`Reading-script: ${SCRIPT}`, `Reading: 1 at ${R1}`, ...(name === null ? [] : [`Reading-checkout: ${name}`])];
    const result = await takeDueReading(row(body(...lines)), { now: AFTER_R1, run, post, reposRoot: ROOT });
    assert.equal(result.kind, "refused", String(name));
    assert.equal(spawned.length, 0, String(name));
    assert.equal(posted.length, 0, String(name));
  }
});

test("a row that names no Reading-script is not a scheduled row: ignored, never run (the control)", async () => {
  const { run, spawned } = fakeRun("a\n");
  const { post, posted } = recorder();
  const handTaken = body(`Reading: 1 at ${R1}`, "Reading-checkout: a11y-witness");
  assert.deepEqual(await takeDueReading(row(handTaken), { now: AFTER_R1, run, post, reposRoot: ROOT }), { kind: "none" });
  assert.deepEqual(await takeDueReading({ number: 1, body: null, comments: null }, { now: AFTER_R1, run, post, reposRoot: ROOT }), { kind: "none" });
  assert.equal(spawned.length + posted.length, 0);
});

test("a script with no `Reading:` line is SAID, not silently idle: there is nothing to run it for", async () => {
  const { run } = fakeRun("a\n");
  const { post } = recorder();
  const b = body(`Reading-script: ${SCRIPT}`, "Reading-checkout: a11y-witness");
  const result = await takeDueReading(row(b), { now: AFTER_R1, run, post, reposRoot: ROOT });
  assert.equal(result.kind, "refused");
  assert.match((result as { reason: string }).reason, /no `Reading: <n> at <time>` line/);
});

test("a script that fails posts NOTHING, so no receipt exists and the next pass retries; the reason comes back", async () => {
  const run: RunCommand = async () => {
    throw new Error("fatal: not a git repository");
  };
  const { post, posted } = recorder();
  const result = await takeDueReading(row(SCHEDULED), { now: AFTER_R1, run, post, reposRoot: ROOT });
  assert.equal(result.kind, "failed");
  assert.match((result as { reason: string }).reason, /not a git repository/);
  assert.match((result as { reason: string }).reason, /\/repos\/a11y-witness/);
  assert.equal(posted.length, 0);
});

test("a post that fails is NOT swallowed: it rejects, so the caller knows no receipt landed", async () => {
  const { run } = fakeRun("a\n");
  const post = async () => {
    throw new Error("HTTP 502");
  };
  await assert.rejects(takeDueReading(row(SCHEDULED), { now: AFTER_R1, run, post, reposRoot: ROOT }), /HTTP 502/);
});

test("Reading-expect is only SAID on the row: met, not met, and a bound nobody can read, and the reading is posted in every case", async () => {
  const cases: [string, string, RegExp][] = [
    ["Reading-expect: < 100", "a\n", /^Expected < 100: met\./m],
    ["Reading-expect: < 2", "a\nb\nc\n", /^Expected < 2: NOT met by 3\. Closing stays with the row's owner\./m],
    ["Reading-expect: 1", "a\n", /^Expected == 1: met\./m],
    ["Reading-expect: about a hundred", "a\n", /^Expected bound not understood \(`about a hundred`\)/m],
  ];
  for (const [line, stdout, said] of cases) {
    const { run } = fakeRun(stdout);
    const { post, posted } = recorder();
    const b = body(`Reading-script: ${SCRIPT}`, "Reading-checkout: a11y-witness", `Reading: 1 at ${R1}`, line);
    const result = await takeDueReading(row(b), { now: AFTER_R1, run, post, reposRoot: ROOT });
    assert.equal(result.kind, "posted", line);
    assert.match(posted[0].comment, said, line);
    assert.match(posted[0].comment, /^Reading 1 posted$/m, line);
  }
});

test("a row with no Reading-expect says nothing about a bound (the control), and every operator compares the right way round", () => {
  assert.equal(judgeExpectation(body("no bound here"), 5), null);
  const kind = (line: string, value: number) => judgeExpectation(body(line), value)?.kind;
  assert.deepEqual(
    [kind("Reading-expect: <= 5", 5), kind("Reading-expect: <= 5", 6), kind("Reading-expect: >= 5", 4), kind("Reading-expect: > 5", 5), kind("Reading-expect: == 5", 5), kind("Reading-expect: = 5", 6)],
    ["met", "not-met", "not-met", "not-met", "met", "not-met"],
  );
});

test("the default runner against real git: a repository with one linked worktree counts 2, the same as `git worktree list | wc -l`", async () => {
  const root = mkdtempSync(join(tmpdir(), "scheduled-reading-"));
  try {
    const repo = join(root, "fixture");
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env: sandboxGitEnv(), encoding: "utf8" });
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "x");
    git("worktree", "add", "-q", "--detach", join(root, "linked"));
    const { post, posted } = recorder();
    const b = body(`Reading-script: ${SCRIPT}`, "Reading-checkout: fixture", `Reading: 1 at ${R1}`);
    const result = await takeDueReading(row(b), { now: AFTER_R1, post, reposRoot: root });
    assert.equal(result.kind, "posted");
    assert.equal((result as { value: number }).value, 2);
    assert.match(posted[0].comment, /^Reading 1: 2 \(/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

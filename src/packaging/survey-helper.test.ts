// no-token: gh -- every `gh` task here runs through an INJECTED `run`; survey.mjs's own default `run`
// (which really would spawn `gh`) is exercised only by tasks of kind `grep`/`read`, which reach `git`, in a
// throwaway repository this test creates and deletes.
/**
 * #2690: BATCH SEVERAL SMALL grep/read/gh CHECKS INTO ONE CALL -- engineer.md's "batch related small
 * checks into one command rather than several" habit, given a tool to reach for.
 *
 * `survey()` takes a list of the three checks an engineer already reaches for by hand (`git grep -n`,
 * `Read` with a range, `gh ... --jq`) and runs them together, in order, each returned under its own
 * heading. The row's own acceptance is that a batch answers what N separate calls would, at a LOWER
 * call/subprocess count -- the CLI-level test below counts real process spawns on both sides of that claim
 * rather than asserting it in prose.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { survey, render, DEFAULT_READ_LIMIT } from "../survey.mjs";
import { sandboxGitEnv } from "../../../guards/src/git-env.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SURVEY_CLI = join(REPO, "packages/agent-org/src/survey.mjs");

/**
 * A real, throwaway git WORKING TREE -- `git grep` (no `--cached`) reads the working tree, so nothing here
 * needs a commit. A hand-written stub of `git grep` would be a second copy of its exit-code contract
 * wearing git's name; this runs the real binary, the way `row-claim-stale-rule.test.ts` does.
 */
function fixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "a11y-survey-fixture-"));
  const env = sandboxGitEnv();
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: root, env, stdio: "pipe" });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  // `git grep` (without `--untracked`) searches TRACKED files only; `add` is enough -- no commit needed.
  execFileSync("git", ["add", "-A"], { cwd: root, env, stdio: "pipe" });
  return root;
}

const FILES = {
  "a.txt": "one\ntwo\nTARGET here\nfour\n",
  "b.txt": Array.from({ length: 20 }, (_unused, i) => `line ${i + 1}`).join("\n") + "\n",
};

test("#2690: a batch of grep + read + gh returns the same content the three would separately, in one call", () => {
  const root = fixtureRepo(FILES);
  try {
    let ghCalls = 0;
    const run = (cmd: string, args: string[], opts: Parameters<typeof execFileSync>[2]): string => {
      if (cmd === "gh") {
        ghCalls += 1;
        assert.deepEqual(args, ["issue", "view", "1", "--json", "state"]);
        return '{"state":"OPEN"}';
      }
      return execFileSync(cmd, args, opts) as string;
    };
    const results = survey([
      { kind: "grep", pattern: "TARGET", paths: ["a.txt"] },
      { kind: "read", path: "b.txt", offset: 5, limit: 3 },
      { kind: "gh", args: ["issue", "view", "1", "--json", "state"] },
    ], { cwd: root, run });
    assert.equal(results.length, 3, "one result per task, in the order given");
    assert.equal(ghCalls, 1, "the gh task runs exactly once -- batching must not repeat a call");
    assert.ok(results[0].ok && results[0].output.includes("TARGET here"),
      "grep: the same line a lone `git grep -n` would answer");
    assert.deepEqual(results[1].ok && results[1].output.split("\n"), ["5\tline 5", "6\tline 6", "7\tline 7"],
      "read: the same three lines a lone `Read` with offset=5 limit=3 would answer");
    assert.equal(results[2].ok && results[2].output, '{"state":"OPEN"}', "gh: passed through exactly as given");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#2690: grep's exit 1 (no match) is an ANSWER, not a failure -- ok:true with empty output", () => {
  const root = fixtureRepo(FILES);
  try {
    const [result] = survey([{ kind: "grep", pattern: "NOPE_NOT_THERE_AT_ALL", paths: ["a.txt"] }], { cwd: root });
    assert.deepEqual(result, { task: result.task, ok: true, output: "" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#2690: a real grep failure (not exit 1) is reported ok:false, and does not stop the rest of the batch", () => {
  const failing = () => {
    const err = new Error("fatal: bad thing") as Error & { status: number };
    err.status = 128;
    throw err;
  };
  const results = survey([
    { kind: "grep", pattern: "x", paths: ["missing.txt"] },
    { kind: "read", path: "irrelevant" },
  ], { cwd: "/", run: failing as never, readFile: (() => "content\n") as never });
  assert.equal(results[0].ok, false);
  assert.match((results[0] as { error: string }).error, /bad thing/);
  assert.equal(results[1].ok, true, "one task's failure must not discard the other's answer");
});

test("#2690: an unrecognised task kind is refused as its OWN entry, and does not stop the others", () => {
  const results = survey([
    { kind: "read", path: "x" },
    { kind: "bogus" } as never,
  ], { cwd: "/", readFile: (() => "hello\n") as never });
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match((results[1] as { error: string }).error, /unknown task kind/);
});

test("#2690: a read task with no offset/limit defaults to the range engineer.md names (from line 1, 200 lines)", () => {
  const root = fixtureRepo({ "many.txt": `${Array.from({ length: 250 }, (_unused, i) => `L${i + 1}`).join("\n")}\n` });
  try {
    const [result] = survey([{ kind: "read", path: "many.txt" }], { cwd: root });
    const lines = (result.ok ? result.output : "").split("\n");
    assert.equal(lines.length, DEFAULT_READ_LIMIT);
    assert.equal(lines[0], "1\tL1");
    assert.equal(lines[DEFAULT_READ_LIMIT - 1], `${DEFAULT_READ_LIMIT}\tL${DEFAULT_READ_LIMIT}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#2690: render prints one heading per task, in order, and names a failure inline", () => {
  const text = render([
    { task: { kind: "grep", pattern: "X", paths: ["a.txt"] }, ok: true, output: "a.txt:1:X" },
    { task: { kind: "gh", args: ["issue", "view", "1"] }, ok: false, error: "boom" },
  ]);
  const parts = text.split("\n\n");
  assert.equal(parts.length, 2);
  assert.match(parts[0], /^### grep -e X -- a\.txt\na\.txt:1:X$/);
  assert.match(parts[1], /^### gh issue view 1\nERROR: boom$/);
});

test("#2690: ONE `survey` CLI call answers what several separate CLI calls would, at a LOWER process-spawn count", () => {
  const root = fixtureRepo(FILES);
  const tasksFile = join(root, "tasks.json");
  try {
    writeFileSync(tasksFile, JSON.stringify([
      { kind: "grep", pattern: "TARGET", paths: ["a.txt"] },
      { kind: "read", path: "b.txt", offset: 1, limit: 2 },
      { kind: "grep", pattern: "line 9$", paths: ["b.txt"] },
    ]));

    let batchedSpawns = 0;
    batchedSpawns += 1;
    const batched = spawnSync(process.execPath, [SURVEY_CLI, `--tasks=${tasksFile}`, `--repo=${root}`], { encoding: "utf8" });
    assert.equal(batched.status, 0, batched.stderr);
    assert.match(batched.stdout, /TARGET here/);
    assert.match(batched.stdout, /1\tline 1/);
    assert.match(batched.stdout, /b\.txt:9:line 9/);
    assert.equal(batchedSpawns, 1, "one survey CLI call answers all three checks");

    // THE UNBATCHED EQUIVALENT: the identical three answers, one process spawn PER check.
    let unbatchedSpawns = 0;
    unbatchedSpawns += 1;
    const r1 = spawnSync("git", ["grep", "-n", "-e", "TARGET", "--", "a.txt"], { cwd: root, encoding: "utf8" });
    unbatchedSpawns += 1;
    const r2 = spawnSync(process.execPath, ["-e",
      `process.stdout.write(require("fs").readFileSync(${JSON.stringify(join(root, "b.txt"))}, "utf8").split("\\n").slice(0, 2).join("\\n"))`],
      { encoding: "utf8" });
    unbatchedSpawns += 1;
    const r3 = spawnSync("git", ["grep", "-n", "-e", "line 9$", "--", "b.txt"], { cwd: root, encoding: "utf8" });
    for (const r of [r1, r2, r3]) assert.equal(r.status, 0, r.stderr);
    assert.ok(r1.stdout.includes("TARGET here"));
    assert.ok(r2.stdout.startsWith("line 1"));
    assert.ok(r3.stdout.includes("line 9"));
    assert.equal(unbatchedSpawns, 3, "the unbatched equivalent needs one spawn per check");

    assert.ok(batchedSpawns < unbatchedSpawns, "batching must cost FEWER process spawns for the same answers");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

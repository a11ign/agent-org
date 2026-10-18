/**
 * a11ign/agent-org#859 (a11ign#4957, cause 2): AN ACCEPTANCE RUNS IN THE CLAIMED WORKTREE.
 *
 * `execSync` was given no `cwd`, so a command ran wherever `pr:open` was started, and the rows' own `cd <primary checkout> && ...` read
 * the PRIMARY checkout, which carries the change only after the merge. Every test here runs the real runner in a CHILD process whose working
 * directory is a real linked worktree of a throwaway repository, because the working directory is the thing under test and an in-process
 * call would only ever see this test's own.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sandboxGitEnv } from "./lib/git-env.ts";
import { rewriteLeadingCd } from "./acceptance-commands/suite-scripts-for.ts";

const SRC = new URL(".", import.meta.url);
const ACCEPTANCE_COMMANDS = new URL("acceptance-commands/suite-scripts-for.ts", SRC).href;
const ACCEPTANCE_CLOSURE = new URL("acceptance-commands/unmet-command-closure-requirements.ts", SRC).href;
const PR_OPEN = new URL("pr-open.ts", SRC).href;

let root: string;
let primary: string;
let worktree: string;
let elsewhere: string;
let runner: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: sandboxGitEnv(), stdio: "ignore" });
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "acceptance-worktree-")));
  primary = join(root, "primary");
  worktree = join(root, "wt");
  elsewhere = join(root, "elsewhere");
  for (const dir of [primary, elsewhere]) {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "kept.txt"), "x\n");
    git(dir, "init", "-q", "-b", "main");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", ".");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
  }
  git(primary, "worktree", "add", "-q", "-b", "agent/x-1", worktree);
  // A file only the worktree has: the change the Acceptance is meant to test.
  writeFileSync(join(worktree, "only-in-worktree.test.ts"), "");
  // The runner is a script in the fixture, not an inline `node -e`, and takes the work as argv.
  runner = join(root, "runner.mjs");
  writeFileSync(runner, `import { runAcceptanceCommand } from ${JSON.stringify(ACCEPTANCE_COMMANDS)};
import { testFileArgumentsResolve } from ${JSON.stringify(ACCEPTANCE_CLOSURE)};
import { checkBody } from ${JSON.stringify(PR_OPEN)};
const [mode, arg] = process.argv.slice(2);
if (mode === "run") process.exitCode = runAcceptanceCommand(arg);
else if (mode === "resolve") console.log(JSON.stringify(testFileArgumentsResolve(arg)));
else if (mode === "pr-open") {
  // ADR 0044: the Acceptance is read from the file the pull request ADDS, so the diff names one and \`readFile\` hands it back.
  const file = ".acceptance/agent~x-1.md";
  for (const line of checkBody("Closes: none -- a fixture", { diff: { ok: true, files: [file], added: [file] }, readFile: () => arg }).lines) console.log(line);
}
`);
});

after(() => rmSync(root, { recursive: true, force: true }));

function inDir(cwd: string, mode: "run" | "resolve" | "pr-open", arg: string) {
  const child = spawnSync(process.execPath, [runner, mode, arg], { cwd, encoding: "utf8", env: sandboxGitEnv() });
  return { status: child.status, lines: child.stdout.split("\n").filter(Boolean), stderr: child.stderr };
}

test("an Acceptance that prints its own cwd prints the worktree's top level, from the top and from a subdirectory", () => {
  const top = inDir(worktree, "run", "pwd");
  assert.deepEqual([top.status, top.lines], [0, [worktree]], top.stderr);
  mkdirSync(join(worktree, "sub"), { recursive: true });
  const sub = inDir(join(worktree, "sub"), "run", "pwd");
  assert.deepEqual([sub.status, sub.lines], [0, [worktree]], sub.stderr);
});

test("POSITIVE CONTROL: a leading `cd` into the primary checkout is run in the worktree, and the first line says so", () => {
  const ran = inDir(worktree, "run", `cd ${primary} && pwd`);
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.lines[0], /^RUN-IN-WORKTREE: a leading `cd .*primary` is into the primary checkout .*run in this worktree .*`cd \.`$/);
  assert.ok(ran.lines[0].includes(primary) && ran.lines[0].includes(worktree), ran.lines[0]);
  assert.deepEqual(ran.lines.slice(1), [worktree]);
});

test("started in the primary checkout itself, the `cd` is the run's own directory and there is no line", () => {
  const ran = inDir(primary, "run", `cd ${primary} && pwd`);
  assert.deepEqual([ran.status, ran.lines], [0, [primary]], ran.stderr);
});

test("a subdirectory of the primary checkout, quoted, and the `bash -c '...'` spelling, each land in the worktree's", () => {
  const quoted = inDir(worktree, "run", `cd "${primary}/sub" && ls`);
  assert.deepEqual(quoted.lines.slice(1), ["kept.txt"], quoted.stderr);
  const wrapped = inDir(worktree, "run", `bash -c 'cd ${primary}/sub && pwd'`);
  assert.deepEqual(wrapped.lines.slice(1), [join(worktree, "sub")], wrapped.stderr);
  assert.match(wrapped.lines[0], /^RUN-IN-WORKTREE: .*`cd \.\/sub`$/);
});

test("the exit code of the command is the runner's, rewritten or not", () => {
  assert.equal(inDir(worktree, "run", `cd ${primary} && exit 7`).status, 7);
  assert.equal(inDir(worktree, "run", "exit 3").status, 3);
});

test("REFUTATION: what is not a leading cd into this repository's primary checkout runs exactly as written", () => {
  // Another repository's checkout is not this run's to move.
  const other = inDir(worktree, "run", `cd ${elsewhere} && pwd`);
  assert.deepEqual(other.lines, [elsewhere], other.stderr);
  // A `cd` that is not leading is the author's own.
  const later = inDir(worktree, "run", `true && cd ${primary} && pwd`);
  assert.deepEqual(later.lines, [primary], later.stderr);
  // Prose that names the path is not a `cd`.
  const prose = inDir(worktree, "run", `echo "cd ${primary} && pwd"`);
  assert.deepEqual(prose.lines, [`cd ${primary} && pwd`], prose.stderr);
  // A sibling that only starts with the primary's name is not inside it.
  const sibling = `${primary}-2`;
  mkdirSync(sibling);
  const lookalike = inDir(worktree, "run", `cd ${sibling} && pwd`);
  assert.deepEqual(lookalike.lines, [sibling], lookalike.stderr);
});

test("rewriteLeadingCd is a pure function of the command and the two checkouts", () => {
  const p = "/r/agent-org";
  const w = "/r/wt-1";
  assert.equal(rewriteLeadingCd("cd /r/agent-org && node --test a.ts", p, w)?.command, "cd . && node --test a.ts");
  assert.equal(rewriteLeadingCd("cd /r/agent-org/ && x", p, w)?.command, "cd . && x");
  assert.equal(rewriteLeadingCd("  cd '/r/agent-org/src' && x", p, w)?.command, "  cd './src' && x");
  assert.equal(rewriteLeadingCd("bash -c 'cd /r/agent-org && x'", p, w)?.command, "bash -c 'cd . && x'");
  assert.equal(rewriteLeadingCd("cd /r/agent-org-2 && x", p, w), null);
  assert.equal(rewriteLeadingCd("cd /r && x", p, w), null);
  assert.equal(rewriteLeadingCd("x && cd /r/agent-org && y", p, w), null);
  assert.equal(rewriteLeadingCd("cd /r/agent-org && x", p, p), null);
});

test("the file check before the run looks a named test file up in the worktree, where the command will run", () => {
  const command = `cd ${primary} && tsx --test only-in-worktree.test.ts`;
  assert.deepEqual(JSON.parse(inDir(worktree, "resolve", command).lines[0]), { ok: true });
  // CONTROL: the file is in no primary checkout, so run from there it is the missing file the check exists to name.
  assert.deepEqual(JSON.parse(inDir(primary, "resolve", command).lines[0]), { ok: false, missing: ["only-in-worktree.test.ts"] });
});

test("`pr:open`'s own check runs the Acceptance in the worktree, with the line, through the same runner", () => {
  const file = `Acceptance:\n\n\`\`\`bash\ncd ${primary} && node -p 'process.cwd()'\n\`\`\`\n`;
  const checked = inDir(worktree, "pr-open", file);
  const at = checked.lines.findIndex((line) => line.startsWith("RUN-IN-WORKTREE: "));
  assert.ok(at >= 0, `no rewrite line in:\n${checked.lines.join("\n")}\n${checked.stderr}`);
  assert.equal(checked.lines[at + 1], worktree, checked.lines.join("\n"));
});
